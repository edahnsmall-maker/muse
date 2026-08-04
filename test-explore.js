/*
 * Tests for explore.js — the lab's plain-language layer.
 *
 * WHAT THESE ARE FOR. This module exists to answer a practitioner's question in sentences, which makes
 * it the most dangerous file in the project: a wrong number in the search results is a wrong number,
 * while a wrong SENTENCE is a belief. So the tests are weighted towards the ways it could overclaim.
 *
 * Four failure modes, each with a test that would catch it:
 *
 *   1. Manufacturing agreement by pooling — one sit with many marks outvoting several sits.
 *   2. Reporting a direction with no size behind it, so measurement noise reads as a finding.
 *   3. Calling a coin toss a pattern: half the sits agreeing is what chance produces.
 *   4. Saying "no effect" when the truth is "not enough data", which are opposite conclusions.
 */
const assert = require('assert');
const Explore = require('./public/explore.js');

// A sit where the signal really is higher near the marks.
function sitWithEffect(id, { marks, lift = 3, noise = 0.2, seconds = 300, key = 'calmAbs' }) {
  let seed = id.length * 977 + 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const rows = [];
  for (let t = 0; t < seconds; t++) {
    const near = marks.some((m) => t >= m - 20 && t <= m);
    const row = { t };
    row[key] = 30 + (near ? lift : 0) + noise * rnd() * 10;
    rows.push(row);
  }
  return { id, label: id, rows };
}

/* 1) ONE SIT CANNOT OUTVOTE SEVERAL.
 *    The whole reason the headline is a count of sessions rather than a p-value over pooled marks: a
 *    single sit with forty marks and a strong effect must not produce the same answer as five sits that
 *    each show it. Tested by giving one sit an overwhelming effect and many marks, and the rest none.
 */
{
  const loud = sitWithEffect('loud', { marks: Array.from({ length: 40 }, (_, i) => 25 + i * 6), lift: 20 });
  const quiet = [1, 2, 3, 4].map((i) => sitWithEffect(`quiet${i}`, {
    marks: [40, 100, 160, 220], lift: 0,
  }));
  const sessions = [loud].concat(quiet);
  const markTimes = { loud: loud.rows.length ? Array.from({ length: 40 }, (_, i) => 25 + i * 6) : [] };
  for (const q of quiet) markTimes[q.id] = [40, 100, 160, 220];
  const a = Explore.askAcrossSessions(sessions, {
    signalKey: 'calmAbs', markTimes, window: { preSec: 20, postSec: 0 },
  });
  assert.strictEqual(a.sessionsAnswered, 5, 'all five sits must get a vote');
  assert.strictEqual(a.agree <= 2, true,
    `one loud sit must not carry the answer (agree=${a.agree} of ${a.sessionsAnswered})`);
  assert.notStrictEqual(a.strength.key, 'repeats',
    'and the badge must not read as a repeating pattern on the strength of one sit');
  console.log(`✓ one sit with 40 marks and a huge effect cannot outvote four that show none`
    + ` (${a.agree}/${a.sessionsAnswered}, "${a.strength.label}")`);
}

/* 2) A REAL, REPEATED EFFECT IS FOUND AND CALLED WHAT IT IS.
 *    The positive control. If this module cannot see an effect present in every sit, its silence
 *    elsewhere means nothing.
 */
{
  const marks = [40, 90, 140, 190, 240];
  const sessions = [1, 2, 3, 4, 5, 6].map((i) => sitWithEffect(`s${i}`, { marks, lift: 4 }));
  const markTimes = {};
  for (const s of sessions) markTimes[s.id] = marks;
  const a = Explore.askAcrossSessions(sessions, {
    signalKey: 'calmAbs', markTimes, window: { preSec: 20, postSec: 0 },
  });
  assert.strictEqual(a.direction, 1, 'the direction must be up, as constructed');
  assert.strictEqual(a.agree, 6, `all six sits must see it (got ${a.agree})`);
  assert.strictEqual(a.strength.key, 'repeats', `and the badge must say it repeats (${a.strength.label})`);
  const sentence = Explore.describe(a, { experience: 'Thinking' });
  assert.match(sentence, /higher/, 'the sentence must name the direction');
  assert.match(sentence, /Thinking/, 'and the experience asked about');
  assert.match(sentence, /\d of \d sessions/, 'and carry the count, which is the actual evidence');
  console.log(`✓ a real repeated effect is found and described: "${sentence}"`);
}

