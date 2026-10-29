#!/usr/bin/env node
// uw.mjs — map-pack CLI: make and feed interactive map sites. Zero dependencies, Node >= 22.
// Usage: node scripts/uw.mjs <command> [args]   (node scripts/uw.mjs help for the list)
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './lib/util.mjs';
import { setDeadline, isSkip, releaseOverpassLock, networkActive } from './lib/net.mjs';
import { commandLimitS, runOutOfTime, jobDeadlineValue, maxCommandS } from './lib/budget.mjs';
import { stateDirOf } from './lib/state-dir.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`error: uw.mjs needs Node >= 22; this is Node ${process.versions.node}.`);
  process.exit(1);
}

const COMMANDS = {
  new:        ['cmd-site.mjs', 'newSite',      'Create a site from the starter (title, centre, zoom, .gitignore)'],
  doctor:     ['cmd-site.mjs', 'doctor',   'Check Node, network services, Playwright and (optionally) a site'],
  geocode:    ['cmd-geocode.mjs', 'geocode', 'Look up a place name → candidates with coordinates (the place search chain)'],
  'add-point':['cmd-geocode.mjs', 'addPoint', 'Geocode a name and add/replace it as a point in a layer'],
  places:     ['cmd-places.mjs', 'run',    'OpenStreetMap places by kind (cafe, gym, mrt_station…) or tag → points'],
  lines:      ['cmd-lines.mjs', 'run',     'Transit/rail/ferry/cycleway lines with OSM colours → lines'],
  route:      ['cmd-routing.mjs', 'route', 'Walking/cycling/driving route between points (OSRM) → route line'],
  isochrone:  ['cmd-routing.mjs', 'isochrone', 'Reachable area in N minutes (Valhalla) → areas linked to points'],
  legs:       ['cmd-routing.mjs', 'legs',  'Ordered trip legs between stops (arcs, or real track with --follow <lines layer>)'],
  station:    ['cmd-stay.mjs', 'station',  "A city's main railway station as a point (OSM railway=station only; --nights for trips)"],
  handoff:    ['cmd-handoff.mjs', 'run',   "Read a research team's handoff files (instafy.research@1) → the trip steps, facts, unverified list"],
  cite:       ['cmd-cite.mjs', 'run',      'Fetch one public page as a fact source (robots.txt, link-only sites refused, bot checks stop) → url, title, retrieved_at, lines'],
  transit:    ['cmd-transit.mjs', 'run',   'Scheduled train/bus connections between two stops from a MOTIS planner (if configured) → ride time with source'],
  plan:       ['cmd-plan.mjs', 'run',      'Day-by-day plan of a trip from stops + nights + start date (legs, stays, sights as items)'],
  stay:       ['cmd-stay.mjs', 'stay',     'Lodging near a station/place ranked by walking time, with a reason each (Taiwan register / OSM)'],
  air:        ['cmd-air.mjs', 'run',       'Air quality, past 7 + next 3 days, by hour (Open-Meteo) → data/air.json'],
  feel:       ['cmd-feel.mjs', 'run',      'Calm/lively/green/amenities grid estimated from OpenStreetMap → data/feel.geojson'],
  enrich:     ['cmd-enrich.mjs', 'run',    'Add metrics to features: counts nearby, nearest distance, feel scores'],
  wiki:       ['cmd-wiki.mjs', 'run',      'Wikipedia articles near a point → points with short extracts'],
  areas:      ['cmd-areas.mjs', 'run',     'Named areas with verdicts ("Quiet at night") from the feel grid → data/areas.geojson'],
  doorstep:   ['cmd-doorstep.mjs', 'run',  'Street at the door: class, main-road distance, Street View viewpoint + heading'],
  photos:     ['cmd-photos.mjs', 'run',    'Dated doorstep street photos (Panoramax, CC BY-SA) → data/photos.json'],
  adapter:    ['cmd-adapter.mjs', 'run',   'Dataset adapters (list | tw-hotels | tw-night-markets …): licences, hours, filed rates'],
  question:   ['cmd-question.mjs', 'run',  'Scaffold the "question" block (options, criteria, lenses) from data/metrics.json'],
  host:       ['cmd-host.mjs', 'host',     'Dev host: static serve + __uw/intent, __uw/events (SSE) and handlers from bound.json'],
  reload:     ['cmd-host.mjs', 'reload',   'After editing a site: every open viewer reloads in place (keeps camera, selection, sheet)'],
  set:        ['cmd-set.mjs', 'run',       'Edit one feature\'s note/name/props, or remove it (no network)'],
  fit:        ['cmd-site.mjs', 'fit',      'Set view centre/zoom/bounds in map.config.json to frame the data'],
  validate:   ['cmd-validate.mjs', 'run',  'Check config, data files, refs, style and custom.js (exit 1 on errors)'],
  serve:      ['cmd-serve.mjs', 'serve',   'Static dev server (Range, MIME, no-cache), prints local + LAN URLs'],
  snapshot:   ['cmd-serve.mjs', 'snapshot','Render desktop + mobile PNGs with Playwright; report console errors'],
  upgrade:    ['cmd-site.mjs', 'upgrade',  "Replace the site's engine/ with the pack's current engine"],
  lookups:    ['cmd-lookups.mjs', 'run',   'The outside services per capability, in order, and their health (--reset to ask a down one again)'],
  wait:       ['jobs.mjs', 'waitJob',      'Wait for a job started with --detach: its output, then its exit code (75 = still running: wait again)'],
};
// commands with their own --detach (a server that keeps running); every other command runs as a background job with it
const OWN_DETACH = new Set(['host', 'serve']);

