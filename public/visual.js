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
  /* Ribbon's soft passes, at half the output resolution - see RIBBON_SCALE. Its own canvas rather than
     the shared `buf` because `buf` is fixed at 560px wide for the wash modes, and half of a 2880px retina
     canvas is 1440: the ribbons want that, and the washes do not want to pay for it. */
  const rib = document.createElement('canvas');
  const bctx = buf.getContext('2d');
  const lctx = lay.getContext('2d');
  const rctx = rec.getContext('2d');
  const ribctx = rib.getContext('2d');

  const BUF_MAX_W = 560; // small buffer => soft upscale + cheap blur
  /*
   * RIBBON'S SOFT PASSES RENDER AT HALF SCALE, and the reason is measured rather than assumed.
   *
   * Each ribbon is eleven overlapping translucent fills - two auras, a body, seven depth fills - and the
   * aura alone covers four times the ribbon's own area. Four ribbons is 40-odd large `lighter` composites
   * per frame, which is more per-pixel blending than any other mode here does. Half scale is a quarter of
   * the pixels.
   *
   * What it costs is edge sharpness on the soft passes, which is exactly the thing that does not matter
   * about them - they are gradients whose whole job is to be soft. The two things that DO need to be
   * sharp, the hairline crest along each ribbon's lit edge and the head dot, are drawn afterwards straight
   * onto the output canvas at full resolution.
   *
   * WHAT WAS ACTUALLY MEASURED, because the first version of this note claimed a speedup it had not
   * earned: in the headless container these are developed in, a bare requestAnimationFrame loop drawing
   * NOTHING runs at 28fps, and the shipped modes measure Flow 39, Breath 28, Eclipse 19, Silk 18, Ribbon
   * 20. So the container is the ceiling and Ribbon costs about what Eclipse and Silk cost. Neither the
   * half scale nor the point decimation showed a measurable gain HERE, and both are kept anyway: a phone
   * at three times this pixel count is where the blending actually bites, and neither costs anything
   * visible. Nothing in this file should be read as a claim that they were measured to help.
   */
  const RIBBON_SCALE = 0.5;
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
    hr: null, hrv: null,        // from the chest strap; null until one is connected
    metrics: {},   // composite scores by key, for Pulse
    breathAmount: null, // measured breath phase, -1 exhaled .. +1 inhaled
    bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0, fresh: true })),
  };
  let smooth = {
    calm: 0.5, noise: 0, breathPeriod: 0, activity: 0.5,
    focus: 0.5,
    levels: [0.5, 0.5, 0.5, 0.5],
    // Eclipse's void grows on a much longer time constant than everything
    // else — the user asked for it to grow SLOWLY, and a void that twitched
    // with every calm wobble would undo the whole point of the image.
    voidCalm: 0.5,
    breathAmount: null,   // null until a real measurement exists
    breathPrev: null,
    /*
     * EVERY COMPOSITE, EASED PER FRAME — the same fix Flow needed, for the same reason.
     *
     * Reported as "the other visuals are also choppy". Pulse, Corona and Silk wrote
     * `state.metrics[key]` straight into their ring buffers on every frame, and that value only
     * changes when setState is called: once per 250ms tick. So fifteen consecutive frames wrote
     * an identical radius and the sixteenth stepped. The ring is a history, so the step is then
     * preserved in the picture rather than passing — a visible staircase around the dial.
     *
     * `calm`, `activity`, `noise` and the electrode levels were already eased here. The
     * composites were the ones nobody had connected, because they arrived later. Null is
     * preserved rather than eased toward zero: a metric with no inputs must hold, not decay,
     * which is the same rule metrics.js follows.
     */
    metrics: {},
  };

  let modeIndex = 0;
  let patternIndex = 0;
  const detector = new VizCore.EventDetector();
  // Blooms live much longer than the first version (7s -> 16s): appearing and
  // dissolving slowly was an explicit request, and slow overlapping blooms
  // merge into a field instead of reading as separate "street lights".
  const blooms = new VizCore.BloomField({ max: 14, life: 16000 });

  const RESPONSE_MODES = [
    {
      key: 'smooth', label: 'smooth',
      rates: { calm: 0.018, activity: 0.022, focus: 0.018, voidCalm: 0.002, noise: 0.09, breath: 0.006, levels: 0.028 },
    },
    {
      key: 'sensitive', label: 'sensitive',
      rates: { calm: 0.04, activity: 0.05, focus: 0.04, voidCalm: 0.004, noise: 0.15, breath: 0.01, levels: 0.06 },
    },
    {
      key: 'ultrasensitive', label: 'ultrasensitive',
      rates: { calm: 0.10, activity: 0.13, focus: 0.10, voidCalm: 0.010, noise: 0.24, breath: 0.025, levels: 0.14 },
    },
  ];
  let responseIndex = 1;

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
  /* Ribbon is here for the same reason Flow is: the bright hairline along each ribbon's top edge is
     sub-pixel, and the shared 560px buffer would deliver it upscaled 4x as a smear. It costs nothing
     extra — this mode uses no blur ops at all, only gradients. */
  /* Lumen is here because it is nothing BUT large soft gradients: through the shared 560px buffer they
     would be upscaled 4x and band, and the whole picture is falloff. It costs no blur ops. */
  const DIRECT_MODES = new Set(['flow', 'lumen', 'ribbon', 'pulse', 'corona', 'silk']);

  // Which series Flow graphs: the four electrodes, or the four composites.
  // Follows the data panel's Sensors/Composites switch, because a main visual
  // showing raw electrodes while the panel and readout show composites is just
  // two unrelated pictures — and that mismatch is exactly what made a composite
  // look "dead" when the flat blue line was in fact an electrode.
  let seriesMode = 'sensors';
  /*
   * WHICH SERIES FLOW IS PLOTTING, as a set of VizCore.FLOW_SERIES keys.
   *
   * `seriesMode` survives beside it as the name of the last PRESET applied, because the keyboard, the
   * legend and three tests ask "sensors or composites?" — but it is now a label for a set rather than the
   * thing that decides what is drawn. A hand-picked mix leaves it as 'custom'.
   */
  let flowKeys = new Set(VizCore.FLOW_PRESETS.sensors);

  /* Is the key drawn? On by default, and that is the deliberate choice: the whole
   * complaint was not knowing what the colours meant, so a legend you have to find
   * a switch for does not answer it. Kept switchable because a legend is text on
   * screen during a sit, and someone who has learned the palette will want it gone.
   */
  let legendOn = true;
  // Pixels to keep clear on the left. See the note in drawLegend.
  let legendInset = 0;

  /*
   * HAS THIS ELECTRODE EVER READ ANYTHING?
   *
   * Reported as "the two flat lines": TP9 and TP10 both artifact-flagged for a whole
   * sit, drawn as perfectly straight horizontal lines across the middle of Flow. The
   * value behind them is the initial 0.5 — bandLevel only moves on a valid window — so
   * two of the four traces were a fabricated constant rendered as the steadiest signal
   * on screen. Exactly the bug just fixed in the chart, in the other renderer.
   *
   * The existing `held` treatment (dashed and dimmed) is right for a channel that reads
   * SOMETIMES: the gaps are informative. It is wrong for one that has never read at
   * all, because there is no signal for the dashes to be gaps in. So: never fresh,
   * never drawn, and dropped from the key as well — a legend entry for a line that is
   * not on screen is its own small lie.
   */
  const everFresh = [false, false, false, false];

  // Flow's vertical range per series, persisted between frames so the axis holds still.
  // Cleared when the series being drawn changes, since a composite's range says nothing
  // about an electrode's.
  let flowRanges = [null, null, null, null];
  /* Where the newest sample was drawn last frame, in canvas pixels. See flowScroll(). */
  let flowHeadX = null;
  let pushSeq = 0;
  let flowDt = 0;

  /*
   * WHEN THE LAST SAMPLE LANDED, and how far apart samples arrive — the two numbers Flow
   * needs to stop looking like stop motion.
   *
   * Reported as "it looks like a stop motion, i assume becuase its sample data by seconds,
   * but its just choppy". The guess was close. The frame loop is rAF, so it runs at ~60fps,
   * but `history` gains a sample only when setState is called — once per 250ms tick. So the
   * PICTURE changed four times a second while the canvas was redrawn sixty times a second:
   * fifteen identical frames, then a jump. Nothing about the smoothing or the colours could
   * fix that, because the trace was not moving between samples at all.
   *
   * The fix is to scroll the trace by the FRACTION of a sample interval elapsed since the
   * last one, so the drawn x positions advance every frame. The interval is measured rather
   * than assumed (a 250ms tick is not a promise, and a busy tab delivers it late), as an EMA
   * over observed gaps with implausible ones rejected.
   */
  /* WHAT THE APP SAYS IS DRIVING THE IMAGE, for the key to name. A label rather than a value:
     visual.js is handed a number and cannot know which metric it came from, and guessing would
     put a name in the key that the renderer never used. */
  let driverLabel = null;

  let flowDebugOn = false;
  const flowLastY = [null, null, null, null];

  let lastPushAt = null;      // performance.now() of the newest history sample
  let pushIntervalSec = null; // measured spacing between samples, seconds

  /* How far through the current sample interval we are: 0 the instant a sample lands, 1
   * just before the next. Clamped, so a stalled feed holds the trace still rather than
   * scrolling it off to the left. Returns 1 when the cadence is not yet known, which
   * reproduces the pre-scroll mapping exactly instead of guessing at one. */
  function flowPhase() {
    if (lastPushAt == null || pushIntervalSec == null) return 1;
    return Math.max(0, Math.min(1, ((performance.now() - lastPushAt) / 1000) / pushIntervalSec));
  }

  let sessionSec = 0;   // monotonic, for placing blooms along a slow sweep
  let breathPhase = 0;  // integrated radians — see renderBreath
  let patternT = 0;     // seconds accumulated for patterned breathing
  let breathLabel = null;

  /*
   * SIZED TO ITS OWN BOX, not to the window.
   *
   * This used to be innerWidth x innerHeight, which is the same thing as long as the canvas covers the
   * viewport — and it did, with every panel floating on top of it. Asked for: "I don't just want sticky
   * panels. I want it to look integrated. So the panels don't hide info anymore." Panels stop hiding the
   * visual when the visual stops being underneath them, which means the canvas has to occupy a region
   * rather than the screen. CSS decides that region; this reads it.
   *
   * The ResizeObserver is what makes the layout change work at all: moving between Meditate (full
   * screen) and Train (the centre cell) changes the canvas box with no window resize to hear about, and
   * a canvas whose backing store is the wrong size draws a stretched, blurred picture rather than an
   * obviously broken one — the kind of wrong that is easy to look at for weeks.
   *
   * Falls back to the window when there is no box to measure, which is the case in the smoke test's
   * stubbed canvas.
   */
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = Math.max(1, Math.round((box && box.width) || innerWidth));
    const h = Math.max(1, Math.round((box && box.height) || innerHeight));
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const scale = Math.min(1, BUF_MAX_W / canvas.width);
    BW = Math.max(160, Math.round(canvas.width * scale));
    BH = Math.max(90, Math.round(canvas.height * scale));
    for (const c of [buf, lay, rec]) { c.width = BW; c.height = BH; }
    rib.width = Math.max(2, Math.round(canvas.width * RIBBON_SCALE));
    rib.height = Math.max(2, Math.round(canvas.height * RIBBON_SCALE));
  }
  addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function' && canvas.getBoundingClientRect) {
    try { new ResizeObserver(resize).observe(canvas); } catch (err) { /* window resize still works */ }
  }
  resize();

  function paintBase(c) {
    const g = c.createLinearGradient(0, 0, 0, BH);
    g.addColorStop(0, '#070a18');
    g.addColorStop(1, '#03050d');
    c.fillStyle = g;
    c.fillRect(0, 0, BW, BH);
  }

  /* A key for whatever a mode is currently drawing.
   *
   * Every visible mode has one now, from VizCore.legendFor. Reported twice: "I
   * don't know what these colors actually mean. Thinking and drowsy." A visual
   * that reacts to your physiology without saying what it is reacting to cannot
   * be used to notice anything, because a real change and a rendering flourish
   * look the same.
   *
   * Entries come from VizCore so the key is generated from the same source the
   * renderer draws from and cannot drift out of sync with it. That drift is not
   * hypothetical — the data panel's electrode colours HAD diverged from the
   * visual's, so a ribbon and its own line were different colours.
   *
   * TWO ENTRY SHAPES. `{label, color}` draws a swatch: this hue IS that series.
   * `{text}` draws a word-line with no swatch, for encodings that are not colours
   * at all — Eclipse's expanding void, Iris's outward growth. No swatch can
   * explain those, and inventing one would misdescribe the picture.
   *
   * Top-left, because the mode pills own top-centre, the readout bottom-right and
   * the data panel bottom-left. Deliberately quiet: something to glance at, not
   * to read. Takes W/H so it works for both the full-resolution modes and the
   * small-buffer ones.
   */
  function drawLegend(c, W, H, entries) {
    if (!entries || !entries.length) return;
    /* `legendInset` shifts the key clear of anything the page has parked down the left edge. The mark
       rail in Train is a 272px column there, and the key was drawn straight over it — two unrelated
       lists of words on top of each other, which is worse than either alone. The page owns that layout,
       so the page supplies the inset; nothing here knows what a mark rail is. */
    const pad = Math.round(Math.min(W, H) * 0.030) + Math.max(0, legendInset);
    const size = Math.max(10, Math.round(H * 0.0165));
    const lh = Math.round(size * 1.75);
    const swatch = Math.round(size * 1.7);
    const textX = pad + swatch + Math.round(size * 0.6);
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.lineCap = 'round';
    let y = pad + size;
    let lastWasSwatch = false;
    for (const e of entries) {
      const isNote = !e.color;
      // A blank half-line between the colour key and the words, so the two kinds
      // of information do not read as one list of eight equal items.
      if (isNote && lastWasSwatch) y += Math.round(lh * 0.45);
      if (isNote) {
        // Smaller and dimmer than the key: these are captions, and they must not
        // compete with the visual they are describing.
        c.font = `${Math.max(9, Math.round(size * 0.92))}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
        c.fillStyle = 'rgba(226,232,255,0.40)';
        c.fillText(e.text, pad, y);
      } else {
        c.font = `${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
        // A short line segment, not a dot: the data is drawn as lines, so the key
        // should look like the thing it refers to.
        c.strokeStyle = rgba(e.color, e.faint ? 0.5 : 0.8);
        c.lineWidth = Math.max(1.5, size * 0.16);
        c.beginPath();
        c.moveTo(pad, y);
        c.lineTo(pad + swatch, y);
        c.stroke();
        c.fillStyle = rgba(e.color, e.faint ? 0.42 : 0.66);
        c.fillText(e.label, textX, y);
      }
      lastWasSwatch = !isNote;
      y += lh;
    }
    c.restore();
  }

  // ---- Eclipse: a growing void with a corona of mental activity ---------
  // Stillness is rendered as ABSENCE: as calm rises the black void expands and
  // pushes the bright, busy corona out toward the margins. Settling literally
  // quiets the screen. Thinking (DSP.ActivityTracker — beta level, band-power
  // variability, and rate of abrupt shifts) makes the corona reach further and
  // flare harder. Movement noise is NOT thinking and is handled separately.
  function renderEclipse(tSec) {
    // Dark ground keeps Eclipse restful. The colour should glow out of the
    // void, not turn the whole room into a lightbox.
    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#050711');
    bg.addColorStop(1, '#010208');
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
  const IRIS_DEPOSIT_SEC = 5;
  // 120 five-second layers gives Iris a ten-minute outward record. Each layer
  // keeps the same time thickness; color and brightness carry the mind state.
  const IRIS_MAX_RINGS = 120;
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

  function roseRadii() {
    const rMax = Math.min(BW, BH) * 0.56;
    const r0 = rMax * 0.14;
    const step = (rMax - r0) / IRIS_MAX_RINGS;
    return { rMax, r0, step, rNow: Math.min(rMax, r0 + irisRing * step) };
  }

  function roseWindowBand(rInner, tSec, alphaScale, sharpCtx, softCtx = lctx) {
    const cx = BW / 2, cy = BH / 2;
    const rad = roseRadii();
    const rMax = rad.rMax;
    const band = Math.max(2, rad.step * 2.6);
    const r0 = Math.max(rMax * 0.10, rInner - band * 0.75);
    const r1 = Math.min(rMax, rInner + band * 1.15);
    const calm = clamp01(smooth.calm);
    const focus = clamp01(smooth.focus);
    const activity = clamp01(smooth.activity);
    const cells = 24;

    for (let s = 0; s < cells; s++) {
      const mid = ((s + 0.5) / cells) * Math.PI * 2;
      const a0 = (s / cells) * Math.PI * 2;
      const a1 = ((s + 1) / cells) * Math.PI * 2;
      let owner = 0;
      let best = -1;
      for (let i = 0; i < 4; i++) {
        const w = VizCore.lobeWeight(mid, i, 1.05);
        if (w > best) { best = w; owner = i; }
      }

      const lvl = clamp01(smooth.levels[owner]);
      const spike = clamp01(state.bands[owner].spike);
      const petal = 0.42 + 0.58 * Math.pow(Math.abs(Math.cos(mid * IRIS_PETALS)), 0.82);
      const rough = (1 - calm) * activity * 0.12 * VizCore.wobble(tSec * 0.18 + s * 0.7, owner + 2);
      const inner = Math.max(1, r0 + band * 0.20 * petal * (0.5 - lvl));
      const outer = Math.max(inner + 1, r1 + band * (0.38 * petal * focus + 0.55 * spike + rough));
      const col = mixColor(VizCore.CHANNEL_COLORS[owner], [246, 205, 126], focus * (0.30 + 0.30 * calm));

      if (softCtx) {
        softCtx.beginPath();
        softCtx.moveTo(cx + Math.sin(a0) * inner, cy - Math.cos(a0) * inner);
        softCtx.lineTo(cx + Math.sin(mid) * outer, cy - Math.cos(mid) * outer);
        softCtx.lineTo(cx + Math.sin(a1) * inner, cy - Math.cos(a1) * inner);
        softCtx.closePath();
        softCtx.fillStyle = rgba(col, alphaScale * (0.09 + 0.24 * lvl + 0.15 * focus));
        softCtx.fill();
      }

      if (sharpCtx) {
        sharpCtx.beginPath();
        sharpCtx.moveTo(cx + Math.sin(a0) * inner, cy - Math.cos(a0) * inner);
        sharpCtx.lineTo(cx + Math.sin(mid) * outer, cy - Math.cos(mid) * outer);
        sharpCtx.lineTo(cx + Math.sin(a1) * inner, cy - Math.cos(a1) * inner);
        sharpCtx.strokeStyle = rgba(mixColor(col, [255, 240, 205], 0.28), alphaScale * (0.12 + 0.24 * focus + 0.11 * lvl));
        sharpCtx.lineWidth = Math.max(0.45, rMax * (0.0025 + 0.0025 * focus));
        sharpCtx.stroke();
      }
    }

    if (sharpCtx) {
      sharpCtx.beginPath();
      sharpCtx.arc(cx, cy, Math.max(1, rInner), 0, Math.PI * 2);
      sharpCtx.strokeStyle = `rgba(232,222,188,${(0.06 + 0.10 * focus) * alphaScale})`;
      sharpCtx.lineWidth = Math.max(0.45, rMax * 0.0018);
      sharpCtx.stroke();
    }
  }

  function renderIrisRose(tSec) {
    const cx = BW / 2, cy = BH / 2;
    const rad = roseRadii();
    const rNow = Math.max(2, rad.rNow);
    const calm = clamp01(smooth.calm);
    const focus = clamp01(smooth.focus);
    const activity = clamp01(smooth.activity);

    if (sessionSec - irisLastDeposit >= IRIS_DEPOSIT_SEC && irisRing < IRIS_MAX_RINGS) {
      irisLastDeposit = sessionSec;
      lctx.clearRect(0, 0, BW, BH);
      lctx.globalCompositeOperation = 'source-over';
      rctx.globalCompositeOperation = 'lighter';
      roseWindowBand(rNow, tSec, 1.0, rctx);
      rctx.filter = 'blur(2px)';
      rctx.drawImage(lay, 0, 0);
      rctx.filter = 'none';
      rctx.globalCompositeOperation = 'source-over';
      irisRing++;
    }

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#080714');
    bg.addColorStop(0.58, '#050711');
    bg.addColorStop(1, '#02030a');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    const halo = bctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, rad.rMax * 1.35));
    halo.addColorStop(0, `rgba(104,92,168,${0.06 + 0.08 * focus})`);
    halo.addColorStop(0.58, `rgba(34,44,94,${0.05 + 0.05 * calm})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = halo;
    bctx.fillRect(0, 0, BW, BH);

    bctx.globalCompositeOperation = 'lighter';
    bctx.globalAlpha = 0.92;
    bctx.drawImage(rec, 0, 0);
    bctx.globalAlpha = 1;

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'source-over';
    roseWindowBand(rNow, tSec, 1.0, null);
    bctx.filter = `blur(${Math.max(1, Math.round(BW / 150))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';
    roseWindowBand(rNow, tSec, 0.92, bctx, null);

    bctx.globalCompositeOperation = 'source-over';
    bctx.lineCap = 'round';
    const spokes = 24;
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      const fade = s % 2 ? 0.035 : 0.060;
      bctx.beginPath();
      bctx.moveTo(cx + Math.sin(a) * rad.r0 * 0.72, cy - Math.cos(a) * rad.r0 * 0.72);
      bctx.lineTo(cx + Math.sin(a) * rad.rMax * 0.98, cy - Math.cos(a) * rad.rMax * 0.98);
      bctx.strokeStyle = `rgba(238,226,190,${fade * (0.55 + focus)})`;
      bctx.lineWidth = Math.max(0.35, rad.rMax * 0.0012);
      bctx.stroke();
    }
    for (let k = 1; k <= 5; k++) {
      const r = rad.rMax * (0.16 + k * 0.16);
      bctx.beginPath();
      bctx.arc(cx, cy, r, 0, Math.PI * 2);
      bctx.strokeStyle = `rgba(238,226,190,${0.025 + 0.025 * focus})`;
      bctx.lineWidth = Math.max(0.35, rad.rMax * 0.0013);
      bctx.stroke();
    }

    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * calm;
    const tide = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));
    const tideR = rad.rMax * (0.28 + 0.60 * tide);
    const tg = bctx.createRadialGradient(cx, cy, Math.max(1, tideR * 0.94), cx, cy, Math.max(2, tideR * 1.08));
    tg.addColorStop(0, 'rgba(255,255,255,0)');
    tg.addColorStop(0.5, `rgba(245,232,196,${0.035 + 0.045 * calm})`);
    tg.addColorStop(1, 'rgba(255,255,255,0)');
    bctx.fillStyle = tg;
    bctx.beginPath(); bctx.arc(cx, cy, Math.max(2, tideR * 1.08), 0, Math.PI * 2); bctx.fill();

    const oculus = Math.max(2, rad.rMax * (0.105 + 0.018 * (1 - calm) + 0.012 * activity));
    const og = bctx.createRadialGradient(cx, cy, 0, cx, cy, oculus * 2.4);
    og.addColorStop(0, 'rgba(4,4,9,0.98)');
    og.addColorStop(0.58, 'rgba(7,8,18,0.92)');
    og.addColorStop(1, 'rgba(7,8,18,0)');
    bctx.fillStyle = og;
    bctx.beginPath(); bctx.arc(cx, cy, oculus * 2.4, 0, Math.PI * 2); bctx.fill();
    bctx.strokeStyle = `rgba(246,220,166,${0.12 + 0.16 * focus})`;
    bctx.lineWidth = Math.max(0.55, rad.rMax * 0.003);
    bctx.beginPath(); bctx.arc(cx, cy, oculus * 1.02, 0, Math.PI * 2); bctx.stroke();

    bctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const sp = clamp01(state.bands[i].spike);
      if (sp < 0.22) continue;
      const a = VizCore.CHANNEL_ANGLES[i];
      const r = Math.max(rad.r0, rNow);
      const col = VizCore.CHANNEL_COLORS[i];
      bctx.beginPath();
      bctx.arc(cx, cy, r + rad.step * 2.5, a - 0.18, a + 0.18);
      bctx.strokeStyle = rgba(mixColor(col, [255, 255, 255], 0.45), 0.20 * sp);
      bctx.lineWidth = Math.max(1, rad.rMax * 0.018);
      bctx.stroke();
    }
    bctx.globalCompositeOperation = 'source-over';
  }

  function irisSedimentRadii() {
    const rMax = Math.min(BW, BH) * 0.55;
    const r0 = rMax * 0.12;
    const step = (rMax - r0) / IRIS_MAX_RINGS;
    return { rMax, r0, step, rNow: Math.min(rMax, r0 + irisRing * step) };
  }

  /*
   * How long between deposits.
   *
   * IRIS_MAX_RINGS rings at IRIS_DEPOSIT_SEC each is a ten-minute disc, and a sit
   * longer than that used to WIPE the record and start again from the middle — the
   * one behaviour a visual whose entire premise is "a record of this sit" must not
   * have. When the intended length is known (the session timer), the interval is
   * derived from it so the whole sit maps onto the full radius: a 40-minute sit lays
   * a ring every 20s and finishes at the rim.
   *
   * With no timer set it falls back to 5s and FREEZES at the rim rather than wiping.
   * Freezing loses the tail; wiping loses everything already earned, which is worse.
   */
  let irisSessionSec = null;
  function irisDepositSec() {
    if (irisSessionSec && irisSessionSec > 0) {
      return Math.max(2, irisSessionSec / IRIS_MAX_RINGS);
    }
    return IRIS_DEPOSIT_SEC;
  }

  /*
   * Lay down one ring if one is due — CALLED EVERY FRAME FROM THE FRAME LOOP, not
   * from the Iris renderer.
   *
   * Reported: "when I flip back and forth on Iris, it always starts in the
   * beginning... ideally it just starts running when you connect the device, and it
   * keeps building rings so that if you switch off of it and you switch on, it's
   * still there." It was inside renderIrisSediment, so rings were only deposited
   * during the seconds Iris happened to be the visible mode. Spend the first ten
   * minutes on Eclipse and Iris had recorded nothing — the record was a record of
   * WATCHING, not of sitting.
   *
   * Cheap to call unconditionally: it returns immediately except on the interval
   * boundary, so the cost is one subtraction per frame.
   */
  function depositIrisRing() {
    if (sessionSec - irisLastDeposit < irisDepositSec()) return false;
    if (irisRing >= IRIS_MAX_RINGS) return false;   // full: freeze, never wipe
    irisLastDeposit = sessionSec;
    const mood = irisMindColor();
    const rad = irisSedimentRadii();
    const depositR = Math.max(2, rad.rNow);
    const ringW = Math.max(2, rad.step * 2.2);
    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'source-over';
    drawIrisSedimentRing(lctx, depositR, ringW, mood, 1, false);
    rctx.globalCompositeOperation = 'lighter';
    rctx.filter = 'blur(1.5px)';
    rctx.drawImage(lay, 0, 0);
    rctx.filter = 'none';
    drawIrisSedimentRing(rctx, depositR, ringW * 0.72, mood, 0.85, true);
    rctx.globalCompositeOperation = 'source-over';
    irisRing++;
    return true;
  }

  function irisMindColor() {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(state.metrics && state.metrics.thinking != null ? state.metrics.thinking : smooth.activity);
    const focus = clamp01(smooth.focus);
    const noise = clamp01(smooth.noise);

    // The attached session reports sit mostly near the middle: calm averages
    // around 0.53, marked thinking was about 0.57..0.61, and calm ranged
    // roughly 0.33..0.76. These thresholds make that middle visually legible.
    const heat = smoothstep(0.52, 0.68, thinking) * (1 - 0.35 * calm);
    const cool = smoothstep(0.50, 0.68, calm) * (1 - 0.25 * thinking);
    const gold = smoothstep(0.38, 0.66, focus) * (1 - 0.35 * heat);

    // Endpoints come from VizCore.IRIS_MOOD so the legend keys off the same values
    // this mixes. The thresholds and weightings stay here — they are this renderer's
    // judgement about what is legible, not shared vocabulary.
    const M = VizCore.IRIS_MOOD;
    let base = M.uncertain;    // no clear state: blue-grey
    if (heat > cool + 0.12) {
      base = mixColor(M.thinkingLo, M.thinkingHi, clamp01(heat));
    } else if (cool > heat + 0.08) {
      base = mixColor(M.calmLo, M.calmHi, clamp01(cool));
    } else {
      base = mixColor(M.mixedLo, M.mixedHi, clamp01(0.35 + heat));
    }
    base = mixColor(base, M.focusTint, gold * 0.40);
    base = mixColor(base, M.noiseTint, smoothstep(0.22, 0.58, noise) * 0.72);

    const accent = mixColor(base, heat > cool ? [255, 182, 126] : [172, 245, 220], 0.28 + 0.22 * gold);
    const intensity = clamp01(0.34 + 0.34 * Math.max(heat, cool) + 0.24 * gold - 0.24 * noise);
    return { base, accent, calm, thinking, focus, noise, heat, cool, gold, intensity };
  }

  function drawIrisSedimentRing(c, rMid, width, mood, alphaScale = 1, crisp = true) {
    const cx = BW / 2, cy = BH / 2;
    const petalAmp = width * 0.72;
    const N = 192;
    const innerPts = [];
    const outerPts = [];
    let minInner = Infinity;
    let maxOuter = 0;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const petal = Math.pow(Math.abs(Math.cos(a * IRIS_PETALS)), 0.72);
      const lace = 0.18 * Math.sin(a * IRIS_PETALS * 2);
      const centerR = Math.max(1, rMid + petalAmp * (petal - 0.52 + lace * (0.35 + 0.45 * mood.focus)));
      const innerR = Math.max(1, centerR - width * 0.50);
      const outerR = Math.max(innerR + 1, centerR + width * 0.50);
      minInner = Math.min(minInner, innerR);
      maxOuter = Math.max(maxOuter, outerR);
      innerPts.push([cx + Math.sin(a) * innerR, cy - Math.cos(a) * innerR]);
      outerPts.push([cx + Math.sin(a) * outerR, cy - Math.cos(a) * outerR]);
    }

    const g = c.createRadialGradient(cx, cy, Math.max(1, minInner), cx, cy, Math.max(2, maxOuter));
    g.addColorStop(0, rgba(mood.base, 0.05 * alphaScale));
    g.addColorStop(0.45, rgba(mood.base, (0.22 + 0.34 * mood.intensity) * alphaScale));
    g.addColorStop(0.72, rgba(mood.accent, (0.12 + 0.22 * mood.focus) * alphaScale));
    g.addColorStop(1, rgba(mood.base, 0.03 * alphaScale));
    c.fillStyle = g;
    c.beginPath();
    outerPts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
    for (let i = innerPts.length - 1; i >= 0; i--) c.lineTo(innerPts[i][0], innerPts[i][1]);
    c.closePath();
    c.fill();

    if (!crisp) return;
    c.strokeStyle = rgba(mood.accent, (0.045 + 0.12 * mood.focus + 0.07 * mood.intensity) * alphaScale);
    c.lineWidth = Math.max(0.45, width * 0.055);
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const petal = Math.pow(Math.abs(Math.cos(a * IRIS_PETALS)), 0.72);
      const lace = 0.18 * Math.sin(a * IRIS_PETALS * 2);
      const centerR = Math.max(1, rMid + petalAmp * (petal - 0.52 + lace * (0.35 + 0.45 * mood.focus)));
      const x = cx + Math.sin(a) * centerR;
      const y = cy - Math.cos(a) * centerR;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  function renderIrisSediment(tSec) {
    const cx = BW / 2, cy = BH / 2;
    const rad = irisSedimentRadii();
    const mood = irisMindColor();
    const ringW = Math.max(2, rad.step * 2.2);
    // The live ring creeps outward between deposits, so growth looks continuous
    // rather than jumping a whole step every interval.
    const progress = clamp01((sessionSec - irisLastDeposit) / irisDepositSec());
    const rNow = Math.max(2, Math.min(rad.rMax, rad.r0 + (irisRing + progress) * rad.step));

    // NO DEPOSIT HERE. depositIrisRing() runs from the frame loop so the record
    // accumulates whether or not Iris is the mode on screen — see the note there.

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#060814');
    bg.addColorStop(1, '#02030a');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    const halo = bctx.createRadialGradient(cx, cy, 0, cx, cy, rad.rMax * 1.38);
    halo.addColorStop(0, 'rgba(24,28,42,0.08)');
    halo.addColorStop(0.58, 'rgba(12,15,26,0.045)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = halo;
    bctx.fillRect(0, 0, BW, BH);

    bctx.globalCompositeOperation = 'lighter';
    bctx.globalAlpha = 0.94;
    bctx.drawImage(rec, 0, 0);
    bctx.globalAlpha = 1;

    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * mood.calm;
    const breath = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));
    drawIrisSedimentRing(bctx, rNow, ringW, mood, 0.78 + 0.18 * breath, true);

    bctx.globalCompositeOperation = 'source-over';
    const centerR = Math.max(2, rad.r0);
    const cg = bctx.createRadialGradient(cx, cy, 0, cx, cy, centerR * 2.8);
    cg.addColorStop(0, 'rgba(246,235,210,0.32)');
    cg.addColorStop(0.46, 'rgba(42,44,54,0.14)');
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    bctx.fillStyle = cg;
    bctx.beginPath();
    bctx.arc(cx, cy, centerR * 2.8, 0, Math.PI * 2);
    bctx.fill();

    bctx.strokeStyle = 'rgba(142,152,170,0.16)';
    bctx.lineWidth = Math.max(0.55, rad.rMax * 0.0026);
    bctx.beginPath();
    bctx.arc(cx, cy, centerR, 0, Math.PI * 2);
    bctx.stroke();

    /* THE PALE DISC IS GONE. It filled a hard-edged circle of rgba(170,170,180) at
       radius rMax * 1.02 whenever noise passed 0.18, meaning to say "the signal is
       unreliable". Reported as "I still see, like, a white background that goes on
       sometimes for the iris thing" — because that is what it looked like: a light
       grey plate appearing behind the disc, washing the colours out, with nothing
       to connect it to signal quality.
       The frame loop already veils EVERY mode by smooth.noise, which is where that
       message belongs — one mechanism, the same reading in every visual. This was a
       second, louder, mode-specific copy of it. */
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
  const FLOW_SMOOTH = 9;    // equivalent averaging length for a composite, in samples
  /*
   * The SENSOR series is smoothed harder than the composites, and that asymmetry is the
   * point rather than an inconsistency.
   *
   * A composite arrives adaptively normalised — it has already been through a smoother and
   * a running baseline. The per-channel value has not: it is a raw alpha/(alpha+beta) ratio
   * recomputed from a one-second window four times a second, so its sample-to-sample noise
   * is a large fraction of its genuine range. Measured after rescaling, one noisy sample
   * occupied 34% of the band for the sensors against 5% for the composites. ~5s of
   * smoothing is still shorter than any state worth seeing and takes most of that out.
   */
  const FLOW_SMOOTH_SENSORS = 21;   // ~5.2s at 4Hz
  /* The fixed axis for the per-channel traces. See the note in renderFlow: alpha's share of alpha+beta is
     a bounded ratio, so it needs no derived scale, and 0..0.6 keeps a beta-dominant sit (~0.2) a third of
     the way up the band rather than pinned to the floor. Frozen object: it is handed out to four callers
     per frame and must not be mutable by any of them. */
  const SENSOR_RANGE = Object.freeze({ min: 0, max: 0.75, span: 0.75 });

  /*
   * THE SMOOTHING IS CAUSAL AND CACHED PER SAMPLE, and that is the fix for the tick.
   *
   * Reported, after the sub-sample scroll went in, as still choppy — "like a battery
   * analog watch vs. automatic. tick tick". Measured, and the scroll was innocent: an
   * idle frame moved the line by 0.002% of the band, the frame after a sample arrived
   * moved it by 0.584%. So the picture was still changing four times a second, in the
   * vertical direction, and the horizontal scroll had nothing to do with it.
   *
   * The cause was a CENTRED smoothing window recomputed every frame. A centred window
   * needs samples from both sides, and the newest ones do not exist yet, so the value it
   * produces for a recent sample keeps being revised as its future arrives. Measured on a
   * steady signal with a converged axis: when one new sample landed, the samples 0-8 back
   * from the head moved 2.8-3.3% of the band, and everything 10 or more back moved 0.01%.
   * Half a smoothing window of already-drawn line, jumping every 250ms. Exactly a ticking
   * second hand: the movement is real, it is just delivered in steps.
   *
   * So each sample's smoothed value is now computed ONCE, from the past only, at the
   * moment it is recorded, and stored on the history entry. Nothing already drawn can
   * ever move again. A one-pole (exponential) filter rather than a trailing box, because
   * it is incremental, responds to the newest sample immediately instead of only after
   * the window fills, and has a gentler impulse response.
   *
   * The cost, stated plainly: a causal filter lags. alpha = 2/(N+1) gives the same noise
   * suppression as averaging N samples, so the sensor trace lags by roughly 11 samples,
   * about 2.7 seconds. That is a real cost and it is the right trade — 2.7s of lag on a
   * 60-second history plot is invisible, and a past that revises itself is not.
   */
  const emaAlpha = (n) => 2 / (n + 1);
  function emaStep(prev, value, alpha) {
    if (value == null) return prev;   // a gap folds in nothing and does not reset the filter
    if (prev == null) return value;   // start on the first real reading, not on a ramp from 0
    return prev + alpha * (value - prev);
  }
  const flowEma = { levels: [null, null, null, null], metrics: [null, null, null, null], breath: null };

  /* Which electrode a series is, for the arrays that are still indexed by channel (everFresh, spikes). */
  function channelIndexOf(spec) { return VizCore.CHANNEL_LABELS.indexOf(spec.label); }

  /*
   * THE LABEL PILLS, beside each line's head and at its height.
   *
   * Asked for: "it'd be really nice to move the labels into small pills to the right of the line and see
   * them match the height of the line. in other words, be by the dot, even tho you'd have to sort what
   * happens when they overlap (which goes on top)".
   *
   * Why this is better than the corner key it replaces: with up to eleven lines on one graph, a legend in
   * the top-left makes you match a colour swatch to a line by eye, across the width of the screen, for
   * every line. A pill at the head names the line where you are already looking, and its height IS the
   * reading — so the label and the value are the same object.
   *
   * OVERLAP. Two lines at the same value want the same pill position. The resolution is a single pass
   * over the pills sorted by y, pushing each one down until it clears the previous by a pill's height,
   * then re-centring the whole stack on where it started so a cluster spreads symmetrically rather than
   * marching off the bottom. A pill that has been moved gets a short leader line back to its dot, because
   * a displaced label with no connector is a label pointing at the wrong line.
   *
   * WHICH GOES ON TOP is decided rather than left to draw order: the pills are drawn in ascending order
   * of how much they were displaced, so the one still at its true height is painted last and reads as the
   * anchor of the cluster. Ties break toward the higher value, which is the line the eye follows.
   */
  function drawFlowPills(c, W, H, nowX, heads) {
    if (!heads.length) return;
    const fontPx = Math.max(9, Math.min(13, Math.round(H * 0.017)));
    c.font = `600 ${fontPx}px Inter, ui-sans-serif, system-ui, sans-serif`;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const padX = Math.round(fontPx * 0.55);
    const padY = Math.round(fontPx * 0.34);
    const pillH = fontPx + padY * 2;
    const gap = Math.round(fontPx * 0.28);
    const x0 = nowX + Math.max(7, fontPx * 0.85);

    const items = heads.map((h) => ({
      ...h,
      text: h.spec.label,
      w: Math.ceil(c.measureText(h.spec.label).width) + padX * 2,
      want: h.y,
      at: h.y,
    })).sort((a, b) => a.want - b.want);

    // Push down to clear, then recentre the stack on its own mean so it grows both ways.
    let shifted = false;
    for (let i = 1; i < items.length; i++) {
      const need = items[i - 1].at + pillH + gap;
      if (items[i].at < need) { items[i].at = need; shifted = true; }
    }
    if (shifted) {
      const wantMid = (items[0].want + items[items.length - 1].want) / 2;
      const atMid = (items[0].at + items[items.length - 1].at) / 2;
      const dy = wantMid - atMid;
      for (const it of items) it.at += dy;
      // And keep the whole stack on screen, top edge first — a pill above the frame is unreadable.
      const top = items[0].at - pillH / 2;
      const bottom = items[items.length - 1].at + pillH / 2;
      if (top < 2) for (const it of items) it.at += 2 - top;
      else if (bottom > H - 2) for (const it of items) it.at -= bottom - (H - 2);
    }

    /* A pill that would run off the right edge is drawn to the LEFT of the head instead. On a narrow
       phone the head sits at 95% of the width and there is no room to the right at all. */
    const widest = Math.max(...items.map((it) => it.w));
    const flip = x0 + widest > W - 4;
    c.globalCompositeOperation = 'source-over';
    for (const it of items.slice().sort((a, b) => Math.abs(b.at - b.want) - Math.abs(a.at - a.want)
      || a.want - b.want)) {
      const px = flip ? nowX - Math.max(7, fontPx * 0.85) - it.w : x0;
      const py = it.at - pillH / 2;
      // The leader, only when the pill is not where its dot is.
      if (Math.abs(it.at - it.want) > 1) {
        c.strokeStyle = rgba(it.col, 0.34);
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(flip ? nowX - 3 : nowX + 3, it.want);
        c.lineTo(flip ? px + it.w : px, it.at);
        c.stroke();
      }
      const r = Math.min(pillH / 2, 6);
      c.beginPath();
      if (c.roundRect) c.roundRect(px, py, it.w, pillH, r);
      else c.rect(px, py, it.w, pillH);
      /* A DARK PLATE UNDER THE TEXT, not the series colour behind white type. Eleven saturated pills
         would be eleven bright blocks over the trace; a near-black plate with coloured text keeps the
         lines the brightest thing on screen, which is what they should be. */
      c.fillStyle = `rgba(6,9,18,${it.fresh ? 0.82 : 0.6})`;
      c.fill();
      c.strokeStyle = rgba(it.col, it.fresh ? 0.55 : 0.25);
      c.lineWidth = 1;
      c.stroke();
      c.fillStyle = rgba(it.col, it.fresh ? 0.96 : 0.45);
      c.fillText(it.text, px + padX, it.at + 0.5);
    }
  }

  function renderFlow(c, W, H) {
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#070a18');
    bg.addColorStop(1, '#03050d');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    if (history.length < 2) return;

    const nowX = W * FLOW_NOW_X;
    const n = history.length;
    const step = nowX / (FLOW_MAX - 1);   // horizontal distance one sample occupies

    /*
     * SUB-SAMPLE SCROLL. `phase` is how far through the current sample interval we are,
     * 0 at the instant a sample lands and 1 just before the next one.
     *
     * The newest sample is placed one step to the RIGHT of nowX and the trace is clipped
     * at nowX, so the line emerges from the right edge continuously instead of a new
     * segment popping into existence. Check the seam: just before a push, phase -> 1 and
     * the newest sample sits at exactly nowX; just after, that same sample has aged by one
     * and phase is 0, which puts it at nowX again. No jump, by construction.
     *
     * phase defaults to 1 when the cadence is not yet known, which reproduces the old
     * mapping exactly (newest at nowX) rather than guessing.
     */
    const phase = flowPhase();
    const xOf = (i) => nowX - ((n - 1 - i) + phase - 1) * step;
    flowHeadX = xOf(n - 1);

    /*
     * WHICH SERIES, from the catalogue rather than from a binary switch.
     *
     * `flowKeys` is a set of VizCore.FLOW_SERIES keys, so Flow can plot any mix of electrodes,
     * composites and body signals at once — asked for as "possibly even all (eeg, body, compositves,
     * etc) all on the same graph, visually distinct". Each carries its OWN fixed axis, which is what
     * makes the mix meaningful: alpha share, a 0-100 score and a heart rate are not on one scale.
     */
    const specs = VizCore.FLOW_SERIES.filter((fs) => flowKeys.has(fs.key));
    if (!specs.length) return;
    const composites = specs.some((fs) => fs.family === 'mind');
    const colors = specs.map((fs) => fs.color);
    /* The value cached at record time — see emaStep above. Each series reads itself out of the history
       entry through its own `read`, so adding a signal to the catalogue is all it takes to plot it. A
       null is a GAP and never a zero. */
    const rawAt = (i, k) => specs[k].read(history[i]);
    const freshAt = (i, k) => specs[k].fresh(history[i]);

    // Already smoothed, at record time, once. Reading it here rather than filtering per
    // frame is the whole point: the array below is identical from one frame to the next
    // except for the one sample that was added.
    const series = specs.map((_, k) => history.map((__, i) => rawAt(i, k)));

    // expand() is the difference between a trace and a flat line. Every value
    // here is adaptively normalised against the wearer's own baseline, so a real
    // session occupies roughly 0.35..0.75. The trace still uses that expanded
    // value, but it is drawn inside a protected vertical band instead of the
    // full canvas: very-low values were dropping into the bottom controls and
    // becoming hard to see.
    const flowTop = H * 0.18;
    const flowBottom = H * 0.76;
    /*
     * EACH SERIES IS SCALED TO ITS OWN VISIBLE RANGE — see VizCore.autoRange.
     *
     * expandSoft alone assumed the values were already adaptively normalised into
     * roughly 0.35..0.75. True of the composites, false of the per-channel series,
     * which is a raw alpha/(alpha+beta) ratio: on a beta-dominant sit that ratio sits
     * near 0.2 on every electrode, so every trace pinned to the floor of the band and
     * the whole picture compressed into the bottom third.
     *
     * autoRange falls back to null when there is too little history, in which case
     * expandSoft is used as before rather than nothing being drawn.
     */
    /* HELD ACROSS FRAMES, not recomputed fresh each one. The same range is applied to
       the whole visible history, so recomputing it every frame made the entire recorded
       line rise and sink — the past appearing to move, which is exactly what was
       reported. settleRange widens at once (never clip a real excursion) and narrows a
       few percent per second (nothing is lost by a range that is briefly too wide). */
    /*
     * THE PER-CHANNEL TRACES GET A FIXED AXIS. No auto-range, no settling, no hold — a constant.
     *
     * Reported as "the lines still wildly jump in flow visuals for sensors", and the reason it was still
     * true of sensors after the axis was made to hold is that holding only stops the drift AFTER the
     * warm-up, and an axis derived from a narrow, noisy series moves most while it is still learning.
     *
     * But these series do not need an axis derived from anything. A channel's value here is alpha's share
     * of alpha+beta — a BOUNDED RATIO, already on a fixed scale, where 0.5 means equal alpha and beta for
     * every person on every day. Auto-ranging a quantity that already has a natural scale is what created
     * the movement: it re-derived a scale that was never in question.
     *
     * The reason auto-ranging was added in the first place is still real and is handled by the choice of
     * window rather than by adapting: "on a beta-dominant sit that ratio sits near 0.2 on every electrode,
     * so every trace pinned to the floor of the band". 0..0.75 puts 0.2 a quarter of the way up and 0.5 —
     * the balance point, and the top of the range measured across real sits — at two thirds.
     *
     * The window is 0.75 rather than 0.6 because a fixed axis clips instead of adapting, and a clipped
     * excursion is drawn flat against the edge, which HANDOFF §6 names as reading like a confident detection
     * rather than an out-of-range one. Real sits measured 0.24-0.38, so 0.75 leaves twice the observed
     * range in headroom; anything above it is rarer than the drift was frequent.
     *
     * The upshot is better than a still axis: this one is the same axis in every sit, so two sits' traces
     * are comparable by eye. An auto-ranged trace never was.
     */
    /*
     * EVERY SERIES NOW CARRIES A FIXED AXIS, including the composites.
     *
     * The composites used to learn a range and then freeze it, because they were within-sit normalised
     * scores with no natural scale. They are absolute band shares now (see DSP.bandShares), so 0..1 means
     * the same thing in every sit and there is nothing left to derive. That removes the last adaptive
     * axis in this renderer: no settleRange, no autoRange, no warm-up during which the past moves — and
     * it is what makes two sits' Flow traces comparable by eye, which they never were.
     */
    const ranges = specs.map((fs) => fs.range);
    const yOf = (i, k) => {
      const v = series[k][i];
      if (v == null) return null;
      const u = ranges[k] ? VizCore.inRange(v, ranges[k]) : VizCore.expandSoft(v);
      if (u == null) return null;
      return flowTop + (flowBottom - flowTop) * (1 - u);
    };

    if (flowDebugOn) {
      for (let k = 0; k < 4; k++) flowLastY[k] = series[k].map((_, i) => yOf(i, k));
    }

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

    /* CLIPPED AT nowX, so the sub-sample scroll above has somewhere to scroll FROM.
     * The newest sample is drawn one step to the right of this edge and revealed a
     * fraction at a time. Without the clip the trace would stick out past the head. */
    c.save();
    c.beginPath();
    c.rect(0, 0, nowX, H);
    c.clip();

    // The legend used to be drawn here, for Flow alone. It is now drawn once for
    // every mode at the end of the frame — see the call after the render dispatch.
    // Drawing it inside a renderer meant six other modes each had to remember to,
    // and none of them did.

  // The breath, as a wave about the vertical midpoint: above the centre line is
    // the in-breath, below it the out-breath. Drawn from the same history buffer
    // as everything else, so it is the real recorded breath rather than a sine
    // generated at the current rate — you can see where the rhythm changed.
    //
    // Drawn FIRST and kept dim: it is context for the traces, not another
    // competing line. A first attempt drew it last at 30% amplitude and it
    // completely swamped the sensor data.
    if (history.some((h) => h.breath != null)) {
      const mid = H * 0.5;
      const amp = H * 0.15;
      const breathSeries = history.map((h) => (h.sBreath === undefined ? h.breath : h.sBreath));
      // The midpoint, so "above" and "below" are readable at a glance.
      c.strokeStyle = 'rgba(180,205,235,0.07)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, mid); c.lineTo(nowX, mid); c.stroke();
      // Same age banding as the traces, so the breath dissolves leftward with
      // them instead of sitting there like a fixed grid.
      for (let gi = 0; gi < FLOW_GROUPS; gi++) {
        const i0 = Math.round((gi * (n - 1)) / FLOW_GROUPS);
        const i1 = Math.round(((gi + 1) * (n - 1)) / FLOW_GROUPS);
        if (i1 <= i0) continue;
        const age = 1 - ((i0 + i1) / 2 / (n - 1));
        const vis = Math.pow(1 - age, 0.9);
        for (const pass of [{ w: baseW * 7, a: 0.030 * vis }, { w: baseW * 1.2, a: 0.13 * vis }]) {
          if (pass.a <= 0.004) continue;
          c.beginPath();
          let started = false;
          for (let i = i0; i <= i1; i++) {
            const v = breathSeries[i];
            if (v == null) { started = false; continue; }
            const y = mid - amp * Math.max(-1, Math.min(1, v));
            if (!started) { c.moveTo(xOf(i), y); started = true; } else c.lineTo(xOf(i), y);
          }
          c.strokeStyle = `rgba(134,225,255,${pass.a})`;
          c.lineWidth = Math.max(0.5, pass.w);
          c.stroke();
        }
      }
    }

    /* SOURCE-OVER FOR THE TRACES. `lighter` is additive, so two lines crossing summed toward white and
       every line wore a halo of its own making — that is the "shiny" that was reported. The breath wash
       above and the head glow below keep `lighter`, because both are washes where summing is the
       intended look; only the data lines are solid. */
    c.globalCompositeOperation = 'source-over';
    for (let ch = 0; ch < specs.length; ch++) {
      const col = colors[ch] || [200, 210, 255];
      if (yOf(n - 1, ch) == null) continue;   // nothing to say about this series
      /* An electrode that has never made contact draws NOTHING. Its level is still the initial 0.5,
         which would render as a dead-flat line through the middle. Keyed off the SERIES rather than off
         a mode flag, so this still holds when electrodes and composites are on screen together. */
      if (specs[ch].family === 'eeg' && !everFresh[channelIndexOf(specs[ch])]) continue;
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
        let freshCount = 0, seenCount = 0;
        for (let i = i0; i <= i1; i++) {
          if (series[ch][i] == null) continue;
          seenCount++;
          if (freshAt(i, ch)) freshCount++;
        }
        const freshRatio = seenCount ? freshCount / seenCount : 1;
        const heldDim = composites ? 1 : (0.24 + 0.76 * freshRatio);

        /*
         * ONE SOLID STROKE, not three stacked ones.
         *
         * Asked for: "the lines for flow are still shiny not just solid color." The shine was
         * deliberate and is now wrong. There were three passes per age group — a wide dim halo, a
         * mid one, and a bright core — composited with `lighter`, which is additive: where the halo
         * of one channel crossed another they summed toward white, and every line carried a glow
         * that is not information about anything. That was the local answer to "everything renders
         * into a small buffer that gets upscaled, so softness has to be built in geometry"; a solid
         * line simply does not need it.
         *
         * The age fade STAYS. That is structural rather than decorative — it is how the trace
         * dissolves leftward into the past instead of ending at a hard edge — so alpha still falls
         * with age. What goes is the width stack and the additive blend.
         *
         * Drawn with `source-over` (set below), so a line is its own colour at its own opacity and
         * two crossing lines do not brighten each other.
         */
        const passes = [
          { w: baseW * 2.2, a: (0.30 + 0.70 * vis) * (1 - 0.55 * age) },
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
            if (!freshAt(i, ch) && (i % 8) >= 4) { started = false; continue; }
            const x = xOf(i);
            if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
          }
          c.strokeStyle = rgba(col, p.a * heldDim);
          c.lineWidth = Math.max(0.5, p.w);
          c.stroke();
        }
      }

    }

    // Out of the clip: the head glow is a disc centred ON nowX, so half of it falls to
    // the right of the edge the trace is cut at.
    c.restore();
    /* STILL source-over. The head used to be an additive white-cored glow; it is a solid dot in the
       line's colour now, and additive blending would put the whitening straight back wherever two heads
       or a head and a trace overlap. */

    /* THE LIVE HEAD, at nowX, with its height interpolated between the last two samples
     * by the same phase the trace scrolls by. In its own pass over the channels so that
     * it can sit outside the clip.
     *
     * Interpolating matters as much as the scrolling does: the head is the brightest
     * thing on screen, and pinning it to the newest sample left it hopping four times a
     * second while everything behind it slid. At phase 0 it is exactly the sample
     * arriving at nowX now, and at phase 1 exactly the next one, so it crosses a push
     * without a step either. */
    const headsAt = [];
    for (let ch = 0; ch < specs.length; ch++) {
      const col = colors[ch] || [200, 210, 255];
      if (specs[ch].family === 'eeg' && !everFresh[channelIndexOf(specs[ch])]) continue;
      const yNew = yOf(n - 1, ch);
      if (yNew == null) continue;
      const yPrev = n >= 2 ? yOf(n - 2, ch) : yNew;
      const hy = yPrev == null ? yNew : yPrev + (yNew - yPrev) * phase;
      /*
       * A SOLID DOT, in the channel's own colour.
       *
       * This was a radial gradient whose centre stop was the colour mixed 55% toward WHITE, drawn under
       * `lighter` — so it summed with whatever was behind it and read as a white glow at the head of every
       * line. Asked for twice: "not solid color", "still have the white glow which i asked you to remove".
       * The mockup has a plain round endpoint in the line's own colour, which is also the only version
       * that says something true — the head is where the line is now, not an event.
       */
      const hr = Math.max(2, baseW * 2.6);
      const headFresh = freshAt(n - 1, ch);
      c.fillStyle = rgba(col, headFresh ? 1 : 0.35);
      c.beginPath(); c.arc(nowX, hy, hr, 0, Math.PI * 2); c.fill();
      headsAt.push({ y: hy, col, spec: specs[ch], fresh: headFresh, value: series[ch][n - 1] });
    }
    drawFlowPills(c, W, H, nowX, headsAt);

    // Spikes: small marks left where they happened, fading with the trace
    // rather than staying at full brightness forever.
    for (let i = 0; i < n; i++) {
      const h = history[i];
      const vis = Math.pow(i / Math.max(1, n - 1), 1.2);
      if (vis < 0.05) continue;
      for (let ch = 0; ch < specs.length; ch++) {
        // Spikes belong to an ELECTRODE. A composite or a heart rate has none, and marking one would be
        // attaching an electrode's event to a series that cannot have it.
        if (specs[ch].family !== 'eeg') continue;
        const sp = clamp01(h.spikes[channelIndexOf(specs[ch])]);
        if (sp < 0.5) continue;
        const y = yOf(i, ch);
        if (y == null) continue;
        const col = colors[ch] || [200, 210, 255];
        const x = xOf(i);
        const r = Math.max(2, H * 0.012) * (1 + 1.6 * (1 - vis));
        /* IN THE CHANNEL'S COLOUR, not white. A white halo on the line was the other half of the glow —
           and it also said the wrong thing, since a spike belongs to one electrode and a white mark
           belongs to none of them. */
        c.fillStyle = rgba(col, 0.30 * sp * vis);
        c.beginPath(); c.arc(x, y, Math.max(1.5, r * 0.45), 0, Math.PI * 2); c.fill();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  /* ==== RIBBON =========================================================================================
   *
   * WHAT IT IS. Four silk ribbons flowing left to right across the screen — calm, focus, thinking, drowsy
   * — over a warm bloom at the centre that breathes. The right-hand end is now; the left edge is a minute
   * ago, dissolving.
   *
   * WHY IT EXISTS. Asked for: "look how cool the visual is, vs ours … ours sucks … make a new visual and
   * make it the default for meditate". The rest of the sentence is the part that decides the design: "the
   * point is to represent the data for the user that helps them."
   *
   * So every quality of the picture is a measurement, and there is nothing in it that is only decoration:
   *
   *   - HEIGHT is the score. High is more of that state.
   *   - THICKNESS is the same score again. That redundancy is the whole reason this works as something to
   *     meditate in front of: with your eyes half closed you cannot read four positions, but you can see
   *     which band is broad. Position is for when you look; thickness is for when you don't.
   *   - BRIGHTNESS is the score a third time, so the dominant state is the one that catches the eye.
   *   - THE SHIMMER at the live end is thinking. A settled mind draws still ribbons; an agitated one
   *     ripples. Restricted to the newest third on purpose — see the note on `liveness` below.
   *   - THE CENTRE BLOOM's width is calm and its slow pulse is the breath, so it can be breathed with.
   *
   * WHAT IT DELIBERATELY DOES NOT DO.
   *
   *   - NO DERIVED AXIS. Height comes from a CONSTANT transform of the score, `expandSoft(v, .28, .82)`,
   *     the same in every sit. Flow's composites learn a range and then hold it, which is honest but means
   *     two sits are not comparable by eye and the first two minutes still move. Here the axis is a
   *     constant, so nothing can drift — the complaint that took three rounds to fix cannot recur in this
   *     mode by construction, and last Tuesday's ribbon is directly comparable to today's.
   *   - NO FABRICATED ZERO. A metric with no inputs leaves a GAP in its ribbon. A ribbon that thins to
   *     nothing would read as "calm collapsed" when it means "the headband stopped reading".
   *   - NO BLUR OPS. Softness is gradients and stacked fills, so this mode spends none of the frame's
   *     blur budget (HANDOFF: <=2.2 per frame) and stays smooth on a phone.
   *
   * Rendered at full canvas resolution rather than through the shared 560px buffer: the bright edge along
   * the top of each ribbon is a hairline, and a hairline upscaled 4x is a smear.
   */
  const RIBBON_LO = 0.28;         // the constant axis. See above: a constant, never learned.
  const RIBBON_HI = 0.82;
  const RIBBON_NOW_X = 0.955;     // now sits near the right edge; the eye reads leftward into the past
  const RIBBON_PACER_SEC = 10;    // 6 breaths a minute, when there is no measured breath to follow
  const RIBBON_STRIDE = 3;        // one curve point every third sample — see the note in the span loop

  /*
   * Catmull-Rom through the sample points, emitted as beziers.
   *
   * A ribbon drawn as a polyline is not silk — at four samples a second over a minute the segments are
   * short enough to read as faceted rather than smooth, and the eye finds the facets before it finds the
   * shape. Catmull-Rom passes exactly through every sample (so no value is moved to make the curve
   * prettier, which would be the picture lying about the data) and only interpolates between them.
   */
  /*
   * `join` continues the current subpath instead of starting a new one, and it is not a nicety.
   *
   * A ribbon is ONE closed loop: up the top edge, across, back along the bottom edge, closed. Emitting the
   * second edge with `moveTo` — which is what this did — starts a fresh subpath, so the fill was two
   * separate open curves auto-closed independently and combined by the nonzero winding rule. That fills
   * the LENS between them rather than the band, which is why every ribbon carried a dark wedge tapering
   * into its head: the wedge was the part of the band the fill had skipped.
   */
  function ribbonPath(c, pts, close, join) {
    if (pts.length < 2) return;
    if (join) c.lineTo(pts[0].x, pts[0].y); else c.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) { c.lineTo(pts[1].x, pts[1].y); return; }
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i > 0 ? i - 1 : 0];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      c.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
        p2.x, p2.y,
      );
    }
    if (close) c.closePath();
  }

  function renderRibbon(out, W, H, tSec) {
    /*
     * TWO CONTEXTS, DELIBERATELY.
     *
     * `c` is the half-resolution layer that every soft pass goes into, with a 0.5 transform applied so the
     * code below can keep working in output-canvas coordinates and not think about it. `out` is the real
     * canvas, and the only things drawn straight onto it are the hairline crest along each ribbon's lit
     * edge and the head dots — the two things that have to be sharp. See RIBBON_SCALE.
     */
    const c = ribctx;
    const rw = rib.width, rh = rib.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, rw, rh);
    c.setTransform(rw / W, 0, 0, rh / H, 0, 0);
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);

    // Background. Warmer at the bottom than Flow's, so the bloom has something to sit in rather than
    // being a light source in a vacuum.
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04060f');
    bg.addColorStop(0.55, '#070915');
    bg.addColorStop(1, '#0b0713');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    const nowX = W * RIBBON_NOW_X;
    const top = H * 0.14;
    const bottom = H * 0.80;
    const bandH = bottom - top;
    const midY = (top + bottom) / 2;

    /* ---- THE CENTRE BLOOM ----------------------------------------------------------------------------
     *
     * Two real signals and no invented ones.
     *
     * WIDTH is calm: a settled mind opens the glow out across the screen, an agitated one pulls it into a
     * tight knot. That direction round because the wide, low, warm field is the one that is pleasant to
     * look at, and the visual should be nicer when the thing it is measuring is going well.
     *
     * THE PULSE is the breath. Measured breath when there is one — `smooth.breathAmount` is a real phase
     * estimate, -1 exhaled to +1 inhaled. When there is none, it falls back to a FIXED 10-second cycle,
     * and the legend says which of the two it is doing (`driver`), because a pacer presented as your own
     * breath is exactly the kind of unearned claim this project forbids. A pacer is worth having — six
     * breaths a minute is a real practice — but only when it is labelled as one.
     */
    const measured = smooth.breathAmount != null;
    const pulse = measured
      ? clamp01(0.5 + 0.5 * smooth.breathAmount)
      : 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / RIBBON_PACER_SEC);
    const bloomW = W * (0.34 + 0.44 * calm) * (0.93 + 0.12 * pulse);
    const bloomH = bandH * (0.50 + 0.34 * calm) * (0.90 + 0.16 * pulse);
    // Warm when calm, cooler and more violet when busy. Never white: a white core reads as a blown
    // highlight rather than as light, and it is what made the old modes look bleached.
    const warm = mixColor([132, 122, 205], [255, 172, 108], Math.pow(calm, 0.8));
    const glowA = 0.20 + 0.26 * calm + 0.08 * pulse;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.translate(W * 0.46, midY);
    c.scale(1, bloomH / bloomW);
    const bloom = c.createRadialGradient(0, 0, 0, 0, 0, bloomW);
    bloom.addColorStop(0, rgba(warm, glowA));
    bloom.addColorStop(0.22, rgba(warm, glowA * 0.74));
    bloom.addColorStop(0.46, rgba(mixColor(warm, [196, 118, 208], 0.42), glowA * 0.40));
    bloom.addColorStop(0.74, rgba([84, 104, 205], glowA * 0.16));
    bloom.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = bloom;
    c.beginPath(); c.arc(0, 0, bloomW, 0, Math.PI * 2); c.fill();
    /* A TIGHTER CORE on top of the wide field. One gradient cannot be both a soft hall of light and a
       thing with a centre — the falloff that reads as atmosphere at the edge has no core left in the
       middle, which is why the first version looked like haze rather than a bloom. */
    const core = c.createRadialGradient(0, 0, 0, 0, 0, bloomW * 0.30);
    core.addColorStop(0, rgba(mixColor(warm, [255, 226, 190], 0.30), glowA * 0.62));
    core.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = core;
    c.beginPath(); c.arc(0, 0, bloomW * 0.30, 0, Math.PI * 2); c.fill();
    c.restore();

    /* THE LAYER STILL HAS TO REACH THE SCREEN when there is not enough history to draw a ribbon — the
       background and the bloom are already in it, and returning here without blitting left the canvas
       blank for the first second of every sit. */
    const blit = () => {
      out.clearRect(0, 0, W, H);
      out.imageSmoothingEnabled = true;
      out.imageSmoothingQuality = 'high';
      out.drawImage(rib, 0, 0, rw, rh, 0, 0, W, H);
    };
    if (history.length < 3) { blit(); return; }

    const n = history.length;
    const step = nowX / (FLOW_MAX - 1);
    /* The same sub-sample scroll Flow uses, and for the same reason: without it the newest sample pops
       into existence four times a second and the whole picture ticks. See flowPhase. */
    const phase = flowPhase();
    const xOf = (i) => nowX - ((n - 1 - i) + phase - 1) * step;

    const heads = [];
    /* The crest paths, kept for the sharp pass below rather than stroked now. `style` is a THUNK, not a
       gradient: a CanvasGradient belongs to the context that made it, and one made on the half-res layer
       is not usable on the output canvas. */
    const crests = [];
    /* NO CLIP AT THE HEAD, and a POINTED TIP instead — which is the fix for the hard vertical edge the
     * first version cut across all four ribbons.
     *
     * Flow clips at nowX because it has to: its newest sample is drawn one step to the RIGHT of that edge
     * and revealed a fraction at a time, so that a new sample slides in rather than popping into
     * existence. A line disappearing into a clip looks like a line continuing. A filled ribbon does not —
     * it looks like a ribbon that has been guillotined, and with a head dot sitting on the cut it read as
     * four ribbons plugged into four balls.
     *
     * So the ribbon TAPERS TO A POINT at its newest sample and there is no clip. A point has no blunt end
     * to pop, and the <=6px of sub-sample glide that the clip existed to hide is, on a taper, a tip
     * gliding smoothly — which is what it actually is. See `tip` below for the cost.
     */
    c.globalCompositeOperation = 'lighter';

    for (let k = 0; k < 4; k++) {
      const spec = VizCore.PULSE_METRICS[k];
      const col = spec.color;
      /* THE LANE. Each ribbon owns a horizontal slice of the band, so which lane a ribbon is in is fixed
         and you learn where to look for calm. Within its lane it still moves by its value, which is what
         carries the reading.
         The swing is DELIBERATELY WIDER THAN THE LANE SPACING, so neighbouring ribbons cross and
         interweave when their values pull apart. Silk that never touches is four stripes; the braiding is
         where the material comes from, and under additive blending a crossing lights up — which happens
         to put the light exactly where two states are trading off, the most interesting thing on screen. */
      const laneMid = top + bandH * (0.19 + 0.205 * k);
      const laneSwing = bandH * 0.185;

      const upper = [];
      const lower = [];
      let head = null;
      for (let i = 0; i < n; i++) {
        const raw = history[i].sMetrics ? history[i].sMetrics[k] : null;
        if (raw == null || !Number.isFinite(raw)) {
          // A gap: a null in both edges, split into separate filled spans below.
          upper.push(null); lower.push(null);
          continue;
        }
        const v = clamp01(raw);
        const e = VizCore.expandSoft(v, RIBBON_LO, RIBBON_HI);
        const x = xOf(i);
        /*
         * LIVENESS: how much this sample is allowed to shimmer. 1 at the head, 0 by the time it is a
         * third of the way back.
         *
         * This is the one piece of motion in the picture that is not a value, and it is fenced in for a
         * reason that took three rounds to learn: a past that moves is indistinguishable from a
         * measurement that drifts, and drift is what made the old traces untrustworthy. So the record
         * behind you is exactly still, and only the live end — where you are actually looking — breathes.
         * The amplitude is thinking, and it is capped at 2.5% of the band, small enough to read as
         * texture on the ribbon rather than as the ribbon moving.
         */
        const age = (n - 1 - i) / Math.max(1, n - 1);
        const liveness = smoothstep(0.34, 0.0, age);
        /* KEYED TO THE SAMPLE, not to `x`. On screen position the shimmer pattern is fixed in space and
           the ribbon slides through it, which beats against the scroll and is the other half of the chop.
           On `seq` the ripple travels WITH the sample, which is what a ripple on a moving surface does. */
        const seq = history[i].seq == null ? i : history[i].seq;
        const shimmer = bandH * 0.025 * thinking * liveness
          * Math.sin(seq * 0.42 + tSec * 1.5 + k * 2.1);
        const y = laneMid + laneSwing * (0.5 - e) * 2 + shimmer;
        /* THICKNESS IS THE VALUE AGAIN. The floor is not zero: a ribbon must stay visible at its lowest,
           or "calm is low" and "calm is not being measured" look the same, and only one of those is a
           thing the picture is allowed to say. The gap above is what says the other. */
        const full = bandH * (0.010 + 0.075 * Math.pow(e, 1.2));
        /* THE TAPER, and its cost stated plainly: over the newest ~1.5 seconds the thickness is not the
           value. Everywhere else it is. That is the trade for a tip instead of a cut, and it is a good one
           because the head dot is sized from the same `e` — the reading is not lost at the head, it moves
           into the dot, which is where the eye is anyway. */
        const tip = 0.14 + 0.86 * smoothstep(0, 0.026, age);
        const halfW = full * tip;
        upper.push({ x, y: y - halfW, w: halfW, tip });
        lower.push({ x, y: y + halfW, w: halfW, tip });
        head = { x, y, e, halfW: full };
      }

      // Split at the gaps. Each surviving stretch is filled on its own, so a dropout is a hole in the
      // ribbon rather than a straight line drawn across the missing minute.
      const spans = [];
      let s = -1;
      for (let i = 0; i <= n; i++) {
        const ok = i < n && upper[i] != null;
        if (ok && s < 0) s = i;
        if (!ok && s >= 0) { if (i - s > 2) spans.push([s, i]); s = -1; }
      }
      if (!spans.length) continue;

      /* AGE FADE, as ONE gradient across the whole width rather than by drawing the ribbon in bands. Three
         fills and three gradients per ribbon regardless of how soft it looks, so the cost of this mode
         does not grow with its softness the way a stack of blurred passes would. */
      const bright = 0.42 + 0.48 * (head ? head.e : 0.5) + 0.10 * focus;
      const rampOn = (target, a0, a1, a2, tint) => {
        const g = target.createLinearGradient(0, 0, nowX, 0);
        const cc = tint ? mixColor(col, [255, 255, 255], tint) : col;
        g.addColorStop(0, rgba(cc, 0));
        g.addColorStop(0.26, rgba(cc, a0 * bright));
        g.addColorStop(0.74, rgba(cc, a1 * bright));
        g.addColorStop(1, rgba(cc, a2 * bright));
        return g;
      };
      const ramp = (a0, a1, a2, tint) => rampOn(c, a0, a1, a2, tint);
      /* THREE PASSES, WIDEST FIRST — and this is where the silk comes from rather than from any blur.
       * An aura two and a half times the ribbon's width at a tenth of its alpha, the body at full alpha,
       * and a hairline along the lit edge. Stacked additively they give a soft-shouldered band with a
       * bright crest, which is what a lit fold of cloth looks like. The first version drew only the body,
       * at a fifth of this alpha, and read as smoke. */
      const aura = ramp(0.014, 0.028, 0.044, 0.05);
      const body = ramp(0.10, 0.25, 0.38, 0);
      const crest = () => rampOn(out, 0.12, 0.40, 0.78, 0.34);
      /*
       * THE LIGHT ACROSS THE RIBBON'S THICKNESS, AS A STACK OF NESTED FILLS.
       *
       * The ribbon needs to be brightest near its top edge and fall off toward its bottom, so it reads as
       * a lit surface rather than a flat strip. A gradient cannot do it: the ribbon's centre line moves up
       * and down across the screen, and a canvas gradient is fixed in page space, so a vertical ramp would
       * slide across the ribbon instead of following it.
       *
       * So the falloff is built out of fills that each start at the top edge and stop at a different depth.
       * Where seven of them overlap the light is seven deep, where one does it is one deep, and the sum is
       * a ramp. This replaces two such fills, which is the same idea at a resolution where it does not work:
       * two overlapping bands are two HARD EDGES across every ribbon, and at a 45px-thick calm ribbon they
       * read as a pair of dark diagonal seams running the width of the screen rather than as shading.
       *
       * Seven because the step is then about a seventh of the total, which at these alphas is under the
       * threshold where an edge is visible.
       */
      const SHEEN_STEPS = 7;
      const sheen = ramp(0.038, 0.095, 0.160, 0.26);

      for (const [a, b] of spans) {
        /*
         * DECIMATED: one curve point every third sample.
         *
         * The history is 240 samples across ~1375px — one control point every 5.7px. A Catmull-Rom curve
         * through points that close together is indistinguishable from one through every third point, and
         * every one of them is paid for eleven times over: two aura fills, a body, seven sheen fills and a
         * stroke, four ribbons deep. See RIBBON_SCALE for what was and was not measured about this.
         *
         * The newest point is always kept whatever the stride lands on, because that is where the head dot
         * goes and a head that snapped between every third sample would tick visibly.
         */
        /*
         * CHOSEN BY THE SAMPLE'S OWN IDENTITY, not by its position in the array — and this is the fix for
         * "the ribbon is really choppy".
         *
         * The array scrolls: every push shifts every index by one. Selecting `i % 3 === 0` therefore
         * re-picks a DIFFERENT third of the samples four times a second, and a Catmull-Rom curve through a
         * different control set is a different curve. So the whole ribbon re-shaped on every sample —
         * small in amplitude, but four times a second, everywhere at once, which is exactly what reads as
         * chop rather than as movement.
         *
         * `seq` is a counter that belongs to the sample, so a given sample is a control point for its whole
         * life or never. The curve behind the head then never changes shape again.
         */
        const idx = [];
        for (let i = a; i < b; i++) {
          const h = history[i];
          if (h.seq == null || h.seq % RIBBON_STRIDE === 0) idx.push(i);
        }
        if (!idx.length || idx[idx.length - 1] !== b - 1) idx.push(b - 1);
        const up = idx.map((i) => upper[i]);
        const dn = idx.map((i) => lower[i]).reverse();
        /* `grow` is a MULTIPLE OF EACH POINT'S OWN HALF-WIDTH, not a constant number of pixels. A constant
           would keep the aura full width where the ribbon has tapered to a point, putting a blunt 18px
           shoulder exactly where the taper exists to avoid one. */
        const band = (topOf, botOf, style) => {
          c.fillStyle = style;
          c.beginPath();
          ribbonPath(c, up.map(topOf), false);
          ribbonPath(c, dn.map(botOf), true, true);
          c.fill();
        };
        const same = (q) => q;
        band((q) => ({ x: q.x, y: q.y - q.w * 2.0 }), (q) => ({ x: q.x, y: q.y + q.w * 2.0 }), aura);
        band((q) => ({ x: q.x, y: q.y - q.w * 0.9 }), (q) => ({ x: q.x, y: q.y + q.w * 0.9 }), aura);
        band(same, same, body);
        /* THE LIT SIDE. A second fill over the TOP HALF of the band only, so the light has a direction and
           the ribbon reads as a surface rather than a tube — that is the whole difference between a ribbon
           and a pipe.
           It is a fill and not a dark stroke along the bottom, which is what the first attempt used: under
           `lighter` nothing can be darkened, so a "shadow" colour was simply added and appeared as a
           second dim ribbon running under the real one. Additive blending only lights; shade has to be the
           ABSENCE of a highlight. */
        c.globalAlpha = 1 / SHEEN_STEPS;
        for (let j = 1; j <= SHEEN_STEPS; j++) {
          /* Depth of this fill below the top edge, as a fraction of the full thickness. Squared, so the
             fills crowd near the top: that puts most of the light in the first third of the band, which is
             where a highlight sits on a real fold, and leaves the bottom third unlit. */
          const f = 0.88 * Math.pow(j / SHEEN_STEPS, 1.7);
          /* `q` here is a point on the BOTTOM edge, at y_c + w — so the top edge is q.y - 2w, and a depth
             of f through the thickness is q.y - 2w + 2wf. Getting this wrong by one w (using q.y - w, the
             centre line) sent every fill up to 76% BELOW the ribbon's own bottom edge: the stack lit the
             empty space under each ribbon and left a dark seam along the edge itself. */
          band(same, (q) => ({ x: q.x, y: q.y - q.w * 2 + q.w * 2 * f }), sheen);
        }
        c.globalAlpha = 1;
        // The crest is NOT stroked here: a hairline through a half-resolution layer arrives on screen
        // two pixels wide and soft, which is the one thing about this picture that has to be neither.
        crests.push({ pts: up, style: crest });
      }

      if (head) heads.push({ head, col });
    }

    /* THE LAYER, UP TO SIZE. `imageSmoothingQuality: high` because this is a 2x upscale of gradients, and
       the cheap filter puts visible steps in a slow ramp — the exact artefact the soft passes exist to
       avoid. */
    blit();

    // ---- THE SHARP PASS, straight onto the output canvas ----
    out.save();
    out.globalCompositeOperation = 'lighter';
    out.lineJoin = 'round';
    out.lineWidth = Math.max(1, H * 0.0026);
    for (const { pts, style } of crests) {
      out.strokeStyle = style();
      out.beginPath(); ribbonPath(out, pts, false); out.stroke();
    }

    /* THE HEADS, LAST. Where each ribbon is right now, as a dot in the metric's own colour, sized from the
     * same value that sets the ribbon's thickness — so the reading the taper gives up over the last second
     * and a half is carried here instead of lost.
     * Solid colour, not mixed toward white: "the lines … still have the white glow which i asked you to
     * remove" is a rule about every mode, not only the one it was reported against.
     */
    for (const { head, col } of heads) {
      const r = Math.max(2, Math.min(bandH * 0.020, head.halfW * 0.62));
      const halo = out.createRadialGradient(head.x, head.y, 0, head.x, head.y, r * 4.5);
      halo.addColorStop(0, rgba(col, 0.26));
      halo.addColorStop(1, rgba(col, 0));
      out.fillStyle = halo;
      out.beginPath(); out.arc(head.x, head.y, r * 4.5, 0, Math.PI * 2); out.fill();
      out.fillStyle = rgba(col, 0.62 + 0.28 * head.e);
      out.beginPath(); out.arc(head.x, head.y, r, 0, Math.PI * 2); out.fill();
    }
    out.restore();
  }

  /* Which of the two things the centre bloom is doing, so the key can say so rather than implying the
     nicer of the two. Read by app.js when it asks for a legend. */
  function ribbonBreathDriver() { return smooth.breathAmount != null ? 'breath' : 'pacer'; }

  /* ==== LUMEN =========================================================================================
   *
   * WHAT IT IS. Drifting lobes of coloured light that overlap and merge, like light through moving water.
   * No axis, no head, no plotted history — nothing in it reads as a chart.
   *
   * WHY IT EXISTS, and it is a correction. Ribbon was built for the Meditate screen and the report was:
   * "it's too similar to flow. i wanted abstract and beautiful. the one you made is really choppy too."
   * Both true, and the two faults have one cause: Ribbon's GEOMETRY IS THE SAMPLE BUFFER. Drawing the
   * history as filled bands rather than as lines makes it a prettier chart, not a different kind of
   * picture — and any shape derived from a 4Hz buffer changes four times a second no matter how it is
   * smoothed, which is what chop is.
   *
   * So nothing here touches `history`. Every lobe's position is a continuous function of elapsed time, and
   * the DATA only sets parameters that are already eased per frame in `smooth`. That makes it smooth by
   * construction at any frame rate: there is no sample arrival for the eye to catch.
   *
   * WHAT IS STILL A READING. The same discipline as everywhere else — nothing here is decoration:
   *
   *   COHERENCE   focus. High focus draws the lobes toward one centre and slows them; low focus lets them
   *               scatter to the corners. So absorption looks like one thing and distraction looks like
   *               several, which is the distinction the state actually has.
   *   HUE         calm against thinking. Amber and gold when settled, violet and magenta when busy, on the
   *               same warm-to-cool axis the metrics panel uses.
   *   DRIFT SPEED thinking. A quiet mind moves the field slowly.
   *   BREADTH     calm. Settling opens the lobes out; agitation contracts them into tighter knots.
   *   BRIGHTNESS  calm, so the picture is nicer when the thing it measures is going well.
   *   THE PULSE   your measured breath, or a fixed 10s pacer when nothing is measuring one — and the key
   *               says which, in those words. A pacer presented as your own breathing is the unearned
   *               claim this project forbids; a pacer that says it is one is a real practice tool.
   *
   * WHAT IT CANNOT DO, said plainly: it has no memory. You cannot look at it and see how the sit went,
   * which is the whole point of Iris and of Flow. It is a mirror, not a record.
   */
  /*
   * FIVE LARGE LOBES, NOT SEVEN SMALL ONES — and this is the difference between a field of light and a
   * scatter of dots, which is what the first two attempts were.
   *
   * Discrete radial gradients only read as one luminous body if they overlap almost entirely AND are drawn
   * bright. Seven modest lobes spread over half the frame at a fifth of an alpha each is seven visible
   * discs whose colours average to grey in the gaps. Five that each cover most of the short side, at two
   * or three times that alpha, sum into a single mass whose interior varies — which is the look.
   */
  const LUMEN_LOBES = 5;
  const LUMEN_PACER_SEC = 10;

  /*
   * Each lobe's own slow path, as a pair of incommensurable sine terms.
   *
   * Incommensurable on purpose: two frequencies with a rational ratio close and the lobe retraces the same
   * closed loop every few seconds, which the eye learns and then reads as a mechanism. The ratios here are
   * irrational multiples so the path never exactly repeats, and each lobe gets its own phase so the seven
   * of them never line up into a pattern.
   */
  const LUMEN_PATHS = Array.from({ length: LUMEN_LOBES }, (_, i) => ({
    // Small excursions, so the lobes stay overlapped and the mass kneads rather than dispersing.
    ax: 0.13 + 0.07 * ((i * 7) % 5) / 4,
    ay: 0.11 + 0.07 * ((i * 3) % 4) / 3,
    fx: 0.021 + 0.0135 * Math.sqrt(i + 1),
    fy: 0.017 + 0.0122 * Math.sqrt((i * 2 + 3) % 7 + 1),
    px: i * 2.399963,          // the golden angle in radians, so the phases spread evenly
    py: i * 1.399963 + 0.7,
    hue: i / LUMEN_LOBES,
  }));

  function renderLumen(c, W, H, tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);

    const measured = smooth.breathAmount != null;
    const pulse = measured
      ? clamp01(0.5 + 0.5 * smooth.breathAmount)
      : 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / LUMEN_PACER_SEC);

    // The ground. Warmer at the bottom so the field has somewhere to sit rather than floating in a void.
    /* THE GROUND FOLLOWS THE MOOD TOO. A cool navy ground tints a dim warm field toward muddy violet — at
       calm 0.9 the picture read violet while every lobe colour in it was amber, because the ground was
       most of what was visible. So the ground warms as the field does, and the two agree. */
    const mood0 = Math.pow(clamp01(smooth.calm), 0.75);
    const g0 = mixColor([5, 6, 15], [14, 8, 8], mood0);
    const g1 = mixColor([12, 7, 20], [26, 14, 11], mood0);
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, rgba(g0, 1));
    bg.addColorStop(0.6, rgba(mixColor(g0, g1, 0.5), 1));
    bg.addColorStop(1, rgba(g1, 1));
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    const min = Math.min(W, H);
    const cx = W * 0.5;
    const cy = H * 0.47;
    /* COHERENCE. At focus 1 the lobes sit almost on top of each other and the field is one form; at 0 they
       use most of the frame. Cubed so the gathering happens at the top of the range, where the difference
       between concentrated and very concentrated is the one worth showing. */
    /*
     * A FLOOR UNDER THE GATHERING. With no floor, high focus pulled the five lobes essentially concentric
     * and the picture became one featureless blown-out disc — verified at a real `smooth.calm` of 0.92,
     * after three rounds of tuning against 0.28 because the harness was racing the app's own tick.
     * Gathering has to produce a coherent FORM, not a point.
     */
    const spread = 1 - 0.42 * Math.pow(focus, 2);
    // A quiet mind moves the field slowly. The floor is not zero: a frozen picture reads as broken.
    const rate = 0.30 + 1.25 * thinking;
    const t = tSec * rate;
    // Settling opens the lobes; agitation knots them. The breath pulse rides on top of both.
    // Each lobe covers most of the short side, so five of them are one body and not five shapes.
    const size = min * (0.30 + 0.17 * calm) * (0.94 + 0.12 * pulse);
    /*
     * DRAWN GENUINELY BRIGHT, and the first version was not.
     *
     * It used 0.055-0.13 and came out as a brown-grey haze with no form in it. HANDOFF says exactly why:
     * "additive colour at low alpha over near-black desaturates toward grey — either draw genuinely
     * bright, or use a light ground". Seven lobes at a twentieth of an alpha each sum to a flat wash whose
     * hue has been averaged away, which is the failure that made several earlier visuals colourless.
     */
    /*
     * TUNED FOR THE SUM, not for one lobe. Five lobes overlapping almost entirely means the alpha that
     * matters is roughly five times this — at 0.34+0.34*calm the centre saturated to white and the picture
     * was a blown-out pink blob. The overlap is what should be bright; each lobe on its own is faint.
     */
    const bright = 0.17 + 0.15 * calm;

    /* THE PALETTE, warm-to-cool on the same axis the metrics panel uses. `hue` walks each lobe a little
       way along it so the field has variation rather than being one colour at seven opacities. */
    /* SATURATED ENDS. A palette whose members are close together averages to grey the moment it is added
       up, which is precisely what seven overlapping lobes do. */
    const WARM = [255, 158, 74];
    const GOLD = [255, 214, 130];
    const COOL = [168, 96, 255];
    const DEEP = [72, 92, 232];
    const mood = Math.pow(calm, 0.75);

    c.save();
    c.globalCompositeOperation = 'lighter';
    /* A VERY SLOW WHOLE-FIELD ROTATION. Without it the lobes drift but the composition does not, and over
       minutes that reads as static. One turn every eight minutes or so — below the threshold where the eye
       reads it as motion, above the one where nothing is happening. */
    c.translate(cx, cy);
    c.rotate(tSec * 0.0021 * (0.5 + 0.5 * calm));
    c.translate(-cx, -cy);

    for (let i = 0; i < LUMEN_LOBES; i++) {
      const p = LUMEN_PATHS[i];
      const x = cx + Math.sin(t * p.fx * 2 * Math.PI + p.px) * W * p.ax * spread;
      const y = cy + Math.sin(t * p.fy * 2 * Math.PI + p.py) * H * p.ay * spread;
      /* Each lobe breathes on its own slow cycle as well as with the global pulse, so the field kneads
         rather than scaling as a whole — that is what makes it read as liquid instead of as a zoom. */
      const own = 0.78 + 0.30 * Math.sin(t * (0.031 + 0.011 * i) * 2 * Math.PI + p.py * 1.7);
      /* SIZES VARY PER LOBE. Seven identical discs sum to one smooth dome with no internal structure —
         which is what the first version was. A mix of broad, faint lobes and smaller, denser ones is what
         makes the overlaps read as ridges of light rather than as an average. */
      const scale = 0.72 + 0.55 * ((i * 3) % 5) / 4;
      const r = size * own * scale;
      if (!(r > 0)) continue;
      /*
       * ELLIPTICAL, EACH AT ITS OWN SLOWLY TURNING ANGLE — this is where the structure comes from.
       * Overlapping circles sum to a bigger circle, however many there are; overlapping ellipses at
       * different angles sum to ridges and lens shapes that move against each other. That is the
       * difference between a glow and a picture, and it costs one transform per lobe.
       */
      const ecc = 0.52 + 0.34 * ((i * 2) % 3) / 2;
      const ang = p.px + t * (0.013 + 0.006 * i) * 2 * Math.PI;
      const warm = mixColor(COOL, WARM, mood);
      const core = mixColor(warm, mixColor(DEEP, GOLD, mood), p.hue);
      /* A DENSE CORE AND A LONG TAIL, rather than a linear falloff. The near stops carry most of the alpha
         over a fifth of the radius, so each lobe has a centre the eye can find; the tail is what merges. */
      const a0 = bright / Math.sqrt(scale);      // small lobes denser, so total light stays even
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      /*
       * THE TAIL MUST FOLLOW THE MOOD, and this was the bug that made a settled sit look violet.
       *
       * The far stop used to mix 55% toward DEEP — a blue-violet — regardless of state. The tails are most
       * of the picture's AREA, so five overlapping violet tails set the colour of the whole field while the
       * cores, which were correctly amber, were five small dots inside it. The key said "warm is settled"
       * over a violet screen.
       *
       * So the shade the tail falls toward is itself on the warm-to-cool axis: a deep ember when settled, a
       * deep indigo when busy. And the core is less peaked (0.22 carries most of the near alpha) so the
       * lobes read as one body rather than as five bright points in a haze.
       */
      const shade = mixColor(DEEP, [128, 52, 26], mood);
      g.addColorStop(0, rgba(mixColor(core, GOLD, 0.22 * mood), a0 * 0.95));
      g.addColorStop(0.24, rgba(core, a0 * 0.78));
      g.addColorStop(0.52, rgba(mixColor(core, shade, 0.30), a0 * 0.34));
      g.addColorStop(0.78, rgba(shade, a0 * 0.12));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.save();
      c.translate(x, y);
      c.rotate(ang);
      c.scale(1, ecc);
      c.translate(-x, -y);
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.restore();
    }

    /* THE CORE. Where the lobes gather, one tighter warm centre — so at high focus the field has a middle
       to rest the eye on, and at low focus it is lost among them, which is the honest picture of both. */
    const coreR = min * (0.05 + 0.10 * focus) * (0.9 + 0.2 * pulse);
    const cg = c.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    const cCol = mixColor(mixColor(COOL, GOLD, mood), [255, 240, 214], 0.25);
    cg.addColorStop(0, rgba(cCol, (0.05 + 0.08 * calm) * (0.30 + 0.70 * focus)));
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = cg;
    c.beginPath(); c.arc(cx, cy, coreR, 0, Math.PI * 2); c.fill();
    c.restore();

    /* A VIGNETTE, so the mass sits INSIDE something rather than bleeding off every edge. Multiplied down
       rather than added: this is the one place in the picture that needs to darken, and `lighter` cannot. */
    c.globalCompositeOperation = 'source-over';
    const vig = c.createRadialGradient(cx, cy, min * 0.28, cx, cy, Math.max(W, H) * 0.78);
    vig.addColorStop(0, 'rgba(3,4,10,0)');
    vig.addColorStop(0.62, `rgba(3,4,10,${0.30 - 0.10 * calm})`);
    vig.addColorStop(1, `rgba(2,3,8,${0.74 - 0.14 * calm})`);
    c.fillStyle = vig;
    c.fillRect(0, 0, W, H);
  }

  function lumenBreathDriver() { return smooth.breathAmount != null ? 'breath' : 'pacer'; }

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
      // Eased, not raw — see smooth.metrics. Writing the 4Hz value into a 60fps ring is what
      // made the dial step.
      const raw = smooth.metrics[m.key] != null ? smooth.metrics[m.key] : null;
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
  const coronaRings = VizCore.PULSE_METRICS.map(() => new VizCore.SweepRing({
    bins: PULSE_BINS, revSec: PULSE_REV_SEC,
  }));
  // Much hotter than Pulse: the request was explicitly for more sensitivity, and
  // with no crisp outline to read there is nothing to see unless the shape moves
  // a lot. levelMix near zero means a steady mind draws a quiet even ring and
  // all the visible structure is genuine change.
  const coronaDevs = VizCore.PULSE_METRICS.map(() => new VizCore.DeviationTracker({
    gain: 10.0, levelMix: 0.018, rate: 0.055,
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
      const raw = smooth.metrics[m.key] != null ? smooth.metrics[m.key] : null;
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

  function renderCoronaDiffuse(c, W, H, tSec) {
    const cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) * 0.46;

    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1026');
    bg.addColorStop(1, '#050813');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    VizCore.PULSE_METRICS.forEach((m, mi) => {
      // Eased, not raw — see smooth.metrics.
      const raw = smooth.metrics[m.key] != null ? smooth.metrics[m.key] : null;
      coronaRings[mi].write(tSec, coronaDevs[mi].update(raw == null ? null : VizCore.expandSoft(raw)));
    });

    const voidR = maxR * 0.56;
    c.globalCompositeOperation = 'lighter';
    c.lineJoin = 'round';
    c.lineCap = 'round';

    VizCore.PULSE_METRICS.forEach((m, mi) => {
      const ring = coronaRings[mi];
      const prof = ring.profile({ smoothBins: 13, leadIn: 0.09, curve: 1.75 });
      const phaseOffset = (mi - 1.5) * 0.010;
      for (let b = 0; b < PULSE_BINS; b++) {
        const v = prof[b];
        if (v < 0.018) continue;

        const age = ring.age(b);
        const freshness = Math.pow(1 - age, 0.85);
        const a = (b / PULSE_BINS + phaseOffset) * Math.PI * 2;
        const span = (Math.PI * 2 / PULSE_BINS) * (1.75 + 2.5 * v);
        const base = voidR * (1.02 + 0.035 * mi) + maxR * 0.20 * freshness;
        const r = base + maxR * (0.56 + 0.10 * mi) * Math.pow(v, 0.82);
        const alpha = Math.pow(v, 0.75) * freshness;
        const strokes = [
          { w: 0.135, a: 0.060 },
          { w: 0.070, a: 0.095 },
          { w: 0.030, a: 0.155 },
        ];

        for (const s of strokes) {
          c.beginPath();
          c.arc(cx, cy, Math.max(2, r), a - span, a + span);
          c.strokeStyle = rgba(m.color, s.a * alpha);
          c.lineWidth = Math.max(1, Math.min(W, H) * s.w * (0.70 + 0.55 * v));
          c.stroke();
        }
      }
    });

    c.globalCompositeOperation = 'source-over';
    const vg = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, voidR));
    vg.addColorStop(0, 'rgba(3,5,14,0.94)');
    vg.addColorStop(0.48, 'rgba(4,6,17,0.76)');
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

    /*
     * THE SETTLING SEAM — the line the folds are supposed to settle INTO.
     *
     * Reported as "the silk visual has an almost flat horizontal line thru it that never goes away.
     * prob some artifact." It was not an artifact, it was this, and it was on essentially always.
     *
     * Two faults, both from the same mistake of gating a continuous thing with a threshold. It appeared
     * whenever `calm > 0.45 || focus > 0.35`, and Calm was normalised within the sit so it sat at ~0.50
     * by construction while focus sat near 0.65 — so the OR was true for practically every frame of
     * every sit. And its amplitude was under 1% of the short side, so what it drew was not a seam the
     * folds had settled into but a permanent flat rule across the picture.
     *
     * Now it fades in with `settle`, the same quantity the folds themselves flatten with, so it is a
     * consequence of settling rather than a separate switch that happens to be on. Below a third settled
     * it is not drawn at all; the alpha ramps from there, so it never appears at full strength in one
     * frame. And it carries real curvature that straightens as settling completes, which is the thing it
     * was meant to depict: at half settled it is one more fold, at fully settled it is the horizon.
     */
    const seam = smoothstep(0.32, 0.85, settle);
    if (seam > 0.01) {
      const ridge = c.createLinearGradient(-width * 0.5, 0, width * 0.5, 0);
      ridge.addColorStop(0, 'rgba(90,190,255,0)');
      ridge.addColorStop(0.43, `rgba(138,222,255,${(0.06 + 0.12 * calm) * seam})`);
      ridge.addColorStop(0.56, `rgba(255,219,166,${(0.08 + 0.16 * focus) * seam})`);
      ridge.addColorStop(1, 'rgba(255,170,210,0)');
      c.strokeStyle = ridge;
      c.lineWidth = Math.max(1, min * (0.003 + 0.004 * focus));
      // Curvature from what is LEFT to settle, so the line is a fold until it is a horizon.
      const bend = min * 0.075 * (1 - seam);
      c.beginPath();
      c.moveTo(-width * 0.46, breath * min * 0.006);
      c.bezierCurveTo(-width * 0.15, -bend, width * 0.14, bend * 0.7,
        width * 0.46, breath * min * 0.006);
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
    } else if (smooth.breathAmount != null) {
      // "Follow me" now genuinely FOLLOWS. Previously it ran a synthetic sine at
      // roughly the measured RATE, which is not the same thing at all — it drifts
      // out of step with the actual breath within a cycle or two. This is the
      // measured phase from RSA, so the visual moves when the person does.
      //
      // It lags by about a fifth of a cycle, because the heart responds to
      // breathing rather than predicting it. Fine to watch; do not treat it as
      // a metronome to breathe against.
      amount = 0.5 + 0.5 * smooth.breathAmount;
      breathLabel = smooth.breathAmount > (smooth.breathPrev || 0) ? 'Breathing in' : 'Breathing out';
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

  // ---- Prism: refractive glass veils -------------------------------------
  function renderPrism(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * calm;
    const breath = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));

    const bg = bctx.createLinearGradient(0, 0, BW, BH);
    bg.addColorStop(0, '#02040b');
    bg.addColorStop(0.55, '#06081a');
    bg.addColorStop(1, '#05030c');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';

    const min = Math.min(BW, BH);
    const cx = BW * (0.50 + 0.025 * Math.sin(tSec * 0.035));
    const cy = BH * (0.50 + 0.015 * (breath - 0.5));
    const colors = [
      [34, 232, 255],
      [177, 98, 255],
      [54, 255, 192],
      [255, 75, 176],
      [255, 213, 80],
    ];
    const sheets = 26;
    for (let i = 0; i < sheets; i++) {
      const u = i / Math.max(1, sheets - 1);
      const side = u - 0.5;
      const band = i % 4;
      const level = clamp01(smooth.levels[band]);
      const spike = clamp01(state.bands[band].spike);
      const warm = clamp01(thinking * 0.85 + spike * 0.5);
      const col = mixColor(colors[i % colors.length], [255, 118, 104], warm);
      const drift = Math.sin(tSec * (0.035 + i * 0.002) + i * 0.7);
      const spread = min * (0.12 + 0.34 * Math.abs(side));
      const x0 = cx + side * BW * (0.72 - 0.18 * calm);
      const y0 = -min * 0.12;
      const x1 = cx + side * BW * (0.18 + 0.18 * calm) + drift * min * 0.10 * (0.35 + thinking);
      const y1 = cy - min * (0.10 + 0.08 * level);
      const x2 = cx - side * BW * (0.12 + 0.13 * (1 - calm)) + Math.sin(tSec * 0.05 + i) * min * 0.05;
      const y2 = cy + min * (0.07 + 0.22 * breath);
      const x3 = cx - side * BW * (0.78 - 0.16 * focus);
      const y3 = BH + min * 0.12;

      lctx.strokeStyle = rgba(col, 0.050 + 0.120 * (0.35 + level) + 0.110 * spike + 0.045 * focus);
      lctx.lineWidth = Math.max(1, spread * (0.16 + 0.16 * (1 - calm) + 0.08 * focus));
      lctx.beginPath();
      lctx.moveTo(x0, y0);
      lctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
      lctx.stroke();
    }
    lctx.globalCompositeOperation = 'source-over';

    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(3, Math.round(min / 42))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';

    const beamCol = mixColor([94, 222, 255], [255, 219, 169], focus);
    const beam = bctx.createLinearGradient(cx - min * 0.45, 0, cx + min * 0.45, 0);
    beam.addColorStop(0, rgba(beamCol, 0));
    beam.addColorStop(0.46, rgba(beamCol, 0.18 + 0.22 * focus));
    beam.addColorStop(0.50, rgba([255, 255, 255], 0.16 + 0.18 * focus));
    beam.addColorStop(0.54, rgba([255, 86, 190], 0.08 + 0.12 * thinking));
    beam.addColorStop(1, rgba(beamCol, 0));
    bctx.fillStyle = beam;
    bctx.fillRect(cx - min * 0.45, 0, min * 0.9, BH);
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Lattice: sacred geometry that steadies with focus -----------------
  function renderLattice(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const cx = BW / 2, cy = BH * 0.51;
    const min = Math.min(BW, BH);

    const bg = bctx.createRadialGradient(cx, cy, 0, cx, cy, min * 0.72);
    bg.addColorStop(0, '#070a19');
    bg.addColorStop(0.58, '#030510');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';

    const drawPoly = (c, sides, r, rot, col, alpha, width, wobble) => {
      c.beginPath();
      for (let i = 0; i <= sides; i++) {
        const a = rot + (i / sides) * Math.PI * 2;
        const ch = i % 4;
        const local = 1 + wobble * (
          0.45 * Math.sin(a * 3 + tSec * (0.11 + 0.22 * thinking))
          + 0.30 * (clamp01(smooth.levels[ch]) - 0.5)
          + 0.30 * clamp01(state.bands[ch].spike)
        );
        const rr = Math.max(1, r * local);
        const x = cx + Math.sin(a) * rr;
        const y = cy - Math.cos(a) * rr;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.strokeStyle = rgba(col, alpha);
      c.lineWidth = Math.max(0.5, width);
      c.stroke();
    };

    const cool = [42, 228, 255];
    const mint = [66, 255, 186];
    const warm = [255, 74, 170];
    const gold = [255, 225, 90];
    const rot = tSec * (0.006 + 0.018 * (1 - calm));
    const rings = 7;
    for (let i = 0; i < rings; i++) {
      const u = (i + 1) / rings;
      const sides = i % 2 === 0 ? 6 : 12;
      const r = min * (0.055 + u * 0.37);
      const channel = i % 4;
      const level = clamp01(smooth.levels[channel]);
      const spike = clamp01(state.bands[channel].spike);
      const col = mixColor(mixColor(cool, mint, level), warm, clamp01(thinking * 0.72 + spike * 0.45));
      const wobble = (0.006 + 0.052 * thinking + 0.030 * spike) * (1 - 0.65 * focus);
      drawPoly(lctx, sides, r, rot * (i % 2 ? -1 : 1) + i * Math.PI / 12,
        col, 0.100 + 0.085 * u + 0.140 * spike + 0.040 * focus, min * (0.0017 + 0.0025 * focus), wobble);
    }

    for (let i = 0; i < 12; i++) {
      const a = rot * 0.5 + (i / 12) * Math.PI * 2;
      const r0 = min * (0.07 + 0.025 * focus);
      const r1 = min * (0.39 + 0.05 * calm);
      lctx.beginPath();
      lctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      lctx.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
      lctx.strokeStyle = rgba(mixColor(cool, gold, focus), 0.070 + 0.140 * focus);
      lctx.lineWidth = Math.max(0.5, min * 0.0020);
      lctx.stroke();
    }

    lctx.globalCompositeOperation = 'source-over';
    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(2, Math.round(min / 92))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';
    drawPoly(bctx, 6, min * (0.08 + 0.020 * focus), -rot, mixColor(gold, mint, calm),
      0.260 + 0.280 * focus, min * 0.0026, 0.004 * thinking);
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Horizon: a cinematic focus line -----------------------------------
  function renderHorizon(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * calm;
    const breath = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#030512');
    bg.addColorStop(0.58, '#050714');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';

    const min = Math.min(BW, BH);
    const baseY = BH * (0.52 + 0.020 * (breath - 0.5));
    const width = BW * 0.86;
    const left = (BW - width) / 2;
    const active = clamp01(thinking + 0.35 * (1 - calm));
    const colors = [
      [44, 225, 255],
      [178, 94, 255],
      [255, 78, 181],
      [255, 219, 91],
      [73, 255, 195],
    ];

    for (let layer = 0; layer < 5; layer++) {
      const offset = (layer - 2) * min * 0.025;
      const col = mixColor(colors[layer], [255, 116, 96], smoothstep(0.35, 0.9, thinking));
      const amp = min * (0.010 + 0.090 * active) * (1 - 0.14 * layer);
      const speed = 0.045 + 0.035 * thinking + layer * 0.004;
      const points = 84;
      lctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const x = left + (i / points) * width;
        const px = i / points - 0.5;
        const peakA = Math.exp(-Math.pow((px - 0.18 * Math.sin(tSec * 0.025)) / 0.16, 2));
        const peakB = Math.exp(-Math.pow((px + 0.28) / 0.22, 2));
        const fine = Math.sin(px * Math.PI * 16 + tSec * (0.70 + thinking * 1.4) + layer);
        const broad = Math.sin(px * Math.PI * 2.4 + tSec * speed + layer * 0.6);
        const y = baseY + offset
          + amp * (0.65 * broad + thinking * 0.75 * (peakA - 0.55 * peakB) + 0.030 * active * fine);
        if (i === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.strokeStyle = rgba(col, 0.105 + 0.170 * focus + 0.085 * active);
      lctx.lineWidth = Math.max(1, min * (0.008 + 0.010 * (1 - calm) + 0.006 * focus));
      lctx.stroke();
    }

    lctx.globalCompositeOperation = 'source-over';
    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(2, Math.round(min / 58))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';

    const line = bctx.createLinearGradient(left, 0, left + width, 0);
    line.addColorStop(0, 'rgba(80,210,255,0)');
    line.addColorStop(0.42, `rgba(80,235,255,${0.18 + 0.24 * focus})`);
    line.addColorStop(0.50, `rgba(255,240,145,${0.22 + 0.30 * focus})`);
    line.addColorStop(0.58, `rgba(255,78,190,${0.12 + 0.18 * thinking})`);
    line.addColorStop(1, 'rgba(80,210,255,0)');
    bctx.strokeStyle = line;
    bctx.lineWidth = Math.max(1, min * (0.002 + 0.003 * focus));
    bctx.beginPath();
    bctx.moveTo(left, baseY);
    bctx.lineTo(left + width, baseY);
    bctx.stroke();
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Slow Bloom: Bloom rebuilt as glass flowers ------------------------
  function renderGlassBloom(nowMs, tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const min = Math.min(BW, BH);
    const cx = BW / 2, cy = BH * 0.52;

    const bg = bctx.createRadialGradient(cx, cy, 0, cx, cy, min * 0.78);
    bg.addColorStop(0, '#070b19');
    bg.addColorStop(0.62, '#030612');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    const active = blooms.update(nowMs);
    const ambientCount = 5;
    const flowers = [];
    for (let i = 0; i < ambientCount; i++) {
      const a = tSec * (0.012 + i * 0.002) + i * Math.PI * 2 / ambientCount;
      flowers.push({
        x: 0.5 + Math.sin(a) * (0.11 + 0.05 * thinking),
        y: 0.52 - Math.cos(a) * (0.10 + 0.04 * focus),
        alpha: 0.62 + 0.22 * calm,
        radius: 0.14 + 0.045 * Math.sin(tSec * 0.02 + i),
        color: mixColor([36, 232, 255], [255, 76, 178], smoothstep(0.36, 0.92, thinking)),
      });
    }
    for (const b of active) {
      flowers.push({
        x: b.x, y: b.y, alpha: b.alpha, radius: b.radius * 1.55,
        color: mixColor(b.color, [255, 245, 145], 0.25 + 0.35 * focus),
      });
    }

    bctx.globalCompositeOperation = 'lighter';
    for (const f of flowers) {
      const x = f.x * BW, y = f.y * BH;
      const R = Math.max(2, f.radius * min * (1.3 + 0.45 * calm));
      const petalCount = 8;
      for (let p = 0; p < petalCount; p++) {
        const a = p * Math.PI * 2 / petalCount + tSec * 0.018 * (p % 2 ? -1 : 1);
        const px = x + Math.sin(a) * R * 0.18;
        const py = y - Math.cos(a) * R * 0.18;
        const g = bctx.createRadialGradient(px, py, 0, px, py, R * (0.74 + 0.12 * Math.sin(p)));
        g.addColorStop(0, rgba(f.color, 0.28 * f.alpha));
        g.addColorStop(0.42, rgba(f.color, 0.125 * f.alpha));
        g.addColorStop(0.72, rgba(mixColor(f.color, [255,255,255], 0.4), 0.045 * f.alpha));
        g.addColorStop(1, rgba(f.color, 0));
        bctx.fillStyle = g;
        bctx.beginPath(); bctx.arc(px, py, R, 0, Math.PI * 2); bctx.fill();
      }
      bctx.strokeStyle = rgba(mixColor(f.color, [255, 255, 255], 0.38), 0.150 + 0.180 * focus);
      bctx.lineWidth = Math.max(0.5, min * 0.0024);
      bctx.beginPath(); bctx.arc(x, y, R * (0.38 + 0.18 * calm), 0, Math.PI * 2); bctx.stroke();
    }
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Glass Silk: Silk as panes and a settling seam ---------------------
  function renderGlassSilk(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const min = Math.min(BW, BH);
    const period = smooth.breathPeriod > 0.5 ? smooth.breathPeriod : 6 + 5 * calm;
    const breath = 0.5 - 0.5 * Math.cos((tSec * 2 * Math.PI) / Math.max(1, period));

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#020510');
    bg.addColorStop(0.58, '#060819');
    bg.addColorStop(1, '#020207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';
    const layers = 76;
    const width = BW * 1.08;
    const amp = min * (0.018 + 0.135 * clamp01(thinking + 0.52 * (1 - calm)));
    for (let i = 0; i < layers; i++) {
      const u = i / (layers - 1);
      const y0 = BH * (0.30 + u * 0.42);
      const ridge = smoothstep(0.22, 0.0, Math.abs(u - 0.5));
      const cool = mixColor([38, 230, 255], [180, 92, 255], u);
      const col = mixColor(cool, [255, 78, 178], smoothstep(0.42, 0.92, thinking + clamp01(state.bands[i % 4].spike) * 0.4));
      const phase = tSec * (0.020 + 0.080 * thinking) + i * (0.07 - 0.035 * calm);
      lctx.strokeStyle = rgba(col, 0.060 + 0.170 * ridge + 0.080 * focus);
      lctx.lineWidth = Math.max(0.5, min * (0.0032 + 0.0075 * ridge + 0.003 * focus));
      lctx.beginPath();
      for (let s = 0; s <= 90; s++) {
        const x = BW * 0.5 - width / 2 + (s / 90) * width;
        const px = s / 90 - 0.5;
        const calmLine = y0 + (u - 0.5) * min * 0.05 * calm;
        const fold = amp * (
          Math.sin(px * Math.PI * 2.0 + phase)
          + 0.54 * Math.sin(px * Math.PI * 4.3 - phase * 0.7)
          + thinking * 0.38 * Math.sin(px * Math.PI * 16 + tSec * 1.6 + i)
        );
        const y = calmLine + fold * (1 - 0.78 * Math.pow(calm, 1.7)) + (breath - 0.5) * min * 0.020;
        if (s === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.stroke();
    }
    lctx.globalCompositeOperation = 'source-over';

    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(2, Math.round(min / 70))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';

    const seam = bctx.createLinearGradient(BW * 0.12, 0, BW * 0.88, 0);
    seam.addColorStop(0, 'rgba(90,220,255,0)');
    seam.addColorStop(0.46, `rgba(80,237,255,${0.20 + 0.24 * calm + 0.16 * focus})`);
    seam.addColorStop(0.51, `rgba(255,238,124,${0.18 + 0.28 * focus})`);
    seam.addColorStop(0.56, `rgba(255,80,190,${0.10 + 0.16 * thinking})`);
    seam.addColorStop(1, 'rgba(90,220,255,0)');
    bctx.strokeStyle = seam;
    bctx.lineWidth = Math.max(1, min * (0.0032 + 0.0055 * focus));
    bctx.beginPath();
    bctx.moveTo(BW * 0.13, BH * (0.51 + (breath - 0.5) * 0.012));
    bctx.bezierCurveTo(BW * 0.35, BH * (0.50 - 0.025 * (1 - calm)), BW * 0.62,
      BH * (0.52 + 0.020 * (1 - calm)), BW * 0.87, BH * (0.51 + (breath - 0.5) * 0.012));
    bctx.stroke();
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Aurora: slow curtains of colour ----------------------------------
  function renderAurora(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const min = Math.min(BW, BH);

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#01030a');
    bg.addColorStop(0.48, '#050817');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    lctx.clearRect(0, 0, BW, BH);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineCap = 'round';
    const curtains = 7;
    for (let i = 0; i < curtains; i++) {
      const ch = i % 4;
      const level = clamp01(smooth.levels[ch]);
      const spike = clamp01(state.bands[ch].spike);
      const col = mixColor(mixColor([43, 255, 194], [43, 220, 255], level), [255, 70, 170], clamp01(thinking * 0.65 + spike * 0.55));
      const xBase = BW * (0.12 + i * 0.13) + Math.sin(tSec * 0.025 + i) * min * 0.035;
      const top = BH * (0.08 + 0.03 * Math.sin(i));
      const bottom = BH * (0.78 + 0.08 * calm);
      lctx.strokeStyle = rgba(col, 0.140 + 0.090 * focus + 0.120 * spike);
      lctx.lineWidth = Math.max(1, min * (0.058 + 0.026 * level + 0.026 * thinking));
      lctx.beginPath();
      for (let s = 0; s <= 44; s++) {
        const y = top + (s / 44) * (bottom - top);
        const f = s / 44;
        const x = xBase
          + Math.sin(f * Math.PI * 2.1 + tSec * (0.05 + 0.12 * thinking) + i) * min * (0.05 + 0.08 * (1 - calm))
          + Math.sin(f * Math.PI * 6.0 - tSec * 0.08 + i * 1.7) * min * 0.015 * thinking;
        if (s === 0) lctx.moveTo(x, y); else lctx.lineTo(x, y);
      }
      lctx.stroke();
    }
    lctx.globalCompositeOperation = 'source-over';

    bctx.globalCompositeOperation = 'lighter';
    bctx.filter = `blur(${Math.max(3, Math.round(min / 48))}px)`;
    bctx.drawImage(lay, 0, 0);
    bctx.filter = 'none';
    const floor = bctx.createRadialGradient(BW / 2, BH * 0.75, 0, BW / 2, BH * 0.75, min * 0.52);
    floor.addColorStop(0, `rgba(95,255,220,${0.120 + 0.170 * calm})`);
    floor.addColorStop(1, 'rgba(125,238,215,0)');
    bctx.fillStyle = floor;
    bctx.fillRect(0, 0, BW, BH);
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Cathedral: a stained-glass rose for focus -------------------------
  function renderCathedral(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const cx = BW / 2, cy = BH * 0.50;
    const min = Math.min(BW, BH);

    const bg = bctx.createRadialGradient(cx, cy, 0, cx, cy, min * 0.72);
    bg.addColorStop(0, '#080817');
    bg.addColorStop(0.60, '#030511');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    bctx.globalCompositeOperation = 'lighter';
    const petals = 18;
    const rot = tSec * (0.004 + 0.018 * (1 - calm));
    for (let r = 0; r < 5; r++) {
      const rr = min * (0.11 + r * 0.070 + calm * 0.014);
      for (let p = 0; p < petals; p++) {
        const a = rot + (p / petals) * Math.PI * 2 + (r % 2) * Math.PI / petals;
        const ch = p % 4;
        const spike = clamp01(state.bands[ch].spike);
        const level = clamp01(smooth.levels[ch]);
        const col = mixColor(mixColor([42, 226, 255], [76, 255, 188], level), [255, 72, 174], clamp01(thinking * 0.70 + spike * 0.4));
        const x = cx + Math.sin(a) * rr;
        const y = cy - Math.cos(a) * rr;
        const pr = min * (0.030 + 0.010 * focus + 0.018 * spike);
        const g = bctx.createRadialGradient(x, y, 0, x, y, pr * 2.2);
        g.addColorStop(0, rgba(col, 0.240 + 0.220 * focus + 0.180 * spike));
        g.addColorStop(0.62, rgba(col, 0.080 + 0.090 * focus));
        g.addColorStop(1, rgba(col, 0));
        bctx.fillStyle = g;
        bctx.beginPath(); bctx.ellipse(x, y, pr * (0.55 + 0.4 * calm), pr * 1.7, -a, 0, Math.PI * 2); bctx.fill();
      }
    }
    bctx.strokeStyle = rgba([210, 246, 255], 0.150 + 0.220 * focus);
    bctx.lineWidth = Math.max(0.5, min * 0.0022);
    for (let p = 0; p < petals; p++) {
      const a = rot + (p / petals) * Math.PI * 2;
      bctx.beginPath();
      bctx.moveTo(cx + Math.sin(a) * min * 0.08, cy - Math.cos(a) * min * 0.08);
      bctx.lineTo(cx + Math.sin(a) * min * 0.44, cy - Math.cos(a) * min * 0.44);
      bctx.stroke();
    }
    bctx.beginPath(); bctx.arc(cx, cy, min * (0.075 + 0.020 * calm), 0, Math.PI * 2); bctx.stroke();
    bctx.globalCompositeOperation = 'source-over';
  }

  // ---- Tide: slow waves flattening into calm -----------------------------
  function renderTide(tSec) {
    const calm = clamp01(smooth.calm);
    const thinking = clamp01(smooth.activity);
    const focus = clamp01(smooth.focus);
    const cx = BW / 2, cy = BH * 0.54;
    const min = Math.min(BW, BH);

    const bg = bctx.createLinearGradient(0, 0, 0, BH);
    bg.addColorStop(0, '#020511');
    bg.addColorStop(0.55, '#050917');
    bg.addColorStop(1, '#010207');
    bctx.fillStyle = bg;
    bctx.fillRect(0, 0, BW, BH);

    bctx.globalCompositeOperation = 'lighter';
    const rings = 12;
    for (let i = 0; i < rings; i++) {
      const u = i / Math.max(1, rings - 1);
      const r = min * (0.07 + u * 0.50);
      const ch = i % 4;
      const level = clamp01(smooth.levels[ch]);
      const spike = clamp01(state.bands[ch].spike);
      const col = mixColor(mixColor([42, 230, 255], [72, 255, 190], calm), [255, 75, 174], clamp01(thinking * 0.62 + spike * 0.50));
      const amp = min * (0.004 + 0.030 * thinking + 0.022 * spike) * (1 - 0.62 * calm);
      const pts = 128;
      bctx.beginPath();
      for (let p = 0; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        const wave = Math.sin(a * (3 + (i % 3)) + tSec * (0.07 + 0.10 * thinking) + i)
          + 0.45 * Math.sin(a * 9 - tSec * 0.05 + i * 0.6);
        const rr = r + amp * wave + min * 0.010 * (level - 0.5);
        const x = cx + Math.sin(a) * rr;
        const y = cy - Math.cos(a) * rr * (0.62 + 0.18 * calm);
        if (p === 0) bctx.moveTo(x, y); else bctx.lineTo(x, y);
      }
      bctx.strokeStyle = rgba(col, 0.100 + 0.105 * (1 - u) + 0.125 * focus);
      bctx.lineWidth = Math.max(0.5, min * (0.0020 + 0.0032 * (1 - u) + 0.0023 * focus));
      bctx.stroke();
    }
    const pool = bctx.createRadialGradient(cx, cy, 0, cx, cy, min * (0.18 + 0.13 * calm));
    pool.addColorStop(0, `rgba(120,245,255,${0.130 + 0.190 * calm + 0.100 * focus})`);
    pool.addColorStop(1, 'rgba(150,238,255,0)');
    bctx.fillStyle = pool;
    bctx.beginPath(); bctx.arc(cx, cy, min * (0.20 + 0.13 * calm), 0, Math.PI * 2); bctx.fill();
    bctx.globalCompositeOperation = 'source-over';
  }

  let last = performance.now();
  const start = last;
  function frame(now) {
    const dtSec = Math.min(0.1, (now - last) / 1000);
    last = now;
    sessionSec += dtSec;
    flowDt = dtSec;

    const response = RESPONSE_MODES[responseIndex].rates;
    smooth.calm += response.calm * (state.calm - smooth.calm);
    smooth.activity += response.activity * (state.activity - smooth.activity);
    const targetFocus = state.metrics && state.metrics.focus != null ? state.metrics.focus : state.calm;
    smooth.focus += response.focus * (targetFocus - smooth.focus);
    // The base mode keeps the void slow; the responsiveness toggle deliberately
    // changes only how quickly the visual catches up, not the underlying score.
    smooth.voidCalm += response.voidCalm * (state.calm - smooth.voidCalm);
    smooth.noise += response.noise * (state.noise - smooth.noise);
    smooth.breathPeriod += response.breath * (state.breathPeriod - smooth.breathPeriod);
    for (let i = 0; i < 4; i++) {
      smooth.levels[i] += response.levels * (clamp01(state.bands[i].level) - smooth.levels[i]);
    }
    /* The composites, on the same per-frame easing as everything else above. `response.focus` is
       reused deliberately: these are interpreted scores on the same timescale as focus, and
       inventing a fourth rate constant for them would be a knob with no measurement behind it. */
    for (const m of VizCore.PULSE_METRICS) {
      const target = state.metrics && state.metrics[m.key] != null ? state.metrics[m.key] : null;
      // Non-finite as well as null: a metric arriving as NaN or Infinity must not be eased
      // toward, because an eased NaN is NaN forever — the value is a running state, so one bad
      // sample poisons it for the rest of the sit rather than passing through in a frame.
      if (target == null || !Number.isFinite(target)) continue;
      const cur = smooth.metrics[m.key];
      const next = cur == null ? target : cur + response.focus * (target - cur);
      smooth.metrics[m.key] = clamp01(next);
    }

    const mode = VizCore.MODES[modeIndex].key;
    const tSec = (now - start) / 1000;

    /* Iris's record accumulates on the SESSION clock, not on the time Iris spent
     * being looked at. Outside the mode dispatch on purpose: a record that only
     * exists while you are watching it is a record of watching. */
    depositIrisRing();

    if (DIRECT_MODES.has(mode)) {
      // Straight to the output canvas at full resolution — see renderFlow for
      // why. These modes depend on sharp thin lines, which cannot survive the
      // upscale from the shared small buffer.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (mode === 'flow') renderFlow(ctx, canvas.width, canvas.height);
      else if (mode === 'lumen') renderLumen(ctx, canvas.width, canvas.height, tSec);
      else if (mode === 'ribbon') renderRibbon(ctx, canvas.width, canvas.height, tSec);
      else if (mode === 'silk') renderSilk(ctx, canvas.width, canvas.height, tSec);
      else if (mode === 'corona') renderCoronaDiffuse(ctx, canvas.width, canvas.height, tSec);
      else renderPulse(ctx, canvas.width, canvas.height, tSec);
    } else {
      if (mode === 'eclipse') renderEclipse(tSec);
      else if (mode === 'iris') renderIrisSediment(tSec);
      else if (mode === 'bloom') renderBloom(now);
      else if (mode === 'field') renderField(tSec);
      else if (mode === 'breath') renderBreath(dtSec);
      else if (mode === 'glassbloom') renderGlassBloom(now, tSec);
      else if (mode === 'glasssilk') renderGlassSilk(tSec);
      else if (mode === 'prism') renderPrism(tSec);
      else if (mode === 'lattice') renderLattice(tSec);
      else if (mode === 'horizon') renderHorizon(tSec);
      else if (mode === 'aurora') renderAurora(tSec);
      else if (mode === 'cathedral') renderCathedral(tSec);
      else renderTide(tSec);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buf, 0, 0, BW, BH, 0, 0, canvas.width, canvas.height);
    }

    /* THE KEY, ONCE, FOR WHATEVER MODE IS RUNNING.
     * Drawn here rather than inside each renderer: it lived inside renderFlow, so
     * Flow was the only visual that explained itself and the other six each would
     * have had to remember to call it. Here there is one call and no mode can be
     * forgotten — a new mode either has an entry in VizCore.LEGENDS or gets no key,
     * and test-viz.js fails if a VISIBLE mode has none.
     *
     * On the output canvas after the upscale, not into the small buffer, so the text
     * is drawn at real resolution instead of being magnified from a 4x-smaller
     * bitmap. That matters more for text than for anything else on screen.
     */
    if (legendOn) {
      drawLegend(ctx, canvas.width, canvas.height, VizCore.legendFor(mode, {
        driver: driverLabel,
        composites: seriesMode === 'composites',
        breath: history.some((h) => h.breath != null),
        depositSec: irisDepositSec(),
        /* What the centre glow is really pulsing on. See LEGENDS.ribbon: this is the difference between
           "follows your breath" and "a steady 10s pacer, not your breath", and only one of them is true
           at any moment. */
        bloom: mode === 'ribbon' ? ribbonBreathDriver()
          : mode === 'lumen' ? lumenBreathDriver() : null,
        omitSeries: VizCore.CHANNEL_LABELS.filter((_, i) => !everFresh[i]),
      }));
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
        return {
          level: src.level != null ? src.level : 0.5,
          spike: src.spike || 0,
          fresh: src.fresh !== false,
        };
      });
      /* Only when bands were actually SUPPLIED. Without the guard the back-compat
         path (setCalm, which passes no bands) falls through to state.bands, whose
         default `fresh` is true, and every channel would be marked as having read. */
      if (next.bands) {
        bands.forEach((b, i) => { if (b.fresh !== false) everFresh[i] = true; });
      }
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
        /* Merged rather than replaced, like `metrics`: a tick with no fresh beat must hold the last heart
           rate rather than dropping the line, since a beat arrives about once a second and the tick runs
           four times as often. */
        hr: next.hr !== undefined ? next.hr : state.hr,
        hrv: next.hrv !== undefined ? next.hrv : state.hrv,
        breathAmount: next.breathAmount !== undefined ? next.breathAmount : state.breathAmount,
        bands,
      };
      /* SMOOTHED HERE, ONCE, FROM THE PAST ONLY — see emaStep. A stale level from a
         channel that is not reading is fed in as null rather than as a number: it would
         otherwise both flatten the trace and, worse, set that channel's own axis. */
      const metricNow = VizCore.PULSE_METRICS.map((m) => (
        state.metrics[m.key] == null ? null : clamp01(state.metrics[m.key])
      ));
      for (let k = 0; k < 4; k++) {
        flowEma.levels[k] = emaStep(flowEma.levels[k],
          bands[k].fresh === false ? null : clamp01(bands[k].level), emaAlpha(FLOW_SMOOTH_SENSORS));
        flowEma.metrics[k] = emaStep(flowEma.metrics[k], metricNow[k], emaAlpha(FLOW_SMOOTH));
      }
      flowEma.breath = emaStep(flowEma.breath, state.breathAmount, emaAlpha(5));
      history.push({
        /* A counter that belongs to the SAMPLE rather than to its slot in the array — see the note on the
           control-point selection in renderRibbon. Monotonic for the life of the page. */
        seq: pushSeq++,
        breath: state.breathAmount,
        levels: bands.map((b) => clamp01(b.level)),
        held: bands.map((b) => b.fresh === false),
        spikes: bands.map((b) => clamp01(b.spike)),
        // Composites too, so Flow can graph whichever series the data panel is
        // showing. Held values (not zeros) for metrics with no inputs.
        metrics: metricNow,
        calm: clamp01(state.calm),
        // What Flow actually draws: the smoothed value as of this sample, frozen.
        sLevels: flowEma.levels.slice(),
        sMetrics: flowEma.metrics.slice(),
        sBreath: state.breathAmount == null ? null : flowEma.breath,
        /* THE BODY SIGNALS, so Flow can plot them beside the EEG. Not smoothed here: heart rate and RMSSD
           arrive already averaged over a window of beats — a 60-second one for RMSSD — and smoothing an
           average again only adds lag. Null when there is no strap, which draws as a gap. */
        hr: state.hr, hrv: state.hrv,
      });
      if (history.length > FLOW_MAX) history.shift();
      /* Sample cadence, measured. Gaps below 20ms are two setState calls inside one tick
         and say nothing about the cadence; gaps above 2s are a stall, and letting one into
         the average would make the trace crawl for a minute afterwards. */
      {
        const t = performance.now();
        if (lastPushAt != null) {
          const gap = (t - lastPushAt) / 1000;
          if (gap > 0.02 && gap < 2) {
            pushIntervalSec = pushIntervalSec == null ? gap : pushIntervalSec + 0.25 * (gap - pushIntervalSec);
          }
        }
        lastPushAt = t;
      }

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
    cycleMode(dir = 1) { return this.setMode(VizCore.nextMode(modeIndex, dir)); },
    /* By KEY, for the bar's mode pills. Index would work and would be the wrong thing to expose: a
       mode's index is its identity in stored preferences, so a caller holding indexes breaks the moment
       a hidden mode is added. */
    setModeByKey(key) {
      const i = VizCore.MODES.findIndex((m) => m.key === key);
      return i < 0 ? VizCore.MODES[modeIndex] : this.setMode(i);
    },
    currentMode() { return VizCore.MODES[modeIndex]; },
    // Follows the data panel's Sensors/Composites switch — see seriesMode.
    /* THE SERIES SET, and the four ways to change it. `setSeries` keeps its old meaning as a preset so
       every existing caller works unchanged; the other three are what the picker uses. */
    setFlowSeries(keys) {
      const want = (keys || []).filter((k) => VizCore.FLOW_BY_KEY[k]);
      flowKeys = new Set(want);
      seriesMode = Object.keys(VizCore.FLOW_PRESETS).find((p) => {
        const preset = VizCore.FLOW_PRESETS[p];
        return preset.length === flowKeys.size && preset.every((k) => flowKeys.has(k));
      }) || 'custom';
      flowRanges = [null, null, null, null];
      return this.flowSeries();
    },
    toggleFlowSeries(key) {
      if (!VizCore.FLOW_BY_KEY[key]) return this.flowSeries();
      const next = new Set(flowKeys);
      if (next.has(key)) next.delete(key); else next.add(key);
      /* NEVER EMPTY. An empty Flow is a blank rectangle with no way to tell it from a crash, so the last
         series cannot be switched off — the same rule the metrics panel follows. */
      if (!next.size) return this.flowSeries();
      return this.setFlowSeries(Array.from(next));
    },
    flowSeries() {
      return { preset: seriesMode, keys: VizCore.FLOW_SERIES.map((fs) => fs.key).filter((k) => flowKeys.has(k)) };
    },
    setSeries(which) {
      if (seriesMode !== (which === 'composites' ? 'composites' : 'sensors')) {
        // Different series entirely — a held range from the old set would be applied to
        // the new one for a few seconds and put every trace against an edge.
        flowRanges = [null, null, null, null];
      }
      seriesMode = which === 'composites' ? 'composites' : 'sensors';
      // AND THE SET, or the preset name and what is drawn disagree.
      flowKeys = new Set(VizCore.FLOW_PRESETS[seriesMode]);
      return seriesMode;
    },
    setLegend(on) { legendOn = !!on; return legendOn; },
    setLegendInset(px) { legendInset = Number.isFinite(px) ? Math.max(0, px) : 0; return legendInset; },
    // Null clears it, which is right when the view is showing raw sensors: nothing is being
    // selected, so there is no driver to name.
    setDriver(label) { driverLabel = label || null; return driverLabel; },
    // Which electrodes have produced at least one artifact-free window. Exposed so a
    // test can assert that a dead one is absent rather than merely dim.
    channelsReading() { return everFresh.slice(); },
    legendVisible() { return legendOn; },
    /* How long the sit is meant to be, so Iris can spread its rings across the whole
     * of it instead of filling up in ten minutes. Set from the session timer; null
     * means unknown, and Iris falls back to a fixed interval and freezes at the rim.
     * Told, not guessed: the app knows the intended length and the visual does not. */
    setSessionLength(sec) {
      irisSessionSec = sec != null && sec > 0 ? sec : null;
      return irisSessionSec;
    },
    // Exposed for the tests and the legend: rings, capacity, and the current spacing.
    irisRecord() {
      return { rings: irisRing, maxRings: IRIS_MAX_RINGS, depositSec: irisDepositSec(),
        full: irisRing >= IRIS_MAX_RINGS };
    },
    /* The settled vertical range per Flow series, for measuring axis stability without
       reading pixels. A recorded sample's position is `1 - inRange(value, range)`, so a
       test can watch a FIXED value's drawn position move between frames — which is what
       "the lines are jumping" actually is. */
    flowRange(k) { return flowRanges[k] ? Object.assign({}, flowRanges[k]) : null; },
    /* The sub-sample scroll position and the measured sample cadence, so a test can check
       that Flow moves between samples without inferring it from drawn coordinates. */
    /* `headX` is where the newest sample is drawn, in canvas pixels, reported rather than inferred from
       the draw calls. The test that measures the sub-sample scroll used to take the rightmost moveTo/lineTo
       vertex, which was the trace's head until the label pills arrived — their leader lines are drawn at a
       fixed x beside the head, so the maximum became a constant and the scroll read as zero. A renderer
       that has to be reverse-engineered from its draw calls will keep breaking tests that way. */
    flowScroll() { return { phase: flowPhase(), intervalSec: pushIntervalSec, headX: flowHeadX }; },
    /* The eased values every renderer actually draws from. Exposed because a harness that sets state and
       then screenshots is not testing what it thinks: the app's own tick calls setState four times a
       second too, so a driver at the same cadence only wins about half the frames. Three rounds of colour
       tuning were done against a `smooth.calm` of roughly 0.5 while the harness believed it was 0.9. */
    debugSmooth() {
      return { calm: smooth.calm, activity: smooth.activity, focus: smooth.focus,
        breathAmount: smooth.breathAmount };
    },
    /* The y actually drawn for every sample of a series, last frame, in canvas pixels —
       the only way to measure whether the RECORDED PAST holds still, which is the thing
       that was reported as drifting. Off unless asked for: this allocates per frame. */
    flowDebug(on) { flowDebugOn = !!on; },
    flowTrace(k) { return flowLastY[k] ? flowLastY[k].slice() : null; },
    // Exposed for the tests: what the key currently says, without reading pixels.
    // The drawing is smoke-tested; WHAT it claims is the part worth asserting.
    legendNow() {
      return VizCore.legendFor(VizCore.MODES[modeIndex].key, {
        driver: driverLabel,
        composites: seriesMode === 'composites',
        breath: history.some((h) => h.breath != null),
        depositSec: irisDepositSec(),
        bloom: VizCore.MODES[modeIndex].key === 'ribbon' ? ribbonBreathDriver()
          : VizCore.MODES[modeIndex].key === 'lumen' ? lumenBreathDriver() : null,
        omitSeries: VizCore.CHANNEL_LABELS.filter((_, i) => !everFresh[i]),
      });
    },
    currentSeries() { return seriesMode; },
    modes() { return VizCore.MODES; },
    responsivenessModes() { return RESPONSE_MODES.map(({ key, label }) => ({ key, label })); },
    currentResponsiveness() { return RESPONSE_MODES[responseIndex]; },
    setResponsiveness(key) {
      const idx = RESPONSE_MODES.findIndex((m) => m.key === key);
      if (idx >= 0) responseIndex = idx;
      return RESPONSE_MODES[responseIndex];
    },
    cycleResponsiveness() {
      responseIndex = (responseIndex + 1) % RESPONSE_MODES.length;
      return RESPONSE_MODES[responseIndex];
    },
    cyclePattern() {
      patternIndex = VizCore.nextPattern(patternIndex);
      patternT = 0; // restart the cycle so it begins on an inhale
      return VizCore.BREATH_PATTERNS[patternIndex];
    },
    currentPattern() { return VizCore.BREATH_PATTERNS[patternIndex]; },
    breathCue() { return breathLabel; },
  };
}
