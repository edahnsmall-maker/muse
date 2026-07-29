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

/*
 * MARKS AS OBSERVATIONS, and the wider signature vocabulary.
 *
 * Two things asked for, and both are the kind of change that can quietly go wrong
 * without failing: a window built from the wrong seconds still produces numbers, and a
 * feature that is subtly mis-derived still correlates with something.
 */
{
  // Windows come from BEFORE the mark, and stop short of it.
  const rows = [];
  for (let t = 0; t < 200; t++) rows.push({ t, calm: t, focus: 200 - t });
  const sessions = [{ sessionId: 'S1', metrics: rows,
    notes: [{ offsetSec: 100, transition: 'returned', anchored: true }] }];
  const units = A.unitsFromMarks(sessions, { leadSec: 10, tailSec: 2, controlsPerMark: 0 });
  const mark = units.find((u) => !u.isControl);
  assert.ok(mark, 'a mark must produce a unit');
  assert.strictEqual(mark.toSec, 98,
    'the window must END tailSec before the mark: pressing a key moves a hand and a jaw,'
    + ' and that muscle activity lands in the frequencies the scores are built from');
  assert.strictEqual(mark.fromSec, 90, 'and reach leadSec back from the mark');
  // calm == t here, so the mean of t in [90,98) is 93.5 — proof the right rows were used.
  assert.ok(Math.abs(mark.features['calm.level'] - 93.5) < 1e-9,
    `the window must contain exactly rows 90..97 (got mean ${mark.features['calm.level']})`);
  assert.ok(Math.abs(mark.features['calm.trend'] - 1) < 1e-9,
    'calm rises 1 per second here, so the trend must be 1');
  assert.ok(Math.abs(mark.features['focus.trend'] + 1) < 1e-9, 'and focus falls at 1');
  assert.ok(Math.abs(mark.features['calm+focus.pair'] + 1) < 1e-6,
    'two exactly opposed lines must give a pair value of -1, not 0 or +1');

  // A mark too early to have a full window is DROPPED, not padded with whatever rows
  // happen to exist — a half-length window is a different measurement.
  const early = A.unitsFromMarks(
    [{ sessionId: 'S1', metrics: rows, notes: [{ offsetSec: 4, transition: 'returned' }] }],
    { leadSec: 10, tailSec: 2, controlsPerMark: 0 });
  assert.strictEqual(early.length, 0, 'a mark inside the first leadSec must be skipped');

  // Probe answers must NOT become marks: a probe fires on a clock, so the window
  // before it samples the sit rather than a state the person had just noticed.
  const withProbe = A.unitsFromMarks([{ sessionId: 'S1', metrics: rows, notes: [
    { offsetSec: 100, transition: 'returned', anchored: true },
    { offsetSec: 150, kind: 'probe', response: 'aware-on', anchored: true },
  ] }], { leadSec: 10, tailSec: 2, controlsPerMark: 0 });
  assert.strictEqual(withProbe.filter((u) => !u.isControl).length, 1,
    'only the tap counts as a mark; a clock-scheduled probe is not a noticed moment');
}

{
  // CONTROL WINDOWS exist because a single tap category has no contrast: a one-class
  // label has zero variance, so every correlation against it is null.
  const rows = [];
  for (let t = 0; t < 600; t++) rows.push({ t, calm: 0.5, focus: 0.4 });
  const notes = [];
  for (let i = 0; i < 5; i++) notes.push({ offsetSec: 60 + i * 100, transition: 'returned' });
  const units = A.unitsFromMarks([{ sessionId: 'S1', metrics: rows, notes }],
    { leadSec: 10, tailSec: 2, controlClearanceSec: 30 });
  const controls = units.filter((u) => u.isControl);
  assert.ok(controls.length > 0, 'controls must be generated');
  assert.ok(controls.every((u) => notes.every((n) => Math.abs(n.offsetSec - u.toSec) >= 20)),
    'a control window must be kept clear of every mark, or it is partly a mark window');
  // The label is one-vs-rest, and with ONE category the coarse "any mark" question is
  // the identical question — asking it twice doubles the comparison count for no new
  // information, which costs real power under multiplicity correction.
  assert.deepStrictEqual(Object.keys(units[0].labels), ['is:returned'],
    `one category must yield one label (got ${Object.keys(units[0].labels).join(', ')})`);
  const two = A.unitsFromMarks([{ sessionId: 'S1', metrics: rows, notes:
    notes.concat([{ offsetSec: 560, transition: 'lost' }]) }], { leadSec: 10, tailSec: 2 });
  assert.deepStrictEqual(Object.keys(two[0].labels).sort(),
    ['is:any-mark', 'is:lost', 'is:returned'],
    'two categories earn the coarse question as well as one each');
}

