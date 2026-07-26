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

  // ---- Flow: chronological watercolour ribbons --------------------------
  // "Now" sits slightly right of centre rather than hard against the right
  // edge: new paint appears where the eye already is, history trails off to
  // the left, and the newest stroke's soft wash blooms into the space to its
  // right instead of being clipped by the frame.
  const FLOW_NOW_X = 0.56;

  function renderFlow() {
    paintBase(bctx);
    if (history.length < 2) return;

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    // Unblurred here; blur is applied per age-zone on the blit below.
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';

    const nowX = BW * FLOW_NOW_X;
    const xOf = (i) => nowX - ((history.length - 1 - i) / (FLOW_MAX - 1)) * nowX;

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
    // Age fade: erase progressively toward the left so older paint dissolves.
    lctx.globalCompositeOperation = 'destination-out';
    const fade = lctx.createLinearGradient(0, 0, nowX, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0.95)');
    fade.addColorStop(0.55, 'rgba(0,0,0,0)');
    lctx.fillStyle = fade;
    lctx.fillRect(0, 0, nowX, BH);
    lctx.globalCompositeOperation = 'source-over';

    // Sharp where it is being made, dissolving as it ages. A single blur pass
    // cannot vary across the image, so the layer is blitted in three x-zones
    // with increasing blur: the newest zone is composited with no filter at
    // all, so the live edge stays genuinely crisp. Zones overlap slightly and
    // the older ones are drawn at reduced alpha, which hides the seams.
    // Cost: two blur passes per frame (the newest zone needs none).
    const zones = [
      { from: 0.00, to: 0.42, blur: Math.max(3, Math.round(BW / 42)), alpha: 0.85 },
      { from: 0.38, to: 0.78, blur: Math.max(1, Math.round(BW / 150)), alpha: 0.95 },
      { from: 0.74, to: 1.00, blur: 0, alpha: 1 },
    ];
    bctx.globalCompositeOperation = 'lighter';
    for (const z of zones) {
      const x0 = z.from * nowX;
      const x1 = z.to * nowX;
      // The newest zone extends to the full buffer width so the live stroke's
      // wash can bloom right of `nowX` rather than being cut off.
      const w = (z.to >= 1 ? BW : x1) - x0;
      if (w <= 0) continue;
      bctx.save();
      bctx.beginPath();
      bctx.rect(x0, 0, w, BH);
      bctx.clip();
      bctx.globalAlpha = z.alpha;
      bctx.filter = z.blur > 0 ? `blur(${z.blur}px)` : 'none';
      bctx.drawImage(lay, 0, 0);
      bctx.filter = 'none';
      bctx.globalAlpha = 1;
      bctx.restore();
    }
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
    // ~4s time constant: the void must grow slowly and never twitch.
    smooth.voidCalm += 0.004 * (state.calm - smooth.voidCalm);
    smooth.noise += 0.15 * (state.noise - smooth.noise);
    smooth.breathPeriod += 0.01 * (state.breathPeriod - smooth.breathPeriod);
    for (let i = 0; i < 4; i++) {
      smooth.levels[i] += 0.06 * (clamp01(state.bands[i].level) - smooth.levels[i]);
    }

    const mode = VizCore.MODES[modeIndex].key;
    if (mode === 'eclipse') renderEclipse((now - start) / 1000);
    else if (mode === 'iris') renderIris((now - start) / 1000);
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
      // Only the scratch layer. `rec` holds Iris's session record and must
      // survive switching away and back, or the record is not a record.
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
