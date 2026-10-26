// Time budget of one uw command. A hosted agent's run has a hard limit (10 minutes); no uw command, background job or
// self-paced run may come near it. There is no unlimited mode: `--timeout 0`, a detached job (UW_TURN_BUDGET=0) and
// `handoff --apply` all get a ceiling, and the host's own deadlines (INSTAFY_TURN_DEADLINE, INSTAFY_JOB_DEADLINE) cap
// everything. A command that runs out ends with what it has (exit 4, partial results kept), never by being killed.

/** No single command runs longer than this (9 min), whatever it is asked. UW_MAX_COMMAND_S may only lower it. */
export const MAX_COMMAND_S = 540;
/** `handoff --apply`: the whole run, every step it starts included (UW_APPLY_BUDGET_S may only lower it). */
export const APPLY_BUDGET_S = 420;
/** Below this much time left in the run, a command does not start (its steps would be cut at once). */
export const MIN_START_S = 3;

const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const isoMs = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };

export function maxCommandS(env = process.env) {
  return Math.min(MAX_COMMAND_S, positive(env.UW_MAX_COMMAND_S) ?? MAX_COMMAND_S);
}

export function applyBudgetS(env = process.env) {
  return Math.min(maxCommandS(env), positive(env.UW_APPLY_BUDGET_S) ?? APPLY_BUDGET_S);
}

/** The deadline of the run this command belongs to (INSTAFY_JOB_DEADLINE, an ISO time), or null. */
export function jobDeadlineMs(env = process.env) {
  return isoMs(env.INSTAFY_JOB_DEADLINE);
}

/**
 * The limit in seconds of one network command (always > 0).
 *   defaultS: the command's own default; given: --timeout (0 = the longest allowed, never "none");
 *   selfPaced: handoff --apply (its own total budget); turnLeftS: what the turn budget leaves (null: no turn clock);
 *   turnHardLeftS: what is left before the turn's hard limit by the pack's own turn clock (null: none; the host's
 *   clock is hostDeadlineMs); hostDeadlineMs / hostMarginS: the host's hard turn limit and the margin kept before it;
 *   env: for the job deadline and the ceilings.
 */
export function commandLimitS({ defaultS, given = null, selfPaced = false, turnLeftS = null, turnHardLeftS = null, hostDeadlineMs = null, hostMarginS = 45, now = Date.now(), env = process.env }) {
  let limit = selfPaced ? applyBudgetS(env) : given == null ? defaultS : given === 0 ? maxCommandS(env) : given;
  // the turn budget caps the default limit (an explicit --timeout is the caller's own choice)
  if (!selfPaced && given == null && turnLeftS != null) limit = Math.min(limit, Math.max(10, turnLeftS));
  // ... but no choice outlives the turn's hard limit: commands run one after another in a turn, so an explicit
  // --timeout or handoff --apply late in the turn gets only what is left of it
  if (turnHardLeftS != null) limit = Math.min(limit, Math.max(10, turnHardLeftS));
  // ... but never the host's hard turn limit
  if (hostDeadlineMs != null) limit = Math.min(limit, Math.max(10, Math.floor((hostDeadlineMs - now) / 1000) - hostMarginS));
  // ... nor the run it belongs to (a self-paced run's steps, a detached job)
  const job = jobDeadlineMs(env);
  if (job != null) limit = Math.min(limit, Math.max(1, Math.floor((job - now) / 1000)));
  return Math.max(1, Math.min(limit, maxCommandS(env)));
}

/** Is the run this command belongs to out of time already? Then the command is skipped before it starts. */
export function runOutOfTime(env = process.env, now = Date.now()) {
  const job = jobDeadlineMs(env);
  return job != null && job - now < MIN_START_S * 1000;
}

/** The environment value that bounds every command a run starts: the earlier of `untilMs` and the one already set. */
export function jobDeadlineValue(untilMs, env = process.env) {
  const job = jobDeadlineMs(env);
  return new Date(job != null ? Math.min(job, untilMs) : untilMs).toISOString();
}
