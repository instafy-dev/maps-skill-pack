// `handoff`: read a research team's handoff files (handoff/<task-slug>/<item-slug>.json, "instafy.research@1") and turn
// them into the map steps of reference/itinerary.md: which station/stay/add-point/legs commands to run per item, which
// facts may go into day texts (high/medium confidence, with a source), and what must be listed as unverified.
// It never writes the site and never takes a coordinate from a handoff (the schema has none; places are geocoded).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, makeOut, slugify, readJSON, writeJSON, writeGeoJSON, exists, haversine, clipWords, UsageError, UserError } from './util.mjs';
import { expectOf, mergeExpect, describeItems } from './expect.mjs';
import { openSite, layerPath, withSiteLock } from './site.mjs';
import { politeFetch, pageText } from './cmd-cite.mjs';
import { forgetMissing } from './cmd-geocode.mjs';
import { FAR_FROM_CENTRE_KM, prefetchLodging } from './cmd-stay.mjs';
import { isSkip, readShared, writeShared, setDeadline, withCap, partialLine } from './net.mjs';
import { runOutOfTime, applyBudgetS } from './budget.mjs';
import { geocodeDown } from './cmd-geocode.mjs';

export const help = `handoff <handoff dir> [--site <site>] [--no-source-check] [--json]
  Reads every *.json in the folder (one research worker each, schema "instafy.research@1": item, kind city|product,
  summary, facts[{text, source_url, retrieved_at, confidence high|medium|low}], places[{name, query, kind
  hotel|station|sight|food|store, why, source_url}], legs[{from, to, mode, duration_min?, source_url?}], unknowns[]).
  Prints per item: the commands to run (station, stay, add-point for researched hotels and sights with their source,
  legs durations only where a leg has both duration_min and source_url), the facts usable in day texts, and the
  unverified list for the reply. Files that break the schema are reported and skipped (exit 1 if none is usable).
  Coordinates never come from a handoff: every place is looked up by its query.
  Source check (on unless --no-source-check): each cited page is read again with uw cite's rules (at most 25 pages).
  A place whose cited page does not name it loses that source and is listed as unverified; a fact whose page is
  gone (HTTP 404/410) is unverified. Pages that refuse automated reads are not held against the item.
  A leg may give a range from its source as duration_min_range [lo, hi] (minutes) instead of one duration_min.
  A lane that covered several stops ("Hualien and Taitung") puts "stop": "<City>" on each place, leg and fact.
  Products: "model" (the generation researched), "previous" (an older one it replaces), "successor" (only when the
  researched model is not the newest: flagged), prices[{store, amount, currency, kind?, source_url, retrieved_at}]
  copied from a page that shows them (\`uw cite <url> --grep price\` shows the page's price lines). The source check reads
  each price's page again: a price it does not show is dropped to the unverified list. Printed under "Prices seen on
  their pages" for the builder to carry to the page with the store, link and day.

handoff --check <file.json>
  Checks one handoff file against the schema (no network): prints what is wrong, exit 1 when it is not usable.

handoff <handoff dir> --site <site> --apply --route "Taipei:3,Hualien:2,…,Taipei:1" --start YYYY-MM-DD
        [--country <name|code>] [--modes train,train,…] [--kinds hotel] [--centre-stays auto|always|never]
        [--no-source-check] [--detach]
  Runs the map steps itself, one uw command after another (the site must exist: uw new first). It takes minutes: run
  it with --detach and follow it with \`uw wait\` (exit 75 = still running: run \`uw wait\` again; never start it twice).
  Every place is looked up in its stop's country (the handoff's "country", else --country), so a city name shared
  across countries never lands in the wrong one. Per city on the route:
  station (with its nights; when no railway station is found the stop is placed at the city centre instead, and said),
  stay (--kinds, default hotel; with --centre-stays auto also in town when the station is far from the centre),
  the researched hotels (merged into the stay that matches by name, with the researcher's reason and source, so it
  becomes the plan's base; added with add-point --strict-name when no pick matches: a hotel whose name no map hit
  carries is listed as unverified, never placed on another hotel), the sourced sights (also by name), then fit,
  lines, legs (sourced durations per leg), question and plan. Prints facts per stop (nights, researched sights, the
  station's distance from the centre) and per leg (distance, sourced duration, whether a high-speed line serves both
  ends on the loaded track), then what is left: day texts, validate, preview, the route line and the unverified list. --route: the stops in travel order with nights (a loop names its first city
  again; 0 nights = pass through).
  The route is the request's list: it is saved as the map's "expect" before any lookup, so uw validate fails while a
  stop is missing. A stop that neither its station nor its city centre placed is tried once more after the stays (a
  busy service often answers by then). One still missing is printed first and last as REQUESTED BUT NOT ON THE MAP,
  with the nights the plan lost and the exact commands to place it; exit 3 (the rest of the map is built).`;

const KINDS = ['hotel', 'station', 'sight', 'food', 'store'];
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

