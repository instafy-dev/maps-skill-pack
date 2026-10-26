// Lookup chains: one mechanism for every outside lookup (place search, routing, page reads, …).
// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical copy: packages/instafy-bind/src/lookup.mjs. The interactive-map pack carries an identical copy
// (scripts/lib/lookup.mjs); scripts/sync-map-pack.mjs refuses to vendor the pack while the two differ. Zero deps.
//
// - Which services answer a capability, and in what order, is DATA, never code:
//     { "schema": "instafy.lookup-providers@1",
//       "providers": { "<id>": { "protocol": "<how to talk to it>", "base": "https://…", "base_env": "ENV_NAME",
//                                "timeout_ms": 20000 (0: the protocol keeps its own time), "cooldown_s": 600, "fail_threshold": 1, "slow_ms": 15000,
//                                "complete": true, "health": "provider" | "host" | "none", "label": "…",
//                                "max_concurrent": 2 } },
//       "chains": { "<capability>": ["<id>", …] },
//       "chain_rules": { "<capability>": { "on_empty": "next" | "stop" } } }
//   Code knows protocols (how to ask a kind of service), never a provider by name. `complete: false` marks a
//   provider whose empty answer proves nothing (an exact-title lookup).
// - Empty answers: by default (`on_empty: "next"`) an empty answer moves on to the next provider: one search not
//   knowing a small venue proves nothing while another source may know it. A capability whose first provider is
//   authoritative for "none here" (places of a kind in an area) declares `on_empty: "stop"`. An override that
//   replaces a chain keeps the rules declared before it.
// - Honesty: an answer from any provider but the first one asked is a fallback: status "partial", `fallback: true`,
//   `via` (who answered), `reason` (why the first could not), `missing` (fields the answer lacks). "not_found" only
//   when a complete provider answered empty and no provider was unavailable, skipped or out of time; nothing found
//   while one could not answer is "unavailable" (never "not found").
// - Time: `deadlineAt` (ms since the epoch) bounds the whole chain: each attempt gets at most the time left minus
//   what the rest of the chain needs (2 s each); a provider there is no time for is skipped with reason "budget".
// - Rate limits: an HTTP 429 opens that provider's breaker for its cooldown (at least its Retry-After), and no
//   command asks it again within the turn: never a retry storm against a service that asked us to slow down.
//   "health": "none": the provider's protocol keeps its health itself (per mirror, say); the chain only reads it.
// - Politeness: "max_concurrent" is how many lookups of that provider's host run at once on this machine, whatever
//   process asks (one lock file per slot next to the health file); work that runs side by side queues for a slot
//   instead of flooding a shared community service. A protocol that keeps its own health ("none") keeps its own slots.
// - INSTAFY_LOOKUP_PROVIDERS (JSON text, or a path to a JSON file) adds or replaces providers by id and replaces
//   whole chains: a self-hosted instance, or a declared fake provider for an outage drill (protocol "fake").
// - Health: a circuit breaker per provider (per provider and host with "health": "host"), kept in one small JSON
//   file every process on the machine shares.
//   A provider that was unavailable is skipped until its cooldown passes; a turn that started after the failure
//   (INSTAFY_TURN_STARTED_AT) gets one fresh try, so a person's "try again" is always a real try, except while a
//   Retry-After the service sent has not passed. The file lives in a folder that outlasts the turn: INSTAFY_LOOKUP_STATE,
//   else INSTAFY_LOOKUP_CACHE_DIR, else the runtime's per-space INSTAFY_CACHE_DIR, else ~/.cache/instafy.
// - One status contract: ok | partial | not_found | unavailable. "unavailable" (refused, timed out, busy, down:
//   the service could not answer) is never "not_found" (it answered: there is no such thing). CLIs exit 4 for it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA = "instafy.lookup-providers@1";
export const STATUS = Object.freeze({ OK: "ok", PARTIAL: "partial", NOT_FOUND: "not_found", UNAVAILABLE: "unavailable" });
/** The exit code every lookup CLI uses for "the service could not answer" (never for "not found"). */
export const EXIT_UNAVAILABLE = 4;
const DEFAULTS = { timeout_ms: 20_000, cooldown_s: 600, fail_threshold: 1 };
/** The least time an attempt is worth starting with (a provider with less left is skipped: reason "budget"). */
export const MIN_ATTEMPT_MS = 2000;
const ON_EMPTY = new Set(["next", "stop"]);