// Network commands get a time limit (seconds): --timeout <s> overrides it, --timeout 0 = the longest allowed
// (lib/budget.mjs: no command runs past 9 minutes, the host's turn or the run it belongs to). Phase-A commands
// (places, enrich, add-point, stay) are short so the first useful map is quick; slow enrichments (feel, areas…) get
// longer. `stay` answers within its 30 s with what it found (a command an agent waits on must end while it still waits).
// Past the limit the command is SKIPPED: exit 4, one "skipped: …" line, files and config left valid.
export const NET_TIMEOUT_S = { geocode: 45, handoff: 90, 'add-point': 90, places: 45, enrich: 30, lines: 60, route: 30, legs: 45, isochrone: 45, station: 45, stay: 30, cite: 30, transit: 30,
  air: 30, feel: 90, areas: 45, doorstep: 30, photos: 60, wiki: 30, adapter: 120 };
// slow, optional layers: skipped at once when the turn budget is used up (Phase A commands still get a short try)
const OPTIONAL = new Set(['lines', 'route', 'legs', 'isochrone', 'air', 'feel', 'areas', 'doorstep', 'photos', 'wiki', 'adapter']);
// Turn budget: hosted agents have a hard per-turn limit. When the host says when the turn started and when it ends
// (INSTAFY_TURN_STARTED_AT / INSTAFY_TURN_DEADLINE, ISO times), those are used, minus a reply margin. Otherwise a
// "turn" starts at the first uw command on a site after ≥ UW_TURN_GAP s (default 150) of no uw commands, and network
// commands never run past UW_TURN_BUDGET s (default 480) into it, so there is always time left to validate, serve and
// reply. UW_TURN_BUDGET=0 turns the turn budget off (a background job); the command ceiling still holds.
const REPLY_MARGIN_S = 120;
// a network command ends this long before the host's hard turn limit, whatever --timeout it was given
const HOST_MARGIN_S = 45;
const HOST_TURN = (() => {
  const started = Date.parse(process.env.INSTAFY_TURN_STARTED_AT || '');
  const deadline = Date.parse(process.env.INSTAFY_TURN_DEADLINE || '');
  return Number.isFinite(started) && Number.isFinite(deadline) && deadline > started ? { started, deadline } : null;
})();
const TURN_BUDGET_S = process.env.UW_TURN_BUDGET != null ? Number(process.env.UW_TURN_BUDGET)
  : HOST_TURN ? Math.max(60, Math.round((HOST_TURN.deadline - HOST_TURN.started) / 1000) - REPLY_MARGIN_S) : 480;
const TURN_GAP_S = Number(process.env.UW_TURN_GAP ?? 150);

