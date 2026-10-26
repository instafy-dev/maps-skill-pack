// map-pack engine: DOM chrome — bottom sheet / side panel, header controls, tabs, cards, buttons, toasts.
// Kit-owned file: sites should not edit it.
import { h, clamp, fill, fmtHour, fmtMetric, fmtDate, humanize, timeIcon, distM, isIOS, round6, reducedMotion, BASIS, LETTER_COLORS, safeUrl, word } from './util.js';
import { BASIS_TAG, Question } from './question.js';

const ICONS = {
  clock: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>',
  locate: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M21.4 2.6a1 1 0 0 0-1.06-.22l-17 6.5a1 1 0 0 0 .08 1.9l7.06 2.08 2.08 7.06a1 1 0 0 0 1.9.08l6.5-17a1 1 0 0 0-.22-1.06z"/></svg>',
  reset: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M16 16l4.5 4.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M7.5 7.5L12 3l4.5 4.5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  compass: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#ef4444" d="M12 2.5l4 9.5h-8z"/><path fill="currentColor" opacity="0.55" d="M12 21.5l-4-9.5h8z"/><circle cx="12" cy="12" r="1.6" fill="var(--uw-card,#fff)"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.6h-4.6"/></svg>',
  maps: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
const svg = (name) => { const s = h('span.uw-ico'); s.innerHTML = ICONS[name]; return s; };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Sat 24 Oct" from "2026-10-24" (the year only when it is not this year) */
function dayDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return `${WEEKDAYS[dt.getDay()]} ${fmtDate(iso, dt.getFullYear() !== new Date().getFullYear())}`;
}
/** the best value's mark: a 16 px check and one word, never a star or a tint */
const bestMark = (word) => h('span.uw-best', svg('check'), h('span', word));
/** a leading emoji in a label ("🚆 Taipei → Hualien") is decoration: the words stay */
const stripEmoji = (t) => String(t).replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*)+/u, '');
/** a day's row: [title, phrase]. "Day 1 · Taipei: arrive, old streets" → ["Day 1 · Taipei", "arrive, old streets"];
 * with a date: ["Sat 24 Oct · Taipei", …]; a title that already starts with a date keeps it. */
function dayHeading(d, j) {
  let t = stripEmoji(String(d.title || '')).replace(/^(day\s*)?\d+\s*[·:.-]\s*/i, '').trim();
  let phrase = '';
  const colon = t.indexOf(': ');
  if (colon > 0) { phrase = t.slice(colon + 2).trim(); t = t.slice(0, colon).trim(); }
  // a trailing aside ("Taroko Gorge (check what's open)") is not the place: the day's items say what to check
  t = t.replace(/\s*\([^()]*\)\s*$/, '').trim() || t;
  const dated = /^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(t);
  const lead = d.date ? dayDate(d.date) : dated ? '' : `Day ${j + 1}`;
  return [[lead, t].filter(Boolean).join(' · ') || `Day ${j + 1}`, phrase];
}

/** a day row's caption, the same words as the timeline page: "4 stops · 2 not checked" */
function dayCaption(d) {
  const items = Array.isArray(d.items) ? d.items : [];
  const open = items.filter((it) => it && typeof it.check === 'string' && it.check.trim()).length;
  return [items.length ? `${items.length} ${items.length === 1 ? 'stop' : 'stops'}` : null, open ? `${open} not checked` : null].filter(Boolean).join(' · ');
}

const AQ = [[12, 'Good', '#22c55e'], [35.4, 'Moderate', '#eab308'], [55.4, 'Sensitive', '#f97316'], [150.4, 'Unhealthy', '#ef4444'], [Infinity, 'Very unhealthy', '#a21caf']];

// ---------- slider (pointer events; works with touch, mouse, keyboard) ----------
class Slider {
  constructor({ cls, min, max, step, value, label, onInput, onChange, thumb, before, after }) {
    Object.assign(this, { min, max, step, value, onInput, onChange });
    this.thumb = h('div.uw-thumb', thumb || '');
    this.track = h('div.uw-track', h('div.uw-fill'));
    this.rail = h('div.uw-rail', this.track, this.thumb);
    this.el = h(`div.uw-slider.${cls}`, { role: 'slider', tabindex: 0, 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max },
      before || null, this.rail, after || null);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('keydown', (e) => this.key(e));
    this.set(value, false);
  }
  fromX(x) {
    const r = this.rail.getBoundingClientRect(), tw = this.thumb.offsetWidth || 0;
    const t = clamp((x - r.left - tw / 2) / Math.max(1, r.width - tw), 0, 1);
    return Math.round((this.min + t * (this.max - this.min)) / this.step) * this.step;
  }
  set(v, fire = true) {
    v = clamp(Math.round(v / this.step) * this.step, this.min, this.max);
    const changed = v !== this.value; this.value = v;
    const t = (v - this.min) / (this.max - this.min);
    this.el.style.setProperty('--t', t);
    this.el.setAttribute('aria-valuenow', v);
    if (fire && changed) this.onInput?.(v);
    return changed;
  }
  down(e) {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    this.el.focus({ preventScroll: true });
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('is-active');
    const move = (ev) => { ev.stopPropagation(); this.set(this.fromX(ev.clientX)); };
    const up = (ev) => {
      this.el.removeEventListener('pointermove', move); this.el.removeEventListener('pointerup', up); this.el.removeEventListener('pointercancel', up);
      this.el.classList.remove('is-active'); this.onChange?.(this.value); ev.stopPropagation();
    };
    this.el.addEventListener('pointermove', move); this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
    this.set(this.fromX(e.clientX));
  }
  key(e) {
    const k = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -4, PageUp: 4 }[e.key];
    if (k == null && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const v = e.key === 'Home' ? this.min : e.key === 'End' ? this.max : this.value + k * this.step;
    if (this.set(v)) this.onChange?.(this.value);
  }
}

// ---------- phone sheet snaps ----------
/** Where the phone sheet's top sits at each snap (px from the frame top). H: frame height; safeTop / safeBot: --sat /
 *  --sab (the device's safe area, raised to an embedding host's chrome: Studio's bar, composer, reply peek);
 *  content: what the peek shows (grab + lens row + progress + tab bar).
 *  The peek ends the tab bar exactly at H - safeBot, so Places / Layers / Compare are never under a host's composer,
 *  and a taller inset moves the sheet up. The map keeps at least 30% of the area between the insets (≥ 96 px); a peek
 *  taller than that is clipped by `cut` px (the ask's verdict lines), never the tab bar. A peek that fits under the
 *  middle (content + safeBot ≤ H/2 - 40, every map without a host) is where it always was: H - content - safeBot.
 *  (It used to stop at H/2 + 40, which pushed a tall ask's tab bar under the host's composer.) */
export function sheetSnaps({ H, safeTop = 0, safeBot = 0, content = 0 }) {
  const full = safeTop + 10;
  const want = H - safeBot - content;
  const floor = safeTop + Math.max(96, Math.round((H - safeTop - safeBot) * 0.3));
  const peek = Math.round(Math.max(want, floor));
  const cut = Math.max(0, peek - want);
  // half open sits between the peek and full when a tall inset already lifted the peek past the middle
  const half = peek - 40 < Math.round(H * 0.5) ? Math.round((peek + full) / 2) : Math.round(H * 0.5);
  return { full, half, peek, cut };
}

