/*
 * Tests for the labelling protocol.
 *
 * The properties under test are methodological. A probe schedule that is predictable,
 * a window that includes the act of answering, or an event average with no null — each
 * of those produces data that looks fine and means something other than what it says.
 */
const assert = require('assert');
const P = require('./public/probes.js');
const A = require('./public/analysis.js');

// 1) The response set must be answerable in one tap, and must keep the aware/unaware
//    distinction — the one thing probes are uniquely for.
{
  assert.ok(P.RESPONSES.length >= 4 && P.RESPONSES.length <= 6,
    `a probe must be answerable without reading: ${P.RESPONSES.length} options is too many`);
  const kbds = P.RESPONSES.map((r) => r.kbd);
  assert.strictEqual(new Set(kbds).size, kbds.length, 'no two responses may share a key');
  for (const r of P.RESPONSES) {
    assert.match(r.kbd, /^[1-9]$/, `${r.key} must be a digit — reachable without looking`);
    assert.strictEqual(typeof r.onTask, 'boolean', `${r.key} must state whether it is on-task`);
    assert.strictEqual(typeof r.aware, 'boolean', `${r.key} must state whether you knew`);
    assert.ok(r.hint && r.hint.length > 10);
  }
  // THE distinction: off-task-and-knew versus off-task-and-didn't. Collapsing these
  // would throw away the only state self-caught marking can never sample.
  const aware = P.RESPONSES.find((r) => !r.onTask && r.aware);
  const unaware = P.RESPONSES.find((r) => !r.onTask && !r.aware);
  assert.ok(aware && unaware,
    'both aware and unaware off-task responses must exist, or meta-awareness is unmeasurable');
  // And a state that is neither focused nor thinking, which a single axis cannot hold.
  assert.ok(P.RESPONSES.some((r) => r.key === 'dull'),
    'dull/blank must be its own answer — it is neither on-task nor thinking, and an'
    + ' alpha-based calm score may well score it highly');
  console.log(`✓ ${P.RESPONSES.length} one-tap responses, keeping aware/unaware apart`);
}

// 2) Armed tap categories: one key, one meaning, optional grade.
{
  /* PRIMARY categories — the ones with a letter. A category reached by a GESTURE instead (deep
     thinking, via a double-tap of Thinking) deliberately has no letter, and is checked separately
     below. Splitting the invariant rather than weakening it: "one key, one meaning" still has to hold
     for everything that is pressed, and "no key at all" has to hold for everything that is not. */
  const kbds = P.PRIMARY_TAP_CATEGORIES.map((t) => t.kbd);
  assert.strictEqual(new Set(kbds).size, kbds.length, 'tap keys must be distinct');
  for (const t of P.PRIMARY_TAP_CATEGORIES) {
    assert.match(t.kbd, /^[A-Z]$/, `${t.key} must be a single letter`);
    if (t.grades) {
      assert.ok(t.grades.length >= 2, `${t.key} grades must offer a real choice`);
      for (const g of t.grades) {
        assert.ok(Number.isInteger(g.value) && g.value >= 1);
        assert.ok(g.label && g.hint, `${t.key} grade ${g.value} needs a label and a hint`);
      }
    }
  }
  /* THE PAIR THAT EARNS THE VOCABULARY ITS KEEP: the same degree of focus with and
   * without effort. A single focus score cannot separate these, which is the whole
   * reason effort is a distinct axis — and having both as one-key marks means the
   * moment of crossing between them is recordable. */
  /* Every gesture-reached category must have NO letter and must name a parent that exists. A
     double-tap whose parent was renamed would be unreachable while still appearing in every
     vocabulary list — the sort of dangling reference that reads as a category nobody ever presses. */
  for (const t of P.TAP_CATEGORIES.filter((x) => x.viaDoubleTap)) {
    assert.strictEqual(t.kbd, null, `${t.key} is reached by a gesture and must have no letter`);
    assert.ok(P.TAP_BY_KEY[t.viaDoubleTap],
      `${t.key} double-taps ${t.viaDoubleTap}, which is not a category`);
    assert.ok(!P.TAP_BY_KEY[t.viaDoubleTap].viaDoubleTap,
      `${t.key} must double-tap a real key, not another gesture`);
  }

  assert.ok(P.TAP_BY_KEY.concentrating && P.TAP_BY_KEY.absorbed,
    'effortful and effortless concentration must both be markable, and separately');
  assert.match(P.TAP_BY_KEY.absorbed.hint, /holding itself|no work/,
    'and the effortless one must say what makes it different');

  // Two different returns: to the object, and to not-working-at-it.
  assert.ok(P.TAP_BY_KEY.returned && P.TAP_BY_KEY['returned-effortless'],
    'returning to the breath and returning to effortlessness are different acts');
  assert.notStrictEqual(P.TAP_BY_KEY.returned.kbd, P.TAP_BY_KEY['returned-effortless'].kbd);

  /* KENSHO AND SATORI must be recordable and must NOT be presented as detectable.
   * They will be far too rare to analyse for years, and the hint has to say that the
   * mark is a report rather than a measurement — otherwise the rarest, most
   * over-interpretable label in the set arrives with no warning attached. */
  for (const k of ['kensho', 'satori']) {
    const t = P.TAP_BY_KEY[k];
    assert.ok(t, `${k} must be markable`);
    assert.match(t.hint, /never inferred|not a measurement|rare/i,
      `${k}'s hint must make clear it is a report, not something the app detects`);
  }
  // The graded one, where the grade is a real distinction rather than decoration.
  const restless = P.TAP_BY_KEY.restless;
  assert.ok(restless.grades && restless.grades.length === 2,
    'restlessness has degrees worth telling apart');
  /* Keys must not collide with the app's existing bindings.
   *
   * T came OFF this list: it is now `lost` / "Thinking", which is the most-pressed
   * category by a distance and should match the word you say to yourself. Training moved
   * to Shift+T — a once-per-sit action can afford a modifier, a mid-sit tap cannot. */
  for (const taken of ['M', 'N', 'V', 'F']) {
    assert.ok(!kbds.includes(taken), `${taken} is already bound elsewhere`);
  }
  console.log(`✓ ${P.TAP_CATEGORIES.length} armed tap categories with grades: ${kbds.join(' ')}`);
}

