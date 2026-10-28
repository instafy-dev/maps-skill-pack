// Long commands as background jobs: `uw <cmd> … --detach` starts the command and returns at once with a job id;
// `uw wait [<job>]` prints its output so far and waits a little (exit 75 while it still runs: run `uw wait` again; then
// the command's own exit code). A shell tool that gives up on a long command after its own time limit can never leave
// the agent guessing whether the work stalled, and the command is never started twice.
// Jobs live in jobs/ in the current folder's state folder (lib/state-dir.mjs: the space's folder in Instafy, else
// .uwcache/ here): <id>.json (command, pid, times, exit code) and <id>.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UsageError, UserError } from './util.mjs';
import { stateDirOf } from './state-dir.mjs';

const UW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uw.mjs');
/** Exit code of `uw wait` while the job still runs (EX_TEMPFAIL). */
export const STILL_RUNNING = 75;
const DEFAULT_WAIT_S = 50;

export const help = `wait [<job id>] [--max 50] [--json]
  Waits for a job a command started with --detach (the newest one when no id is given): prints its new output, waits up
  to --max seconds (default ${DEFAULT_WAIT_S}), then exits with the command's own exit code when it has finished, or with
  ${STILL_RUNNING} while it still runs: run \`uw wait <id>\` again. Never start the command a second time.
  Any uw command takes --detach (\`uw handoff … --apply --detach\`); host and serve have their own.`;

export function jobsDir(cwd = process.cwd()) { return path.join(stateDirOf(cwd), 'jobs'); }
const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
const readJob = (dir, id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; } };
const writeJob = (dir, job) => fs.writeFileSync(path.join(dir, `${job.id}.json`), JSON.stringify(job, null, 2));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The environment a background job runs with. When the host can continue the work in a new turn
 *  (INSTAFY_TURN_CONTINUE_FILE), the job is not part of this turn: it runs outside the turn's clock (its steps keep
 *  their own limits and skip nothing for the turn's sake), and a later turn waits for it with `uw wait`. Its step
 *  timings go to a file of its own (UW_JOB_TIMINGS), which `uw wait` hands to the turn that sees it finish. Exported
 *  for the tests. */
export function jobEnv(env, timingsFile) {
  const e = { ...env, UW_JOB_TIMINGS: timingsFile };
  delete e.INSTAFY_STEP_TIMINGS_FILE;
  if (env.INSTAFY_TURN_CONTINUE_FILE) {
    delete e.INSTAFY_TURN_STARTED_AT; delete e.INSTAFY_TURN_DEADLINE; delete e.INSTAFY_TURN_CONTINUE_FILE;
    e.UW_TURN_BUDGET = '0';
  }
  return e;
}

/** Start `uw <args…>` in the background; returns the job record. */
export function startJob(args, { cwd = process.cwd() } = {}) {
  const dir = jobsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${args[0]}-${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')}`;
  const log = path.join(dir, `${id}.log`);
  const fd = fs.openSync(log, 'a');
  const job = { id, cmd: args[0], command: `uw ${args.map(q).join(' ')}`, started_at: new Date().toISOString(), log, pid: null, exit_code: null, ended_at: null };
  writeJob(dir, job);
  const child = spawn(process.execPath, [UW, '__job', id, ...args], { cwd, detached: true, stdio: ['ignore', fd, fd], env: jobEnv(process.env, path.join(dir, `${id}.timings.ndjson`)) });
  child.unref();
  fs.closeSync(fd);
  job.pid = child.pid;
  writeJob(dir, job);
  return job;
}

/** The background side of a job: run the command, then record its exit code. */
export function runJob(id, args, { cwd = process.cwd() } = {}) {
  const dir = jobsDir(cwd);
  const started = Date.now();
  const r = spawnSync(process.execPath, [UW, ...args], { cwd, stdio: 'inherit', env: process.env });
  const job = readJob(dir, id) || { id };
  Object.assign(job, { exit_code: r.status ?? 1, ended_at: new Date().toISOString() });
  // the job as one step (the command it ran may have recorded its own steps already)
  if (process.env.UW_JOB_TIMINGS) {
    try { fs.appendFileSync(process.env.UW_JOB_TIMINGS, JSON.stringify({ tool: 'uw', command: `job ${args[0]}`, step: job.command || args[0], phase: 'job', start_ms: 0, ms: Date.now() - started, exit: job.exit_code }) + '\n'); } catch {}
  }
  writeJob(dir, job);
  return job.exit_code;
}

/** A finished job's step timings go to the turn that saw it finish (INSTAFY_STEP_TIMINGS_FILE), once per turn file. */
export function handOverTimings(dir, id, env = process.env) {
  const to = env.INSTAFY_STEP_TIMINGS_FILE;
  if (!to) return false;
  const from = path.join(dir, `${id}.timings.ndjson`);
  const mark = path.join(dir, `${id}.timings.sent`);
  let sent = [];
  try { sent = fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean); } catch {}
  if (sent.includes(to)) return false;
  let text = '';
  try { text = fs.readFileSync(from, 'utf8'); } catch { return false; }
  if (!text.trim()) return false;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.appendFileSync(to, text.endsWith('\n') ? text : `${text}\n`);
    fs.appendFileSync(mark, `${to}\n`);
    return true;
  } catch { return false; }
}

