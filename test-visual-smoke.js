/*
 * Headless smoke test for visual.js.
 *
 * visual.js draws to a real canvas, which can't run under Node — but the
 * thing most likely to break it isn't the pixels, it's a plain runtime error
 * in a render path (a typo'd context method, an undefined variable, an
 * unguarded array index) that would otherwise only surface as a blank screen
 * on the user's machine. So: stub a minimal Canvas2D context, run every mode
 * for many frames with adversarial state, and fail on any thrown error or any
 * NaN/negative geometry reaching a draw call.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
let badNumbers = [];
// Counts draw operations issued while a blur filter is active. ctx.filter
// blurs EVERY draw op separately, so N fills under an active filter cost N
// full-buffer blur passes. Keeping this at ~1 per frame is a real perf
// invariant: earlier versions issued 4-12 and this is how that regresses.
let blurredDraws = 0;

function checkNums(method, args) {
  args.forEach((a, i) => {
    if (typeof a === 'number' && !Number.isFinite(a)) {
      badNumbers.push(`${method} arg${i} = ${a}`);
    }
  });
}

function makeCtx() {
  const gradient = { addColorStop: (o, c) => {
    if (typeof o === 'number' && !Number.isFinite(o)) badNumbers.push(`addColorStop offset ${o}`);
    if (typeof c === 'string' && /NaN|Infinity|undefined/.test(c)) badNumbers.push(`addColorStop color "${c}"`);
  } };
  const ctx = { canvas: null, lineCap: 'butt', imageSmoothingQuality: 'low',
    imageSmoothingEnabled: true, font: '10px sans-serif', textAlign: 'left',
    textBaseline: 'alphabetic', __ops: [], __calls: [] };

  // Validate PROPERTY assignments too, not just method arguments. Canvas
  // state like lineWidth/globalAlpha/fillStyle is set by assignment, so a
  // NaN or Infinity reaching them is invisible to argument checking — this
  // was a real blind spot in an earlier version of this test, found by
  // deliberately injecting an Infinity and watching the suite still pass.
  const numericProps = { globalAlpha: 1, lineWidth: 1 };
  for (const [prop, init] of Object.entries(numericProps)) {
    let v = init;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (nv) => {
        if (typeof nv === 'number' && !Number.isFinite(nv)) badNumbers.push(`${prop} = ${nv}`);
        if (typeof nv === 'number' && nv < 0) badNumbers.push(`${prop} negative (${nv})`);
        v = nv;
      },
    });
  }
  const styleProps = { fillStyle: '', strokeStyle: '', filter: 'none', globalCompositeOperation: 'source-over' };
  for (const [prop, init] of Object.entries(styleProps)) {
    let v = init;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (nv) => {
        if (typeof nv === 'string' && /NaN|Infinity|undefined|null/.test(nv)) {
          badNumbers.push(`${prop} = "${nv}"`);
        }
        v = nv;
      },
    });
  }
  const record = (name, requirePositive = []) => (...args) => {
    calls.push(name);
    ctx.__ops.push(name);
    // Arguments too, not just op names — a test that has to measure WHERE something was
    // drawn (Flow's sub-sample scroll) cannot do it from a list of method names.
    ctx.__calls.push([name, args]);
    const DRAW_OPS = ['fill', 'stroke', 'fillRect', 'drawImage'];
    if (DRAW_OPS.includes(name) && ctx.filter && ctx.filter !== 'none') blurredDraws++;
    checkNums(name, args);
    requirePositive.forEach((idx) => {
      if (typeof args[idx] === 'number' && args[idx] < 0) {
        badNumbers.push(`${name} arg${idx} negative (${args[idx]})`);
      }
    });
  };
  ctx.createLinearGradient = (...a) => { calls.push('createLinearGradient'); checkNums('createLinearGradient', a); return gradient; };
  // radius args (2 and 5) must never be negative — canvas throws IndexSizeError
  ctx.createRadialGradient = (...a) => {
    calls.push('createRadialGradient'); checkNums('createRadialGradient', a);
    [2, 5].forEach((i) => { if (a[i] < 0) badNumbers.push(`createRadialGradient radius arg${i} negative (${a[i]})`); });
    return gradient;
  };
  ctx.fillRect = record('fillRect');
  ctx.clearRect = record('clearRect');
  ctx.drawImage = record('drawImage');
  ctx.beginPath = record('beginPath');
  ctx.closePath = record('closePath');
  ctx.arc = record('arc', [2]); // radius must be >= 0
  ctx.fill = record('fill');
  ctx.stroke = record('stroke');
  ctx.moveTo = record('moveTo');
  ctx.lineTo = record('lineTo');
  ctx.quadraticCurveTo = record('quadraticCurveTo');
  ctx.bezierCurveTo = record('bezierCurveTo');
  ctx.ellipse = record('ellipse', [2, 3]); // radii must be >= 0
  ctx.rect = record('rect');
  ctx.clip = record('clip');
  ctx.save = record('save');
  ctx.restore = record('restore');
  ctx.translate = record('translate');
  ctx.rotate = record('rotate');
  ctx.scale = record('scale');
  // Ribbon renders its soft passes into a half-resolution layer and uses setTransform to keep working in
  // output-canvas coordinates. Absent from this stub, so the very first Ribbon frame threw — which is
  // exactly what this file exists to catch, and did.
  ctx.setTransform = record('setTransform');
  // Text, for the Flow legend. Arg 0 is the string, so the numeric check must skip
  // it; measureText has to return something plausible or layout maths goes NaN.
  ctx.fillText = record('fillText');
  ctx.strokeText = record('strokeText');
  ctx.measureText = (t) => { calls.push('measureText'); return { width: String(t).length * 6 }; };
  ctx.createPattern = () => ({ setTransform: () => {} });
  return ctx;
}

// Every canvas the code under test creates, in creation order — so a test can
// assert about a specific internal layer (the Iris record layer, say) rather
// than only about the aggregate.
const createdCanvases = [];

function makeCanvas(w = 1280, h = 720) {
  const c = { width: w, height: h };
  const ctx = makeCtx();
  ctx.canvas = c;
  c.getContext = () => ctx;
  createdCanvases.push(c);
  return c;
}

// ---- sandbox ---------------------------------------------------------------
let rafCb = null;
const sandbox = {
  console,
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2,
  addEventListener: () => {},
  requestAnimationFrame: (cb) => { rafCb = cb; return 1; },
  performance: { now: () => nowMs },
  document: { createElement: () => makeCanvas() },
  module: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let nowMs = 1000;
const ctxObj = vm.createContext(sandbox);
for (const f of ['public/viz-core.js', 'public/visual.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctxObj, { filename: f });
}

const target = makeCanvas();
const visual = sandbox.createZenVisual(target);
assert.ok(rafCb, 'createZenVisual should have scheduled a frame');
console.log('✓ createZenVisual initialises without throwing');

// ---- drive every mode through many frames with adversarial state ----------
// EVERY mode, including the ones hidden from the picker. Hidden modes still have
// code, and hiding one must not become a way for it to rot unnoticed — if it gets
// un-hidden later it has to still render.
const modeCount = sandbox.VizCore.MODES.length;
const visibleCount = sandbox.VizCore.visibleModes().length;
const adversarial = [
  { calm: 0, noise: 0, breathPeriod: 0, bands: [0, 1, 2, 3].map(() => ({ level: 0, spike: 0 })),
    metrics: { calm: 0, thinking: 0, focus: 0, drowsy: 0 }, breathAmount: -1 },
  { calm: 1, noise: 1, breathPeriod: 0, bands: [0, 1, 2, 3].map(() => ({ level: 1, spike: 1 })),
    metrics: { calm: 1, thinking: 1, focus: 1, drowsy: 1 }, breathAmount: 1 },
  { calm: 0.5, noise: 0.5, breathPeriod: 4.2, bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0.5 })),
    metrics: { calm: 0.5, thinking: 0.8, focus: 0.2, drowsy: 0.5 }, breathAmount: 0 },
  // deliberately malformed: missing bands, nulls, out-of-range
  // breathAmount null is a REAL state (no strap, or breath-holding) and must not
  // render as a convincing sway on stale data.
  { calm: null, noise: null, breathPeriod: null, metrics: { calm: null, thinking: NaN }, breathAmount: null },
  { calm: 0.7, bands: [{ level: null, spike: null }], metrics: {} },  // too few bands
  { calm: -5, noise: 99, breathPeriod: -3, bands: [],                 // empty + out of range
    metrics: { calm: -4, thinking: 12, focus: null, drowsy: NaN }, breathAmount: 9 },
];

for (let m = 0; m < modeCount; m++) {
  const mode = visual.currentMode();
  const before = calls.length;
  blurredDraws = 0;
  for (let i = 0; i < 60; i++) {
    visual.setState(adversarial[i % adversarial.length]);
    nowMs += 16;
    const cb = rafCb; rafCb = null;
    cb(nowMs); // run one frame; throws propagate and fail the test
    assert.ok(rafCb, 'each frame must schedule the next one');
  }
  assert.ok(calls.length > before, `mode "${mode.label}" should issue draw calls`);
  // At most ~2 blurred draw ops per frame, averaged over the run.
  const perFrame = blurredDraws / 60;
  assert.ok(perFrame <= 2.2,
    `mode "${mode.label}" issues ${perFrame.toFixed(1)} blurred draw ops per frame — ` +
    `draw unblurred into the scratch layer and blit ONCE with a filter instead`);
  console.log(`✓ mode "${mode.label}" rendered 60 frames, ${perFrame.toFixed(2)} blur passes/frame, no errors`);
  visual.cycleMode();
}

assert.deepStrictEqual(badNumbers, [], `no NaN/Infinity/negative geometry may reach a draw call:\n  ${badNumbers.join('\n  ')}`);
console.log('✓ no NaN, Infinity, or negative radii reached any draw call');

// ---- Iris's deposit path needs a LONG session to fire at all --------------
// The 60-frame loop above covers ~1 second, so Iris's every-6-seconds deposit
// never ran and its record-layer code was entirely untested — a real hole,
// since that path writes to a different canvas than the one being composited.
{
  const canvasesBefore = createdCanvases.length;
  const v = sandbox.createZenVisual(makeCanvas());
  /* Creation order is [target, compose buffer, scratch layer, Iris record, Ribbon layer]. Asserted by
     count AND indexed by position, so adding a layer without updating this shows up here rather than as
     a test that silently starts reading a different canvas — which is what happened when Ribbon's
     half-resolution layer was added: this asserted 4 and got 5. */
  const layers = createdCanvases.slice(canvasesBefore);
  assert.strictEqual(layers.length, 5, 'expected the target canvas plus four offscreen layers');
  const recordCtx = layers[3].getContext();

  while (v.currentMode().key !== 'iris') v.cycleMode();
  const depositsWanted = 3;
  // ~20 simulated seconds at 60fps — enough for 3 deposits at 6s apiece.
  for (let i = 0; i < 1260; i++) {
    v.setState(adversarial[i % adversarial.length]);
    nowMs += 16;
    const cb = rafCb; rafCb = null;
    cb(nowMs);
  }
  const blits = recordCtx.__ops.filter((o) => o === 'drawImage').length;
  const strokes = recordCtx.__ops.filter((o) => o === 'stroke').length;
  assert.ok(blits >= depositsWanted,
    `Iris should have deposited onto the record layer at least ${depositsWanted} times in 20s, saw ${blits}`);
  assert.ok(strokes >= depositsWanted,
    `each deposit should stroke permanent tracery onto the record layer, saw ${strokes} strokes`);
  assert.deepStrictEqual(badNumbers, [], `deposit path produced bad numbers:\n  ${badNumbers.join('\n  ')}`);
  console.log(`✓ Iris deposits onto its record layer over a long session (${blits} deposits, ${strokes} tracery strokes)`);
}

