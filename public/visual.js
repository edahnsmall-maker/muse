/*
 * Reactive visuals — four modes the user can cycle through.
 *
 * Deliberately Canvas 2D, not a WebGL shader. Three shader iterations failed
 * to produce colour or legible data-correspondence, because shader colour
 * grading had to be written blind (no way to compile or view GLSL here) and
 * it twice hit GPU float-precision bugs. Canvas 2D uses explicit rgba
 * colours, real blur (ctx.filter — fine, since Web Bluetooth already
 * restricts this page to Chrome/Edge), and removes that whole bug class.
 * Rendering happens into a small offscreen buffer that is then upscaled,
 * which is both fast and gives soft, watercolour-ish edges for free.
 *
 * The modes:
 *   Flow   — chronological. Your data painted as it happens, scrolling right
 *            to left, one coloured ribbon per electrode. Data-correspondence
 *            is literal: the picture IS the history.
 *   Bloom  — no lines at all. Soft colour gradients emerge only when
 *            something significant actually happens in the data.
 *   Field  — one soft wavy band of colour per sensor (the "reference image"
 *            look), now with a genuinely distinct hue per electrode.
 *   Breath — austere. Slow breathing only, nothing per-channel, nothing to
 *            read or chase. The "mirror mode" of the roadmap's Zen framing.
 *
 * Exposed as createZenVisual() with a setCalm() method so the older Mind
 * Monitor page (index.html) keeps working unchanged.
 */