// 3) THE SCHEDULE MUST BE UNPREDICTABLE. A cue every two minutes exactly is a cue you
//    wait for, and waiting is a different state from the one being sampled.
{
  const times = P.schedule(1800, { seed: 3 });
  assert.ok(times.length >= 6, `a 30-minute sit should get several probes (got ${times.length})`);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(new Set(gaps).size > 1, 'gaps must VARY — a fixed interval is anticipated');
  for (const g of gaps) {
    assert.ok(g >= P.DEFAULTS.minGapSec, `no two probes closer than ${P.DEFAULTS.minGapSec}s (got ${g})`);
    assert.ok(g <= P.DEFAULTS.maxGapSec + 1, `and none further than ${P.DEFAULTS.maxGapSec}s (got ${g})`);
  }
  assert.ok(times[0] >= P.DEFAULTS.firstGapSec, 'time to settle before the first probe');
  // Nothing so late that the post-probe exclusion runs off the end of the sit.
  assert.ok(times[times.length - 1] <= 1800 - P.DEFAULTS.postExcludeSec);

  // Reproducible from the seed, so the schedule can be exported and re-derived —
  // which is what lets a MISSED probe be told apart from one never scheduled.
  assert.deepStrictEqual(P.schedule(1800, { seed: 3 }), times);
  assert.notDeepStrictEqual(P.schedule(1800, { seed: 4 }), times);
  // A sit too short for any probe gets none, rather than one crammed in.
  assert.deepStrictEqual(P.schedule(30, {}), []);
  console.log(`✓ ${times.length} probes over 30 min, gaps ${Math.min(...gaps)}-${Math.max(...gaps)}s, jittered and reproducible`);
}

// 4) dueProbe fires once per scheduled time, in order.
{
  const times = [100, 250, 400];
  assert.strictEqual(P.dueProbe(times, 0, 50), null, 'not yet');
  assert.strictEqual(P.dueProbe(times, 0, 100).index, 0, 'due exactly on time');
  assert.strictEqual(P.dueProbe(times, 0, 180).index, 0, 'still due if the tick was late');
  assert.strictEqual(P.dueProbe(times, 1, 180), null, 'answered, so not due again');
  assert.strictEqual(P.dueProbe(times, 3, 9999), null, 'all answered, none left');
  console.log('✓ probes come due once each, in order, and survive a late tick');
}