/* ---- Iris records THE SIT, not the time spent looking at Iris -------------
 * Reported: "when I flip back and forth on Iris, it always starts in the beginning...
 * ideally it just starts running when you connect the device, and it keeps building
 * rings so that if you switch off and switch on, it's still there."
 *
 * The deposit was inside renderIrisSediment, so rings were laid down only during the
 * seconds Iris happened to be the visible mode. Ten minutes on Eclipse and Iris had
 * recorded nothing — the disc was a record of WATCHING, which is not what it claims
 * to be. The deposit now runs from the frame loop.
 */
{
  const v = sandbox.createZenVisual(makeCanvas());
  const run = (frames) => {
    for (let i = 0; i < frames; i++) {
      v.setState(adversarial[i % adversarial.length]);
      nowMs += 16;
      const cb = rafCb; rafCb = null;
      cb(nowMs);
    }
  };

  // Sit on ECLIPSE — never switch to Iris at all.
  while (v.currentMode().key !== 'eclipse') v.cycleMode();
  run(1260);                                   // ~20 simulated seconds
  const whileAway = v.irisRecord().rings;
  assert.ok(whileAway >= 3,
    `Iris must accumulate while another mode is showing — after 20s on Eclipse it had`
    + ` ${whileAway} rings. The record is of the sit, not of looking at the record.`);

  // Now switch to Iris: the rings already earned must still be there.
  while (v.currentMode().key !== 'iris') v.cycleMode();
  const onArrival = v.irisRecord().rings;
  assert.strictEqual(onArrival, whileAway,
    `switching to Iris must not reset the record (${whileAway} -> ${onArrival})`);
  run(600);
  const grown = v.irisRecord().rings;
  assert.ok(grown > onArrival, 'and it must keep growing once shown');

  // Switching away and back must not restart it either — setMode clears only the
  // scratch layer, and this is the assertion that keeps it that way.
  while (v.currentMode().key !== 'flow') v.cycleMode();
  while (v.currentMode().key !== 'iris') v.cycleMode();
  assert.ok(v.irisRecord().rings >= grown,
    'a round trip through another mode must not lose rings');
  console.log(`✓ Iris records the sit, not the viewing: ${whileAway} rings laid down`
    + ' while Eclipse was on screen, kept across two mode switches');
}

