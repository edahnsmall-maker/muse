/*
 * Tests for the plain-language layer.
 *
 * The risk being guarded here is the opposite of a crash. Prose makes a weak result
 * sound strong, so these assert that the caveats travel WITH the sentence — the sample
 * size, the size of the search, the held-out check — and that a null result reads as a
 * real answer rather than as an apology.
 *
 * The handoff file is tested for what it REFUSES to let a reader conclude, because a
 * table handed to an AI without guardrails produces confident confabulation, which is
 * the same failure mode as before, relocated to a different reader.
 */
const assert = require('assert');
const F = require('./public/findings.js');
const A = require('./public/analysis.js');

const mkSearch = ({ units = 40, comparisons = 20, train = 7, test = 3, confirmed = [], tests = [] }) => ({
  units, comparisons, confirmed, tests,
  split: { train: Array.from({ length: train }, (_, i) => `s${i}`),
    test: Array.from({ length: test }, (_, i) => `t${i}`) },
});

// 1) NO FINDING WITHOUT ITS EXPOSURE. Every sentence must carry the sample size, the
//    size of the search, and whether it survived the held-out check.
{
  const t = { key: 'hrv~focus', feature: 'hrv', label: 'focus', trainRho: 0.44,
    testRho: 0.38, p: 0.002, q: 0.03, heldUp: true };
  const f = F.describe(t, { units: 40, comparisons: 20, trainSessions: 7, testSessions: 3 });

  // The direction must be in the reader's words, not as the sign of a coefficient.
  assert.match(f.sentence, /higher/, 'a positive relationship must be described as higher');
  assert.match(f.sentence, /one-pointed/, 'in the label’s own language');
  assert.match(f.sentence, /heart-rate variability/, 'and the metric named in English');
  assert.ok(!/rho/.test(f.sentence), 'the headline sentence must not require decoding a coefficient');

  // Exposure, in the sentence itself rather than a footnote.
  assert.match(f.sentence, /40 labelled observations/, 'the sample size must be in the sentence');
  assert.match(f.sentence, /held its direction on 3 session/, 'and the held-out check');
  assert.match(f.evidence, /one of 20 comparisons/,
    'the size of the search must be stated — a finding without it is not a finding');
  assert.strictEqual(f.strength, 'moderate');

  // A negative relationship must read as "lower", against the label's low end.
  const neg = F.describe(Object.assign({}, t, { trainRho: -0.5, testRho: -0.55 }),
    { units: 40, comparisons: 20, trainSessions: 7, testSessions: 3 });
  assert.match(neg.sentence, /lower/);
  assert.match(neg.sentence, /scattered/, 'and name the other end of the scale');
  assert.strictEqual(neg.strength, 'strong');
  console.log('✓ a finding reads as a sentence, with its sample size and search size attached');
}

// 2) A metric whose own validity is doubtful must say so IN the finding. A correlation
//    with an unvalidated score is a correlation with an unvalidated score.
{
  const f = F.describe({ key: 'calm~focus', feature: 'calm', label: 'focus',
    trainRho: 0.4, testRho: 0.35, p: 0.01, q: 0.05, heldUp: true },
    { units: 30, comparisons: 12, trainSessions: 5, testSessions: 2 });
  assert.ok(f.caveat, 'a finding about an unvalidated score must carry that caveat');
  assert.match(f.caveat, /unvalidated/);

  // HRV is a real established measure and must be described as such rather than
  // hedged identically — undifferentiated hedging is as misleading as none.
  const hrv = F.describe({ key: 'hrv~focus', feature: 'hrv', label: 'focus',
    trainRho: 0.4, testRho: 0.35, p: 0.01, q: 0.05, heldUp: true },
    { units: 30, comparisons: 12, trainSessions: 5, testSessions: 2 });
  assert.match(hrv.caveat, /well established/,
    'a genuinely solid measure must not be hedged like a speculative one');

  // The artifact rate is the trap: a correlation there probably means movement.
  const noise = F.describe({ key: 'noise~focus', feature: 'noise', label: 'focus',
    trainRho: -0.5, testRho: -0.45, p: 0.001, q: 0.02, heldUp: true },
    { units: 30, comparisons: 12, trainSessions: 5, testSessions: 2 });
  assert.match(noise.nextStep, /suspicion|movement/i,
    'a correlation with signal quality must be flagged as possibly about movement');
  console.log('✓ findings carry the metric’s own validity, and the artifact trap is flagged');
}

