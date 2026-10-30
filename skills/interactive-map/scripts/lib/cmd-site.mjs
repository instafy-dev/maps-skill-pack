// `new`, `upgrade`, `doctor`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, makeOut, parseLngLat, readJSON, writeJSON, exists, round6, geomBBox, UsageError, UserError } from './util.mjs';
import { UA, LOOKUPS, lookupState } from './net.mjs';
import { chainOf, resolveProvider } from './lookup.mjs';
import { STARTER_DIR, ensureGitignore, openSite, loadLayer, listLayerIds, withSiteLock } from './site.mjs';
import { loadPlaywright, launchChromium } from './cmd-serve.mjs';
import { parseExpect, describeItems } from './expect.mjs';

export const helps = {
  newSite: `new <dir> [--title "Where to stay in Taipei"] [--subtitle "…"] [--ask "Which hotel for 3 nights?"] [--center lng,lat] [--zoom 14]
      [--lang en|sv] [--expect "<item>,<item>:<nights>,…"] [--force] [--json]
  Copies the starter (index.html, map.config.json, style.json, custom.js, data/, engine/) into <dir>, sets title and view
  (bounds are derived from --center + --zoom) and writes a .gitignore (.uwcache/ and the working snapshots, keeping
  snapshots/mobile.png, desktop.png and thumb.png for a gallery). Refuses a non-empty
  <dir> unless --force (then only starter files are overwritten; your other files stay).
  Get the centre from: uw.mjs geocode "Zhongshan, Taipei". Zoom: city 12, district 13.5, neighbourhood 14.5, street 16.
  --ask "…"  the user's question (≤ 70 characters), kept as "description"; \`uw question\` uses it when it gets no --ask.
  --lang sv  "locale": "sv": the words the map writes itself (tabs, verdict phrases from uw question) are Swedish.
  --expect "…"  every item the request names (stops with nights, places, options), kept as "expect": uw validate
             fails while one of them is not on the map (or, with a plan, in no day). A stop with nights
             ("Lisbon:3" for 3 days in Lisbon) is a trip: validate fails until the map has its plan.`,
  fit: `fit <dir> [--layers hotels,day1] [--pad 0.12] [--max-zoom 16] [--json]
  Sets view.center, view.zoom and view.bounds in map.config.json to frame the data. A find-place question frames its
  lettered top N (ranked like the engine) plus the hand-picked layers. Default: the hand-picked layers
  (made by add-point, station, stay, route and legs; walk areas from isochrone too when there is only one subject point); else
  unclustered points, routes, legs and areas. Context layers (places, lines, feel, wiki) never decide the frame.
  view.bounds = the data's box (+ --pad), view.zoom = the zoom a phone needs to show it. Every screen fits view.bounds;
  phones never zoom in past view.zoom + 0.6, wide screens past view.zoom + 1. Run it after adding data instead of typing coordinates.`,
  upgrade: `upgrade <dir> [--dry-run] [--json]
  Replaces <dir>/engine/ with the pack's current engine (kit-owned files only). Config, style, custom.js and data are untouched.`,
  doctor: `doctor [<dir>] [--offline] [--json]
  Checks Node, the network services the scripts use, Playwright (for snapshot) and the pack's starter; with <dir> also
  validates that site. Exit 1 only when something blocking is wrong (old Node, missing starter, invalid site).`,
};

const SKIP = new Set(['.DS_Store', '.uwcache', 'snapshots', 'node_modules', '.git', 'Thumbs.db']);

