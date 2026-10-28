// `serve` (static dev server) and `snapshot` (Playwright desktop + mobile PNGs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs, makeOut, exists, readJSON, UsageError, UserError } from './util.mjs';
import { ensureGitignore, SCRIPTS_DIR } from './site.mjs';
import { stateDirOf, stateDirsOf, folderId } from './state-dir.mjs';
import { signalPass } from './snapshot-signal.mjs';
import { safeEnv } from './safe-env.mjs';
import { hostRefusal, publicHostnames } from './host-check.mjs';

export const helps = {
  serve: `serve <dir> [--port 4173] [--host 127.0.0.1|0.0.0.0] [--quiet] [--public-url <url>] [--detach | --stop]
  Static server for a site (or any folder, e.g. examples/): Range (206) support, correct MIME types (.json .geojson .pbf
  .pmtiles .mjs .webp .svg …), Cache-Control: no-cache, folders serve their index.html. Dotfiles (.uwcache, .env …) are
  never served. Listens on 127.0.0.1 (this computer only) unless --host 0.0.0.0, which also prints the LAN URL to open on a
  phone on the same Wi-Fi. If the port is busy (and --port was not given) the next free one is used.
  Answers only for this computer, IP addresses, Instafy tunnels/previews of the port and --public-url hosts (repeatable;
  or UW_PUBLIC_URL), so a web page cannot rebind its own name onto the port and read the site's files.
  --detach  start it in the background, outliving this shell and an agent's turn (a tunnel needs it alive), wait until
            it answers, print the URL and return. Reuses a server already serving <dir> on that port (also one the
            space started again by itself). Log and pid: serve.log and serve.json in <dir>'s state folder (in an
            Instafy space the space's own folder, INSTAFY_CACHE_DIR; else <dir>/.uwcache). Prints the command that
            starts the same server in the foreground ("serve_cmd") and the \`instafy preview open … --serve-cmd …\`
            line that gives it a preview card the space can start again after the server stops.
  --stop    stop the background server of <dir>.`,
  snapshot: `snapshot <dir> [--out <dir>/snapshots] [--only desktop|mobile] [--hash "t=22&v=0.8"] [--eval "<js>"] [--tag name]
         [--thumb] [--scheme light|dark] [--wait ms] [--signal [--strict]] [--json]
  Serves <dir> on a free port and renders it with Playwright: desktop 1280×800 and mobile 390×844 (isMobile, touch, DPR 2).
  Waits for window.__uwReady (30 s) and the map's idle event, writes desktop.png / mobile.png, prints console errors,
  failed requests and window.__uwErrors. Exit 1 on errors. Look at both PNGs.
  --eval "<js>"  runs in the page once it is ready (window.uw is the API), e.g. --eval "uw.ui.openSheet('compare')" or
                 --eval "uw.setDay(2)" or --eval "uw.select('hotels','via-loft')"; then waits for the map to settle.
  --tag name     writes desktop-name.png / mobile-name.png (keeps the plain shots).
  --thumb        also writes thumb.png: the phone view framed on every option, without buttons and toasts (galleries).
  --signal       then renders the phone view in each state (default, every lens #l=<id>, #t=22, option A selected,
                 pitch 72 by day and night, landscape 844×390 with option A's card), reads the engine's uw.signal()
                 clutter report in each and applies S1-S19 (noise, budgets, fill, labels, legends, tie rows, English,
                 verdict, notes over pins, tap targets incl. inline links, options in view, why lines, cited numbers,
                 dark horizon band measured from pixels, S16 lens chips covered, S17 verdict line cut off or not led by
                 the top score, S18 why-line text overlapping, S19 agent results hidden). Writes snapshots/signal.json
                 and mobile-lens-<id>.png / mobile-pitch72-*.png / landscape-card.png; prints one line per failed rule
                 with a fix; exit 1 on any fail (S7 only fails with --strict).
  Playwright: import('playwright'), then $UW_PLAYWRIGHT (path to a playwright package folder, e.g. one inside another
  project's node_modules), then one in a node_modules above the current folder, then (in Instafy) the engine
  \`instafy preview check\` uses: the runtime's own Playwright and Chromium. It needs a browser: Playwright's own
  (npx playwright install chromium), that engine's Chromium, or an installed Google Chrome (tried automatically;
  UW_BROWSER_CHANNEL=chrome forces it).
  Exit 3 (and old PNGs removed) when Playwright is absent: the screenshots were NOT checked.`,
};

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pbf': 'application/x-protobuf', '.mvt': 'application/vnd.mapbox-vector-tile',
  '.pmtiles': 'application/octet-stream', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

