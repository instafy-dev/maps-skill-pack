// Helpers for intent handlers (scripts/handlers/*.mjs), which uw host runs as child processes.
// Contract (ENGINE-SPEC-v0.2 §10): one JSON object on stdin { intent, bound, site: { dir, config } }; NDJSON on stdout:
//   {"type":"progress","step":1,"of":2,"message":"…","source":"…"}  {"type":"records","records":[…],"attribution":[…]}
//   {"type":"done","summary":"…"}  {"type":"error","code":"not_found|upstream|invalid|policy","message":"…"}
// stderr goes to the host log. Handlers never write site files: the host validates, stamps and merges the records.
import { loadLayer } from './site.mjs';

export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const txt = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(txt); } catch { fail('invalid', 'handler input is not JSON'); }
}
export function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
export function progress(step, of, message, source) { emit({ type: 'progress', step, of, message: String(message).slice(0, 140), ...(source ? { source } : {}) }); }
export function records(list, attribution) { if (list.length) emit({ type: 'records', records: list, ...(attribution ? { attribution } : {}) }); }
export function done(summary) { emit({ type: 'done', summary: String(summary || '').slice(0, 200) }); }
export function fail(code, message) { emit({ type: 'error', code, message: String(message || code).slice(0, 140) }); process.exit(0); }
export const log = (...m) => console.error(...m);

// A read-only site view (no .gitignore writes, no cache dir changes): enough for loadLayer().
export function siteView(input) {
  const dir = input?.site?.dir || process.env.UW_SITE || process.cwd();
  return { dir, rel: dir, config: input?.site?.config || null, cfgPath: null };
}
export function findFeature(site, ref) {
  const m = String(ref || '').match(/^([A-Za-z0-9][A-Za-z0-9_-]{0,47}):(.+)$/);
  if (!m) return null;
  let fc = null;
  try { fc = loadLayer(site, m[1], { required: false }); } catch { return null; }
  const f = fc?.features?.find((x) => String(x?.properties?.id) === m[2]);
  return f ? { layer: m[1], id: m[2], feature: f } : null;
}
// Run main() and turn exceptions into {"type":"error"} lines.
export function runHandler(main) {
  main().catch((e) => {
    log(e?.stack || String(e));
    const code = /ENOTFOUND|HTTP \d|timed out|download failed|request failed/i.test(e?.message || '') ? 'upstream' : 'invalid';
    fail(code, e?.message || String(e));
  });
}