// 5) THE WINDOW IS BEFORE THE PROBE, and the seconds after are excluded — answering is
//    a deliberate act and would otherwise be mixed into the state it describes.
{
  const w = P.windowFor(300, {});
  assert.strictEqual(w.toSec, 300, 'the window ENDS at the probe');
  assert.strictEqual(w.fromSec, 300 - P.DEFAULTS.preWindowSec);
  assert.ok(w.fromSec < w.toSec);

  // Two probes close together must not both claim the same seconds — double-counting a
  // stretch would make two observations out of one piece of evidence.
  const tight = P.windowFor(300, { prevProbeAtSec: 290 });
  assert.strictEqual(tight, null,
    'a window squeezed by the previous probe’s exclusion must be refused, not shrunk'
    + ' to a second and reported as a 30-second state');
  // Far enough apart that the pre-window fits whole: 360 - 30 = 330, and the previous
  // exclusion only reaches 320, so nothing is clamped.
  const roomy = P.windowFor(360, { prevProbeAtSec: 300 });
  assert.strictEqual(roomy.fromSec, 330, 'an unobstructed window is the full pre-window');
  // Close enough that the previous exclusion DOES bite: 320 + 20 = 340 > 330.
  const clamped = P.windowFor(360, { prevProbeAtSec: 320 });
  assert.strictEqual(clamped.fromSec, 340,
    'bounded below by the previous probe’s exclusion, so no second is counted twice');
  assert.ok(clamped.toSec - clamped.fromSec >= 8, 'and still long enough to mean something');
  // A probe near the start clamps at zero rather than going negative.
  assert.strictEqual(P.windowFor(20, {}).fromSec, 0);
  console.log('✓ the labelled window precedes the probe, and never overlaps the last one');
}

// 6) unitsFromProbes: two labels from one tap, latency as a FEATURE not a label.
{
  const metrics = [];
  for (let t = 0; t < 600; t++) metrics.push({ t, calm: t < 300 ? 0.8 : 0.2, epochMs: t });
  const answers = [
    { atSec: 200, response: 'on', latencySec: 1.2 },
    { atSec: 400, response: 'unaware-off', latencySec: 6.5 },
    { atSec: 500, response: 'dull', latencySec: 2.0 },
    { atSec: 505, response: 'on', latencySec: 1.0 },        // too close: must be dropped
    { atSec: 550, response: 'nonsense' },                    // unknown: must be dropped
  ];
  const units = P.unitsFromProbes(answers, metrics, { sessionId: 's1' });
  assert.strictEqual(units.length, 3,
    `overlapping and unknown answers must be dropped (got ${units.length})`);
  assert.ok(units.every((u) => u.sessionId === 's1'));

  const on = units.find((u) => u.response === 'on');
  assert.deepStrictEqual(on.labels, { onTask: 1, aware: 1 });
  const lost = units.find((u) => u.response === 'unaware-off');
  assert.deepStrictEqual(lost.labels, { onTask: 0, aware: 0 },
    'off-task and unaware must be TWO labels, or the distinction is lost');
  const dull = units.find((u) => u.response === 'dull');
  assert.deepStrictEqual(dull.labels, { onTask: 0, aware: 1 },
    'dull is off-task but aware — neither focused nor lost in thought');

  // Latency is behaviour, not self-report, so it belongs with the measurements.
  assert.strictEqual(lost.features.probeLatency, 6.5);
  assert.ok(!('probeLatency' in lost.labels), 'latency must not become a label');
  // Features come from the pre-window only.
  assert.ok(on.features.calm > 0.7, 'a probe at 200s must average the 0.8 stretch');
  assert.ok(lost.features.calm < 0.3, 'and one at 400s the 0.2 stretch');
  console.log('✓ one tap yields two labels, latency is a feature, overlaps are dropped');
}