// ---------------------------------------------------------------------------------------------------------------
// Declarations

function readOverride(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const json = text.startsWith("{") ? text : fs.readFileSync(text, "utf8");
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INSTAFY_LOOKUP_PROVIDERS must be a JSON object");
  return value;
}

/** The declared providers and chains: `defaults` (a providers object), then each override in order (by default
 *  INSTAFY_LOOKUP_PROVIDERS). Throws on a chain that names an undeclared provider or a provider with no protocol. */
export function loadProviders(defaults, { env = process.env, overrides } = {}) {
  const layers = [defaults, ...(overrides ?? [readOverride(env.INSTAFY_LOOKUP_PROVIDERS)])].filter(Boolean);
  const providers = {};
  const chains = {};
  const rules = {};
  for (const layer of layers) {
    for (const [id, p] of Object.entries(layer.providers || {})) providers[id] = { ...(providers[id] || {}), ...p, id };
    for (const [capability, list] of Object.entries(layer.chains || {})) {
      if (!Array.isArray(list)) throw new Error(`lookup chain "${capability}" must be a list of provider ids`);
      chains[capability] = list.map(String);
    }
    for (const [capability, rule] of Object.entries(layer.chain_rules || {})) {
      if (rule?.on_empty != null && !ON_EMPTY.has(rule.on_empty)) throw new Error(`lookup chain "${capability}": on_empty must be "next" or "stop"`);
      rules[capability] = { ...(rules[capability] || {}), ...rule };
    }
  }
  for (const [id, p] of Object.entries(providers)) {
    if (typeof p.protocol !== "string" || !p.protocol) throw new Error(`lookup provider "${id}" declares no protocol`);
  }
  for (const [capability, list] of Object.entries(chains)) {
    for (const id of list) if (!providers[id]) throw new Error(`lookup chain "${capability}" names "${id}", which is not declared`);
  }
  return { providers, chains, rules, env };
}

/** What a capability's chain does with an empty answer: "next" (default: ask the next provider) or "stop". */
export function onEmptyOf(registry, capability) {
  return registry.rules?.[capability]?.on_empty || "next";
}

/** A provider's settings with its defaults and its base URLs (`base_env` overrides `base`/`bases`; a comma list
 *  is several mirrors of the same provider, each with its own health). */
export function resolveProvider(registry, id) {
  const p = registry.providers[id];
  if (!p) throw new Error(`lookup provider "${id}" is not declared`);
  const fromEnv = p.base_env ? String(registry.env?.[p.base_env] || "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const bases = (fromEnv.length ? fromEnv : p.bases?.length ? p.bases : p.base ? [p.base] : []).map((b) => String(b).replace(/\/+$/, ""));
  return { ...DEFAULTS, ...p, bases, base: bases[0] || null, label: p.label || id };
}

/** The provider ids of a capability's chain, in order ([] when the capability is not declared). */
export function chainOf(registry, capability) {
  return registry.chains[capability] || [];
}

// ---------------------------------------------------------------------------------------------------------------
// Health (circuit breakers), shared by every process through one small file

/** The folder lookup state (health, slots, locks) lives in: one that outlasts a turn. A hosted runtime gives each
 *  tool turn a fresh HOME and TMPDIR, so state kept there would be forgotten every turn; INSTAFY_CACHE_DIR is the
 *  runtime's stable per-space folder for skill packs. */
export function stateDir(env = process.env) {
  if (env.INSTAFY_LOOKUP_STATE) return path.dirname(env.INSTAFY_LOOKUP_STATE);
  if (env.INSTAFY_LOOKUP_CACHE_DIR) return env.INSTAFY_LOOKUP_CACHE_DIR;
  if (env.INSTAFY_CACHE_DIR) return path.join(env.INSTAFY_CACHE_DIR, "lookups");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "instafy");
}

