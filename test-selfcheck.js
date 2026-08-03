/*
 * Tests for selfcheck.js — can the display tell the recorded signal from a shuffled copy of it?
 *
 * The point of this module is to deliver bad news about the app it lives in, so the tests are
 * written to make sure it CAN. A self-check that reports everything as fine is worse than no
 * self-check: it converts an unexamined problem into a certified one.
 *
 * So the central tests use transforms whose answer is known in advance — one that genuinely
 * responds to temporal structure, and one that cannot possibly — and require the module to
 * separate them.
 */
const assert = require('assert');
const SelfCheck = require('./public/selfcheck.js');
const DSP = require('./public/dsp.js');

function rnd(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// A series with real temporal structure: a slow wander, the shape a settling mind would produce.
function wander(n = 400, seed = 3, amp = 0.3) {
  const r = rnd(seed);
  const out = [];
  let v = 0.5;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * 0.02;
    v = Math.max(0, Math.min(1, v));
    out.push(v + amp * Math.sin(i / 40) * 0.5);
  }
  return out;
}

// A series with none: independent draws, so order carries nothing.
function white(n = 400, seed = 5) {
  const r = rnd(seed);
  return Array.from({ length: n }, () => r());
}

/* 1) A TRANSFORM THAT DEPENDS ON ORDER MUST SCORE WELL.
 *    A trailing average is the simplest thing that genuinely uses temporal structure: on a wandering
 *    series it tracks the wander, and on a shuffled copy it averages out to nearly nothing. If the
 *    module cannot see the difference here, it cannot see anything.
 */
{
  const trailing = (xs) => {
    const out = [];
    let acc = xs[0];
    for (const v of xs) { acc += 0.05 * (v - acc); out.push(acc); }
    return out;
  };
  const r = SelfCheck.check(wander(), trailing);
  assert.strictEqual(r.known, true, `the check must produce an answer (${r.reason})`);
  assert.ok(r.discrimination > 2,
    `a smoother on a wandering series must clearly beat its shuffle (got ${r.discrimination.toFixed(2)}×)`);
  assert.strictEqual(r.decorative, false, 'and must not be called decorative');
  assert.match(SelfCheck.describe(r, 'Flow'), /genuinely about the recording/,
    'and must say so in words');
  console.log(`✓ an order-dependent transform scores ${r.discrimination.toFixed(1)}× on structured data`);
}

/* 2) A TRANSFORM THAT CANNOT DEPEND ON ORDER MUST SCORE 1.0.
 *    Passing values straight through is order-blind by construction: the 5th-to-95th spread of a
 *    series and of its shuffle are IDENTICAL, because a shuffle preserves the distribution exactly.
 *    So this is the module's calibration point — if it does not read ~1.0 here, its scale is wrong.
 */
{
  const passthrough = (xs) => xs;
  const r = SelfCheck.check(wander(), passthrough);
  assert.strictEqual(r.known, true);
  assert.ok(Math.abs(r.discrimination - 1) < 0.02,
    `an order-blind transform must read 1.00, not more (got ${r.discrimination.toFixed(3)}×)`);
  assert.strictEqual(r.decorative, true, 'and must be reported as decorative');
  assert.match(SelfCheck.describe(r), /cannot distinguish/,
    'in the plainest available words');
  assert.match(SelfCheck.describe(r), /decoration/,
    'and must name it decoration rather than softening it');
  console.log(`✓ an order-blind transform reads ${r.discrimination.toFixed(3)}× and is called decoration`);
}

/* 3) THE REAL PIPELINE, which is the measurement that prompted this module.
 *    DSP.AdaptiveNormalizer is what sits between every metric and every visual. It rescales its
 *    input against that input's own recent range — which means it uses its full output range
 *    whether or not the input carries information.
 */
{
  const throughNormaliser = (xs) => {
    const n = new DSP.AdaptiveNormalizer();
    return xs.map((v) => n.update(v)).filter((v) => v != null);
  };
  const structured = SelfCheck.check(wander(), throughNormaliser);
  const noise = SelfCheck.check(white(), throughNormaliser);
  assert.strictEqual(structured.known, true);
  assert.strictEqual(noise.known, true);

  /* THE FINDING, asserted rather than described: on structureless input the normaliser's output
     spread is the same for the series and its shuffle, so the display carries no information about
     order. This is the honest characterisation of the visuals and it must not quietly regress into
     looking fine. */
  assert.ok(noise.discrimination < 1.5,
    `on structureless input the normaliser must not appear informative`
    + ` (got ${noise.discrimination.toFixed(2)}×)`);

  // On structured input it should do better — if it does not, the normaliser is destroying signal
  // rather than revealing it, which is a different and equally important thing to know.
  console.log(`✓ the real normaliser scores ${structured.discrimination.toFixed(2)}× on a wandering`
    + ` series and ${noise.discrimination.toFixed(2)}× on white noise`);
}

