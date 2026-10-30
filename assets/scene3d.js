/* Conf DDL · the city scene in 2.5D, drifting through the day.
   Loaded only when a generated panorama with a depth map is on screen (and motion and WebGL are allowed).
   One WebGL canvas sits inside the backdrop picture it upgrades, framed exactly as that picture's CSS
   (cover, panning across over 140 s), so it can fade in over it. Each pixel is displaced by its depth as a
   slow camera drifts (and follows the mouse or the tilt of a phone): near roofs move, the far hills and sky
   stay. The four moods are edits of one picture with the same layout, so they share the depth map and are
   blended by the reader's clock: night → dawn → day → dusk → night, with no hard switch. */
(() => {
  "use strict";
  const PAN_MS = 140000, FPS = 30, K = 0.014; // K: how far the nearest pixels travel, as a share of the screen

  // the clock's keyframes (local hours) and the mood each holds; between two, the pictures blend
  const KEYS = [[4.5, "night"], [5.5, "dawn"], [6.4, "dawn"], [7.6, "day"], [16.4, "day"], [17.4, "dusk"], [18.4, "dusk"], [19.6, "night"]];
  const ease = x => x * x * (3 - 2 * x);
  function moodsAt(h) {
    for (let i = 0; i < KEYS.length; i++) {
      const [h0, a] = KEYS[i], [h1, b] = KEYS[(i + 1) % KEYS.length];
      const span = (h1 - h0 + 24) % 24, t = (h - h0 + 24) % 24;
      if (t < span) return a === b ? [a, a, 0] : [a, b, ease(t / span)];
    }
    return ["night", "night", 0];
  }
  const preview = Number(new URLSearchParams(location.search).get("hour"));
  const hourNow = () => {
    if (preview >= 0 && preview < 24 && new URLSearchParams(location.search).has("hour")) return preview;
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };

  // the CSS pan is `ease-in-out` (cubic-bezier(.42, 0, .58, 1)), alternating, phased to the document timeline
  function bezier(x) {
    let t = x;
    for (let i = 0; i < 6; i++) {
      const bx = 3 * (1 - t) * (1 - t) * t * .42 + 3 * (1 - t) * t * t * .58 + t * t * t - x;
      const dx = 3 * (1 - t) * (1 - t) * .42 + 6 * (1 - t) * t * (.58 - .42) + 3 * t * t * (1 - .58);
      if (Math.abs(bx) < 1e-5 || !dx) break;
      t -= bx / dx;
    }
    return 3 * (1 - t) * t * t + t * t * t;
  }
  const panAt = ms => { const t = ms / PAN_MS, k = Math.floor(t); const p = t - k; return bezier(k % 2 ? 1 - p : p); };

  const VS = "attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}";
  const FS = `precision mediump float;varying vec2 v;
uniform sampler2D uA,uB,uD;uniform float uMix;uniform vec2 uShift;uniform vec4 uMap;
void main(){
  vec2 uv=vec2(v.x*uMap.x+uMap.y,v.y*uMap.z+uMap.w),p=uv;
  for(int i=0;i<5;i++){p=uv-uShift*texture2D(uD,p).r;}
  p=clamp(p,0.,1.);
  gl_FragColor=mix(texture2D(uA,p),texture2D(uB,p),uMix);
}`;

  function glOf(cv) {
    const gl = cv.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = n => gl.getUniformLocation(pr, n);
    gl.uniform1i(u("uA"), 0); gl.uniform1i(u("uB"), 1); gl.uniform1i(u("uD"), 2);
    return { gl, uMix: u("uMix"), uShift: u("uShift"), uMap: u("uMap") };
  }
  function texture(gl, img) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3); // a spare unit, so loading never disturbs the ones being drawn with
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, val);
    return t;
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; });

  // one shared camera: a slow figure-of-eight, plus the mouse or the phone's tilt
  const cam = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener("pointermove", e => { if (e.pointerType === "mouse") { cam.tx = e.clientX / innerWidth * 2 - 1; cam.ty = e.clientY / innerHeight * 2 - 1; } }, { passive: true });
  addEventListener("deviceorientation", e => {
    if (e.gamma == null) return;
    cam.tx = Math.max(-1, Math.min(1, e.gamma / 25)); cam.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 25));
  }, { passive: true });

  /* attach(el, { scenes, depth, fixed, paused, onMood }) — el is the backdrop <div> (cover, panned by CSS).
     scenes: { day, dawn, dusk, night } urls; fixed: a mood picked by hand (no clock); paused(): skip drawing;
     onMood(mood): the mood that now dominates. */
  async function attach(el, opt) {
    const cv = document.createElement("canvas");
    cv.className = "page-bg-3d";
    const g = glOf(cv);
    if (!g) return null;
    const { gl } = g;
    const tex = {}, ar = { w: 2400, h: 960 };
    let fixed = opt.fixed || null, lastMood = null;
    const want = () => { const [a, b] = fixed ? [fixed, fixed] : moodsAt(hourNow()); return [a, b].filter(m => opt.scenes[m]); };
    const load = async m => {
      if (tex[m] || !opt.scenes[m]) return;
      tex[m] = "loading";
      try { const img = await loadImg(opt.scenes[m]); ar.w = img.naturalWidth; ar.h = img.naturalHeight; tex[m] = texture(gl, img); }
      catch { delete tex[m]; }
    };
    try {
      const [d] = await Promise.all([loadImg(opt.depth), ...want().map(load)]);
      tex.depth = texture(gl, d);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tex.depth);
    } catch { return null; }
    if (!el.isConnected) return null;
    el.append(cv);
    el.dataset.live = "1";
    // the other moods come in once the first frame is up
    setTimeout(() => ["day", "dawn", "dusk", "night"].forEach(load), 1500);

    const near = m => tex[m] && tex[m] !== "loading" ? m : ["day", "dawn", "dusk", "night"].find(k => tex[k] && tex[k] !== "loading");
    let last = 0, shown = false, t0 = performance.now();
    const frame = now => {
      if (!el.isConnected) { gl.getExtension("WEBGL_lose_context")?.loseContext(); return; }
      requestAnimationFrame(frame);
      if (now - last < 1000 / FPS - 2 || document.hidden || opt.paused()) return;
      last = now;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      const W = Math.round(el.clientWidth * dpr), H = Math.round(el.clientHeight * dpr);
      if (!W || !H) return;
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; gl.viewport(0, 0, W, H); }
      // background-size: cover; background-position: <pan>% 45%
      const ia = ar.w / ar.h, ca = W / H;
      let fx = 1, ox = 0, fy = 1, oy = 0;
      if (ia > ca) { fx = ca / ia; ox = panAt(document.timeline.currentTime) * (1 - fx); }
      else { fy = ia / ca; oy = .45 * (1 - fy); }
      gl.uniform4f(g.uMap, fx, ox, fy, oy);
      const t = now / 1000;
      cam.x += (cam.tx - cam.x) * .04; cam.y += (cam.ty - cam.y) * .04;
      const cx = .55 * Math.sin(t * 2 * Math.PI / 26) + .8 * cam.x, cy = .3 * Math.sin(t * 2 * Math.PI / 37) + .5 * cam.y;
      // the depth grows in over a few seconds, so the canvas starts as the flat picture it fades in over
      const amp = Math.min(1, (now - t0) / 4000);
      gl.uniform2f(g.uShift, -cx * K * fx * amp, -cy * K * fy * amp);
      // the clock picks two moods and how far between them
      let [a, b, mix] = fixed ? [fixed, fixed, 0] : moodsAt(hourNow());
      load(a); load(b);
      a = near(a); b = near(b) || a;
      if (!a) return;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[a]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[b]);
      gl.uniform1f(g.uMix, a === b ? 0 : mix);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const mood = mix < .5 ? a : b;
      if (mood !== lastMood) { lastMood = mood; opt.onMood && opt.onMood(mood); }
      if (!shown) { shown = true; requestAnimationFrame(() => cv.classList.add("is-on")); }
    };
    requestAnimationFrame(frame);
    return { setFixed: m => { fixed = m || null; } };
  }

  const ok = (() => { try { return !!document.createElement("canvas").getContext("webgl"); } catch { return false; } })();
  window.Scene3D = { attach: ok ? attach : async () => null, moodsAt };
})();
