/*
 * Tests for the analysis core.
 *
 * THE TEST THAT MATTERS IS #3: pure noise must produce NOTHING. Every other
 * assertion here is hygiene. A pattern-finder that reports findings from random data
 * is worse than no tool at all, because its output is indistinguishable from a real
 * discovery and will get built into the app and shown to somebody as a fact about
 * their mind.
 *
 * Note the shape of these tests: signal is PLANTED with a known strength and a known
 * sign, and noise is generated with a seeded generator. Ground truth is therefore
 * something the test constructs and the implementation is never told — not a fixture
 * built from the same assumptions as the code.
 */
const assert = require('assert');
const A = require('./public/analysis.js');

const rnd = A.seededRandom(4242);
const gauss = () => {
  // Box-Muller, so "noise" is actually normal rather than uniform — uniform noise is
  // easier to correlate against and would make the null test too kind.
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// 1) Correlation basics, against values checkable by hand.
{
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.ok(Math.abs(A.correlate(xs, xs).r - 1) < 1e-9, 'a series correlates perfectly with itself');
  assert.ok(Math.abs(A.correlate(xs, xs.slice().reverse()).r + 1) < 1e-9, 'and inversely with its reverse');

  // A constant series must give null, NOT zero. Zero would read as "measured, no
  // relationship"; the truth is "not measurable".
  const flat = A.correlate(xs, [3, 3, 3, 3, 3, 3, 3, 3]);
  assert.strictEqual(flat.r, null);
  assert.match(flat.reason, /does not vary/);

  // Too few pairs must refuse rather than produce an impressive r from 3 points.
  const few = A.correlate([1, 2, 3], [1, 2, 3]);
  assert.strictEqual(few.r, null);
  assert.strictEqual(few.n, 3);
  assert.match(few.reason, /too few/);

  // Missing values drop the PAIR — never imputed, which would be a fabricated
  // observation, and with sparse labels the fabrications would dominate.
  const withGaps = A.correlate([1, null, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, null, 5, 6, 7, 8, 9]);
  assert.strictEqual(withGaps.n, 7, 'two incomplete pairs must be dropped, not filled');
  console.log('✓ correlation refuses where it cannot measure, and never imputes');
}

// 2) Spearman on ORDINAL data with heavy ties — which is all a 1-5 scale ever is.
{
  const labels = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  const monotoneButNotLinear = labels.map((v) => v ** 3);
  const s = A.spearman(labels, monotoneButNotLinear);
  assert.ok(Math.abs(s.rho - 1) < 1e-9,
    'a monotone-but-curved relationship is a perfect rank correlation');
  // Pearson would understate it — which is exactly why Spearman is the default here.
  const p = A.correlate(labels, monotoneButNotLinear);
  assert.ok(p.r < 0.98, 'Pearson penalises the curvature, Spearman does not');

  // Ties must share the average rank. Ignoring that inflates rho on 1-5 data.
  assert.deepStrictEqual(A.rank([5, 5, 1, 3]), [3.5, 3.5, 1, 2]);
  assert.deepStrictEqual(A.rank([2, null, 1]), [2, null, 1], 'nulls stay null through ranking');
  console.log('✓ Spearman handles ordinal labels and ties, and beats Pearson on curves');
}

// 3) *** THE ONE THAT MATTERS *** Pure noise must yield no confirmed findings.
//    40 features x 4 labels = 160 comparisons on random data. At p < 0.05 about
//    eight of those will look "significant" by chance. Nothing may survive.
{
  const units = [];
  for (let sess = 0; sess < 8; sess++) {
    for (let u = 0; u < 4; u++) {
      const features = {};
      for (let f = 0; f < 40; f++) features[`f${f}`] = gauss();
      units.push({
        sessionId: `s${sess}`,
        features,
        labels: {
          focus: 1 + Math.floor(rnd() * 5), effort: 1 + Math.floor(rnd() * 5),
          pull: 1 + Math.floor(rnd() * 5), tone: 1 + Math.floor(rnd() * 5),
        },
      });
    }
  }
  const res = A.search(units, { iterations: 400 });
  assert.strictEqual(res.comparisons, 160, 'the size of the search must be reported');
  assert.strictEqual(res.confirmed.length, 0,
    `pure noise must confirm NOTHING (got ${res.confirmed.map((c) => c.key).join(', ')})`);
  assert.match(res.verdict, /No pattern survived/,
    'and the verdict must say so in words, not leave a table to be misread');
  assert.match(res.verdict, /160 comparisons/,
    'the verdict must state how many comparisons were made — a finding is worth'
    + ' nothing without the size of the search behind it');

  // Uncorrected, the search DOES find things. That is the whole point: without the
  // correction and the held-out check, this tool would report those as discoveries.
  const raw = res.tests.filter((t) => t.p != null && t.p < 0.05);
  assert.ok(raw.length >= 3,
    `noise should produce several nominally significant hits (got ${raw.length});`
    + ' if it does not, this test is not exercising the problem it exists for');
  console.log(`✓ 160 comparisons on pure noise: ${raw.length} nominally significant,`
    + ' 0 confirmed — the defences work');
}

// 4) A PLANTED signal must be found, or the tool is merely a no-detector.
{
  const units = [];
  for (let sess = 0; sess < 10; sess++) {
    for (let u = 0; u < 5; u++) {
      const focus = 1 + Math.floor(rnd() * 5);
      const features = { real: focus * 0.5 + gauss() * 0.35 };  // strong, not perfect
      for (let f = 0; f < 20; f++) features[`noise${f}`] = gauss();
      units.push({ sessionId: `s${sess}`, features, labels: { focus } });
    }
  }
  const res = A.search(units, { iterations: 400 });
  const found = res.confirmed.map((c) => c.feature);
  assert.ok(found.includes('real'),
    `the planted feature must be found (confirmed: ${found.join(', ') || 'none'})`);
  const real = res.confirmed.find((c) => c.feature === 'real');
  assert.ok(real.trainRho > 0 && real.testRho > 0,
    'the direction must be positive on both halves, since that is how it was planted');
  assert.strictEqual(real.heldUp, true);

  /* FALSE POSITIVES ARE EXPECTED HERE, and the first version of this test wrongly
   * demanded zero of them.
   *
   * FDR controls the expected PROPORTION of false discoveries among those reported —
   * at fdr = 0.1, roughly one survivor in ten being spurious is the method working
   * as specified, not failing. It does not and cannot promise a clean list. What it
   * promises is that the list is mostly real and that the proportion is known.
   *
   * So the assertions are: the planted feature is found, it is the STRONGEST
   * held-out result, and the spurious rate is consistent with the declared FDR.
   * Anything stricter would be asserting a guarantee the statistics do not give, and
   * would go green only by luck.
   */
  const noiseSurvivors = found.filter((f) => f.startsWith('noise'));
  const byHeldOut = res.confirmed.slice()
    .sort((a, b) => Math.abs(b.testRho) - Math.abs(a.testRho));
  assert.strictEqual(byHeldOut[0].feature, 'real',
    `the planted signal must be the strongest held-out result, not merely present`
    + ` (top was ${byHeldOut[0].feature})`);
  assert.ok(noiseSurvivors.length <= 3,
    `spurious survivors must stay consistent with fdr=0.1 out of 21 features`
    + ` (got ${noiseSurvivors.length}: ${noiseSurvivors.join(', ')})`);
  console.log(`✓ a planted signal is found and ranks first (train rho ${real.trainRho.toFixed(2)},`
    + ` held-out ${real.testRho.toFixed(2)}); ${noiseSurvivors.length} spurious survivor(s),`
    + ' as FDR 0.1 permits');
}

// 5) THE SPLIT MUST BE BY SESSION. Samples within one sit are near-duplicates, so a
//    sample-level split leaks the answer across the boundary and makes every method
//    look excellent — the most common way a result like this turns out to be nothing.
{
  const ids = ['a', 'a', 'a', 'b', 'b', 'c', 'c', 'd'];
  const split = A.splitSessions(ids, { holdOut: 0.5, seed: 1 });
  const overlap = split.train.filter((s) => split.test.includes(s));
  assert.deepStrictEqual(overlap, [],
    'no session may appear on both sides — that is the leak this exists to prevent');
  assert.strictEqual(split.train.length + split.test.length, 4, 'four distinct sessions');
  assert.ok(split.test.length >= 1 && split.train.length >= 1);

  // Deterministic, so a held-out score can be re-derived rather than re-rolled until
  // it flatters.
  assert.deepStrictEqual(A.splitSessions(ids, { seed: 1 }), A.splitSessions(ids, { seed: 1 }));
  // The seed must actually matter — but comparing two arbitrary seeds is not a valid
  // test of that: with four sessions and one held out, two seeds coincide a quarter
  // of the time, so the first version of this assertion was a 25% flake. Scan a
  // range and require that the choice varies across it.
  const outcomes = new Set();
  for (let seed = 1; seed <= 10; seed++) outcomes.add(A.splitSessions(ids, { seed }).test.join(','));
  assert.ok(outcomes.size > 1,
    `the seed must change which session is held out (all 10 seeds gave ${[...outcomes][0]})`);

  // One session cannot be validated at all, and must say so rather than pretend.
  const single = A.splitSessions(['only'], {});
  assert.deepStrictEqual(single.test, []);
  assert.match(single.reason, /at least 2 sessions/);
  const res = A.search([{ sessionId: 'only', features: { a: 1 }, labels: { focus: 3 } }]);
  assert.match(res.verdict, /Not enough labelled observations/);
  console.log('✓ the train/test split is by session, deterministic, and refuses on one session');
}

// 6) Permutation p-values: reproducible, and never exactly zero.
{
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ys = xs.map((v) => v * 2);
  const a = A.permutationP(xs, ys, { iterations: 500, seed: 3 });
  const b = A.permutationP(xs, ys, { iterations: 500, seed: 3 });
  assert.strictEqual(a.p, b.p, 'a p-value must be reproducible, or it invites re-rolling');
  assert.ok(a.p > 0, 'p must never be exactly 0 — a finite number of shuffles cannot show that');
  assert.ok(a.p < 0.01, 'a perfect relationship should still be highly significant');
  assert.strictEqual(a.p, 1 / 501, 'with no shuffle beating it, p is (0+1)/(iterations+1)');

  const noise = A.permutationP([1, 2, 3, 4, 5, 6, 7, 8], [5, 2, 8, 1, 7, 3, 6, 4],
    { iterations: 500, seed: 3 });
  assert.ok(noise.p > 0.05, 'a scrambled relationship must not be significant');
  console.log(`✓ permutation p is reproducible and bounded away from zero (${a.p.toFixed(4)})`);
}

// 7) Benjamini-Hochberg, and the requirement that failures stay in the table.
{
  const tests = [
    { key: 'a', p: 0.001 }, { key: 'b', p: 0.008 }, { key: 'c', p: 0.04 },
    { key: 'd', p: 0.3 }, { key: 'e', p: 0.7 }, { key: 'f', p: null },
  ];
  const adj = A.adjustForMultiplicity(tests, { fdr: 0.1 });
  assert.strictEqual(adj.comparisons, 5, 'the untestable one is not a comparison');
  assert.strictEqual(adj.tests.length, 6,
    'every test stays in the output, including the failures — hiding them hides the'
    + ' size of the search, which is what determines a survivor’s worth');
  const byKey = Object.fromEntries(adj.tests.map((t) => [t.key, t]));
  assert.ok(byKey.a.passes && byKey.b.passes, 'the strongest results survive');
  assert.ok(!byKey.e.passes, 'p = 0.7 cannot survive');
  assert.strictEqual(byKey.f.q, null, 'an untestable comparison gets no q-value');
  assert.strictEqual(byKey.f.passes, false, 'and certainly does not pass');
  // q must be at least p, and monotone in p.
  for (const t of adj.tests) if (t.p != null) assert.ok(t.q >= t.p - 1e-12, `q >= p for ${t.key}`);
  console.log('✓ FDR correction keeps every comparison in the table, including the failures');
}

// 8) unitsFromSpans must not inflate n. A 20-minute span with one label is ONE
//    observation, not 1200 — feeding samples in individually would shrink every
//    p-value by the number of seconds in the span while adding nothing independent.
{
  const metrics = [];
  for (let t = 0; t < 1200; t++) metrics.push({ t, calm: 0.5 + t / 4000, focus: 0.3, epochMs: t });
  const units = A.unitsFromSpans([{
    sessionId: 's1', metrics,
    spans: [
      { fromSec: 0, toSec: 600, dims: { focus: 2 } },
      { fromSec: 600, toSec: 1200, dims: { focus: 5 } },
      { fromSec: 1200, toSec: 1800, dims: null },        // unlabelled tail
    ],
  }]);
  assert.strictEqual(units.length, 2,
    `two labelled spans must give two observations, not 1200 (got ${units.length})`);
  assert.strictEqual(units[0].samples, 600, 'the sample count is kept for reporting');
  assert.ok(units[1].features.calm > units[0].features.calm,
    'features are averaged within the span');
  // `t` and `epochMs` are coordinates, not features — correlating a label against the
  // clock would find "time" and call it a discovery.
  assert.ok(!('t' in units[0].features), 'the timestamp must not become a feature');
  assert.ok(!('epochMs' in units[0].features), 'nor the absolute clock');
  assert.deepStrictEqual(units[0].labels, { focus: 2 });
  console.log('✓ spans aggregate to one observation each, and the clock is not a feature');
}

console.log('\nAll analysis tests passed.');