// 7) The meta-awareness gap, and its refusal to be computed from too little.
{
  const answers = [
    { atSec: 100, response: 'on' }, { atSec: 250, response: 'unaware-off' },
    { atSec: 400, response: 'unaware-off' }, { atSec: 550, response: 'aware-off' },
    { atSec: 700, response: 'on' }, { atSec: 850, response: 'unaware-off' },
  ];
  const gap = P.metaAwarenessGap({ answers, selfCaughtCount: 2, durationSec: 1200 });
  assert.strictEqual(gap.ok, true);
  assert.strictEqual(gap.probes, 6);
  assert.ok(Math.abs(gap.offFraction - 4 / 6) < 1e-9, 'four of six probes were off-task');
  assert.ok(Math.abs(gap.unawareFraction - 3 / 6) < 1e-9, 'three of six were unaware');
  assert.ok(gap.minutesOff > 10 && gap.minutesOff < 15, 'two thirds of 20 minutes');
  assert.ok(gap.selfCaughtPerMinuteOff > 0 && gap.selfCaughtPerMinuteOff < 1,
    'two catches across ~13 minutes off is a low catch rate');
  assert.match(gap.note, /meta-awareness/,
    'the number must be framed as being about awareness, not concentration');

  // Refused below five probes: a proportion from three samples is not a proportion.
  const thin = P.metaAwarenessGap({ answers: answers.slice(0, 3), selfCaughtCount: 1, durationSec: 600 });
  assert.strictEqual(thin.ok, false);
  assert.match(thin.reason, /fewer than 5/);
  assert.strictEqual(P.metaAwarenessGap({ answers, selfCaughtCount: 0 }).ok, false,
    'without a session length there is no proportion of time to report');
  console.log('✓ the meta-awareness gap is computed from both label types, and refused when thin');
}

// 8) EVENT-LOCKED AVERAGING. A planted response around marks must be recovered, and
//    NOISE MUST PRODUCE NOTHING — averaging enough windows of anything gives a smooth
//    curve that looks like a result.
{
  const rnd = A.seededRandom(31);
  const build = (planted) => {
    const series = {};
    const events = [];
    for (let s = 0; s < 5; s++) {
      const sid = `s${s}`;
      const rows = [];
      for (let t = 0; t < 900; t++) {
        // Slow drift across the sit, which a per-event baseline must remove — otherwise
        // it dominates the average and produces a confident shape meaning "time passed".
        rows.push({ t, calm: 0.5 + t / 3000 + (rnd() - 0.5) * 0.1 });
      }
      const marks = [120, 300, 480, 660, 800];
      for (const m of marks) {
        events.push({ sessionId: sid, tSec: m });
        if (!planted) continue;
        // A dip just before the mark and a rise just after — what "noticing you were
        // gone, then coming back" might plausibly look like.
        for (let t = m - 8; t < m; t++) if (rows[t]) rows[t].calm -= 0.12;
        for (let t = m; t < m + 6; t++) if (rows[t]) rows[t].calm += 0.12;
      }
      series[sid] = rows;
    }
    return { series, events };
  };

  const planted = build(true);
  const hit = A.eventLockedTest(planted.events, planted.series,
    { feature: 'calm', preSec: 20, postSec: 10, baselineSec: 8, seed: 9, surrogates: 150 });
  assert.strictEqual(hit.real.events, 25, 'all 25 marks must be usable');
  assert.ok(hit.peak, 'a peak must be located');
  assert.strictEqual(hit.peak.clear, true,
    `a planted response must rise clear of random times (real ${hit.peak.real}, surrogate ${hit.peak.surrogate})`);
  assert.match(hit.verdict, /Worth testing/, 'and be framed as worth testing, not as proven');

  const noise = build(false);
  const miss = A.eventLockedTest(noise.events, noise.series,
    { feature: 'calm', preSec: 20, postSec: 10, baselineSec: 8, seed: 9, surrogates: 150 });
  assert.strictEqual(miss.peak.clear, false,
    `marks with no real response must NOT clear the null (real ${miss.peak.real}, p ${miss.p})`);
  assert.match(miss.verdict, /nothing rises clear/,
    'and must say so plainly rather than showing a curve and leaving it to be read');

  // The drift must be removed by the baseline, not left to masquerade as a response.
  const noBaseline = A.eventLocked(noise.events, noise.series,
    { feature: 'calm', preSec: 20, postSec: 10, baselineSec: 8 });
  assert.ok(Math.abs(noBaseline.mean[0]) < 0.05,
    'the first bin is the baseline, so it must sit near zero after subtraction');

  // Too few events must refuse rather than report a shape from three instances.
  const thin = A.eventLockedTest(planted.events.slice(0, 3), planted.series, { feature: 'calm' });
  assert.strictEqual(thin.peak, null);
  assert.match(thin.verdict, /need at least/);
  console.log(`✓ event-locked averaging finds a planted response (${hit.peak.real.toFixed(3)}`
    + ` at ${hit.peak.atSec}s, p ${hit.p.toFixed(3)}) and rejects noise (p ${miss.p.toFixed(3)})`);
}

