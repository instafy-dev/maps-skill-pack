// `lookups`: the outside services every uw command asks, per capability and in order (lookup-providers.json plus
// INSTAFY_LOOKUP_PROVIDERS), and their health (one shared file: a provider found down is skipped for its cooldown,
// and asked again by the next turn). --reset closes breakers by hand (an operator who fixed a service; outside
// Instafy, a person's explicit "try again").
import { parseArgs, makeOut, UsageError } from './util.mjs';
import { LOOKUPS, lookupHealth, lookupState } from './net.mjs';
import { chainOf, resolveProvider } from './lookup.mjs';

export const help = `lookups [--reset [<provider id>]] [--json]
  The lookup chains (capability → providers in the order they are asked) and each provider's health: ok, slow, or
  down (found down by a uw command; asked again after its cooldown, or by the next turn). Exit 4 from a lookup
  command means every provider of its chain was down or too slow: the service is unavailable, the name is not wrong.
  --reset closes the breakers of every provider (or one id), so the next command asks it at once.`;

export async function run(argv) {
  const args = parseArgs(argv, { reset: 'bool' }, { positionals: [0, 1], command: 'lookups' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const only = args._[0] || null;
  if (only && !LOOKUPS.providers[only]) throw new UsageError(`no provider "${only}" is declared (uw lookups lists them)`);
  if (args.reset) {
    let n = 0;
    for (const id of Object.keys(LOOKUPS.providers)) {
      if (only && id !== only) continue;
      const p = resolveProvider(LOOKUPS, id);
      for (const base of p.bases.length ? p.bases : [null]) { lookupHealth.reset(p, { base }); n++; }
    }
    out.result({ ok: true, reset: n, file: lookupHealth.file }, [`Closed ${n} breaker(s)${only ? ` of ${only}` : ''}: the next lookup asks again.`]);
    return 0;
  }
  const chains = Object.keys(LOOKUPS.chains).map((capability) => {
    const st = lookupState(capability);
    return { capability, available: st.available, degraded: st.degraded, providers: st.providers.map((x) => ({ id: x.id, label: x.label,
      state: !x.allow ? 'down' : x.slow ? 'slow' : 'ok', ...(x.retry_after_s ? { retry_after_s: x.retry_after_s } : {}),
      ...(x.last_error ? { last_error: x.last_error } : {}) })) };
  });
  out.result({ ok: true, file: lookupHealth.file, chains }, [
    ...chains.map((c) => `${c.capability}: ${c.providers.map((p) => `${p.label} [${p.state}${p.retry_after_s ? `, asked again in ${p.retry_after_s} s` : ''}]`).join(' → ') || '(none declared)'}${c.available ? '' : '  UNAVAILABLE'}`),
    `health file: ${lookupHealth.file}`,
  ]);
  return 0;
}