/* ---- A long sit must not WIPE the record ---------------------------------
 * The old code cleared the record layer and reset to the centre once the disc filled
 * — at 120 rings x 5s that is every ten minutes. For a retreat sit of forty minutes
 * that means three silent erasures and a final disc showing the last ten minutes,
 * presented as if it were the sit. Freezing at the rim loses the tail; wiping loses
 * everything already earned.
 */
{
  const v = sandbox.createZenVisual(makeCanvas());
  while (v.currentMode().key !== 'iris') v.cycleMode();
  const cap = v.irisRecord().maxRings;

  // A 12-minute intended sit: the interval must stretch so it fits the disc rather
  // than filling it in ten.
  v.setSessionLength(12 * 60);
  assert.ok(v.irisRecord().depositSec > 5,
    `a 12-minute sit must space rings wider than the 5s default (got`
    + ` ${v.irisRecord().depositSec}s)`);
  assert.ok(Math.abs(v.irisRecord().depositSec * cap - 12 * 60) < 1,
    'and the rings must span exactly the intended length');

  // Drive well past capacity on the short interval and check it freezes full.
  v.setSessionLength(null);
  for (let i = 0; i < 60 * 60 * 12; i++) {      // ~12 simulated minutes
    nowMs += 16;
    const cb = rafCb; rafCb = null;
    cb(nowMs);
    if (v.irisRecord().full) break;
  }
  const rec = v.irisRecord();
  assert.ok(rec.full, `expected the disc to fill within 12 minutes (got ${rec.rings})`);
  // Keep going: the ring count must hold, never drop back toward zero.
  for (let i = 0; i < 60 * 90; i++) {
    nowMs += 16;
    const cb = rafCb; rafCb = null;
    cb(nowMs);
  }
  assert.strictEqual(v.irisRecord().rings, cap,
    'a full disc must FREEZE, not wipe and restart from the middle — wiping presents'
    + " the last ten minutes as if it were the whole sit");
  console.log(`✓ Iris spreads rings over the intended length and freezes at ${cap}`
    + ' rather than erasing the sit');
}