{
  // windowFeatures: refusals rather than fabrications.
  assert.strictEqual(A.windowFeatures([{ t: 0, calm: 1 }, { t: 1, calm: 2 }]), null,
    'fewer than three rows cannot support a trend or an sd — refuse, do not guess');
  // A constant line has NO co-movement. Reporting 0 would claim it moved independently,
  // which is a claim about a line that did not move at all.
  const flat = A.windowFeatures([0, 1, 2, 3, 4].map((t) => ({ t, calm: 0.5, focus: t })));
  assert.ok(!('calm+focus.pair' in flat),
    'a constant series must yield no pair feature, not a pair value of 0');
  /* And the within-window threshold must be BELOW the window length, or a single
     dropped sample deletes every pair and trio feature rather than costing precision.
     The default window is leadSec 10 minus tailSec 2 = 8 samples at 1Hz, and this sat
     exactly on correlate's MIN_N of 8 until windowCorr was split out. */
  assert.ok(A.MIN_WINDOW_PAIRS < 8,
    `a ${A.MIN_WINDOW_PAIRS}-sample floor leaves no slack in an 8-sample window`);
  assert.strictEqual(A.windowCorr([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1,
    'five clean samples are enough for a within-window co-movement — it is a feature'
    + ' value, not a claim; the claim is tested across windows');
  assert.strictEqual(A.windowCorr([1, 2, 3], [2, 4, 6]), null, 'three are not');
  assert.strictEqual(flat['calm.swing'], 0, 'though its swing is genuinely zero');
  // Blank columns must not become series: metrics.csv carries whatever the app was
  // computing, so a score that was off all sit appears as a column of empty strings.
  const keys = A.seriesKeys([{ t: 0, calm: 0.5, hrv: '' }, { t: 1, calm: 0.6, hrv: '' },
    { t: 2, calm: 0.4, hrv: '' }]);
  assert.deepStrictEqual(keys, ['calm'],
    `an empty column is not a series (got ${keys.join(', ')})`);
  // Trios are limited to the named composites on purpose: n-choose-3 over every series
  // would add scores of features and spend the search's power on combinations nobody
  // had a reason to suspect.
  const many = {};
  const rows = [0, 1, 2, 3, 4, 5].map((t) => {
    const r = { t };
    for (const k of ['calm', 'focus', 'thinking', 'drowsy', 'noise', 'hrv', 'breath']) {
      r[k] = Math.sin(t + k.length);
    }
    return r;
  });
  const f = A.windowFeatures(rows);
  const trios = Object.keys(f).filter((k) => k.endsWith('.trio'));
  assert.strictEqual(trios.length, 10,
    `five composite series give C(5,3)=10 trios, not every combination of all seven`
    + ` (got ${trios.length})`);
  assert.ok(!trios.some((k) => /hrv|breath/.test(k)),
    'and hrv/breath are not in the trio set');
  void many;
}

{
  /*
   * THE ONE THAT MATTERS: a shape invisible to a comparison of MEANS is found, and
   * pure noise still produces nothing.
   *
   * calm rises and focus falls across each pre-mark window, with the means held equal
   * by construction. The old search compared means only and would have reported
   * nothing here — so this is the test that the added breadth buys something real.
   */
  const build = (planted, seed) => {
    let x = seed;
    const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const sessions = [];
    for (let s = 0; s < 6; s++) {
      const metrics = [], notes = [], marks = [];
      for (let i = 0; i < 8; i++) marks.push(60 + i * 90);
      for (let t = 0; t < 800; t++) {
        let calm = 0.5 + (rnd() - 0.5) * 0.05;
        let focus = 0.5 + (rnd() - 0.5) * 0.05;
        const near = marks.find((m) => t >= m - 10 && t < m - 2);
        if (planted && near != null) {
          // Symmetric about the window centre, so the MEAN is unchanged and only the
          // shape carries the signal.
          const u = (t - (near - 10) - 3.5) / 8;
          calm += u * 0.30;
          focus -= u * 0.30;
        }
        metrics.push({ t, calm, focus, thinking: 0.4 + (rnd() - 0.5) * 0.05, noise: 0.1 });
      }
      for (const m of marks) notes.push({ offsetSec: m, transition: 'returned' });
      sessions.push({ sessionId: `S${s}`, metrics, notes });
    }
    return sessions;
  };

  const hit = A.search(A.unitsFromMarks(build(true, 4242)), { iterations: 600 });
  const keys = hit.confirmed.map((c) => c.key);
  assert.ok(keys.some((k) => k.startsWith('calm.trend~')),
    `the rising trend must be found (confirmed: ${keys.join(', ') || 'none'})`);
  assert.ok(keys.some((k) => k.startsWith('calm+focus.pair~')),
    `and the two lines moving opposite (confirmed: ${keys.join(', ') || 'none'})`);
  // The level must NOT be among them: it was held constant, and finding it would mean
  // the window boundaries are leaking signal from outside the window.
  assert.ok(!keys.some((k) => k.startsWith('calm.level~')),
    `the MEAN was held equal by construction, so finding it means the windows are`
    + ` picking up rows they should not (confirmed: ${keys.join(', ')})`);

  for (const seed of [11, 22, 33]) {
    const miss = A.search(A.unitsFromMarks(build(false, seed)), { iterations: 600 });
    assert.strictEqual(miss.confirmed.length, 0,
      `pure noise must confirm nothing (seed ${seed} gave`
      + ` ${miss.confirmed.map((c) => c.key).join(', ')})`);
  }
  console.log('✓ marks become windows before the tap, the wider signatures find a shape'
    + ' that means cannot see, and noise still confirms nothing');
}

console.log('\nAll analysis tests passed.');
