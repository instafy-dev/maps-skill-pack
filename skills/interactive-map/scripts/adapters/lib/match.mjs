// Record matching with explicit signals and a confidence level (ENGINE-SPEC-v0.2 §8.2).
//   signals: phone (exact), address (road + section + number), name (similarity ≥ 0.5), geo (≤ 60 m)
//   high:   (phone or address) and (name or geo)
//   medium: name ≥ 0.6 within 150 m, or address (or phone) alone
//   low:    best candidate with name ≥ 0.4 (shown only as "possibly")
import { haversine } from '../../lib/util.mjs';
import { sameAddress, bestNameSim } from './twnorm.mjs';

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
export const confRank = (c) => RANK[c] ?? 0;

// target / cand: { names: [..], phones: [..], addr: parsed address, coord: [lng,lat] | null }
export function scoreCandidate(target, cand) {
  const phone = !!(target.phones?.length && cand.phones?.length && target.phones.some((p) => cand.phones.includes(p)));
  const address = sameAddress(target.addr, cand.addr);
  const sim = bestNameSim(target.names || [], cand.names || []);
  const dist = target.coord && cand.coord ? haversine(target.coord, cand.coord) : null;
  const name = sim >= 0.5, geo = dist != null && dist <= 60;
  let confidence = 'none';
  if ((phone || address) && (name || geo)) confidence = 'high';
  else if ((sim >= 0.6 && dist != null && dist <= 150) || address || phone) confidence = 'medium';
  else if (sim >= 0.4) confidence = 'low';
  const by = [phone && 'phone', address && 'address', name && 'name', geo && 'geo'].filter(Boolean);
  // ordering score: confidence first, then the number of signals, then similarity, then distance
  const score = confRank(confidence) * 100 + by.length * 10 + sim * 5 - (dist == null ? 2 : Math.min(dist, 500) / 250);
  return { confidence, by, sim, dist_m: dist == null ? null : Math.round(dist), score };
}

export function bestMatch(target, cands) {
  let best = null;
  for (const c of cands) {
    const s = scoreCandidate(target, c);
    if (s.confidence === 'none') continue;
    if (!best || s.score > best.score) best = { ...s, cand: c };
  }
  return best;
}