/** The folder for slot and lock files (how many lookups of a service run at once on this machine): `slots` in the
 *  state folder, else, where that cannot be written (a read-only HOME, no INSTAFY_CACHE_DIR), the system's temporary
 *  folder, so the limit on concurrent requests to a public service still holds. */
const slotDirs = new Map();
export function slotsDir(env = process.env) {
  const want = path.join(stateDir(env), "slots");
  if (slotDirs.has(want)) return slotDirs.get(want);
  let dir = want;
  try {
    fs.mkdirSync(want, { recursive: true });
    fs.accessSync(want, fs.constants.W_OK);
  } catch {
    dir = path.join(os.tmpdir(), "instafy-lookup-slots");
  }
  slotDirs.set(want, dir);
  return dir;
}

export function defaultStateFile(env = process.env) {
  if (env.INSTAFY_LOOKUP_STATE) return env.INSTAFY_LOOKUP_STATE;
  return path.join(stateDir(env), "lookup-health.json");
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export class Health {
  constructor({ env = process.env, file = defaultStateFile(env), now = () => Date.now(), turnStartedAt = Date.parse(env.INSTAFY_TURN_STARTED_AT || "") } = {}) {
    this.file = file;
    this.now = now;
    this.turnStartedAt = Number.isFinite(turnStartedAt) ? turnStartedAt : null;
  }

  /** The breaker key: provider + base URL (mirrors and test servers never share a breaker), or + host. */
  key(p, { base = p.base, host = null } = {}) {
    return [p.id, base || "", ...(p.health === "host" && host ? [host] : [])].join("|");
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return value && typeof value.entries === "object" ? value : { v: 1, entries: {} };
    } catch {
      return { v: 1, entries: {} };
    }
  }

  /** Run `fn` holding the health file's lock (a sibling `.lock` file, created exclusively): commands that write
   *  at the same moment do not drop each other's entries. A lock older than 2 s is a crashed writer's and is taken
   *  over; after 1 s of waiting the write goes ahead without it (health is advice). */
  #locked(fn) {
    const lock = `${this.file}.lock`;
    let fd = null;
    const until = Date.now() + 1000;
    for (let tries = 0; fd === null; tries += 1) {
      try {
        fd = fs.openSync(lock, "wx");
      } catch (error) {
        if (error.code === "ENOENT" && tries === 0) {
          try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch { break; }
          continue;
        }
        if (error.code !== "EEXIST" || Date.now() > until) break;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.unlinkSync(lock); } catch { /* gone already */ }
        Atomics.wait(PAUSE, 0, 0, 3);
      }
    }
    try {
      return fn();
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* closed */ }
        try { fs.unlinkSync(lock); } catch { /* taken over */ }
      }
    }
  }

  #update(key, change) {
    this.#locked(() => this.#write(key, change));
  }

  #write(key, change) {
    try {
      const state = this.read();
      const next = change(state.entries[key] || {});
      if (next) state.entries[key] = next;
      else delete state.entries[key];
      // a day-old entry is history, not health
      for (const [k, e] of Object.entries(state.entries)) if (this.now() - (e.at || 0) > 864e5) delete state.entries[k];
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.file);
    } catch {
      // health is advice: a read-only disk must never fail a lookup
    }
  }

  /** { allow, probe, retry_after_s, slow }: closed → allow; open → skip until the cooldown passes or a newer
   *  turn starts, then one probe. */
  check(p, where = {}) {
    const e = this.read().entries[this.key(p, where)];
    const now = this.now();
    const slow = !!(e?.slow_until && e.slow_until > now);
    // a Retry-After the service sent holds whatever turn it is
    if (e?.hold_until && now < e.hold_until) return { allow: false, probe: false, slow, retry_after_s: Math.max(1, Math.ceil((e.hold_until - now) / 1000)), last_error: e.last_error || null, rate_limited: !!e.rate_limited };
    if (!e?.open_until) return { allow: true, probe: false, slow };
    if (now >= e.open_until || (this.turnStartedAt && (e.opened_at || 0) < this.turnStartedAt)) return { allow: true, probe: true, slow };
    return { allow: false, probe: false, slow, retry_after_s: Math.max(1, Math.ceil((e.open_until - now) / 1000)), last_error: e.last_error || null };
  }

  /** An answer (found or not): the breaker closes. Slower than `slow_ms` marks it slow for a cooldown; a quick
   *  answer clears that. */
  ok(p, ms, where = {}) {
    this.#update(this.key(p, where), (e) => {
      const now = this.now();
      // without a declared slow_ms only an explicit slow() marks it slow, and any answer clears that
      const slowUntil = !p.slow_ms ? 0 : ms > p.slow_ms ? now + p.cooldown_s * 1000 : ms < p.slow_ms / 3 ? 0 : e.slow_until || 0;
      return { at: now, ms: Math.round(ms), ...(slowUntil > now ? { slow_until: slowUntil } : {}) };
    });
  }

  /** A slow answer that ran out of the caller's time: not down, but ask the others first for a while. */
  slow(p, where = {}) {
    this.#update(this.key(p, where), (e) => ({ ...e, at: this.now(), slow_until: this.now() + p.cooldown_s * 1000 }));
  }

  /** A failure. `rate_limited` (HTTP 429) always opens the breaker, for the cooldown or the Retry-After, whichever
   *  is longer; a Retry-After also holds across a new turn. */
  fail(p, message, where = {}, { rate_limited = false, retry_after_s = null } = {}) {
    this.#update(this.key(p, where), (e) => {
      const now = this.now();
      const failures = (e.failures || 0) + 1;
      const opens = rate_limited || failures >= (p.fail_threshold || 1);
      const cooldownMs = Math.max((p.cooldown_s ?? DEFAULTS.cooldown_s) * 1000, retry_after_s > 0 ? retry_after_s * 1000 : 0);
      return {
        ...e, at: now, failures, last_error: String(message || "unavailable").slice(0, 200),
        ...(opens ? { open_until: now + cooldownMs, opened_at: now } : {}),
        ...(rate_limited ? { rate_limited: true } : {}),
        ...(retry_after_s > 0 ? { hold_until: now + retry_after_s * 1000 } : {}),
      };
    });
  }

  /** Close a breaker by hand (an operator who fixed the service). */
  reset(p, where = {}) {
    this.#update(this.key(p, where), () => null);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Slots: at most `max_concurrent` lookups of one provider at a time on this machine

const SLOT_STALE_MS = 180_000;
const slotOwnerGone = (file) => {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (!(pid > 0) || pid === process.pid) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
};

/** Run `fn` holding one of the provider's `max_concurrent` slots (no limit declared: at once). Waits for a free slot
 *  up to `waitMs`, then goes ahead without one (a slot is politeness, never a reason to fail a lookup). */
export async function withProviderSlot(p, fn, { env = process.env, waitMs = 60_000, now = () => Date.now() } = {}) {
  const slots = Math.floor(Number(p?.max_concurrent));
  if (!(slots >= 1)) return fn();
  const dir = slotsDir(env);
  // per host: two providers of the same service (search and reverse search) share its slots
  let host = null;
  try { host = p.base ? new URL(p.base).host : null; } catch { /* not a URL */ }
  const key = String(host || p.id).replace(/[^\w.-]+/g, "_");
  const until = now() + waitMs;
  let held = null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return fn(); }
  while (!held) {
    for (let i = 0; i < Math.min(slots, 16) && !held; i += 1) {
      const file = path.join(dir, `${key}.${i}.lock`);
      try {
        const fd = fs.openSync(file, "wx");
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        held = file;
      } catch (error) {
        if (error.code !== "EEXIST") return fn();
        try { if (slotOwnerGone(file) || now() - fs.statSync(file).mtimeMs > SLOT_STALE_MS) fs.unlinkSync(file); } catch { /* gone already */ }
      }
    }
    if (held || now() > until) break;
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    if (held) { try { fs.unlinkSync(held); } catch { /* taken over */ } }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Errors and classification

/** The error a lookup throws when no provider could answer: exit 4, status "unavailable". */
export class LookupUnavailableError extends Error {
  constructor(capability, attempts = [], { retry_after_s = null, label = null } = {}) {
    const tried = attempts.filter((a) => a.outcome !== "skipped").map((a) => `${a.label}: ${a.detail || a.outcome}`);
    super(`${label || capability} unavailable${tried.length ? ` (${tried.join("; ")})` : ""}`);
    this.name = "LookupUnavailableError";
    this.code = "unavailable";
    this.status = STATUS.UNAVAILABLE;
    this.exitCode = EXIT_UNAVAILABLE;
    this.capability = capability;
    this.attempts = attempts;
    this.retry_after_s = retry_after_s;
  }
}

/** Was this failure the service asking us to slow down (HTTP 429)? Then { retry_after_s } (null when it gave none). */
export function rateLimitOf(error) {
  const http = Number(error?.httpStatus ?? (typeof error?.status === "number" ? error.status : NaN));
  if (http !== 429 && error?.rateLimited !== true) return null;
  const ra = Number(error?.retryAfterS ?? error?.retry_after_s);
  return { retry_after_s: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : null };
}

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "timeout", "unavailable"]);

