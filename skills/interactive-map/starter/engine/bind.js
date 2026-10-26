// map-pack engine: two-way binding (ENGINE-SPEC-v0.2 §9). Kit-owned file: sites should not edit it.
//
// OUT  a click on a declared intent button becomes one intent, sent over every transport at once (hosts dedupe by
//      id): parent postMessage, window events, window.instafy (if present), POST __uw/intent (if `uw host` answered),
//      and a host-provided MessagePort. A host that speaks Instafy's bind v1 (Instafy docs/Bound-Sites.md §2: "instafy-bind"
//      envelopes, a MessagePort or window.instafy) gets v1 messages: hello, intent.request, intent.cancel,
//      intent.resume, session.show. Everything else gets the v2 "instafy-map" message.
// IN   results come back as records, from any of: parent postMessage, a MessagePort, Server-Sent Events from
//      __uw/events, window.instafy.on(), or by polling data/version.json and re-fetching changed records files
//      (the Instafy "apply" model: works for every viewer, including late joiners). All paths end in handle().
//
// Nothing here trusts what comes in: messages are shape-checked, records are validated in records.js, and strings
// are only ever rendered with textContent.
import { postIntent, setPort, embedded } from './bridge.js';
import { validate, applyDefaults, fmtErrors } from './schema.js';
import { fmtClock } from './util.js';
import { fromBindRecord } from './records.js';

const HOST_TYPES = ['hello', 'ack', 'progress', 'results', 'done', 'error', 'command'];
// reload: the site changed (`uw reload <site>` over SSE, data/version.json "reload", or the host's ↻): soft reload in place.
// "layout" (insets, title, caps) is not a bind message: host.js reads it straight from the parent frame; one that
// arrives on the host's MessagePort is handed to host.js (E.hostLayout).
const COMMANDS = ['select', 'flyTo', 'setLens', 'setTime', 'highlight', 'reload', 'navigate'];
const UI_PLACES = /^(card|card-more|sheet-header|map-context|list-row|compare-cell:[a-z][a-z0-9_]*)$/;
const NO_LISTENER_MS = 5000;
// a job's status only moves forward: an ack that arrives late (the POST answer after the SSE "running") never undoes it
const RANK = { sent: 0, queued: 1, needs_confirm: 2, running: 3 };
const NEEDS = { sign_in: 'Sign in needed in your browser', captcha: 'A check needs you in your browser', confirm_cart: 'Confirm in your browser',
  approve_origin: 'Approve the site in Instafy', confirm: 'Waiting for confirmation in chat' };
const newId = () => 'int_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6).padEnd(4, '0');

/** The cooldown key, identical on the page and in `uw host` (cmd-host.mjs coolKey): an item's ref, else the params
 *  with coordinates rounded to ~50 m, so a long-press on another street is a new request, not a repeat. */
export function coolKey(name, ref, params) {
  if (ref) return `${name}|${ref}`;
  const norm = (v) => (Array.isArray(v) ? (v.length === 2 && v.every((x) => typeof x === 'number') ? v.map((x) => Math.round(x / 0.0005) * 0.0005).map((x) => +x.toFixed(4)) : v.map(norm))
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== 'refresh').map((k) => [k, norm(v[k])])) : v);
  return `${name}|${JSON.stringify(norm(params || {}))}`;
}

export class Bind {
  constructor(E) {
    this.E = E;
    this.intents = new Map();
    this.listen = { parent: false, instafy: false, host: false, forced: false, port: false };
    this.pending = new Map();     // intent id → job (this viewer's)
    this.remote = new Map();      // intent id → job another viewer started (shown as pending, never cooled)
    this.outcome = new Map();     // `${ref}|${attr}` and `name|ref` → { at, kind: 'none'|'error', code, message, retry }
    this.lastOk = new Map();      // same keys → { at, summary, count } of the last job that brought something back
    this.cool = new Map();        // coolKey → until (ms)
    this.done = new Set();        // ids already finished (dedupe across transports)
    this.files = new Map();       // records path → version loaded
    this.version = null;
    this.parentOrigin = null;
    this.user = null;
    this.capabilities = null;     // names a host said it will run (null = all)
    this.hostIntents = null;
    this.protocol = 'instafy-host';
    this.helloSeen = false;       // a host introduced itself: it will answer (or hold the intent in a tray)
    this.jobToId = new Map();
    this.taskToId = new Map();
    this.lastEid = null;
    this.resultFiles = []; this.pollOn = false; this.pollS = 3; this.versionPath = 'data/version.json'; this.parentOrigins = null;
  }