// ---------- UI ----------
export class UI {
  constructor(root, ctx) {
    this.ctx = ctx; this.root = root; this.tab = null; this.card = null; this.snap = 'peek'; this.side = false;
    root.classList.add('uw-root');
    this.mapEl = h('div.uw-map#uw-map', { 'aria-label': 'Map', role: 'region' });
    this.fabs = h('div.uw-fabs');
    this.toasts = h('div.uw-toasts', { 'aria-live': 'polite' });
    this.titleEl = h('h1.uw-title', 'Map');
    this.subEl = h('p.uw-sub');
    this.airEl = h('button.uw-air', { type: 'button', hidden: true, 'aria-label': 'Air quality' });
    this.controls = h('div.uw-controls');
    this.handle = h('button.uw-handle', { type: 'button', 'aria-label': 'Expand or collapse panel' });
    this.qbox = h('div.uw-qbox', { hidden: true });
    this.missingEl = h('div.uw-missing', { hidden: true });
    this.grab = h('div.uw-grab', this.handle, h('header.uw-head', h('div.uw-titles', this.titleEl, this.subEl), this.airEl), this.qbox, this.missingEl, this.controls);
    // lens chips scroll sideways, so they live outside the drag handle area (touch-action there is "none")
    this.lensRow = h('div.uw-lensrow', { hidden: true, role: 'toolbar', 'aria-label': 'Lenses' });
    this.progressEl = h('div.uw-progress-wrap', { hidden: true, 'aria-live': 'polite' });
    this.tabsEl = h('nav.uw-tabs', { role: 'tablist' });
    this.body = h('div.uw-body');
    this.panels = {};
    this.sheet = h('section.uw-sheet', { 'aria-label': 'Map panel' }, this.grab, this.lensRow, this.progressEl, this.tabsEl, this.body);
    this.live = h('div.uw-sr', { 'aria-live': 'polite', role: 'status' });
    this.legendPill = h('button.uw-legendpill', { type: 'button', hidden: true });
    this.probe = h('div', { 'aria-hidden': 'true', style: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: 0 } });
    // --sat / --sab: the safe areas, raised to an embedding host's chrome over the frame (engine.css, host.js)
    this.probe.style.paddingTop = 'var(--sat, env(safe-area-inset-top, 0px))'; this.probe.style.paddingBottom = 'var(--sab, env(safe-area-inset-bottom, 0px))';
    this.hostInsets = { top: 0, bottom: 0, left: 0, right: 0 }; // set by the engine from the host's layout message
    root.append(this.mapEl, this.legendPill, this.fabs, this.toasts, this.sheet, this.probe, this.live);
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.visualViewport?.addEventListener('resize', () => this.layout());
    this.initDrag();
    // focus()/scrollIntoView() can scroll overflow:hidden ancestors; the chrome must never move
    for (const el of [root, document.scrollingElement || document.documentElement]) {
      el.addEventListener('scroll', () => { if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; } }, { passive: true });
    }
    // iOS Safari: stop page pinch-zoom on the chrome (the map handles its own pinch)
    document.addEventListener('gesturestart', (e) => { if (!e.target.closest?.('.maplibregl-canvas-container')) e.preventDefault(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.card) this.ctx.clearSelection(); });
  }

  // ----- layout / sheet -----
  layout() {
    const W = window.innerWidth, H = window.visualViewport?.height || window.innerHeight;
    const side = W >= 900 || (W > H && W >= 600 && H < 600);
    if (side !== this.side) { this.side = side; this.root.classList.toggle('is-side', side); this.ctx.onLayout?.(side); }
    this.H = H;
    if (side) { this.sheet.style.transform = ''; this.sheet.style.height = ''; this.body.style.paddingBottom = ''; return; }
    const cs = getComputedStyle(this.probe);
    const safeTop = parseFloat(cs.paddingTop) || 0, safeBot = parseFloat(cs.paddingBottom) || 0;
    // peek = header + sliders + the tab bar, so Places / Plan / Compare are visible without opening the sheet first
    this.qbox.style.maxHeight = ''; this.qbox.style.overflow = ''; // measure the ask at its full height
    const tabsH = this.tabsEl.hidden ? 0 : Math.max(this.tabsEl.offsetHeight, 45); // 0 while a card hides it; ~1 before tabs are built
    const extra = (this.lensRow.hidden ? 0 : this.lensRow.offsetHeight) + (this.progressEl.hidden ? 0 : this.progressEl.offsetHeight);
    // with a card open (its own head replaces the ask on phones) the peek still shows the card's head
    const content = Math.max(this.card && this.qmode ? 116 : 0, this.grab.offsetHeight + extra + tabsH);
    const s = sheetSnaps({ H, safeTop, safeBot, content });
    this.peekH = content + safeBot;
    this.qboxH = this.qbox.hidden ? 0 : this.qbox.offsetHeight;
    this.peekCut = this.card ? 0 : s.cut;
    this.snaps = { full: s.full, half: s.half, peek: s.peek };
    this.sheet.style.height = (H - this.snaps.full) + 'px';
    this.setSnap(this.snap, false);
  }
  sheetTop() { return this.side ? 0 : this.snaps[this.snap]; }
  /** visible area (px) of the map not covered by panel, as camera padding */
  padding() {
    // phones: the button column only covers the top right, so the sides stay narrow and the data gets the width
    const hi = this.hostInsets;
    const pad = this.side ? { top: 60 + hi.top, right: 72 + hi.right, bottom: 36 + hi.bottom, left: this.sheet.offsetWidth + 44 + hi.left } : { top: 64 + hi.top, right: 58 + hi.right, bottom: 40, left: 18 + hi.left };
    // phones: the sheet's peek already sits above a host's bottom bar (--sab), so the sheet top covers both
    if (!this.side) pad.bottom = Math.min(this.H - this.snaps[this.snap === 'full' ? 'half' : this.snap], this.H * 0.55) + 24;
    pad.top = Math.min(pad.top, this.H * 0.2);
    const W = this.root.clientWidth || window.innerWidth;
    const fitV = this.H - 60 - pad.top - pad.bottom, fitH = W - 60 - pad.left - pad.right;
    if (fitV < 0) pad.bottom = Math.max(0, pad.bottom + fitV);
    if (fitH < 0) pad.left = Math.max(0, pad.left + fitH);
    return pad;
  }
  setSnap(name, animate = true) {
    if (this.side) { this.snap = name; return; }
    this.snap = name;
    const y = this.snaps[name];
    this.sheet.classList.toggle('is-anim', animate && !reducedMotion());
    this.sheet.style.transform = `translate3d(0,${y}px,0)`;
    this.sheet.dataset.snap = name;
    // a frame too short for the whole ask: at peek the verdict lines are cut so the tab bar stays above the inset
    const cut = name === 'peek' && this.peekCut > 0 && this.qboxH > 0 ? Math.max(0, this.qboxH - this.peekCut) : null;
    this.qbox.style.maxHeight = cut == null ? '' : cut + 'px'; this.qbox.style.overflow = cut == null ? '' : 'hidden';
    // a hint shown above the sheet follows it (a host's inset can lift the peek after the hint appeared)
    if (this.toasts.style.bottom) this.toasts.style.bottom = `${Math.round(this.H - y + 10)}px`;
    this.body.style.paddingBottom = `calc(${Math.max(0, y - this.snaps.full)}px + var(--sab) + 16px)`;
    this.handle.setAttribute('aria-expanded', String(name !== 'peek'));
    this.ctx.onSnap?.(name);
  }
  initDrag() {
    let start = null;
    const isControl = (t) => t.closest('.uw-slider, .uw-air, input, .uw-lensrow');
    const onDown = (e) => {
      if (this.side || e.button > 0 || isControl(e.target)) return;
      start = { y: e.clientY, x: e.clientX, top: this.snaps[this.snap], t: performance.now(), id: e.pointerId, moved: false, samples: [[performance.now(), e.clientY]] };
    };
    const onMove = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dy = e.clientY - start.y;
      if (!start.moved) {
        if (Math.abs(dy) < 6) return;
        start.moved = true; this.sheet.setPointerCapture?.(e.pointerId); this.sheet.classList.remove('is-anim'); this.sheet.classList.add('is-dragging');
      }
      let y = start.top + dy;
      const { full, peek } = this.snaps;
      if (y < full) y = full - Math.sqrt(full - y) * 2; if (y > peek) y = peek + Math.sqrt(y - peek) * 2;
      this.sheet.style.transform = `translate3d(0,${y}px,0)`;
      start.samples.push([performance.now(), e.clientY]); if (start.samples.length > 6) start.samples.shift();
      start.cur = y;
    };
    const onUp = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const s = start; start = null;
      this.sheet.classList.remove('is-dragging');
      if (!s.moved) {
        if (e.type === 'pointerup' && !e.target.closest('button, a, .uw-tab') && e.target.closest('.uw-grab')) this.toggleSheet();
        return;
      }
      this.suppressClick = performance.now();
      const [t0, y0] = s.samples[0], [t1, y1] = s.samples[s.samples.length - 1];
      const v = (y1 - y0) / Math.max(1, t1 - t0);
      const proj = s.cur + v * 220;
      const best = Object.entries(this.snaps).sort((a, b) => Math.abs(a[1] - proj) - Math.abs(b[1] - proj))[0][0];
      this.setSnap(best);
    };
    for (const el of [this.grab, this.tabsEl, this.progressEl]) el.addEventListener('pointerdown', onDown);
    this.sheet.addEventListener('pointermove', onMove);
    this.sheet.addEventListener('pointerup', onUp);
    this.sheet.addEventListener('pointercancel', onUp);
    this.sheet.addEventListener('click', (e) => { if (this.suppressClick && performance.now() - this.suppressClick < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
    this.handle.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSheet(); });
    // pull the list down from its top to collapse the sheet (like native sheets)
    let pull = null;
    this.body.addEventListener('touchstart', (e) => {
      if (this.side || e.touches.length !== 1 || e.target.closest('.uw-slider, .uw-chips-scroll')) { pull = null; return; }
      const t = e.touches[0];
      pull = { y: t.clientY, top: this.snaps[this.snap], active: false, samples: [[performance.now(), t.clientY]] };
    }, { passive: true });
    this.body.addEventListener('touchmove', (e) => {
      if (!pull) return;
      const t = e.touches[0], dy = t.clientY - pull.y;
      if (!pull.active) {
        if (this.body.scrollTop > 0 || dy < 8) { if (dy < -4 || this.body.scrollTop > 0) pull = null; return; }
        pull.active = true; this.sheet.classList.remove('is-anim'); this.sheet.classList.add('is-dragging'); pull.y = t.clientY; return;
      }
      if (e.cancelable) e.preventDefault();
      const y = Math.min(this.snaps.peek + 20, Math.max(this.snaps.full, pull.top + (t.clientY - pull.y)));
      this.sheet.style.transform = `translate3d(0,${y}px,0)`;
      pull.cur = y; pull.samples.push([performance.now(), t.clientY]); if (pull.samples.length > 6) pull.samples.shift();
    }, { passive: false });
    const endPull = () => {
      if (!pull) return;
      const p = pull; pull = null;
      if (!p.active) return;
      this.sheet.classList.remove('is-dragging');
      const [t0, y0] = p.samples[0], [t1, y1] = p.samples[p.samples.length - 1];
      const proj = (p.cur ?? p.top) + ((y1 - y0) / Math.max(1, t1 - t0)) * 220;
      const best = Object.entries(this.snaps).sort((a, b) => Math.abs(a[1] - proj) - Math.abs(b[1] - proj))[0][0];
      this.setSnap(best);
    };
    this.body.addEventListener('touchend', endPull, { passive: true });
    this.body.addEventListener('touchcancel', endPull, { passive: true });
  }
  toggleSheet() { if (this.side) return; this.setSnap(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'peek'); }
  /** make the map visible again (used when something happens on the map: fly, plan step, walk) */
  revealMap(to = 'half') { if (!this.side && (this.snap === 'full' || (to === 'peek' && this.snap !== 'peek'))) this.setSnap(to); }
  ensureOpen(min = 'half') { if (!this.side && (this.snap === 'peek' || (min === 'full' && this.snap === 'half'))) this.setSnap(min); }

  // ----- header -----
  /** "Not found yet": places asked for that are not on the map; one line, tap for what was tried */
  setMissing(list) {
    const el = this.missingEl; el.innerHTML = '';
    el.hidden = !list?.length;
    if (!list?.length) { this.layout(); return; }
    const names = list.map((m) => m.name);
    const detail = h('ul.uw-missing-list', { hidden: true }, list.map((m) => h('li', h('b', m.name),
      ` · searched ${(Array.isArray(m.tried) && m.tried.length ? m.tried : ['OpenStreetMap']).join(', ')}. ${m.hint || 'Send its street address to add it.'}`)));
    const btn = h('button.uw-missing-btn', { type: 'button', 'aria-expanded': 'false' },
      `Not found yet: ${names.join(', ')}`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      detail.hidden = !detail.hidden; btn.setAttribute('aria-expanded', String(!detail.hidden)); this.layout();
    });
    el.append(btn, detail);
    this.layout();
  }
  setTitle(title, sub) { this.siteTitle = title || 'Map'; this.titleEl.textContent = this.siteTitle; this.subEl.textContent = sub || ''; this.subEl.hidden = !sub; }

  buildControls({ time, vibe }) {
    this.controls.innerHTML = '';
    if (time) {
      this.timeLabel = h('span.uw-time-label');
      this.time = new Slider({ cls: 'uw-time', min: 0, max: 24, step: 0.5, value: this.ctx.hour, label: 'Time of day',
        thumb: this.timeLabel, onInput: (v) => this.ctx.setTime(v), onChange: (v) => this.ctx.setTime(v, { final: true }) });
      this.controls.append(this.time.el);
      this.updateTime(this.ctx.hour);
    }
    if (vibe) {
      this.vibe = new Slider({ cls: 'uw-vibe', min: 0, max: 1, step: 0.05, value: this.ctx.vibe, label: 'Calm to lively',
        before: h('span.uw-vibe-end', 'Calm'), after: h('span.uw-vibe-end', 'Lively'),
        onInput: (v) => this.ctx.setVibe(v), onChange: (v) => this.ctx.setVibe(v, { final: true }) });
      this.controls.append(this.vibe.el);
    }
    this.controls.hidden = !time && !vibe;
    this.layout();
  }
  updateTime(hour) {
    if (!this.time) return;
    this.time.set(hour, false);
    this.timeLabel.textContent = `${timeIcon(hour)} ${fmtHour(hour)}`.trim();
    this.time.el.setAttribute('aria-valuetext', fmtHour(hour));
  }
  updateVibe(v) { if (this.vibe) { this.vibe.set(v, false); this.vibe.el.setAttribute('aria-valuetext', v < 0.35 ? 'calm' : v > 0.65 ? 'lively' : 'balanced'); } }

  setAir(info) {
    if (!info) { this.airEl.hidden = true; return; }
    const [, word, col] = AQ.find(([lim]) => info.pm25 <= lim);
    this.airEl.hidden = false;
    this.airEl.innerHTML = '';
    this.airEl.append(h('span.uw-air-dot', { style: { background: col } }), h('span', `PM2.5 ${Math.round(info.pm25)}`), h('span.uw-air-word', ` · ${word}`));
    this.airEl.title = `${info.label || 'Regional air'} at ${fmtHour(this.ctx.hour)}`;
    this.airEl.onclick = () => this.toast(`Air ${fmtHour(this.ctx.hour)}: PM2.5 ≈ ${Math.round(info.pm25)} µg/m³ (${word}). Regional model estimate${info.source ? ' · ' + info.source : ''}, typical for this hour.${info.disclaimer ? ' ' + info.disclaimer : ''}`, 6500);
  }

  // ----- tabs -----
  buildTabs(tabs) {
    this.tabsEl.innerHTML = ''; this.body.innerHTML = ''; this.panels = {};
    for (const t of tabs) {
      const b = h('button.uw-tab', { type: 'button', role: 'tab', 'data-tab': t.id, 'aria-selected': 'false' }, t.label);
      b.addEventListener('click', () => { this.showTab(t.id); this.ensureOpen(); this.ctx.onTab?.(t.id); });
      this.tabsEl.append(b);
      this.panels[t.id] = h('div.uw-panel', { role: 'tabpanel', 'data-panel': t.id, hidden: true });
      this.body.append(this.panels[t.id]);
    }
    this.panels.card = h('div.uw-panel.uw-cardpanel', { 'data-panel': 'card', hidden: true });
    this.body.append(this.panels.card);
    this.tabsEl.hidden = tabs.length < 2;
    if (!this.tab || !this.panels[this.tab]) this.tab = tabs[0]?.id || null;
    this.showTab(this.tab, false);
    this.layout(); // peek height includes the tab bar
  }
  showTab(id, fromUser = true) {
    if (fromUser && this.card) { this.card = null; this.panels.card.hidden = true; }
    if (fromUser || id === 'card') this.hideToasts();
    if (!this.panels[id]) return;
    if (id !== 'card') this.tab = id;
    for (const [k, p] of Object.entries(this.panels)) p.hidden = this.card ? k !== 'card' : k !== id;
    for (const b of this.tabsEl.children) b.setAttribute('aria-selected', String(!this.card && b.dataset.tab === id));
    const had = this.sheet.classList.contains('has-card');
    this.sheet.classList.toggle('has-card', !!this.card);
    if (had !== !!this.card && this.qmode && !this.side) this.layout();
    this.body.scrollTop = 0;
    this.ctx.onView?.();
  }
  openSheet(name) {
    if (name === 'card') { if (this.card) this.ensureOpen(); return; }
    if (this.panels[name]) { this.card = null; this.showTab(name); this.ensureOpen(); this.ctx.onTab?.(name); }
  }

  // ----- places -----
  renderPlaces(groups, q = '') {
    const p = this.panels.places; if (!p) return;
    if (!this.search) {
      this.search = h('input.uw-search', { type: 'search', placeholder: 'Search places', 'aria-label': 'Search places', enterkeyhint: 'search', autocomplete: 'off' });
      this.search.addEventListener('input', () => this.ctx.renderPlaces());
      this.search.addEventListener('focus', () => this.ensureOpen('full'));
      this.placesList = h('div.uw-list');
      p.append(h('label.uw-searchwrap', svg('search'), this.search), this.placesList);
    }
    q = this.search.value.trim().toLowerCase();
    this.placesList.innerHTML = '';
    let n = 0;
    for (const g of groups) {
      const items = g.items.filter((it) => (!q || it.search.includes(q)) && (q || !it.hide));
      if (!items.length) continue;
      if (groups.length > 1) this.placesList.append(h('div.uw-group', g.title, h('span.uw-count', String(items.length)), g.off ? h('span.uw-count', g.off) : null));
      for (const it of items.slice(0, 300)) {
        n++;
        const row = h('button.uw-row', { type: 'button', 'data-id': it.id, 'data-layer': it.layer },
          it.letter ? this.letterChip(it.letter, it.color, 40) : this.badge(it.emoji, it.color, it.small ? 32 : 40),
          h('span.uw-row-main', h('span.uw-row-title', it.name || '(unnamed)'), it.sub ? h('span.uw-row-sub', it.sub) : null),
          it.price ? h('span.uw-chip.uw-chip-price', it.price) : null,
          it.vote ? h('span.uw-chip.uw-chip-' + it.vote.kind, it.vote.text) : null);
        if (it.dim) row.classList.add('is-dim');
        row.addEventListener('click', () => this.ctx.select(it.layer, it.id, { from: 'list' }));
        if (it.menu?.length) {
          const more = h('button.uw-iconbtn.uw-row-more', { type: 'button', 'aria-label': `More for ${it.name}` }, svg('more'));
          more.addEventListener('click', (e) => { e.stopPropagation(); this.actionSheet(it.name, it.menu); });
          this.placesList.append(h('div.uw-rowwrap', row, more));
        } else this.placesList.append(row);
      }
      if (g.more && !q) {
        const b = h('button.uw-showall', { type: 'button' }, g.more.label);
        b.addEventListener('click', () => g.more.onClick());
        this.placesList.append(b);
      }
    }
    if (!n) this.placesList.append(h('p.uw-empty', q ? `Nothing matches “${q}”.` : 'No places yet.'));
  }

  badge(emoji, color, d = 36) {
    return h('span.uw-badge', { style: { background: color || '#64748b', width: d + 'px', height: d + 'px', fontSize: Math.round(d * 0.5) + 'px' }, 'aria-hidden': 'true' }, emoji || '');
  }

  // ----- plan -----
  /** One list of every day, the same day rows as Instafy's timeline page: "Sat 24 Oct · Taipei" (or "Day 1 · Taipei")
   * with the same caption ("4 stops · 2 not checked"). The current day is open under its row; a tap on another row
   * opens that day. One way to move between days (no stepper above the list), and the list is not a card inside the
   * panel: no chips, no dots, every day one tap away. */
  renderPlan(plan, index) {
    const p = this.panels.plan; if (!p || !plan) return;
    const days = plan.days || [];
    p.innerHTML = '';
    if (!days.length) { p.append(h('p.uw-empty', 'No plan yet.')); return; }
    const list = h('ol.uw-dayrows');
    days.forEach((day, j) => {
      const open = j === index;
      const [title] = dayHeading(day, j);
      const cap = dayCaption(day);
      const head = h('button.uw-dayrow-h', { type: 'button', 'aria-expanded': String(open), 'data-day': j },
        h('span.uw-dayrow-tt', h(open ? 'h2.uw-dayrow-t.uw-day-title' : 'span.uw-dayrow-t', title), cap ? h('span.uw-dayrow-c', cap) : null), svg('chevron'));
      head.onclick = () => this.ctx.setDay(j);
      const li = h('li.uw-dayrow' + (open ? '.is-open' : ''), { id: `uw-day-${j + 1}` }, head);
      if (open) li.append(this.dayBody(day, j));
      list.append(li);
    });
    p.append(list);
    // a new day: bring its row to the top of the panel (the list stays where it was on a plain redraw)
    if (this.planShown !== index) {
      const was = this.planShown;
      this.planShown = index;
      // the open day's row starts at the top of the panel, never part-way through the row above
      if (was != null || index > 0) requestAnimationFrame(() => { const row = list.children[index]; if (row && this.body) this.body.scrollTop += row.getBoundingClientRect().top - this.body.getBoundingClientRect().top - 4; });
    }
  }
  /** the open day: its walk, its text and its items (the timeline page's stop rows: the name, then its note, what is
   * not checked and its source, each on its own line). Opening the day already frames it on the map and sets its hour (Adjust shows it), so
   * there is no second "Show on map" or clock chip; a one-day plan keeps "Show on map" as its only way in. */
  dayBody(d, index) {
    const box = h('div.uw-dayrow-b');
    const meta = [];
    if ((this.ctx.config?.plan?.days?.length || 0) <= 1) {
      const show = h('button.uw-chip.uw-chip-btn', { type: 'button' }, svg('pin'), 'Show on map');
      show.onclick = () => this.ctx.setDay(index);
      meta.push(show);
    }
    if (d.route) {
      const [, lab] = this.ctx.dayWalkLabel(d);
      const b = h('button.uw-chip.uw-chip-btn', { type: 'button' }, lab); b.onclick = () => this.ctx.walkDay(d); meta.push(b);
    }
    if (meta.length) box.append(h('div.uw-chips', meta));
    if (d.text) box.append(h('p.uw-text', d.text));
    if (Array.isArray(d.items) && d.items.length) {
      const ol = h('ol.uw-items');
      d.items.forEach((it) => {
        const info = it.ref ? this.ctx.refInfo(it.ref) : null;
        // the timeline page's stop row: the name, then each caption on its own line (the note, what is not checked,
        // the source). No time column and no dividers: the order carries the sequence (the hour still frames the map)
        const note = typeof it.note === 'string' && it.note.trim() ? h('span.uw-item-note', stripEmoji(it.note.trim()).slice(0, 120)) : null;
        // a stop on the map is a real button (its name and note) that shows it; its links sit beside it, never inside
        const name = [h('span.uw-item-t', stripEmoji(it.text || info?.name || '')), note];
        const go = info ? h('button.uw-item-go', { type: 'button' }, ...name) : null;
        if (go) go.onclick = () => this.ctx.select(it.ref.layer, it.ref.id, { from: 'plan', keepDay: true });
        const body = h('span.uw-item-b', ...(go ? [go] : name));
        const li = h('li.uw-item', body);
        // what is not checked about this stop, in the pages' words: "Not checked · which trails are open · where to check ↗"
        if (typeof it.check === 'string' && it.check.trim()) {
          const cu = safeUrl(it.check_url);
          const a = cu ? h('a.uw-item-src.is-act', { href: cu, target: '_blank', rel: 'noopener noreferrer' }, 'where to check ↗') : null;
          body.append(h('span.uw-item-check', `Not checked · ${it.check.trim().slice(0, 80)}`, a ? ' · ' : null, a));
        }
        // a sourced item ("url": the page the fact came from) gets a small source link; it does not select the item
        const src = safeUrl(it.url);
        if (src) {
          let host = ''; try { host = new URL(src).hostname.replace(/^www\./, ''); } catch { /* */ }
          const a = h('a.uw-item-src', { href: src, target: '_blank', rel: 'noopener noreferrer', title: it.source || host }, `${it.source || host} ↗`);
          body.append(h('span.uw-item-cap', a));
        }
        ol.append(li);
      });
      box.append(ol);
    }
    return box;
  }

  // ----- layers -----
  renderLayers(groups, extra) {
    const p = this.panels.layers; if (!p) return;
    p.innerHTML = '';
    for (const g of groups) {
      p.append(h('div.uw-group', g.title));
      for (const L of g.layers) {
        const sw = this.swatch(L);
        const tog = h('span.uw-switch', { 'aria-hidden': 'true' });
        const busy = this.ctx.layerBusy?.(L);
        const note = this.ctx.layerNote?.(L);
        const row = h('button.uw-row.uw-layerrow', { type: 'button', role: 'switch', 'aria-checked': String(L.visible), 'data-layer': L.id, 'aria-busy': busy ? 'true' : null },
          sw, h('span.uw-row-main', h('span.uw-row-title', L.title), h('span.uw-row-sub', L.error ? 'data failed to load' : note || this.layerSub(L))), busy ? h('span.uw-spin', { 'aria-label': 'Loading' }) : null, tog);
        if (note && !L.visible) row.classList.add('is-hidden-ctx');
        if (L.error) row.disabled = true;
        row.onclick = () => this.ctx.setLayerVisible(L.id, !L.visible);
        p.append(row);
        if (typeof L.def?.legend === 'string' && L.def.legend && L.visible) p.append(h('p.uw-note.uw-layer-legend', L.def.legend));
        if (L.type === 'grid' && L.visible) p.append(this.feelLegend());
      }
    }
    if (extra) p.append(extra);
  }
  layerSub(L) {
    const n = L.data?.features?.length || 0;
    const bits = [];
    // the engine shows a layer's own time window (first, so a long note can't push it out of view)
    if (L.time) bits.push(`${timeIcon(L.time[0])} ${fmtHour(L.time[0])}–${fmtHour(L.time[1])}`.trim());
    if (typeof L.def?.note === 'string' && L.def.note) bits.push(L.def.note);
    else if (L.type === 'grid') bits.push('estimated · drag the vibe dial');
    else if (L.type === 'legs') bits.push(`${n} leg${n === 1 ? '' : 's'}`);
    else if (L.type === 'route') { const f = L.data.features[0]?.properties || {}; if (f.duration_min) bits.push(`${Math.round(f.duration_min)} min`); if (f.distance_km) bits.push(`${f.distance_km} km`); if (!bits.length) bits.push('route'); }
    else bits.push(`${n} ${{ points: 'place', heat: 'place', lines: 'line', areas: 'area' }[L.type] || 'feature'}${n === 1 ? '' : 's'}`);
    if (L.shown === false && L.visible) bits.push('hidden at this time');
    if (L.def?.partial || L.data?.uw?.partial) bits.push('partial data');
    return bits.join(' · ');
  }
  swatch(L) {
    const c = L.color;
    if (L.type === 'points') return this.badge(L.emoji || L.data?.features?.[0]?.properties?.emoji, c, 32);
    const s = h('span.uw-swatch.uw-sw-' + L.type, { 'aria-hidden': 'true' });
    s.style.setProperty('--c', c);
    // data-driven colours ({prop} or per-feature "color"): show up to 4 of the real colours as stripes
    const key = typeof L.style?.color === 'string' && /^\{[\w:.-]+\}$/.test(L.style.color.trim()) ? L.style.color.trim().slice(1, -1) : null;
    const cols = [...new Set((L.data?.features || []).map((f) => f.properties.color || (key && f.properties[key])).filter((x) => typeof x === 'string'))].slice(0, 4);
    if (cols.length > 1 && (L.type === 'lines' || L.type === 'route')) {
      s.classList.add('uw-sw-multi');
      s.style.setProperty('--stripes', `linear-gradient(180deg, ${cols.map((x, i) => `${x} ${i * 100 / cols.length}% ${(i + 1) * 100 / cols.length}%`).join(', ')})`);
    } else if (cols.length === 1) s.style.setProperty('--c', cols[0]);
    return s;
  }
  feelLegend() {
    return h('div.uw-legend',
      h('div.uw-ramp'),
      h('div.uw-ramp-labels', h('span', 'less your vibe'), h('span', 'more your vibe')),
      h('p.uw-note', 'Estimated from OpenStreetMap (road & rail class, parks, trees, cafés, food, nightlife). Not measured. Tap a cell for the breakdown.'));
  }

  // ----- compare -----
  renderCompare(model) {
    const p = this.panels.compare; if (!p) return;
    p.innerHTML = '';
    if (!model || !model.all.length) { p.append(h('p.uw-empty', 'Nothing to compare yet.')); return; }
    p.append(h('p.uw-hint', `Pick up to ${model.max} to compare. 👍 picks are added first.`));
    const chips = h('div.uw-chips.uw-chips-scroll');
    for (const it of model.all) {
      const on = model.chosen.includes(it.id);
      const b = h('button.uw-chip.uw-chip-btn', { type: 'button', 'aria-pressed': String(on) }, `${it.emoji || ''} ${it.short}`);
      b.onclick = () => this.ctx.toggleCompare(it.id);
      chips.append(b);
    }
    p.append(chips);
    const chosen = model.chosen.map((id) => model.all.find((x) => x.id === id)).filter(Boolean);
    if (!chosen.length) return;
    if (model.winner) p.append(h('div.uw-winner', h('span', '🏆'), h('span', h('b', model.winner.name), ` leads on ${model.winner.wins} of ${model.metrics.length}`)));
    for (const m of model.metrics) {
      const block = h('div.uw-metric', h('div.uw-metric-h', h('span', m.label), h('span.uw-metric-dir', m.better === 'lower' ? 'lower is better' : m.better === 'higher' ? 'higher is better' : '')));
      for (const it of chosen) {
        const v = it.props[m.key];
        const r = m.scale(v);
        const best = Array.isArray(m.best) ? m.best.includes(it.id) : m.best === it.id;
        const row = h('button.uw-bar', { type: 'button' },
          h('span.uw-bar-name', `${it.emoji || ''} ${it.short}`),
          h('span.uw-bar-track', h('span.uw-bar-fill', { style: { width: `${Math.round(r.len * 100)}%`, background: r.color } })),
          h('span.uw-bar-val', fmtMetric(v, m)), best ? bestMark(m.better === 'lower' ? (/min|walk|dist|_m$|km/i.test(m.key) ? 'Closest' : 'Lowest') : 'Highest') : null);
        if (best) row.classList.add('is-best');
        row.onclick = () => this.ctx.select(model.layer, it.id, { from: 'compare' });
        block.append(row);
      }
      p.append(block);
    }
  }

  // ----- card -----
  showCard(model) {
    const c = this.panels.card; if (!c) { this.card = model; return; }
    // a refresh that would draw exactly the same card is skipped: replacing the DOM under a finger eats taps
    if (model.refresh && this.card && !c.hidden) {
      const sig = cardSig(model);
      if (sig === this.cardSig) { this.card = model; return; }
    }
    this.card = model;
    this.cardSig = cardSig(model);
    const keepScroll = model.refresh ? this.body.scrollTop : 0;
    c.innerHTML = '';
    if (model.v2) { this.renderCard2(c, model); this.showTab('card', false); if (!model.refresh) this.ensureOpen(); else this.body.scrollTop = keepScroll; return; }
    const close = h('button.uw-iconbtn.uw-close', { type: 'button', 'aria-label': 'Close' }, svg('close'));
    close.onclick = () => this.ctx.clearSelection();
    const head = h('div.uw-card-head', this.badge(model.emoji, model.color, 48),
      h('div.uw-card-titles', h('h2.uw-card-title', model.title), model.subtitle ? h('p.uw-card-sub', model.subtitle) : null), close);
    c.append(head);
    if (model.image) {
      const img = h('img.uw-card-img', { src: model.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      const fig = h('figure.uw-card-fig', img);
      if (model.imageCredit) {
        const cap = h('figcaption.uw-note.uw-img-credit');
        if (model.imageCreditUrl) cap.append(h('a', { href: model.imageCreditUrl, target: '_blank', rel: 'noopener' }, model.imageCredit)); else cap.textContent = model.imageCredit;
        fig.append(cap);
      }
      img.onerror = () => fig.remove();
      c.append(fig);
    }
    if (model.chips?.length) c.append(h('div.uw-chips', model.chips.map((x) => h('span.uw-chip' + (x.kind ? '.uw-chip-' + x.kind : ''), x.text))));
    if (model.actions?.length) {
      const row = h('div.uw-actions');
      for (const a of model.actions) {
        const b = a.href ? h('a.uw-act', { href: a.href, target: '_blank', rel: 'noopener' }) : h('button.uw-act', { type: 'button' });
        if (a.pressed != null) b.setAttribute('aria-pressed', String(a.pressed));
        if (a.primary) b.classList.add('is-primary');
        b.append(a.icon ? svg(a.icon) : h('span.uw-act-e', a.emoji || ''), h('span', a.label));
        if (a.onClick) b.addEventListener('click', (e) => { a.onClick(e); });
        row.append(b);
      }
      c.append(row);
    }
    if (model.body) c.append(h('p.uw-text', model.body));
    if (model.score != null) {
      c.append(h('div.uw-score', h('div.uw-score-ring', { style: { '--p': model.score } }, h('span', Math.round(model.score * 100) + '%')),
        h('div', h('b', model.scoreTitle || 'Match for your vibe'), h('p.uw-note', model.scoreNote || ''))));
    }
    if (model.bars?.length) {
      const wrap = h('div.uw-bars');
      for (const b of model.bars) {
        wrap.append(h('div.uw-mbar', h('div.uw-mbar-h', h('span', b.label), h('b', b.value)),
          h('div.uw-bar-track', h('span.uw-bar-fill', { style: { width: Math.round(clamp(b.len, 0.02, 1) * 100) + '%', background: b.color } }))));
      }
      c.append(wrap);
    }
    if (model.counts?.length) c.append(h('div.uw-chips', model.counts.map((x) => h('span.uw-chip', x))));
    if (model.nearby?.length) {
      c.append(h('div.uw-group', 'Nearby'));
      for (const n of model.nearby) {
        const r = h('button.uw-row', { type: 'button' }, this.badge(n.emoji, n.color, 34),
          h('span.uw-row-main', h('span.uw-row-title', n.name), h('span.uw-row-sub', n.sub)));
        r.onclick = () => this.ctx.select(n.layer, n.id, { from: 'nearby' });
        c.append(r);
      }
    }
    if (model.foot) c.append(h('p.uw-note.uw-foot', model.foot));
    this.showTab('card', false);
    this.ensureOpen();
  }
  hideCard() {
    if (!this.card) return;
    this.card = null; this.panels.card.innerHTML = '';
    this.showTab(this.tab && this.tab !== 'card' ? this.tab : Object.keys(this.panels)[0], false);
  }

  // ===================== v0.2 =====================
  letterChip(letter, color, d = 28) {
    return h('span.uw-letter', { style: { background: color || LETTER_COLORS[letter] || '#64748b', width: d + 'px', height: d + 'px', fontSize: Math.round(d * 0.5) + 'px' }, 'aria-hidden': 'true' }, letter || '');
  }
  basisChip(basis, conf) {
    const b = BASIS[basis];
    if (!b || !b.chip) return null;
    const el = h('span.uw-basis.uw-basis-' + basis, b.chip);
    el.title = `${b.word || basis}${conf ? ' · confidence ' + conf : ''}`;
    return el;
  }
  /** a sentence for screen readers ("Lore: licence found") */
  announce(text) { this.live.textContent = ''; setTimeout(() => { this.live.textContent = text; }, 30); }

  // ----- question header: ask, verdict strip, persona, lens chips + Tune, progress -----
  buildQuestionHeader(ask) {
    this.qmode = true;
    this.root.classList.add('has-question');
    if (ask) this.titleEl.textContent = ask;
    // the ask is not the site title: a host bar that shows the title keeps it in view (engine.css)
    this.titleEl.classList.toggle('is-ask', !!ask && String(ask).trim() !== String(this.siteTitle || '').trim());
    this.subEl.hidden = true;
    this.airEl.classList.add('is-moved');
    this.verdictEl = h('div.uw-verdict', { role: 'list' });
    this.personaEl = h('div.uw-persona', { hidden: true });
    this.qbox.hidden = false;
    this.qbox.append(this.verdictEl, this.personaEl);
    this.lensRow.hidden = false;
    this.controls.hidden = true;
    this.layout();
  }
  /** lines: [{letter, color, text, ref, cites, facts:[{text, basis}]}], persona: {text}, head: {text} */
  renderVerdict(lines, persona, onPick, head) {
    if (!this.verdictEl) return;
    this.verdictEl.innerHTML = '';
    const H = this.H || window.innerHeight;
    const maxPeek = H * 0.4;
    const tag = (w) => h('span.uw-vb', ' · ' + w);
    // each kind of guest's pick is said on its option's own line ("Via Loft · best for light sleepers: quietest door at
    // night, tied with C, and …"), in place of that line's facts: one line per option, no second list repeating them
    const picks = (persona?.picks || []).filter((x) => x.label && x.name);
    const lower = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1);
    const picksFor = (l) => picks.filter((x) => x.ref && x.ref === l.ref);
    const body = (l) => {
      const mine = merged ? picksFor(l) : [];
      if (mine.length) {
        const parts = [];
        if (l.short) parts.push(h('b', l.short));
        mine.forEach((x) => {
          parts.push(h('span.uw-vsep', ' · '));
          parts.push(h('span.uw-vfor', word(this.ctx.config?.locale || 'en', 'bestFor', { who: lower(x.label) }) + (x.reason ? ': ' : '')));
          if (x.reason) parts.push(h('span.uw-vfact', x.reason));
        });
        // a caveat of the line ("but night market 262 m away") is still said, unless the reason already covers it
        const said = new Set(mine.flatMap((x) => x.cites || []));
        const kept = (l.facts || []).filter((f) => f.caveat && !said.has(f.key));
        kept.forEach((f) => { parts.push(h('span.uw-vsep', ' · ')); parts.push(h('span.uw-vfact.is-caveat', f.text)); });
        if (mine.some((x) => x.estimate) || kept.some((f) => f.basis === 'estimated')) parts.push(tag(BASIS_TAG.estimated));
        return parts;
      }
      // facts carry their own basis: "MRT 3 min 🧭" is routed, "quietest streets nearby est." is estimated
      if (Array.isArray(l.facts) && l.facts.length) {
        const parts = [];
        if (l.verdict) parts.push(h('span', l.verdict + ' · '));
        if (l.short) parts.push(h('b', l.short));
        l.facts.forEach((f) => { parts.push(h('span.uw-vsep', ' · ')); parts.push(h('span.uw-vfact' + (f.caveat ? '.is-caveat' : ''), f.text)); });
        // the trust word once per line ("· Estimate"), as on Instafy's pages; no glyph per fact
        const words = [...new Set(l.facts.map((f) => BASIS_TAG[f.basis]).filter(Boolean))];
        if (words.length) parts.push(tag(words.join(', ')));
        // incomplete input data (a fallback, a cap): said on the line itself, never only in a tooltip
        if (l.caveats?.length) parts.push(' ', h('span.uw-vcav', { title: 'Some of the data behind this line is missing; it may change when complete' }, Question.caveatText(l.caveats)));
        return parts;
      }
      return l.short && l.text.startsWith(l.short) ? [h('b', l.short), l.text.slice(l.short.length)] : [l.text];
    };
    const mk = (l) => {
      const b = h('button.uw-vline', { type: 'button', role: 'listitem', 'data-ref': l.ref || '', 'data-day': l.day ?? '' },
        l.letter ? this.letterChip(l.letter, l.color, 26) : l.dayChip ? h('span.uw-daychip', { 'aria-hidden': 'true' }, l.dayChip) : null,
        h('span.uw-vline-t', ...body(l)));
      if (l.dayChip) b.setAttribute('aria-label', `Day ${l.day + 1}: ${l.text}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); onPick?.(l); });
      return b;
    };
    if (head?.text) this.verdictEl.append(h('p.uw-vhead', head.text));
    // a plan's days are listed once, in the plan tab (the same day rows as Instafy's timeline page), not as chips here
    lines = lines.filter((l) => l.day == null);
    // the picks go on their options' lines when every pick's option has a line
    let merged = picks.length > 0 && picks.every((x) => lines.some((l) => l.ref && l.ref === x.ref));
    let shown = lines;
    // peek may grow to fit, never past 40% of the screen: the rest fold into "+N more" (the real remainder)
    const est = (n) => (this.grab.offsetHeight - this.verdictEl.offsetHeight) + n * 48 + (this.lensRow.offsetHeight || 52) + 46 + (persona && !merged ? 20 * Math.max(1, picks.length) : 0) + (head ? 22 : 0);
    const cap = lines.some((l) => l.day != null) ? 3 : 5;
    if (!this.side && lines.length > 3 && (lines.length > cap || est(lines.length) > maxPeek)) shown = lines.slice(0, lines.length > cap ? Math.min(3, cap) : 3);
    // a pick whose option folded into "+N more" keeps the picks in their own lines below
    if (merged && !picks.every((x) => shown.some((l) => l.ref === x.ref))) merged = false;
    else if (this.side && lines.length > 6) shown = lines.slice(0, 6);
    for (const l of shown) this.verdictEl.append(mk(l));
    if (shown.length < lines.length) {
      const rest = lines.length - shown.length;
      const days = lines.some((l) => l.day != null);
      const more = h('button.uw-vline.uw-vmore', { type: 'button' }, `+${rest} more ${days ? (rest === 1 ? 'day' : 'days') : ''}`.trim());
      more.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.openSheet?.(days ? 'plan' : 'compare'); this.setSnap('half'); });
      this.verdictEl.append(more);
    }
    this.personaEl.hidden = !persona || (merged && !persona.close);
    this.personaEl.replaceChildren();
    // merged: only a near tie is left to say ("A and B are close"); else each pick on its own line with its reason
    if (merged) { if (persona?.close) this.personaEl.textContent = persona.close; }
    else if (picks.length) {
      for (const x of picks) this.personaEl.append(h('span.uw-pick', h('b', `${x.label}: ${x.name}`), x.reason ? ` · ${x.reason}` : '', x.estimate ? tag(BASIS_TAG.estimated) : null));
    } else if (persona) this.personaEl.textContent = persona.text;
    this.layout();
  }
  /** lenses: [{id, emoji, label}], active id; extra: [{label, emoji, onClick}] (sheet-header intents).
   * The row under the verdict holds the sheet-header intents as plain buttons and, only on a map that asks for it,
   * "Adjust" (tuneLabel set). The focus choice (Sleep | Night | Transit) lives inside Adjust: the tabs below are the
   * only segmented row in the peek. Without either the row is hidden. */
  renderLensRow(lenses, active, tuneLabel, extra = []) {
    const row = this.lensRow;
    row.innerHTML = '';
    this.lenses = lenses; this.lensActive = active;
    const scroll = h('div.uw-lens-scroll');
    for (const x of extra) {
      const b = h('button.uw-lens.uw-lens-intent', { type: 'button', 'data-intent': x.name || '' }, h('span', x.label));
      if (x.disabled) { b.disabled = true; b.classList.add('is-sent'); }
      b.addEventListener('click', () => x.onClick());
      scroll.append(b);
    }
    // "Adjust" only on a map that asks for it (question.adjust); it says what it opens and nothing else (no clock)
    if (tuneLabel) {
      const tune = h('button.uw-lens.uw-tune-btn', { type: 'button', 'aria-expanded': String(!!this.tuneEl), 'aria-label': 'Adjust', 'aria-haspopup': 'dialog' }, h('span', 'Adjust'));
      tune.addEventListener('click', (e) => { e.stopPropagation(); this.tuneEl ? this.closeTune() : this.openTune(); });
      scroll.append(tune);
      this.tuneBtn = tune;
    } else { this.tuneBtn = null; this.closeTune(); }
    row.append(scroll);
    const was = row.hidden;
    row.hidden = !scroll.firstChild;
    this.root.classList.toggle('has-adjust', !!tuneLabel);
    if (this.tuneEl) this.fillTune(this.tuneEl.querySelector('.uw-tune-body'));
    if (was !== row.hidden) this.layout();
  }
  /** Adjust's content: the engine's time, vibe and weights, then the rarer map buttons as words ("3D view") */
  fillTune(body) {
    if (!body) return;
    this.ctx.renderTune?.(body);
    // the focus choice first: one segmented control in words, the same look as a page's .seg
    if (this.lenses?.length >= 2) {
      const seg = h('div.uw-lens-seg', { role: 'group', 'aria-label': 'Focus' });
      for (const l of this.lenses) {
        const b = h('button.uw-lens', { type: 'button', 'aria-pressed': String(l.id === this.lensActive), 'data-lens': l.id }, h('span', l.label || l.id));
        b.addEventListener('click', (e) => { e.stopPropagation(); if (l.id !== this.ctx.lensId()) this.ctx.setLens(l.id, { from: 'user' }); });
        seg.append(b);
      }
      body.prepend(h('div.uw-tune-sec', h('div.uw-sub-h', 'Focus'), seg));
    }
    const fabs = [...this.fabs.querySelectorAll('.uw-fab[data-adjust]')];
    if (!fabs.length) return;
    const acts = h('div.uw-actions.uw-tune-map');
    for (const f of fabs) {
      const b = h('button.uw-act', { type: 'button' }, h('span', f.dataset.adjust || f.getAttribute('aria-label') || f.textContent));
      if (f.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', f.getAttribute('aria-pressed'));
      b.addEventListener('click', (e) => { e.stopPropagation(); f.click(); if (f.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', f.getAttribute('aria-pressed')); });
      acts.append(b);
    }
    body.append(h('div.uw-tune-sec', h('div.uw-sub-h', 'Map'), acts));
  }
  /** slim progress lines for layer-wide jobs: [{id, text, onCancel}] */
  renderProgress(items) {
    const el = this.progressEl;
    const was = !el.hidden;
    el.innerHTML = '';
    el.hidden = !items.length;
    for (const it of items) {
      const cancel = it.onCancel ? h('button.uw-progress-x', { type: 'button', 'aria-label': `${it.cancelLabel || 'Cancel'} ${it.label || ''}`.trim() }, svg('close')) : null;
      cancel?.addEventListener('click', (e) => { e.stopPropagation(); it.onCancel(); });
      const act = it.action ? h('button.uw-progress-a', { type: 'button' }, it.action.label) : null;
      act?.addEventListener('click', (e) => { e.stopPropagation(); it.action.onClick(); });
      el.append(h('div.uw-progress' + (it.done ? '.is-done' : ''), it.done ? null : h('span.uw-progress-bar', { 'aria-hidden': 'true' }), it.done ? null : h('span.uw-spin', { 'aria-hidden': 'true' }),
        h('span.uw-progress-t', it.text), act, cancel || h('span', { style: { width: '12px' } })));
    }
    if (was !== !el.hidden) this.layout();
  }
  // ----- Adjust: time + vibe + weight sliders + share bar + the rarer map buttons (popover on phones, inline in the side panel) -----
  openTune() {
    this.closeTune();
    this.hideToasts();
    const body = h('div.uw-tune-body');
    const close = h('button.uw-iconbtn.uw-close', { type: 'button', 'aria-label': 'Close' }, svg('close'));
    close.addEventListener('click', () => this.closeTune());
    const el = this.tuneEl = h('div.uw-tune', { role: 'dialog', 'aria-label': 'Adjust' }, h('div.uw-tune-head', h('b', 'Adjust'), close), body);
    if (this.side) this.lensRow.after(el);
    else {
      this.root.append(el);
      const top = this.sheetTop();
      el.style.bottom = `${Math.max(8, this.H - top + 8)}px`;
      // it fits between the top of the frame (a host's bar included) and the sheet: nothing in it sits under the peek
      const safeTop = parseFloat(getComputedStyle(this.probe).paddingTop) || 0;
      el.style.maxHeight = `${Math.max(140, top - 8 - safeTop - 8)}px`;
    }
    this.fillTune(body);
    this.tuneBtn?.setAttribute('aria-expanded', 'true');
    this.tuneOutside = (e) => { if (!el.contains(e.target) && !this.tuneBtn?.contains(e.target)) this.closeTune(); };
    setTimeout(() => document.addEventListener('pointerdown', this.tuneOutside, true), 0);
    this.tuneKey = (e) => { if (e.key === 'Escape') this.closeTune(); };
    document.addEventListener('keydown', this.tuneKey);
    if (this.side) this.layout();
  }
  closeTune() {
    if (!this.tuneEl) return;
    this.tuneEl.remove(); this.tuneEl = null;
    document.removeEventListener('pointerdown', this.tuneOutside, true);
    document.removeEventListener('keydown', this.tuneKey);
    this.tuneBtn?.setAttribute('aria-expanded', 'false');
  }
  /** a 0..3 weight slider row */
  weightSlider(label, value, onInput) {
    const out = h('b.uw-w-val', String(value));
    const s = new Slider({ cls: 'uw-wslider', min: 0, max: 3, step: 1, value, label: `Weight: ${label}`,
      onInput: (v) => { out.textContent = String(v); onInput(v, false); }, onChange: (v) => onInput(v, true) });
    return h('div.uw-wrow', h('div.uw-wrow-h', h('span', label), out), s.el);
  }
  timeSlider() {
    if (!this.time) {
      this.timeLabel = h('span.uw-time-label');
      this.time = new Slider({ cls: 'uw-time', min: 0, max: 24, step: 0.5, value: this.ctx.hour, label: 'Time of day',
        thumb: this.timeLabel, onInput: (v) => this.ctx.setTime(v), onChange: (v) => this.ctx.setTime(v, { final: true }) });
    }
    this.updateTime(this.ctx.hour);
    return this.time.el;
  }
  vibeSlider() {
    if (!this.vibe) {
      this.vibe = new Slider({ cls: 'uw-vibe', min: 0, max: 1, step: 0.05, value: this.ctx.vibe, label: 'Calm to lively',
        before: h('span.uw-vibe-end', 'Calm'), after: h('span.uw-vibe-end', 'Lively'),
        onInput: (v) => this.ctx.setVibe(v), onChange: (v) => this.ctx.setVibe(v, { final: true }) });
    }
    this.updateVibe(this.ctx.vibe);
    return this.vibe.el;
  }

  // ----- dialogs: confirm, intent form, action sheet, info sheet -----
  dialog({ title, body = [], actions = [], cls = '' }) {
    this.closeDialog();
    this.hideToasts();
    const card = h('div.uw-dialog-card' + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      title ? h('h2.uw-dialog-title', title) : null, ...body);
    if (actions.length) {
      const row = h('div.uw-dialog-actions');
      for (const a of actions) {
        const b = h('button.uw-act' + (a.primary ? '.is-primary' : ''), { type: a.submit ? 'submit' : 'button' }, a.label);
        b.addEventListener('click', (e) => { if (!a.submit) { e.preventDefault(); a.onClick?.(); } });
        row.append(b);
      }
      card.append(row);
    }
    const wrap = h('div.uw-dialog', card);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) this.closeDialog(true); });
    this.dialogKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeDialog(true); } };
    document.addEventListener('keydown', this.dialogKey, true);
    this.root.append(wrap);
    this.dialogEl = wrap;
    requestAnimationFrame(() => wrap.classList.add('is-in'));
    setTimeout(() => (card.querySelector('input, select, button.is-primary') || card.querySelector('button'))?.focus({ preventScroll: true }), 30);
    return card;
  }
  closeDialog(cancelled) {
    if (!this.dialogEl) return;
    this.dialogEl.remove(); this.dialogEl = null;
    document.removeEventListener('keydown', this.dialogKey, true);
    const f = this.dialogOnCancel; this.dialogOnCancel = null;
    if (cancelled && f) f();
  }
  confirm(title, text, okLabel = 'OK') {
    return new Promise((res) => {
      this.dialogOnCancel = () => res(false);
      this.dialog({ title, body: [h('p.uw-text', text)], actions: [
        { label: 'Cancel', onClick: () => { this.dialogOnCancel = null; this.closeDialog(); res(false); } },
        { label: okLabel, primary: true, onClick: () => { this.dialogOnCancel = null; this.closeDialog(); res(true); } }] });
    });
  }
  /** a small form generated from an intent's params schema, for required params prefill couldn't fill */
  intentForm(def, params, missing) {
    return new Promise((res) => {
      const props = def.params?.properties || {};
      const fields = [];
      const form = h('form.uw-form', { novalidate: true });
      const keys = [...new Set([...missing, ...Object.keys(props).filter((k) => params[k] === undefined && props[k] && props[k].default === undefined && !['refresh'].includes(k))])];
      for (const k of keys) {
        const s = props[k] || { type: 'string' };
        const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
        const label = s.title || humanize(k);
        let input;
        if (Array.isArray(s.enum)) { input = h('select.uw-input', { name: k }, s.enum.map((v) => h('option', { value: String(v) }, String(v)))); }
        else if (t === 'boolean') input = h('input.uw-check', { type: 'checkbox', name: k });
        else if (t === 'number' || t === 'integer') input = h('input.uw-input', { type: 'number', name: k, inputmode: 'decimal', step: t === 'integer' ? '1' : 'any', min: s.minimum, max: s.maximum });
        else if (s.format === 'date') input = h('input.uw-input', { type: 'date', name: k });
        else if (s.format === 'date-time') input = h('input.uw-input', { type: 'datetime-local', name: k });
        else if (t === 'array') input = h('input.uw-input', { type: 'text', name: k, placeholder: 'comma, separated' });
        else input = h('input.uw-input', { type: 'text', name: k, maxlength: s.maxLength });
        if (missing.includes(k)) input.required = true;
        fields.push({ k, s, t, input });
        form.append(h('label.uw-field', h('span.uw-field-l', label + (missing.includes(k) ? '' : ' (optional)')), input, s.description ? h('span.uw-note', s.description) : null));
      }
      const err = h('p.uw-form-err', { role: 'alert', hidden: true });
      form.append(err);
      const submit = () => {
        const out = { ...params };
        for (const { k, t, input, s } of fields) {
          let v = input.type === 'checkbox' ? input.checked : input.value.trim();
          if (v === '' || v == null) { if (missing.includes(k)) { err.hidden = false; err.textContent = `Please fill in ${s.title || humanize(k)}.`; input.focus(); return; } continue; }
          if (t === 'number' || t === 'integer') v = Number(v);
          else if (t === 'array') v = String(v).split(',').map((x) => x.trim()).filter(Boolean).map((x) => (s.items?.type === 'number' ? Number(x) : x));
          else if (s.format === 'date-time' && v) v = new Date(v).toISOString();
          if (Array.isArray(s.enum)) { const m = s.enum.find((e) => String(e) === v); if (m !== undefined) v = m; }
          out[k] = v;
        }
        this.dialogOnCancel = null; this.closeDialog(); res(out);
      };
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      this.dialogOnCancel = () => res(null);
      this.dialog({ title: `${def.emoji || ''} ${def.label}`.trim(), body: [def.describe ? h('p.uw-note', def.describe) : null, form].filter(Boolean),
        actions: [{ label: 'Cancel', onClick: () => { this.dialogOnCancel = null; this.closeDialog(); res(null); } }, { label: 'Send', primary: true, onClick: submit }] });
    });
  }
  /** ⋯ menu / long-press menu: items [{emoji, label, onClick, href}] */
  actionSheet(title, items) {
    const list = h('div.uw-sheetlist');
    for (const it of items) {
      const b = it.href ? h('a.uw-row.uw-menuitem', { href: it.href, target: '_blank', rel: 'noopener noreferrer' }) : h('button.uw-row.uw-menuitem', { type: 'button' });
      b.append(h('span.uw-menu-e', { 'aria-hidden': 'true' }, it.icon ? svg(it.icon) : it.emoji || '•'), h('span.uw-row-main', h('span.uw-row-title', it.label), it.sub ? h('span.uw-row-sub', it.sub) : null));
      if (it.disabled) { b.setAttribute('aria-disabled', 'true'); b.classList.add('is-dim'); }
      b.addEventListener('click', (e) => { if (it.disabled) { e.preventDefault(); return; } this.closeDialog(); it.onClick?.(e); });
      list.append(b);
    }
    this.dialog({ title, body: [list], actions: [{ label: 'Close', onClick: () => this.closeDialog() }], cls: 'is-menu' });
  }
  infoSheet(title, rows, link) {
    const dl = h('dl.uw-info');
    for (const [k, v] of rows) if (v) dl.append(h('dt', k), h('dd', v));
    const body = [dl];
    if (link) body.push(h('p', h('a.uw-link-inline', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.label)));
    this.dialog({ title, body, actions: [{ label: 'Close', primary: true, onClick: () => this.closeDialog() }] });
  }

  // ----- the v0.2 card: head · photo · why · checked facts · actions · link-outs · all numbers · how we know · sources -----
  renderCard2(c, m) {
    const close = h('button.uw-iconbtn.uw-close', { type: 'button', 'aria-label': 'Close' }, svg('close'));
    close.onclick = () => this.ctx.clearSelection();
    const badge = m.letter ? this.letterChip(m.letter, m.color, 48) : this.badge(m.emoji, m.color, m.context ? 40 : 48);
    const heads = (m.headActs || []).map((a) => {
      const b = h('button.uw-headact', { type: 'button', 'aria-label': a.sub ? `${a.label}: ${a.sub}` : a.label }, a.emoji ? h('span', { 'aria-hidden': 'true' }, a.emoji) : null, h('span', a.label));
      if (a.disabled) b.disabled = true;
      b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick?.(e); });
      return b;
    });
    const titles = h('div.uw-card-titles', h('h2.uw-card-title', m.letter && m.emoji ? h('span.uw-title-e', { 'aria-hidden': 'true' }, m.emoji + ' ') : null, m.title),
      m.subtitle ? h('p.uw-card-sub', m.subtitle) : null, m.licence || heads.length ? h('div.uw-headacts', m.licence || null, ...heads) : null);
    const head = h('div.uw-card-head', badge, titles, close);
    if (m.onLongPress) {
      let t = null;
      const start = (e) => { if (e.target.closest('button, a')) return; t = setTimeout(() => { t = null; try { navigator.vibrate?.(10); } catch { /* */ } m.onLongPress(); }, 500); };
      const stop = () => { clearTimeout(t); t = null; };
      head.addEventListener('pointerdown', start); head.addEventListener('pointerup', stop); head.addEventListener('pointerleave', stop); head.addEventListener('pointercancel', stop);
      head.addEventListener('contextmenu', (e) => { e.preventDefault(); stop(); m.onLongPress(); });
    }
    c.append(head);
    if (m.photo) c.append(m.photo);
    if (m.why?.lines?.length) {
      const box = h('div.uw-why', { 'aria-label': 'Why this fits you' });
      for (const l of m.why.lines) {
        const mark = l.mark === 'check' ? h('span.uw-mark.is-check', { 'aria-label': 'good' }, '✓') : l.mark === 'cross' ? h('span.uw-mark.is-cross', { 'aria-label': 'trade-off' }, '✗') : h('span.uw-mark.is-neutral', { 'aria-hidden': 'true' }, l.emoji || '•');
        box.append(h('div.uw-whyline', mark, h('span.uw-why-t', l.text), l.value ? h('span.uw-why-v', l.value) : null, this.basisChip(l.basis, l.confidence)));
      }
      if (m.why.tradeoff) box.append(h('p.uw-tradeoff', m.why.tradeoff));
      c.append(box);
    }
    if (m.body) c.append(h('p.uw-text.uw-text-sm', m.body));
    if (m.chips?.length) c.append(h('div.uw-chips', m.chips.map((x) => h('span.uw-chip' + (x.kind ? '.uw-chip-' + x.kind : ''), x.text))));
    if (m.facts?.length || m.pending?.length || m.outcome) {
      const box = h('div.uw-facts');
      box.append(h('div.uw-sub-h', m.factsTitle || 'Checked facts'));
      const skelRow = (p) => {
        const t = typeof p === 'string' ? { text: p } : p || {};
        const row = h('div.uw-fact.is-skel', { 'aria-busy': 'true' }, h('span.uw-skel'), h('span.uw-fact-st', t.text || ''));
        if (t.action) { const b = h('button.uw-chip.uw-chip-btn', { type: 'button' }, t.action.label); b.onclick = (e) => { e.stopPropagation(); t.action.onClick(); }; row.append(b); }
        return row;
      };
      for (const p of m.pending || []) box.append(skelRow(p));
      for (const f of m.facts || []) {
        const row = h('div.uw-fact' + (f.expired ? '.is-expired' : '') + (f.stale ? '.is-stale' : '') + (f.skeleton ? '.is-skel' : '') + (f.conflict ? '.is-conflict' : ''));
        if (f.skeleton) { box.append(skelRow(f.skeleton)); continue; }
        row.append(h('div.uw-fact-main', h('span.uw-fact-l', f.label), h('b.uw-fact-v', f.value), f.sub ? h('span.uw-fact-s', f.sub) : null, f.note ? h('span.uw-fact-n', f.note) : null),
          h('div.uw-fact-side', this.basisChip(f.basis, f.confidence), f.sandbox ? h('span.uw-basis', 'sandbox') : null,
            f.onRefresh ? this.refreshBtn(f.refreshLabel || `Check ${f.label} again`, f.onRefresh, f.cooling) : null));
        if (f.href) row.append(h('a.uw-fact-link', { href: f.href, target: '_blank', rel: 'noopener noreferrer' }, f.hrefLabel || 'Open ↗'));
        box.append(row);
      }
      if (m.outcome) {
        const o = h('div.uw-outcome' + (m.outcome.error ? '.is-error' : ''), h('span', m.outcome.text));
        if (m.outcome.onRetry) { const b = h('button.uw-chip.uw-chip-btn', { type: 'button' }, svg('refresh'), 'Try again'); b.onclick = m.outcome.onRetry; o.append(b); }
        box.append(o);
      }
      c.append(box);
    }
    if (m.actions?.length) {
      const row = h('div.uw-actions');
      const vis = m.actions.slice(0, 4), rest = [...m.actions.slice(4), ...(m.moreActions || [])];
      for (const a of vis) row.append(this.actBtn(a));
      if (rest.length) {
        const more = h('button.uw-act.uw-act-more', { type: 'button', 'aria-label': 'More actions' }, svg('more'));
        more.addEventListener('click', () => this.actionSheet(m.title, rest));
        row.append(more);
      }
      c.append(row);
    }
    if (m.links?.length) {
      const row = h('div.uw-links');
      for (const l of m.links) {
        const a = h('a.uw-link', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label);
        a.addEventListener('click', () => l.onClick?.());
        row.append(a);
      }
      c.append(row);
    }
    if (m.nearby?.length) {
      c.append(h('div.uw-group', 'Nearby'));
      for (const n of m.nearby) {
        const r = h('button.uw-row', { type: 'button' }, this.badge(n.emoji, n.color, 34), h('span.uw-row-main', h('span.uw-row-title', n.name), h('span.uw-row-sub', n.sub)));
        r.onclick = () => this.ctx.select(n.layer, n.id, { from: 'nearby' });
        c.append(r);
      }
    }
    if (m.bars?.length) {
      const wrap = h('div.uw-bars');
      for (const b of m.bars) {
        wrap.append(h('div.uw-mbar', h('div.uw-mbar-h', h('span', b.label), h('b', b.value)),
          h('div.uw-bar-track', h('span.uw-bar-fill', { style: { width: Math.round(clamp(b.len, 0.02, 1) * 100) + '%', background: b.color } }))));
      }
      c.append(m.barsOpen ? h('div.uw-allnums', h('div.uw-sub-h', 'All numbers'), wrap) : this.disclosure('All numbers', wrap, m.barsKey));
    }
    if (m.about) c.append(this.disclosure('About', h('p.uw-text.uw-about', m.about), 'about'));
    if (m.how?.length) {
      const list = h('ul.uw-how');
      for (const x of m.how) list.append(h('li', h('b', x.label), ` · ${x.text}`));
      c.append(this.disclosure('How we know', list, 'how'));
    }
    if (m.found) c.append(h('p.uw-note.uw-found', m.found));
    if (m.foot) c.append(h('p.uw-note.uw-foot', m.foot));
  }
  disclosure(label, content, key) {
    const open = this.openDisc?.has(key);
    const btn = h('button.uw-disc', { type: 'button', 'aria-expanded': String(!!open) }, h('span', label), h('span.uw-disc-c', { 'aria-hidden': 'true' }, '▾'));
    const body = h('div.uw-disc-body', { hidden: !open }, content);
    btn.addEventListener('click', () => {
      const o = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(o)); body.hidden = !o;
      (this.openDisc ||= new Set())[o ? 'add' : 'delete'](key);
    });
    return h('div.uw-discwrap', btn, body);
  }
  refreshBtn(label, onClick, cooling) {
    const b = h('button.uw-refresh', { type: 'button', 'aria-label': label, title: label }, svg('refresh'));
    if (cooling) { b.disabled = true; b.classList.add('is-sent'); }
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }
  actBtn(a) {
    const b = a.href ? h('a.uw-act', { href: a.href, target: '_blank', rel: 'noopener noreferrer' }) : h('button.uw-act', { type: 'button' });
    if (a.pressed != null) b.setAttribute('aria-pressed', String(a.pressed));
    if (a.primary) b.classList.add('is-primary');
    if (a.intent) b.classList.add('is-intent');
    if (a.disabled) { b.disabled = true; b.classList.add('is-sent'); }
    b.append(a.icon ? svg(a.icon) : h('span.uw-act-e', a.emoji || ''), h('span', a.label));
    if (a.onClick) b.addEventListener('click', (e) => { a.onClick(e); });
    return b;
  }

  // ----- Compare v2: lettered columns, verdict / doorstep / licence / price rows, weighted criteria, no-diff rows hidden -----
  renderCompare2(m) {
    const p = this.panels.compare; if (!p) return;
    p.innerHTML = '';
    if (!m || !m.cols.length) { p.append(h('p.uw-empty', 'Nothing to compare yet.')); return; }
    const n = m.cols.length;
    const grid = h('div.uw-cmp', { style: { '--n': n } });
    const headRow = h('div.uw-cmp-cols');
    for (const col of m.cols) {
      const b = h('button.uw-cmp-col', { type: 'button', 'aria-label': `Show ${col.name}` }, col.letter ? this.letterChip(col.letter, col.color, 30) : this.badge(col.emoji, col.color, 30), h('span.uw-cmp-name', col.short));
      b.onclick = () => this.ctx.select(col.layer, col.id, { from: 'compare' });
      headRow.append(b);
    }
    grid.append(headRow);
    const rowEl = (r) => {
      const label = h('div.uw-cmp-label', h('span.uw-cmp-l', r.label), r.sub ? h('span.uw-cmp-sub', r.sub) : null, this.basisChip(r.basis, r.confidence));
      const cells = h('div.uw-cmp-cells');
      r.cells.forEach((cell) => {
        const el = h('div.uw-cmp-cell' + (cell.best ? '.is-best' : '') + (cell.skel ? '.is-skel' : '') + (cell.expired ? '.is-expired' : ''));
        if (cell.skel) el.append(h('span.uw-skel'));
        else if (cell.node) el.append(cell.node);
        else {
          el.append(h('span.uw-cmp-v', cell.text ?? '—'));
          if (cell.len != null) el.append(h('span.uw-cmp-bar', h('span', { style: { width: Math.round(clamp(cell.len, 0.03, 1) * 100) + '%' } })));
          // the best value: a check and the comparison's own word ("Lowest", "Closest"), on the neutral selected fill
          if (cell.best) el.append(bestMark(cell.bestWord || 'Best'));
          if (cell.small) el.append(h('span.uw-cmp-small', cell.small));
        }
        if (cell.onRefresh) el.append(this.refreshBtn(cell.refreshLabel || 'Check again', cell.onRefresh, cell.cooling));
        cells.append(el);
      });
      return h('div.uw-cmp-row' + (r.cls ? '.' + r.cls : ''), label, cells);
    };
    for (const r of m.rows) grid.append(rowEl(r));
    if (m.extra?.length) {
      const more = h('div.uw-cmp-more', { hidden: !this.cmpOpen });
      for (const r of m.extra) more.append(rowEl(r));
      const b = h('button.uw-showall', { type: 'button', 'aria-expanded': String(!!this.cmpOpen) }, this.cmpOpen ? 'Fewer rows ▴' : `${m.extra.length} more row${m.extra.length === 1 ? '' : 's'} ▾`);
      b.onclick = () => { this.cmpOpen = !this.cmpOpen; more.hidden = !this.cmpOpen; b.setAttribute('aria-expanded', String(this.cmpOpen)); b.textContent = this.cmpOpen ? 'Fewer rows ▴' : `${m.extra.length} more row${m.extra.length === 1 ? '' : 's'} ▾`; };
      grid.append(more, b);
    }
    p.append(grid);
    if (m.hidden?.length) p.append(h('p.uw-note', `Hidden because all options are about the same: ${m.hidden.join(', ')}.`));
    p.append(h('p.uw-note.uw-sorted', m.sorted));
  }

  /** the one-line grid legend on the map (top-left, ≥ 44 px, tap → Layers) */
  setLegend(info) {
    const el = this.legendPill;
    if (!info) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '';
    for (const [c, label] of info.classes) el.append(h('span.uw-lg-i', h('span.uw-lg-sw', { style: { background: c } }), label));
    el.append(h('span.uw-lg-n', info.note));
    el.setAttribute('aria-label', `Map legend: ${info.classes.map((x) => x[1]).join(', ')}, ${info.note}. Open the map key.`);
    el.onclick = () => this.openSheet('layers');
  }

  // ----- floating buttons -----
  /** a round map button. adjust: a word ("3D view") puts it in Adjust instead when the sheet has one (a question map),
   * so the map itself keeps only the buttons people need at once. */
  addButton({ id, label, title, onClick, html, cls, adjust }) {
    if (id && this.fabs.querySelector(`[data-id="${CSS.escape(id)}"]`)) this.fabs.querySelector(`[data-id="${CSS.escape(id)}"]`).remove();
    const b = h('button.uw-fab', { type: 'button', 'data-id': id || null, title: title || label, 'aria-label': title || label, 'data-adjust': adjust ? (adjust === true ? title || label : adjust) : null });
    if (cls) b.classList.add(cls);
    if (html) b.innerHTML = html; else b.textContent = label || '?';
    b.addEventListener('click', (e) => { e.stopPropagation(); try { onClick?.(e); } catch (err) { this.ctx.error('custom button: ' + err.message, err); } });
    this.fabs.append(b);
    return b;
  }
  icon(name) { return ICONS[name]; }

  /** put every hint away: a panel, a card, a dialog or another tab is now what the person looks at */
  hideToasts() {
    for (const t of [...this.toasts.children]) { t.classList.remove('is-in'); setTimeout(() => t.remove(), 200); }
  }
  toast(text, ms = 2800) {
    // interface text has no emoji: a leading one in a hint ("🏨 Tap a letter…") is dropped, the words stay
    const t = h('div.uw-toast', { role: 'status' }, typeof text === 'string' ? stripEmoji(text) : text);
    // phones: just above the sheet, so a hint never covers the pins it talks about; desktop: top centre
    if (!this.side && this.snaps) { this.toasts.style.top = 'auto'; this.toasts.style.bottom = `${Math.round(this.H - this.sheetTop() + 10)}px`; }
    else { this.toasts.style.top = ''; this.toasts.style.bottom = ''; }
    // the first touch on the map puts it away (the hint has done its job once someone starts exploring)
    const born = performance.now();
    const away = (e) => { if (performance.now() - born < 600 || !e.target.closest?.('.uw-map')) return; t.classList.remove('is-in'); setTimeout(() => t.remove(), 300); document.removeEventListener('pointerdown', away, true); };
    document.addEventListener('pointerdown', away, true);
    setTimeout(() => document.removeEventListener('pointerdown', away, true), ms + 400);
    this.toasts.append(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 300); }, ms);
    return t;
  }

  fatal(title, text) {
    this.root.append(h('div.uw-fatal', h('div.uw-fatal-card', h('div.uw-fatal-e', '🗺️'), h('h2', title), h('p', text))));
  }
}

/** what a card model would draw (functions ignored, DOM nodes by their markup) */
function cardSig(m) {
  try { return JSON.stringify(m, (k, v) => (k === 'refresh' || typeof v === 'function' ? undefined : v instanceof Node ? v.outerHTML : v)); } catch { return Math.random(); }
}

// ---------- helpers used by engine for card content ----------
export function mapsLink(name, lnglat) {
  const [lng, lat] = lnglat.map(round6);
  if (isIOS()) return `https://maps.apple.com/?q=${encodeURIComponent(name || 'Pin')}&ll=${lat},${lng}`;
  return name ? `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},17z`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
export function walkMinutes(m) { return Math.max(1, Math.round(m / 80)); }
export { distM, fill, humanize, fmtMetric, dayHeading, dayCaption };