export function createStaticServer(root, opts = {}) {
  return http.createServer(staticHandler(root, opts));
}
// The request handler behind createStaticServer (uw host wraps it with the __uw/* endpoints).
// refuse(req) → a reason to refuse the request's Host (421), or null; uw host checks the Host itself before this runs.
export function staticHandler(root, { log = () => {}, refuse = null, identity = null } = {}) {
  root = path.resolve(root);
  return (req, res) => {
    // a request from this computer learns which folder this server serves and its process, so \`--detach\` finds a
    // server of the same folder that it did not start itself (never told over a tunnel or the LAN: the peer's address
    // and the Host it asked for decide: a tunnel's client connects from this computer but keeps the public Host)
    if (identity && LOOPBACK_ADDR.test(String(req.socket?.remoteAddress || '')) && LOOPBACK_HOST.test(String(req.headers.host || ''))) {
      res.setHeader('X-UW-Folder', identity.folder);
      res.setHeader('X-UW-Server', `${identity.cmd} ${process.pid}`);
    }
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const refused = refuse ? refuse(req) : null;
    if (refused) { log(421, req.url); return send(421, `refused: ${refused}`, { 'Cache-Control': 'no-store' }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', { Allow: 'GET, HEAD' });
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, 'bad request'); }
    if (urlPath.includes('\0')) return send(400, 'bad request');
    // never serve dotfiles / dot-folders (.uwcache holds raw API responses, a stray .env would leak)
    if (urlPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) { log(404, urlPath); return send(404, `not found: ${urlPath}`); }
    let file = path.join(root, path.normalize(urlPath));
    if (file !== root && !file.startsWith(root + path.sep)) return send(403, 'forbidden');
    let st;
    try { st = fs.statSync(file); } catch { log(404, urlPath); return send(404, `not found: ${urlPath}`); }
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return send(301, '', { Location: encodeURI(urlPath + '/') + q });
      }
      const idx = path.join(file, 'index.html');
      if (exists(idx)) { file = idx; st = fs.statSync(idx); } else return send(200, listing(file, urlPath), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // no Access-Control-Allow-Origin: other web pages the user opens must not read a local site's files
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff' };
    const range = req.headers.range;
    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      let start, end;
      if (m && (m[1] || m[2])) {
        if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, st.size - n); end = st.size - 1; }
        else { start = Number(m[1]); end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1); }
      }
      if (start === undefined || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}