function copyTree(src, dst, { overwrite = true } = {}) {
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyTree(s, d, { overwrite });
    else if (e.isFile()) { if (overwrite || !exists(d)) { fs.copyFileSync(s, d); n++; } }
  }
  return n;
}
function listFiles(d, base = d) {
  if (!exists(d)) return [];
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

function checkStarter() {
  const need = ['index.html', 'map.config.json', 'engine/engine.js'];
  const missing = need.filter((f) => !exists(path.join(STARTER_DIR, f)));
  if (missing.length) throw new UserError(`the pack's starter is incomplete (${STARTER_DIR}: missing ${missing.join(', ')}). Reinstall the skill pack.`);
}

// Bounds that frame roughly what a phone shows above the bottom sheet at this zoom (MapLibre 512 px tiles).
// The engine fits these bounds but never zooms in past view.zoom, so desktops just show more around them.
const FIT_W = 310, FIT_H = 490; // css px of map a portrait phone leaves visible (390×844, sheet in peek, button column, camera padding)
export function boundsFor(center, zoom) {
  const mpp = (78271.517 * Math.cos((center[1] * Math.PI) / 180)) / 2 ** zoom;
  const hw = (FIT_W / 2) * mpp, hh = (FIT_H / 2) * mpp;
  const dLng = hw / (111320 * Math.cos((center[1] * Math.PI) / 180)), dLat = hh / 110574;
  return [[round6(center[0] - dLng), round6(center[1] - dLat)], [round6(center[0] + dLng), round6(center[1] + dLat)]];
}

/** The one command that serves a site and posts its card, run from the site's folder (SKILL.md step 3): the title
 *  in single quotes when it has a character the shell reads inside double quotes. Pure; exported for the tests. */
export function cardCommand(title) {
  const t = String(title ?? '');
  const quoted = /^[^"$`\\!]*$/.test(t) ? `"${t}"` : `'${t.replace(/'/g, `'\\''`)}'`;
  return `instafy preview open --title ${quoted} --serve-cmd "uw host . --port {port}" --start --json`;
}

export async function newSite(argv) {
  const args = parseArgs(argv, { title: 'string', subtitle: 'string', ask: 'string', center: 'string', zoom: 'number', lang: 'string', force: 'bool', expect: 'string' }, { positionals: [1, 1], command: 'new' });
  if (args.help) return console.log(helps.newSite);
  const expect = parseExpect(args.expect);
  // stops with nights: a trip, built by reference/itinerary.md
  const trip = expect.filter((e) => e.nights != null);
  const out = makeOut(args);
  checkStarter();
  const dir = path.resolve(args._[0]);
  if (dir === STARTER_DIR || dir.startsWith(STARTER_DIR + path.sep)) throw new UsageError('refusing to create a site inside the pack starter');
  const center = args.center ? parseLngLat(args.center, 'center') : null;
  if (args.zoom !== undefined && (args.zoom < 0 || args.zoom > 20)) throw new UsageError('--zoom must be 0-20');
  if (args.lang !== undefined && !['en', 'sv'].includes(args.lang)) throw new UsageError('--lang must be en or sv');
  if (exists(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new UserError(`"${args._[0]}" exists and is a file`);
    const existing = fs.readdirSync(dir).filter((f) => !SKIP.has(f) && f !== '.gitignore');
    if (existing.length && !args.force)
      throw new UserError(`"${args._[0]}" is not empty (${existing.slice(0, 5).join(', ')}${existing.length > 5 ? ', …' : ''}). Use another directory, or --force to copy the starter over it (your other files stay).`);
  }
  const userCfg = path.join(dir, 'map.config.json');
  const keepCfg = args.force && exists(userCfg);
  const n = copyTree(STARTER_DIR, dir, { overwrite: true });
  if (keepCfg) out.warn('--force: map.config.json was replaced by the starter config');
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = readJSON(cfgPath);
  cfg.version = 2; // v0.2 sites (the engine reads 1 and 2 alike)
  if (args.title) cfg.title = args.title;
  if (args.lang) cfg.locale = args.lang;
  if (args.subtitle !== undefined) cfg.subtitle = args.subtitle;
  // the user's question in a few words (SKILL.md step 1): kept as "description" until `uw question` makes it the ask
  if (args.ask !== undefined) {
    const ask = String(args.ask).trim();
    if (!ask) throw new UsageError('--ask needs text (the question in ≤ 70 characters)');
    // the ask is the panel's heading: a pasted request cut at 70 characters read "…can you help plan" (r5)
    if (ask.length > 70) throw new UsageError(`--ask is ${ask.length} characters: it is the map's heading, so write the question yourself in ≤ 70 (e.g. "Two weeks in Taiwan by train"), never the user's message`);
    cfg.description = ask;
  }
  if (expect.length) cfg.expect = expect;
  cfg.view = cfg.view || {};
  if (center) {
    cfg.view.center = center;
    const z = args.zoom ?? 14;
    cfg.view.zoom = z;
    cfg.view.bounds = boundsFor(center, z);
  } else if (args.zoom !== undefined) cfg.view.zoom = args.zoom;
  writeJSON(cfgPath, cfg, { pretty: true });
  // working screenshots stay out of git; the three a gallery shows stay in
  ensureGitignore(dir, ['.uwcache/', 'snapshots/*', '!snapshots/mobile.png', '!snapshots/desktop.png', '!snapshots/thumb.png']);
  const rel = path.relative(process.cwd(), dir) || '.';
  out.result({ ok: true, dir, files: n, title: cfg.title, view: cfg.view }, [
    `Created ${rel} (${n} files) — "${cfg.title}"${center ? ` centred on ${center.join(',')} @ z${cfg.view.zoom}` : ''}.`,
    center ? null : 'No --center given: set view.center/zoom/bounds in map.config.json (validate will remind you).',
    // the card before any lookup (SKILL.md step 3): a slow lookup can then cost the map content, never its card
    `Next, at once: its card, from ${rel}: ${cardCommand(cfg.title)}`,
    trip.length
      ? `Then: a trip (${describeItems(trip)}): follow reference/itinerary.md ("One base" for days in one place), not SKILL.md steps 4-8; uw validate fails until the plan has its days.`
      : `Then (SKILL.md procedure step 4): uw add-point ${rel} --layer <options> --query "<name, city>" --near <lng,lat from geocode> --id <slug>, once per option. A trip (days or nights somewhere): reference/itinerary.md instead.`,
  ]);
}

// `fit`: set view.bounds / center / zoom from the data (so nobody has to type coordinates).
export async function fit(argv) {
  const args = parseArgs(argv, { layers: 'string', pad: 'number', 'max-zoom': 'number' }, { positionals: [1, 1], command: 'fit' });
  if (args.help) return console.log(helps.fit);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const r = await fitView(site, { layers: args.layers, pad: args.pad, maxZoom: args['max-zoom'], out });
  out.result({ ok: true, layers: r.layers, features: r.features, view: r.view }, [
    `view set from ${r.features} features in ${r.layers.join(', ')}: centre ${r.view.center.join(',')}, zoom ${r.view.zoom}, bounds ${r.view.bounds.flat().join(',')}`,
  ]);
}

// The fit itself (also used by add-point to keep the options on screen). Writes map.config.json; returns the view.
export async function fitView(site, { layers = null, pad: padArg, maxZoom, out = { log() {}, warn() {} } } = {}) {
  const cfg = site.config;
  const args = { layers, pad: padArg, 'max-zoom': maxZoom };
  const all = (cfg.layers || []).filter((l) => l && l.id);
  let ids = args.layers ? args.layers.split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (ids) { for (const id of ids) if (!all.some((l) => l.id === id)) throw new UsageError(`--layers: "${id}" is not a layer in map.config.json (layers: ${all.map((l) => l.id).join(', ')})`); }
  else {
    // the things people asked about: hand-picked points (add-point), a trip's stations and places to stay, routes,
    // legs and walk areas; context layers (places, lines, feel, wiki) only frame the map when nothing hand-picked exists
    const cmdOf = (id) => { try { return loadLayer(site, id, { required: false })?.uw?.cmd || null; } catch { return null; } };
    const fileIds = listLayerIds(site).filter((id) => all.find((l) => l.id === id)?.visible !== false);
    ids = fileIds.filter((id) => ['add-point', 'station', 'stay', 'route', 'legs'].includes(cmdOf(id)));
    // one subject point (a park, a station): its walk / ride areas are what the map is about
    const nPts = ids.reduce((n, id) => n + (loadLayer(site, id, { required: false })?.features || []).filter((f) => f?.geometry?.type === 'Point').length, 0);
    const hasLines = ids.some((id) => ['route', 'legs'].includes(cmdOf(id)));
    if (nPts <= 1 && !hasLines) ids.push(...fileIds.filter((id) => cmdOf(id) === 'isochrone'));
    if (!ids.length) ids = all.filter((l) => ['points', 'route', 'legs', 'areas'].includes(l.type) && !l.cluster && l.visible !== false).map((l) => l.id);
    if (!ids.length) ids = all.map((l) => l.id);
    if (!ids.length) ids = listLayerIds(site);
  }
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  let n = 0;
  // find-place: frame the lettered top N (ranked exactly as the engine ranks), not all 445 candidates
  const q = cfg.question;
  if (!args.layers && q?.kind === 'find-place' && q.options?.layer) {
    try {
      const { rankLikeEngine } = await import('./cmd-question.mjs');
      const { readMetrics } = await import('./metrics.mjs');
      const feats = (loadLayer(site, q.options.layer).features || []).filter((f) => f?.properties?.id != null);
      const top = (await rankLikeEngine(site, cfg, q, feats, readMetrics(site.dir).metrics)).slice(0, Math.min(5, q.options.top || 5));
      for (const r of top) { const f = feats.find((x) => String(x.properties.id) === String(r.id)); const g = f && geomBBox(f.geometry); if (g) { b[0] = Math.min(b[0], g[0]); b[1] = Math.min(b[1], g[1]); b[2] = Math.max(b[2], g[2]); b[3] = Math.max(b[3], g[3]); n++; } }
      // the subject (a park, a station) stays in the frame; its reachable areas do not (the answer is the top N)
      ids = ids.filter((id) => id !== q.options.layer && (() => { try { return loadLayer(site, id, { required: false })?.uw?.cmd !== 'isochrone'; } catch { return true; } })());
      out.log(`framing the top ${top.length} of ${feats.length} ${q.options.layer} (find-place) plus ${ids.join(', ') || 'nothing else'}`);
    } catch (e) { out.warn(`could not rank the find-place options (${e.message}); framing the layers instead`); }
  }
  for (const id of ids) {
    const fc = loadLayer(site, id, { required: false });
    if (!fc) { out.warn(`layer "${id}" has no data file yet; skipped`); continue; }
    for (const f of fc.features || []) {
      const g = f?.geometry?.coordinates || f?.geometry?.geometries ? geomBBox(f.geometry) : null;
      if (!g) continue;
      b[0] = Math.min(b[0], g[0]); b[1] = Math.min(b[1], g[1]); b[2] = Math.max(b[2], g[2]); b[3] = Math.max(b[3], g[3]); n++;
    }
  }
  if (!n) throw new UserError(`no features found in ${ids.join(', ')}; add data first`);
  const lat0 = (b[1] + b[3]) / 2, k = Math.cos((lat0 * Math.PI) / 180);
  const pad = args.pad ?? 0.12;
  const minHalf = 250; // m: a single point still gets a street-level frame
  let hw = Math.max(((b[2] - b[0]) / 2) * (1 + pad) * 111320 * k, minHalf), hh = Math.max(((b[3] - b[1]) / 2) * (1 + pad) * 110574, minHalf);
  const cx = (b[0] + b[2]) / 2, cy = lat0;
  const zoomFit = Math.log2(Math.min((78271.517 * k * FIT_W) / (2 * hw), (78271.517 * k * FIT_H) / (2 * hh)));
  const zoom = Math.round(Math.max(1, Math.min(args['max-zoom'] ?? 16, zoomFit)) * 10) / 10;
  // bounds = the data box (+pad), not the phone frame: wide screens fit it larger, phones get ≈ view.zoom
  cfg.view = { ...(cfg.view || {}), center: [round6(cx), round6(cy)], zoom,
    bounds: [[round6(cx - hw / (111320 * k)), round6(cy - hh / 110574)], [round6(cx + hw / (111320 * k)), round6(cy + hh / 110574)]] };
  delete cfg.view.zoomWide;
  // only the view changes: written onto the config as it is now (another command may have changed other keys since
  // this one read it), under the site's write lock
  withSiteLock(site, () => {
    const fresh = readJSON(site.cfgPath);
    fresh.view = cfg.view;
    writeJSON(site.cfgPath, fresh, { pretty: true });
    site.config = fresh;
  });
  return { layers: ids, features: n, view: cfg.view };
}

export async function upgrade(argv) {
  const args = parseArgs(argv, { 'dry-run': 'bool' }, { positionals: [1, 1], command: 'upgrade' });
  if (args.help) return console.log(helps.upgrade);
  const out = makeOut(args);
  checkStarter();
  const dir = path.resolve(args._[0]);
  if (!exists(path.join(dir, 'map.config.json')) && !exists(path.join(dir, 'engine')))
    throw new UserError(`"${args._[0]}" does not look like a map site (no map.config.json or engine/)`);
  const src = path.join(STARTER_DIR, 'engine'), dst = path.join(dir, 'engine');
  const newFiles = listFiles(src), oldFiles = listFiles(dst);
  const added = newFiles.filter((f) => !oldFiles.includes(f));
  const removed = oldFiles.filter((f) => !newFiles.includes(f));
  const changed = newFiles.filter((f) => oldFiles.includes(f) && hash(path.join(src, f)) !== hash(path.join(dst, f)));
  const notes = [];
  for (const f of ['index.html']) {
    if (exists(path.join(dir, f)) && hash(path.join(dir, f)) !== hash(path.join(STARTER_DIR, f))) notes.push(`${f} differs from the starter's (not touched); compare them if the page misbehaves.`);
  }
  if (!args['dry-run'] && (added.length || removed.length || changed.length)) {
    const tmp = dst + '.new-' + process.pid;
    fs.rmSync(tmp, { recursive: true, force: true });
    copyTree(src, tmp);
    const bak = dst + '.old-' + process.pid;
    if (exists(dst)) fs.renameSync(dst, bak);
    fs.renameSync(tmp, dst);
    fs.rmSync(bak, { recursive: true, force: true });
  }
  const same = !added.length && !removed.length && !changed.length;
  out.result({ ok: true, dry_run: !!args['dry-run'], changed, added, removed, notes }, [
    same ? `engine/ is already up to date (${newFiles.length} files).`
      : `${args['dry-run'] ? 'Would update' : 'Updated'} engine/: ${changed.length} changed, ${added.length} added, ${removed.length} removed` +
        `${changed.length + added.length ? ` (${[...changed, ...added].slice(0, 6).join(', ')}${changed.length + added.length > 6 ? ', …' : ''})` : ''}.`,
    ...notes,
    same ? null : 'Run validate and snapshot to check the site still looks right.',
  ]);
}

export async function doctor(argv) {
  const args = parseArgs(argv, { offline: 'bool' }, { positionals: [0, 1], command: 'doctor' });
  if (args.help) return console.log(helps.doctor);
  const out = makeOut(args);
  const checks = [];
  const add = (name, ok, detail, blocking = false) => checks.push({ name, ok, detail, blocking });
  const [maj] = process.versions.node.split('.').map(Number);
  add('node', maj >= 22, `Node ${process.versions.node}${maj >= 22 ? '' : ' (need >= 22)'}`, true);
  try { checkStarter(); add('starter', true, `${listFiles(STARTER_DIR).length} files`); } catch (e) { add('starter', false, e.message, true); }

  if (!args.offline) {
    const h = { 'User-Agent': UA };
    const probe = async (name, url, test, opts = {}) => {
      const t0 = Date.now();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(url, { headers: h, signal: ctrl.signal, method: opts.method || 'GET' });
        const body = opts.method === 'HEAD' ? '' : await r.text();
        const ok = r.ok && (!test || test(body, r));
        add(name, ok, `${ok ? 'ok' : `HTTP ${r.status}`} in ${Date.now() - t0} ms`);
      } catch (e) { add(name, false, e.name === 'AbortError' ? 'timeout (12 s)' : (e.cause?.code || e.message)); } finally { clearTimeout(t); }
    };
    // every declared lookup provider (lookup-providers.json) whose protocol has a probe, once per base URL
    const PROBES = {
      overpass: [(base) => base.replace(/\/interpreter$/, '/status'), (b) => /Connected as|slots available|Rate limit/.test(b)],
      'photon-search': [(base) => `${base}/api/?q=Taipei&limit=1`, (b) => b.includes('FeatureCollection')],
      osrm: [(base) => `${base}/routed-foot/route/v1/foot/121.5234,25.0525;121.5204,25.0526?overview=false`, (b) => b.includes('"Ok"')],
      valhalla: [(base) => `${base}/status`, (b) => b.includes('version')],
      'open-meteo': [(base) => `${base}/v1/air-quality?latitude=25.05&longitude=121.52&hourly=pm2_5&forecast_days=1`, (b) => b.includes('hourly')],
      'wikipedia-coords': [(base) => `${base}/w/api.php?action=query&meta=siteinfo&format=json`, (b) => b.includes('general')],
    };
    const declared = new Map();
    for (const capability of Object.keys(LOOKUPS.chains)) {
      for (const id of chainOf(LOOKUPS, capability)) {
        const p = resolveProvider(LOOKUPS, id);
        for (const base of p.bases.slice(0, 1)) if (PROBES[p.protocol] && !declared.has(base)) declared.set(base, { p, base, caps: [] });
        for (const base of p.bases.slice(0, 1)) declared.get(base)?.caps.push(capability);
      }
    }
    // a breaker another uw command opened (the provider was found down): said here, with when it is asked again
    for (const capability of Object.keys(LOOKUPS.chains)) {
      const st = lookupState(capability);
      const down = st.providers.filter((x) => !x.allow);
      if (down.length) add(`lookup ${capability}`, st.available, `${down.map((x) => `${x.label} found down, asked again in ${x.retry_after_s} s or next turn`).join('; ')}${st.available ? '' : ' (nothing left to ask: exit 4)'}`);
    }
    await Promise.all([
      probe('OpenFreeMap tiles (basemap)', 'https://tiles.openfreemap.org/styles/liberty', (b) => b.includes('"layers"')),
      ...[...declared.values()].map(({ p, base, caps }) => probe(`${p.label} (${[...new Set(caps)].join('/')})`, PROBES[p.protocol][0](base), PROBES[p.protocol][1])),
      probe('AWS terrarium DEM (3D terrain)', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png', null, { method: 'HEAD' }),
      probe('Panoramax (photos)', 'https://api.panoramax.xyz/api/search?bbox=121.52,25.05,121.521,25.051&limit=1', (b) => b.includes('features')),
      probe('data.gov.tw API (adapters tw-*)', 'https://data.gov.tw/api/v2/rest/dataset/7780', (b) => b.includes('distribution')),
    ]);
  }
  try {
    const pw = await loadPlaywright();
    try {
      const b = await launchChromium(pw);
      const v = b.version();
      await b.close();
      add('Playwright (snapshot)', true, `Chromium ${v}`);
    } catch (e) { add('Playwright (snapshot)', false, `found, but the browser did not launch: ${e.message.split('\n')[0]}. Try: npx playwright install chromium`); }
  } catch (e) { add('Playwright (snapshot)', false, 'not found: snapshot will skip. npm i -D playwright, or set UW_PLAYWRIGHT=/path/to/node_modules/playwright'); }

  let site = null;
  if (args._[0]) {
    const { run } = await import('./cmd-validate.mjs');
    // run validate quietly and capture JSON
    const orig = process.stdout.write.bind(process.stdout);
    let buf = '';
    process.stdout.write = (c) => { buf += c; return true; };
    let code;
    try { code = await run([args._[0], '--json']); } finally { process.stdout.write = orig; }
    try { site = JSON.parse(buf); } catch { site = { ok: code === 0, errors: [], warnings: [] }; }
    add(`site ${args._[0]}`, site.ok, `${site.errors.length} error(s), ${site.warnings.length} warning(s)${site.ok ? '' : ` — run: uw validate ${args._[0]}`}`, true);
  }
  const blocking = checks.some((c) => !c.ok && c.blocking);
  out.result({ ok: !blocking, checks, site }, [
    ...checks.map((c) => `${c.ok ? '✓' : c.blocking ? '✗' : '!'} ${c.name}: ${c.detail}`),
    blocking ? 'Blocking problems above (✗).' : checks.some((c) => !c.ok) ? 'Usable. Items marked ! are optional or temporarily unreachable; commands that need them fail until fixed.' : 'All good.',
  ]);
  return blocking ? 1 : 0;
}
