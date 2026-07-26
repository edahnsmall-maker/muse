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
    textBaseline: 'alphabetic', __ops: [] };

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
const modeCount = sandbox.VizCore.MODES.length;
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
  // Creation order is [target, compose buffer, scratch layer, Iris record].
  const layers = createdCanvases.slice(canvasesBefore);
  assert.strictEqual(layers.length, 4, 'expected the target canvas plus three offscreen layers');
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
  const seen = new Set();
  for (let i = 0; i < modeCount; i++) seen.add(visual.cycleMode().key);
  assert.strictEqual(seen.size, modeCount, 'cycleMode should reach every mode');
  console.log('✓ cycleMode reaches every mode and reports it');
}

console.log('\nAll visual smoke tests passed.');