// 3) Every finding must come with a next step, and a trial-derived one must be
//    identified as the stronger kind of evidence.
{
  const fromTrial = F.describe({ key: 'calm~condition', feature: 'calm', label: 'condition',
    trainRho: 0.7, testRho: 0.6, p: 0.001, q: 0.01, heldUp: true },
    { units: 20, comparisons: 8, trainSessions: 4, testSessions: 2 });
  assert.match(fromTrial.nextStep, /set in advance/,
    'a trial result must be identified as the strongest evidence available here');

  const fromSpans = F.describe({ key: 'hrv~effort', feature: 'hrv', label: 'effort',
    trainRho: 0.4, testRho: 0.35, p: 0.01, q: 0.05, heldUp: true },
    { units: 30, comparisons: 12, trainSessions: 5, testSessions: 2 });
  assert.match(fromSpans.nextStep, /effort-contrast/,
    'a finding about effort must point at the trial that manipulates effort');
  assert.match(fromSpans.nextStep, /BEFORE looking/,
    'and require the direction to be predicted first — otherwise it is the same'
    + ' search-and-confirm mistake in a new costume');
  console.log('✓ each finding names the trial that would test it, prediction first');
}

// 4) THE HEADLINES. A null must read as a real answer; too little data must not
//    produce a headline at all.
{
  const nothing = F.report(mkSearch({ units: 40, comparisons: 160, confirmed: [] }));
  assert.strictEqual(nothing.headline.status, 'nothing');
  assert.match(nothing.headline.text, /No pattern found/);
  assert.match(nothing.headline.text, /160 comparisons/, 'with the size of the search');
  assert.match(nothing.headline.text, /expected outcome/,
    'a null must be framed as the expected result, not as a failure');

  const thin = F.report(mkSearch({ units: 4, comparisons: 20 }));
  assert.strictEqual(thin.headline.status, 'not-enough');
  assert.match(thin.headline.text, /Nothing here can mean anything/);

  const solo = F.report(mkSearch({ units: 30, train: 1, test: 0 }));
  assert.strictEqual(solo.headline.status, 'unvalidatable');
  assert.match(solo.headline.text, /nothing could be held back/);

  const found = F.report(mkSearch({
    confirmed: [{ key: 'hrv~focus', feature: 'hrv', label: 'focus', trainRho: 0.4,
      testRho: 0.35, p: 0.01, q: 0.04, heldUp: true }],
  }));
  assert.strictEqual(found.headline.status, 'found');
  assert.match(found.headline.text, /candidates, not/,
    'even a positive headline must refuse the word "conclusion"');
  assert.strictEqual(found.confirmed.length, 1);
  console.log('✓ headlines distinguish nothing-found from not-enough-data from unvalidatable');
}

// 5) FAILURES ARE REPORTED. A report of successes only makes the survivors look
//    inevitable rather than lucky.
{
  const rep = F.report(mkSearch({
    tests: [
      { key: 'a~focus', feature: 'calm', label: 'focus', trainRho: 0.6, testRho: -0.1,
        p: 0.001, q: 0.02, passes: true, heldUp: false },
      { key: 'b~tone', feature: 'drowsy', label: 'tone', trainRho: 0.1, testRho: 0.05,
        p: 0.6, q: 0.9, passes: false, heldUp: false },
    ],
  }));
  assert.strictEqual(rep.collapsed.length, 1,
    'only things that PASSED correction and then failed held-out belong in the collapsed list');
  assert.match(rep.collapsed[0].sentence, /check working/,
    'a collapse must be framed as the validation working, not as a near miss');
  console.log('✓ promising-then-collapsed results are reported as the check working');
}