// 4) REPRODUCIBLE. A number that changes when you look again invites re-rolling until it flatters.
{
  const t = (xs) => { const n = new DSP.AdaptiveNormalizer(); return xs.map((v) => n.update(v)).filter((v) => v != null); };
  const a = SelfCheck.check(wander(), t, { seed: 7 });
  const b = SelfCheck.check(wander(), t, { seed: 7 });
  assert.strictEqual(a.discrimination, b.discrimination, 'the same seed must give the same answer');
  const c = SelfCheck.check(wander(), t, { seed: 8 });
  assert.notStrictEqual(a.discrimination, c.discrimination, 'and the seed must actually matter');
  console.log('✓ the result is reproducible from its seed, and the seed matters');
}

/* 5) SEVERAL SHUFFLES, MEDIANED. One shuffle can be lucky, and a mean would be dragged by a single
 *    unusual arrangement — the same reason the lab medians its surrogate bands.
 */
{
  const t = (xs) => xs.map((v, i) => (i > 0 ? (v + xs[i - 1]) / 2 : v));
  const one = SelfCheck.check(wander(), t, { repeats: 1, seed: 2 });
  const many = SelfCheck.check(wander(), t, { repeats: 21, seed: 2 });
  assert.strictEqual(one.known, true);
  assert.strictEqual(many.known, true);
  // Not asserting which is larger — asserting that more shuffles changes the answer, i.e. that the
  // repeats are doing something rather than being decorative themselves.
  assert.notStrictEqual(one.shuffledSpread, many.shuffledSpread,
    'more shuffles must actually change the surrogate estimate');
  console.log(`✓ the surrogate is medianed over repeats (1 shuffle ${one.shuffledSpread.toFixed(4)},`
    + ` 21 shuffles ${many.shuffledSpread.toFixed(4)})`);
}

// 6) DEGRADES HONESTLY. Too little data, or a degenerate transform, must be "cannot tell" and never
//    a reassuring number.
{
  const t = (xs) => xs;
  for (const short of [[], [1, 2, 3], white(30)]) {
    const r = SelfCheck.check(short, t);
    assert.strictEqual(r.known, false, `${short.length} samples must not yield an answer`);
    assert.strictEqual(r.discrimination, null, 'and no number');
    assert.ok(r.reason, 'with a reason');
    assert.match(SelfCheck.describe(r), /Not enough data/, 'said plainly');
  }
  // A transform that flattens everything gives a zero surrogate spread. That is a degenerate
  // transform, not infinite discrimination, and must not be reported as the best possible score.
  const flat = SelfCheck.check(wander(), () => new Array(400).fill(0.5));
  assert.strictEqual(flat.known, false,
    'a transform that collapses its input must be unknown, not perfect');
  assert.strictEqual(flat.decorative, false, 'and must not be scored at all');
  assert.match(flat.reason, /no spread/, 'with the degeneracy named');

  // Nulls and NaNs in the input must be dropped, not propagate into the ratio.
  const messy = wander().map((v, i) => (i % 25 === 0 ? null : v));
  const r = SelfCheck.check(messy, (xs) => { const n = new DSP.AdaptiveNormalizer(); return xs.map((v) => n.update(v)).filter((v) => v != null); });
  assert.strictEqual(r.known, true, 'a few gaps must not sink the check');
  assert.ok(Number.isFinite(r.discrimination), 'and must not produce NaN');
  console.log('✓ too little data, a degenerate transform and gappy input all report "cannot tell"');
}

/* 7) THE THRESHOLD IS ABOVE WHAT CHANCE PRODUCES. If DECORATIVE_BELOW sat under the ratio a
 *    structureless series reaches by luck, the check would certify noise as signal — the precise
 *    failure it exists to prevent. Measured across many seeds rather than assumed.
 */
{
  const t = (xs) => xs;                       // order-blind: every answer here is chance alone
  let worst = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const r = SelfCheck.check(white(400, seed), t, { seed });
    if (r.known) worst = Math.max(worst, r.discrimination);
  }
  assert.ok(worst < SelfCheck.DECORATIVE_BELOW,
    `chance alone reached ${worst.toFixed(3)}× on an order-blind transform, which is at or above`
    + ` the ${SelfCheck.DECORATIVE_BELOW}× threshold — the threshold would certify noise as signal`);
  console.log(`✓ the decorative threshold (${SelfCheck.DECORATIVE_BELOW}×) sits above the`
    + ` ${worst.toFixed(3)}× that chance reaches over 30 seeds`);
}

console.log('\nAll self-check tests passed.');