function siteDirOf(rest) {
  // the site is the first positional, or --site <dir> (handoff <handoff dir> --site <site>)
  const flag = rest.findIndex((a) => a === '--site' || a.startsWith('--site='));
  const named = flag < 0 ? [] : [rest[flag].includes('=') ? rest[flag].slice(7) : rest[flag + 1]];
  for (const a of [...rest.slice(0, 2), ...named]) {
    if (!a || a.startsWith('-')) continue;
    try { if (fs.statSync(path.join(a, 'map.config.json')).isFile()) return path.resolve(a); } catch {}
  }
  return null;
}
function turnClock(dir, { touchOnly = false } = {}) {
  // the host's own clock beats the idle-gap guess
  if (HOST_TURN && process.env.UW_TURN_BUDGET == null) return { elapsedS: Math.max(0, Math.round((Date.now() - HOST_TURN.started) / 1000)), host: true };
  if (!dir) return null;
  const f = path.join(stateDirOf(dir), 'turn.json');
  const now = Date.now();
  let t = null;
  try { t = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  // a new turn after a quiet gap (only checked when a command starts: a long command must not restart the clock)
  if (!t || !(t.started > 0) || !(t.last > 0) || (!touchOnly && now - t.last > TURN_GAP_S * 1000)) t = { started: now, last: now };
  t.last = now;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(t)); } catch {}
  return { elapsedS: Math.round((now - t.started) / 1000) };
}
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
// "retry later with" line: the same command with a longer limit
function retryLine(cmd, rest, timeoutS) {
  const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  const args = []; for (let i = 0; i < rest.length; i++) { if (rest[i] === '--timeout') { i++; continue; } if (/^--timeout=/.test(rest[i]) || rest[i] === '--json') continue; args.push(rest[i]); }
  return `uw ${cmd} ${args.map(q).join(' ')} --timeout ${Math.max(120, Math.round((timeoutS || 60) * 2))}`;
}

function usage() {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  console.log(`uw.mjs — interactive map sites (map-pack)

Usage: node scripts/uw.mjs <command> [<dir>] [flags]     help <command> for details

Commands:
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(w)}  ${v[2]}`).join('\n')}

Typical flow, fast first (coordinates only ever come from geocode output, never typed from memory):
  Phase A (a lettered map with a verdict + preview link in minutes):
  uw.mjs geocode "Taipei"                                   → note the lng,lat of the right result
  uw.mjs new trip --title "Taipei stay" --center <lng,lat from geocode> --zoom 13
  uw.mjs add-point trip --layer hotels --query "Hotel Proverbs Taipei" --near <lng,lat>
  uw.mjs places trip --layer mrt --kinds mrt_station --around hotels --radius 800
  uw.mjs places trip --layer cafes --kinds cafe --around hotels --radius 800
  uw.mjs enrich trip --layer hotels --route-to mrt --nearest mrt --count cafes
  uw.mjs question trip --kind choose-one --options hotels --criteria quiet_night_blocks:3,walk_min_mrt:2,cafes:1 --force
  uw.mjs fit trip && uw.mjs validate trip --signal && uw.mjs serve trip     (background; post the link)
  Phase B (optional, one at a time; re-run the same question command after each; exit 4 = skipped, move on):
  uw.mjs snapshot trip --signal
  uw.mjs isochrone trip --layer walk --from layer:hotels --minutes 10
  uw.mjs feel trip --around hotels && uw.mjs enrich trip --layer hotels --feel --feel-within walk
  uw.mjs areas trip --lens quiet_night,lively_night --within walk --options hotels
  uw.mjs adapter tw-hotels trip --layer hotels --records         (Taiwan; uw.mjs adapter list for others)
  uw.mjs doorstep trip --layer hotels && uw.mjs photos trip --layer hotels

In Instafy, uw is on PATH in every shell. Elsewhere put this scripts/ folder on PATH (its uw shim runs uw.mjs),
or run node scripts/uw.mjs.

Points are written as [lng,lat] (longitude first). Refs are <layer>:<featureId>.
Global flags: --json (machine-readable output), --help, --timeout <s> (network commands; 0 = the longest allowed),
  --detach (run as a background job; follow it with uw wait <job>).
