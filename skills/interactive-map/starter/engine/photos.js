// map-pack engine: doorstep / street photos (ENGINE-SPEC-v0.2 §7.3). Kit-owned file.
// Card thumbnail with date · distance · 360° overlay and a credit that is always visible, the Compare "Doorstep"
// row, and a full-screen viewer (360° photos in our WebGL viewer or a vendored pannellum; flat photos pinch-zoom).
// Photo data comes from data/photos.json (written by `uw photos`). Never shows a farther or older photo silently.
import { h, fmtMonth, safeUrl } from './util.js';
import { createPano } from './pano.js';

const ENGINE_BASE = new URL('./', import.meta.url).href;

export class Photos {
  constructor(E, json, cfg = {}) {
    this.E = E;
    this.cfg = cfg;
    this.items = json && typeof json.items === 'object' ? json.items : {};
    this.radius = Number(json?.radius_m) || Number(json?.uw?.args?.radius) || 40;
    this.attribution = typeof json?.attribution === 'string' ? json.attribution : 'Street photos: Panoramax contributors (CC BY-SA 4.0)';
    this.layers = Array.isArray(cfg.layers) ? cfg.layers : null;
    this.viewer = null;
  }
  covers(layer) { return !this.layers || this.layers.includes(layer); }
  entry(ref) { const e = this.items[ref]; return e && typeof e === 'object' ? e : null; }
  photo(ref) { const e = this.entry(ref); return e?.status === 'found' && e.photo && safeUrl(e.photo.thumb_url) ? e.photo : null; }
  overlayText(p) {
    const bits = [];
    const when = fmtMonth(p.captured_at); if (when) bits.push((p.night ? '🌙 ' : '') + when);
    if (Number.isFinite(p.distance_m)) bits.push(`${Math.round(p.distance_m)} m`);
    if (p.is_360) bits.push('◐ 360°');
    let s = bits.join(' · ');
    if (p.facing === false) s += ' · facing away';
    return s;
  }
  credit(p, cls = 'uw-photo-credit') {
    const el = h('p.' + cls);
    const lic = typeof p.licence === 'string' ? p.licence : 'CC BY-SA 4.0';
    const text = `© ${typeof p.author === 'string' && p.author ? p.author : 'Panoramax contributor'} · ${lic} · Panoramax`;
    const url = safeUrl(p.viewer_url);
    if (url) { const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text); a.addEventListener('click', () => this.E.emit('link', { kind: 'panoramax', url, ...this.cur })); el.append(a); }
    else el.textContent = text;
    return el;
  }
  /** Card block: thumbnail (16:9) + overlay + credit, or the honest "No street photo within 40 m" box. */
  card(item, links = []) {
    const e = this.entry(item.ref);
    if (!e) return null;
    const p = this.photo(item.ref);
    if (p) {
      const img = h('img.uw-photo-img', { src: safeUrl(p.thumb_url), alt: `Street photo near ${item.name || 'this place'}`, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      const btn = h('button.uw-photo', { type: 'button', 'aria-label': `Open the street photo near ${item.name || 'this place'}${p.is_360 ? ' (360°)' : ''}` },
        img, h('span.uw-photo-over', this.overlayText(p)), p.is_360 ? h('span.uw-photo-360', { 'aria-hidden': 'true' }, '360°') : null);
      btn.addEventListener('click', () => this.open(item, p));
      img.addEventListener('error', () => { btn.classList.add('is-broken'); img.remove(); });
      return h('figure.uw-photo-fig', btn, this.credit(p));
    }
    // one honest row, not a 16:9 placeholder: "📷 No street photo within 40 m (nearest 106 m) · Street View ↗"
    const r = Number(e.searched?.radius_m) || this.radius;
    const why = e.rejected_reason ? ` (${String(e.rejected_reason).slice(0, 60)})` : Number.isFinite(e.nearest_m) ? ` (nearest ${Math.round(e.nearest_m)} m)` : '';
    const row = h('div.uw-photo-none', h('span.uw-photo-none-e', { 'aria-hidden': 'true' }, '📷'), h('span.uw-photo-none-t', `No street photo within ${r} m${why}`));
    const sv = links.find((l) => l.kind === 'streetview');
    if (sv) {
      const a = h('a.uw-photo-none-a', { href: sv.url, target: '_blank', rel: 'noopener noreferrer' }, sv.label);
      a.addEventListener('click', () => this.E.emit('link', { layer: item.layer, id: item.id, kind: sv.kind, url: sv.url }));
      row.append(a);
    }
    return h('div.uw-photo-fig.is-none', row);
  }
  /** Compare "Doorstep" cell (4:3) */
  cell(item) {
    const e = this.entry(item.ref), p = this.photo(item.ref);
    if (p) {
      const b = h('button.uw-cmp-photo', { type: 'button', 'aria-label': `Street photo near ${item.name}` },
        h('img', { src: safeUrl(p.thumb_url), alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }),
        h('span.uw-cmp-photo-over', [fmtMonth(p.captured_at), Number.isFinite(p.distance_m) ? `${Math.round(p.distance_m)} m` : null].filter(Boolean).join(' · ')));
      b.addEventListener('click', () => this.open(item, p));
      return b;
    }
    if (!e) return h('span.uw-cmp-na', '—');
    return h('span.uw-cmp-nophoto', `No street photo within ${Number(e.searched?.radius_m) || this.radius} m`);
  }
  hasAny(refs) { return refs.some((r) => this.entry(r)); }

  // ----- full-screen viewer -----
  async open(item, p) {
    this.close(true);
    const E = this.E;
    this.cur = { layer: item.layer, id: item.id, photo_id: p.id };
    const stage = h('div.uw-viewer-stage');
    const closeBtn = h('button.uw-viewer-close', { type: 'button', 'aria-label': 'Close photo' }, h('span', { 'aria-hidden': 'true' }, '✕'));
    const title = h('div.uw-viewer-title', h('b', item.name || 'Street photo'), h('span', this.overlayText(p)));
    const door = p.is_360 ? h('button.uw-viewer-door', { type: 'button' }, '🚪 Look at the door') : null;
    const open = safeUrl(p.viewer_url) ? h('a.uw-viewer-open', { href: safeUrl(p.viewer_url), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Panoramax ↗') : null;
    const bar = h('div.uw-viewer-bar', this.credit(p, 'uw-viewer-credit'), open);
    const status = h('div.uw-viewer-status', { role: 'status' }, 'Loading photo…');
    const el = h('div.uw-viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `Street photo near ${item.name || ''}` }, stage, status, h('div.uw-viewer-top', title, closeBtn), door, bar);
    E.ui.root.append(el);
    const v = this.viewer = { el, item, p, pano: null, onKey: null };
    closeBtn.addEventListener('click', () => this.close());
    v.onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } };
    document.addEventListener('keydown', v.onKey, true);
    try { history.pushState({ uwViewer: 1 }, ''); v.pushed = true; } catch { /* sandboxed */ }
    v.onPop = () => { v.pushed = false; this.close(true); };
    window.addEventListener('popstate', v.onPop);
    requestAnimationFrame(() => el.classList.add('is-in'));
    closeBtn.focus({ preventScroll: true });
    E.emit('photo', { layer: item.layer, id: item.id, photo_id: p.id, action: 'open' });
    const sd = safeUrl(p.sd_url) || safeUrl(p.thumb_url);
    const yaw = Number.isFinite(p.yaw_to_item) ? p.yaw_to_item : 0;
    const loaded = () => { status.hidden = true; el.classList.add('is-loaded'); };
    const failed = (e) => { status.hidden = false; status.textContent = 'The photo did not load. Open it in Panoramax instead.'; console.warn('[map] photo viewer:', e?.message || e); };
    if (p.is_360) {
      const want = this.cfg.viewer;
      if (want === 'link') { this.close(); if (open) window.open(open.href, '_blank', 'noopener'); return; }
      if (want === 'pannellum' && await this.loadPannellum()) {
        try {
          const div = h('div.uw-pano-pannellum'); stage.append(div);
          v.pnl = window.pannellum.viewer(div, { type: 'equirectangular', panorama: sd, yaw, hfov: 90, autoLoad: true, showControls: false, compass: false, crossOrigin: 'anonymous' });
          v.pnl.on?.('load', loaded); v.pnl.on?.('error', failed);
          door?.addEventListener('click', () => v.pnl.lookAt(0, yaw, 90, 600));
          return;
        } catch (e) { console.warn('[map] pannellum failed, using the built-in viewer:', e.message); stage.innerHTML = ''; }
      }
      v.pano = createPano(stage, { src: sd, yaw, hfov: 90, onLoad: loaded, onError: failed });
      door?.addEventListener('click', () => v.pano.lookAt(yaw, 0));
    } else {
      const img = h('img.uw-viewer-img', { src: sd, alt: `Street photo near ${item.name || ''}`, referrerpolicy: 'no-referrer', decoding: 'async' });
      img.addEventListener('load', loaded); img.addEventListener('error', failed);
      stage.append(img);
    }
  }
  loadPannellum() {
    if (window.pannellum) return Promise.resolve(true);
    if (this.pnlP) return this.pnlP;
    this.pnlP = new Promise((res) => {
      const css = h('link', { rel: 'stylesheet', href: ENGINE_BASE + 'vendor/pannellum/pannellum.css' });
      const s = h('script', { src: ENGINE_BASE + 'vendor/pannellum/pannellum.js', async: true });
      s.onload = () => res(!!window.pannellum); s.onerror = () => { css.remove(); res(false); };
      document.head.append(css, s);
    });
    return this.pnlP;
  }
  close(silent) {
    const v = this.viewer; if (!v) return;
    this.viewer = null;
    document.removeEventListener('keydown', v.onKey, true);
    window.removeEventListener('popstate', v.onPop);
    try { v.pano?.destroy(); v.pnl?.destroy?.(); } catch { /* */ }
    v.el.remove();
    if (v.pushed) { try { history.back(); } catch { /* */ } }
    this.E.emit('photo', { layer: v.item.layer, id: v.item.id, photo_id: v.p.id, action: 'close' });
    if (!silent) this.E.ui.root.querySelector('.uw-photo')?.focus({ preventScroll: true });
  }
}