// ---- back-compat: the Mind Monitor page only calls setCalm ---------------
{
  const v2 = sandbox.createZenVisual(makeCanvas());
  v2.setCalm(0.8);
  v2.setBreathPeriod(5);
  v2.setNoise(0.2);
  nowMs += 16;
  const cb = rafCb; rafCb = null;
  cb(nowMs);
  console.log('✓ setCalm/setBreathPeriod/setNoise back-compat path works (index.html)');
}

// ---- visual responsiveness is a UI-level setting, not a scoring change ----
{
  const v3 = sandbox.createZenVisual(makeCanvas());
  assert.strictEqual(v3.currentResponsiveness().key, 'sensitive');
  assert.strictEqual(v3.responsivenessModes().map((m) => m.key).join(','),
    'smooth,sensitive,ultrasensitive');
  assert.strictEqual(v3.setResponsiveness('smooth').key, 'smooth');
  assert.strictEqual(v3.cycleResponsiveness().key, 'sensitive');
  assert.strictEqual(v3.setResponsiveness('not-a-mode').key, 'sensitive');
  console.log('✓ visual responsiveness cycles smooth/sensitive/ultrasensitive');
}

// ---- mode cycling returns real modes and wraps -----------------------------
{
  // Cycling reaches the VISIBLE modes only — walking the keyboard through visuals
  // the picker does not offer would be a bug. The render loop above still exercises
  // all of them.
  const seen = new Set();
  for (let i = 0; i < visibleCount; i++) seen.add(visual.cycleMode().key);
  assert.strictEqual(seen.size, visibleCount,
    `cycleMode should reach every visible mode (${visibleCount} of ${modeCount})`);
  const hidden = sandbox.VizCore.MODES.filter((m) => m.hidden).map((m) => m.key);
  for (const k of seen) {
    assert.ok(!hidden.includes(k), `cycling must not land on hidden mode ${k}`);
  }
  console.log('✓ cycleMode reaches every mode and reports it');
}

