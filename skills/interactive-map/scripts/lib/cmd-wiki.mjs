// `wiki`: Wikipedia geosearch + short extracts → points.
import { parseArgs, makeOut, parseLngLat, round6, haversine, sleep, UsageError } from './util.mjs';
import { fetchJSON } from './net.mjs';
import { openSite, checkLayerId, writeOwnedLayer, assertOwned, layerHint, registerLayer, viewCenter, resolvePoint, loadLayer } from './site.mjs';

export const help = `wiki <dir> --layer <id> --near <lng,lat | layer:id> [--radius 1000] [--lang en] [--limit 30] [--exclude regex] [--append] [--force] [--json]
  Wikipedia geosearch (max radius 10000 m) + 2-sentence intro extracts → points with id wiki-<pageid>, name, url,
  note (extract), image (thumbnail) with image_credit (author · licence) and image_page, distance_m.
  Leaves out list articles ("List of …"), disambiguation pages and (by default) schools, embassies and similar noise;
  --exclude adds your own title regex (e.g. "station|MRT"). --append adds to the layer's file (one call per town).
  Text is CC BY-SA and each image has its own licence: keep the "Wikipedia" attribution and the image credits.`;
const NOISE = /^(list of|lists of|outline of|index of|timeline of)\b|\(disambiguation\)|\b(embassy|consulate|ambassadors?|elementary school|junior high|senior high|high school|primary school|kindergarten|police station|fire station|district office|household registration|post office|research institute)\b/i;

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', near: 'string', radius: 'number', lang: 'string', limit: 'number', force: 'bool', exclude: 'string', append: 'bool' },
    { positionals: [1, 1], command: 'wiki' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'wiki', args.force || args.append);
  let excl = null;
  if (args.exclude) { try { excl = new RegExp(args.exclude, 'i'); } catch (e) { throw new UsageError(`--exclude is not a valid regex: ${e.message}`); } }
  // --near takes lng,lat or a feature ref (hotels:regent)
  const near = args.near ? resolvePoint(site, args.near, 'near').coord : viewCenter(site);
  if (!near) throw new UsageError('give --near lng,lat');
  if (!args.near) out.log(`(no --near: using view.center ${near.join(',')})`);
  const radius = Math.round(args.radius ?? 1000);
  if (radius < 10 || radius > 10000) throw new UsageError('--radius must be 10-10000 m (Wikipedia geosearch limit)');
  const lang = (args.lang || 'en').toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]+)?$/.test(lang)) throw new UsageError(`--lang "${args.lang}" is not a Wikipedia language code (e.g. en, zh, ja)`);
  const limit = Math.max(1, Math.min(100, args.limit ?? 30));
  const api = `https://${lang}.wikipedia.org/w/api.php`;

  const gs = new URL(api);
  Object.entries({ action: 'query', list: 'geosearch', gscoord: `${near[1]}|${near[0]}`, gsradius: radius, gslimit: limit, gsnamespace: 0, format: 'json', formatversion: 2 })
    .forEach(([k, v]) => gs.searchParams.set(k, String(v)));
  out.log(`Searching ${lang}.wikipedia.org within ${radius} m…`);
  const g = await fetchJSON(gs.toString(), { label: 'Wikipedia', timeoutMs: 20000 }).catch((e) => {
    if (/cannot resolve host/.test(e.message)) throw new UsageError(`${lang}.wikipedia.org cannot be reached; is --lang "${lang}" a real Wikipedia language? (${e.message})`);
    throw e;
  });
  if (g.error) throw new UsageError(`Wikipedia: ${g.error.info || g.error.code}`);
  const all = g.query?.geosearch || [];
  const hits = all.filter((h) => !NOISE.test(h.title) && !(excl && excl.test(h.title)));
  const pages = new Map();
  for (let i = 0; i < hits.length; i += 20) {
    if (i) await sleep(200);
    const ids = hits.slice(i, i + 20).map((h) => h.pageid);
    const u = new URL(api);
    Object.entries({ action: 'query', prop: 'extracts|info|pageimages|pageprops', exintro: 1, explaintext: 1, exsentences: 2, exlimit: 20, inprop: 'url',
      piprop: 'thumbnail|name', pithumbsize: 320, pilimit: 20, ppprop: 'disambiguation', pageids: ids.join('|'), format: 'json', formatversion: 2, redirects: 1 })
      .forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const d = await fetchJSON(u.toString(), { label: 'Wikipedia', timeoutMs: 20000 });
    for (const p of d.query?.pages || []) pages.set(p.pageid, p);
  }
  // image author + licence from Commons (each thumbnail has its own licence; CC BY-SA for the text does not cover it)
  const files = [...new Set([...pages.values()].map((p) => p.pageimage).filter(Boolean))];
  const credits = new Map();
  for (let i = 0; i < files.length; i += 40) {
    await sleep(200);
    const u = new URL('https://commons.wikimedia.org/w/api.php');
    Object.entries({ action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url', iiextmetadatafilter: 'Artist|LicenseShortName|UsageTerms',
      titles: files.slice(i, i + 40).map((f) => 'File:' + f).join('|'), format: 'json', formatversion: 2 }).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    try {
      const d = await fetchJSON(u.toString(), { label: 'Wikimedia Commons', timeoutMs: 20000 });
      for (const p of d.query?.pages || []) {
        const m = p.imageinfo?.[0]?.extmetadata || {};
        const strip = (x) => String(x || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const name = (p.title || '').replace(/^File:/, '').replace(/ /g, '_');
        credits.set(name, { artist: strip(m.Artist?.value).slice(0, 80), license: strip(m.LicenseShortName?.value), page: p.imageinfo?.[0]?.descriptionurl });
      }
    } catch { /* no credits → no image (below) */ }
  }
  const features = hits.filter((h) => !pages.get(h.pageid)?.pageprops?.disambiguation && !(pages.get(h.pageid)?.extract || '').match(/^\S.{0,80} (may refer to|can refer to)/)).map((h) => {
    const p = pages.get(h.pageid) || {};
    const props = { id: `wiki-${h.pageid}`, name: h.title, kind: 'wiki', emoji: '📖' };
    const ex = (p.extract || '').replace(/\s+/g, ' ').trim();
    if (ex) props.note = ex.length > 320 ? ex.slice(0, 317).replace(/\s+\S*$/, '') + '…' : ex;
    props.url = p.fullurl || `https://${lang}.wikipedia.org/?curid=${h.pageid}`;
    const cr = p.pageimage ? credits.get(p.pageimage.replace(/ /g, '_')) : null;
    // an image is shown only with its author and licence
    if (p.thumbnail?.source && cr && cr.license) {
      props.image = p.thumbnail.source.split('?')[0];
      props.image_credit = `Photo: ${cr.artist || 'Wikimedia Commons'} · ${cr.license}`;
      if (cr.page) props.image_page = cr.page;
    }
    props.distance_m = Math.round(h.dist ?? haversine(near, [h.lon, h.lat]));
    props.source = `Wikipedia (${lang}), CC BY-SA`;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [round6(h.lon), round6(h.lat)] }, properties: props };
  });
  if (!features.length) out.warn('no geotagged articles found here; try a larger --radius or another --lang (e.g. zh, ja).');
  let allF = features;
  if (args.append) {
    const prev = loadLayer(site, layer, { required: false });
    if (prev) { const ids = new Set(features.map((f) => f.properties.id)); allF = prev.features.filter((f) => !ids.has(f?.properties?.id)).concat(features); }
  }
  const w = writeOwnedLayer(site, layer, { type: 'FeatureCollection', attribution: `Text: <a href="https://${lang}.wikipedia.org/" target="_blank" rel="noopener">Wikipedia</a> contributors, CC BY-SA 4.0 · photos: Wikimedia Commons (credits on each card)`, features: allF },
    { cmd: 'wiki', args: { near: near.join(','), radius, lang, ...(args.append ? { appended: true } : {}) }, force: args.force || args.append, out });
  const hint = layerHint(site, layer, 'points', { style: { emoji: '📖', size: 's' }, card: { body: '{note}' } });
  const registered = registerLayer(site, hint);
  out.result({ ok: true, layer, file: w.rel, count: features.length, titles: features.map((f) => f.properties.name), registered_layer: registered ? hint : null }, [
    `Wrote ${features.length} Wikipedia places to ${w.rel}${allF.length > features.length ? ` (${allF.length} in the file)` : ''}${features.length ? ': ' + features.slice(0, 6).map((f) => f.properties.name).join(' · ') : ''}`,
    all.length > hits.length ? `Left out ${all.length - hits.length} list / school / embassy-type articles.` : null,
    registered,
  ]);
}