  // ---------- setup ----------
  /** @param {object} o { config, bound (parsed bound.json or null), boundHash ("sha256:…" or null), hostHint (bool) } */
  async init({ config, bound, boundHash, hostHint }) {
    const cfg = config.bind && typeof config.bind === 'object' ? config.bind : {};
    this.cfg = cfg;
    this.siteId = String(bound?.siteId || cfg.siteId || location.pathname.split('/').filter(Boolean).pop() || config.title || 'map').slice(0, 80);
    this.manifestHash = boundHash || null;
    const add = (name, def, from) => {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(name) || !def || typeof def !== 'object') { console.warn(`[map] intent "${name}" ignored (name must be snake_case, def an object)`); return; }
      if (this.intents.has(name) && from === 'bound.json') console.warn(`[map] intent "${name}" is declared in both map.config.json and bound.json; bound.json wins`);
      const ui = (Array.isArray(def.ui) ? def.ui : def.ui ? [def.ui] : ['card']).filter((u) => { const ok = UI_PLACES.test(u); if (!ok) console.warn(`[map] intent "${name}": unknown ui "${u}"`); return ok; });
      this.intents.set(name, { name, label: name.replace(/_/g, ' '), emoji: '✨', pending: 'item', cooldown_s: 20, timeout_s: 90, ...def, ui, from });
    };
    for (const [n, d] of Object.entries(config.intents || {})) add(n, d, 'config');
    for (const [n, d] of Object.entries(bound?.intents || {})) add(n, d, 'bound.json');
    const res = { ...(bound?.results || {}), ...(cfg.results || {}) };
    this.resultFiles = [...new Set([...(Array.isArray(res.files) ? res.files : []), ...[...this.intents.values()].map((d) => d.target?.records).filter(Boolean)])]
      .filter((p) => typeof p === 'string' && /^[\w./-]+\.json$/.test(p) && !p.includes('..'));
    this.pollS = Math.max(1, Number(res.poll_s) || 3);
    this.sseOn = res.sse !== false;
    this.pollOn = res.poll !== false && (this.resultFiles.length > 0 || !!bound || !!config.bind);
    this.versionPath = typeof res.version === 'string' ? res.version : 'data/version.json';
    const po = Array.isArray(cfg.parentOrigins) ? cfg.parentOrigins : Array.isArray(bound?.parentOrigins) ? bound.parentOrigins : null;
    this.parentOrigins = po ? po.filter((x) => typeof x === 'string') : null;
    this.attribution = Array.isArray(bound?.attribution) ? bound.attribution.filter((x) => typeof x === 'string') : [];

    window.addEventListener('message', (e) => this.onWindowMessage(e));
    const early = window.__uwEarly || []; window.__uwEarly = null;
    for (const e of early) this.onWindowMessage(e);
    if (/(^|[#&])bind=1(&|$)/.test(location.hash)) this.listen.forced = true;
    this.detectInstafy();
    // a host that injects window.instafy after load can announce itself
    window.addEventListener('instafy:ready', () => { this.detectInstafy(); this.changed(); });
    // an embedding host learns who we are first (v1 hello; a host that only speaks v2 ignores it)
    if (embedded() && this.intents.size) this.sendV1('hello', { siteId: this.siteId, manifestHash: this.manifestHash }, 'parent');
    if (this.intents.size || hostHint) await this.probeHost(hostHint);
    if (this.pollOn) await this.loadAll();
    this.schedulePoll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.schedulePoll(0); });
    this.changed();
  }
  detectInstafy() {
    const I = window.instafy;
    if (!I || typeof I !== 'object' || this.listen.instafy) return;
    if (typeof I.intent === 'function' || typeof I.request === 'function') {
      this.listen.instafy = true;
      if (typeof I.on === 'function') { try { I.on('message', (m) => this.handle(m, 'instafy')); } catch { /* */ } }
      if (typeof I.hello === 'function') {
        try { const r = I.hello({ siteId: this.siteId, manifestHash: this.manifestHash }); if (r && typeof r.then === 'function') r.then((a) => { if (a && typeof a === 'object') this.handle({ source: 'instafy-bind', v: 1, type: 'hello.ack', payload: a }, 'instafy'); }).catch(() => {}); } catch { /* */ }
      }
    }
  }
  async probeHost(hint) {
    if (!hint) return;
    try {
      const r = await fetch('__uw/health', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || j.ok !== true) return;
      this.listen.host = true;
      if (Array.isArray(j.intents)) this.hostIntents = j.intents.filter((x) => typeof x === 'string');
      if (this.sseOn && typeof EventSource === 'function') this.openSSE();
    } catch { /* not a uw host */ }
  }
  openSSE() {
    if (this.es) return;
    try {
      const es = this.es = new EventSource('__uw/events');
      for (const t of HOST_TYPES) es.addEventListener(t, (ev) => { let d; try { d = JSON.parse(ev.data); } catch { return; } this.handle({ ...d, source: d.source || 'instafy-host', type: d.type || t }, 'sse'); });
      es.onmessage = (ev) => { let d; try { d = JSON.parse(ev.data); } catch { return; } this.handle({ source: 'instafy-host', ...d }, 'sse'); };
      es.onerror = () => { /* the browser reconnects with Last-Event-ID */ };
    } catch (e) { console.warn('[map] SSE unavailable:', e.message); }
  }

  /** Is anything listening? (buttons render only then; §9.1 Visibility) */
  get active() { const l = this.listen; return !!(l.parent || l.instafy || l.host || l.forced || l.port); }
  changed() { this.E.onBindChange?.(); }

  // ---------- v1 out (Instafy bind) ----------
  sendV1(type, payload, to = 'all') {
    const msg = { source: 'instafy-bind', v: 1, type, payload };
    try { if ((to === 'all' || to === 'port') && this.port) this.port.postMessage(msg); } catch { /* closed */ }
    try { if ((to === 'all' || to === 'parent') && embedded()) window.parent.postMessage(msg, this.parentOrigin || '*'); } catch { /* */ }
  }
  get v1() { return this.protocol === 'instafy-bind'; }

