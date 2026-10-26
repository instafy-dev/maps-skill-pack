// map-pack engine: a small 360° (equirectangular) photo viewer. Kit-owned file. Our own code (no dependency):
// one WebGL quad whose fragment shader turns each screen pixel into a view ray and samples the panorama.
// Drag to look around, pinch / wheel / +- to zoom, arrow keys to turn. Used by photos.js (ENGINE-SPEC-v0.2 §7.3) when
// engine/vendor/pannellum is not vendored or `photos.viewer` is "builtin".

const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const FS = `precision highp float;
varying vec2 v; uniform sampler2D tex; uniform float yaw, pitch, f, aspect;
const float PI = 3.141592653589793;
void main(){
  vec3 d = normalize(vec3(v.x * aspect, v.y, f));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  float lon = atan(d.x, d.z), lat = asin(clamp(d.y, -1.0, 1.0));
  gl_FragColor = texture2D(tex, vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI));
}`;
const rad = (d) => (d * Math.PI) / 180;

/**
 * @param {HTMLElement} host   @param {object} o { src, yaw (deg, 0 = picture centre), pitch, hfov, onLoad, onError }
 * @returns {{ lookAt(yaw, pitch?), destroy(), canvas }}
 */
export function createPano(host, o = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'uw-pano-canvas';
  canvas.setAttribute('aria-label', '360° street photo: drag to look around');
  canvas.tabIndex = 0;
  host.append(canvas);
  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false }) || canvas.getContext('experimental-webgl');
  const st = { yaw: rad(o.yaw || 0), pitch: rad(o.pitch || 0), hfov: o.hfov || 90, ready: false, raf: 0, anim: null, dead: false };
  if (!gl) { o.onError?.(new Error('WebGL not available')); return { canvas, lookAt() {}, destroy() { canvas.remove(); } }; }
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { o.onError?.(new Error('viewer shader failed')); return { canvas, lookAt() {}, destroy() { canvas.remove(); } }; }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uYaw = U('yaw'), uPitch = U('pitch'), uF = U('f'), uAspect = U('aspect');
  const tex = gl.createTexture();

  const draw = () => {
    st.raf = 0;
    if (st.dead || !st.ready) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const aspect = w / Math.max(1, h);
    // hfov is horizontal; on a portrait phone that would make the vertical view ~130° (stretched sky and road), so
    // the vertical field is capped at 100° and the horizontal one follows
    const vmax = rad(100), hf = Math.min(rad(st.hfov), 2 * Math.atan(Math.tan(vmax / 2) * aspect));
    const f = aspect / Math.tan(hf / 2);
    gl.uniform1f(uYaw, st.yaw); gl.uniform1f(uPitch, st.pitch); gl.uniform1f(uF, f); gl.uniform1f(uAspect, aspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const redraw = () => { if (!st.raf) st.raf = requestAnimationFrame(draw); };
  const clampView = () => { st.hfov = Math.max(35, Math.min(110, st.hfov)); st.pitch = Math.max(-rad(80), Math.min(rad(80), st.pitch)); };

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    if (st.dead) return;
    let source = img;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    if (img.naturalWidth > max) { // downscale very large panoramas to what the GPU can hold
      const c = document.createElement('canvas'); c.width = max; c.height = Math.round(max * img.naturalHeight / img.naturalWidth);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); source = c;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch (e) { o.onError?.(e); return; }
    st.ready = true; redraw(); o.onLoad?.();
  };
  img.onerror = () => { if (!st.dead) o.onError?.(new Error('photo failed to load')); };
  img.src = o.src;

  // ----- gestures -----
  const pts = new Map(); let pinch = null;
  const onDown = (e) => { canvas.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); st.anim = null; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), hfov: st.hfov }; } };
  const onMove = (e) => {
    const prev = pts.get(e.pointerId); if (!prev) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); st.hfov = pinch.hfov * (pinch.d / Math.max(20, d)); clampView(); redraw(); return; }
    if (pts.size !== 1) return;
    const k = rad(st.hfov) / Math.max(1, canvas.clientWidth);
    st.yaw -= (e.clientX - prev[0]) * k; st.pitch += (e.clientY - prev[1]) * k; clampView(); redraw();
  };
  const onUp = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  const onWheel = (e) => { e.preventDefault(); st.hfov *= Math.exp(e.deltaY * 0.0015); clampView(); redraw(); };
  const onKey = (e) => {
    const k = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, 6], ArrowDown: [0, -6] }[e.key];
    if (k) { st.yaw += rad(k[0]); st.pitch += rad(k[1]); clampView(); redraw(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { st.hfov /= 1.15; clampView(); redraw(); }
    else if (e.key === '-') { st.hfov *= 1.15; clampView(); redraw(); }
  };
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : null; ro?.observe(canvas);

  return {
    canvas,
    get ready() { return st.ready; },
    view: () => ({ yaw: (st.yaw * 180) / Math.PI, pitch: (st.pitch * 180) / Math.PI, hfov: st.hfov }),
    lookAt(yawDeg, pitchDeg = 0, ms = 600) {
      const y0 = st.yaw, p0 = st.pitch, h0 = st.hfov;
      let y1 = rad(yawDeg); while (y1 - y0 > Math.PI) y1 -= 2 * Math.PI; while (y1 - y0 < -Math.PI) y1 += 2 * Math.PI;
      const p1 = rad(pitchDeg), t0 = performance.now(), a = st.anim = {};
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const step = (now) => {
        if (st.anim !== a || st.dead) return;
        const t = reduce ? 1 : Math.min(1, (now - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        st.yaw = y0 + (y1 - y0) * e; st.pitch = p0 + (p1 - p0) * e; st.hfov = h0 + (90 - h0) * e; draw();
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    destroy() {
      st.dead = true; cancelAnimationFrame(st.raf); ro?.disconnect();
      try { gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog); gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* */ }
      canvas.remove();
    },
  };
}