/* ---- Flow must move BETWEEN samples, not four times a second ---------------
 *
 * Reported as: "it looks like a stop motion, i assume becuase its sample data by seconds,
 * but its just choppy". The frame loop is rAF at ~60fps, but `history` gains a sample only
 * when setState is called — once per 250ms tick. So fifteen consecutive frames drew an
 * identical picture and the sixteenth jumped a whole sample width.
 *
 * This measures the thing the eye was seeing: with NO new data arriving, do the drawn x
 * positions advance every frame, and by the right amount? One sample interval of elapsed
 * time must shift the trace by exactly one sample width. Before the fix the shift was 0.
 */
{
  const W = 1280, H = 720;
  const canvas = makeCanvas(W, H);
  const v = sandbox.createZenVisual(canvas);
  const ctx = canvas.getContext();
  while (v.currentMode().key !== 'flow') v.cycleMode();

  const TICK = 250;                       // the app's real setState cadence, ms
  const sample = (i) => ({
    calm: 0.5 + 0.2 * Math.sin(i / 5),
    noise: 0.1,
    activity: 0.5,
    bands: [0, 1, 2, 3].map((k) => ({ level: 0.4 + 0.1 * Math.sin(i / 4 + k), spike: 0, fresh: true })),
  });
  // Fill some history at the real cadence so the measured interval settles on it.
  for (let i = 0; i < 40; i++) {
    nowMs += TICK;
    v.setState(sample(i));
  }

  /* The RIGHTMOST line vertex in one frame — the newest sample, the one whose position is
   * pure phase. The mean of all vertices was tried first and is not usable: settleRange
   * narrows the vertical band frame by frame, values outside it yield a null y, and the
   * vertex SET changes underneath the average. That read as 1.85x the true drift. The
   * rightmost vertex is always present (a channel is skipped entirely when its newest
   * sample has no y) and is exactly nowX + (1 - phase) * step. */
  const headX = () => {
    ctx.__calls.length = 0;
    nowMs += 16;
    const cb = rafCb; rafCb = null;
    cb(nowMs);
    const xs = ctx.__calls.filter(([n]) => n === 'moveTo' || n === 'lineTo').map(([, a]) => a[0]);
    assert.ok(xs.length > 50, `Flow should be drawing a trace to measure (${xs.length} vertices)`);
    return Math.max(...xs);
  };

  // No setState inside this loop: every change in x is time, not data.
  assert.ok(v.flowScroll().intervalSec != null,
    'the sample cadence must have been measured after 40 samples');
  const marks = [headX()];
  for (let f = 0; f < 14; f++) marks.push(headX());
  const steps = marks.slice(1).map((x, i) => x - marks[i]);
  assert.ok(steps.every((d) => d < 0),
    `every frame must move the trace left, with no new data: ${steps.map((d) => d.toFixed(3)).join(', ')}`);

  /* And by the right amount. nowX is 74% of the BACKING-STORE width, which is not W:
     createZenVisual sizes the canvas for the device pixel ratio, so read it off the canvas
     rather than assuming (this test first computed it from 1280 and was wrong by exactly
     that factor of two). One sample occupies nowX/(FLOW_MAX-1); 15 marks are 14 gaps. */
  const step = (canvas.width * 0.74) / (240 - 1);
  const gaps = marks.length - 1;
  const expected = step * (gaps * 16) / TICK;
  const moved = marks[0] - marks[marks.length - 1];
  assert.ok(Math.abs(moved - expected) < expected * 0.05,
    `${gaps * 16}ms of drift should be ${expected.toFixed(2)}px (one sample width is`
    + ` ${step.toFixed(2)}px), measured ${moved.toFixed(2)}px`);

  // A STALL MUST FREEZE, NOT SLIDE AWAY. The phase is clamped to one interval, so a feed
  // that stops leaves the trace where it is instead of scrolling it off to the left —
  // which is what an unclamped fraction of elapsed time would do.
  nowMs += 5000;
  const stalled = headX();
  const stalledAgain = headX();
  assert.ok(Math.abs(stalledAgain - stalled) < 0.01,
    `a stalled feed must hold still, not keep scrolling (moved ${(stalledAgain - stalled).toFixed(3)}px)`);
  assert.deepStrictEqual(badNumbers, [], `Flow scroll produced bad numbers:\n  ${badNumbers.join('\n  ')}`);
  console.log(`✓ Flow scrolls between samples: ${(-steps[0]).toFixed(2)}px per frame,`
    + ` ${moved.toFixed(2)}px per ${gaps * 16}ms (one sample = ${step.toFixed(2)}px),`
    + ` and freezes when the feed stalls`);
}