/** Check one handoff object; returns { ok, errors[], item } with the usable parts. Exported for the tests. */
export function checkHandoff(j) {
  const errors = [];
  if (!j || typeof j !== 'object') return { ok: false, errors: ['not a JSON object'] };
  if (j.schema !== 'instafy.research@1') errors.push(`schema is ${JSON.stringify(j.schema)}, expected "instafy.research@1"`);
  if (typeof j.item !== 'string' || !j.item.trim()) errors.push('item missing');
  if (!['city', 'product'].includes(j.kind)) errors.push('kind must be city or product');
  const arr = (k) => (j[k] === undefined ? [] : Array.isArray(j[k]) ? j[k] : (errors.push(`${k} must be an array`), []));
  const facts = arr('facts').filter((f, i) => {
    if (typeof f?.text !== 'string' || !f.text.trim()) { errors.push(`facts[${i}].text missing`); return false; }
    if (!isUrl(f.source_url)) { errors.push(`facts[${i}] has no source_url: listed as unverified`); return false; }
    if (!['high', 'medium', 'low'].includes(f.confidence)) { errors.push(`facts[${i}].confidence must be high, medium or low`); return false; }
    return true;
  });
  const places = arr('places').filter((p, i) => {
    if (typeof p?.name !== 'string' || !p.name.trim()) { errors.push(`places[${i}].name missing`); return false; }
    if (!KINDS.includes(p.kind)) { errors.push(`places[${i}].kind must be one of ${KINDS.join(', ')}`); return false; }
    for (const k of ['lat', 'lng', 'lon', 'coord', 'coordinates', 'geometry']) if (p[k] !== undefined) errors.push(`places[${i}] carries "${k}": ignored (places are looked up by query)`);
    return true;
  });
  const legs = arr('legs').filter((l, i) => {
    if (typeof l?.from !== 'string' || typeof l?.to !== 'string') { errors.push(`legs[${i}] needs from and to`); return false; }
    return true;
  });
  // a product's prices: each copied from a page that shows it (the store's product page), with that page and the day
  const prices = arr('prices').filter((x, i) => {
    if (!Number.isFinite(x?.amount) || x.amount <= 0) { errors.push(`prices[${i}].amount must be a number copied from the page (e.g. 150 or 129.95)`); return false; }
    if (typeof x.currency !== 'string' || !/^[A-Z]{3}$/.test(x.currency)) { errors.push(`prices[${i}].currency must be a 3-letter code (USD, EUR, SEK)`); return false; }
    if (!isUrl(x.source_url) || !/^https:/.test(x.source_url)) { errors.push(`prices[${i}] has no https source_url (the product page that shows it): dropped`); return false; }
    if (typeof x.retrieved_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(x.retrieved_at)) { errors.push(`prices[${i}].retrieved_at must be the day you read it (YYYY-MM-DD)`); return false; }
    return true;
  });
  if (j.kind === 'city' && prices.length) errors.push('prices are for product files; a hotel price is never typed (only a price check reads it)');
  const unknowns = arr('unknowns').filter((u) => typeof u === 'string' && u.trim());
  // a lane per cluster of stops ("Hualien and Taitung") must say which stop each place belongs to
  if (j.kind === 'city' && isCluster(j.item)) {
    const loose = places.filter((p) => (typeof p.stop !== 'string' || !p.stop.trim()) && !namedCity(j, p)).length;
    if (loose) errors.push(`item "${j.item}" covers several stops, but ${loose} place(s) have no "stop" and name none of them: they are placed at the first one; put "stop": "<City>" on every place and leg`);
  }
  const fatal = errors.some((e) => /^(schema|item missing|kind must)/.test(e));
  if (j.kind === 'city' && j.country !== undefined && (typeof j.country !== 'string' || !j.country.trim())) errors.push('country must be the country\'s name (e.g. "Japan")');
  if (j.kind === 'city' && j.country === undefined) errors.push('no "country": the builder cannot tell this city from places of the same name elsewhere; add "country": "<name>"');
  if (j.kind === 'product' && typeof j.successor === 'string' && j.successor.trim())
    errors.push(`"successor": ${JSON.stringify(j.successor.slice(0, 60))} is newer than the researched model: research the current one (the newest generation) and keep the older one as "previous", or say why the older one fits better in "summary"`);
  return { ok: !fatal, errors, item: { item: j.item, kind: j.kind, country: typeof j.country === 'string' && j.country.trim() ? j.country.trim() : null, summary: typeof j.summary === 'string' ? j.summary : '', facts, places, legs, unknowns,
    prices: j.kind === 'product' ? prices : [], ...(typeof j.model === 'string' ? { model: j.model.slice(0, 80) } : {}), ...(typeof j.successor === 'string' && j.successor.trim() ? { successor: j.successor.slice(0, 80) } : {}),
    ...(typeof j.previous === 'string' && j.previous.trim() ? { previous: j.previous.slice(0, 80) } : {}),
    noSource: arr('facts').filter((f) => typeof f?.text === 'string' && !isUrl(f?.source_url)).map((f) => f.text) } };
}

/** "Hualien and Taitung", "Kaohsiung / Tainan", "Porto, Braga": an item that names several stops. */
export const isCluster = (item) => /\s(and|&)\s|[,/、]|\s\+\s/i.test(String(item || ''));
/** The stops a cluster item names, in order ("Hualien and Taitung" → Hualien, Taitung). */
export const clusterCities = (item) => String(item || '').split(/\s+(?:and|&|\+)\s+|\s*[,/、]\s*/i).map((x) => x.trim()).filter(Boolean);
/** The cluster city a place's own query or name mentions ("Hotel Cham Cham, Taitung" → Taitung), or null. */
const namedCity = (it, x) => {
  const text = `${x?.query || ''} ${x?.name || ''} ${x?.from || ''} ${x?.text || ''}`.toLowerCase();
  return clusterCities(it.item).find((c) => text.includes(c.toLowerCase())) || null;
};
/** The stop a place, leg or fact belongs to: its own "stop", else the item; in a cluster the city its query names,
 *  else the first city. */
export const stopOf = (it, x) => (typeof x?.stop === 'string' && x.stop.trim() ? x.stop.trim()
  : isCluster(it.item) ? namedCity(it, x) || clusterCities(it.item)[0] : it.item);

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const sq = (o) => `'${JSON.stringify(o).replace(/'/g, "'\\''")}'`;

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${m}m`);

const GENERIC = new Set(['hotel', 'hotels', 'hostel', 'inn', 'the', 'and', 'resort', 'city', 'station', 'guesthouse', 'guest', 'house', 'house', 'b&b', 'bnb', 'suites', 'apartment', 'apartments', 'museum', 'park', 'market', 'night', 'temple', 'street', 'old', 'new']);
const norm = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[’'`]/g, "'").replace(/\s+/g, ' ');

/** Does a cited page name this place? A variant of the name (the whole name, the parts in and out of brackets, the
 *  query's first part) appears in the text, or every distinctive word of a Latin variant does (generic words such as
 *  "hotel" and the city's own name do not count). Pure; exported for the tests. */
export function pageNamesPlace(text, { name, query, city }) {
  const page = norm(text);
  const cityWords = new Set(norm(city).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const raw = [name, String(query || '').split(',')[0]];
  const variants = new Set();
  for (const v of raw) {
    const n = norm(v).trim();
    if (!n) continue;
    variants.add(n);
    for (const m of n.matchAll(/\(([^)]+)\)/g)) variants.add(m[1].trim());
    variants.add(n.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
    for (const part of n.split(/\s+\/\s+/)) variants.add(part.trim());
  }
  for (const v of variants) {
    if (!v) continue;
    const cjk = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(v);
    if ((cjk ? v.length >= 2 : v.length >= 4) && page.includes(v)) return true;
    if (!cjk) {
      const words = v.split(/[^\p{L}\p{N}&]+/u).filter((w) => w.length >= 3 && !GENERIC.has(w) && !cityWords.has(w));
      if (words.length && words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(page))) return true;
    }
  }
  return false;
}

/** Does a page's text (or its raw HTML, where a schema.org offer says "price":"150.00") show this amount? 150 matches
 *  "150", "$150.00", "150,00 kr"; 1299 also "1,299" and "1 299". Pure; exported for the tests. */
export function pageShowsPrice(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const int = Math.floor(amount + 1e-9), cents = Math.round((amount - int) * 100);
  const digits = String(int);
  // thousands may be grouped with a comma, dot, space or thin space
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '[,.\\s\u00a0\u202f]?');
  const dec = cents ? `[.,]${String(cents).padStart(2, '0')}` : '(?:[.,]0{1,2})?';
  return new RegExp(`(?<![\\d.,])${grouped}${dec}(?![\\d]|[.,]\\d)`).test(String(text || ''));
}

/** Re-read the pages the handoffs cite (uw cite's rules) and mark places their page does not name and facts whose
 *  page is gone. Unreadable pages (refused, timeouts) are left alone. Mutates the items; returns a summary. */
/** The commands that load the rail track and redraw the legs on it, for when `lines` failed during --apply. */
export function railRetryCommands(site, legArgs) {
  const q = (a) => (/^[\w:.,/@%+=~-]+$/.test(a) ? a : JSON.stringify(a));
  const legs = legArgs.includes('--follow') ? legArgs : [...legArgs, '--follow', 'rail'];
  return [`uw lines ${q(site)} --layer rail --kinds rail,hsr --simplify 80 --timeout 120`, `uw ${legs.map(q).join(' ')}`];
}

/** A cited page as the source check last read it (shared cache, PAGE_CACHE_MS): a continuation turn or a second build
 *  re-reads nothing it read within hours. Only answers are kept (a page, or a gone page), never a refusal or an error. */
