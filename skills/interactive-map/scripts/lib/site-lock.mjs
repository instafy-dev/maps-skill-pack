// One writer at a time per site: uw commands may run side by side on the same site (handoff --apply runs a stop's
// steps beside the other stops'), and each one reads a layer file or map.config.json, changes it and writes it back.
// `withSiteLock(dir, fn)` runs fn holding the site's write.lock (created exclusively, in its state folder:
// lib/state-dir.mjs), so a read-change-write in
// fn never loses another command's write. Network work stays outside the lock; only the short file sections take it.
// Re-entrant within a process. A lock whose owner is gone, or older than STALE_MS, is taken over.
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './util.mjs';
import { stateDirOf } from './state-dir.mjs';

const PAUSE = new Int32Array(new SharedArrayBuffer(4));
const STALE_MS = 60_000;
const WAIT_MS = Number(process.env.UW_SITE_LOCK_WAIT_MS || 60_000);
const held = new Map(); // lock path -> depth

const ownerGone = (file) => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!(pid > 0)) return false;
    if (pid === process.pid) return false;
    process.kill(pid, 0);
    return false;
  } catch (e) { return e.code === 'ESRCH'; }
};

function acquire(lock) {
  const until = Date.now() + WAIT_MS;
  for (let tries = 0; ; tries++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return;
    } catch (e) {
      if (e.code === 'ENOENT' && tries === 0) { fs.mkdirSync(path.dirname(lock), { recursive: true }); continue; }
      if (e.code !== 'EEXIST') throw e;
      try { if (ownerGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.unlinkSync(lock); } catch { /* gone already */ }
      if (Date.now() > until) throw new UserError(`the site is busy: another uw command has been writing it for over ${Math.round(WAIT_MS / 1000)} s (${lock}); run this again when it has finished`);
      Atomics.wait(PAUSE, 0, 0, 5);
    }
  }
}

/** Run fn (sync or async) holding the site's write lock. `site` is a site object ({ dir }) or a site directory. */
export function withSiteLock(site, fn) {
  const dir = typeof site === 'string' ? site : site?.dir;
  if (!dir) return fn();
  const lock = path.join(stateDirOf(dir), 'write.lock');
  const depth = held.get(lock) || 0;
  if (!depth) acquire(lock);
  held.set(lock, depth + 1);
  const release = () => {
    const d = (held.get(lock) || 1) - 1;
    if (d > 0) { held.set(lock, d); return; }
    held.delete(lock);
    try { fs.unlinkSync(lock); } catch { /* taken over */ }
  };
  let result;
  try { result = fn(); } catch (e) { release(); throw e; }
  if (result && typeof result.then === 'function') return result.finally(release);
  release();
  return result;
}