/* 3) A COIN TOSS IS NOT A PATTERN.
 *    Half the sits going each way is exactly what no effect looks like, and it is the most likely thing
 *    to be mistaken for a finding, because a majority of one feels like evidence.
 */
{
  const marks = [40, 90, 140, 190, 240];
  const sessions = [];
  const markTimes = {};
  for (let i = 0; i < 6; i++) {
    // Alternating sign: three sits up, three down.
    const s = sitWithEffect(`c${i}`, { marks, lift: i % 2 === 0 ? 4 : -4 });
    sessions.push(s);
    markTimes[s.id] = marks;
  }
  const a = Explore.askAcrossSessions(sessions, {
    signalKey: 'calmAbs', markTimes, window: { preSec: 20, postSec: 0 },
  });
  assert.strictEqual(a.up, 3, 'three up');
  assert.strictEqual(a.down, 3, 'three down');
  assert.strictEqual(a.direction, 0,
    'a tie must report NO direction — naming one of two equal counts is how a null becomes a finding');
  assert.strictEqual(a.strength.key, 'unclear', `and the badge must say unclear (${a.strength.label})`);
  assert.match(Explore.describe(a, { experience: 'Thinking' }), /no consistent pattern/,
    'said plainly, in the sentence, not left to be inferred from a number');
  console.log('✓ three sits each way reports no direction and reads as "no consistent pattern"');
}

/* 4) "NOT ENOUGH DATA" AND "NO EFFECT" MUST NEVER BE THE SAME SENTENCE.
 *    They lead to opposite actions — collect more, or stop looking — and conflating them is the single
 *    most consequential thing a screen like this can get wrong. Two sits agreeing perfectly must still
 *    read as insufficient.
 */
{
  const marks = [40, 90, 140, 190, 240];
  const sessions = [1, 2].map((i) => sitWithEffect(`t${i}`, { marks, lift: 6 }));
  const markTimes = {};
  for (const s of sessions) markTimes[s.id] = marks;
  const a = Explore.askAcrossSessions(sessions, {
    signalKey: 'calmAbs', markTimes, window: { preSec: 20, postSec: 0 },
  });
  assert.strictEqual(a.agree, 2, 'both sits do show it');
  assert.strictEqual(a.strength.key, 'insufficient',
    'but two agreeing sits is a coin landing the same way twice, and must not read as a pattern');
  const s = Explore.describe(a);
  assert.match(s, /Not enough/, 'the sentence must say there is not enough, not that there is nothing');
  assert.doesNotMatch(s, /no consistent pattern|no difference/,
    'and must never be phrased as an absence of effect');
  assert.match(Explore.nextStep([a], sessions), /more/i,
    'and the next step must be to collect more, not to conclude');
  console.log('✓ two agreeing sits reads "not enough", never "no effect", and points at more data');
}

/* 5) A DIRECTION REQUIRES A SIZE. A difference far below the sit's own variation is where you looked,
 *    not what happened, and reporting its sign would turn noise into a finding one sit at a time.
 */
{
  const marks = [40, 90, 140, 190, 240];
  // A tiny lift against large noise: real in the fixture, invisible against the sit's own spread.
  const s = sitWithEffect('tiny', { marks, lift: 0.05, noise: 2 });
  const v = Explore.sessionVote(s.rows, marks, 'calmAbs', { preSec: 20, postSec: 0 });
  assert.strictEqual(v.known, true, 'the sit can be evaluated');
  assert.strictEqual(v.direction, 0,
    `an effect of ${v.effect.toFixed(3)} sd must not be given a direction (floor ${Explore.MIN_EFFECT})`);
  assert.ok(Math.abs(v.effect) < Explore.MIN_EFFECT, 'and the measured effect must be below the floor');
  // While a clear one does get a direction, or the floor would simply be a mute button.
  const big = sitWithEffect('big', { marks, lift: 6, noise: 0.2 });
  assert.strictEqual(Explore.sessionVote(big.rows, marks, 'calmAbs', { preSec: 20, postSec: 0 }).direction, 1,
    'a clear effect must still be reported');
  console.log('✓ a difference below a fifth of the sit’s own spread gets no direction; a clear one does');
}