const PAGE_CACHE_MS = 6 * 3600e3;
async function cachedPage(fetchPage, url, opts) {
  const hit = readShared('pages', ['handoff-source', url], PAGE_CACHE_MS);
  if (hit) return hit;
  const r = await fetchPage(url, opts);
  if (!r.refused && (r.status < 400 || r.status === 404 || r.status === 410)) {
    writeShared('pages', ['handoff-source', url], { status: r.status, type: r.type || null, text: String(r.text || '').slice(0, 600_000) });
  }
  return r;
}

export async function checkSources(items, { maxPages = 25, concurrency = 6, fetchPage = politeFetch, cache = true } = {}) {
  if (cache) { const raw = fetchPage; fetchPage = (url, opts) => cachedPage(raw, url, opts); }
  const urls = [];
  for (const it of items) {
    for (const p of it.places) if (isUrl(p.source_url) && !urls.includes(p.source_url)) urls.push(p.source_url);
    for (const f of it.facts) if (isUrl(f.source_url) && !urls.includes(f.source_url)) urls.push(f.source_url);
    for (const x of it.prices || []) if (isUrl(x.source_url) && !urls.includes(x.source_url)) urls.push(x.source_url);
  }
  const pages = new Map();
  const todo = urls.slice(0, maxPages);
  let next = 0, stopped = false;
  const worker = async () => {
    while (!stopped && next < todo.length) {
      const url = todo[next++];
      try {
        const r = await fetchPage(url, { timeoutMs: 15000 });
        if (r.refused) pages.set(url, { state: 'unreadable', reason: r.refused });
        else if (r.status === 404 || r.status === 410) pages.set(url, { state: 'gone' });
        else if (r.status >= 400) pages.set(url, { state: 'unreadable', reason: `HTTP ${r.status}` });
        else pages.set(url, { state: 'ok', text: /json/i.test(r.type || '') ? r.text : pageText(r.text).lines.join('\n'), raw: r.text });
      } catch (e) {
        if (isSkip(e)) stopped = true;
        pages.set(url, { state: 'unreadable', reason: e.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  let mismatched = 0, gone = 0, priceMismatched = 0;
  for (const it of items) {
    for (const p of it.places) {
      const pg = pages.get(p.source_url);
      if (pg?.state === 'ok' && !pageNamesPlace(pg.text, { name: p.name, query: p.query, city: stopOf(it, p) })) { p.source_mismatch = true; mismatched++; }
      if (pg?.state === 'gone') { p.source_mismatch = true; mismatched++; }
    }
    for (const f of it.facts) if (pages.get(f.source_url)?.state === 'gone') { f.source_missing = true; gone++; }
    // a price its page does not show (any more) is not carried to the page
    for (const x of it.prices || []) {
      const pg = pages.get(x.source_url);
      if (pg?.state === 'gone' || (pg?.state === 'ok' && !pageShowsPrice(`${pg.text}\n${pg.raw || ''}`, x.amount))) { x.source_mismatch = true; priceMismatched++; }
      else if (pg?.state === 'ok') x.checked = true;
    }
  }
  const unreadable = [...pages.values()].filter((p) => p.state === 'unreadable').length;
  return { pages: urls.length, read: [...pages.values()].filter((p) => p.state === 'ok').length, unreadable, skipped: Math.max(0, urls.length - todo.length), mismatched, gone, prices_mismatched: priceMismatched };
}

/** The itinerary.md steps for usable handoff items. Exported for the tests. */
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'the store'; } };

export function planFromHandoff(items, site = '<site>') {
  const steps = [], dayFacts = [], unverified = [], notes = [], prices = [];
  for (const it of items) {
    if (it.kind === 'city') {
      const cities = isCluster(it.item) ? clusterCities(it.item) : [it.item];
      for (const p of it.places) if (!cities.some((c) => slugify(c) === slugify(stopOf(it, p)))) cities.push(stopOf(it, p));
      for (const city of cities) {
        const stop = slugify(city) || 'stop';
        const here = it.places.filter((p) => slugify(stopOf(it, p)) === stop);
        const st = here.find((p) => p.kind === 'station');
        const country = it.country ? ` --country ${q(it.country)}` : '';
        steps.push(`uw station ${site} --city ${q(city)}${country} --nights <N>${st ? `   # researched: ${st.name} (--pick N if the pick differs)` : ''}`);
        steps.push(`uw stay ${site} --near stations:${stop} --kinds hotel`);
        for (const p of here.filter((x) => x.kind === 'hotel')) {
          const sourced = isUrl(p.source_url) && !p.source_mismatch;
          if (p.source_mismatch) unverified.push(`${city}: ${p.name} (the cited page does not name it)`);
          const props = { stop, researched: true, ...(p.why ? { why: p.why, note: p.why } : {}), ...(sourced ? { source_url: p.source_url } : {}) };
          steps.push(`# researched hotel ${p.name}: if uw stay picked it, give that pick the reason: uw set ${site} stays:<its id> --props ${sq(props)}; else: uw add-point ${site} --layer stays --query ${q(p.query || p.name)} --near <stations:${stop} lng,lat> --id ${stop}-${slugify(p.name) || 'stay'} --props ${sq(props)}`);
        }
        const sights = here.filter((x) => ['sight', 'food', 'store'].includes(x.kind));
        for (const p of sights) {
          if (!isUrl(p.source_url)) { unverified.push(`${city}: ${p.name} (no source)`); continue; }
          if (p.source_mismatch) { unverified.push(`${city}: ${p.name} (the cited page does not name it)`); continue; }
          steps.push(`uw add-point ${site} --layer ${p.kind === 'food' ? 'food' : 'sights'} --query ${q(p.query || p.name)} --near <stations:${stop} lng,lat> --id ${slugify(p.name) || 'sight'} --props ${sq({ stop, source_url: p.source_url, source: new URL(p.source_url).hostname.replace(/^www\./, ''), ...(p.why ? { why: clipWords(p.why, 90) } : {}) })}`);
        }
        if (!sights.length) notes.push(`${city}: no sights researched`);
      }
    }
    for (const l of it.legs) {
      const dur = legDuration(l);
      if (dur && isUrl(l.source_url)) steps.push(`# leg ${l.from} → ${l.to} (${l.mode || 'train'}): ${dur}, source ${l.source_url} → uw legs … --durations "${dur}" --source-url for this leg (a range stays a range)`);
      else unverified.push(`${l.from} → ${l.to}: no sourced duration`);
    }
    for (const f of it.facts) {
      const who = it.kind === 'city' ? stopOf(it, f) : it.item;
      if (f.source_missing) unverified.push(`${who}: ${f.text} (its source page is gone)`);
      else if (f.confidence === 'low') unverified.push(`${who}: ${f.text} (low confidence)`);
      else dayFacts.push({ item: who, text: f.text, source_url: f.source_url });
    }
    if (it.kind === 'product') {
      if (it.successor) unverified.push(`${it.item}: researched ${it.model || 'an older model'}, but ${it.successor} is newer (lead with the newer one or say why not)`);
      for (const x of it.prices || []) {
        const store = x.store || hostOf(x.source_url);
        if (x.source_mismatch) unverified.push(`${it.item}: ${x.amount} ${x.currency} at ${store} (its page does not show that price now)`);
        else prices.push({ item: it.item, ...(it.model ? { model: it.model } : {}), store, amount: x.amount, currency: x.currency, ...(x.kind ? { kind: x.kind } : {}),
          source_url: x.source_url, seen_at: x.retrieved_at.slice(0, 10), checked: !!x.checked });
      }
      if (!(it.prices || []).length) notes.push(`${it.item}: no price from a page (a store that blocks reads gets a "check the price" link)`);
    }
    for (const t of it.noSource) unverified.push(`${it.item}: ${t} (no source)`);
    for (const u of it.unknowns) unverified.push(`${it.item}: ${u}`);
  }
  return { steps, dayFacts, unverified, notes, prices };
}

/** A leg's sourced duration as `uw legs --durations` takes it ("2h–3h", "1h45"), or null. */
export function legDuration(l) {
  const range = Array.isArray(l.duration_min_range) && l.duration_min_range.length === 2 && l.duration_min_range.every(Number.isFinite) && l.duration_min_range[0] <= l.duration_min_range[1]
    ? l.duration_min_range : null;
  return range ? (range[0] === range[1] ? fmtMin(range[0]) : `${fmtMin(range[0])}–${fmtMin(range[1])}`) : Number.isFinite(l.duration_min) ? fmtMin(l.duration_min) : null;
}

/** "Taipei:3,Hualien:2,Taipei:1" → [{ city, id, nights }]. Exported for the tests. */
export function parseRoute(raw) {
  const route = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.+?):(\d{1,2})$/);
    if (!m) throw new UsageError(`--route entry "${x}" must be <City>:<nights>, e.g. Taipei:3`);
    return { city: m[1].trim(), id: slugify(m[1]) || null, nights: Number(m[2]) };
  });
  if (route.length < 2) throw new UsageError('--route needs at least two stops in travel order, e.g. "Porto:3,Lisbon:4"');
  for (const r of route) if (!r.id) throw new UsageError(`--route "${r.city}": use the Latin name of the city (it becomes the stop id)`);
  return route;
}

