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
  const lay = document.createElement('canvas'); // scratch layer, drawn unblurred
  const rec = document.createElement('canvas'); // persistent record layer (Iris)
  const bctx = buf.getContext('2d');
  const lctx = lay.getContext('2d');
  const rctx = rec.getContext('2d');

  const BUF_MAX_W = 560; // small buffer => soft upscale + cheap blur
  let BW = 0, BH = 0;

  const clamp01 = (v) => Math.max(0, Math.min(1, v == null || Number.isNaN(v) ? 0 : v));
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
  const mixColor = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
  ];
  const smoothstep = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };

  let state = {
    calm: 0.5, noise: 0, breathPeriod: 0, activity: 0.5,
    metrics: {},   // composite scores by key, for Pulse
    bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0 })),
  };
  let smooth = {
    calm: 0.5, noise: 0, breathPeriod: 0, activity: 0.5,
    focus: 0.5,
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

  // Modes that bypass the shared small buffer and draw at full canvas
  // resolution. Both depend on crisp thin strokes, which a ~4x upscale
  // destroys; neither uses a blur filter, so they don't need the small buffer.
  const DIRECT_MODES = new Set(['flow', 'pulse', 'corona', 'silk']);

  // Which series Flow graphs: the four electrodes, or the four composites.
  // Follows the data panel's Sensors/Composites switch, because a main visual
  // showing raw electrodes while the panel and readout show composites is just
  // two unrelated pictures — and that mismatch is exactly what made a composite
  // look "dead" when the flat blue line was in fact an electrode.
  let seriesMode = 'sensors';

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
    for (const c of [buf, lay, rec]) { c.width = BW; c.height = BH; }
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
    // Both scores are adaptively normalised and so sit near 0.5, occupying only
    // about 0.35..0.75 in practice. Expanding that band to a full 0..1 is what
    // makes the change visible — the previous mapping moved the void radius by
    // only ~12% across a realistic session, i.e. not at all to the eye.
    const calmE = VizCore.expand(clamp01(smooth.voidCalm));
    const act = VizCore.expand(clamp01(smooth.activity));
    const voidR = Math.max(2, maxR * (0.12 + 0.62 * calmE));

    // ctx.filter blurs EVERY draw operation separately, so setting it once and
    // then issuing four fills costs FOUR full-buffer blur passes. Draw the
    // lobes unblurred into the scratch layer, then blit that layer ONCE with
    // blur — one pass instead of four.
    lctx.clearRect(0, 0, BW, BH);
    for (let i = 0; i < 4; i++) {
      const col = VizCore.CORONA_COLORS[i];
      const lvl = clamp01(smooth.levels[i]);
      const spike = clamp01(state.bands[i].spike);
      // Reach grows with activity and with a spike; a channel sitting in alpha
      // (restful) pulls its own lobe back in toward the void.
      const span = Math.max(1, voidR * (0.09 + 1.05 * act + 0.45 * spike) * (0.55 + 0.65 * (1 - lvl)));
      // How ragged and how fast the boundary churns is now driven BY ACTIVITY.
      // Previously the wobble amplitude was a constant (0.40), so the corona
      // seethed identically whether the mind was racing or completely settled —
      // which is exactly why it looked busy while focusing. At low activity the
      // boundary is nearly a smooth circle and drifts slowly; at high activity
      // it is deeply scalloped and moves several times faster.
      const churn = 0.06 + 0.94 * act;
      const N = 64;
      lctx.beginPath();
      for (let s = 0; s <= N; s++) {
        const a = (s / N) * Math.PI * 2;
        const timeScale = 0.06 + 0.34 * act;   // settled => slow drift
        const flare = 1.0 + churn * 0.62 * VizCore.wobble(tSec * timeScale * (1 + 0.25 * i) + a * (1.2 + 2.2 * act), i + 1);
        // Localise this hue to where the sensor actually is on the head, so
        // the flaring side of the image tells you WHICH sensor is active.
        const w = VizCore.lobeWeight(a, i);
        const r = voidR * 0.94 + span * flare * (0.16 + 0.84 * w);
        const x = cx + Math.sin(a) * r;
        const y = cy - Math.cos(a) * r;
        if (s === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.closePath();
      const rg = lctx.createRadialGradient(cx, cy, voidR * 0.88, cx, cy, Math.max(voidR + 1, voidR + span * 1.25));
      rg.addColorStop(0, rgba(col, 0.22 + 0.62 * act));
      rg.addColorStop(0.42, rgba(col, 0.30 * (0.20 + act)));
      rg.addColorStop(1, rgba(col, 0));
      lctx.fillStyle = rg;
      lctx.fill();
    }
    bctx.filter = `blur(${Math.max(3, Math.round(BW / 34))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';

    // The void itself: flat, absolute black, hard-edged against the corona.
    bctx.fillStyle = '#050506';
    bctx.beginPath(); bctx.arc(cx, cy, voidR, 0, Math.PI * 2); bctx.fill();
  }

  // ---- Iris: your session laid down as a rose window --------------------
  // A mandala oriented like the headband on your head: each sensor owns one
  // quadrant, at its real anatomical position. Two things happen at once —
  //   * a LIVE crown at the current radius, scalloped by each sensor's
  //     alpha/beta balance right now, and
  //   * every few seconds that crown is DEPOSITED permanently onto a record
  //     layer and the radius steps outward, like a growth ring.
  // So the disc accumulates into a readable record of the whole sit: which
  // minutes were whole and which were broken stay visible afterwards.
  //
  // Cheap by construction: the record layer is written on deposit ticks only
  // (not per frame) and composited back with a single drawImage.
  const IRIS_DEPOSIT_SEC = 6;
  // Reaching the rim used to take 200 × 5s ≈ 17 minutes, which meant the disc
  // was a small blob for the entire window in which someone decides whether it
  // is worth looking at. 84 × 6s ≈ 8.4 minutes, and each ring is a band you can
  // actually see rather than a sub-pixel sliver.
  const IRIS_MAX_RINGS = 84;
  const IRIS_PETALS = 6;        // per half-turn => 12 lobes around the disc
  let irisRing = 0;
  let irisLastDeposit = 0;

  function irisRadii() {
    const rMax = Math.min(BW, BH) * 0.60;
    // Starts at a third of the way out, not at 13%: the aperture is meant to be
    // an oculus, not the whole picture. Minute one should already have presence.
    const r0 = rMax * 0.34;
    const step = (rMax - r0) / IRIS_MAX_RINGS;
    return { rMax, r0, step, rNow: Math.min(rMax, r0 + irisRing * step) };
  }

  // Builds one scalloped annulus. The soft body goes into lctx (unblurred, then
  // blitted once through a blur); the crisp tracery is stroked straight onto
  // `sharpCtx` so it stays sharp — a rose window is stone lines as much as
  // coloured glass, and blurring everything is what made this read as a fuzzy
  // ball. Used for BOTH the live crown and the permanent deposit, so the two
  // can never drift apart.
  function irisCrown(rInner, tSec, alphaScale, sharpCtx, softCtx = lctx) {
    const cx = BW / 2, cy = BH / 2;
    const N = 240;                    // enough segments to keep 12 lobes smooth
    const rMax = irisRadii().rMax;
    for (let i = 0; i < 4; i++) {
      const col = VizCore.CHANNEL_COLORS[i];
      const lvl = clamp01(smooth.levels[i]);
      const ang = VizCore.CHANNEL_ANGLES[i];
      // Tracery is sized from the DISC, not from the current ring. Scaling it
      // by rInner meant the scallops were sub-pixel for the first several
      // minutes, so there was no structure to see at all — the real reason this
      // looked like a smear rather than a mandala.
      const amp = rMax * (0.020 + 0.060 * (1 - lvl)) * (0.45 + 0.80 * (1 - smooth.calm));
      const thick = rMax * (0.018 + 0.045 * lvl);
      const outer = [];
      for (let s = 0; s <= N; s++) {
        const a = (s / N) * Math.PI * 2;
        const w = VizCore.lobeWeight(a, i, 0.8);
        // Angular repetition — the thing that turns four soft quadrant blobs
        // into petals. Phase is tied to the sensor's own angle, so every
        // quadrant's petals line up into coherent radial symmetry.
        const petal = 0.32 + 0.68 * Math.pow(Math.abs(Math.cos((a - ang) * IRIS_PETALS)), 0.7);
        const scallop = VizCore.wobble(tSec * 0.5 + a * 4.0, i + 1);
        const r = Math.max(1, rInner + (thick + amp * scallop) * w * petal);
        outer.push([cx + Math.sin(a) * r, cy - Math.cos(a) * r]);
      }

      // Soft coloured body.
      if (softCtx) {
        softCtx.beginPath();
        outer.forEach(([x, y]) => softCtx.lineTo(x, y));
        for (let s = N; s >= 0; s--) {
          const a = (s / N) * Math.PI * 2;
          softCtx.lineTo(cx + Math.sin(a) * rInner, cy - Math.cos(a) * rInner);
        }
        softCtx.closePath();
        const g = softCtx.createRadialGradient(cx, cy, Math.max(1, rInner * 0.90), cx, cy, Math.max(2, rInner + thick + amp));
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(0.45, rgba(col, 0.46 * alphaScale * (0.45 + 0.75 * lvl)));
        g.addColorStop(1, rgba(col, 0));
        softCtx.fillStyle = g;
        softCtx.fill();
      }

      // Crisp tracery: the petal edge, in that sensor's own hue.
      if (sharpCtx) {
        sharpCtx.beginPath();
        outer.forEach(([x, y]) => sharpCtx.lineTo(x, y));
        sharpCtx.strokeStyle = rgba(col, 0.34 * alphaScale * (0.35 + 0.65 * lvl));
        sharpCtx.lineWidth = Math.max(0.6, rMax * 0.004);
        sharpCtx.stroke();
      }
    }

    // One faint concentric course per ring. On the record layer these stack up
    // into visible growth rings, so the disc reads as a dated record of the sit
    // rather than an undifferentiated wash.
    if (sharpCtx) {
      sharpCtx.beginPath();
      sharpCtx.arc(cx, cy, Math.max(1, rInner), 0, Math.PI * 2);
      sharpCtx.strokeStyle = `rgba(226,232,255,${0.10 * alphaScale})`;
      sharpCtx.lineWidth = Math.max(0.5, rMax * 0.0022);
      sharpCtx.stroke();
    }
  }

  function renderIris(tSec) {
    const cx = BW / 2, cy = BH / 2;
    const rad = irisRadii();
    const rNow = Math.max(2, rad.rNow);

    // Deposit: fossilise the current crown, then step the radius outward.
    if (sessionSec - irisLastDeposit >= IRIS_DEPOSIT_SEC && irisRing < IRIS_MAX_RINGS) {
      irisLastDeposit = sessionSec;
      lctx.clearRect(0, 0, BW, BH);
      lctx.globalCompositeOperation = 'source-over';
      rctx.globalCompositeOperation = 'lighter';
      // Tracery goes onto the record sharp; only the soft body is blurred in.
      irisCrown(rNow, tSec, 1.0, rctx);
      rctx.filter = 'blur(3px)';
      rctx.drawImage(lay, 0, 0);
      rctx.filter = 'none';
      rctx.globalCompositeOperation = 'source-over';
      irisRing++;
    }

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, smooth.calm > 0.55 ? '#120e24' : '#0a0d1e');
    bg.addColorStop(1, '#04050e');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    // A halo behind the disc, so the window sits in light rather than floating
    // in pure void — on near-black everything reads as a small dim smudge.
    const halo = bctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, rad.rMax * 1.45));
    halo.addColorStop(0, `rgba(96,86,168,${0.13 + 0.12 * smooth.calm})`);
    halo.addColorStop(0.6, `rgba(60,54,120,${0.06 + 0.06 * smooth.calm})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = halo;
    bctx.fillRect(0, 0, BW, BH);

    // The record: a whole session's structure in one composited call.
    bctx.globalCompositeOperation = 'lighter';
    bctx.globalAlpha = 0.85;
    bctx.drawImage(rec, 0, 0);
    bctx.globalAlpha = 1;

    // The live crown: soft body drawn unblurred then blitted once with blur,
    // tracery stroked straight onto the destination so it stays sharp.
    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'source-over';
    irisCrown(rNow, tSec, 1.0, null);
    bctx.filter = `blur(${Math.max(2, Math.round(BW / 110))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';
    irisCrown(rNow, tSec, 0.85, bctx, null);

    // Breath tide: a soft ring sweeping between aperture and rim — the
    // metronome of the piece, and the one thing that never stops.
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * smooth.calm;
    const tide = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));
    const tideR = Math.max(2, rNow * (0.25 + 0.85 * tide));
    const tg = bctx.createRadialGradient(cx, cy, Math.max(1, tideR * 0.72), cx, cy, Math.max(2, tideR * 1.28));
    tg.addColorStop(0, 'rgba(255,255,255,0)');
    tg.addColorStop(0.5, `rgba(232,240,255,${0.12 + 0.10 * smooth.calm})`);
    tg.addColorStop(1, 'rgba(255,255,255,0)');
    bctx.fillStyle = tg;
    bctx.beginPath(); bctx.arc(cx, cy, Math.max(2, tideR * 1.28), 0, Math.PI * 2); bctx.fill();

    // The aperture: a small, perfectly still warm centre. The one thing in the
    // image that never reacts to anything at all.
    const ap = Math.max(2, Math.min(BW, BH) * 0.055);
    const ag = bctx.createRadialGradient(cx, cy, 0, cx, cy, ap * 2.4);
    ag.addColorStop(0, 'rgba(255,236,198,0.92)');
    ag.addColorStop(0.4, 'rgba(255,214,150,0.35)');
    ag.addColorStop(1, 'rgba(255,200,130,0)');
    bctx.fillStyle = ag;
    bctx.beginPath(); bctx.arc(cx, cy, ap * 2.4, 0, Math.PI * 2); bctx.fill();

    // Spike comets: a bright dart flung outward from the sensor that shifted.
    for (let i = 0; i < 4; i++) {
      const sp = clamp01(state.bands[i].spike);
      if (sp < 0.2) continue;
      const a = VizCore.CHANNEL_ANGLES[i];
      const r1 = rNow * 1.02, r2 = rNow * (1.10 + 0.30 * sp);
      const x1 = cx + Math.sin(a) * r1, y1 = cy - Math.cos(a) * r1;
      const x2 = cx + Math.sin(a) * r2, y2 = cy - Math.cos(a) * r2;
      const cg = bctx.createLinearGradient(x1, y1, x2, y2);
      cg.addColorStop(0, `rgba(255,255,255,${0.55 * sp})`);
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      bctx.strokeStyle = cg;
      bctx.lineWidth = Math.max(1, rad.rMax * 0.02);
      bctx.lineCap = 'round';
      bctx.beginPath(); bctx.moveTo(x1, y1); bctx.lineTo(x2, y2); bctx.stroke();
    }
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Flow: a live trace that dissolves as it ages ----------------------
  // "Now" sits slightly right of centre rather than hard against the right
  // edge: new paint appears where the eye already is, and history trails left.
  //
  // THIS MODE RENDERS AT FULL CANVAS RESOLUTION, not into the shared small
  // buffer. That is the whole reason it can look sharp. Every other mode draws
  // into a <=560px buffer that is then upscaled ~4x, which is fine for soft
  // washes and fatal for a thin line — a 1px stroke arrives on screen as a 4px
  // smear no matter what filter is or isn't applied.
  //
  // Softening is done by STACKING STROKES of increasing width and decreasing
  // alpha, with both varying continuously per age group. The previous version
  // blitted the layer through three clipped x-zones at different blur radii,
  // which produced exactly what it sounds like: hard vertical seams where the
  // zones met, and a live edge that was still soft because it had been drawn
  // fat. There is no `filter` here at all, so it also costs zero blur passes.
  const FLOW_NOW_X = 0.74;
  const FLOW_GROUPS = 26;   // age bands; enough that the ramp reads as smooth
  const FLOW_SMOOTH = 9;    // samples in the centred smoothing window (~2.2s)

  function renderFlow(c, W, H) {
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#070a18');
    bg.addColorStop(1, '#03050d');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    if (history.length < 2) return;

    const nowX = W * FLOW_NOW_X;
    const n = history.length;
    const xOf = (i) => nowX - ((n - 1 - i) / (FLOW_MAX - 1)) * nowX;

    // Which four series, and in which colours.
    const composites = seriesMode === 'composites';
    const colors = composites
      ? VizCore.PULSE_METRICS.map((m) => m.color)
      : VizCore.CHANNEL_COLORS;
    // A held value for a metric with no inputs, so a null doesn't collapse the
    // line to the floor and read as a real reading of zero.
    const rawAt = (i, k) => {
      const h = history[i];
      if (!composites) return clamp01(h.levels[k]);
      for (let j = i; j >= 0; j--) {
        const v = history[j].metrics && history[j].metrics[k];
        if (v != null) return v;
      }
      return null;
    };

    // Smoothed once per frame per series, not per lookup — expandSoft below
    // stretches the middle of the range to fill the frame, which multiplies
    // sample-to-sample jitter by the same factor. Without this the trace is
    // legible as noise rather than as a signal. ~9 samples at ~4Hz is a little
    // over two seconds, which is shorter than any state worth seeing.
    const series = [0, 1, 2, 3].map((k) => VizCore.smoothSeries(
      history.map((_, i) => rawAt(i, k)), FLOW_SMOOTH
    ));

    // expand() is the difference between a trace and a flat line. Every value
    // here is adaptively normalised against the wearer's own baseline, so a real
    // session occupies roughly 0.35..0.75 — mapped straight to y that is about
    // 12% of the screen height, which is what "the line isn't changing at all"
    // actually was. Same fix as Eclipse's void radius.
    const yOf = (i, k) => {
      const v = series[k][i];
      if (v == null) return null;
      return H * (0.09 + 0.82 * (1 - VizCore.expandSoft(v)));
    };

    // BUTT caps, not round: adjacent age groups deliberately share an endpoint,
    // and a round cap there gets drawn twice under additive blending — visible
    // as a string of beads along every line.
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.globalCompositeOperation = 'lighter';

    // A genuinely thin line. The old wash pass was 11.5% of screen height per
    // channel, four channels deep, composited additively — which is why it
    // blew out to white.
    const baseW = Math.max(1, H * 0.0018);

    for (let ch = 0; ch < 4; ch++) {
      const col = colors[ch] || [200, 210, 255];
      if (yOf(n - 1, ch) == null) continue;   // nothing to say about this series
      for (let gi = 0; gi < FLOW_GROUPS; gi++) {
        const i0 = Math.round((gi * (n - 1)) / FLOW_GROUPS);
        const i1 = Math.round(((gi + 1) * (n - 1)) / FLOW_GROUPS);
        if (i1 <= i0) continue;
        // Groups share an endpoint, so there are no gaps; and because width and
        // alpha change only slightly from one group to the next, the joins read
        // as a continuous gradient rather than as boundaries.
        const mid = (i0 + i1) / 2 / (n - 1);   // 0 = oldest, 1 = live head
        const age = 1 - mid;
        const vis = Math.pow(1 - age, 0.85);   // dissolves out to the left

        // Halo widens and dims with age — this IS the blur, done in geometry.
        // Core stays narrow and bright at the head and gives out as it ages.
        const passes = [
          { w: baseW * (1 + 20 * age * age), a: 0.055 * vis + 0.012 },
          { w: baseW * (1 + 6 * age), a: 0.10 * vis },
          { w: baseW * (1 + 0.8 * age), a: 0.62 * vis * (1 - 0.7 * age) },
        ];
        for (const p of passes) {
          if (p.a <= 0.004) continue;
          c.beginPath();
          // A composite can have had no data at the start of a sit, so the path
          // must be able to begin partway through rather than anchoring to a
          // fabricated point.
          let started = false;
          for (let i = i0; i <= i1; i++) {
            const y = yOf(i, ch);
            if (y == null) { started = false; continue; }
            const x = xOf(i);
            if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
          }
          c.strokeStyle = rgba(col, p.a);
          c.lineWidth = Math.max(0.5, p.w);
          c.stroke();
        }
      }

      // The live head: a small bright point, so it reads as being written now.
      const hy = yOf(n - 1, ch);
      const hr = Math.max(1.5, baseW * 2.6);
      const hg = c.createRadialGradient(nowX, hy, 0, nowX, hy, hr * 3);
      hg.addColorStop(0, rgba(mixColor(col, [255, 255, 255], 0.55), 0.95));
      hg.addColorStop(0.35, rgba(col, 0.35));
      hg.addColorStop(1, rgba(col, 0));
      c.fillStyle = hg;
      c.beginPath(); c.arc(nowX, hy, hr * 3, 0, Math.PI * 2); c.fill();
    }

    // Spikes: small marks left where they happened, fading with the trace
    // rather than staying at full brightness forever.
    for (let i = 0; i < n; i++) {
      const h = history[i];
      const vis = Math.pow(i / Math.max(1, n - 1), 1.2);
      if (vis < 0.05) continue;
      for (let ch = 0; ch < 4; ch++) {
        const sp = clamp01(h.spikes[ch]);
        if (sp < 0.5) continue;
        const y = yOf(i, ch);
        if (y == null) continue;
        const x = xOf(i);
        const r = Math.max(2, H * 0.012) * (1 + 1.6 * (1 - vis));
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${0.34 * sp * vis})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  // ---- Pulse: a clock hand sweeping a ring per metric --------------------
  // One revolution every PULSE_REV_SEC, resetting at twelve o'clock. Where the
  // hand is now, each metric's ring bulges by how much that metric is doing;
  // the bulge stays and fades as the hand moves on, so you see the shape of the
  // last few seconds laid out around the dial — growing, holding, or subsiding.
  //
  // Also full-resolution: the bulge outlines want a crisp edge, same reason as
  // Flow. A black disc holds the centre so it reads as a corona.
  // 24 seconds per revolution, not the 5 originally sketched. Verified from
  // headless screenshots: at 5s the sweep is FASTER than the timescale these
  // metrics move on, so every revolution sees a near-constant value and draws a
  // near-perfect circle — which read as a loading spinner and carried no
  // information. A slower hand lets a real rise-and-fall fit inside one turn,
  // which is the whole point: shape you can read at a glance.
  const PULSE_REV_SEC = 24;
  const PULSE_BINS = 144;
  const pulseRings = VizCore.PULSE_METRICS.map(() => new VizCore.SweepRing({
    bins: PULSE_BINS, revSec: PULSE_REV_SEC,
  }));
  // Higher gain than the default: the raw scores are adaptively normalised and
  // move very little, and a dial that barely twitches is not reporting anything.
  // Low levelMix on purpose: a metric that is merely HIGH should sit quiet and
  // near its base radius, and a metric that MOVES should flare. Mixing in a lot
  // of absolute level was what drew a steadily-busy mind as a perfect circle —
  // which looked like a loading spinner and said nothing.
  const pulseDevs = VizCore.PULSE_METRICS.map(() => new VizCore.DeviationTracker({
    gain: 6.0, levelMix: 0.14, rate: 0.035,
  }));

  function renderPulse(c, W, H, tSec) {
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.50;

    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1024');
    bg.addColorStop(1, '#050813');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // Feed each ring. Metrics the page hasn't supplied simply don't move.
    // expand() first, for the same reason as everywhere else: without it the
    // input only ever travels across the middle third of its range.
    VizCore.PULSE_METRICS.forEach((m, mi) => {
      const raw = state.metrics && state.metrics[m.key] != null ? state.metrics[m.key] : null;
      pulseRings[mi].write(tSec, pulseDevs[mi].update(raw == null ? null : VizCore.expand(raw)));
    });

    // The void first, so the inner rings glow from INSIDE it rather than being
    // painted over by it. It is a soft-edged well, not a hard disc — a hard edge
    // reintroduces exactly the instrument-dial look this mode should not have.
    const voidR = maxR * 0.56;
    const vg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, voidR));
    vg.addColorStop(0, 'rgba(1,2,7,0.96)');
    vg.addColorStop(0.62, 'rgba(2,4,12,0.88)');
    vg.addColorStop(1, 'rgba(6,9,22,0)');
    c.fillStyle = vg;
    c.beginPath(); c.arc(cx, cy, Math.max(2, voidR), 0, Math.PI * 2); c.fill();

    c.globalCompositeOperation = 'lighter';
    VizCore.PULSE_METRICS.forEach((m, mi) => {
      const ring = pulseRings[mi];
      const r0 = maxR * m.base;
      // Generous amplitude, and deliberately more than the base spacing, so the
      // rings interpenetrate and bleed instead of sitting in tidy lanes.
      //
      // Inward-growing rings are capped at a fraction of their own base radius.
      // Without that cap a strong reading drives the radius through zero and out
      // the other side, which draws as a spray of spikes through the centre —
      // clearly visible in a headless screenshot, and impossible to spot from
      // the code alone.
      const bulge = m.out < 0
        ? -Math.min(maxR * 0.40, r0 * 0.72)
        : maxR * 0.40;
      const prof = ring.profile({ smoothBins: 9 });
      const pts = [];
      let peak = 0;
      for (let b = 0; b <= PULSE_BINS; b++) {
        const bin = b % PULSE_BINS;
        const v = prof[bin];
        if (v > peak) peak = v;
        const a = (bin / PULSE_BINS) * Math.PI * 2;
        const r = Math.max(1, r0 + bulge * v);
        pts.push([cx + Math.sin(a) * r, cy - Math.cos(a) * r]);
      }
      // Gradient body between the base circle and the bulged outline. The
      // gradient spans a FIXED generous radius range rather than being derived
      // from the current bulge: derived stops collapse to nothing whenever the
      // bulge is small, which is exactly when the ring most needs to still look
      // like a soft bloom instead of a hairline circle.
      c.beginPath();
      pts.forEach(([x, y]) => c.lineTo(x, y));
      for (let b = PULSE_BINS; b >= 0; b--) {
        const a = ((b % PULSE_BINS) / PULSE_BINS) * Math.PI * 2;
        c.lineTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      }
      c.closePath();
      const span = maxR * 0.34;
      const gIn = Math.max(1, r0 - (m.out < 0 ? span : span * 0.25));
      const gOut = Math.max(2, r0 + (m.out > 0 ? span : span * 0.25));
      const g = c.createRadialGradient(cx, cy, gIn, cx, cy, gOut);
      g.addColorStop(0, rgba(m.color, m.out < 0 ? 0.34 : 0.05));
      g.addColorStop(0.5, rgba(m.color, 0.22));
      g.addColorStop(1, rgba(m.color, m.out > 0 ? 0.30 : 0.04));
      c.fillStyle = g;
      c.fill();

      // Three stacked strokes along the bulge, widest and faintest first. Same
      // technique as Flow: softness built out of geometry, so the ring bleeds
      // like a gradient rather than being an outline with a fill behind it.
      c.lineJoin = 'round';
      c.lineCap = 'round';
      const glow = 0.35 + 0.65 * clamp01(peak);
      const strokes = [
        { w: Math.min(W, H) * 0.075, a: 0.055 * glow },
        { w: Math.min(W, H) * 0.032, a: 0.085 * glow },
        { w: Math.min(W, H) * 0.012, a: 0.13 * glow },
      ];
      for (const s of strokes) {
        c.beginPath();
        pts.forEach(([x, y]) => c.lineTo(x, y));
        c.strokeStyle = rgba(m.color, s.a);
        c.lineWidth = Math.max(1, s.w);
        c.stroke();
      }

      // Keep the thin bright edge: it carries the actual information, and it is
      // legible in a way a pure gradient is not.
      c.beginPath();
      pts.forEach(([x, y]) => c.lineTo(x, y));
      c.strokeStyle = rgba(m.color, 0.16 + 0.30 * clamp01(peak));
      c.lineWidth = Math.max(1, Math.min(W, H) * 0.0018);
      c.stroke();
    });
    c.globalCompositeOperation = 'source-over';
  }

  // ---- Corona: the same sweep, as one bleeding field ---------------------
  // Same clock-sweep mechanism as Pulse, different picture. Pulse gives each
  // metric its own lane, which reads as an instrument — concentric rings with
  // dark gaps between them, like lanes on a track. Corona packs all four into
  // the SAME radius region so they overlap directly, adds them together, and
  // draws no crisp edge at all. What you get is a single corona whose colour
  // and shape vary around the dial, not four separate readouts.
  //
  // Kept alongside Pulse rather than replacing it: the lanes are more legible,
  // the corona is more beautiful, and which one actually helps someone settle is
  // an open question that only comparison can answer.
  const CORONA_BASES = [0.52, 0.60, 0.68, 0.76];  // packed close, so they overlap
  const coronaRings = VizCore.PULSE_METRICS.map(() => new VizCore.SweepRing({
    bins: PULSE_BINS, revSec: PULSE_REV_SEC,
  }));
  // Much hotter than Pulse: the request was explicitly for more sensitivity, and
  // with no crisp outline to read there is nothing to see unless the shape moves
  // a lot. levelMix near zero means a steady mind draws a quiet even ring and
  // all the visible structure is genuine change.
  const coronaDevs = VizCore.PULSE_METRICS.map(() => new VizCore.DeviationTracker({
    gain: 9.0, levelMix: 0.10, rate: 0.05,
  }));

  function renderCorona(c, W, H, tSec) {
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.46;

    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1026');
    bg.addColorStop(1, '#050813');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    VizCore.PULSE_METRICS.forEach((m, mi) => {
      const raw = state.metrics && state.metrics[m.key] != null ? state.metrics[m.key] : null;
      coronaRings[mi].write(tSec, coronaDevs[mi].update(raw == null ? null : VizCore.expandSoft(raw)));
    });

    c.globalCompositeOperation = 'lighter';
    c.lineJoin = 'round';
    c.lineCap = 'round';

    VizCore.PULSE_METRICS.forEach((m, mi) => {
      const prof = coronaRings[mi].profile({ smoothBins: 11 });
      const r0 = maxR * CORONA_BASES[mi];
      const bulge = maxR * 0.42;
      const pts = [];
      let peak = 0;
      for (let b = 0; b <= PULSE_BINS; b++) {
        const bin = b % PULSE_BINS;
        const v = prof[bin];
        if (v > peak) peak = v;
        const a = (bin / PULSE_BINS) * Math.PI * 2;
        const r = Math.max(1, r0 + bulge * v);
        pts.push([cx + Math.sin(a) * r, cy - Math.cos(a) * r]);
      }

      // Nothing but stacked soft strokes — no fill, no outline. Widths run from
      // very wide down to merely wide, all at low alpha, so each metric is a
      // band of glow rather than a shape with a boundary. Additively they merge
      // into one field where they overlap, which is the whole point: the dark
      // gap between lanes is what made Pulse read as an instrument.
      // Alphas are ~2.5x an earlier attempt. Additive colour at low alpha over
      // near-black desaturates toward grey — the same lesson Eclipse taught —
      // so a soft corona has to be drawn genuinely bright to stay coloured.
      const glow = 0.45 + 0.55 * clamp01(peak);
      const strokes = [
        { w: 0.150, a: 0.075 },
        { w: 0.080, a: 0.100 },
        { w: 0.040, a: 0.130 },
        { w: 0.016, a: 0.200 },
      ];
      for (const s of strokes) {
        c.beginPath();
        pts.forEach(([x, y]) => c.lineTo(x, y));
        c.strokeStyle = rgba(m.color, s.a * glow);
        c.lineWidth = Math.max(1, Math.min(W, H) * s.w);
        c.stroke();
      }
    });

    c.globalCompositeOperation = 'source-over';

    // A soft well at the centre, drawn LAST and feathered, so the overlapping
    // glow is pushed outward into a corona without a hard disc edge cutting
    // across it. Deliberately not the crisp void Pulse has — a hard circle here
    // reintroduces exactly the dial look this mode exists to avoid.
    const voidR = maxR * 0.56;
    const vg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, voidR));
    vg.addColorStop(0, 'rgba(3,5,14,0.90)');
    vg.addColorStop(0.5, 'rgba(4,6,17,0.58)');
    vg.addColorStop(1, 'rgba(6,9,22,0)');
    c.fillStyle = vg;
    c.beginPath(); c.arc(cx, cy, Math.max(2, voidR), 0, Math.PI * 2); c.fill();
  }

  // ---- Silk: iridescent folds settling into a line -----------------------
  // A material visual rather than an instrument. Calm compresses the surface
  // toward a nearly-straight luminous horizon. Thought/activity lifts slow
  // peaks and adds fine vibration. Focus brightens and sharpens the coherent
  // ridge without making the field busier.
  function renderSilk(c, W, H, tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * calm;
    const breath = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));

    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#040611');
    bg.addColorStop(1, '#0a0612');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    c.save();
    c.translate(W * 0.5, H * 0.53);
    c.rotate((-0.14 + (-0.025 + 0.14) * calm) + 0.025 * thinking * Math.sin(tSec * 0.08));

    const min = Math.min(W, H);
    const lines = 104;
    const settle = Math.pow(calm, 1.8) * (1 - 0.55 * thinking);
    const amp = min * (0.020 + (0.205 - 0.020) * clamp01(thinking + 0.55 * (1 - calm)));
    const width = W * 1.12;
    const step = min * 0.0085;
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';

    for (let i = 0; i < lines; i++) {
      const u = (i / (lines - 1) - 0.5);
      const y0 = u * min * 0.78;
      const phase = tSec * (0.16 + (0.018 - 0.16) * calm) + i * (0.13 + (0.045 - 0.13) * calm);
      const weave = Math.sin(i * 0.42 + tSec * (0.055 + (0.012 - 0.055) * calm));
      const cool = mixColor([60, 190, 255], [154, 91, 230], u + 0.5);
      const warm = mixColor([255, 110, 69], [255, 200, 151], smoothstep(-0.05, 0.44, u + 0.22));
      const col = mixColor(cool, warm, smoothstep(-0.18, 0.55, Math.sin(i * 0.035 + tSec * 0.02) + focus * 0.55));
      const shade = 0.10 + 0.42 * Math.pow(Math.max(0, Math.sin(i * 0.18 + phase)), 3);
      const ridgeLine = smoothstep(0.12, 0.0, Math.abs(u));
      c.strokeStyle = rgba(col, (0.020 + 0.060 * shade + 0.045 * focus * ridgeLine) * (0.70 + 0.42 * focus));
      c.lineWidth = Math.max(0.5, step * (0.40 + 0.72 * focus + 0.30 * ridgeLine));
      c.beginPath();
      for (let s = 0; s <= 96; s++) {
        const x = -width * 0.5 + (s / 96) * width;
        const px = x / width;
        const peakA = Math.exp(-Math.pow((px - 0.08 - 0.12 * Math.sin(tSec * 0.025)) / 0.16, 2));
        const peakB = Math.exp(-Math.pow((px + 0.27 + 0.08 * Math.sin(tSec * 0.031 + 2)) / 0.22, 2));
        const thoughtPeaks = thinking * (peakA - 0.75 * peakB) * Math.sin(phase * 1.4 + u * 5.5);
        const broadFold =
          Math.sin(px * Math.PI * 2 * 1.25 + phase)
          + 0.48 * Math.sin(px * Math.PI * 2 * 2.10 - phase * 0.62 + u * 3.2);
        const vibration = thinking * (1 - calm * 0.55)
          * Math.sin(px * Math.PI * 2 * 18 + tSec * 2.4 + i * 0.43)
          * smoothstep(0.04, 0.32, Math.abs(u));
        const fold = amp * (
          broadFold * (1 - 0.82 * settle)
          + 1.25 * thoughtPeaks
          + 0.055 * vibration
        );
        const y = y0 + fold + weave * min * 0.006 * (1 - settle) + breath * min * 0.007 * (0.35 + focus);
        if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }

    const light = c.createRadialGradient(min * 0.26, -min * 0.25, 0, min * 0.26, -min * 0.25, min * 0.72);
    light.addColorStop(0, `rgba(255,210,172,${0.13 + 0.13 * focus})`);
    light.addColorStop(0.42, `rgba(59,204,255,${0.08 + 0.10 * (1 - thinking)})`);
    light.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = light;
    c.fillRect(-W, -H, W * 2, H * 2);

    if (calm > 0.45 || focus > 0.35) {
      const ridge = c.createLinearGradient(-width * 0.5, 0, width * 0.5, 0);
      ridge.addColorStop(0, 'rgba(90,190,255,0)');
      ridge.addColorStop(0.43, `rgba(138,222,255,${0.08 + 0.10 * calm})`);
      ridge.addColorStop(0.56, `rgba(255,219,166,${0.10 + 0.15 * focus})`);
      ridge.addColorStop(1, 'rgba(255,170,210,0)');
      c.strokeStyle = ridge;
      c.lineWidth = Math.max(1, min * (0.003 + 0.004 * focus));
      c.beginPath();
      c.moveTo(-width * 0.46, breath * min * 0.006);
      c.bezierCurveTo(-width * 0.15, -min * 0.018 * (1 - calm), width * 0.14,
        min * 0.012 * (1 - calm), width * 0.46, breath * min * 0.006);
      c.stroke();
    }
    c.restore();
    c.globalCompositeOperation = 'source-over';
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
    // Unblurred into `lay`, then one blurred blit — see the note in Eclipse.
    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';
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
      const wash = lctx.createLinearGradient(0, baseY - thick, 0, baseY + thick * 3);
      wash.addColorStop(0, rgba(col, 0.13 * (0.4 + lvl)));
      wash.addColorStop(1, rgba(col, 0));
      lctx.beginPath();
      pts.forEach(([x, y], s) => (s === 0 ? lctx.moveTo(x, y) : lctx.lineTo(x, y)));
      lctx.lineTo(BW, baseY + thick * 3);
      lctx.lineTo(0, baseY + thick * 3);
      lctx.closePath();
      lctx.fillStyle = wash;
      lctx.fill();

      lctx.beginPath();
      pts.forEach(([x, y], s) => (s === 0 ? lctx.moveTo(x, y) : lctx.lineTo(x, y)));
      lctx.strokeStyle = rgba(col, 0.28 + 0.4 * lvl);
      lctx.lineWidth = Math.max(1, thick);
      lctx.stroke();

      if (state.bands[i].spike > 0.25) {
        lctx.strokeStyle = `rgba(255,255,255,${0.5 * state.bands[i].spike})`;
        lctx.lineWidth = Math.max(1, thick * 0.3);
        lctx.stroke();
      }
    }
    lctx.globalCompositeOperation = 'source-over';
    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(3, Math.round((BW / 46) * (0.55 + 0.9 * smooth.calm)))}px)`;
    bctx.drawImage(lay, 0, 0);
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
    const targetFocus = state.metrics && state.metrics.focus != null ? state.metrics.focus : state.calm;
    smooth.focus += 0.04 * (targetFocus - smooth.focus);
    // ~4s time constant: the void must grow slowly and never twitch.
    smooth.voidCalm += 0.004 * (state.calm - smooth.voidCalm);
    smooth.noise += 0.15 * (state.noise - smooth.noise);
    smooth.breathPeriod += 0.01 * (state.breathPeriod - smooth.breathPeriod);
    for (let i = 0; i < 4; i++) {
      smooth.levels[i] += 0.06 * (clamp01(state.bands[i].level) - smooth.levels[i]);
    }

    const mode = VizCore.MODES[modeIndex].key;
    const tSec = (now - start) / 1000;

    if (DIRECT_MODES.has(mode)) {
      // Straight to the output canvas at full resolution — see renderFlow for
      // why. These modes depend on sharp thin lines, which cannot survive the
      // upscale from the shared small buffer.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (mode === 'flow') renderFlow(ctx, canvas.width, canvas.height);
      else if (mode === 'silk') renderSilk(ctx, canvas.width, canvas.height, tSec);
      else if (mode === 'corona') renderCorona(ctx, canvas.width, canvas.height, tSec);
      else renderPulse(ctx, canvas.width, canvas.height, tSec);
    } else {
      if (mode === 'eclipse') renderEclipse(tSec);
      else if (mode === 'iris') renderIris(tSec);
      else if (mode === 'bloom') renderBloom(now);
      else if (mode === 'field') renderField(tSec);
      else renderBreath(dtSec);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buf, 0, 0, BW, BH, 0, 0, canvas.width, canvas.height);
    }

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
        // Composite scores by key, for Pulse. Merged rather than replaced, so a
        // metric that momentarily has no inputs holds its last value instead of
        // snapping its ring to zero — a fabricated zero is a lie about the
        // signal, the same rule metrics.js follows.
        metrics: Object.assign({}, state.metrics, next.metrics || {}),
        bands,
      };
      history.push({
        levels: bands.map((b) => clamp01(b.level)),
        spikes: bands.map((b) => clamp01(b.spike)),
        // Composites too, so Flow can graph whichever series the data panel is
        // showing. Held values (not zeros) for metrics with no inputs.
        metrics: VizCore.PULSE_METRICS.map((m) => (
          state.metrics[m.key] == null ? null : clamp01(state.metrics[m.key])
        )),
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
      // Only the scratch layer. `rec` holds Iris's session record and must
      // survive switching away and back, or the record is not a record.
      lctx.clearRect(0, 0, BW, BH);
      return VizCore.MODES[modeIndex];
    },
    cycleMode() { return this.setMode(VizCore.nextMode(modeIndex)); },
    currentMode() { return VizCore.MODES[modeIndex]; },
    // Follows the data panel's Sensors/Composites switch — see seriesMode.
    setSeries(which) {
      seriesMode = which === 'composites' ? 'composites' : 'sensors';
      return seriesMode;
    },
    currentSeries() { return seriesMode; },
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
