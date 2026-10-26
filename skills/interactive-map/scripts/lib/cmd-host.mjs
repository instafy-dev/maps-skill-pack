// `host`: local dev host for the full two-way loop (ENGINE-SPEC-v0.2 §10). A superset of `serve`:
//   GET  <site>/__uw/health   → { ok, host: "uw-host", v: 2, intents: [names with a resolvable handler] }
//   POST <site>/__uw/intent   → validate (declared, handler, params schema, ≤ 4 KB, same origin) → 202 queued job
//   GET  <site>/__uw/events   → Server-Sent Events: ack / progress / results / done / error for EVERY viewer
//   GET  <site>/__uw/jobs     → the last 50 jobs (debug)
// Jobs run handlers (pack:<name> → scripts/handlers/<name>.mjs, or a site-relative .mjs) as child processes; the host
// does the apply step (schema check, source + lane check, stamp prov.intent/job, merge into target.records, bump
// data/version.json) and broadcasts the accepted records. This mirrors the Instafy "apply, no model" step.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { parseArgs, makeOut, readJSON, exists, UserError } from './util.mjs';
import { staticHandler, listen, lanAddresses, remoteHint, detach, stop, readState, alive } from './cmd-serve.mjs';
import { SCRIPTS_DIR } from './site.mjs';
import { validate, applyDefaults, fmtErrors } from './schema-lite.mjs';
import { normalizeRecord, validateRecord, writeRecords, bumpVersion, readVersion, versionPath, stampReload, RECORDS_PATH_RE } from './records.mjs';
import { uwCacheRoot } from './cmd-adapter.mjs';
import { safeEnv } from './safe-env.mjs';
import { hostRefusal, originRefusal, publicHostnames } from './host-check.mjs';
import { ownSiteWrites, releaseSiteWrites } from './save-owner.mjs';

export const help = `host <site|gallery-dir> [--port 4173] [--host 127.0.0.1|0.0.0.0] [--confirm] [--log] [--no-save] [--json] [--detach | --stop]
  --detach / --stop as for serve (one background server per folder; host replaces a running serve).
  Serves the site like "serve" and adds the agent loop for the intents declared in its bound.json:
    GET  __uw/health   which intents this host can run (the engine shows intent buttons only when a listener answers)
    POST __uw/intent   the map's intent message (§9.3): name declared, handler resolvable, params valid, ≤ 4 KB,
                       same origin → 202 {status:"queued", id, job}; 400 rejected; 404 unknown; 409 duplicate id;
                       202 {status:"rejected", retry_after_s} for a repeat inside cooldown_s (keyed like the page: the
                       item's ref, or a map search's spot to ~50 m; "refresh" does not skip it). Identical (name,
                       params) within 60 s join the running job. Max 2 jobs at once.
    GET  __uw/events   Server-Sent Events (retry 2 s, ping 15 s, Last-Event-ID replay from 200 events): every viewer
                       gets every ack / progress / results / done / error (with name, ref and a map search's spot), so
                       all open phones update live and show each other's running jobs.
    GET  __uw/jobs     the last 50 jobs.
  Handlers ("handler": "pack:check_registry" → scripts/handlers/check_registry.mjs, or "handlers/x.mjs" in the site)
  run as child processes and never write site files: the host validates every record (records.schema.json), keeps only
  prov.source in the intent's "sources" and lanes open/official/local, stamps prov.intent + prov.job, merges into
  target.records (kept under 180 KB: the oldest results go first, an item with its claims) and bumps
  data/version.json (jobs[id] = { state, name, ref, error, summary }), then broadcasts results + done.
  A gallery folder (e.g. examples/) gets <sub>/__uw/* for every subfolder with a bound.json.
  --confirm  each job waits for "y" on this terminal first (simulates the Instafy confirm tray; ack needs_confirm).
  --log      log every request.
  --no-warm  skip warming handler datasets at start (handlers that support UW_WARM=1 download them in the background).
  --no-save  in an Instafy space, leave what the host writes for clicks (records, data/version.json) as changed files.
             By default the host commits them to the space's checkout a couple of seconds after its last write, under
             the space's workspace lock, and the space's next save publishes them (as instafy bind serve does).
  --public-url <url>  also answer __uw/* for this host (a tunnel other than Instafy's; repeatable; or UW_PUBLIC_URL).
             __uw/* answers only localhost, IP addresses, Instafy tunnels/previews of this port and these (no DNS
             rebinding); POST __uw/intent also needs the page's own Origin. Files carry no CORS header.
  \`uw reload <site>\` (data/version.json "reload") is pushed to every viewer as a "command" event: they reload in place.`;

