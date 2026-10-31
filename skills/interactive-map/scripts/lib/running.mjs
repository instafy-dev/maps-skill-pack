// The uw commands still running on a site. A network command run on a site's folder (uw.mjs: a command with a
// network time limit) leaves a small file in the site's state folder while it runs (running/<pid>.json: the command,
// when it started, until when it may run) and removes it when it ends. `uw plan` and `uw validate` name the ones still
// running: a command tool that stops waiting answers with a session and no exit code, and a turn that missed that
// planned its days and replied while its place lookups were still running, so their places never reached the map.
// A file whose process is gone (killed with its turn) or whose time is up is not counted, and is removed.
// The steps a command runs as uw commands of their own (`uw handoff --apply`) share its run (UW_RUN_ID): they never
// name it, or each other, as still running.
import fs from 'node:fs';
import path from 'node:path';
import { stateDirOf, stateDirsOf } from './state-dir.mjs';

const DIR = 'running';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// where the system lists a process's command line (Linux), a pid another program took over is not a uw command
const stillUw = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('uw.mjs'); } catch { return true; }
};
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${String(a).replace(/(["\\$`])/g, '\\$1')}"`);

/** The command as one short line, `uw <cmd>` and its arguments (`args` without the site's folder: "on this site"). */
export function commandLabel(cmd, args = [], max = 110) {
  let line = `uw ${cmd}`;
  for (const a of args.filter((x) => x !== '--json')) {
    const next = `${line} ${quote(a)}`;
    if (next.length > max) return `${line} …`;
    line = next;
  }
  return line;
}

/** Mark this process as running `uw <cmd> <args>` on the site in `dir` until it exits (at the latest `untilMs`).
 *  Returns a function that removes the mark (it is removed on exit too). */
export function markRunning(dir, { cmd, args = [], untilMs, env = process.env, pid = process.pid }) {
  if (!env.UW_RUN_ID) env.UW_RUN_ID = String(pid);
  const file = path.join(stateDirOf(dir, env), DIR, `${pid}.json`);
  const entry = { pid, run: env.UW_RUN_ID, cmd, label: commandLabel(cmd, args), started_at: new Date().toISOString(), until: new Date(untilMs).toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch { return () => {}; }
  let done = false;
  const unmark = () => { if (done) return; done = true; try { fs.unlinkSync(file); } catch { /* gone already */ } };
  process.once('exit', unmark);
  return unmark;
}

/** The network commands still running on the site in `dir`, oldest first, other than this process's own run:
 *  [{ pid, cmd, label, started_at, running_s }]. The files of commands that are gone are removed. */
export function stillRunning(dir, { env = process.env, now = Date.now(), pid = process.pid } = {}) {
  const out = [];
  for (const state of stateDirsOf(dir, env)) {
    const folder = path.join(state, DIR);
    let names = [];
    try { names = fs.readdirSync(folder).filter((n) => /^\d+\.json$/.test(n)); } catch { continue; }
    for (const name of names) {
      const file = path.join(folder, name);
      let e = null;
      try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written */ }
      if (!e || !(e.pid > 0) || e.pid === pid || (env.UW_RUN_ID && e.run === env.UW_RUN_ID)) continue;
      if (!alive(e.pid) || !stillUw(e.pid) || !(Date.parse(e.until) > now)) {
        try { fs.unlinkSync(file); } catch { /* removed by its own process */ }
        continue;
      }
      out.push({ pid: e.pid, cmd: e.cmd, label: e.label, started_at: e.started_at, running_s: Math.max(0, Math.round((now - Date.parse(e.started_at)) / 1000)) });
    }
  }
  return out.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

/** `uw add-point --layer sights --query "…" (35 s so far); uw stay … (4 s so far)` */
export const runningList = (list) => list.map((r) => `${r.label} (${r.running_s} s so far)`).join('; ');
