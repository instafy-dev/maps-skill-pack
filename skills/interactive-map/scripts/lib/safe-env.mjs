// The environment every process uw starts on its own (a `--detach` server, a `uw host` handler, a warm-up run) gets:
// a positive allowlist, never a copy of the caller's environment. An agent's shell carries per-job credentials
// (CONTROLLER_ACCESS_TOKEN, the model proxy key as OPENAI_API_KEY / CODEX_API_KEY …); a detached server outlives the
// job, and anything that can read /proc/<pid>/environ, or a handler a viewer triggers, would otherwise see them.
// Same policy as instafy-bind's script executor (packages/instafy-bind/src/executors/script.mjs).

const KEEP = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'USERPROFILE']);
// the pack's own settings (UW_*, INSTAFY_LOOKUP_*) and the runtime's stable cache folder (lookup state that outlasts
// the turn: a detached host's lookups share it)
const KEEP_PREFIX = /^(LC_[A-Z_]+|SSL_CERT_(FILE|DIR)|NODE_[A-Z0-9_]+|UW_[A-Z0-9_]+|INSTAFY_LOOKUP_[A-Z0-9_]+|INSTAFY_CACHE_DIR)$/;
// NODE_OPTIONS can preload code into every child (--require/--import); NODE_AUTH_TOKEN is an npm credential
const DROP = new Set(['NODE_OPTIONS', 'NODE_AUTH_TOKEN', 'NODE_REPL_EXTERNAL_MODULE']);
// even an allowed prefix never passes a name that looks like a credential (UW_SOME_TOKEN, NODE_…_KEY)
export const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)KEY$|_KEY_|API_?KEY|COOKIE|SESSION)/;

/** The allowlisted copy of `env` (default: this process's), plus `extra` (UW_* values the child needs). */
export function safeEnv(extra = {}, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || DROP.has(k) || SECRET_ENV_RE.test(k)) continue;
    if (KEEP.has(k) || KEEP_PREFIX.test(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}
