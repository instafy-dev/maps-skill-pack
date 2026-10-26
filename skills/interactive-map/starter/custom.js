// custom.js — optional escape hatch for interactions the config can't express.
// The engine imports this file (config "custom": "custom.js") after the map and layers are ready
// and calls the default export with the `uw` API. Keep it small; prefer map.config.json when possible.
//
// uw.map                      the MapLibre map (anything goes: map.on(...), map.setPaintProperty(...))
// uw.config                   the parsed map.config.json
// uw.on(evt, fn)              events: ready, select, clear, pick, nope, pin, time, vibe, layer, day
// uw.select(layer, id) · uw.clearSelection() · uw.flyTo(target) · uw.setTime(h) · uw.setVibe(v)
// uw.setLayerVisible(id, on) · uw.addLayer(def) · uw.getFeatures(layer) · uw.random(layer)
// uw.ui.toast(text) · uw.ui.addButton({ id, label, title, onClick }) · uw.ui.openSheet('places'|'plan'|'layers'|'compare'|'card')
//
// v0.2 (question, verdict, binding to an agent):
// uw.question                 the resolved question (kind, lens, weights, lettered options) or null
// uw.rank()                   [{ ref, letter, score, g: { key: goodness } }] in rank order
// uw.setLens(id|null) · uw.setWeights({ key: 0..3 })
// uw.intent(name, params?, { ref, ui })   emit a declared intent (bound.json / config "intents"); resolves to its id
// uw.ingest(msg)              feed a host message ({ type: 'results' | 'progress' | 'done' | 'command', … }) like postMessage
// uw.records(ref?) · uw.pending() · uw.links(layer, id) · uw.signal()
// more events: lens, weights, intent, ack, results, done, error, link, photo, verdict
//
// Example (uncomment to try):
//   uw.on('select', ({ layer, id, feature }) => console.log('selected', layer, id, feature.properties.name));
//   uw.ui.addButton({ id: 'surprise', label: '🎲', title: 'Surprise me', onClick: () => uw.select('cafes', uw.random('cafes')) });

export default function setup(uw) {
  // Your custom interactions go here.
}