  // ---------- which buttons ----------
  allowed(name) {
    if (this.capabilities && !this.capabilities.includes(name)) return false;
    if (this.hostIntents && this.listen.host && !this.listen.parent && !this.listen.instafy && !this.listen.forced && !this.hostIntents.includes(name)) return false;
    return true;
  }
  /** intents for a UI placement ('card', 'card-more', 'sheet-header', 'map-context', 'list-row'); item = {layer,id} or null */
  forPlace(place, item) {
    if (!this.active) return [];
    return [...this.intents.values()].filter((d) => d.ui.includes(place) && this.allowed(d.name) && this.layerOk(d, item));
  }
  /** an intent's "layers" may name a layer another intent creates at run time (target.create) */
  layerOk(d, item) { return !item || !Array.isArray(d.layers) || d.layers.includes(item.layer); }
  /** "check again" intent for a claim/offer row: the record's own intent, else one that produces the attribute
   *  ("produces": [...] in bound.json, or ui compare-cell:<attr>) */
  forCell(attr, item, rec) {
    if (!this.active) return null;
    const own = rec?.prov?.intent?.name && this.intents.get(rec.prov.intent.name);
    if (own && this.allowed(own.name) && (own.ui.includes('compare-cell:' + attr) || own.ui.includes('card') || (own.produces || []).includes(attr))) return { def: own, params: rec.prov.intent.params || null };
    const d = [...this.intents.values()].find((x) => (x.ui.includes('compare-cell:' + attr) || (Array.isArray(x.produces) && x.produces.includes(attr))) && this.allowed(x.name) && this.layerOk(x, item));
    return d ? { def: d, params: null } : null;
  }
  cooling(name, ref, params) { const t = this.cool.get(coolKey(name, ref, params)); return !!(t && t > Date.now()); }
  /** when (ms) the cooldown for this request ends, or 0 */
  coolUntil(name, ref, params) { const t = this.cool.get(coolKey(name, ref, params)); return t && t > Date.now() ? t : 0; }