// 6) THE HANDOFF FILE must lead with what the data cannot support.
{
  const rep = F.report(mkSearch({
    confirmed: [{ key: 'hrv~focus', feature: 'hrv', label: 'focus', trainRho: 0.44,
      testRho: 0.38, p: 0.002, q: 0.03, heldUp: true }],
  }));
  const md = F.handoff([{ title: 'Hand-labelled spans', report: rep }], {
    sessions: [{ name: 'a.zip', minutes: 20, spans: 4, transitions: 6, blocks: 0 }],
  });

  // The refusals, before any finding.
  const firstFinding = md.indexOf('hrv');
  const cannotSupport = md.indexOf('cannot support');
  assert.ok(cannotSupport > 0 && cannotSupport < firstFinding,
    'the limits must appear BEFORE the findings, or a reader meets the numbers first');
  for (const must of ['Causal claims', 'people in general', 'Clinical', 'single session']) {
    assert.ok(md.includes(must), `the handoff must rule out ${must}`);
  }
  // It must invite a null answer, or it is asking to be told something.
  assert.match(md, /too weak to be worth interpreting/,
    'the file must explicitly invite "this is too weak to interpret" as a useful answer');
  // The method has to be described, or a reader cannot judge the numbers.
  assert.match(md, /by session, never by sample/);
  assert.match(md, /ONE observation, not one per second/i);
  // And it must say what happens to the answer, so a wrong suggestion is cheap.
  assert.match(md, /wasted trial rather than a false number/);
  // Sessions table, so exposure is visible at a glance.
  assert.match(md, /\| a\.zip \| 20 min \| 4 \| 6 \| 0 \|/);
  // Small enough for any context: findings only, never the raw signal.
  assert.ok(md.length < 20000, `the handoff must stay small (got ${md.length} bytes)`);
  assert.ok(!/[0-9]\.[0-9]{6,}/.test(md), 'no raw sample dumps');
  console.log(`✓ the handoff leads with its limits, describes the method, and is ${md.length} bytes`);
}

// 7) A FAILED EQUIPMENT CONTROL must void the file, loudly, and tell the reader to say
//    so rather than interpret the findings above it.
{
  const rep = F.report(mkSearch({
    confirmed: [{ key: 'calm~focus', feature: 'calm', label: 'focus', trainRho: 0.5,
      testRho: 0.45, p: 0.001, q: 0.01, heldUp: true }],
  }));
  const bad = F.handoff([{ title: 'Trial', report: rep,
    controls: [{ feature: 'calm', ok: false, text: 'no eyes-closed alpha difference' }] }]);
  assert.match(bad, /control FAILED/i);
  assert.match(bad, /treated as void/,
    'a failed control must void the rest of the file explicitly');
  assert.match(bad, /Please say so rather than interpreting/,
    'and instruct the reader not to interpret the findings anyway');

  const good = F.handoff([{ title: 'Trial', report: rep,
    controls: [{ feature: 'calm', ok: true, text: 'clear eyes-closed alpha rise' }] }]);
  assert.match(good, /PASSED/);
  assert.ok(!/treated as void/.test(good), 'a passing control must not void anything');
  console.log('✓ a failed equipment control voids the handoff and says not to interpret it');
}

// 8) End to end, from a real search over planted data: the prose must match the maths.
{
  const rnd = A.seededRandom(88);
  const units = [];
  for (let s = 0; s < 10; s++) {
    for (let u = 0; u < 4; u++) {
      const focus = 1 + Math.floor(rnd() * 5);
      units.push({
        sessionId: `s${s}`,
        // Planted NEGATIVE: hrv falls as focus rises. The prose must say "lower".
        features: { hrv: 1 - focus * 0.15 + (rnd() - 0.5) * 0.12, junk: rnd() },
        labels: { focus },
      });
    }
  }
  const res = A.search(units, { iterations: 400 });
  const rep = F.report(res);
  assert.strictEqual(rep.headline.status, 'found');
  const hrv = rep.confirmed.find((f) => f.feature === 'hrv');
  assert.ok(hrv, `the planted relationship must appear in the prose (got ${rep.confirmed.map((f) => f.feature).join(', ') || 'none'})`);
  assert.match(hrv.sentence, /lower/,
    'a planted NEGATIVE relationship must be described as lower, not higher');
  assert.match(hrv.sentence, /scattered/, 'against the low end of the label');
  assert.match(hrv.evidence, new RegExp(`one of ${res.comparisons} comparisons`));
  console.log(`✓ end to end: a planted negative relationship reads as "${hrv.sentence.slice(0, 62)}…"`);
}

console.log('\nAll findings tests passed.');