export const reloadHelp = `reload <site> [--note "<what changed>"] [--json]
  After you changed a site that people may have open (map.config.json, style.json, custom.js, data/, bound.json):
  every open viewer reloads in place and keeps its camera, selection, lens, layers, sheet and tab, with a short
  "↻ <note>" toast (≤ 80 chars; default "Map updated"). Run \`uw validate <site>\` first.
  How: stamps data/version.json "reload"; a running \`uw host\` pushes it to viewers over __uw/events at once, and
  viewers that only poll data/version.json pick it up on their next poll. Prints how many viewers are connected.
  Served with \`uw serve\` (no live channel): restart with \`uw host <site> --detach\` (or viewers press ↻).`;
export const helps = { host: help, reload: reloadHelp };

const MAX_BODY = 4096, RING = 200, MAX_JOBS = 2, COALESCE_MS = 60000;
// a records file stays under this many bytes (the engine reads at most 200 KB of a file): the oldest results go first
const RECORDS_BUDGET = 180 * 1024;
const KILL_GRACE_MS = 3000;
const OK_LANES = new Set(['open', 'official', 'local']);
let INTENT_SCHEMA = null;
function intentSchema() {
  if (!INTENT_SCHEMA) { const s = readJSON(path.join(SCRIPTS_DIR, 'schemas', 'messages.schema.json')); INTENT_SCHEMA = { schema: s.$defs.intent, root: s }; }
  return INTENT_SCHEMA;
}
const stamp = () => new Date().toISOString().slice(11, 19);
/** The cooldown key, identical to the engine's (bind.js coolKey): an item's ref, else the params with coordinates
 *  rounded to ~50 m, so a long-press on another street is a new request and never meets a 429. */
export function coolKey(name, ref, params) {
  if (ref) return `${name}|${ref}`;
  const norm = (v) => (Array.isArray(v) ? (v.length === 2 && v.every((x) => typeof x === 'number') ? v.map((x) => Math.round(x / 0.0005) * 0.0005).map((x) => +x.toFixed(4)) : v.map(norm))
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'refresh').map((k) => [k, norm(v[k])])) : v);
  return `${name}|${JSON.stringify(norm(params || {}))}`;
}
/** what other viewers may see of a job's params (where a map search ran), never more */
const publicParams = (p) => Object.fromEntries(Object.entries(p || {}).filter(([k, v]) => ['at', 'radius_m', 'max'].includes(k) && (typeof v === 'number' || Array.isArray(v))));