/** What a failed attempt says about the provider: "unavailable" (refused, timed out, busy: try another, open the
 *  breaker), "slow" (no answer within the share of time it was given: try another, ask it later first), "deadline"
 *  (the caller ran out of time: stop, nothing proven), "not_found" (it answered: no such thing), or "fatal" (a bad
 *  request or a policy refusal: the same everywhere, so stop). */
export function classify(error) {
  if (!error) return "fatal";
  if (error.deadline === true) return "deadline";
  if (error.slow === true) return "slow";
  if (error.status === STATUS.UNAVAILABLE || error.code === "unavailable") return "unavailable";
  if (error.code === "policy" || error.code === "invalid") return "fatal";
  const http = Number(error.httpStatus ?? (typeof error.status === "number" ? error.status : NaN));
  if (http === 429 || http >= 500) return "unavailable";
  // a page that is gone (`httpStatus`, set by page reads) is an answer; an API endpoint that is not there
  // (`status` 404 from a JSON client) is a provider that cannot answer, never "no such place"
  if (http === 404 || http === 410) return error.httpStatus != null ? "not_found" : "unavailable";
  if (http >= 400) return "fatal";
  const code = error.code || error.cause?.code || error.cause?.cause?.code;
  if (code && UNAVAILABLE_CODES.has(code)) return "unavailable";
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "SkipError") return "unavailable";
  if (/timed out|request failed|fetch failed|socket hang up|could not read|cannot resolve|no answer|busy|unavailable|ECONNREFUSED|HTTP (429|5\d\d)/i.test(error.message || "")) return "unavailable";
  return "fatal";
}