function listing(dir, urlPath) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const items = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(urlPath)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;background:#fff;color:#111}a{display:block;padding:10px 0;color:#2563eb}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#93c5fd}}</style>
<h1>${esc(urlPath)}</h1><ul>${urlPath !== '/' ? '<li><a href="../">../</a></li>' : ''}${items}</ul>`;
}

/** localhost only opens where this runs (in a hosted runtime: not on the user's device): say how to share it */
export const remoteHint = (port) => `  localhost opens only on this machine. To share it (Instafy, a phone elsewhere): ask first, then instafy tunnel start --port ${port} --name map --json and post its "url".`;
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, host);
  });
}

const LOOPBACK_ADDR = /^(?:::ffff:)?127(?:\.\d{1,3}){3}$|^::1$/;
const LOOPBACK_HOST = /^(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?$/i;
// --detach bookkeeping: serve.json { pid, cmd, port, host, dir } in the folder's state folder (lib/state-dir.mjs)
const stateFile = (dir) => path.join(stateDirOf(dir), 'serve.json');
const readOne = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'serve.json'), 'utf8')); } catch { return null; } };
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The server registered for `dir`: a live one in any of its state folders (this process's, or the folder's own
 *  .uwcache: a server the space started again without INSTAFY_CACHE_DIR), else this process's record, else null. */
export const readState = (dir) => {
  for (const d of stateDirsOf(dir)) { const st = readOne(d); if (st && alive(st.pid)) return st; }
  return readOne(stateDirOf(dir));
};
/** Forget `dir`'s server record(s): every one naming `pid`, or all of them. */
function clearState(dir, pid = null) {
  for (const d of stateDirsOf(dir)) { const st = readOne(d); if (st && (pid == null || st.pid === pid)) fs.rmSync(path.join(d, 'serve.json'), { force: true }); }
}
/** A server keeps its own record while it runs (in the foreground too: one the space started again from its preview
 *  card is found by --detach, --stop and reload). Returns the function that drops it when the server stops. */
export function registerServer(dir, { cmd, port, host }) {
  const f = stateFile(dir);
  const prev = readOne(path.dirname(f));
  if (prev && prev.pid !== process.pid && alive(prev.pid)) return () => {};
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, cmd, port, host, dir, started_at: new Date().toISOString() }) + '\n');
  } catch { return () => {}; }
  return () => { if (readOne(path.dirname(f))?.pid === process.pid) fs.rmSync(f, { force: true }); };
}
/** What answers on 127.0.0.1:<port>: { ok, folder, cmd, pid } (folder, cmd and pid only from a uw server). */
async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    const [cmd, pid] = String(r.headers.get('x-uw-server') || '').split(' ');
    return { ok: r.status < 500, folder: r.headers.get('x-uw-folder'), cmd: cmd || null, pid: Number(pid) || null };
  } catch { return { ok: false }; }
}
async function answers(port) { return (await probe(port)).ok; }

const shellWord = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : !a.includes("'") ? `'${a}'` : `"${a.replace(/["\\$`]/g, (c) => `\\${c}`)}"`);
const shellQuote = (s) => `"${String(s).replace(/["\\$`]/g, (c) => `\\${c}`)}"`;
/** The executable `name` a shell finds first on PATH (null when none). */
function onPath(name, env = process.env) {
  for (const d of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}
/** Whether the \`uw\` a shell finds runs this pack (this pack's own scripts/uw, or a shim naming this uw.mjs). */
export function uwOnPath(env = process.env) {
  const f = onPath('uw', env);
  if (!f) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const mine = [real(path.join(SCRIPTS_DIR, 'uw.mjs')), real(path.join(SCRIPTS_DIR, 'uw'))];
  if (mine.includes(real(f))) return true;
  try { const head = fs.readFileSync(f, 'utf8').slice(0, 4096); return mine.some((m) => head.includes(m)) || head.includes(path.join(SCRIPTS_DIR, 'uw.mjs')); } catch { return false; }
}
/** The one command (no shell syntax) that starts this server again in the foreground: what
 *  \`instafy preview open --serve-cmd\` records, so the space can start the site again after it stops or sleeps. The
 *  folder is absolute: the space replays it from wherever \`instafy preview open\` ran. \`uw\` when the shell finds
 *  this pack's, else node and this pack's uw.mjs. Exported for the tests. */
export function serveCommand(cmd, dir, { port, host, extra = [] }, { env = process.env } = {}) {
  const site = path.resolve(dir);
  const prog = uwOnPath(env) ? ['uw'] : [onPath('node', env) ? 'node' : process.execPath, path.join(SCRIPTS_DIR, 'uw.mjs')];
  return [...prog, cmd, site, '--port', String(port), '--host', host, ...extra].map(shellWord).join(' ');
}
/** The \`instafy preview open\` line for a server of \`dir\` on \`port\`, with its start command. */
function previewLine(dir, port, serveCmd) {
  let title = '';
  try { title = String(readJSON(path.join(dir, 'map.config.json'))?.title || ''); } catch { /* not a map site */ }
  title = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) || path.basename(dir);
  return `instafy preview open --port ${port} --title ${shellQuote(title)} --serve-cmd ${shellQuote(serveCmd)} --json`;
}