  // ---------- intents out ----------
  /** Prefill params from tokens ("$item.ref", "$pin.lnglat|$view.center", literals). */
  prefill(def, ctx) {
    const out = {};
    const resolve = (tok) => {
      if (typeof tok !== 'string' || !tok.startsWith('$')) return tok;
      for (const alt of tok.split('|')) { const v = this.E.token(alt.trim(), ctx); if (v !== undefined && v !== null && v !== '') return v; }
      return undefined;
    };
    for (const [k, v] of Object.entries(def.prefill || {})) { const x = resolve(v); if (x !== undefined) out[k] = x; }
    return applyDefaults(def.params, out);
  }
  /** Public entry (uw.intent): throws for undeclared names. Returns the id, or null when cancelled / invalid. */
  async run(name, params, o = {}) {
    const def = this.intents.get(name);
    if (!def) throw new Error(`intent "${name}" is not declared (bound.json or map.config.json "intents")`);
    const ctx = { item: o.item || (o.ref ? this.E.itemFor(o.ref) : null), pin: o.pin || null };
    let p = { ...this.prefill(def, ctx), ...(params || {}) };
    if (o.refresh && def.params?.properties?.refresh) p.refresh = true;
    const missing = (def.params?.required || []).filter((k) => p[k] === undefined || p[k] === '');
    if (missing.length) {
      p = await this.E.ui.intentForm(def, p, missing);
      if (!p) return null;
    }
    const errs = def.params ? validate(def.params, p) : [];
    if (errs.length) { this.E.ui.toast(`Can't send “${def.label}”: ${fmtErrors(errs, 1)}`, 4500); console.warn('[map] intent params invalid:', fmtErrors(errs)); return null; }
    if (JSON.stringify(p).length > 4096) { this.E.ui.toast(`Can't send “${def.label}”: too much data`, 3500); return null; }
    if (def.confirm === true) {
      const ok = await this.E.ui.confirm(`Send to the agent?`, `${def.emoji || ''} ${def.label}${ctx.item ? ' · ' + (ctx.item.name || '') : ''}`.trim(), 'Send');
      if (!ok) return null;
    }
    return this.emit(def, p, { ref: o.ref ?? ctx.item?.ref ?? null, ui: o.ui || 'card', attr: o.attr || null, pending: o.pending });
  }
  emit(def, params, env) {
    const id = newId();
    // no "by": who clicked is stamped by the host, never claimed by the page
    const msg = { source: 'instafy-map', v: 2, type: 'intent', id, name: def.name, params, ui: env.ui, ref: env.ref || null };
    if (env.attr) msg.attr = env.attr;
    msg.site = { title: String(this.E.config?.title || document.title || '').slice(0, 120), path: location.pathname.slice(0, 300) };
    msg.state = this.E.stateHint();
    msg.at = new Date().toISOString();
    const mode = env.pending || def.pending || 'item';
    const job = { id, name: def.name, def, params, ref: env.ref || null, attr: env.attr || null, ui: env.ui, mode,
      layer: def.target?.layer || null, status: 'sent', progress: null, started: Date.now(), acked: false, delivered: false, count: 0, refs: new Set() };
    this.pending.set(id, job);
    this.outcome.delete(this.outKey(job));
    const ck = job.cool = coolKey(def.name, job.ref, params);
    const cd = Math.max(0, Number(def.cooldown_s ?? 20)) * 1000;
    this.cool.set(ck, Date.now() + cd);
    // redraw the buttons when the cooldown ends ("✓ Checked" → "Check licence again")
    if (cd) setTimeout(() => this.changed(), cd + 60);
    // 1 + 2 (+ port): parent frame and window events. A v1 host gets the v1 request on its port / parent instead.
    const v1 = { iid: id, name: def.name, params, ...(job.ref ? { ref: job.ref } : {}) };
    if (this.v1) {
      this.sendV1('intent.request', v1);
      postIntent(msg, this.parentOrigin || '*', [], { port: false, parent: false });
    } else postIntent(msg, this.parentOrigin || '*');
    // 3: window.instafy (the Instafy desktop tab; its resolved value is an ack)
    const I = window.instafy;
    try {
      const r = typeof I?.request === 'function' ? I.request(v1) : typeof I?.intent === 'function' ? I.intent(msg) : null;
      if (r && typeof r.then === 'function') r.then((a) => { if (a && typeof a === 'object') this.handle({ source: 'instafy-host', type: 'ack', id, status: a.status || 'queued', ...a }, 'instafy'); else job.delivered = true; }).catch(() => {});
    } catch (e) { console.warn('[map] window.instafy.request threw:', e.message); }
    // 4: the dev host
    if (this.listen.host) {
      fetch('__uw/intent', { method: 'POST', body: JSON.stringify(msg), headers: { 'content-type': 'application/json' } })
        .then(async (r) => {
          let j = null; try { j = await r.json(); } catch { /* */ }
          if (j?.status === 'rejected') this.handle({ source: 'instafy-host', type: 'ack', id, status: 'rejected', reason: j.reason || 'rejected', retry_after_s: j.retry_after_s }, 'host');
          else if (r.status === 202 || r.status === 409) { job.delivered = true; this.handle({ source: 'instafy-host', type: 'ack', id, status: j?.status || 'queued', job: j?.job }, 'host'); }
          else if (r.status >= 400) this.handle({ source: 'instafy-host', type: 'ack', id, status: 'rejected', reason: j?.reason || (r.status === 404 ? 'unknown intent' : `HTTP ${r.status}`) }, 'host');
        }).catch(() => { /* host gone; other transports may still answer */ });
    }
    this.E.emit('intent', { id, name: def.name, params, ref: job.ref, ui: env.ui });
    job.noListener = setTimeout(() => {
      if (!this.pending.has(id) || job.acked || job.delivered) return;
      // a host that said hello holds the intent (Instafy's "Send to Octo" tray): wait for it, don't give up
      if (this.helloSeen || this.listen.port || this.listen.instafy) { job.status = 'sent'; job.waiting = true; this.E.onPending?.(job); return; }
      this.cool.delete(ck); // nothing was sent anywhere: the button is free again
      this.finish(job, null);
      this.E.ui.toast('No agent is connected to this map. Open it in Instafy, or run uw host.', 5000);
    }, NO_LISTENER_MS);
    this.armTimeout(job);
    this.schedulePoll();
    this.E.onPending?.(job);
    return id;
  }
  armTimeout(job) {
    clearTimeout(job.timeout);
    job.timeout = setTimeout(() => {
      if (this.pending.has(job.id)) this.handle({ source: 'instafy-host', type: 'error', id: job.id, error: { code: 'timeout', message: 'The agent took too long.' } }, 'local');
    }, Math.max(5, Number(job.def.timeout_s ?? 90)) * 1000);
  }
  outKey(job) { return job.mode.startsWith('cell:') ? `${job.ref}|${job.mode.slice(5)}` : `${job.name}|${job.ref || ''}`; }
  /** Re-emit a finished/failed job with the same params and a new id. */
  retry(o) { const def = this.intents.get(o.name); if (!def) return null; return this.emit(def, o.params, { ref: o.ref, ui: o.ui, attr: o.attr, pending: o.mode }); }
  cancel(id) {
    const job = this.pending.get(id); if (!job) return;
    const msg = { source: 'instafy-map', v: 2, type: 'intent', id: newId(), name: 'cancel', params: { id }, ui: 'cancel', ref: job.ref, at: new Date().toISOString() };
    if (this.v1) { this.sendV1('intent.cancel', { iid: id }); postIntent(msg, this.parentOrigin || '*', [], { port: false, parent: false }); }
    else postIntent(msg, this.parentOrigin || '*');
    try { window.instafy?.cancel?.({ iid: id }); } catch { /* */ }
    if (this.listen.host) fetch('__uw/intent', { method: 'POST', body: JSON.stringify(msg), headers: { 'content-type': 'application/json' } }).catch(() => {});
    this.finish(job, null);
    this.E.ui.toast(`Cancelled “${job.def.label}”`, 2200);
  }
  /** v1: bring the worker window to the front (sign in, solve a check, watch) */
  show(id) {
    const job = this.pending.get(id); if (!job) return;
    const payload = { iid: id, ...(job.needsTask ? { taskId: job.needsTask } : {}) };
    this.sendV1('session.show', payload);
    try { window.instafy?.show?.(payload); } catch { /* */ }
  }
  /** Re-run "check again" on a record row. A re-check re-matches against the cached register (cheap); it does not
   *  re-download it: the dataset's own date says how fresh it is. */
  checkAgain(attr, item, rec) {
    const c = this.forCell(attr, item, rec); if (!c) return null;
    if (c.params) {
      const p = { ...c.params };
      delete p.refresh;
      return this.emit(c.def, p, { ref: item?.ref || rec?.ref || null, ui: 'cell', attr, pending: 'cell:' + attr });
    }
    return this.run(c.def.name, null, { ref: item?.ref, item, ui: 'cell', attr, pending: 'cell:' + attr });
  }