Default limits (s): ${Object.entries(NET_TIMEOUT_S).map(([k, v]) => `${k} ${v}`).join(', ')}.
Exit codes: 0 ok, 1 error, 2 usage error / needs a decision, 3 snapshot skipped (no Playwright: screenshots were NOT
checked), 4 skipped / unavailable (a service was busy, slow or down: not "not found"; the map is valid without this
step; say so, offer a retry; uw lookups shows which), 
75 (uw wait) the job still runs: run uw wait again.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const sub = argv[1];
    if (sub && COMMANDS[sub]) {
      const mod = await import(`./lib/${COMMANDS[sub][0]}`);
      console.log(mod.helps?.[COMMANDS[sub][1]] || mod.help || COMMANDS[sub][2]);
      return;
    }
    usage();
    return;
  }
  if (cmd === '--version' || cmd === 'version') { console.log('uw.mjs 0.2.0'); return; }
  if (cmd === '__job') {
    const { runJob } = await import('./lib/jobs.mjs');
    process.exitCode = runJob(argv[1], argv.slice(2));
    return;
  }
  const entry = COMMANDS[cmd];
  if (!entry) {
    const close = Object.keys(COMMANDS).filter((k) => k.startsWith(cmd.slice(0, 3)));
    throw new UsageError(`unknown command "${cmd}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} Run: node scripts/uw.mjs help`);
  }
  let rest = argv.slice(1);
  if (rest.includes('--detach') && !OWN_DETACH.has(cmd) && cmd !== 'wait' && !rest.includes('--help') && !rest.includes('-h')) {
    const { startJob } = await import('./lib/jobs.mjs');
    const job = startJob([cmd, ...rest.filter((a) => a !== '--detach')]);
    if (rest.includes('--json')) process.stdout.write(JSON.stringify({ ok: true, job: job.id, detached: true, command: job.command, log: job.log }) + '\n');
    else console.log(`started job ${job.id}: ${job.command}\nIt runs in the background (minutes for a whole trip). Follow it with: uw wait ${job.id}\n(exit 75 = still running: run uw wait ${job.id} again; never start the command a second time)`);
    return;
  }
  const mod = await import(`./lib/${entry[0]}`);
  if ((rest.includes('--help') || rest.includes('-h')) && !(cmd === 'adapter' && rest[0] && !rest[0].startsWith('-'))) {
    console.log(mod.helps?.[entry[1]] || mod.help || entry[2]);
    return;
  }
  const siteDir = siteDirOf(rest);
  const clock = turnClock(siteDir);
  if (cmd in NET_TIMEOUT_S) {
    // --timeout is global for network commands (snapshot keeps its own --timeout in ms)
    let given = null;
    const kept = [];
    for (let i = 0; i < rest.length; i++) {
      const m = rest[i].match(/^--timeout(?:=(.*))?$/);
      if (!m) { kept.push(rest[i]); continue; }
      const v = m[1] ?? rest[++i];
      given = Number(v);
      if (v === undefined || !Number.isFinite(given) || given < 0) throw new UsageError(`--timeout expects seconds (e.g. --timeout 60; 0 = the longest allowed, ${maxCommandS()} s), got "${v ?? ''}"`);
    }
    rest = kept;
    // handoff --apply paces itself: every step it runs is a uw command with its own limit, and the whole run has one
    // total budget (lib/budget.mjs) its steps inherit through INSTAFY_JOB_DEADLINE
    const selfPaced = cmd === 'handoff' && rest.includes('--apply');
    if (runOutOfTime()) {
      const line = `skipped: the run this step belongs to has used its time budget; the map works without it. Say which steps were skipped, then offer: ${retryLine(cmd, rest, NET_TIMEOUT_S[cmd])}`;
      throw Object.assign(new Error(line), { name: 'SkipError', exitCode: 4, line });
    }
    let turnLeftS = null;
    // the pack's own turn clock (no host clock): what is left before the hard limit, whatever the command asks
    const turnHardLeftS = clock && !clock.host && TURN_BUDGET_S > 0 ? TURN_BUDGET_S + REPLY_MARGIN_S - HOST_MARGIN_S - clock.elapsedS : null;
    if (!selfPaced && given == null && clock && TURN_BUDGET_S > 0) {
      turnLeftS = TURN_BUDGET_S - clock.elapsedS;
      if (OPTIONAL.has(cmd) && turnLeftS < 20) {
        const line = `skipped: ${mmss(clock.elapsedS)} of this turn are used (budget ${mmss(TURN_BUDGET_S)}); the map works without it. Validate, serve and reply now, then offer this as a follow-up: ${retryLine(cmd, rest, NET_TIMEOUT_S[cmd])}`;
        throw Object.assign(new Error(line), { name: 'SkipError', exitCode: 4, line });
      }
    }
    // no command outlives the turn it runs in (a job started with --detach runs outside the turn's clock when a
    // continuation turn can pick it up, see jobs.mjs), and none has no limit at all
    const limit = commandLimitS({ defaultS: NET_TIMEOUT_S[cmd], given, selfPaced, turnLeftS, turnHardLeftS,
      hostDeadlineMs: HOST_TURN && process.env.UW_TURN_BUDGET == null ? HOST_TURN.deadline : null, hostMarginS: HOST_MARGIN_S });
    // the steps a self-paced run starts end with it
    if (selfPaced) process.env.INSTAFY_JOB_DEADLINE = jobDeadlineValue(Date.now() + limit * 1000);
    ctx.limit = limit; ctx.cmd = cmd; ctx.rest = rest;
    setDeadline(limit * 1000);
    if (limit > 0) {
      // a hard stop a little after the limit, in case a request hangs past its abort; never while the command is
      // working on data it already has (it writes valid files when it finishes)
      const hardStop = () => {
        if (!networkActive()) { setTimeout(hardStop, 5000).unref(); return; }
        releaseOverpassLock();
        console.error(`skipped: ${cmd} did not finish within ${limit} s (+15 s grace); the map works without it; retry later with: ${retryLine(cmd, rest, limit)}`);
        process.exit(4);
      };
      setTimeout(hardStop, (limit + 15) * 1000).unref();
    }
  }
  const code = await mod[entry[1]](rest);
  if (typeof code === 'number') process.exitCode = code;
  if (siteDir || cmd === 'new') turnClock(siteDir || siteDirOf(rest), { touchOnly: true });
  if (clock && (cmd === 'question' || cmd === 'validate') && !argv.includes('--json')) {
    const { clockAdvice } = await import('./lib/turn-advice.mjs');
    console.error(clockAdvice(clock.elapsedS, await planGaps(siteDir || siteDirOf(rest)), TURN_BUDGET_S, { continuation: !!process.env.INSTAFY_TURN_CONTINUE_FILE }));
  }
}
/** Empty full days of the site's trip plan, if it has one (see cmd-plan.mjs emptyPlanDays). */
async function planGaps(dir) {
  if (!dir) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'map.config.json'), 'utf8'));
    if (!cfg.plan) return null;
    const { emptyPlanDays } = await import('./lib/cmd-plan.mjs');
    return emptyPlanDays(cfg.plan);
  } catch { return null; }
}