// One background server per site folder. `host` serves everything `serve` does plus __uw/*: asking for `host` replaces
// a static `serve`; asking for `serve` reuses a `host`.
export async function detach(args, dir, cmd = 'serve', extra = []) {
  const out = makeOut(args);
  const host = args.host || '127.0.0.1';
  const port = args.port ?? 4173;
  const urls = (p) => ({ local: `http://localhost:${p}/`, lan: host === '0.0.0.0' || host === '::' ? lanAddresses().map((a) => `http://${a}:${p}/`) : [] });
  const serveCmd = serveCommand(cmd, dir, { port, host, extra });
  const preview = previewLine(dir, port, serveCmd);
  const startLines = [`Preview card (Instafy): ${preview}`, `  (--serve-cmd: the space starts the map again with it after the server stops or the space sleeps)`];
  let prev = readState(dir);
  if (!(prev && prev.dir === dir && prev.port === port && alive(prev.pid) && await answers(port))) {
    // no record of a running server here, but one of this very folder answers on the port (started again by the
    // space, which keeps its record in the folder's own .uwcache): that one is this folder's server
    const p = await probe(port);
    prev = p.ok && p.folder === folderId(dir) && p.pid && alive(p.pid) ? { pid: p.pid, cmd: p.cmd, port, host, dir } : null;
  }
  const prevCmd = prev?.cmd || 'serve';
  if (prev) {
    if (prevCmd === cmd || prevCmd === 'host') {
      try { fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true }); fs.writeFileSync(stateFile(dir), JSON.stringify({ pid: prev.pid, cmd: prevCmd, port, host: prev.host || host, dir, started_at: prev.started_at || new Date().toISOString() }) + '\n'); } catch { /* the server keeps its own record */ }
      out.result({ ok: true, reused: true, cmd: prevCmd, pid: prev.pid, dir, port, ...urls(port), serve_cmd: serveCmd, preview_cmd: preview },
        [`Already serving ${path.relative(process.cwd(), dir) || '.'} at http://localhost:${port}/ (uw ${prevCmd}, pid ${prev.pid}).`, ...startLines, remoteHint(port)]);
      return 0;
    }
    process.kill(prev.pid, 'SIGTERM');
    for (let i = 0; i < 30 && await answers(port); i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (await answers(port)) throw new UserError(`port ${port} is in use by another server; pick another with --port (or --stop the old one)`);
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  const logFile = path.join(stateDirOf(dir), `${cmd}.log`);
  const log = fs.openSync(logFile, 'a');
  // detached = its own session (setsid), so it outlives this shell and the process group an agent's turn kills
  // and it never keeps the caller's credentials (an agent job's controller token, the model key): allowlist only
  const child = spawn(process.execPath, [process.argv[1], cmd, dir, '--port', String(port), '--host', host, ...extra],
    { detached: true, stdio: ['ignore', log, log], cwd: dir, env: safeEnv() });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 50 && !(await answers(port)); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await answers(port))) throw new UserError(`the background server did not start; see ${logFile}`);
  fs.writeFileSync(stateFile(dir), JSON.stringify({ pid: child.pid, cmd, port, host, dir, started_at: new Date().toISOString() }) + '\n');
  const u = urls(port);
  out.result({ ok: true, reused: false, cmd, pid: child.pid, dir, port, ...u, serve_cmd: serveCmd, preview_cmd: preview },
    [`Serving ${path.relative(process.cwd(), dir) || '.'} at ${u.local} in the background (uw ${cmd}, pid ${child.pid}; stop: uw ${cmd} ${args._[0]} --stop).`,
      ...u.lan.map((x) => `  on your network: ${x}  (phone on the same Wi-Fi)`), ...startLines, remoteHint(port)]);
  return 0;
}

export function stop(args, dir) {
  const out = makeOut(args);
  const st = readState(dir);
  if (!st || !alive(st.pid)) { clearState(dir); out.result({ ok: true, stopped: false }, ['No background server is running for this folder.']); return 0; }
  process.kill(st.pid, 'SIGTERM');
  clearState(dir, st.pid);
  out.result({ ok: true, stopped: true, pid: st.pid, port: st.port }, [`Stopped the server on port ${st.port} (pid ${st.pid}).`]);
  return 0;
}

