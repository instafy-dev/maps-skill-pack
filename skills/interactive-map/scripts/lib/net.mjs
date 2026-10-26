// Network helpers: polite fetch with UA, retries + backoff, response cache, Overpass lock + mirrors, and the lookup
// chains (lookup.mjs): every outside service is a provider declared in ../lookup-providers.json, asked through its
// capability's chain, with one shared health file (a provider that is down is skipped for its cooldown).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep, UserError } from './util.mjs';
import { Health, STATUS, chainHealth, chainOf, loadProviders, resolveProvider, runChain } from './lookup.mjs';

export const UA = 'instafy-map-pack/0.2 (+https://instafy.dev)';

// The declared providers and chains (defaults: the free community services, fine for prototypes and personal maps;
// reference/data-sources.md). base_env (UW_PHOTON, UW_OVERPASS, …) or INSTAFY_LOOKUP_PROVIDERS point them elsewhere.
export const LOOKUPS = loadProviders(JSON.parse(fs.readFileSync(new URL('../lookup-providers.json', import.meta.url), 'utf8')));
export const lookupHealth = new Health();
/** The first provider of a capability's chain, resolved (its base URL, timeouts): for probes and labels. */
export const primaryOf = (capability) => { const id = chainOf(LOOKUPS, capability)[0]; return id ? resolveProvider(LOOKUPS, id) : null; };
/** Overpass mirrors: the bases of the first provider whose protocol is "overpass" in the osm-query chain. */
const overpassProvider = () => primaryOf('osm-query');

let cacheDir = null; // set per site: <dir>/.uwcache
let noCache = !!process.env.UW_NO_CACHE;
export function setCacheDir(dir) { cacheDir = dir; }
export function setNoCache(v) { noCache = !!v; }

