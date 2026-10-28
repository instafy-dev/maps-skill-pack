// Where uw keeps a folder's working state: a site's response cache, its background server's pid and log, its write
// lock and turn clock, and the background jobs started from a folder. In an Instafy space the runtime gives every turn
// a folder of the space's own outside its files, kept across turns (INSTAFY_CACHE_DIR): the state lives there, so none
// of it lands in the space's files, a saved version or a published site, and every site of the space shares one
// cache. Elsewhere (or where that folder cannot be written) it is the folder's own `.uwcache/`, as before.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCAL_STATE = '.uwcache';
const memo = new Map();

/** The folder's own `.uwcache/` (where a process without INSTAFY_CACHE_DIR keeps the state, and older packs did). */
export const localStateDir = (dir) => path.join(path.resolve(dir), LOCAL_STATE);

/** A short id of a folder, the same in every process that sees the same folder (its real path, hashed). */
export function folderId(dir) {
  let real = path.resolve(dir);
  try { real = fs.realpathSync(real); } catch { /* not there yet */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** The space's state root (INSTAFY_CACHE_DIR/interactive-map/state), or null outside a space. */
export function spaceStateRoot(env = process.env) {
  const d = String(env.INSTAFY_CACHE_DIR || '').trim();
  return d && path.isAbsolute(d) ? path.join(d, 'interactive-map', 'state') : null;
}

/** The state folder of `dir`: `<INSTAFY_CACHE_DIR>/interactive-map/state/<name>-<id>` in a space whose folder can be
 *  written, else `<dir>/.uwcache`. Created on first use (mode 0700). */
export function stateDirOf(dir, env = process.env) {
  const abs = path.resolve(dir);
  const root = spaceStateRoot(env);
  if (!root) return localStateDir(abs);
  const key = `${root}\0${abs}`;
  if (memo.has(key)) return memo.get(key);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* not there yet */ }
  const name = path.basename(real).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 40) || 'folder';
  let out = path.join(root, `${name}-${folderId(abs)}`);
  try {
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    fs.accessSync(out, fs.constants.W_OK);
  } catch { out = localStateDir(abs); }
  memo.set(key, out);
  return out;
}

/** Every state folder `dir` may have: this process's first, then the folder's own `.uwcache/` (a server the space
 *  restarted without INSTAFY_CACHE_DIR, or one an older pack started, registered there). */
export function stateDirsOf(dir, env = process.env) {
  return [...new Set([stateDirOf(dir, env), localStateDir(dir)])];
}

/** Whether `dir`'s state lives in the space's folder (not in `dir` itself). */
export const stateInSpace = (dir, env = process.env) => stateDirOf(dir, env) !== localStateDir(dir);