/** The sourced leg of the handoffs from city a to city b (either direction counts as the same line). */
export function legFor(items, a, b) {
  const same = (x, y) => { const s1 = slugify(x), s2 = slugify(y); return !!s1 && !!s2 && (s1 === s2 || s1.startsWith(`${s2}-`) || s2.startsWith(`${s1}-`)); };
  const legs = items.flatMap((it) => it.legs);
  const sourced = (l) => legDuration(l) && isUrl(l.source_url);
  return legs.find((l) => same(l.from, a) && same(l.to, b) && sourced(l)) || legs.find((l) => same(l.from, b) && same(l.to, a) && sourced(l)) || null;
}

/** Does a stay feature (from uw stay) name the researched hotel? Its name, English name or website. Pure. */
export function stayMatches(props, place, city) {
  const text = [props.name, props.name_en, props.osm_name_en, props.website].filter(Boolean).join(' \n ');
  return pageNamesPlace(text, { name: place.name, query: place.query, city });
}

export async function run(argv) {
  const args = parseArgs(argv, { site: 'string', 'no-source-check': 'bool', apply: 'bool', route: 'string', start: 'string', modes: 'string', kinds: 'string',
    check: 'bool', country: 'string', 'centre-stays': 'string' },
  { positionals: [1, 1], command: 'handoff' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  if (args.check) return checkOne(args._[0], out);
  if (args['centre-stays'] && !['auto', 'always', 'never'].includes(args['centre-stays'])) throw new UsageError('--centre-stays must be auto, always or never');
  if (args.apply) {
    if (!args.site) throw new UsageError('--apply needs --site <site> (create it first with uw new)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start || '')) throw new UsageError('--apply needs --start YYYY-MM-DD (the arrival date)');
    parseRoute(args.route);
  }
  const dir = path.resolve(args._[0]);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { throw new UserError(`no handoff folder at ${args._[0]}`); }
  if (!files.length) throw new UserError(`${args._[0]} has no .json handoff files yet (workers still running? wait for the checkpoint)`);
  const items = [], problems = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { problems.push(`${f}: not valid JSON (${e.message})`); continue; }
    const c = checkHandoff(j);
    for (const e of c.errors) problems.push(`${f}: ${e}`);
    if (c.ok) items.push(c.item);
  }
  if (!items.length) {
    out.result({ ok: false, files: files.length, problems }, [`No usable handoff file in ${args._[0]}:`, ...problems.map((p) => `  ${p}`)]);
    return 1;
  }
  // --apply: the source check runs beside the first steps (stations need no sources); hotels and sights wait for it
  if (args.apply) return applyHandoff({ args, out, items, problems, sourcesCheck: args['no-source-check'] ? Promise.resolve(null) : timedCheckSources(items) });
  const sources = args['no-source-check'] ? null : await checkSources(items);
  const plan = planFromHandoff(items, args.site || '<site>');
  const sourceLine = sourcesLine(sources);
  out.result({ ok: true, files: files.length, items: items.map((i) => ({ item: i.item, kind: i.kind, summary: i.summary })), problems, sources, ...plan }, [
    `${items.length} handoff item(s): ${items.map((i) => `${i.item} (${i.kind})`).join(', ')}`,
    sourceLine,
    problems.length ? `Problems (skipped parts):\n${problems.map((p) => `  ${p}`).join('\n')}` : null,
    'Steps (reference/itinerary.md; coordinates from the commands, never from the handoff). Faster: the same with --apply --route … --start …:',
    ...plan.steps.map((s) => `  ${s}`),
    ...plan.notes.map((n) => `  NOTE ${n}`),
    plan.prices.length ? 'Prices seen on their pages (seed them on the page as "seen <day> at <store>", with the link; a price check refreshes them):' : null,
    ...plan.prices.map((x) => `  ${x.item}${x.model ? ` (${x.model})` : ''}: ${x.amount} ${x.currency}${x.kind ? ` ${x.kind}` : ''} at ${x.store}, seen ${x.seen_at}${x.checked ? ', still on the page' : ''} [${x.source_url}]`),
    plan.dayFacts.length ? 'Facts for day texts (keep the source):' : null,
    ...plan.dayFacts.map((f) => `  ${f.item}: ${f.text} [${f.source_url}]`),
    plan.unverified.length ? 'Unverified (say so in the reply):' : null,
    ...plan.unverified.map((u) => `  ${u}`),
  ]);
  return 0;
}

const sourcesLine = (sources) => (sources ? `Sources re-read: ${sources.read} of ${sources.pages} page(s)${sources.unreadable ? `, ${sources.unreadable} unreadable (not held against the item)` : ''}${sources.skipped ? `, ${sources.skipped} not checked (limit)` : ''}; ${sources.mismatched} place(s) not named on their cited page, ${sources.gone} fact(s) with a gone page${sources.prices_mismatched ? `, ${sources.prices_mismatched} price(s) their page no longer shows` : ''}.` : null);

/** --check: one file against the schema, no network. Exit 1 when it is not usable. */
function checkOne(file, out) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    out.result({ ok: false, file, errors: [e.code === 'ENOENT' ? 'no such file' : `not valid JSON (${e.message})`] }, [`${file}: ${e.code === 'ENOENT' ? 'no such file' : `not valid JSON (${e.message})`}`]);
    return 1;
  }
  const c = checkHandoff(j);
  const it = c.item || {};
  const counts = c.ok ? `${it.places.length} place(s), ${it.facts.length} sourced fact(s), ${it.legs.length} leg(s)${it.kind === 'product' ? `, ${it.prices.length} sourced price(s)` : ''}` : '';
  out.result({ ok: c.ok, file, errors: c.errors, ...(c.ok ? { places: it.places.length, facts: it.facts.length, legs: it.legs.length } : {}) }, [
    c.ok ? `${file}: usable (${counts})${c.errors.length ? '; fix these:' : '.'}` : `${file}: NOT usable; fix these:`,
    ...c.errors.map((e) => `  ${e}`),
  ]);
  return c.ok ? 0 : 1;
}