/* 6) EVERY REFUSAL SAYS WHY, IN WORDS THE READER CAN ACT ON.
 *    A blank panel is how the lab became unusable in the first place: the reader cannot tell a missing
 *    sensor from too few marks from a bug, and those have three different fixes.
 */
{
  const marks = [40, 90, 140];
  const rows = Array.from({ length: 200 }, (_, t) => ({ t, calmAbs: 30 }));
  // No readings for that signal at all.
  const noSig = Explore.sessionVote(rows, marks, 'breathPerMin', {});
  assert.strictEqual(noSig.known, false);
  assert.match(noSig.reason, /no readings/, 'a missing signal must say so');
  // Too few marks.
  const fewMarks = Explore.sessionVote(rows, [40], 'calmAbs', {});
  assert.strictEqual(fewMarks.known, false);
  assert.match(fewMarks.reason, /marks/, 'too few marks must say so, and say how many are needed');
  assert.match(fewMarks.reason, new RegExp(String(Explore.MIN_MARKS_PER_SESSION)),
    'naming the actual threshold rather than "not enough"');
  // A signal that never moves: no difference can exist, which is not the same as none being found.
  const flat = Explore.sessionVote(rows, marks, 'calmAbs', { preSec: 20, postSec: 0 });
  assert.strictEqual(flat.known, false);
  assert.match(flat.reason, /never changed/, 'a constant signal must be named as such');
  /* And a window covering the whole sit. With marks every 20s and a 20s window there is nothing left
     outside, and the comparison silently becomes the sit against itself. */
  const dense = Array.from({ length: 40 }, (_, i) => i * 10);
  const wide = Explore.sessionVote(rows, dense, 'calmAbs', { preSec: 20, postSec: 20 });
  assert.strictEqual(wide.known, false, 'a window that covers everything cannot be a comparison');
  assert.match(wide.reason, /nothing left to compare/, 'and must say that, rather than returning zero');
  console.log('✓ every refusal names its own cause: missing signal, too few marks, flat signal,'
    + ' window covering the sit');
}

/* 7) THE SIGNALS DECLARE WHETHER THEY CAN BE COMPARED BETWEEN SITS.
 *    Measured on seven real recordings: the normalised calm score spanned 42-53 across ALL of them
 *    while the underlying physiology spanned more than twofold, and their rank correlation was -0.32.
 *    Anything rescaled within a sit is meaningless across sits, and a screen offering it for a
 *    whole-session question would be inviting exactly that error.
 */
{
  const relative = Explore.SIGNALS.filter((s) => !s.comparable).map((s) => s.key);
  assert.ok(relative.includes('calm'),
    'the normalised calm score must be marked as NOT comparable between sits');
  assert.ok(relative.includes('thinking'), 'and so must thinking');
  for (const s of Explore.SIGNALS.filter((x) => !x.comparable)) {
    assert.match(s.caveat, /CANNOT be compared/,
      `${s.key} must say plainly that it cannot be compared between sits`);
  }
  for (const s of Explore.SIGNALS) {
    assert.ok(s.plain && s.plain.length > 10, `${s.key} needs a plain-language description`);
    assert.ok(s.caveat && s.caveat.length > 20, `${s.key} needs a real caveat`);
  }
  // The strap-dependent ones must say so, since a sit without one produces nothing and the reader
  // would otherwise read absence as a null result.
  for (const k of ['breathPerMin', 'hrvMs', 'hrBpm']) {
    assert.match(Explore.SIGNAL_BY_KEY[k].caveat, /chest strap/,
      `${k} must say it needs the strap`);
  }
  console.log(`✓ all ${Explore.SIGNALS.length} signals carry a plain description, a real caveat, and`
    + ' declare whether they survive a comparison between sits');
}

// 8) NO CONFIDENCE PERCENTAGE, ANYWHERE. There is no model here and no basis for one.
{
  const src = Explore.strengthOf.toString() + Explore.describe.toString();
  assert.doesNotMatch(src, /confidence/i,
    'nothing here may report a confidence — a percentage implies a calibration that does not exist');
  const badges = [
    Explore.strengthOf(1, 1, 1), Explore.strengthOf(8, 7, 8),
    Explore.strengthOf(8, 4, 8), Explore.strengthOf(8, 1, 8),
  ];
  for (const b of badges) {
    assert.doesNotMatch(b.label, /%/, `badge "${b.label}" must not carry a percentage`);
    assert.ok(b.why && b.why.length > 20, `badge "${b.label}" must explain itself`);
  }
  assert.strictEqual(badges[1].key, 'repeats', '7 of 8 repeats');
  assert.strictEqual(badges[2].key, 'possible', '4 of 8 is possible at best');
  assert.strictEqual(badges[3].key, 'unclear', '1 of 8 is unclear');
  console.log('✓ badges are counts with words, never percentages, and each explains its own basis');
}

console.log('\nAll explore tests passed.');