/*
 * DOUBLE-TAP THINKING = DEEP THINKING.
 *
 * The property that matters is that the second press REPLACES the first. Two marks 400ms apart
 * recorded as two separate returns to thinking is a count this dataset cannot afford to get wrong:
 * the marks-versus-marks comparison in explore.js is built entirely on counts, so one event reported
 * as two inflates exactly the number the comparison rests on.
 */
{
  const T = P.TAP_BY_KBD.T;
  assert.ok(T && T.key === 'lost', 'T must still be Thinking');
  const deep = P.TAP_BY_KEY['deep-thinking'];
  assert.ok(deep, 'there must be a deep-thinking category');
  assert.strictEqual(deep.viaDoubleTap, 'lost', 'reached by double-tapping Thinking');

  // A single tap is a single tap.
  const once = P.doubleTap('lost', { lastKey: null, lastAt: null, at: 10000 });
  assert.strictEqual(once.category, 'lost', 'one press is Thinking');
  assert.strictEqual(once.upgraded, false);
  assert.strictEqual(once.replaces, null, 'and replaces nothing');

  // Two inside the window become ONE deep-thinking mark, and say which mark to remove.
  const twice = P.doubleTap('lost', { lastKey: 'lost', lastAt: 10000, lastId: 42, at: 10400 });
  assert.strictEqual(twice.category, 'deep-thinking', 'two quick presses are deep thinking');
  assert.strictEqual(twice.upgraded, true);
  assert.strictEqual(twice.replaces, 42, 'and the first mark must be named for removal');

  // Outside the window they are two separate notices, which is the honest reading.
  const slow = P.doubleTap('lost', {
    lastKey: 'lost', lastAt: 10000, lastId: 42, at: 10000 + P.DOUBLE_TAP_MS + 1 });
  assert.strictEqual(slow.category, 'lost', 'a slow second press is a second Thinking mark');
  assert.strictEqual(slow.replaces, null, 'and must not delete the first');

  // Exactly at the boundary counts as a double-tap, so the window is inclusive and stated.
  assert.strictEqual(P.doubleTap('lost', {
    lastKey: 'lost', lastAt: 0, lastId: 1, at: P.DOUBLE_TAP_MS }).upgraded, true,
    'the window is inclusive at its edge');

  // A different category in between does not upgrade.
  assert.strictEqual(P.doubleTap('lost', {
    lastKey: 'returned', lastAt: 10000, lastId: 7, at: 10100 }).upgraded, false,
    'a different mark in between breaks the gesture');

  // NO CLIMBING. A third press must not upgrade deep thinking to something else, and holding the key
  // down must not manufacture marks — there is nothing above deep thinking.
  const third = P.doubleTap('deep-thinking',
    { lastKey: 'deep-thinking', lastAt: 10400, lastId: 43, at: 10500 });
  assert.strictEqual(third.category, 'deep-thinking', 'a third press stays deep thinking');
  assert.strictEqual(third.upgraded, false, 'and does not upgrade again');
  assert.strictEqual(third.replaces, null, 'and deletes nothing');

  // A category with no double-tap is never upgraded, however fast it is pressed.
  assert.strictEqual(P.doubleTap('returned', {
    lastKey: 'returned', lastAt: 10000, lastId: 3, at: 10050 }).upgraded, false,
    'only categories with a declared double-tap upgrade');

  /* IT MUST NOT APPEAR IN THE MARK BAR. It has no letter, so a row for it would show an empty key —
     and offering it beside Thinking invites pressing both for one event, which splits one state's
     marks across two buckets. That is the same mistake the just-sitting/Being/shikantaza note
     explains avoiding. */
  assert.ok(!P.PRIMARY_TAP_CATEGORIES.some((t) => t.key === 'deep-thinking'),
    'deep thinking must not be offered as a first-class category');
  assert.ok(P.PRIMARY_TAP_CATEGORIES.every((t) => t.kbd),
    'every category offered in the mark bar must have a letter to press');
  // And the letter table must not have grown a null key.
  assert.ok(!('null' in P.TAP_BY_KBD) && !(null in P.TAP_BY_KBD),
    'a letterless category must not be indexed by its absent letter');

  console.log('✓ double-tapping Thinking makes one deep-thinking mark and removes the first,'
    + ' a slow second press stays two marks, a third does not climb, and it is not offered as a key');
}

console.log('\nAll probe tests passed.');