const UW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uw.mjs');
const shellQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);

/** Run one uw command as its own process (its own time limit and turn budget). Its output (stdout and stderr, in the
 *  order written) is printed as one block when it ends, so steps that run side by side never interleave. Resolves
 *  { code, ms }. */
/** Steps --apply did not start because its time budget was used up (INSTAFY_JOB_DEADLINE). */
const outOfBudget = [];
function uwStep(cmdArgs, log) {
  const started = Date.now();
  if (runOutOfTime()) {
    // the run's budget is used up: the step is not started (exit 4, like any skipped step) and the report says so
    outOfBudget.push(`uw ${cmdArgs.map(shellQuote).join(' ')}`);
    log(`\n$ uw ${cmdArgs.map(shellQuote).join(' ')}\n  skipped: --apply's time budget is used up (not started)`);
    return Promise.resolve({ code: 4, ms: 0 });
  }
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(process.execPath, [UW, ...cmdArgs], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const done = (code) => {
      const ms = Date.now() - started;
      const text = Buffer.concat(chunks).toString('utf8').replace(/\n+$/, '');
      log(`\n$ uw ${cmdArgs.map(shellQuote).join(' ')}${text ? `\n${text}` : ''}\n  (${fmtS(ms)}, exit ${code})`);
      resolve({ code, ms });
    };
    child.on('error', () => done(1));
    child.on('close', (code) => done(code ?? 1));
  });
}
const fmtS = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

/** Run fn over items, at most `limit` at a time; resolves the results in item order. */
export async function inPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

/** A rail track attempt that failed after this long is not tried again within --apply (UW_APPLY_RAIL_RETRY_WITHIN_S). */
const railRetryWithinMs = () => Number(process.env.UW_APPLY_RAIL_RETRY_WITHIN_S ?? 90) * 1000;

/** How many stops --apply works on at once (UW_APPLY_CONCURRENCY, default 3; 1 = one after another). */
export const applyConcurrency = (env = process.env) => Math.max(1, Math.min(8, Math.floor(Number(env.UW_APPLY_CONCURRENCY ?? 3)) || 1));

/** Where step timings go: a background job's own file (uw wait hands it to the turn that sees the job finish), else
 *  the turn's file the host names (INSTAFY_STEP_TIMINGS_FILE), else nowhere. One JSON object per line. */
export function recordTimings(records, env = process.env) {
  const file = env.UW_JOB_TIMINGS || env.INSTAFY_STEP_TIMINGS_FILE;
  if (!file || !records.length) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return true;
  } catch { return false; }
}

/** The source check, timed (its own phase: it runs beside the station steps). */
async function timedCheckSources(items) {
  const t = Date.now();
  const sources = await checkSources(items).catch((e) => { if (isSkip(e)) return null; throw e; });
  return sources && { ...sources, ms: Date.now() - t };
}

const hostName = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/** Is any vertex of a line or multiline within `m` metres of a point? */
function lineNear(geometry, point, m) {
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  return lines.some((l) => l.some((v) => haversine(v, point) <= m));
}

/** Whether the loaded track has a high-speed line near both ends of a leg: true, false, or null when no track layer
 *  is loaded (unknown). Data, not a country rule: where OpenStreetMap maps no high-speed line, there is none to take.
 *  Pure; exported for the tests. */
export function hsrServesBoth(railFC, a, b, withinM = 15000) {
  if (!railFC || !Array.isArray(railFC.features) || !railFC.features.length) return null;
  const hsr = railFC.features.filter((f) => f?.properties?.kind === 'hsr');
  const both = hsr.some((f) => lineNear(f.geometry, a, withinM)) && hsr.some((f) => lineNear(f.geometry, b, withinM));
  // track from the basemap tiles carries no high-speed marks: where it stands in, "no" is unknown
  if (!both && railFC.features.some((f) => f?.properties?.hsr_unknown)) return null;
  return both;
}

/** The country of a stop on the route: the handoff file that covers it says so, else --country. */
export function countryOfStop(items, city, fallback = null) {
  const id = slugify(city);
  const covers = (it) => slugify(it.item) === id || (isCluster(it.item) && clusterCities(it.item).some((c) => slugify(c) === id)) ||
    it.places.some((p) => slugify(stopOf(it, p)) === id);
  return items.find((it) => it.kind === 'city' && it.country && covers(it))?.country || fallback || null;
}

/** --apply: the itinerary steps for these handoffs. Stops are worked on side by side (applyConcurrency), each stop's
 *  own steps in order; the rail track loads in the background once the stations are placed; the lodging around every
 *  stop is asked for in one batched request first. Every step's time is recorded (printed, in --json "timings", and
 *  in the step timings file). */