const ctx = { limit: null, cmd: null, rest: null };

main().catch((e) => {
  const json = process.argv.includes('--json');
  if (isSkip(e) || e?.name === 'SkipError') {
    // one clear line: what was skipped, that the map is fine, how to retry
    const line = e.line || `skipped: ${e.message}; ${e.kept ? `kept ${e.kept}; ` : ''}the map works without it; retry later with: ${retryLine(ctx.cmd || process.argv[2], ctx.rest || process.argv.slice(3), ctx.limit)}`;
    if (json) process.stdout.write(JSON.stringify({ ok: false, skipped: true, status: 'unavailable', error: line, kept: e.kept || null, exit_code: 4,
      ...(e.retry_after_s ? { retry_after_s: e.retry_after_s } : {}), ...(e.attempts ? { tried: e.attempts.filter((a) => a.outcome !== 'skipped').map((a) => ({ provider: a.provider, outcome: a.outcome, detail: a.detail || null })) } : {}) }) + '\n');
    console.error(line);
    process.exitCode = 4;
    return;
  }
  const code = e?.exitCode ?? 1;
  const known = e?.name === 'UsageError' || e?.name === 'UserError' || e?.name === 'HttpError';
  const msg = known ? e.message : (e?.stack || String(e));
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: e?.message || String(e), exit_code: code }) + '\n');
  console.error(`error: ${msg}`);
  if (e?.name === 'UsageError' && !/Run: node scripts\/uw\.mjs help/.test(e.message)) {
    const cmd = process.argv[2];
    console.error(`(run: node scripts/uw.mjs help${cmd && COMMANDS[cmd] ? ' ' + cmd : ''})`);
  }
  process.exitCode = code;
});