  // ---------- results in ----------
  onWindowMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.source !== 'instafy-host' && d.source !== 'instafy-bind') return;
    // only the frame that embeds us, and (when the site lists them) only its allowed origins, may speak or hand us a
    // port: messages on an adopted port are trusted like the parent's own, so these checks come first
    if (e.source !== window.parent || !embedded()) return;
    if (this.parentOrigins && !this.parentOrigins.includes(e.origin)) { console.warn('[map] message from a parent origin not in bind.parentOrigins ignored:', e.origin); return; }
    // a MessagePort handed in by the host (Instafy Studio pane): adopt it
    if (e.ports && e.ports[0]) this.adoptPort(e.ports[0], d.source === 'instafy-bind');
    if (!this.parentOrigin && e.origin && e.origin !== 'null') this.parentOrigin = e.origin;
    this.handle(d, 'parent');
  }
  adoptPort(p, v1) {
    if (this.port === p) return;
    // a v1 (instafy-bind) port carries only bind messages; UI events keep going to the parent frame
    this.port = p; setPort(p, { events: !v1 });
    if (v1) this.protocol = 'instafy-bind';
    p.onmessage = (ev) => { if (ev.data && typeof ev.data === 'object') this.handle(ev.data, 'port'); };
    try { p.start?.(); } catch { /* */ }
    this.listen.port = true;
    // the Studio pane does not wait for us to speak first; we introduce ourselves on the port right away
    if (v1) this.sendV1('hello', { siteId: this.siteId, manifestHash: this.manifestHash }, 'port');
    this.changed();
  }
  /** instafy-bind v1 envelope (Instafy docs/Bound-Sites.md §2) → the v2 host message shape */
  adaptBind(d) {
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    this.protocol = 'instafy-bind';
    if (d.id != null && /^\d+$/.test(String(d.id))) { this.lastEid = Number(d.id); try { sessionStorage.setItem('uw:eid:' + this.siteId, String(d.id)); } catch { /* */ } }
    const byTask = (taskId) => this.taskToId.get(String(taskId || '')) || this.jobToId.get(String(taskId || '').split('.')[0]) || p.iid;
    switch (d.type) {
      case 'hello.ack': {
        if (p.bound === false) { this.helloSeen = true; this.changed(); return null; }
        // pick up where a reload left off
        let from = Number.isFinite(p.resumeFrom) ? p.resumeFrom : null;
        try { const s = Number(sessionStorage.getItem('uw:eid:' + this.siteId)); if (Number.isFinite(s) && s > 0) from = s; } catch { /* */ }
        if (from != null) this.sendV1('intent.resume', { from });
        return { type: 'hello', user: p.user ? { name: p.user.display || p.user.name } : null, capabilities: Array.isArray(p.intents) ? { intents: p.intents } : null };
      }
      case 'intent.accepted': {
        if (p.jobId) this.jobToId.set(String(p.jobId), p.iid);
        const job = this.pending.get(p.iid);
        if (job && Array.isArray(p.plan)) {
          job.plan = p.plan.slice(0, 12).map((t) => ({ taskId: String(t.taskId || ''), origin: String(t.origin || ''), lane: String(t.lane || ''), status: String(t.status || 'queued') }));
          for (const t of job.plan) if (t.taskId) this.taskToId.set(t.taskId, p.iid);
        }
        return { type: 'ack', id: p.iid, status: 'queued', job: p.jobId };
      }
      case 'intent.rejected': return { type: 'ack', id: p.iid, status: 'rejected', reason: p.code };
      case 'task.status': {
        const id = byTask(p.taskId);
        const job = this.pending.get(id);
        if (job?.plan) { const t = job.plan.find((x) => x.taskId === String(p.taskId)); if (t) { t.status = String(p.state || t.status); t.reason = p.reason || null; } }
        if (p.state === 'needs_user') { if (job) { job.needs = p.reason === 'needs_login' ? 'sign_in' : 'confirm'; job.needsTask = p.taskId; } return { type: 'ack', id, status: 'needs_confirm' }; }
        return { type: 'progress', id, progress: { message: job?.plan ? planLine(job.plan) : (p.note || p.state) } };
      }
      case 'task.needs_user': {
        const id = byTask(p.taskId); const job = this.pending.get(id);
        if (job) { job.needs = NEEDS[p.kind] ? p.kind : 'confirm'; job.needsTask = p.taskId; }
        return { type: 'ack', id, status: 'needs_confirm' };
      }
      case 'record.upsert': {
        const job = this.pending.get(p.iid) || this.remote.get(p.iid);
        const layer = job?.def?.target?.layer || this.E.Q?.optionLayer || null;
        const list = (Array.isArray(p.records) ? p.records : [p]).map((r) => fromBindRecord(r, { layer })).filter(Boolean);
        return list.length ? { type: 'results', id: p.iid, records: list } : null;
      }
      case 'record.expire': { if (p.rid && this.E.records?.remove(String(p.rid))) this.E.afterExpire?.(); return null; }
      case 'intent.done': {
        const c = p.counts && typeof p.counts === 'object' ? p.counts : null;
        const bad = c ? (Number(c.blocked) || 0) + (Number(c.failed) || 0) : 0;
        return { type: 'done', id: p.iid, ...(c ? { counts: c, summary: bad ? `${Number(c.ok) || 0} of ${(Number(c.ok) || 0) + bad} sources answered (${[c.blocked ? `${c.blocked} blocked` : null, c.failed ? `${c.failed} failed` : null].filter(Boolean).join(', ')})` : undefined } : {}) };
      }
      case 'browser.location': { if (typeof p.url === 'string') this.E.onLocation?.(p.url); return null; }
      case 'data.version': this.schedulePoll(0); return null;
      default: return null;
    }
  }
  handle(d, via) {
    if (!d || typeof d !== 'object') return;
    if (d.source === 'instafy-bind') { d = this.adaptBind(d); if (!d) return; d.source = 'instafy-host'; }
    if (d.source && d.source !== 'instafy-host') return;
    const type = d.type;
    // a layout handed over the host's MessagePort (or uw.ingest): the same as host.js's parent-frame path
    if (type === 'layout' && (via === 'port' || via === 'api')) { this.E.hostLayout?.(d); return; }
    // so are the host's answers to "Show my location" (locate.js); from the parent frame host.js checks and routes them
    if ((type === 'location' || type === 'location-error' || type === 'location-stop') && (via === 'port' || via === 'api')) { this.E.hostLocation?.(d); return; }
    // and follow mode's present / apply-view / apply-tap (follow.js)
    if ((type === 'present' || type === 'apply-view' || type === 'apply-tap') && (via === 'port' || via === 'api')) { this.E.hostFollow?.(d); return; }
    if (!HOST_TYPES.includes(type)) return;
    const id = typeof d.id === 'string' ? d.id : null;
    switch (type) {
      case 'hello': {
        this.helloSeen = true;
        if (via === 'parent') this.listen.parent = true;
        if (d.user && typeof d.user.name === 'string') this.user = { name: d.user.name.slice(0, 60) };
        if (d.capabilities && Array.isArray(d.capabilities.intents)) this.capabilities = d.capabilities.intents.filter((x) => typeof x === 'string');
        if (Array.isArray(d.parentOrigins) && !this.parentOrigins) this.parentOrigins = d.parentOrigins.filter((x) => typeof x === 'string');
        this.changed();
        return;
      }
      case 'command': return this.command(d.command);
      case 'ack': {
        const job = id && this.pending.get(id);
        if (!job) { this.remoteJob(d); return; }
        job.acked = true;
        const st = d.status;
        if (st === 'rejected') {
          // a cooldown on the host: the button already says "sent" here, so no alarm, just the wait
          const cool = /cooldown/.test(String(d.reason || ''));
          if (cool && Number.isFinite(d.retry_after_s)) this.cool.set(job.cool, Date.now() + d.retry_after_s * 1000);
          this.finish(job, null, { keepCool: cool });
          this.E.emit('ack', { id, status: 'rejected' });
          this.E.ui.toast(cool ? `“${job.def.label}” ran a moment ago: try again in ${d.retry_after_s || 'a few'} s` : `“${job.def.label}” was not run${d.reason ? ': ' + String(d.reason).slice(0, 80) : ''}`, 4200);
          return;
        }
        const next = st === 'needs_confirm' ? 'needs_confirm' : st === 'running' ? 'running' : 'queued';
        // a person needed mid-run (sign in, a check) always shows; otherwise a status only moves forward
        if (next === 'needs_confirm' || RANK[next] >= RANK[job.status]) job.status = next;
        job.waiting = false;
        // a human in the loop (confirm tray, sign-in) does not count against the job's timeout
        if (job.status === 'needs_confirm') clearTimeout(job.timeout); else if (next === 'running') this.armTimeout(job);
        if (d.job) job.job = String(d.job).slice(0, 80);
        this.E.emit('ack', { id, status: job.status });
        this.E.onPending?.(job);
        return;
      }
      case 'progress': {
        const job = id && this.pending.get(id);
        if (!job) { this.remoteJob({ ...d, status: 'running' }); return; }
        job.acked = true;
        if (job.status === 'needs_confirm') { job.needs = null; this.armTimeout(job); }
        job.status = 'running';
        const p = d.progress && typeof d.progress === 'object' ? d.progress : {};
        job.progress = { step: Number.isFinite(p.step) ? p.step : null, of: Number.isFinite(p.of) ? p.of : null, message: typeof p.message === 'string' ? p.message.slice(0, 120) : '', source: typeof p.source === 'string' ? p.source.slice(0, 60) : '' };
        this.E.onPending?.(job);
        return;
      }
      case 'results': {
        const job = id ? this.pending.get(id) : null;
        if (job) { job.acked = true; job.status = 'running'; }
        const recs = Array.isArray(d.records) ? d.records : [];
        const rj = !job && id ? this.remote.get(id) : null;
        const r = this.E.ingestRecords(recs, { via, intent: job?.def || rj?.def || (d.name ? this.intents.get(d.name) : null) || null, id });
        const tj = job || rj;
        if (tj) { tj.count += r.changed.length; tj.items = (tj.items || 0) + r.items.length; for (const x of r.refs) tj.refs.add(x); for (const x of r.items) tj.refs.add((x.layer || tj.layer) + ':' + x.iid); }
        if (d.files && typeof d.files === 'object') this.noteFiles(d.files);
        this.E.emit('results', { id, count: r.changed.length, refs: [...r.refs] });
        if (tj) this.E.onPending?.(tj);
        return;
      }
      case 'done': {
        if (!id || this.done.has(id)) return;
        const rj = this.remote.get(id);
        if (rj) { this.remote.delete(id); this.done.add(id); clearTimeout(rj.timeout); this.E.onJobDone?.(rj, { summary: d.summary, remote: true }); this.E.onPending?.(rj, true); return; }
        const job = this.pending.get(id); if (!job) { this.done.add(id); return; }
        if (d.files && typeof d.files === 'object') this.noteFiles(d.files);
        // a host that only writes files: let the poller pick the records up before we call it "nothing new"
        if (!job.count && this.pollOn && via !== 'poll' && !job.graced) { job.graced = true; this.pollNow().finally(() => this.handle(d, 'grace')); return; }
        const summary = typeof d.summary === 'string' ? d.summary.slice(0, 200) : null;
        if (job.count) this.lastOk.set(this.outKey(job), { at: new Date().toISOString(), summary, count: job.count, cool: job.cool });
        // part of the sources failed (v1 counts): say so, with the job's own summary
        const partial = d.counts && ((Number(d.counts.blocked) || 0) + (Number(d.counts.failed) || 0)) > 0;
        this.finish(job, job.count && !partial ? null : partial ? { kind: 'partial', at: new Date().toISOString(), message: summary || 'Some sources did not answer', retry: this.retryOf(job) } : { kind: 'none', at: new Date().toISOString(), summary });
        this.E.onJobDone?.(job, { summary, counts: d.counts || null });
        // for an embedding host's receipts: which button, which item, how many
        this.E.emit('done', { id, name: job.name, ref: job.ref || null, summary, count: job.count || 0 });
        return;
      }
      case 'error': {
        const rj = id && this.remote.get(id);
        if (rj) { this.remote.delete(id); clearTimeout(rj.timeout); this.remoteError(rj, d.error); this.E.onPending?.(rj, true); return; }
        const job = id && this.pending.get(id); if (!job) return;
        const e = d.error && typeof d.error === 'object' ? d.error : {};
        const code = typeof e.code === 'string' ? e.code.slice(0, 30) : 'error';
        const message = typeof e.message === 'string' ? e.message.slice(0, 140) : code === 'timeout' ? 'The agent took too long.' : 'Something went wrong.';
        this.finish(job, { kind: 'error', code, message, at: new Date().toISOString(), retry: this.retryOf(job) });
        this.E.emit('error', { id, code });
        this.E.emit('done', { id, name: job.name, ref: job.ref || null, summary: null, count: job.count || 0, error: { code, message } });
        if (job.mode === 'none' || job.mode === 'layer') this.E.ui.toast(`“${job.def.label}”: ${message}`, 4200);
        return;
      }
      default:
    }
  }
  retryOf(job) { return { name: job.name, params: job.params, ref: job.ref, ui: job.ui, attr: job.attr, mode: job.mode }; }
  /** another viewer's job (the host broadcasts every ack / progress with name, ref and who): pending here too */
  remoteJob(d) {
    const id = typeof d.id === 'string' ? d.id : null;
    if (!id || this.done.has(id) || d.status === 'rejected') return;
    const def = typeof d.name === 'string' ? this.intents.get(d.name) : null;
    if (!def) return;
    let job = this.remote.get(id);
    if (!job) {
      const params = d.params && typeof d.params === 'object' ? d.params : {};
      job = { id, name: def.name, def, params, ref: typeof d.ref === 'string' ? d.ref : null, attr: null, ui: d.ui || null, mode: def.pending || 'item', remote: true,
        by: typeof d.by === 'string' ? d.by.slice(0, 40) : null, layer: def.target?.layer || null, status: 'queued', progress: null, started: Date.now(), count: 0, refs: new Set() };
      if (job.mode.startsWith('cell:') && !job.ref) job.mode = 'item';
      this.remote.set(id, job);
      // a remote job that never finishes (the other viewer's host died) stops showing after its timeout
      job.timeout = setTimeout(() => { if (this.remote.delete(id)) this.E.onPending?.(job, true); }, Math.max(5, Number(def.timeout_s ?? 90)) * 1000);
    }
    const next = d.status === 'needs_confirm' ? 'needs_confirm' : d.status === 'running' || d.type === 'progress' ? 'running' : 'queued';
    if (RANK[next] >= RANK[job.status]) job.status = next;
    if (d.progress && typeof d.progress === 'object') job.progress = { step: d.progress.step ?? null, of: d.progress.of ?? null, message: String(d.progress.message || '').slice(0, 120) };
    this.E.onPending?.(job);
  }
  remoteError(job, e) {
    const code = typeof e?.code === 'string' ? e.code.slice(0, 30) : 'error';
    if (code === 'cancelled') return;
    this.outcome.set(this.outKey(job), { kind: 'error', code, message: typeof e?.message === 'string' ? e.message.slice(0, 140) : 'The agent hit an error.', at: new Date().toISOString(), retry: this.retryOf(job) });
  }
  finish(job, outcome, o = {}) {
    clearTimeout(job.noListener); clearTimeout(job.timeout);
    this.pending.delete(job.id);
    this.done.add(job.id);
    if (outcome) this.outcome.set(this.outKey(job), outcome); else this.outcome.delete(this.outKey(job));
    // an error or nothing-new frees the button at once (a retry should not wait out the cooldown)
    if (outcome && outcome.kind === 'error' && !o.keepCool) this.cool.delete(job.cool);
    else if (!outcome && !job.count && !o.keepCool) this.cool.delete(job.cool);
    this.E.onPending?.(job, true);
    this.schedulePoll();
  }
  /** Last outcome for an item/attr (or intent+item): "Nothing new found · as of 15:04" or an error with retry. */
  outcomeFor(key) { return this.outcome.get(key) || null; }
  outcomeText(o) {
    if (o.kind === 'none') return `${o.summary && !/^nothing new/i.test(o.summary) ? o.summary + ' · ' : ''}Nothing new found · as of ${fmtClock(o.at)}`;
    if (o.kind === 'partial') return `${o.message} · ${fmtClock(o.at)}`;
    return `${o.message}${o.at ? ' · ' + fmtClock(o.at) : ''}`;
  }
  okFor(key) { return this.lastOk.get(key) || null; }
  command(c) {
    if (!c || typeof c !== 'object' || !COMMANDS.includes(c.name)) return;
    const a = c.args && typeof c.args === 'object' ? c.args : {};
    try { this.E.command(c.name, a); } catch (e) { console.warn('[map] command failed:', c.name, e.message); }
  }

  // ---------- files: results.files + data/version.json polling ----------
  noteFiles(files) {
    let stale = false;
    for (const [p, v] of Object.entries(files)) if (this.resultFiles.includes(p) || /^data\/records\/[\w.-]+\.json$/.test(p)) { if (!(this.files.get(p) >= v)) stale = true; }
    if (stale) this.schedulePoll(0);
  }
  async fetchJSON(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    const text = await r.text();
    return { json: JSON.parse(text), text };
  }
  async loadFile(path, v) {
    try {
      const { json, text } = await this.fetchJSON(path);
      const res = this.E.ingestRecordFile(path, json, text);
      // never a file path in front of a viewer: the console gets the detail
      if (res && res.ok === false) console.warn(`[map] ${path} ignored: ${res.error}`);
      else if (res?.partial) console.warn(`[map] ${path}: over the size budget, showing the newest ${res.partial.kept} of ${res.partial.total} records`);
      this.files.set(path, v ?? this.files.get(path) ?? 0);
    } catch (e) { if (e.status !== 404) console.warn(`[map] couldn't load ${path}:`, e.message); }
  }
  async loadAll() {
    let ver = null;
    try { ver = (await this.fetchJSON(this.versionPath)).json; } catch (e) { if (e.status !== 404) console.warn('[map] version.json:', e.message); }
    if (ver && typeof ver === 'object') this.version = ver;
    const files = new Set(this.resultFiles);
    for (const p of Object.keys(ver?.files || {})) if (/^data\/records\/[\w.-]+\.json$/.test(p)) files.add(p);
    await Promise.all([...files].map((p) => this.loadFile(p, ver?.files?.[p] ?? 0)));
    // the last error per item is part of the shared state (every viewer, after a reload too)
    for (const [id, st] of Object.entries(ver?.jobs || {})) this.jobState(id, st, true);
  }
  /** a data/version.json job entry: "running" | "done" | "error", or { state, name, ref, by, error:{code,message} } */
  jobState(id, st, initial = false) {
    const s = typeof st === 'string' ? { state: st } : st && typeof st === 'object' ? st : null;
    if (!s) return;
    const job = this.pending.get(id);
    if (job) {
      if (s.state === 'running') { if (!job.acked) { job.acked = true; job.status = 'running'; this.E.onPending?.(job); } }
      else if (s.state === 'done') this.handle({ source: 'instafy-host', type: 'done', id, summary: s.summary }, 'poll');
      else if (s.state === 'error') this.handle({ source: 'instafy-host', type: 'error', id, error: s.error || { code: 'error', message: 'The agent hit an error.' } }, 'poll');
      return;
    }
    if (this.done.has(id)) return;
    if ((s.state === 'running' || s.state === 'queued' || s.state === 'needs_confirm') && !initial) this.remoteJob({ id, name: s.name, ref: s.ref, by: s.by, params: s.params, status: s.state });
    else if (s.state === 'error' && s.name && s.error && s.error.code !== 'cancelled') {
      const def = this.intents.get(s.name);
      if (def) { this.remote.delete(id); this.remoteError({ name: s.name, def, ref: s.ref || null, params: s.params || {}, mode: def.pending || 'item', attr: null, ui: null }, s.error); this.done.add(id); }
    } else if (s.state === 'done' && this.remote.has(id)) this.handle({ source: 'instafy-host', type: 'done', id, summary: s.summary }, 'poll');
    // a later success clears the shared "last error" of that intent on that item
    else if (s.state === 'done' && s.name) { const def = this.intents.get(s.name); if (def) this.outcome.delete(`${s.name}|${s.ref || ''}`); }
  }
  async pollNow() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      let ver;
      try { ver = (await this.fetchJSON(this.versionPath)).json; } catch { return; }
      if (!ver || typeof ver !== 'object') return;
      const prev = this.version; this.version = ver;
      const files = ver.files && typeof ver.files === 'object' ? ver.files : {};
      const changed = Object.entries(files).filter(([p, v]) => (this.resultFiles.includes(p) || /^data\/records\/[\w.-]+\.json$/.test(p)) && Number(v) > (this.files.get(p) ?? -1));
      await Promise.all(changed.map(([p, v]) => this.loadFile(p, Number(v))));
      // job states resolve pending items for hosts that only write files, and show other viewers' jobs
      for (const [id, st] of Object.entries(ver.jobs || {})) this.jobState(id, st);
      if (prev && prev.v !== ver.v) this.E.onVersion?.(ver);
      // `uw reload` stamps "reload" for viewers that only poll (no SSE): the page changed, reload in place
      if (prev && typeof ver.reload === 'string' && ver.reload !== prev.reload) this.command({ name: 'reload', args: { note: ver.reload_note } });
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  schedulePoll(ms) {
    if (!this.pollOn) return;
    clearTimeout(this.pollTimer);
    if (document.hidden) return;
    const wait = ms ?? (this.pending.size || this.remote.size ? this.pollS : 30) * 1000;
    this.pollTimer = setTimeout(async () => { await this.pollNow(); this.schedulePoll(); }, wait);
  }
  snapshot() {
    return [...this.pending.values(), ...this.remote.values()].map((j) => ({ id: j.id, name: j.name, ref: j.ref, attr: j.attr, mode: j.mode, status: j.status, progress: j.progress, count: j.count, remote: !!j.remote, by: j.by || null }));
  }
  /** this viewer's and other viewers' jobs */
  all() { return [...this.pending.values(), ...this.remote.values()]; }
}

/** "agoda.com: extracting · booking.com: queued" from a v1 plan */
function planLine(plan) {
  return plan.map((t) => { let o = t.origin; try { o = new URL(t.origin).hostname.replace(/^www\./, ''); } catch { /* */ } return `${o || t.taskId}: ${t.status}${t.reason ? ' (' + t.reason.replace(/_/g, ' ') + ')' : ''}`; }).join(' · ').slice(0, 120);
}
export { NEEDS };