async function applyHandoff({ args, out, items, problems, sourcesCheck }) {
  openSite(args.site);
  const log = (line) => process.stdout.write(`${line}\n`);
  const t0 = Date.now();
  const timings = [];
  const timed = async (step, phase, fn) => {
    const started = Date.now();
    const r = await fn();
    const code = typeof r === 'number' ? r : r?.code;
    timings.push({ step, phase, start_ms: started - t0, ms: Date.now() - started, ...(code != null ? { exit: code } : {}) });
    return r;
  };
  const conc = applyConcurrency();
  const route = parseRoute(args.route);
  const cities = [];
  for (const r of route) if (!cities.some((c) => c.id === r.id)) cities.push({ ...r, nights: route.filter((x) => x.id === r.id).reduce((a, x) => a + x.nights, 0) });
  for (const c of cities) c.country = countryOfStop(items, c.city, args.country);
  // the route is what the request asked for: kept as the map's "expect" before any lookup can lose a stop
  withSiteLock(openSite(args.site), () => {
    const site = openSite(args.site);
    const cfg = readJSON(site.cfgPath);
    const want = mergeExpect(expectOf(cfg), cities.map((c) => ({ name: c.city, nights: c.nights })));
    if (JSON.stringify(cfg.expect) !== JSON.stringify(want)) { cfg.expect = want; writeJSON(site.cfgPath, cfg, { pretty: true }); }
  });
  const kinds = args.kinds || 'hotel';
  const centreStays = args['centre-stays'] || 'auto';
  // per stop, so the report reads in route order whatever finished first
  const per = new Map(cities.map((c) => [c.id, { ran: [], failed: [], unverified: [], facts: [], retrySights: [] }]));
  const ran = [], failed = [], facts = [];
  let retryRail = null;
  const step = (bucket, label, phase, cmdArgs) => timed(label, phase, () => uwStep(cmdArgs, log)).then(({ code }) => {
    (code === 0 ? bucket.ran : bucket.failed).push(code === 0 ? label : `${label} (exit ${code})`);
    return code;
  });
  const stations = () => { const p = layerPath(openSite(args.site), 'stations'); return exists(p) ? readJSON(p).features : []; };
  const placesFor = (id, kinds) => items.filter((it) => it.kind === 'city').flatMap((it) => it.places.filter((p) => kinds.includes(p.kind) && slugify(stopOf(it, p)) === id).map((p) => ({ it, p })));
  const countryArgs = (c) => (c.country ? ['--country', c.country] : []);
  const noCountry = cities.filter((c) => !c.country).map((c) => c.city);
  if (noCountry.length) facts.push(`no country known for ${noCountry.join(', ')} (handoff "country" or --country): looked up by name alone`);
  const notOnRoute = [];
  for (const it of items.filter((x) => x.kind === 'city')) for (const p of it.places) {
    if (!cities.some((c) => c.id === slugify(stopOf(it, p)))) notOnRoute.push(`${stopOf(it, p)}: ${p.name} (not a stop on the route)`);
  }
  // this process's own lookups (the batched lodging request) get a limit of their own; each step has its own
  setDeadline(Number(process.env.UW_APPLY_NET_S ?? 150) * 1000);

  // 1. stations, side by side (the city centre when no railway station is found, so the stop's stays and sights are
  // still placed)
  const stationArgs = (c) => ['station', args.site, '--city', c.city, ...countryArgs(c), '--id', c.id, '--nights', String(c.nights)];
  const centreArgs = (c) => ['add-point', args.site, '--layer', 'stations', '--query', c.city, ...countryArgs(c), '--id', c.id, '--name', c.city,
    '--kind', 'city', '--allow-far', '--no-fit', '--props', JSON.stringify({ nights: c.nights, station_of: c.city, no_station: true })];
  // the station, else the city centre; `again`: the second try for a stop the first pass could not place
  const placeStop = async (c, again = false) => {
    const b = per.get(c.id);
    const more = again ? ['--timeout', String(Number(process.env.UW_APPLY_STOP_RETRY_S ?? 60))] : [];
    const code = await timed(`station ${c.city}${again ? ' (again)' : ''}`, 'stations', () => uwStep([...stationArgs(c), ...more], log));
    if (code.code === 0) { b.ran.push(`station ${c.city}`); return true; }
    const placed = (await step(b, `centre of ${c.city} (no station found${again ? ', again' : ''})`, 'stations', [...centreArgs(c), ...more])) === 0;
    if (!placed) return false;
    b.unverified.push(`${c.city}: no railway station found; the stop is the city centre (check where its station is)`);
    return true;
  };
  await inPool(cities, conc, (c) => placeStop(c));
  const placedIds = () => new Set(stations().map((f) => f.properties.id));
  let ids = route.map((r) => r.id).filter((id) => placedIds().has(id));

  // 2. the rail track, in the background: it is fetched as map tiles kept in the shared cache, framed on the stations
  let railRun = null;
  const railArgs = ['lines', args.site, '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80'];
  const railTimeout = String(Number(process.env.UW_APPLY_RAIL_TIMEOUT ?? 200));
  if (ids.length >= 2) {
    await timed('fit (stations)', 'rail', () => uwStep(['fit', args.site, '--layers', 'stations'], log));
    railRun = timed('rail track', 'rail', () => uwStep([...railArgs, '--timeout', railTimeout], log));
  }

  // 3. sources checked (they decide which researched places count as sourced), then the lodging around every stop in
  // one request, then each stop's stays, researched hotels and sights, stops side by side
  const sources = await sourcesCheck;
  // the check started with the stations: its own time, from the start
  if (sources?.ms != null) timings.push({ step: `source check, ${sources.pages} page(s)`, phase: 'sources', start_ms: 0, ms: sources.ms, exit: 0 });
  const plan = planFromHandoff(items, args.site);
  const unverified = [...plan.unverified, ...notOnRoute];
  const anchors = [];
  for (const f of stations()) {
    const c = cities.find((x) => x.id === f.properties.id);
    if (!c) continue;
    anchors.push(f.geometry.coordinates);
    const pr = f.properties;
    if ((centreStays === 'always' || (centreStays === 'auto' && pr.centre_km > FAR_FROM_CENTRE_KM && c.nights >= 2)) && Array.isArray(pr.centre_lnglat)) anchors.push(pr.centre_lnglat);
  }
  await timed(`lodging lookup, ${anchors.length} stops in one request`, 'stays', async () => {
    // a busy Overpass answers the stops' own requests no sooner: the one request gets a short limit of its own
    const r = await withCap(Number(process.env.UW_APPLY_BATCH_S ?? 60) * 1000, () => prefetchLodging(anchors));
    if (r.asked) log(`lodging around ${r.asked} stop(s) asked in one request: ${r.answered} answered${r.answered < r.asked ? ` (the rest are asked by each stop${r.unavailable?.reason ? `; the request was not answered: ${r.unavailable.reason}` : ''})` : ''}`);
    return { code: r.answered === r.asked ? 0 : 4 };
  });
  const staysPath = layerPath(openSite(args.site), 'stays');
  const stopPlaces = async (c) => {
    const b = per.get(c.id);
    let st = stations().find((f) => f.properties.id === c.id);
    if (!st) return;
    await step(b, `stays ${c.city}`, 'stays', ['stay', args.site, '--near', `stations:${c.id}`, '--kinds', kinds]);
    const pr = st.properties;
    const far = pr.centre_km > FAR_FROM_CENTRE_KM;
    if (pr.centre_km != null) b.facts.push(`${c.city}: the station is ${pr.centre_km} km from the centre${far ? ' (far)' : ''}`);
    if ((centreStays === 'always' || (centreStays === 'auto' && far && c.nights >= 2)) && Array.isArray(pr.centre_lnglat)) {
      await step(b, `stays in ${c.city}'s centre`, 'stays', ['stay', args.site, '--near', pr.centre_lnglat.join(','), '--near-label', `the centre of ${c.city}`, '--stop', c.id, '--kinds', kinds]);
    }
    // researched hotels: the matching pick takes the researcher's reason and source (and becomes the base); one that
    // no pick matches is placed only by its own name (never on another hotel), else it is listed as unverified
    for (const { p } of placesFor(c.id, ['hotel'])) {
      const sourced = isUrl(p.source_url) && !p.source_mismatch;
      const props = { stop: c.id, researched: true, ...(p.why ? { why: p.why, note: p.why } : {}), ...(sourced ? { source_url: p.source_url, source: hostName(p.source_url) } : {}) };
      // matched and merged under the site's write lock (another stop's step may write the stays at the same moment)
      const merged = withSiteLock(openSite(args.site), () => {
        const fc = exists(staysPath) ? readJSON(staysPath) : { type: 'FeatureCollection', features: [] };
        const hit = fc.features.find((f) => f.properties.stop === c.id && stayMatches(f.properties, p, c.city));
        if (!hit) return { hit: null, hasBase: fc.features.some((f) => f.properties?.stop === c.id) };
        Object.assign(hit.properties, props, !hit.properties.name_en && /\p{Script=Latin}/u.test(p.name) && !/\p{Script=Han}/u.test(p.name) ? { name_en: p.name } : {});
        writeGeoJSON(staysPath, fc);
        return { hit };
      });
      if (merged.hit) {
        log(`researched hotel ${p.name}: matches the pick ${merged.hit.properties.id}; it carries the researcher's reason${sourced ? ' and source' : ''} now`);
        b.ran.push(`researched ${p.name}`);
        continue;
      }
      if (merged.hasBase && geocodeDown()) {
        // the place lookup is down and the stop already has its base: an alternative is not worth minutes of fallback
        b.unverified.push(`${c.city}: ${p.name} (researched, another option; not on the map: the place lookup was unavailable)`);
        continue;
      }
      // the English query first, then the local name in brackets ("Mupinju Space Inn (沐品居太空旅棧)")
      const local = (p.name.match(/\(([^)]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][^)]*)\)/u) || [])[1];
      const queries = [p.query || `${p.name}, ${c.city}`, ...(local ? [local.trim()] : [])];
      let added = false;
      for (const query of queries) {
        const r = await timed(`researched hotel ${p.name}`, 'places', () => uwStep(['add-point', args.site, '--layer', 'stays', '--query', query, '--near', st.geometry.coordinates.join(','), ...countryArgs(c),
          '--id', `${c.id}-${slugify(p.name) || 'stay'}`, '--kind', 'hotel', '--strict-name', '--no-fit', '--props', JSON.stringify(props)], log));
        if (r.code === 0) { added = true; break; }
      }
      if (added) { b.ran.push(`researched ${p.name}`); continue; }
      b.failed.push(`researched ${p.name} (no map hit carries its name)`);
      // the stop already has a base: this hotel was another option, not a gap in the plan, so it stays off the
      // map's "Not found yet" line (r5: eight researched alternatives were listed to the traveller under the title)
      const placed = exists(staysPath) && readJSON(staysPath).features.some((f) => f.properties?.stop === c.id);
      if (placed) forgetMissing(openSite(args.site), { layer: 'stays', id: `${c.id}-${slugify(p.name) || 'stay'}`, name: p.name, query: queries[0] });
      b.unverified.push(`${c.city}: ${p.name} (researched${placed ? ', another option' : ''}, but no map hit carries its name: not placed; check its address)`);
    }
    // sourced sights, each by its own name
    st = stations().find((f) => f.properties.id === c.id);
    const sights = placesFor(c.id, ['sight', 'food', 'store']);
    b.facts.push(`${c.city}: ${c.nights} night(s), ${sights.length} researched sight(s)`);
    for (const { p } of sights) {
      if (!isUrl(p.source_url) || p.source_mismatch) continue; // already on the unverified list
      // food goes on its own layer ("Eat: …" in the day text); the researcher's reason rides along for the day text
      const layer = p.kind === 'food' ? 'food' : 'sights';
      const why = typeof p.why === 'string' && p.why.trim() ? { why: clipWords(p.why, 90) } : {};
      const addArgs = ['add-point', args.site, '--layer', layer, '--query', p.query || `${p.name}, ${c.city}`, '--near', st.geometry.coordinates.join(','),
        ...countryArgs(c), '--strict-name', '--no-fit', '--id', slugify(p.name) || `${c.id}-sight`, '--props', JSON.stringify({ stop: c.id, source_url: p.source_url, source: hostName(p.source_url), ...why })];
      // the place lookup is down: list the sight with its exact command for later instead of a slow fallback per place
      const code = geocodeDown() ? 4 : await step(b, `${p.kind === 'food' ? 'food' : 'sight'} ${p.name}`, 'places', addArgs);
      if (code === 4) {
        // the place lookup was down, not the name wrong: the exact command, for when it is back (r5: 14 researched
        // sights were lost to a place-search outage and every full day shipped empty)
        b.retrySights.push(`uw ${addArgs.map((a) => (/^[\w:.,/@%+=~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ')}`);
        b.unverified.push(`${c.city}: ${p.name} (sourced, not on the map yet: the place lookup was unavailable)`);
      } else if (code !== 0) b.unverified.push(`${c.city}: ${p.name} (sourced, but no map hit carries its name: not placed)`);
    }
  };
  await inPool(cities, conc, stopPlaces);
  // 3b. a stop the request named that the first pass could not place: once more, now that the services had a few
  // minutes (r10: every Taiwan run lost the same two stops to one slow minute), then its stays and sights
  const unplaced = cities.filter((c) => !placedIds().has(c.id));
  if (unplaced.length) {
    log(`\n${unplaced.length} requested stop(s) not on the map yet (${unplaced.map((c) => c.city).join(', ')}): trying once more.`);
    await inPool(unplaced, conc, async (c) => { if (await placeStop(c, true)) await stopPlaces(c); });
  }
  const missingStops = cities.filter((c) => !placedIds().has(c.id));
  for (const c of missingStops) per.get(c.id).unverified.push(`${c.city}: not on the map (neither its station nor the city was found${c.country ? ` in ${c.country}` : ''}; the place lookups were unavailable or slow)`);
  for (const c of cities) {
    const b = per.get(c.id);
    ran.push(...b.ran); failed.push(...b.failed); unverified.push(...b.unverified); facts.push(...b.facts);
  }
  const retrySights = cities.flatMap((c) => per.get(c.id).retrySights);

  // 4. the track (waited for now; once more for the tiles still missing when it failed), legs with the sourced
  // durations, the question and the plan (every stop placed by now, late ones included)
  ids = route.map((r) => r.id).filter((id) => placedIds().has(id));
  if (ids.length >= 2) {
    const rail = railRun ? await railRun : null;
    let linesOk = rail?.code === 0;
    // once more for the tiles still missing, only after a quick failure: a track that already waited minutes on a
    // busy Overpass would wait again (the retry commands go to the report instead)
    if (!linesOk && (!rail || rail.ms < railRetryWithinMs())) {
      const again = String(Number(process.env.UW_APPLY_RAIL_RETRY_TIMEOUT ?? 120));
      linesOk = (await timed('rail track (again, missing tiles only)', 'rail', () => uwStep([...railArgs, '--timeout', again], log))).code === 0;
    }
    (linesOk ? ran : failed).push(linesOk ? 'rail track' : 'rail track (Overpass busy; legs drawn straight)');
    await timed('fit', 'plan', () => uwStep(['fit', args.site], log)).then(({ code }) => (code === 0 ? ran : failed).push(code === 0 ? 'fit' : `fit (exit ${code})`));
    const railPath = layerPath(openSite(args.site), 'rail');
    const railFC = linesOk && exists(railPath) ? readJSON(railPath) : null;
    const railPartial = railFC?.uw?.partial || null;
    if (railPartial) facts.push(`rail track: ${railPartial.reason}`);
    const n = ids.length - 1;
    const durs = [], urls = [], srcs = [], legFacts = [];
    for (let i = 0; i < n; i++) {
      const a = route.find((r) => r.id === ids[i]).city, b = route.find((r) => r.id === ids[i + 1]).city;
      const l = legFor(items, a, b);
      const https = l && /^https:\/\//.test(l.source_url);
      durs.push(https ? legDuration(l) : '');
      urls.push(https ? l.source_url : '');
      srcs.push(https ? hostName(l.source_url) : null);
      const ca = stations().find((f) => f.properties.id === ids[i]), cb = stations().find((f) => f.properties.id === ids[i + 1]);
      if (!ca || !cb) continue;
      const km = Math.round(haversine(ca.geometry.coordinates, cb.geometry.coordinates) / 1000);
      const hsr = hsrServesBoth(railFC, ca.geometry.coordinates, cb.geometry.coordinates);
      legFacts[i] = facts.length;
      facts.push(`${a} → ${b}: ${km} km straight line; duration ${https ? `${legDuration(l)} (${hostName(l.source_url)})` : 'not sourced'}; high-speed line near both ends: ${hsr === null ? (railFC ? 'unknown (the track has no high-speed marks: check the operator)' : 'unknown (no track loaded)') : hsr ? 'yes' : 'no'}`);
    }
    const modes = args.modes || 'train';
    const legArgs = ['legs', args.site, '--layer', 'trip', '--stops', ids.map((id) => `stations:${id}`).join(','), '--modes', modes, ...(linesOk ? ['--follow', 'rail'] : [])];
    if (durs.some(Boolean)) legArgs.push('--durations', durs.join(','), '--source', 'research', '--source-url', urls.join(','));
    if (durs.some(Boolean) && args['no-source-check']) legArgs.push('--no-source-check');
    const legsBucket = { ran, failed };
    if (await step(legsBucket, 'legs', 'plan', legArgs) === 0 && durs.some(Boolean)) {
      // one source name per leg: the page each duration came from
      const tripPath = layerPath(openSite(args.site), 'trip');
      withSiteLock(openSite(args.site), () => {
        const fc = readJSON(tripPath);
        for (const f of fc.features) {
          const i = (f.properties.order || 0) - 1;
          if (srcs[i] && f.properties.duration_source) f.properties.duration_source = srcs[i];
          // legs dropped a duration its page does not state: the fact and the page say so
          if (durs[i] && f.properties.duration_note && legFacts[i] != null) {
            facts[legFacts[i]] = facts[legFacts[i]].replace(/duration [^;]*;/, `duration not stated on its page (${durs[i]} dropped; the card links the page);`);
            unverified.push(`${f.properties.name}: travel time (its page does not state ${durs[i]})`);
          }
        }
        writeGeoJSON(tripPath, fc);
      });
    }
    if (!linesOk || railPartial) {
      // the legs are straight arcs over whatever lies between: the exact commands that put them on the track
      retryRail = railRetryCommands(args.site, legArgs);
      if (!linesOk) facts.push(`legs: ${n} of ${n} drawn as straight arcs (the rail track did not load); each leg's card says "Drawn straight"`);
    }
    await step(legsBucket, 'question', 'plan', ['question', args.site, '--kind', 'plan-route', '--options', 'stations', '--force']);
    const have = placedIds();
    const nights = route.filter((r) => have.has(r.id)).map((r) => String(r.nights));
    const placeLayers = ['sights', 'food'].filter((l) => exists(layerPath(openSite(args.site), l)));
    await step(legsBucket, 'plan', 'plan', ['plan', args.site, '--stops', 'stations', '--ids', ids.join(','), '--nights', nights.join(','), '--start', args.start, '--legs', 'trip', '--stays', 'stays',
      ...(placeLayers.length ? ['--sights', placeLayers.join(',')] : []), '--force']);
  } else failed.push('legs and plan (fewer than two stops on the map)');

  const totalMs = Date.now() - t0;
  const phases = {};
  for (const t of timings) {
    const ph = phases[t.phase] || (phases[t.phase] = { from: t.start_ms, to: t.start_ms + t.ms, steps: 0 });
    ph.from = Math.min(ph.from, t.start_ms); ph.to = Math.max(ph.to, t.start_ms + t.ms); ph.steps++;
  }
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  recordTimings(timings.map((t) => ({ tool: 'uw', command: 'handoff --apply', ...t })).concat([{ tool: 'uw', command: 'handoff --apply', step: 'total', phase: 'total', start_ms: 0, ms: totalMs, concurrency: conc }]));
  const timingLine = `Timings: ${fmtS(totalMs)} in all, ${conc} stop(s) at a time; ${Object.entries(phases).map(([k, v]) => `${k} ${fmtS(v.to - v.from)} (${v.steps})`).join(', ')}. Slowest: ${slowest.map((t) => `${t.step} ${fmtS(t.ms)}`).join('; ')}.`;
  const sourceLine = sourcesLine(sources);
  // the request's stops the map leaves out: said first and last, never only in the unverified list
  const askedNights = route.reduce((a, r) => a + r.nights, 0);
  const coveredNights = route.filter((r) => !missingStops.some((c) => c.id === r.id)).reduce((a, r) => a + r.nights, 0);
  const missingItems = missingStops.map((c) => ({ name: c.city, nights: c.nights }));
  const missingBlock = missingStops.length ? [
    `REQUESTED BUT NOT ON THE MAP: ${describeItems(missingItems)}. The plan covers ${coveredNights} of the ${askedNights} nights asked for; the map's "Not found yet" line names them.`,
    'Place them before replying when the turn clock allows (then uw plan … --force with every stop), else say plainly in the reply which stops are missing and that the plan is short of those nights:',
    ...missingStops.map((c) => `  uw ${[...stationArgs(c), '--timeout', '120'].map(shellQuote).join(' ')}`),
  ] : [];
  out.result({ ok: failed.length === 0 && !missingStops.length, ...(outOfBudget.length ? { status: 'partial', not_started: outOfBudget } : {}), ran, failed, problems, facts, ...plan, unverified,
    ...(missingStops.length ? { missing_stops: missingItems, nights: { asked: askedNights, covered: coveredNights } } : {}), ...(retryRail ? { retry_rail: retryRail } : {}), ...(retrySights.length ? { retry_sights: retrySights } : {}),
    timings: { total_ms: totalMs, concurrency: conc, phases, steps: timings } }, [
    '',
    ...(missingBlock.length ? [missingBlock[0]] : []),
    `handoff --apply: ${ran.length} step(s) done${failed.length ? `, ${failed.length} not: ${failed.join('; ')}` : ''}.`,
    outOfBudget.length ? partialLine('handoff --apply', `${outOfBudget.length} step(s) not started: the run's time budget (${applyBudgetS()} s) was used up`,
      `say so in the reply; run them in the next turn:\n${outOfBudget.map((c) => `  ${c}`).join('\n')}`) : null,
    timingLine,
    sourceLine,
    problems.length ? `Problems in the handoff files:\n${problems.map((p) => `  ${p}`).join('\n')}` : null,
    facts.length ? 'Facts per stop and leg (reference/itinerary.md says what to do with them):' : null,
    ...facts.map((f) => `  ${f}`),
    'Next: the plan\'s day texts name each full day\'s sourced places; reword them with these facts where they fit (≤ 140 characters, keep the items), fill days still "Day in …" with sourced places, then uw validate --signal and the preview card:',
    ...plan.dayFacts.map((f) => `  ${f.item}: ${f.text} [${f.source_url}]`),
    'In the reply and your summary: no file or folder names (the handoff or site folders), commands or layer ids.',
    retryRail ? 'Rail track not loaded, so the legs are straight arcs. Run these now if the turn clock allows, else as the next turn\'s first step (then uw plan … --force and re-add the day texts):' : null,
    ...(retryRail || []).map((c) => `  ${c}`),
    retrySights.length ? `${retrySights.length} sourced sight(s) are not on the map because the place lookup was unavailable. Wait a minute and run these, then uw plan … --force (before replying when the turn clock allows); a sight still not placed goes into its day's text with its source link, so no full day ships empty:` : null,
    ...retrySights.map((c) => `  ${c}`),
    unverified.length ? 'Unverified (say so in the reply):' : null,
    ...unverified.map((u) => `  ${u}`),
    ...(missingBlock.length ? ['', ...missingBlock] : []),
  ]);
  return failed.some((f) => /^(plan|legs and plan)/.test(f)) ? 1 : missingStops.length ? 3 : 0;
}