// ---------------------------------------------------------------------------------------------------------------
// Running a chain

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The built-in protocol for drills and tests: a provider that behaves as declared ("behaviour": "unavailable" |
 *  "not_found" | "results" | "slow"; "results": [...]; "delay_ms"). Never reaches the network. */
export const fakeProtocol = {
  async lookup(_request, p) {
    if (p.delay_ms) await sleep(p.delay_ms);
    switch (p.behaviour || "unavailable") {
      case "results": return structuredClone(p.results || []);
      case "not_found": return [];
      case "slow": return new Promise(() => {}); // never answers: the chain's timeout ends it
      default: throw Object.assign(new Error(`${p.label || p.id}: connection refused (declared outage)`), { code: "ECONNREFUSED" });
    }
  },
};

/** Race a promise against a timeout that rejects as unavailable. */
async function withTimeout(promise, ms, label) {
  if (!(ms > 0) || ms === Infinity) return promise;
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label}: no answer in ${Math.round(ms / 1000)} s`), { code: "timeout" })), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a capability's chain. `protocols` maps a protocol name to { lookup(request, provider, ctx), accepts?(request,
 * provider) }; `lookup` resolves an array of results, or { results, partial, notes, meta, missing }. Every provider is
 * asked at most once. `deadlineAt` (ms since the epoch, optional) bounds the whole chain; `onEmpty` overrides the
 * capability's rule for one request.
 * Resolves { status, results, provider, label, attempts, retry_after_s, via, fallback, missing, reason }:
 *   ok: the first provider asked found something, and says its answer is complete;
 *   partial: something was found, but by a fallback (an earlier provider was down, out of time or found nothing), or
 *     the provider says its answer is incomplete (`partial`, `missing`, or `complete: false`);
 *   not_found: a complete provider answered and found nothing, and no provider failed to answer;
 *   unavailable: nothing found, and at least one provider could not answer (each one's reason is in `attempts`).
 * A "fatal" error (bad request, policy) is thrown as is; so is a "deadline" one, after marking the provider slow.
 */
export async function runChain(capability, request, { registry, health = new Health(), protocols = {}, where = {}, log = null, deadlineAt = null, now = () => Date.now(), onEmpty: askedOnEmpty = null } = {}) {
  const ids = chainOf(registry, capability);
  // a caller with its own next step for an empty answer (another tag set, the same search in English) says "stop"
  const onEmpty = askedOnEmpty && ON_EMPTY.has(askedOnEmpty) ? askedOnEmpty : onEmptyOf(registry, capability);
  const attempts = [];
  let retryAfter = null;
  let emptyAnswer = null;
  const couldNotAnswer = () => attempts.filter((a) => a.outcome === STATUS.UNAVAILABLE || a.outcome === "skipped_open" || a.outcome === "skipped_budget");
  const askedBefore = () => attempts.filter((a) => a.outcome !== "skipped");
  const reasonOf = (list) => list.map((a) => `${a.label} ${a.outcome === STATUS.NOT_FOUND ? "found nothing" : a.outcome === "skipped_budget" ? "had no time left" : `unavailable${a.detail ? ` (${a.detail})` : ""}`}`).join("; ");
  for (const [n, id] of ids.entries()) {
    const p = resolveProvider(registry, id);
    const protocol = p.protocol === "fake" ? fakeProtocol : protocols[p.protocol];
    const attempt = { provider: id, label: p.label };
    if (p.enabled === false || !protocol) { attempts.push({ ...attempt, outcome: "skipped", detail: protocol ? "disabled" : `no "${p.protocol}" protocol here` }); continue; }
    if (protocol.accepts && !protocol.accepts(request, p)) { attempts.push({ ...attempt, outcome: "skipped", detail: "cannot answer this request" }); continue; }
    // a provider with several mirrors keeps one breaker per mirror (its protocol asks them and reports each);
    // the chain only needs one of them to be askable
    const mirrored = p.bases.length > 1 || p.health === "none";
    const at = { base: p.base, ...where };
    const state = mirrored ? mirrorState(health, p, where) : health.check(p, at);
    if (!state.allow) {
      attempts.push({ ...attempt, outcome: "skipped_open", detail: `${state.rate_limited ? "rate-limited" : "down"}, retry in ${state.retry_after_s} s`, retry_after_s: state.retry_after_s });
      retryAfter = retryAfter == null ? state.retry_after_s : Math.min(retryAfter, state.retry_after_s);
      continue;
    }
    // the time budget: a provider with less than a minimal try left is not asked; while there is room, each one
    // leaves a minimal try for every provider after it (when there is not, it gets all that is left and the
    // command's own deadline ends it, as "out of time", never as "this service is down")
    let reservedMs = null;
    if (deadlineAt != null) {
      const left = deadlineAt - now();
      if (left < MIN_ATTEMPT_MS) {
        attempts.push({ ...attempt, outcome: "skipped_budget", detail: "no time left in this command" });
        log?.(`${p.label} not asked: no time left in this command`);
        continue;
      }
      // a minimal try for each later provider, and a little slack so the cut-off provider's end still leaves it
      const reserve = (ids.length - n - 1) * (MIN_ATTEMPT_MS + 500);
      if (reserve > 0 && left - reserve >= Math.max(2 * MIN_ATTEMPT_MS, left * 0.6)) reservedMs = left - reserve;
    }
    let t0 = Date.now();
    try {
      // a slot of the provider first (its own health, its own slots): the time limit counts from the slot
      const own = p.timeout_ms > 0 ? p.timeout_ms + 5000 : 0;
      const budgetCut = reservedMs != null && (!(own > 0) || reservedMs < own);
      const limit = budgetCut ? reservedMs : own;
      // cut short to leave time for the next provider: slow (asked later first), not down
      const ask = () => { t0 = Date.now(); return withTimeout(Promise.resolve(protocol.lookup(request, p, { health, where: at, attempt })), limit, p.label)
        .catch((error) => { if (budgetCut && error?.code === "timeout") error.slow = true; throw error; }); };
      const answer = mirrored ? await ask() : await withProviderSlot(p, ask, { env: registry.env || process.env, waitMs: deadlineAt != null ? Math.max(0, Math.min(60_000, (deadlineAt - now()) / 2)) : 60_000 });
      const ms = Date.now() - t0;
      if (!mirrored) health.ok(p, ms, at);
      const results = Array.isArray(answer) ? answer : answer?.results || [];
      const missing = Array.isArray(answer) ? [] : Array.isArray(answer?.missing) ? answer.missing : [];
      const ownPartial = (!Array.isArray(answer) && !!answer?.partial) || missing.length > 0;
      if (results.length) {
        // anyone asked before this one (down, out of time, or found nothing) makes this answer a fallback
        const before = askedBefore();
        const fallback = before.length > 0;
        const partial = ownPartial || fallback || p.complete === false;
        attempts.push({ ...attempt, outcome: partial ? STATUS.PARTIAL : STATUS.OK, ms });
        const notes = Array.isArray(answer) ? [] : answer?.notes || [];
        const meta = Array.isArray(answer) ? null : answer?.meta ?? null;
        const why = [
          ...(fallback ? [`fallback: ${reasonOf(before)}`] : []),
          ...(p.complete === false ? [`${p.label} gives an incomplete answer`] : []),
          ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
        ];
        return {
          status: partial ? STATUS.PARTIAL : STATUS.OK, results, notes, meta, provider: id, label: p.label, attempts, retry_after_s: null,
          via: [id], fallback, missing, reason: why.join("; ") || null,
        };
      }
      attempts.push({ ...attempt, outcome: STATUS.NOT_FOUND, ms });
      if (p.complete !== false) {
        emptyAnswer ||= { provider: id, label: p.label };
        if (onEmpty === "stop") break;
      }
    } catch (error) {
      const kind = classify(error);
      const detail = String(error?.message || error).replace(new RegExp(`^${p.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), "").slice(0, 160);
      if (kind === "deadline") { if (!mirrored) health.slow(p, at); throw error; }
      if (kind === "slow") {
        if (!mirrored) health.slow(p, at);
        attempts.push({ ...attempt, outcome: STATUS.UNAVAILABLE, detail, ms: Date.now() - t0 });
        log?.(`${p.label} too slow (${detail})${n < ids.length - 1 ? "; asking the next one" : ""}`);
        continue;
      }
      if (kind === "not_found") {
        attempts.push({ ...attempt, outcome: STATUS.NOT_FOUND, detail, ms: Date.now() - t0 });
        if (p.complete !== false) {
          emptyAnswer ||= { provider: id, label: p.label };
          if (onEmpty === "stop") break;
        }
        continue;
      }
      if (kind === "fatal") throw error;
      // asked to slow down (429): not asked again this turn by any command (its breaker opens at once)
      const limited = rateLimitOf(error);
      if (!mirrored) health.fail(p, detail, at, limited ? { rate_limited: true, retry_after_s: limited.retry_after_s } : {});
      if (limited?.retry_after_s) retryAfter = retryAfter == null ? limited.retry_after_s : Math.min(retryAfter, limited.retry_after_s);
      attempts.push({ ...attempt, outcome: STATUS.UNAVAILABLE, detail: limited ? `rate-limited (HTTP 429)${limited.retry_after_s ? `, retry after ${limited.retry_after_s} s` : ""}` : detail, ms: Date.now() - t0 });
      log?.(`${p.label} ${limited ? "asked us to slow down (HTTP 429): not asked again this turn" : `unavailable (${detail})`}${n < ids.length - 1 ? "; asking the next one" : ""}`);
    }
  }
  const failed = couldNotAnswer();
  if (failed.length) {
    return { status: STATUS.UNAVAILABLE, results: [], provider: null, attempts, retry_after_s: retryAfter, via: [], fallback: false, missing: [], reason: reasonOf(failed) };
  }
  if (emptyAnswer) return { status: STATUS.NOT_FOUND, results: [], provider: emptyAnswer.provider, label: emptyAnswer.label, attempts, retry_after_s: null, via: [emptyAnswer.provider], fallback: false, missing: [], reason: null };
  if (attempts.some((a) => a.outcome === STATUS.NOT_FOUND)) return { status: STATUS.NOT_FOUND, results: [], provider: null, attempts, retry_after_s: null, via: [], fallback: false, missing: [], reason: null };
  return { status: STATUS.UNAVAILABLE, results: [], provider: null, attempts, retry_after_s: retryAfter, via: [], fallback: false, missing: [], reason: "no provider could answer this request" };
}