function createZenVisual(canvas) {
  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas'); // per-frame compose target
  const acc = document.createElement('canvas'); // persistent accumulation (Flow)
  const tmp = document.createElement('canvas'); // scroll helper for Flow
  const bctx = buf.getContext('2d');
  const actx = acc.getContext('2d');
  const tctx = tmp.getContext('2d');

  const BUF_MAX_W = 560; // small buffer => soft upscale + cheap blur
  let BW = 0, BH = 0;

  const clamp01 = (v) => Math.max(0, Math.min(1, v == null || Number.isNaN(v) ? 0 : v));
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
  const mixColor = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
  ];

  let state = {
    calm: 0.5, noise: 0, breathPeriod: 0,
    bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0 })),
  };
  let smooth = { calm: 0.5, noise: 0, breathPeriod: 0, levels: [0.5, 0.5, 0.5, 0.5] };

  let modeIndex = 0;
  const detector = new VizCore.EventDetector();
  const blooms = new VizCore.BloomField();

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    const scale = Math.min(1, BUF_MAX_W / canvas.width);
    BW = Math.max(160, Math.round(canvas.width * scale));
    BH = Math.max(90, Math.round(canvas.height * scale));
    for (const c of [buf, acc, tmp]) { c.width = BW; c.height = BH; }
  }
  addEventListener('resize', resize); resize();

  function paintBase(c) {
    const g = c.createLinearGradient(0, 0, 0, BH);
    g.addColorStop(0, '#070a18');
    g.addColorStop(1, '#03050d');
    c.fillStyle = g;
    c.fillRect(0, 0, BW, BH);
  }

  // ---- Flow: chronological watercolour ---------------------------------
  function renderFlow(nowMs, dtSec) {
    // Scroll the persistent buffer left. Fractional offsets make drawImage
    // interpolate, which is exactly the soft bleed we want for watercolour.
    const dx = Math.max(0.25, dtSec * (BW / 45)); // ~45s of history on screen
    tctx.clearRect(0, 0, BW, BH);
    tctx.drawImage(acc, 0, 0);
    actx.clearRect(0, 0, BW, BH);
    actx.globalAlpha = 0.994; // slow fade so old paint dissolves away
    actx.drawImage(tmp, -dx, 0);
    actx.globalAlpha = 1;

    actx.globalCompositeOperation = 'lighter';
    const x = BW - 2;
    const unit = BH / 300;
    state.bands.forEach((b, i) => {
      const col = VizCore.CHANNEL_COLORS[i];
      const y = BH * (1 - clamp01(smooth.levels[i]));
      const r = Math.max(2, (4 + 8 * smooth.calm) * unit * 3);
      const g = actx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(col, 0.5));
      g.addColorStop(1, rgba(col, 0));
      actx.fillStyle = g;
      actx.fillRect(x - r, y - r, r * 2, r * 2);
      if (b.spike > 0.25) {
        const sr = r * 2.4;
        const sg = actx.createRadialGradient(x, y, 0, x, y, sr);
        sg.addColorStop(0, `rgba(255,255,255,${0.55 * b.spike})`);
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        actx.fillStyle = sg;
        actx.fillRect(x - sr, y - sr, sr * 2, sr * 2);
      }
    });
    actx.globalCompositeOperation = 'source-over';

    paintBase(bctx);
    bctx.globalCompositeOperation = 'lighter';
    bctx.drawImage(acc, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Bloom: gradients that emerge on real events ----------------------
  function renderBloom(nowMs) {
    paintBase(bctx);
    const active = blooms.update(nowMs);
    bctx.globalCompositeOperation = 'lighter';
    // No ctx.filter here on purpose: a multi-stop radial gradient is already
    // smooth, and blurring every bloom individually would mean up to a dozen
    // full-size blur passes per frame for no visible gain.
    for (const b of active) {
      const R = Math.max(4, b.radius * Math.min(BW, BH) * 1.7);
      const cx = b.x * BW, cy = b.y * BH;
      const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, rgba(b.color, 0.55 * b.alpha));
      g.addColorStop(0.45, rgba(b.color, 0.22 * b.alpha));
      g.addColorStop(1, rgba(b.color, 0));
      bctx.fillStyle = g;
      bctx.beginPath(); bctx.arc(cx, cy, R, 0, Math.PI * 2); bctx.fill();
    }
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Field: one soft wavy coloured band per sensor --------------------
  function renderField(tSec) {
    paintBase(bctx);
    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(3, Math.round((BW / 46) * (0.55 + 0.9 * smooth.calm)))}px)`;
    bctx.lineCap = 'round';
    state.bands.forEach((b, i) => {
      const col = VizCore.CHANNEL_COLORS[i];
      const lvl = clamp01(smooth.levels[i]);
      const baseY = BH * (0.27 + 0.155 * i);
      const amp = BH * (0.05 + 0.055 * (1 - smooth.calm));
      const thick = BH * (0.045 + 0.11 * smooth.calm) * (0.6 + 0.8 * lvl);
      bctx.beginPath();
      const steps = 26;
      for (let s = 0; s <= steps; s++) {
        const px = (s / steps) * BW;
        const py = baseY + amp * VizCore.wobble(tSec * (0.45 + 0.11 * i) + (s / steps) * 3.2, i + 1);
        if (s === 0) bctx.moveTo(px, py); else bctx.lineTo(px, py);
      }
      bctx.strokeStyle = rgba(col, 0.28 + 0.4 * lvl);
      bctx.lineWidth = Math.max(1, thick);
      bctx.stroke();
      if (b.spike > 0.25) {
        bctx.strokeStyle = `rgba(255,255,255,${0.5 * b.spike})`;
        bctx.lineWidth = Math.max(1, thick * 0.3);
        bctx.stroke();
      }
    });
    bctx.filter = 'none';
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Breath: austere, slow, nothing per-channel -----------------------
  function renderBreath(nowMs) {
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * smooth.calm;
    const b = 0.5 + 0.5 * Math.sin((nowMs / 1000) * ((2 * Math.PI) / period));
    paintBase(bctx);
    bctx.globalCompositeOperation = 'lighter';
    // Same reasoning as Bloom: the radial gradient is already smooth, so no
    // blur pass is needed here.
    const cool = [150, 190, 255], warm = [255, 234, 196];
    const col = mixColor(cool, warm, smooth.calm);
    const cx = BW / 2, cy = BH * 0.52;
    const R = Math.min(BW, BH) * (0.30 + 0.16 * b + 0.10 * smooth.calm);
    const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(col, 0.26 + 0.20 * b));
    g.addColorStop(0.55, rgba(col, 0.09));
    g.addColorStop(1, rgba(col, 0));
    bctx.fillStyle = g;
    bctx.beginPath(); bctx.arc(cx, cy, R, 0, Math.PI * 2); bctx.fill();
    bctx.globalCompositeOperation = 'source-over';
  }

  let last = performance.now();
  const start = last;
  function frame(now) {
    const dtSec = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Smooth the inputs so the picture glides rather than snapping.
    smooth.calm += 0.04 * (state.calm - smooth.calm);
    smooth.noise += 0.15 * (state.noise - smooth.noise);
    smooth.breathPeriod += 0.01 * (state.breathPeriod - smooth.breathPeriod);
    for (let i = 0; i < 4; i++) {
      smooth.levels[i] += 0.06 * (clamp01(state.bands[i].level) - smooth.levels[i]);
    }

    const mode = VizCore.MODES[modeIndex].key;
    if (mode === 'flow') renderFlow(now, dtSec);
    else if (mode === 'bloom') renderBloom(now);
    else if (mode === 'field') renderField((now - start) / 1000);
    else renderBreath(now);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, BW, BH, 0, 0, canvas.width, canvas.height);

    // A faint veil when the signal itself is noisy — honest feedback that
    // what you're seeing is less trustworthy right now, rather than hiding
    // it inside a smoothed score.
    if (smooth.noise > 0.02) {
      ctx.fillStyle = `rgba(190,195,215,${0.05 * clamp01(smooth.noise)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function spawnEventBlooms(events, nowMs) {
    for (const ev of events) {
      if (ev.type === 'spike') {
        // Deterministic but varied placement, biased to that channel's band.
        const jx = 0.5 + 0.34 * VizCore.wobble(nowMs / 1000, ev.channel + 1);
        const jy = 0.30 + 0.16 * ev.channel + 0.05 * VizCore.wobble(nowMs / 700, ev.channel + 5);
        blooms.spawn({
          x: clamp01(jx), y: clamp01(jy),
          color: VizCore.CHANNEL_COLORS[ev.channel] || [200, 210, 255],
          strength: 0.9, at: nowMs,
        });
      } else if (ev.type === 'settled') {
        blooms.spawn({ x: 0.5, y: 0.5, color: [255, 226, 178], strength: 1, at: nowMs });
      } else if (ev.type === 'stirred') {
        blooms.spawn({ x: 0.5, y: 0.5, color: [140, 175, 255], strength: 0.8, at: nowMs });
      }
    }
  }

  return {
    // Full state (direct.html). Also drives event detection for Bloom mode.
    setState(next) {
      // Always normalise to exactly 4 bands — the render loop indexes 0..3
      // every frame, so a short or missing array must never reach it.
      const bands = [0, 1, 2, 3].map((i) => {
        const src = (next.bands && next.bands[i]) || state.bands[i] || {};
        return { level: src.level != null ? src.level : 0.5, spike: src.spike || 0 };
      });
      state = {
        calm: next.calm != null ? next.calm : state.calm,
        noise: next.noise != null ? next.noise : state.noise,
        breathPeriod: next.breathPeriod != null ? next.breathPeriod : state.breathPeriod,
        bands,
      };
      const events = detector.update({
        calm: state.calm,
        spikes: state.bands.map((b) => b.spike),
      });
      if (events.length) spawnEventBlooms(events, performance.now());
    },
    // Back-compat for the Mind Monitor page, which only has a calm value.
    setCalm(v) { this.setState({ calm: v }); },
    setBreathPeriod(v) { this.setState({ breathPeriod: v == null ? 0 : v }); },
    setNoise(v) { this.setState({ noise: v == null ? 0 : v }); },
    cycleMode() {
      modeIndex = VizCore.nextMode(modeIndex);
      actx.clearRect(0, 0, BW, BH); // don't carry Flow's painting across modes
      return VizCore.MODES[modeIndex];
    },
    currentMode() { return VizCore.MODES[modeIndex]; },
  };
}