function cacheKey(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}
// Two levels: the site's own .uwcache, then the answers every uw command on this machine shares (UW_CACHE/answers): an
// identical lookup from another site, another stop of the same build or a continuation turn is answered from disk
// instead of asking the service again. The same age limit applies to both.
const answersDir = () => sharedCacheDir('answers');
function cacheGet(key, maxAgeMs, dir) {
  if (noCache) return null;
  for (const d of dir !== undefined ? [dir] : [cacheDir, answersDir()]) {
    if (!d) continue;
    const f = path.join(d, key + '.json');
    try {
      const st = fs.statSync(f);
      if (maxAgeMs && Date.now() - st.mtimeMs > maxAgeMs) continue;
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* a miss, or a file another process is still writing */ }
  }
  return null;
}
function cachePut(key, value, dir) {
  if (noCache) return;
  const text = JSON.stringify(value);
  for (const d of dir !== undefined ? [dir] : [cacheDir, answersDir()]) {
    if (!d) continue;
    try {
      fs.mkdirSync(d, { recursive: true });
      // written whole, then renamed: a reader in another process never sees half a file
      const tmp = path.join(d, `${key}.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(d, key + '.json'));
    } catch { /* cache is best effort */ }
  }
  if (Math.random() < 0.02) pruneAnswers();
}
/** Drop shared answers older than two weeks (no cached answer is used past a week). */
function pruneAnswers(maxAgeMs = 14 * 864e5) {
  try {
    const d = answersDir();
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
/** A value kept in the shared cache under `sub` (pages re-read by handoff's source check, say): null when absent or
 *  older than maxAgeMs. */
export function readShared(sub, parts, maxAgeMs) { return cacheGet(cacheKey(parts), maxAgeMs, sharedCacheDir(sub)); }
export function writeShared(sub, parts, value) { cachePut(cacheKey(parts), value, sharedCacheDir(sub)); }
/** The cache every site on this machine shares (UW_CACHE, default ~/.cache/uw): data that changes slowly (rail track
 *  tiles) is fetched once, not once per site. */
export const sharedCacheDir = (sub) => path.join(process.env.UW_CACHE || path.join(os.homedir(), '.cache', 'uw'), sub);

const DEFAULT_TIMEOUT = 60000;
export const debug = (...m) => { if (process.env.UW_DEBUG) console.error('[uw]', ...m); };

// ---------------------------------------------------------------------------
// Deadline: uw.mjs sets one per command (--timeout <s>, a per-command default, the turn budget). Every request,
// retry wait and lock wait below is clamped to it; when it passes, a SkipError (exit code 4) ends the command.
// Commands that loop over features catch it, keep what they finished (valid partial output) and rethrow.
let deadlineAt = null, deadlineS = null, startedAt = Date.now();
let commandDeadlineAt = null; // the command's own deadline (withReserve/withCap only lower deadlineAt for a while)
const netState = { service: null, busy: false };
export function setDeadline(ms) { startedAt = Date.now(); deadlineAt = ms > 0 ? startedAt + ms : null; commandDeadlineAt = deadlineAt; deadlineS = ms > 0 ? Math.round(ms / 1000) : null; }
export function timeLeft() { return deadlineAt == null ? Infinity : deadlineAt - Date.now(); }
export class SkipError extends UserError {
  constructor(service, why, extra = {}) {
    super(`${service} ${why}`, 4);
    this.name = 'SkipError'; this.service = service; this.why = why; this.status = STATUS.UNAVAILABLE; Object.assign(this, extra);
  }
}
/** exit 4: a service could not answer (busy, slow, down; a lookup chain with no provider left), never "not found" */
export const isSkip = (e) => e?.name === 'SkipError' || e?.status === STATUS.UNAVAILABLE;
/** the SkipError for the current deadline (busy = the service answered 429/5xx; slow = no answer in time). Past a
 *  withReserve/withCap limit while the command still has time it is `slow` (a lookup chain asks the next provider);
 *  past the command's own deadline it is `deadline` (stop: nothing is proven about the service). */
export function deadlineSkip(service = netState.service || 'the network') {
  const s = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  // a reserve or a cap lowered the limit and the command still has time: only this step ran out (slow)
  const commandOver = commandDeadlineAt == null || Date.now() >= commandDeadlineAt - 1000;
  const soft = deadlineAt !== commandDeadlineAt && !commandOver;
  return new SkipError(service, `${netState.busy ? 'busy' : 'too slow'} after ${s} s${deadlineS && deadlineS > s + 2 ? ` (limit ${deadlineS} s)` : ''}`,
    { timeoutS: deadlineS, deadline: !soft, slow: soft });
}
let active = 0; // requests on the wire right now (the hard stop in uw.mjs only fires while waiting on the network)
export const networkActive = () => active > 0;
const tracked = (p) => { active++; return p.finally(() => { active--; }); };
function noteService(label, busy = false) { netState.service = label; if (busy) netState.busy = true; }
/** ms for one attempt: its own limit, clamped to the deadline (≥ 1 s); throws when the deadline has passed */
function attemptMs(limitMs, label) {
  const left = timeLeft();
  if (left <= 250) throw deadlineSkip(label);
  return Math.max(1000, Math.min(limitMs, left));
}
/** run fn with a deadline `reserveMs` earlier than the command's (time kept back for a fallback); restored after */
export async function withReserve(reserveMs, fn) {
  const saved = [deadlineAt, deadlineS];
  // a short limit keeps back less (at most 40 % of what is left)
  const keep = Math.min(reserveMs, timeLeft() * 0.4);
  if (deadlineAt != null && keep >= 2000) { deadlineAt -= keep; deadlineS = Math.max(1, deadlineS - Math.round(keep / 1000)); }
  try { return await fn(); } finally { [deadlineAt, deadlineS] = saved; }
}
/** run fn with at most capMs of the command's time (an optional sub-step must not eat the whole limit); restored after */
export async function withCap(capMs, fn) {
  const saved = [deadlineAt, deadlineS];
  if (deadlineAt == null || timeLeft() > capMs) { deadlineAt = Date.now() + capMs; deadlineS = Math.round(capMs / 1000); }
  try { return await fn(); } finally { [deadlineAt, deadlineS] = saved; }
}
/**
 * Ask a capability's chain (lookup-providers.json): `protocols` maps each protocol name to { lookup(request,
 * provider), accepts?(request, provider) } (provider.base is the URL to ask). Resolves { status, results, provider,
 * label, attempts }: ok / partial / not_found. When no provider could answer it throws a SkipError (exit 4, status
 * "unavailable") naming each one's reason; a provider skipped for its cooldown is named as "down".
 */
export async function ask(capability, request, protocols, { where = {}, quiet = false } = {}) {
  const r = await runChain(capability, request, { registry: LOOKUPS, health: lookupHealth, protocols, where, log: quiet ? null : (line) => console.error(`  ${line}`) });
  if (r.status !== STATUS.UNAVAILABLE) return r;
  const reasons = r.attempts.filter((a) => a.outcome !== 'skipped').map((a) => `${a.label}: ${a.detail || a.outcome}`);
  const primary = r.attempts.find((a) => a.outcome !== 'skipped')?.label || capability;
  throw new SkipError(primary, `unavailable${reasons.length ? ` (${reasons.join('; ')})` : ''}`, { capability, attempts: r.attempts, retry_after_s: r.retry_after_s, unavailable: true });
}
/** { available, slow, degraded, retry_after_s, providers } for a capability: long jobs leave optional lookups for
 *  later while its first provider is down or slow (degraded). */
export const lookupState = (capability, where = {}) => chainHealth(capability, { registry: LOOKUPS, health: lookupHealth, where });
/** sleep before a retry, or end now when the wait would run past the deadline */
async function waitOrSkip(ms, label) {
  if (ms >= timeLeft() - 1000) throw deadlineSkip(label);
  await sleep(ms);
}

// fetchJSON(url, { method, body, headers, cacheMaxAgeMs, retries, timeoutMs, label, accept })
// Returns parsed JSON. Retries 429/5xx/network/timeouts with exponential backoff.
export async function fetchJSON(url, opts = {}) {
  // retries: attempts after a timeout or network error; statusRetries: after a quick 429/5xx answer (a busy service
  // that answers fast is worth asking again a few times, a hung one is not)
  const { method = 'GET', body, headers = {}, cacheMaxAgeMs = 7 * 864e5, retries = 3, statusRetries = retries, timeoutMs = DEFAULT_TIMEOUT,
    label = new URL(url).host, acceptJson = true, cache = true } = opts;
  const key = cacheKey([method, url, body || '']);
  if (cache) {
    const hit = cacheGet(key, cacheMaxAgeMs);
    if (hit) return hit;
  }
  const h = { 'User-Agent': UA, ...headers };
  if (acceptJson && !h.Accept) h.Accept = 'application/json';
  let lastErr;
  noteService(label);
  let failures = 0, statusFailures = 0;
  for (let attempt = 0; failures <= retries && statusFailures <= statusRetries; attempt++) {
    if (attempt) await waitOrSkip(Math.min(20000, 1000 * 2 ** (attempt - 1)) + Math.random() * 400, label);
    const ms = attemptMs(timeoutMs, label);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const { res, text } = await tracked(fetch(url, { method, body, headers: h, signal: ctrl.signal }).then(async (r) => ({ res: r, text: await r.text() })));
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(label, res.status, text);
        noteService(label, true);
        statusFailures++;
        const ra = Number(res.headers.get('retry-after'));
        if (ra > 0 && ra < 30) await waitOrSkip(ra * 1000, label);
        continue;
      }
      if (!res.ok) throw new HttpError(label, res.status, text, true);
      let data;
      try { data = JSON.parse(text); } catch {
        throw new HttpError(label, res.status, `response was not JSON: ${text.slice(0, 200)}`, true);
      }
      if (cache) cachePut(key, data);
      return data;
    } catch (e) {
      if ((e instanceof HttpError && e.fatal) || isSkip(e)) throw e;
      if (e?.cause?.code === 'ENOTFOUND') throw new UserError(`${label}: cannot resolve host ${new URL(url).host} (offline, or the host does not exist)`);
      if (e.name === 'AbortError' && timeLeft() <= 1000) throw deadlineSkip(label);
      lastErr = e.name === 'AbortError' ? new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`) : e;
      failures++;
    } finally { clearTimeout(t); }
  }
  throw lastErr instanceof HttpError ? lastErr : new UserError(`${label}: request failed (${lastErr?.message || lastErr})`);
}