export async function serve(argv) {
  const args = parseArgs(argv, { port: 'number', host: 'string', quiet: 'bool', detach: 'bool', stop: 'bool', 'public-url': 'multi' }, { positionals: [1, 1], command: 'serve' });
  if (args.help) return console.log(helps.serve);
  const dir = path.resolve(args._[0]);
  if (!exists(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`"${args._[0]}" is not a directory`);
  if (args.stop) return stop(args, dir);
  if (!exists(path.join(dir, 'index.html'))) console.error(`warning: ${args._[0]} has no index.html; serving a file listing.`);
  if (args.detach) return detach(args, dir, 'serve', ['--quiet', ...args['public-url'].flatMap((u) => ['--public-url', u])]);
  const host = args.host || '127.0.0.1';
  const hostOpts = { port: null, publicHosts: publicHostnames(args['public-url']) };
  const server = createStaticServer(dir, {
    log: args.quiet ? () => {} : (code, p) => { if (!/favicon\.ico$/.test(p)) console.error(`  ${code} ${p}`); },
    refuse: (req) => hostRefusal(req.headers.host, hostOpts),
    identity: { folder: folderId(dir), cmd: 'serve' },
  });
  let port = args.port ?? 4173;
  for (let i = 0; ; i++) {
    try { port = await listen(server, port, host); break; } catch (e) {
      if (e.code === 'EADDRINUSE' && args.port === undefined && i < 20) { port++; continue; }
      if (e.code === 'EADDRINUSE') throw new UserError(`port ${port} is in use; pick another with --port`);
      throw e;
    }
  }
  hostOpts.port = port;
  const unregister = registerServer(dir, { cmd: 'serve', port, host });
  const local = `http://localhost:${port}/`;
  const lan = host === '0.0.0.0' || host === '::' ? lanAddresses().map((a) => `http://${a}:${port}/`) : host !== '127.0.0.1' && host !== 'localhost' ? [`http://${host}:${port}/`] : [];
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, dir, port, local, lan }) + '\n');
  else {
    console.log(`Serving ${path.relative(process.cwd(), dir) || '.'} at ${local}`);
    for (const u of lan) console.log(`  on your network: ${u}  (phone on the same Wi-Fi)`);
    if (!lan.length && (host === '127.0.0.1' || host === 'localhost')) console.log('  (this computer only; add --host 0.0.0.0 to open it on a phone on the same Wi-Fi)');
    console.log(remoteHint(port));
    console.log('Ctrl-C to stop.');
  }
  await new Promise((resolve) => {
    const stop = () => { unregister(); server.close(); resolve(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

// ---------------------------------------------------------------------------
export async function loadPlaywright() {
  const tried = [];
  for (const name of ['playwright', 'playwright-core']) {
    try { const m = await import(name); return m.chromium ? m : m.default; } catch (e) { tried.push(`${name}: ${e.code || e.message}`); }
  }
  const envPath = process.env.UW_PLAYWRIGHT;
  if (envPath) {
    try { const m = createRequire(import.meta.url)(envPath); if (m?.chromium) return m; } catch (e) { tried.push(`$UW_PLAYWRIGHT=${envPath}: ${e.code || e.message}`); }
  }
  // a project the site sits in often has Playwright already (npm, or pnpm's .pnpm store): look upwards from cwd
  for (const p of findPlaywrightDirs(process.cwd())) {
    try { const m = createRequire(import.meta.url)(p); if (m?.chromium) return m; } catch (e) { tried.push(`${p}: ${e.code || e.message}`); }
  }
  // no local Playwright: in Instafy, use the runtime's own Playwright and Chromium (what `instafy preview check` uses)
  const eng = instafyEngine(tried);
  if (eng) {
    try { const m = createRequire(import.meta.url)(eng.playwright); const pw = m?.chromium ? m : m?.default; if (pw?.chromium) { engines.set(pw, eng); return pw; } } catch (e) { tried.push(`${eng.playwright}: ${e.code || e.message}`); }
  }
  const err = new Error(`Playwright not found (${tried.join('; ')})`);
  err.notFound = true;
  throw err;
}

// Playwright module → the Instafy engine it came from (its Chromium binaries, for launchChromium)
const engines = new WeakMap();

/**
 * The runtime's own Playwright and Chromium, from the variables the runtime image sets for its tools (the same ones
 * `instafy preview check` reads): INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH (a playwright package) or
 * INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT (a node_modules holding one), and Chromium builds under
 * PLAYWRIGHT_BROWSERS_PATH or /ms-playwright. → { playwright, chromium: [paths], args } or null (not in a runtime).
 */
export function instafyEngine(tried = []) {
  const isPlaywright = (dir) => fs.existsSync(path.join(dir, 'package.json')) && ['playwright', 'playwright-core'].includes(path.basename(dir));
  let playwright = null;
  const direct = (process.env.INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH || '').trim();
  if (direct) {
    if (path.isAbsolute(direct) && isPlaywright(direct)) playwright = direct;
    else tried.push('$INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH is not an absolute path to a playwright package');
  }
  const root = (process.env.INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT || '').trim();
  if (!playwright && root) {
    const found = path.isAbsolute(root) ? ['playwright', 'playwright-core'].map((n) => path.join(root, n)).find(isPlaywright) : null;
    if (found) playwright = found;
    else tried.push('no playwright in $INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT');
  }
  if (!playwright) { if (!direct && !root) tried.push('not in an Instafy runtime (no INSTAFY_SHARED_BROWSER_* playwright)'); return null; }
  const chromium = [];
  for (const base of [...new Set([process.env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright'].filter((x) => x && x !== '0'))]) {
    let entries = [];
    try { entries = fs.readdirSync(base).sort().reverse(); } catch { continue; }
    for (const e of entries.filter((x) => x.startsWith('chromium_headless_shell-'))) {
      chromium.push(path.join(base, e, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), path.join(base, e, 'chrome-linux', 'headless_shell'));
    }
    for (const e of entries.filter((x) => /^chromium-\d/.test(x))) chromium.push(path.join(base, e, 'chrome-linux64', 'chrome'), path.join(base, e, 'chrome-linux', 'chrome'));
  }
  return { playwright, chromium: chromium.filter((p) => fs.existsSync(p)), args: ['--disable-dev-shm-usage'] };
}

function findPlaywrightDirs(start) {
  const found = [];
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    const nm = path.join(dir, 'node_modules');
    for (const name of ['playwright', 'playwright-core']) if (fs.existsSync(path.join(nm, name, 'package.json'))) found.push(path.join(nm, name));
    try {
      for (const e of fs.readdirSync(path.join(nm, '.pnpm')).filter((n) => /^playwright(-core)?@\d/.test(n)).sort().reverse()) {
        const name = e.startsWith('playwright-core@') ? 'playwright-core' : 'playwright';
        const p = path.join(nm, '.pnpm', e, 'node_modules', name);
        if (fs.existsSync(path.join(p, 'package.json'))) found.push(p);
      }
    } catch {}
    if (found.length) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

export async function launchChromium(pw) {
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const channel = process.env.UW_BROWSER_CHANNEL;
  if (!channel) {
    try { return await pw.chromium.launch({ headless: true, args }); } catch (e) {
      if (!/Executable doesn't exist|browserType\.launch|Looks like Playwright/i.test(e.message)) throw e;
    }
    // the Instafy engine's Chromium (the runtime image's), as `instafy preview check` launches it
    const eng = engines.get(pw);
    for (const executablePath of eng?.chromium || []) {
      try { return await pw.chromium.launch({ headless: true, executablePath, args: [...new Set([...args, ...eng.args])] }); } catch { /* next */ }
    }
  }
  return pw.chromium.launch({ channel: channel || 'chrome', headless: true, args });
}

export async function snapshot(argv) {
  const args = parseArgs(argv, { out: 'string', only: 'string', hash: 'string', scheme: 'string', wait: 'number', timeout: 'number', eval: 'string', tag: 'string', thumb: 'bool', signal: 'bool', strict: 'bool' },
    { positionals: [1, 1], command: 'snapshot' });
  if (args.help) return console.log(helps.snapshot);
  const out = makeOut(args);
  const dir = path.resolve(args._[0]);
  if (!exists(dir) || !fs.statSync(dir).isDirectory()) throw new UserError(`"${args._[0]}" is not a directory`);
  if (!exists(path.join(dir, 'index.html'))) throw new UserError(`${args._[0]}/index.html not found; snapshot renders a site's index.html`);
  if (args.only && !['desktop', 'mobile'].includes(args.only)) throw new UsageError('--only must be desktop or mobile');
  if (args.scheme && !['light', 'dark'].includes(args.scheme)) throw new UsageError('--scheme must be light or dark');
  const outDir = path.resolve(args.out || path.join(dir, 'snapshots'));
  let pw;
  if (args.tag && !/^[\w-]{1,40}$/.test(args.tag)) throw new UsageError('--tag must be a short name (letters, digits, - _)');
  try { pw = await loadPlaywright(); } catch (e) {
    if (!e.notFound) throw e;
    // old PNGs would look like a check that never happened
    const stale = ['desktop', 'mobile'].map((n) => path.join(outDir, `${n}${args.tag ? '-' + args.tag : ''}.png`)).filter(exists);
    for (const f of stale) fs.rmSync(f, { force: true });
    out.result({ ok: false, skipped: true, reason: e.message, removed_stale: stale }, [
      'SKIPPED: Playwright is not available, so no screenshots were taken and NOTHING was checked visually.',
      stale.length ? `Removed ${stale.length} old PNG(s) so they are not mistaken for new ones.` : null,
      'To enable: npm i -D playwright && npx playwright install chromium   (or set UW_PLAYWRIGHT=/path/to/node_modules/playwright).',
      'Tell the user the map was validated but not looked at.',
    ]);
    return 3;
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (outDir.startsWith(dir + path.sep)) ensureGitignore(dir, [path.relative(dir, outDir).split(path.sep).join('/') + '/']);

  // files a bound site may not have yet (records arrive later; the engine treats their 404 as "nothing yet")
  const optional = new Set(['/data/version.json']);
  try {
    const bj = JSON.parse(fs.readFileSync(path.join(dir, 'bound.json'), 'utf8'));
    for (const f of bj.results?.files || []) optional.add('/' + String(f).replace(/^\/+/, ''));
    for (const d of Object.values(bj.intents || {})) if (d?.target?.records) optional.add('/' + d.target.records);
  } catch {}
  const isOptional = (u) => { try { return optional.has(new URL(u, 'http://x').pathname); } catch { return false; } };
  const notFound = [];
  const server = createStaticServer(dir, { log: (code, p) => { if (!/favicon\.ico$/.test(p) && !optional.has(p)) notFound.push(p); } });
  const port = await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/`;
  const url = base + (args.hash ? '#' + args.hash.replace(/^#/, '') : '');
  let browser;
  const results = [];
  let hadErrors = false;
  let signal = null;
  try {
    browser = await launchChromium(pw);
    const variants = [
      { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
      { name: 'mobile', ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } },
    ].filter((v) => !args.only || v.name === args.only);
    for (const v of variants) {
      const errors = [], warnings = [];
      notFound.length = 0;
      const context = await browser.newContext({ ...v.ctx, colorScheme: args.scheme || 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('console', (m) => {
        const t = m.type();
        // "Failed to load resource" duplicates the response/requestfailed handlers below, which know the URL.
        if (/^Failed to load resource/.test(m.text())) return;
        if (/GL Driver Message|GPU stall due to ReadPixels|READ-usage buffer was written/.test(m.text())) return; // software-GL noise
        if (t === 'error') errors.push(`console.error: ${m.text().slice(0, 400)}`);
        else if (t === 'warning') warnings.push(`console.warn: ${m.text().slice(0, 300)}`);
      });
      page.on('pageerror', (e) => errors.push(`page error: ${(e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | ')}`));
      page.on('requestfailed', (r) => {
        const u = r.url();
        if (/favicon\.ico$/.test(u)) return;
        const why = r.failure()?.errorText || 'failed';
        if (/ERR_ABORTED/.test(why)) return; // tiles cancelled when the camera moves
        (u.startsWith(base) ? errors : warnings).push(`request failed: ${u.replace(base, '')} (${why})`);
      });
      page.on('response', (r) => {
        if (r.status() === 404 && isOptional(r.url())) return;
        if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) {
          const u = r.url();
          (u.startsWith(base) ? errors : warnings).push(`HTTP ${r.status()}: ${u.replace(base, '')}`);
        }
      });
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      let ready = true;
      try { await page.waitForFunction(() => window.__uwReady === true, null, { timeout: args.timeout ?? 30000 }); } catch {
        ready = false;
        errors.push(`window.__uwReady was not set within ${(args.timeout ?? 30000) / 1000}s (the engine did not finish loading)`);
      }
      // Wait for the map to go idle (tiles + layers drawn).
      const idle = await page.evaluate(() => new Promise((resolve) => {
        const m = window.uw?.map;
        if (!m || typeof m.once !== 'function') return resolve('no-map');
        const done = () => resolve('idle');
        try { if (m.loaded() && (!m.areTilesLoaded || m.areTilesLoaded())) return resolve('idle'); } catch {}
        m.once('idle', done);
        setTimeout(() => resolve('timeout'), 15000);
      })).catch(() => 'error');
      if (idle === 'timeout') warnings.push('map did not reach "idle" within 15 s (tiles still loading?)');
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      if (args.eval) {
        try { await page.evaluate(async (js) => { const r = (0, eval)(js); if (r && typeof r.then === 'function') await r; }, args.eval); }
        catch (e) { errors.push(`--eval failed: ${String(e.message || e).split('\n')[0]}`); }
        await page.waitForTimeout(1300);
        await page.evaluate(() => new Promise((res) => { const m = window.uw?.map; if (!m) return res(); if (!m.isMoving() && m.loaded()) return res(); m.once('idle', res); setTimeout(res, 8000); })).catch(() => {});
      }
      await page.waitForTimeout(args.wait ?? 400);
      const uwErrors = await page.evaluate(() => (Array.isArray(window.__uwErrors) ? window.__uwErrors.map((e) => (typeof e === 'string' ? e : e?.message || JSON.stringify(e))) : [])).catch(() => []);
      for (const e of uwErrors) errors.push(`__uwErrors: ${String(e).slice(0, 400)}`);
      for (const p of notFound) if (!errors.some((e) => e.includes(p.replace(/^\//, '')))) errors.push(`HTTP 404: ${p}`);
      const file = path.join(outDir, `${v.name}${args.tag ? '-' + args.tag : ''}.png`);
      await page.screenshot({ path: file });
      if (args.thumb && v.name === 'mobile') {
        await page.addStyleTag({ content: '.uw-fabs,.uw-toasts,.maplibregl-ctrl-attrib,.uw-note{display:none!important}' });
        // the thumbnail is the top 600 px: frame every option (and the view) inside it, never crop the recommended one
        await page.evaluate(() => {
          const uw = window.uw, m = uw?.map; if (!m) return;
          const pts = (uw.question?.options || []).map((o) => { const i = o.ref.indexOf(':'); const f = uw.getFeatures(o.ref.slice(0, i)).find((x) => String(x.properties.id) === o.ref.slice(i + 1)); return f?.geometry?.type === 'Point' ? f.geometry.coordinates : null; }).filter(Boolean);
          if (!pts.length) return;
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 70, bottom: innerHeight - 600 + 60, left: 50, right: 50 }, maxZoom: 16, duration: 0 });
        }).catch(() => {});
        await page.evaluate(() => new Promise((res) => { const m = window.uw?.map; if (!m || (!m.isMoving() && m.loaded() && m.areTilesLoaded())) return res(); m.once('idle', res); setTimeout(res, 6000); })).catch(() => {});
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(outDir, 'thumb.png'), clip: { x: 0, y: 0, width: 390, height: 600 } });
      }
      const ms = Date.now() - t0;
      await context.close();
      const uniq = (a) => [...new Set(a)];
      results.push({ name: v.name, file, ready, idle, ms, errors: uniq(errors), warnings: uniq(warnings) });
      if (errors.length) hadErrors = true;
    }
    if (args.signal) {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'map.config.json'), 'utf8')); } catch {}
      const waitReady = async (page) => {
        let ok = true;
        try { await page.waitForFunction(() => window.__uwReady === true, null, { timeout: args.timeout ?? 30000 }); } catch { ok = false; }
        await page.evaluate(() => new Promise((resolve) => {
          const m = window.uw?.map;
          if (!m || typeof m.once !== 'function') return resolve();
          try { if (m.loaded() && (!m.areTilesLoaded || m.areTilesLoaded())) return resolve(); } catch {}
          m.once('idle', resolve); setTimeout(resolve, 15000);
        })).catch(() => {});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await page.waitForTimeout(args.wait ?? 600);
        return ok;
      };
      signal = await signalPass({ browser, base, dir, outDir, cfg, waitReady, args });
    }
  } finally {
    await browser?.close().catch(() => {});
    server.close();
  }
  const rel = (f) => path.relative(process.cwd(), f) || f;
  const lines = [];
  for (const r of results) {
    lines.push(`${r.errors.length ? '✗' : '✓'} ${r.name}: ${rel(r.file)} (${(r.ms / 1000).toFixed(1)}s${r.ready ? '' : ', NOT READY'}${r.idle !== 'idle' ? `, map ${r.idle}` : ''})`);
    for (const e of r.errors.slice(0, 15)) lines.push(`    error: ${e}`);
    for (const w of r.warnings.slice(0, 8)) lines.push(`    warn:  ${w}`);
  }
  let sigFail = false;
  if (signal) {
    const fails = signal.rules.filter((r) => r.level === 'fail'), warns = signal.rules.filter((r) => r.level === 'warn');
    sigFail = fails.length > 0;
    const d = signal.reports.find((r) => r.state === 'default')?.signal;
    lines.push(`Signal (${signal.reports.length} phone states → ${rel(path.join(outDir, 'signal.json'))}): ${fails.length} fail, ${warns.length} warn` +
      (d && !d.error ? ` · default: ${d.options.visible}/${d.options.total} options, noise ${d.noise}/${d.noise_limit}, ${d.symbols.support} support, ${d.symbols.context_dots} dots, ${d.basemap_labels} basemap labels` : ''));
    for (const r of [...fails, ...warns]) lines.push(`  ${r.level === 'fail' ? '✗' : '!'} ${r.id} ${r.message}${r.fix ? `. Fix: ${r.fix}` : ''}`);
    // S15 (horizon band) passes silently; a band is already listed as a fail above (signal.json has the rows checked)
  }
  lines.push(hadErrors ? 'Fix the errors above, then snapshot again. Look at the PNGs either way.' : 'Now look at both PNGs (Read them) and check layout, legibility and overlap.');
  out.result({ ok: !hadErrors && !sigFail, url, results: results.map((r) => ({ ...r, file: r.file })), ...(signal ? { signal: { rules: signal.rules, file: path.join(outDir, 'signal.json') } } : {}) }, lines);
  return hadErrors || sigFail ? 1 : 0;
}