/** runChain, but "unavailable" throws LookupUnavailableError (exit 4); ok/partial/not_found resolve. */
export async function lookup(capability, request, options = {}) {
  const r = await runChain(capability, request, options);
  if (r.status === STATUS.UNAVAILABLE) throw new LookupUnavailableError(capability, r.attempts, { retry_after_s: r.retry_after_s, label: options.label });
  return r;
}

/** The breaker state of a mirrored provider: askable when any mirror is (slow only when every askable one is). */
function mirrorState(health, p, where) {
  if (!p.bases.length) return { allow: true, probe: false, slow: false };
  const states = p.bases.map((base) => health.check(p, { ...where, base }));
  const open = states.filter((s) => s.allow);
  if (open.length) return { allow: true, probe: open.every((s) => s.probe), slow: open.every((s) => s.slow) };
  return { allow: false, slow: false, retry_after_s: Math.min(...states.map((s) => s.retry_after_s || 1)) };
}

/** Can anything in this chain be asked right now? { available, slow, degraded, retry_after_s, providers }:
 *  slow = the first askable provider answered slowly lately; degraded = the chain's first provider is down or slow
 *  (optional extra lookups wait; a long job leaves them for later). */
export function chainHealth(capability, { registry, health = new Health(), where = {} } = {}) {
  const providers = chainOf(registry, capability).map((id) => {
    const p = resolveProvider(registry, id);
    return { id, label: p.label, ...(p.bases.length > 1 || p.health === "none" ? mirrorState(health, p, where) : health.check(p, { base: p.base, ...where })) };
  });
  const first = providers.find((x) => x.allow);
  const waits = providers.filter((x) => !x.allow).map((x) => x.retry_after_s);
  return {
    available: !!first, slow: !!first?.slow, degraded: !!providers.length && (!providers[0].allow || providers[0].slow),
    retry_after_s: first ? null : waits.length ? Math.min(...waits) : null, providers,
  };
}

