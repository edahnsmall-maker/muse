/*
 * Reactive visuals — several modes the user can switch between.
 *
 * Canvas 2D, not a WebGL shader: three shader iterations failed to produce
 * colour or legible data-correspondence, because GLSL had to be written blind
 * (nothing in this toolchain can compile or view it) and it twice hit GPU
 * float-precision bugs visible only on real hardware. Canvas 2D uses explicit
 * rgba colours, real blur (ctx.filter — fine, Web Bluetooth already restricts
 * this page to Chrome/Edge), and is testable via a stubbed context.
 *
 * Rendering goes into a small offscreen buffer that is upscaled to the screen:
 * fast, and soft edges for free.
 *
 * Exposed as createZenVisual() with setCalm() so the Mind Monitor page
 * (index.html) keeps working unchanged.
 */
function createZenVisual(canvas) {
  const ctx = canvas.getContext('2d');
  const buf = document.createElement('canvas'); // per-frame compose target
  const lay = document.createElement('canvas'); // scratch layer (Flow ribbons)
  const bctx = buf.getContext('2d');
  const lctx = lay.getContext('2d');

  const BUF_MAX_W = 560; // small buffer => soft upscale + cheap blur
  let BW = 0, BH = 0;

  const clamp01 = (v) => Math.max(0, Math.min(1, v == null || Number.isNaN(v) ? 0 : v));
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
  const mixColor = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
  ];

  let state = {
    calm: 0.5, noise: 0, breathPeriod: 0, activity: 0.5,
    bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0 })),
  };
  let smooth = {
    calm: 0.5, noise: 0, breathPeriod: 0, activity: 0.5,
    levels: [0.5, 0.5, 0.5, 0.5],
    // Eclipse's void grows on a much longer time constant than everything
    // else — the user asked for it to grow SLOWLY, and a void that twitched
    // with every calm wobble would undo the whole point of the image.
    voidCalm: 0.5,
  };

  let modeIndex = 0;
  let patternIndex = 0;
  const detector = new VizCore.EventDetector();
  // Blooms live much longer than the first version (7s -> 16s): appearing and
  // dissolving slowly was an explicit request, and slow overlapping blooms
  // merge into a field instead of reading as separate "street lights".
  const blooms = new VizCore.BloomField({ max: 14, life: 16000 });

  // Flow renders from an explicit history buffer rather than by repeatedly
  // blitting a canvas onto itself. The old approach had two compounding bugs:
  // the per-frame fade (0.994^60 ≈ 0.70/sec) destroyed paint in ~10s while a
  // full crossing took ~37s, so nothing ever travelled — it just sat at the
  // right edge; and sub-pixel self-blits re-interpolated every frame into
  // mush. Drawing from data is deterministic and cannot fail to move.
  const FLOW_MAX = 240; // ~60s of history at ~4 samples/sec
  const history = [];

  let sessionSec = 0;   // monotonic, for placing blooms along a slow sweep
  let breathPhase = 0;  // integrated radians — see renderBreath
  let patternT = 0;     // seconds accumulated for patterned breathing
  let breathLabel = null;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    const scale = Math.min(1, BUF_MAX_W / canvas.width);
    BW = Math.max(160, Math.round(canvas.width * scale));
    BH = Math.max(90, Math.round(canvas.height * scale));
    for (const c of [buf, lay]) { c.width = BW; c.height = BH; }
  }
  addEventListener('resize', resize); resize();

  function paintBase(c) {
    const g = c.createLinearGradient(0, 0, 0, BH);
    g.addColorStop(0, '#070a18');
    g.addColorStop(1, '#03050d');
    c.fillStyle = g;
    c.fillRect(0, 0, BW, BH);
  }

  // ---- Eclipse: a growing void with a corona of mental activity ---------
  // Stillness is rendered as ABSENCE: as calm rises the black void expands and
  // pushes the bright, busy corona out toward the margins. Settling literally
  // quiets the screen. Thinking (DSP.ActivityTracker — beta level, band-power
  // variability, and rate of abrupt shifts) makes the corona reach further and
  // flare harder. Movement noise is NOT thinking and is handled separately.
  function renderEclipse(tSec) {
    // Light ground, unlike every other mode. Saturated colour composited onto
    // near-black trends toward pale grey; on a light ground it reads vivid.
    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#f8f5f2');
    bg.addColorStop(1, '#ece7e3');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    const cx = BW / 2, cy = BH / 2;
    const maxR = Math.min(BW, BH) * 0.5;
    const voidR = Math.max(2, maxR * (0.28 + 0.34 * clamp01(smooth.voidCalm)));
    const act = clamp01(smooth.activity);

    bctx.filter = `blur(${Math.max(3, Math.round(BW / 34))}px)`;
    for (let i = 0; i < 4; i++) {
      const col = VizCore.CORONA_COLORS[i];
      const lvl = clamp01(smooth.levels[i]);
      const spike = clamp01(state.bands[i].spike);
      // Reach grows with activity and with a spike; a channel sitting in alpha
      // (restful) pulls its own lobe back in toward the void.
      const span = Math.max(1, voidR * (0.26 + 1.25 * act + 0.55 * spike) * (0.55 + 0.65 * (1 - lvl)));
      const N = 48;
      bctx.beginPath();
      for (let s = 0; s <= N; s++) {
        const a = (s / N) * Math.PI * 2;
        // Angular variation: this is what makes it peek and move like a real
        // corona rather than sitting as a perfect ring.
        const flare = 0.60 + 0.40 * VizCore.wobble(tSec * (0.20 + 0.05 * i) + a * 2.0, i + 1);
        const r = voidR * 0.94 + span * flare;
        const x = cx + Math.cos(a + i * 1.5708) * r;
        const y = cy + Math.sin(a + i * 1.5708) * r;
        if (s === 0) bctx.moveTo(x, y); else bctx.lineTo(x, y);
      }
      bctx.closePath();
      const rg = bctx.createRadialGradient(cx, cy, voidR * 0.88, cx, cy, Math.max(voidR + 1, voidR + span * 1.25));
      rg.addColorStop(0, rgba(col, 0.50 + 0.34 * act));
      rg.addColorStop(0.42, rgba(col, 0.26 * (0.45 + act)));
      rg.addColorStop(1, rgba(col, 0));
      bctx.fillStyle = rg;
      bctx.fill();
    }
    bctx.filter = 'none';

    // The void itself: flat, absolute black, hard-edged against the corona.
    bctx.fillStyle = '#050506';
    bctx.beginPath(); bctx.arc(cx, cy, voidR, 0, Math.PI * 2); bctx.fill();
  }

  // ---- Flow: chronological watercolour ribbons --------------------------
  function renderFlow() {
    paintBase(bctx);
    if (history.length < 2) return;

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.filter = `blur(${Math.max(2, Math.round(BW / 90))}px)`;
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';

    const xOf = (i) => ((FLOW_MAX - history.length + i) / (FLOW_MAX - 1)) * BW;

    for (let ch = 0; ch < 4; ch++) {
      const col = VizCore.CHANNEL_COLORS[ch];
      // Two passes per channel: a wide faint wash (the watercolour bleed) and
      // a narrower brighter core. 8 strokes/frame total, not per-segment.
      for (const pass of [{ w: 0.115, a: 0.13 }, { w: 0.030, a: 0.48 }]) {
        lctx.beginPath();
        for (let i = 0; i < history.length; i++) {
          const x = xOf(i);
          const y = BH * (1 - history[i].levels[ch]);
          if (i === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
        }
        lctx.strokeStyle = rgba(col, pass.a);
        lctx.lineWidth = Math.max(1, BH * pass.w);
        lctx.stroke();
      }
    }

    // Spikes: small bright marks left in the record where they happened.
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      for (let ch = 0; ch < 4; ch++) {
        if (h.spikes[ch] > 0.5) {
          const x = xOf(i), y = BH * (1 - h.levels[ch]);
          const r = Math.max(2, BH * 0.045);
          const g = lctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(255,255,255,${0.55 * h.spikes[ch]})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          lctx.fillStyle = g;
          lctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
    }
    lctx.filter = 'none';

    // Age fade: erase progressively toward the left so older paint dissolves.
    lctx.globalCompositeOperation = 'destination-out';
    const fade = lctx.createLinearGradient(0, 0, BW, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0.92)');
    fade.addColorStop(0.42, 'rgba(0,0,0,0)');
    lctx.fillStyle = fade;
    lctx.fillRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'source-over';

    bctx.globalCompositeOperation = 'lighter';
    bctx.drawImage(lay, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Bloom: slow gradients that emerge on real events -----------------
  function renderBloom(nowMs) {
    paintBase(bctx);
    const active = blooms.update(nowMs);
    bctx.globalCompositeOperation = 'lighter';
    // No blur pass: a multi-stop radial gradient is already smooth, and
    // blurring a dozen blooms individually would cost far more than it adds.
    for (const b of active) {
      // Larger and fainter than the first version so blooms overlap and read
      // as one merging field rather than as separate points of light.
      const R = Math.max(4, b.radius * Math.min(BW, BH) * 2.6);
      const cx = b.x * BW, cy = b.y * BH;
      const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, rgba(b.color, 0.34 * b.alpha));
      g.addColorStop(0.35, rgba(b.color, 0.18 * b.alpha));
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
    for (let i = 0; i < 4; i++) {
      const col = VizCore.CHANNEL_COLORS[i];
      const lvl = clamp01(smooth.levels[i]);
      // The band's vertical POSITION now moves with its channel's level, not
      // just its thickness — previously every band sat at a fixed height, so
      // there was little to see ("doesn't really look like anything").
      const baseY = BH * (0.27 + 0.155 * i) + (0.5 - lvl) * BH * 0.10;
      const amp = BH * (0.05 + 0.055 * (1 - smooth.calm));
      const thick = BH * (0.045 + 0.11 * smooth.calm) * (0.6 + 0.8 * lvl);
      const pts = [];
      const steps = 26;
      for (let s = 0; s <= steps; s++) {
        const px = (s / steps) * BW;
        const py = baseY + amp * VizCore.wobble(tSec * (0.45 + 0.11 * i) + (s / steps) * 3.2, i + 1);
        pts.push([px, py]);
      }
      // A faint wash filled downward from the ribbon gives the bands depth
      // and lets them bleed into each other instead of floating separately.
      const wash = bctx.createLinearGradient(0, baseY - thick, 0, baseY + thick * 3);
      wash.addColorStop(0, rgba(col, 0.13 * (0.4 + lvl)));
      wash.addColorStop(1, rgba(col, 0));
      bctx.beginPath();
      pts.forEach(([x, y], s) => (s === 0 ? bctx.moveTo(x, y) : bctx.lineTo(x, y)));
      bctx.lineTo(BW, baseY + thick * 3);
      bctx.lineTo(0, baseY + thick * 3);
      bctx.closePath();
      bctx.fillStyle = wash;
      bctx.fill();

      bctx.beginPath();
      pts.forEach(([x, y], s) => (s === 0 ? bctx.moveTo(x, y) : bctx.lineTo(x, y)));
      bctx.strokeStyle = rgba(col, 0.28 + 0.4 * lvl);
      bctx.lineWidth = Math.max(1, thick);
      bctx.stroke();

      if (state.bands[i].spike > 0.25) {
        bctx.strokeStyle = `rgba(255,255,255,${0.5 * state.bands[i].spike})`;
        bctx.lineWidth = Math.max(1, thick * 0.3);
        bctx.stroke();
      }
    }
    bctx.filter = 'none';
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Breath: austere, steady, slow in and slow out --------------------
  function renderBreath(dtSec) {
    const pattern = VizCore.BREATH_PATTERNS[patternIndex];
    let amount;
    if (pattern.phases) {
      patternT += dtSec;
      const r = VizCore.breathPattern(pattern, patternT);
      amount = r.amount; breathLabel = r.label;
    } else {
      const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * smooth.calm;
      // Integrate the phase instead of computing it as elapsedTime * omega.
      // That was a real bug: breathPeriod is continuously smoothed, and since
      // elapsed time is large, ANY change in period jumped the phase by a huge
      // amount — the visible flicker/unsteadiness. Integrating keeps the
      // motion continuous even while the measured rate drifts.
      breathPhase += (dtSec * 2 * Math.PI) / Math.max(1, period);
      if (breathPhase > Math.PI * 2) breathPhase -= Math.PI * 2;
      // Zero derivative at both ends => genuinely slow in, slow out.
      amount = 0.5 - 0.5 * Math.cos(breathPhase);
      breathLabel = amount > 0.5 ? 'Breathe in' : 'Breathe out';
    }

    paintBase(bctx);
    bctx.globalCompositeOperation = 'lighter';
    const cool = [150, 190, 255], warm = [255, 234, 196];
    const col = mixColor(cool, warm, smooth.calm);
    const cx = BW / 2, cy = BH * 0.5;
    // Radius depends ONLY on the breath, so the motion is steady. Calm shifts
    // colour and brightness instead — an unsteady radius was part of why this
    // mode felt jittery rather than restful.
    const R = Math.min(BW, BH) * (0.20 + 0.26 * amount);
    const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(col, 0.26 + 0.16 * smooth.calm));
    g.addColorStop(0.55, rgba(col, 0.10));
    g.addColorStop(1, rgba(col, 0));
    bctx.fillStyle = g;
    bctx.beginPath(); bctx.arc(cx, cy, R, 0, Math.PI * 2); bctx.fill();
    // A faint ring at the current extent gives the eye something definite to
    // follow without adding clutter.
    bctx.strokeStyle = rgba(col, 0.13 + 0.10 * amount);
    bctx.lineWidth = Math.max(1, BH * 0.004);
    bctx.beginPath(); bctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2); bctx.stroke();
    bctx.globalCompositeOperation = 'source-over';
  }

  let last = performance.now();
  const start = last;
  function frame(now) {
    const dtSec = Math.min(0.1, (now - last) / 1000);
    last = now;
    sessionSec += dtSec;

    smooth.calm += 0.04 * (state.calm - smooth.calm);
    smooth.activity += 0.05 * (state.activity - smooth.activity);
    // ~4s time constant: the void must grow slowly and never twitch.
    smooth.voidCalm += 0.004 * (state.calm - smooth.voidCalm);
    smooth.noise += 0.15 * (state.noise - smooth.noise);
    smooth.breathPeriod += 0.01 * (state.breathPeriod - smooth.breathPeriod);
    for (let i = 0; i < 4; i++) {
      smooth.levels[i] += 0.06 * (clamp01(state.bands[i].level) - smooth.levels[i]);
    }

    const mode = VizCore.MODES[modeIndex].key;
    if (mode === 'eclipse') renderEclipse((now - start) / 1000);
    else if (mode === 'flow') renderFlow();
    else if (mode === 'bloom') renderBloom(now);
    else if (mode === 'field') renderField((now - start) / 1000);
    else renderBreath(dtSec);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, BW, BH, 0, 0, canvas.width, canvas.height);

    if (smooth.noise > 0.02) {
      // Eclipse renders on a light ground, so a pale veil would be invisible
      // there — darken instead, so "the signal is unreliable right now" reads
      // the same way in every mode.
      const veil = mode === 'eclipse' ? '55,50,60' : '190,195,215';
      ctx.fillStyle = `rgba(${veil},${0.05 * clamp01(smooth.noise)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function spawnEventBlooms(events, nowMs) {
    for (const ev of events) {
      if (ev.type === 'spike') {
        // Placed along a slow left-to-right sweep rather than pseudo-randomly,
        // so successive blooms form a drifting procession that reads as one
        // evolving field — the fix for "looks like random street lights".
        const sweep = (sessionSec % 70) / 70;
        const jx = 0.10 + 0.80 * sweep;
        const jy = 0.26 + 0.16 * ev.channel + 0.05 * VizCore.wobble(sessionSec, ev.channel + 5);
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
        activity: next.activity != null ? next.activity : state.activity,
        bands,
      };
      history.push({
        levels: bands.map((b) => clamp01(b.level)),
        spikes: bands.map((b) => clamp01(b.spike)),
        calm: clamp01(state.calm),
      });
      if (history.length > FLOW_MAX) history.shift();

      const events = detector.update({ calm: state.calm, spikes: bands.map((b) => b.spike) });
      if (events.length) spawnEventBlooms(events, performance.now());
    },
    // Back-compat for the Mind Monitor page, which only has a calm value.
    setCalm(v) { this.setState({ calm: v }); },
    setBreathPeriod(v) { this.setState({ breathPeriod: v == null ? 0 : v }); },
    setNoise(v) { this.setState({ noise: v == null ? 0 : v }); },
    setMode(i) {
      if (i >= 0 && i < VizCore.MODES.length) modeIndex = i;
      lctx.clearRect(0, 0, BW, BH);
      return VizCore.MODES[modeIndex];
    },
    cycleMode() { return this.setMode(VizCore.nextMode(modeIndex)); },
    currentMode() { return VizCore.MODES[modeIndex]; },
    modes() { return VizCore.MODES; },
    cyclePattern() {
      patternIndex = VizCore.nextPattern(patternIndex);
      patternT = 0; // restart the cycle so it begins on an inhale
      return VizCore.BREATH_PATTERNS[patternIndex];
    },
    currentPattern() { return VizCore.BREATH_PATTERNS[patternIndex]; },
    breathCue() { return breathLabel; },
  };
}