// fetchBuffer(url, { timeoutMs, retries, label, headers }) → { buf, status, headers }. Binary downloads (zips, CSVs);
// no response cache here (callers keep their own dataset cache, e.g. ~/.cache/uw/<adapter>/).
export async function fetchBuffer(url, opts = {}) {
  const { timeoutMs = 120000, retries = 3, label = new URL(url).host, headers = {} } = opts;
  let lastErr;
  noteService(label);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await waitOrSkip(Math.min(20000, 1500 * 2 ** (attempt - 1)) + Math.random() * 400, label);
    const ms = attemptMs(timeoutMs, label);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const { res, buf } = await tracked(fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal, redirect: 'follow' })
        .then(async (r) => ({ res: r, buf: Buffer.from(await r.arrayBuffer()) })));
      if (res.status === 429 || res.status >= 500) { lastErr = new HttpError(label, res.status, buf.subarray(0, 300).toString('utf8')); noteService(label, true); continue; }
      if (!res.ok) throw new HttpError(label, res.status, buf.subarray(0, 300).toString('utf8'), true);
      return { buf, status: res.status, headers: Object.fromEntries(res.headers.entries()) };
    } catch (e) {
      if ((e instanceof HttpError && e.fatal) || isSkip(e)) throw e;
      if (e?.cause?.code === 'ENOTFOUND') throw new UserError(`${label}: cannot resolve host ${new URL(url).host} (offline?)`);
      if (e.name === 'AbortError' && timeLeft() <= 1000) throw deadlineSkip(label);
      lastErr = e.name === 'AbortError' ? new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`) : e;
    } finally { clearTimeout(t); }
  }
  throw lastErr instanceof HttpError ? lastErr : new UserError(`${label}: download failed (${lastErr?.message || lastErr})`);
}

// Process-local spacing per key: await spaced('panoramax', 500) keeps ≥ 500 ms between calls (max 2 requests/s).
const lastCall = new Map();
export async function spaced(key, ms) {
  const prev = lastCall.get(key) || 0;
  const wait = prev + ms - Date.now();
  lastCall.set(key, Math.max(Date.now(), prev + ms));
  if (wait > 0) await sleep(wait);
}

export class HttpError extends UserError {
  constructor(label, status, text, fatal = false) {
    const snippet = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    super(`${label}: HTTP ${status}${snippet ? ` — ${snippet}` : ''}`);
    this.status = status; this.fatal = fatal;
  }
}

// ---------------------------------------------------------------------------
// Overpass: at most `max_concurrent` queries at a time on this machine (the provider's declared slots, default 1; one
// lock file per slot in os.tmpdir()), each started at least 1 s after the last one ended.
const LOCK = path.join(os.tmpdir(), 'uw-overpass.lock');
const STAMP = path.join(os.tmpdir(), 'uw-overpass.last');
const slotFile = (i) => (i ? `${LOCK}.${i}` : LOCK);
/** How many Overpass queries may run at once on this machine (lookup-providers.json "max_concurrent"). */
export const overpassSlots = () => Math.max(1, Math.min(8, Math.floor(Number(overpassProvider()?.max_concurrent) || 1)));

let lockHeld = null;
/** drop the Overpass lock if this process holds it (uw.mjs calls it before a hard exit) */
export function releaseOverpassLock() { if (lockHeld) { try { fs.unlinkSync(lockHeld); } catch {} lockHeld = null; } }
const lockOwnerDead = (file) => {
  try { const pid = Number(fs.readFileSync(file, 'utf8')); if (!(pid > 0)) return false; process.kill(pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
};

async function withOverpassSlot(fn) {
  // wait for a free slot at most half the time this one has left, then go ahead without one
  const deadline = Date.now() + Math.min(120000, Math.max(0, timeLeft() / 2));
  const slots = overpassSlots();
  let fd = null, held = null;
  outer: while (fd === null) {
    for (let i = 0; i < slots; i++) {
      const f = slotFile(i);
      try { fd = fs.openSync(f, 'wx'); try { fs.writeSync(fd, String(process.pid)); } catch {} held = f; lockHeld = f; break outer; } catch (e) {
        if (e.code !== 'EEXIST') break outer; // cannot lock; proceed without
        try { if (Date.now() - fs.statSync(f).mtimeMs > 180000 || lockOwnerDead(f)) fs.unlinkSync(f); } catch {}
      }
    }
    if (Date.now() > deadline) break;
    await sleep(250);
  }
  try {
    let last = 0;
    try { last = Number(fs.readFileSync(STAMP, 'utf8')) || 0; } catch {}
    const wait = last + 1000 - Date.now();
    if (wait > 0) await waitOrSkip(wait, 'Overpass');
    try { return await fn(); } finally { try { fs.writeFileSync(STAMP, String(Date.now())); } catch {} }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(held); } catch {} if (lockHeld === held) lockHeld = null; }
  }
}

// Overpass mirrors keep their health in the shared lookup health file (one breaker per mirror): a mirror that gave
// no answer within its share is "slow" (tried last for its cooldown), one that is broken (fails every query fast, or
// answers an error status) is down (skipped for its cooldown); when every mirror is down a query is unavailable at
// once (exit 4) instead of waiting minutes.
const mirrorHealth = (ep) => lookupHealth.check(overpassProvider(), { base: ep });

// Run an Overpass QL query. Returns { elements, ... }. Uses cache, endpoint fallback, backoff.
// shared: { dir, maxAgeMs }: also keep the answer in a cache every site shares (sharedCacheDir), e.g. rail track tiles.
export async function overpass(query, { timeoutS = 90, cacheMaxAgeMs = 3 * 864e5, onEndpoint, quick = false, shared = null } = {}) {
  const q0 = query.includes('[out:json]') ? query : `[out:json][timeout:${timeoutS}];\n${query}`;
  const key = overpassKey(q0);
  const hit = cacheGet(key, cacheMaxAgeMs) || (shared ? cacheGet(key, shared.maxAgeMs, shared.dir) : null);
  if (hit) return { ...hit, _cached: true };
  noteService('Overpass');
  const op = overpassProvider();
  const OVERPASS_ENDPOINTS = op.bases;
  const errors = [];
  const dead = new Set(), down = new Set(), fastFails = new Map();
  // mirrors found down by any uw command lately are skipped (a new turn asks them again)
  for (const ep of OVERPASS_ENDPOINTS) { const h = mirrorHealth(ep); if (!h.allow) { dead.add(ep); down.add(ep); errors.push(`${host(ep)} down (retry in ${h.retry_after_s} s)`); } }
  if (OVERPASS_ENDPOINTS.every((ep) => dead.has(ep))) throw new SkipError('Overpass', `unavailable: every server was down minutes ago (${errors.join('; ')})`, { busy: false, unavailable: true });
  // Rounds over the endpoint list: a busy main server falls back to the next mirror quickly; when all are busy
  // (429/504 at peak times) wait longer between rounds instead of giving up after a few seconds. Everything is clamped
  // to the command's deadline (uw --timeout): past it the command is skipped (exit 4), never left hanging.
  const WAITS = quick ? [0] : [0, 12000, 35000]; // quick: one pass over the endpoints (optional lookups)
  for (let round = 0; round < WAITS.length; round++) {
    if (round) {
      if (OVERPASS_ENDPOINTS.every((ep) => dead.has(ep))) break;
      // near the deadline wait less (a fifth of what is left) and try once more rather than give up
      const w = Math.min(WAITS[round] + Math.random() * 1500, timeLeft() / 5);
      if (timeLeft() - w < 8000) throw deadlineSkip('Overpass');
      console.error(`  Overpass busy (${errors.slice(-2).join('; ')}); retrying in ${Math.round(w / 1000)} s…`);
      await sleep(w);
    }
    // a server that recently hung (no answer at all) goes last: another uw command found it slow minutes ago
    const slowNow = new Map(OVERPASS_ENDPOINTS.map((ep) => [ep, mirrorHealth(ep).slow]));
    const live = OVERPASS_ENDPOINTS.filter((ep) => !dead.has(ep)).sort((a, b) => slowNow.get(a) - slowNow.get(b));
    const isSick = (ep) => slowNow.get(ep);
    for (const [k, ep] of live.entries()) {
      const attempt = round;
      let limitMs = 0;
      try {
        // one attempt never takes the whole budget while a healthy server is still to try (a hung mirror must not eat
        // it): 60 % of what is left then, else 85 %; the last chance (< 20 s left) all of it; a mirror that hung
        // recently at most 20 s
        const left = timeLeft();
        if (left <= 1000) throw deadlineSkip('Overpass');
        const healthyNext = live.slice(k + 1).some((x) => !isSick(x)) || (round < WAITS.length - 1 && live.some((x) => x !== ep && !isSick(x)));
        let share = left < 20000 ? left : Math.max(12000, left * (healthyNext ? 0.6 : 0.85));
        if (isSick(ep) && live.some((x) => !isSick(x))) share = Math.min(share, 20000);
        limitMs = Math.max(1000, Math.min((timeoutS + 30) * 1000, share));
        // the server-side [timeout:N] never asks for more than the time left (busy servers refuse long queries first)
        const q = q0.replace(/\[timeout:(\d+)\]/, (m, n) => `[timeout:${Math.max(10, Math.min(Number(n), Math.floor(limitMs / 1000)))}]`);
        onEndpoint?.(ep, attempt);
        const t0 = Date.now();
        const res = await withOverpassSlot(async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(limitMs, timeLeft())));
          try {
            // NOTE: no "Accept: application/json" header; Overpass answers 406 to that.
            return await tracked(fetch(ep, {
              method: 'POST',
              headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              body: 'data=' + encodeURIComponent(q),
              signal: ctrl.signal,
            }).then(async (r) => ({ status: r.status, text: await r.text() })));
          } finally { clearTimeout(t); }
        });
        debug(`overpass ${host(ep)} round ${attempt + 1}: HTTP ${res.status} in ${Date.now() - t0} ms, ${res.text.length} bytes`);
        if (res.status === 429 || res.status >= 500) {
          errors.push(`${host(ep)} HTTP ${res.status}`);
          noteService('Overpass', true);
          // a mirror that fails every query within ~2 s is broken, not busy: stop asking it this run
          // (busy is not down: not remembered past this command)
          if (res.status >= 500 && Date.now() - t0 < 2500) { const n = (fastFails.get(ep) || 0) + 1; fastFails.set(ep, n); if (n >= 2) dead.add(ep); }
          continue;
        }
        if (res.status !== 200) {
          const em = [...res.text.matchAll(/Error<\/strong>:\s*([^<]+)/g)].map((m) => m[1].trim());
          const msg = (em.length ? em.join(' / ') : res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
            .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 300);
          // 400 = query syntax error: identical on every endpoint, so stop now.
          if (res.status === 400) throw new UserError(`Overpass rejected the query (HTTP 400): ${msg}`);
          errors.push(`${host(ep)} HTTP ${res.status}: ${msg.slice(0, 120)}`);
          dead.add(ep); down.add(ep);
          lookupHealth.fail(op, `HTTP ${res.status}`, { base: ep });
          continue;
        }
        let data;
        try { data = JSON.parse(res.text); } catch {
          // Overloaded servers answer 200 with an HTML "runtime error" page: retry later / elsewhere.
          const m = res.text.match(/Error<\/strong>:\s*([^<]{0,160})/);
          errors.push(`${host(ep)} returned an error page (${(m ? m[1] : res.text.slice(0, 80)).replace(/\s+/g, ' ').trim()})`);
          noteService('Overpass', true);
          continue;
        }
        if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) {
          // Partial result: never cache, try another server.
          errors.push(`${host(ep)}: ${data.remark.slice(0, 160)}`);
          noteService('Overpass', true);
          continue;
        }
        cachePut(key, data);
        if (shared) cachePut(key, data, shared.dir);
        lookupHealth.ok(op, Date.now() - t0, { base: ep });
        return data;
      } catch (e) {
        if (e instanceof UserError) throw e; // includes SkipError
        if (e.name === 'AbortError' && timeLeft() <= 1000) throw deadlineSkip('Overpass');
        if (e.name === 'AbortError') lookupHealth.slow(op, { base: ep }); // no answer within its share while time was left: tried last for a while
        else if (e?.cause?.code === 'ECONNREFUSED' || e?.cause?.code === 'ENOTFOUND' || e?.cause?.code === 'EHOSTUNREACH') { dead.add(ep); down.add(ep); lookupHealth.fail(op, e.cause.code, { base: ep }); }
        errors.push(`${host(ep)}: ${e.name === 'AbortError' ? `no answer in ${Math.round(limitMs / 1000)} s` : e.message}`);
        debug(`overpass ${host(ep)} round ${attempt + 1} failed: ${e.message}`);
      }
    }
  }
  // every server busy or broken: the step is skipped (exit 4), like a timeout; the map works without it
  const allDown = OVERPASS_ENDPOINTS.every((ep) => down.has(ep));
  throw new SkipError('Overpass', `${allDown ? 'unavailable' : 'busy'} on every server (${errors.slice(-3).join('; ')})`, { busy: !allDown, unavailable: allDown });
}
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

/** The cache key of an Overpass query: its text without the server time limit ([timeout:N] does not change the
 *  answer, so the same query asked with another limit, or inside a batch, is the same answer). */
function overpassKey(q0) { return cacheKey(['overpass', String(q0).replace(/\[timeout:\d+\]/, '')]); }

const BATCH_HEADER = /^\s*\[out:json\](?:\[timeout:\d+\])?\s*;\s*/;
/**
 * Several Overpass queries in one request (request batching: one round trip and one queue slot instead of N). Each
 * query must be plain "[out:json][timeout:N];" + statements ending in its own out; queries with other settings are
 * asked one by one. A marker element (make uwbatch) ends each query's part of the answer; every part is cached under
 * the key the query alone would have, so a later uw command that asks one of them is answered from the cache.
 * Queries already cached are not asked again. Resolves an array (same order) of { elements } or null (not answered:
 * the caller asks the usual way). Never throws for a busy service: a failed batch just answers nothing.
 */
export async function overpassBatch(queries, { timeoutS = 60, cacheMaxAgeMs = 3 * 864e5 } = {}) {
  const norm = queries.map((q) => (q.includes('[out:json]') ? q : `[out:json][timeout:${timeoutS}];\n${q}`));
  const keys = norm.map(overpassKey);
  const out = keys.map((k) => { const hit = cacheGet(k, cacheMaxAgeMs); return hit ? { ...hit, _cached: true } : null; });
  const todo = norm.map((q, i) => i).filter((i) => !out[i] && BATCH_HEADER.test(norm[i]) && !/\[out:json\][^;]*\[(?!timeout)/.test(norm[i]));
  if (todo.length < 2) return out;
  const body = todo.map((i, n) => `${norm[i].replace(BATCH_HEADER, '').trim()}\nmake uwbatch i="${n}";\nout;`).join('\n');
  const limit = Math.min(180, Math.max(timeoutS, 25 * todo.length));
  let data;
  try { data = await overpass(`[out:json][timeout:${limit}];\n${body}`, { timeoutS: limit, cacheMaxAgeMs }); }
  // busy, down, out of time or a query the server refused: each command asks its own query the usual way
  catch (e) { debug(`overpass batch of ${todo.length} not answered: ${e.message}`); return out; }
  const parts = todo.map(() => []);
  let n = 0, markers = 0;
  for (const el of data?.elements || []) {
    if (el?.type === 'uwbatch') { markers++; n = Number(el.tags?.i) + 1; continue; }
    if (n < parts.length) parts[n].push(el);
  }
  // an answer cut short (fewer markers than queries) proves nothing about the missing parts
  if (markers !== todo.length) return out;
  todo.forEach((i, k) => { const value = { elements: parts[k] }; cachePut(keys[i], value); out[i] = value; });
  return out;
}