function newestJob(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  const jobs = files.map((f) => readJob(dir, f.slice(0, -5))).filter(Boolean).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return jobs[0] || null;
}

/** `uw wait`: stream the job's new output for up to `maxS` seconds. Resolves the exit code. */
export async function waitJob(argv, { cwd = process.cwd(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), write = (t) => process.stdout.write(t) } = {}) {
  let id = null, maxS = DEFAULT_WAIT_S, json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') { maxS = Number(argv[++i]); if (!(maxS >= 0)) throw new UsageError('--max takes seconds'); }
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(help); return 0; }
    else if (!argv[i].startsWith('-')) id = argv[i];
  }
  const dir = jobsDir(cwd);
  let job = id ? readJob(dir, id) : newestJob(dir);
  if (!job) throw new UserError(id ? `no job "${id}" in ${dir}` : `no jobs in ${dir} (start one with --detach)`);
  id = job.id;
  const seen = path.join(dir, `${id}.seen`);
  let offset = 0;
  try { offset = Number(fs.readFileSync(seen, 'utf8')) || 0; } catch {}
  const flush = () => {
    let buf = Buffer.alloc(0);
    try { const all = fs.readFileSync(job.log); buf = all.subarray(offset); offset = all.length; } catch {}
    if (buf.length && !json) write(buf.toString('utf8'));
    try { fs.writeFileSync(seen, String(offset)); } catch {}
  };
  const t0 = Date.now();
  for (;;) {
    flush();
    job = readJob(dir, id) || job;
    if (job.exit_code != null) {
      handOverTimings(dir, id);
      const line = `job ${id} finished: exit ${job.exit_code} (${job.command})`;
      if (json) write(`${JSON.stringify({ ok: job.exit_code === 0, job: id, finished: true, exit_code: job.exit_code, log: job.log })}\n`); else write(`\n${line}\n`);
      return job.exit_code;
    }
    if (job.pid && !alive(job.pid)) {
      // the background process is gone without recording an exit code (killed, machine restarted)
      const line = `job ${id} stopped without finishing (${job.command}); its output is in ${job.log}. Start it again if it is still needed.`;
      if (json) write(`${JSON.stringify({ ok: false, job: id, finished: false, stopped: true, log: job.log })}\n`); else write(`\n${line}\n`);
      return 1;
    }
    if ((Date.now() - t0) / 1000 >= maxS) {
      const ran = Math.round((Date.now() - Date.parse(job.started_at)) / 1000);
      if (json) write(`${JSON.stringify({ ok: true, job: id, finished: false, running_s: ran })}\n`);
      else write(`\nstill running (${ran} s so far): run \`uw wait ${id}\` again (never start the command twice).\n`);
      return STILL_RUNNING;
    }
    await sleep(1000);
  }
}