/** Tally many lookups (one per place, page, leg) into one honest status: all found → ok; some unavailable or
 *  partial → partial; none answered → unavailable; all answered, nothing found → not_found. */
export class Tally {
  constructor() { this.counts = { ok: 0, partial: 0, not_found: 0, unavailable: 0 }; this.unavailable = new Map(); }
  add(status, { label = null, retry_after_s = null } = {}) {
    this.counts[status] = (this.counts[status] || 0) + 1;
    if (status === STATUS.UNAVAILABLE && label) this.unavailable.set(label, retry_after_s ?? this.unavailable.get(label) ?? null);
    return this;
  }
  get status() {
    const c = this.counts;
    const found = c.ok + c.partial;
    if (c.unavailable && !found && !c.not_found) return STATUS.UNAVAILABLE;
    if (c.unavailable || c.partial) return found || c.not_found ? STATUS.PARTIAL : STATUS.UNAVAILABLE;
    if (!found && c.not_found) return STATUS.NOT_FOUND;
    return STATUS.OK;
  }
  toJSON() { return { status: this.status, ...this.counts, unavailable_services: [...this.unavailable.keys()] }; }
}

/** One plain line for a person (and the agent's reply) about what could not be looked up. */
export function unavailableLine(what, { services = [], retry_after_s = null } = {}) {
  const who = services.length ? ` (${[...new Set(services)].join(", ")} did not answer)` : "";
  const when = retry_after_s ? ` A retry in about ${Math.max(1, Math.round(retry_after_s / 60))} min, or the person's next "try again", asks again.` : " Asking again later may work.";
  return `UNAVAILABLE: ${what} could not be looked up right now${who}; this is not "not found".${when}`;
}