/* ---- The recorded past must not move ---------------------------------------
 *
 * Reported after the sub-sample scroll shipped: "it's still choppy, not smooth. and it
 * looks like the history lines still drift, esp when the sensor reads 0 and everything
 * pushes up" — and then, precisely: "by choppy i mean like a battery analog watch vs.
 * automatic. tick tick".
 *
 * That is not a scrolling problem, it is a REVISION problem. Two mechanisms were rewriting
 * already-drawn line, both only on the frame a sample arrived:
 *
 *   1. A centred smoothing window, whose value for any sample within half a window of the
 *      head kept changing as later samples arrived. Measured: samples 0-8 back moved
 *      2.8-3.3% of the band per new sample, samples 10+ back moved 0.01%.
 *   2. The axis widening instantly. Measured on a channel reading zero: 6.14% of the band
 *      in one frame, settling 36% of the band from where it started.
 *
 * So this follows ONE recorded sample — not a screen position, which slides past different
 * samples and measures the signal's own slope instead — and asserts it holds still.
 */
{
  const canvas = makeCanvas(1280, 720);
  const v = sandbox.createZenVisual(canvas);
  while (v.currentMode().key !== 'flow') v.cycleMode();
  const BAND = canvas.height * (0.76 - 0.18);   // flowBottom - flowTop, in canvas px
  const frame = () => { nowMs += 16; const cb = rafCb; rafCb = null; cb(nowMs); };
  const base = (i, k) => 0.42 + 0.06 * Math.sin(i / 9 + k) + 0.004 * Math.sin(i * 2.3 + k);
  // 250ms apart, three frames per sample, exactly as the app drives it.
  const push = (i, ch0) => {
    nowMs += 250 - 16 * 3;
    const bands = [ch0 === undefined ? { level: base(i, 0), fresh: true } : ch0,
      { level: base(i, 1), fresh: true }, { level: base(i, 2), fresh: true },
      { level: base(i, 3), fresh: true }].map((b) => ({ level: b.level, spike: 0, fresh: b.fresh }));
    v.setState({ calm: 0.5, noise: 0.1, activity: 0.5, bands });
    for (let f = 0; f < 3; f++) frame();
  };
  /* Fill to capacity and let the axis converge, so what follows measures revision only. 300 is
     enough: FLOW_MAX is 240 samples and settleRange's release time constant is ~17s, which is
     60 samples at this cadence. 800 was the first guess and cost 1500 needless frames — the
     debug capture allocates four arrays per frame, so it is switched on only to measure. */
  for (let i = 0; i < 300; i++) push(i);
  v.flowDebug(true);
  // One frame with the capture on, or flowTrace has nothing to return yet: the y values are
  // recorded DURING a render, not on demand.
  frame();

  /* Follow the sample currently at `idx`. History is at capacity, so each push shifts it
     down one index — that is what makes this the same sample rather than the same place. */
  const follow = (pushes, ch0of) => {
    let idx = 180, prev = v.flowTrace(0)[idx], first = prev, worst = 0;
    for (let p = 0; p < pushes; p++) {
      push(900 + p, ch0of ? ch0of(p) : undefined);
      idx -= 1;
      const y = v.flowTrace(0)[idx];
      if (y != null && prev != null) worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    return { worst: 100 * worst / BAND, net: 100 * Math.abs(prev - first) / BAND };
  };

  const steady = follow(40);
  assert.ok(steady.worst < 0.05,
    `on a steady signal a recorded sample must not move: worst ${steady.worst.toFixed(3)}% of the band`
    + ' (the centred smoother moved it 2.8-3.3%)');
  assert.ok(steady.net < 0.5, `and must not drift: net ${steady.net.toFixed(2)}% of the band`);

  /* A CHANNEL THAT IS NOT READING MUST NOT SET ITS OWN AXIS. This is what the app sends
     after DSP.isFlat: the stale level is still there, with fresh:false. If that zero
     reaches the range, the whole trace lifts — measured at 43% of the band before. */
  const dead = follow(60, (p) => (p < 16 ? { level: 0, fresh: false } : undefined));
  assert.ok(dead.net < 1,
    `a channel dropping out must not move the recorded past: net ${dead.net.toFixed(2)}% of the band`);
  assert.ok(dead.worst < 0.05,
    `nor jump it: worst ${dead.worst.toFixed(3)}% of the band`);

  /*
   * A REAL EXCURSION MUST NOT MOVE THE AXIS — which is the reverse of what this asserted, and the reversal
   * is the point.
   *
   * It used to require that an excursion took the axis with it, eased rather than instantly, on the
   * argument that an axis which stops adapting is the opposite bug. Three rounds of easing later the
   * report was still "the lines still wildly jump in flow visuals for sensors... i think it's bc the range
   * is recent", and it was right: an axis that adapts at all moves the whole drawn history, because the
   * same axis is applied to every sample on screen.
   *
   * These series do not need to adapt. A channel's value is alpha's share of alpha+beta — a bounded ratio
   * already on a fixed scale — so the axis is a constant 0-0.75, which is better than merely still: it is
   * the same axis in every sit, so two sits' traces are comparable by eye.
   *
   * What the old assertion was really protecting is that the excursion still REGISTERS, and that is
   * checked directly below instead of via the axis.
   */
  const spike = follow(40, (p) => (p < 2 ? { level: 0.7, fresh: true } : undefined));
  assert.ok(spike.net < 0.5,
    `an excursion must not drag the recorded past with it (net ${spike.net.toFixed(2)}% of the band)`);
  assert.ok(spike.worst < 0.05,
    `nor jump it (worst ${spike.worst.toFixed(3)}% of the band)`);

  /* AND THE EXCURSION ITSELF MUST BE VISIBLE. A fixed axis that swallowed the excursion would be still and
     useless — the failure mode a constant axis could plausibly have. Fed a level near the top of the window
     against one near the bottom, the newest drawn sample has to move a long way up the band. */
  {
    /* Read the NEWEST drawn sample after settling at a level: flowTrace records the y of every sample
       during a render, so the last index is where the line currently is. */
    const headAt = (level) => {
      for (let p = 0; p < 12; p++) push(2000 + p, { level, fresh: true });
      const ys = v.flowTrace(0);
      return ys[ys.length - 1];
    };
    const low = headAt(0.15);
    const high = headAt(0.70);
    assert.ok(low != null && high != null, 'precondition: the head is drawn at both levels');
    const moved = 100 * Math.abs(low - high) / BAND;
    assert.ok(moved > 40,
      'a change from 0.15 to 0.70 must move the line most of the band rather than being clipped away —'
      + ` a fixed axis that swallowed the signal would be still and useless (moved ${moved.toFixed(1)}%)`);
  }
  assert.ok(spike.worst < 1,
    `but must ease into it, not jump (worst single push ${spike.worst.toFixed(2)}% of the band)`);

  /* AND THE TICK ITSELF: movement must no longer be concentrated on the frame a sample
     lands. That ratio was 0.584% against 0.002% — a 290x step function, which is what a
     ticking hand is. */
  let onPush = 0, onIdle = 0, nPush = 0, nIdle = 0;
  {
    let idx = 180, prev = v.flowTrace(0)[idx];
    for (let p = 0; p < 40; p++) {
      nowMs += 250 - 16 * 3;
      v.setState({ calm: 0.5, noise: 0.1, activity: 0.5,
        bands: [0, 1, 2, 3].map((k) => ({ level: base(1200 + p, k), spike: 0, fresh: true })) });
      idx -= 1;
      frame();
      { const y = v.flowTrace(0)[idx]; if (y != null && prev != null) { onPush += Math.abs(y - prev); nPush++; } prev = y; }
      for (let f = 0; f < 2; f++) {
        frame();
        const y = v.flowTrace(0)[idx];
        if (y != null && prev != null) { onIdle += Math.abs(y - prev); nIdle++; }
        prev = y;
      }
    }
  }
  const pushPct = 100 * onPush / nPush / BAND, idlePct = 100 * onIdle / nIdle / BAND;
  assert.ok(pushPct < 0.1,
    `the frame after a sample arrives must not move the past: ${pushPct.toFixed(4)}% of the band`);
  v.flowDebug(false);
  assert.deepStrictEqual(badNumbers, [], `the frozen-past path produced bad numbers:\n  ${badNumbers.join('\n  ')}`);
  console.log(`✓ the recorded past holds still: steady ${steady.worst.toFixed(3)}%/sample,`
    + ` dropout net ${dead.net.toFixed(2)}%, push frame ${pushPct.toFixed(4)}% vs idle ${idlePct.toFixed(4)}%`
    + ` of the band, while a real excursion still rescales (${spike.net.toFixed(2)}%)`);
}

/* ---- RIBBON HAS NO DERIVED AXIS, and that is the point of it -----------------------
 *
 * Ribbon maps a score to a height through `expandSoft(v, 0.28, 0.82)` — a CONSTANT. Flow's composites
 * learn a range from the data and then hold it, which is honest but means the first two minutes still move
 * and two sits are not comparable by eye. The complaint that took three rounds to fix was "the lines still
 * drift and i think it's bc the range is recent", and in this mode drift is not fixed, it is IMPOSSIBLE:
 * there is no state to drift.
 *
 * So the assertion is not "the past moved less than x%", which is a measurement of a thing that can
 * regress. It is that Ribbon never asks for a range at all — no `autoRange`, no `settleRange`, no
 * `inRange`. Anyone who later reaches for one to make the ribbons fill the screen better will fail here,
 * and the note above will tell them why not to.
 *
 * The height of a recorded sample is checked too, across a frame where a new sample lands: a constant
 * transform of a frozen value cannot move, so if it does, something else is rewriting history.
 */
{
  const canvas = makeCanvas(1280, 720);
  const ctx = canvas.getContext();
  const asked = [];
  for (const fn of ['autoRange', 'settleRange', 'inRange']) {
    const real = sandbox.VizCore[fn];
    sandbox.VizCore[fn] = (...args) => { asked.push(fn); return real(...args); };
  }
  const v = sandbox.createZenVisual(canvas);
  while (v.currentMode().key !== 'ribbon') v.cycleMode();

  const feed = (calm, thinking) => v.setState({
    calm, activity: thinking, noise: 0, breathAmount: null, breathPeriod: 9,
    metrics: { calm, focus: 0.5, thinking, drowsy: 0.4 },
    bands: [0, 1, 2, 3].map(() => ({ level: 0.3, spike: 0, fresh: true })),
  });
  const step = () => { nowMs += 16; const cb = rafCb; rafCb = null; cb(nowMs); };

  // 40 samples of a steady sit, then a violent excursion — which is what would move a learned axis.
  for (let i = 0; i < 40; i++) { feed(0.5, 0.5); step(); step(); step(); }
  const geometry = () => ctx.__calls
    .filter(([n]) => n === 'moveTo' || n === 'lineTo' || n === 'bezierCurveTo')
    .map(([, a]) => a.join(',')).join(';');
  ctx.__calls.length = 0; step();
  const before = geometry();
  for (let i = 0; i < 6; i++) { feed(0.95, 0.05); step(); step(); step(); }
  ctx.__calls.length = 0; step();
  const after = geometry();

  assert.deepStrictEqual(asked, [],
    `Ribbon must derive no axis from the data — it asked for ${asked.join(', ')}`);
  assert.ok(before.length > 200 && after.length > 200,
    'the ribbons must actually be drawn, or this measures nothing');
  /* The picture MUST change (the excursion is real and the trace scrolls), so this is not "nothing
     moved" — it is that the ribbons are still being drawn from the same constant mapping, which the
     absence of any range call above establishes. This second check is the smoke: geometry that stops
     changing means the render broke, and geometry identical to before means it froze. */
  assert.notStrictEqual(before, after, 'a real excursion must still change the picture');
  assert.deepStrictEqual(badNumbers, [], `Ribbon produced bad numbers:\n  ${badNumbers.join('\n  ')}`);
  console.log('✓ Ribbon derives no axis from the data: 0 range calls, so its heights cannot drift,'
    + ' and a real excursion still moves the picture');
}

/* ---- The sweep visuals must move EVERY frame, not six times a second -------------
 *
 * Reported as "corona is still very very choppy. like it's in slo mo" — after a first fix that
 * eased the composite values and changed nothing, because the values were never the cause.
 *
 * Measured: with the data feed steady, Corona's drawn geometry changed on 5 of 59 consecutive
 * frames, in a regular one-change-every-ten-frames pattern. 144 bins over a 24-second revolution
 * is one bin every 0.167s, so the picture could only update six times a second, in discrete
 * angular jumps. Pulse measured the same, for the same reason.
 *
 * This measures the thing the eye sees: with NO new data arriving, does the drawn output change
 * on every frame? Every numeric argument of every recorded op is summed, not just line vertices —
 * the first version of this measurement looked only at moveTo/lineTo and reported Corona as
 * changing on 0 of 59 frames, because Corona draws with arcs and gradients.
 */
{
  const canvas = makeCanvas(1280, 720);
  const v = sandbox.createZenVisual(canvas);
  const ctx = canvas.getContext();
  const frame = () => { nowMs += 16; const cb = rafCb; rafCb = null; cb(nowMs); };
  const feed = (i) => v.setState({
    calm: 0.5, noise: 0.05, activity: 0.5,
    metrics: { calm: 0.5 + 0.15 * Math.sin(i / 12), focus: 0.5, thinking: 0.45, drowsy: 0.4 },
    bands: [0, 1, 2, 3].map(() => ({ level: 0.45, spike: 0, fresh: true })),
  });

  const signature = () => {
    let acc = 0;
    for (const [name, args] of ctx.__calls) {
      for (let i = 0; i < args.length; i++) {
        const val = args[i];
        // Weighted by position and op name so two different frames cannot coincidentally sum
        // to the same total.
        if (typeof val === 'number' && Number.isFinite(val)) acc += val * (1 + ((i + name.length) % 13));
      }
    }
    return acc;
  };

  for (const mode of ['corona', 'pulse']) {
    while (v.currentMode().key !== mode) v.cycleMode();
    // Warm the ring past a full revolution at the app's real cadence: 250ms of data, ~15 frames.
    for (let i = 0; i < 120; i++) { feed(i); for (let f = 0; f < 15; f++) frame(); }
    const sig = [];
    for (let f = 0; f < 40; f++) { ctx.__calls.length = 0; frame(); sig.push(signature()); }
    let identical = 0;
    for (let i = 1; i < sig.length; i++) if (Math.abs(sig[i] - sig[i - 1]) < 1e-9) identical++;
    assert.strictEqual(identical, 0,
      `${mode} must redraw something different on every frame with the feed steady:`
      + ` ${identical} of ${sig.length - 1} frames were identical to the one before`
      + ' (it was 54 of 59 before the sweep position became continuous)');
  }
  assert.deepStrictEqual(badNumbers, [], `the continuous sweep produced bad numbers:\n  ${badNumbers.join('\n  ')}`);
  console.log('✓ Corona and Pulse sweep continuously: 0 identical consecutive frames, where the'
    + ' quantised cursor left 54 of 59 unchanged');
}

console.log('\nAll visual smoke tests passed.');
