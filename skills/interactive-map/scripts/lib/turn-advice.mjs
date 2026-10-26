// What the turn clock tells the agent after `uw question` / `uw validate` (uw.mjs): facts only (time used and left, how
// many full days of a trip plan are still empty or thin). What to do with them is the skill's call (SKILL.md "Procedure",
// reference/itinerary.md Phase B). Pure, for the tests.
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;

/** `t`: seconds used; `gaps`: emptyPlanDays() of the site's trip plan, or null; `budgetS`: seconds for tool work;
 *  `continuation`: the host can continue this work in a new turn (INSTAFY_TURN_CONTINUE_FILE is set). */
export function clockAdvice(t, gaps, budgetS = 480, { continuation = false } = {}) {
  const left = Math.max(0, budgetS - t);
  const parts = [`time: ${mmss(t)} used, about ${mmss(left)} left for tool work this turn.`];
  if (gaps && gaps.full >= 1) {
    if (gaps.empty) parts.push(`${gaps.empty} of ${gaps.full} full days are still empty.`);
    else if (gaps.thin) parts.push(`${gaps.thin} of ${gaps.full} full days have fewer than 2 sourced sights.`);
  }
  if (!left) {
    parts.push(continuation && gaps && (gaps.empty || gaps.thin)
      ? 'No time left for network steps in this turn: save, write what is left (in order) to the file $INSTAFY_TURN_CONTINUE_FILE names, and end the turn; a new turn continues from your saved files.'
      : 'No time left for network steps: reply.');
  }
  return parts.join(' ');
}