class SiteHost {
  constructor(dir, prefix, opts) {
    this.dir = dir; this.prefix = prefix; this.opts = opts;
    this.events = []; this.seq = 0; this.clients = new Set();
    this.jobs = new Map(); this.byIntent = new Map(); this.cooldown = new Map(); this.queue = []; this.running = 0; this.jobSeq = 0;
    this._bound = null; this._boundMtime = 0;
  }
  log(...m) { console.error(`[${stamp()}]${this.prefix !== '/' ? ' ' + this.prefix : ''}`, ...m); }
  bound() {
    const p = path.join(this.dir, 'bound.json');
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs !== this._boundMtime) { this._bound = readJSON(p); this._boundMtime = st.mtimeMs; }
    } catch { this._bound = null; this._boundMtime = 0; }
    return this._bound;
  }
  config() { try { return readJSON(path.join(this.dir, 'map.config.json')); } catch { return null; } }
  resolveHandler(def) {
    const h = def?.handler;
    if (typeof h !== 'string') return null;
    let p;
    if (h.startsWith('pack:')) { if (!/^pack:[a-z][a-z0-9_]{0,47}$/.test(h)) return null; p = path.join(SCRIPTS_DIR, 'handlers', h.slice(5) + '.mjs'); }
    else {
      if (!/\.mjs$/.test(h)) return null;
      p = path.resolve(this.dir, h);
      if (!p.startsWith(this.dir + path.sep)) return null;
    }
    return exists(p) ? p : null;
  }
  // Create data/version.json and every declared (empty) records file once, so viewers never fetch a 404 before the
  // first result arrives (browsers log a failed fetch as a console error even when the engine ignores it).
  ensureFiles() {
    const b = this.bound();
    if (!b) return [];
    const made = [];
    const targets = new Set([...(Array.isArray(b.results?.files) ? b.results.files : []), ...Object.values(b.intents || {}).map((d) => d?.target?.records)].filter((p) => typeof p === 'string' && RECORDS_PATH_RE.test(p)));
    for (const rel of targets) if (!exists(path.join(this.dir, rel))) { try { writeRecords(this.dir, rel, [], { cmd: 'host' }); made.push(rel); } catch (e) { this.log(`could not create ${rel}: ${e.message}`); } }
    if (!exists(path.join(this.dir, 'data', 'version.json'))) { try { bumpVersion(this.dir, {}); made.push('data/version.json'); } catch (e) { this.log(`could not create data/version.json: ${e.message}`); } }
    return made;
  }
  runnable() { const b = this.bound(); return Object.entries(b?.intents || {}).filter(([, d]) => this.resolveHandler(d)).map(([n]) => n); }
  // `uw reload <site>` stamps data/version.json "reload": push it to every open viewer, who reloads in place (bind.js
  // COMMANDS "reload" → engine softReload: hash, sheet and tab kept). Stat polling, so an atomic rename is seen too.
  watchReload(interval = 400) {
    this.lastReload = readVersion(this.dir).reload ?? null;
    this.reloadFile = versionPath(this.dir);
    fs.watchFile(this.reloadFile, { interval, persistent: false }, () => this.checkReload());
  }
  checkReload() {
    const v = readVersion(this.dir);
    if (typeof v.reload !== 'string' || v.reload === this.lastReload) return null;
    this.lastReload = v.reload;
    const note = typeof v.reload_note === 'string' ? v.reload_note.slice(0, 80) : null;
    this.log(`reload${note ? ' (' + note + ')' : ''} → ${this.clients.size} viewer(s)`);
    return this.broadcast('command', { command: { name: 'reload', args: note ? { note } : {} }, reload: v.reload });
  }
  unwatchReload() { if (this.reloadFile) fs.unwatchFile(this.reloadFile); }

  // --- events
  broadcast(type, payload) {
    const msg = { source: 'instafy-host', v: 2, type, ...payload, at: new Date().toISOString() };
    const ev = { n: ++this.seq, type, data: JSON.stringify(msg) };
    this.events.push(ev);
    if (this.events.length > RING) this.events.shift();
    for (const res of this.clients) this.send(res, ev);
    return msg;
  }
  send(res, ev) { try { res.write(`id: ${ev.n}\nevent: ${ev.type}\ndata: ${ev.data}\n\n`); } catch {} }
  // every event says which intent, which item and (map searches) where: other viewers show the job as pending too
  jobEvent(job, type, payload = {}) {
    for (const id of job.ids) this.broadcast(type, { id, job: job.job, name: job.name, ref: job.ref, ui: job.ui, by: job.by, ...(job.ref ? {} : { params: publicParams(job.params) }), ...payload });
  }
  sse(req, res, url) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const last = Number(req.headers['last-event-id'] ?? url.searchParams.get('last') ?? NaN);
    if (Number.isFinite(last)) for (const ev of this.events) if (ev.n > last) this.send(res, ev);
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    const bye = () => { clearInterval(ping); this.clients.delete(res); };
    req.on('close', bye); res.on('error', bye);
    if (this.opts.log) this.log(`SSE viewer connected (${this.clients.size} open)${Number.isFinite(last) ? `, replay after #${last}` : ''}`);
  }

  // --- intents
  async intent(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    // the server already refused a Host that is not ours (DNS rebinding, host-check.mjs); the page must be ours too
    const crossOrigin = originRefusal(req.headers.origin, req.headers.host);
    if (crossOrigin) return json(403, { status: 'rejected', reason: crossOrigin });
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return json(415, { status: 'rejected', reason: 'content-type must be application/json' });
    let body = '';
    let size = 0;
    try {
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return json(413, { status: 'rejected', reason: `body over ${MAX_BODY} bytes` }); body += c; }
    } catch { return json(400, { status: 'rejected', reason: 'could not read body' }); }
    let msg;
    try { msg = JSON.parse(body); } catch { return json(400, { status: 'rejected', reason: 'body is not JSON' }); }
    const { schema, root } = intentSchema();
    const errs = validate(schema, msg, { root, max: 5 });
    if (errs.length) return json(400, { status: 'rejected', reason: `invalid intent message: ${fmtErrors(errs)}` });
    // cancel {id}: kill the job that intent id belongs to
    if (msg.name === 'cancel') {
      const target = msg.params?.id;
      const job = target && this.jobs.get(this.byIntent.get(target));
      if (!job) return json(404, { status: 'rejected', reason: 'no such job' });
      this.cancel(job);
      return json(202, { status: 'cancelled', id: target, job: job.job });
    }
    const bound = this.bound();
    const def = bound?.intents?.[msg.name];
    if (!def) return json(404, { status: 'rejected', reason: `intent "${msg.name}" is not declared in bound.json` });
    const handler = this.resolveHandler(def);
    if (!handler) return json(404, { status: 'rejected', reason: `intent "${msg.name}" has no runnable handler on this host` });
    const params = applyDefaults(def.params, msg.params || {});
    const perrs = validate(def.params || { type: 'object' }, params, { max: 5 });
    if (perrs.length) return json(400, { status: 'rejected', reason: `params: ${fmtErrors(perrs)}` });
    if (JSON.stringify(params).length > MAX_BODY) return json(400, { status: 'rejected', reason: 'params over 4 KB' });
    // duplicate intent id (the same click delivered over several transports)
    if (this.byIntent.has(msg.id)) {
      const job = this.jobs.get(this.byIntent.get(msg.id));
      return json(409, { status: 'queued', id: msg.id, job: job?.job, state: job?.state });
    }
    const key = msg.name + ' ' + JSON.stringify(sortKeys(params));
    // identical request while a job for it is still pending: join it
    for (const job of this.jobs.values()) {
      if (job.key === key && !job.finished && Date.now() - job.created < COALESCE_MS) {
        job.ids.push(msg.id); this.byIntent.set(msg.id, job.job);
        this.broadcast('ack', { id: msg.id, job: job.job, name: job.name, ref: job.ref, ui: job.ui, by: job.by, status: job.state === 'needs_confirm' ? 'needs_confirm' : job.state === 'running' ? 'running' : 'queued' });
        this.log(`${msg.name} ${msg.id} joined ${job.job} (same params)`);
        return json(202, { status: job.state === 'needs_confirm' ? 'needs_confirm' : 'queued', id: msg.id, job: job.job, coalesced: true });
      }
    }
    // the same key as the page (so the page never sends what the host would refuse); "refresh" does not skip it.
    // A refusal is a 202 with status "rejected": a 429 would be a console error on every viewer's page.
    const cdKey = coolKey(msg.name, msg.ref || params.ref || null, params);
    const cd = (Number(def.cooldown_s) || 0) * 1000;
    const lastAt = this.cooldown.get(cdKey);
    if (cd && lastAt && Date.now() - lastAt < cd) {
      const wait = Math.ceil((cd - (Date.now() - lastAt)) / 1000);
      return json(202, { status: 'rejected', reason: `cooldown: try again in ${wait} s`, retry_after_s: wait, id: msg.id });
    }
    this.cooldown.set(cdKey, Date.now());
    const job = {
      job: `job_${Date.now().toString(36)}_${(++this.jobSeq).toString(36)}`, name: msg.name, params, key, ids: [msg.id], ref: msg.ref || null, ui: msg.ui || null,
      def, handler, msg: { ...msg, params }, state: 'queued', created: Date.now(), started: null, ended: null, finished: false,
      records: 0, rejected: 0, files: {}, summary: null, error: null, by: null,
    };
    this.jobs.set(job.job, job);
    this.byIntent.set(msg.id, job.job);
    while (this.jobs.size > 200) { const first = this.jobs.keys().next().value; const j = this.jobs.get(first); if (!j.finished) break; for (const i of j.ids) this.byIntent.delete(i); this.jobs.delete(first); }
    this.log(`intent ${msg.name} ${msg.id}${job.ref ? ' on ' + job.ref : ''} → ${job.job}`);
    if (this.opts.confirm) {
      job.state = 'needs_confirm';
      this.jobEvent(job, 'ack', { status: 'needs_confirm' });
      this.opts.askConfirm(this, job);
      return json(202, { status: 'needs_confirm', id: msg.id, job: job.job });
    }
    this.jobEvent(job, 'ack', { status: 'queued' });
    this.queue.push(job);
    setImmediate(() => this.pump());
    return json(202, { status: 'queued', id: msg.id, job: job.job });
  }
  confirmed(job, yes) {
    if (job.finished || job.state !== 'needs_confirm') return;
    if (!yes) { job.state = 'rejected'; job.finished = true; job.ended = Date.now(); this.jobEvent(job, 'ack', { status: 'rejected', reason: 'declined on the host' }); this.markJobs(job, 'error'); return; }
    job.state = 'queued'; this.queue.push(job); this.pump();
  }
  pump() {
    while (this.running < MAX_JOBS && this.queue.length) {
      const job = this.queue.shift();
      if (job.finished) continue;
      this.start(job);
    }
  }
  start(job) {
    this.running++;
    job.state = 'running'; job.started = Date.now();
    this.jobEvent(job, 'ack', { status: 'running' });
    this.markJobs(job, 'running');
    const child = spawn(process.execPath, [job.handler], {
      cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'],
      env: safeEnv({ UW_SITE: this.dir, UW_CACHE: uwCacheRoot(), UW_INTENT_ID: job.ids[0], UW_JOB: job.job }),
    });
    job.child = child;
    const input = { intent: job.msg, bound: job.def, site: { dir: this.dir, config: this.config() } };
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(job, line));
    readline.createInterface({ input: child.stderr }).on('line', (l) => this.log(`  ${job.name} ${job.job} stderr: ${l.slice(0, 300)}`));
    const timeoutMs = (Number(job.def.timeout_s) || 90) * 1000;
    job.timer = setTimeout(() => { job.error = { code: 'timeout', message: `no result within ${timeoutMs / 1000} s` }; this.kill(job); }, timeoutMs);
    child.on('error', (e) => { job.error = { code: 'upstream', message: `could not start handler: ${e.message}`.slice(0, 140) }; });
    child.on('close', (code, signal) => {
      clearTimeout(job.timer); clearTimeout(job.killTimer);
      rl.close();
      this.running--;
      job.ended = Date.now(); job.finished = true;
      if (job.cancelled) { job.state = 'error'; job.error = { code: 'cancelled', message: 'cancelled' }; this.jobEvent(job, 'error', { error: { code: 'cancelled', message: 'cancelled' } }); this.markJobs(job, 'error'); }
      else if (job.error) { job.state = 'error'; this.jobEvent(job, 'error', { error: job.error }); this.markJobs(job, 'error'); }
      else if (!job.doneSeen && (code !== 0 || signal)) {
        job.state = 'error'; job.error = { code: 'upstream', message: `handler exited with ${signal || 'code ' + code}` };
        this.jobEvent(job, 'error', { error: job.error }); this.markJobs(job, 'error');
      } else {
        job.state = 'done';
        this.jobEvent(job, 'done', { summary: (job.summary || (job.records ? `${job.records} record(s)` : 'Nothing new found')).slice(0, 200), rejected: job.rejected, files: job.files });
        this.markJobs(job, 'done');
      }
      this.log(`${job.job} ${job.state} in ${((job.ended - job.started) / 1000).toFixed(1)} s: ${job.records} record(s)${job.rejected ? `, ${job.rejected} rejected` : ''}${job.error ? ` (${job.error.code}: ${job.error.message})` : ''}${job.summary ? ` — ${job.summary}` : ''}`);
      delete job.child;
      this.pump();
    });
  }
  onLine(job, line) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { this.log(`  ${job.job}: ignored non-JSON output: ${line.slice(0, 120)}`); return; }
    if (job.finished) return;
    if (m.type === 'progress') {
      const pr = { step: Number.isInteger(m.step) ? m.step : 0, of: Number.isInteger(m.of) && m.of > 0 ? m.of : 1, message: String(m.message || '').slice(0, 140), ...(m.source ? { source: String(m.source).slice(0, 80) } : {}) };
      this.jobEvent(job, 'progress', { progress: pr });
    } else if (m.type === 'records' && Array.isArray(m.records)) {
      this.apply(job, m.records, Array.isArray(m.attribution) ? m.attribution.map(String) : []);
    } else if (m.type === 'done') { job.doneSeen = true; job.summary = String(m.summary || '').slice(0, 200); }
    else if (m.type === 'error') {
      const code = ['not_found', 'upstream', 'invalid', 'policy', 'timeout'].includes(m.code) ? m.code : 'upstream';
      job.error = { code, message: String(m.message || code).slice(0, 140) };
    }
  }
  // The apply step: validate, check source + lane, stamp, merge, bump version, broadcast.
  apply(job, recs, attribution) {
    const def = job.def;
    const accepted = [];
    for (const r0 of recs.slice(0, 2000)) {
      const r = normalizeRecord(r0);
      if (r?.type === 'item' && !r.layer && def.target?.layer) r.layer = def.target.layer;
      if (r?.prov && typeof r.prov === 'object') { r.prov.intent = { name: job.name, params: job.params, id: job.ids[0] }; r.prov.job = job.job; }
      const errs = validateRecord(r);
      let why = errs.length ? `schema: ${fmtErrors(errs, 2)}` : null;
      if (!why && Array.isArray(def.sources) && def.sources.length && !def.sources.includes(r.prov.source)) why = `source "${r.prov.source}" is not in the intent's sources`;
      if (!why && !OK_LANES.has(r.prov.lane)) why = `lane "${r.prov.lane}" is not allowed from a handler`;
      if (why) { job.rejected++; this.log(`  ${job.job}: rejected ${r?.type || '?'} ${r?.cid || r?.oid || r?.iid || ''}: ${why}`); continue; }
      accepted.push(r);
    }
    if (!accepted.length) return;
    const target = def.target?.records;
    let files = {};
    if (target && RECORDS_PATH_RE.test(target)) {
      try {
        const bound = this.bound();
        const w = writeRecords(this.dir, target, accepted, { cmd: 'host', attribution: [...(bound?.attribution || []), ...attribution],
          jobs: Object.fromEntries(job.ids.map((i) => [i, { state: 'running', name: job.name, ref: job.ref || null, at: new Date().toISOString() }])), budget: RECORDS_BUDGET });
        files = { [target]: w.v };
        job.files = { ...job.files, ...files };
        if (w.evicted) this.log(`  ${job.job}: ${target} kept under ${Math.round(RECORDS_BUDGET / 1024)} KB: dropped the ${w.evicted} oldest record(s)`);
      } catch (e) { this.log(`  ${job.job}: could not write ${target}: ${e.message}`); }
    }
    job.records += accepted.length;
    const refs = [...new Set(accepted.map((r) => r.ref || (r.layer ? `${r.layer}:${r.iid}` : null)).filter(Boolean))];
    this.jobEvent(job, 'results', { records: accepted, files, refs: refs.slice(0, 50) });
  }
  // data/version.json "jobs": the shared state every viewer (and a late joiner) reads: which intent, which item, the
  // outcome and the last error, so an error is not lost on reload and polling-only viewers see jobs run
  markJobs(job, state) {
    const entry = { state, name: job.name, ref: job.ref || null, at: new Date().toISOString(), ...(job.ref ? {} : { params: publicParams(job.params) }),
      ...(job.error ? { error: { code: job.error.code, message: job.error.message } } : {}), ...(job.summary ? { summary: job.summary } : {}) };
    try { bumpVersion(this.dir, { jobs: Object.fromEntries(job.ids.map((i) => [i, entry])) }); } catch (e) { this.log(`version.json: ${e.message}`); }
  }
  kill(job) {
    const c = job.child;
    if (!c) return;
    try { c.kill('SIGTERM'); } catch {}
    job.killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
  }
  cancel(job) {
    if (job.finished) return;
    job.cancelled = true;
    if (job.child) this.kill(job);
    else { job.finished = true; job.state = 'error'; job.ended = Date.now(); this.queue = this.queue.filter((j) => j !== job); this.jobEvent(job, 'error', { error: { code: 'cancelled', message: 'cancelled' } }); this.markJobs(job, 'error'); }
  }
  jobsList() {
    return [...this.jobs.values()].slice(-50).reverse().map((j) => ({ job: j.job, name: j.name, ids: j.ids, ref: j.ref, state: j.state, params: j.params,
      created: new Date(j.created).toISOString(), wait_ms: j.started ? j.started - j.created : null, run_ms: j.ended && j.started ? j.ended - j.started : null,
      records: j.records, rejected: j.rejected, files: j.files, summary: j.summary, error: j.error }));
  }
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export async function host(argv) {
  const args = parseArgs(argv, { port: 'number', host: 'string', confirm: 'bool', log: 'bool', 'no-warm': 'bool', 'no-save': 'bool', detach: 'bool', stop: 'bool', 'public-url': 'multi' }, { positionals: [1, 1], command: 'host' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const root = path.resolve(args._[0]);
  if (!exists(root) || !fs.statSync(root).isDirectory()) throw new UserError(`"${args._[0]}" is not a directory`);
  if (args.stop) return stop(args, root);
  if (args.detach) {
    if (args.confirm) throw new UserError('--confirm reads answers from this terminal, so it cannot run with --detach');
    return detach(args, root, 'host', [...(args.log ? ['--log'] : []), ...(args['no-warm'] ? ['--no-warm'] : []), ...(args['no-save'] ? ['--no-save'] : []), ...args['public-url'].flatMap((u) => ['--public-url', u])]);
  }
  // which sites get __uw endpoints
  const sites = [];
  const pending = [];
  const askConfirm = (site, job) => {
    pending.push({ site, job });
    if (pending.length === 1) prompt();
  };
  const prompt = () => {
    const p = pending[0];
    if (!p) return;
    console.error(`\n[confirm] ${p.job.name} ${p.job.ref ? 'on ' + p.job.ref + ' ' : ''}${JSON.stringify(p.job.params).slice(0, 160)} — run it? [y/N]`);
  };
  const opts = { confirm: !!args.confirm, log: !!args.log, askConfirm, port: null, publicHosts: publicHostnames(args['public-url']) };
  if (exists(path.join(root, 'map.config.json')) || exists(path.join(root, 'bound.json'))) sites.push(new SiteHost(root, '/', opts));
  else for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && exists(path.join(root, e.name, 'bound.json'))) sites.push(new SiteHost(path.join(root, e.name), `/${e.name}/`, opts));
  }
  if (args.confirm) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (l) => {
      const p = pending.shift();
      if (!p) return;
      const yes = /^\s*y(es)?\s*$/i.test(l);
      console.error(`[confirm] ${yes ? 'running' : 'declined'} ${p.job.job}`);
      p.site.confirmed(p.job, yes);
      prompt();
    });
  }
  for (const s of sites) s.watchReload();
  // The host owns what it writes for clicks (records, data/version.json): in an Instafy space's checkout it commits
  // them, so the space's next save publishes them and a stop does not keep them as unsaved work (save-owner.mjs).
  // --no-save leaves them as changed files.
  if (!args['no-save']) for (const s of sites) ownSiteWrites(s.dir, { label: `the ${path.basename(s.dir)} map`, log: (level, text) => s.log(text) });
  for (const s of sites) { const made = s.ensureFiles(); if (made.length) console.error(`[${stamp()}]${s.prefix !== '/' ? ' ' + s.prefix : ''} created ${made.join(', ')} (empty, so viewers never fetch a 404)`); }
  const serveStatic = staticHandler(root, { log: args.log ? (code, p) => console.error(`  ${code} ${p}`) : () => {} });
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    const m = url.pathname.match(/^(.*\/)__uw\/(health|intent|events|jobs)$/);
    // every request, files included: a rebinding page is same-origin with this server, so it could read
    // data/records/*.json, handlers/ and bound.json, not just call __uw/*
    const badHost = hostRefusal(req.headers.host, opts);
    if (badHost) {
      if (args.log) console.error(`  refused ${url.pathname}: ${badHost}`);
      res.writeHead(m ? 403 : 421, { 'Content-Type': m ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(m ? JSON.stringify({ ok: false, status: 'rejected', reason: badHost }) : `refused: ${badHost}`);
    }
    if (!m) {
      // mark responses of bound sites: the engine only probes __uw/health when it sees this header
      const owner = sites.filter((s) => url.pathname.startsWith(s.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      if (owner) {
        res.setHeader('X-UW-Host', '2');
        // and say whether a bound.json exists, so the engine loads it even when map.config.json has no "bind" key
        if (owner.bound()) res.setHeader('X-UW-Bound', '1');
      }
      return serveStatic(req, res);
    }
    if (args.log) console.error(`  ${req.method} ${url.pathname}`);
    const site = sites.find((s) => s.prefix === m[1]);
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!site) return json(404, { ok: false, reason: 'no bound site here' });
    const ep = m[2];
    if (ep === 'intent') { if (req.method !== 'POST') return json(405, { ok: false, reason: 'POST only' }); return site.intent(req, res).catch((e) => json(500, { status: 'rejected', reason: e.message })); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { ok: false, reason: 'GET only' });
    if (ep === 'health') return json(200, { ok: true, host: 'uw-host', v: 2, intents: site.runnable(), confirm: !!args.confirm, viewers: site.clients.size });
    if (ep === 'jobs') return json(200, { ok: true, jobs: site.jobsList() });
    if (ep === 'events') return site.sse(req, res, url);
  });
  const hostName = args.host || '127.0.0.1';
  let port = args.port ?? 4173;
  for (let i = 0; ; i++) {
    try { port = await listen(server, port, hostName); break; } catch (e) {
      if (e.code === 'EADDRINUSE' && args.port === undefined && i < 20) { port++; continue; }
      if (e.code === 'EADDRINUSE') throw new UserError(`port ${port} is in use; pick another with --port`);
      throw e;
    }
  }
  opts.port = port;
  const local = `http://localhost:${port}/`;
  const lan = hostName === '0.0.0.0' ? lanAddresses().map((a) => `http://${a}:${port}/`) : [];
  const info = sites.map((s) => ({ prefix: s.prefix, dir: s.dir, intents: s.runnable(), bound: !!s.bound() }));
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, dir: root, port, local, lan, sites: info }) + '\n');
  else {
    console.log(`uw host: serving ${path.relative(process.cwd(), root) || '.'} at ${local}`);
    for (const u of lan) console.log(`  on your network: ${u}  (phones on the same Wi-Fi; every viewer gets live results)`);
    for (const s of info) console.log(`  ${s.prefix}__uw/*  ${s.bound ? `intents: ${s.intents.join(', ') || '(none runnable)'}` : 'no bound.json (static only; no intent buttons)'}`);
    if (!info.length) console.log('  no site with bound.json found: serving files only');
    if (args.confirm) console.log('  --confirm: each job waits for y/N here');
    console.log(remoteHint(port));
    console.log('Ctrl-C to stop.');
  }
  // warm dataset caches in the background (handlers that support UW_WARM=1) so the first click answers in seconds
  if (!args['no-warm']) {
    const seen = new Set();
    for (const s of sites) for (const name of s.runnable()) {
      const h = s.resolveHandler(s.bound().intents[name]);
      if (!h || seen.has(h) || !/UW_WARM/.test(fs.readFileSync(h, 'utf8'))) continue;
      seen.add(h);
      const t0 = Date.now();
      const c = spawn(process.execPath, [h], { cwd: s.dir, stdio: ['ignore', 'ignore', 'pipe'], env: safeEnv({ UW_WARM: '1', UW_SITE: s.dir, UW_CACHE: uwCacheRoot() }) });
      c.stderr.on('data', () => {});
      c.on('close', (code) => console.error(`[${stamp()}] warm-up ${path.basename(h)}: ${code === 0 ? 'ready' : 'failed (code ' + code + ')'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`));
    }
  }
  await new Promise((resolve) => {
    const stop = () => {
      for (const s of sites) { s.unwatchReload(); for (const j of s.jobs.values()) if (j.child) try { j.child.kill('SIGTERM'); } catch {} for (const c of s.clients) try { c.end(); } catch {} }
      for (const s of sites) releaseSiteWrites(s.dir);
      server.close(); resolve();
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

// `reload <site>`: tell every open viewer to reload in place (see reloadHelp).
const cleanNote = (s) => { const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() : ''; return t ? t.slice(0, 80) : null; };
/** the running `uw host` that serves dir (its own --detach, or a gallery's), as { port, prefix, pid }, or null */
export function runningHost(dir) {
  for (const [d, prefix] of [[dir, '/'], [path.dirname(dir), `/${path.basename(dir)}/`]]) {
    const st = readState(d);
    if (st && st.cmd === 'host' && Number.isInteger(st.port) && alive(st.pid)) return { port: st.port, prefix, pid: st.pid };
    if (st && st.cmd === 'serve' && d === dir && alive(st.pid)) return { port: st.port, prefix, pid: st.pid, serve: true };
  }
  return null;
}
export async function reload(argv) {
  const args = parseArgs(argv, { note: 'string' }, { positionals: [1, 1], command: 'reload' });
  if (args.help) return console.log(reloadHelp);
  const out = makeOut(args);
  const dir = path.resolve(args._[0]);
  if (!exists(path.join(dir, 'index.html'))) throw new UserError(`"${args._[0]}" is not a site folder (no index.html)`);
  const note = cleanNote(args.note);
  const ver = stampReload(dir, note);
  const h = runningHost(dir);
  let viewers = null;
  if (h && !h.serve) {
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}${h.prefix}__uw/health`, { signal: AbortSignal.timeout(2000) });
      const j = r.ok ? await r.json() : null;
      if (j && Number.isInteger(j.viewers)) viewers = j.viewers;
    } catch { /* not answering: the stamp still reaches polling viewers */ }
  }
  const lines = [h && !h.serve
    ? `Reload sent: ${viewers == null ? 'open viewers' : viewers === 1 ? '1 open viewer' : viewers + ' open viewers'} reload in place (uw host on port ${h.port})${note ? ': "' + note + '"' : ''}.`
    : h?.serve
      ? `Stamped data/version.json, but \`uw serve\` (port ${h.port}) has no live channel: run uw host ${args._[0]} --detach --port ${h.port} so open viewers reload by themselves.`
      : 'Stamped data/version.json (viewers that poll it reload in place; others press ↻). No running `uw host` found for this folder: start one with --detach so every viewer reloads at once.'];
  out.result({ ok: true, dir, reload: ver.reload, note, host: h ? { port: h.port, prefix: h.prefix, live: !h.serve } : null, viewers }, lines);
  return 0;
}
