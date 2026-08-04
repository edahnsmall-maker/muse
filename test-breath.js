/*
 * Tests for breath.js — chest-strap breathing rate and cycle shape.
 *
 * THE TEST THAT MATTERS MOST is the harmonic one. The bug this module was written to fix reported 10.2
 * breaths/min where the truth was 6.0, and it did so silently and plausibly: a rate in the right
 * ballpark, from a real sensor, with no error anywhere. The cause was that the axis with the largest
 * variance carried the SECOND HARMONIC of breathing, so the detector counted every breath twice.
 *
 * A wrong rate that looks right is the worst failure available here, so the fixtures are built to
 * reproduce it rather than to be easy: one axis carries a clean fundamental with small amplitude, and
 * another carries a loud harmonic. A module that picks by loudness fails. A module that picks the lowest
 * credible peak passes.
 */
const assert = require('assert');
const Breath = require('./public/breath.js');

const HZ = 50;

/*
 * A synthetic sit. `shape` bends the cycle: 0.5 is symmetric, lower is quick-in slow-out.
 * Built by warping TIME inside each cycle rather than by adding harmonics, because adding a harmonic to
 * make the shape asymmetric would put energy at exactly the frequency the harmonic test is about.
 */
function sit({ ratePerMin = 6, seconds = 300, amp = 8, shape = 0.5, noise = 0.15,
  harmonicAmp = 0, harmonicAxis = 'z', seed = 5, jitter = 0 } = {}) {
  let s = seed | 0 || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  const period = 60 / ratePerMin;
  const rows = [];
  for (let i = 0; i < seconds * HZ; i++) {
    const t = i / HZ;
    // Phase within the cycle, with optional jitter in the period so regularity can be varied.
    const cyc = period * (1 + jitter * Math.sin((2 * Math.PI * t) / (seconds / 3)));
    const ph = (t % cyc) / cyc;
    /*
     * BUILT FROM THE RISE FRACTION DIRECTLY, which the first version of this fixture did not do — and
     * the difference is the whole point of the shape tests.
     *
     * That version warped time inside a sine: it mapped [0, shape] onto the sine's first half. But the
     * sine's first half contains the rise AND half the fall, so compressing it compressed both equally
     * and trough-to-peak stayed exactly half the cycle. Every value of `shape` produced riseFrac 0.500,
     * so the test compared 0.500 against 0.500 and the module was blamed for a fixture that could not
     * express the thing being tested.
     *
     * Here the cycle starts at the trough: it rises to the peak over the first `shape` of the period and
     * falls back over the rest. A half-cosine on each leg, so the waveform is continuous and has no
     * corner to put spurious broadband energy into the spectrum.
     */
    const fundamental = amp * (ph < shape
      ? -Math.cos((Math.PI * ph) / shape)
      : Math.cos((Math.PI * (ph - shape)) / (1 - shape)));
    rows.push({
      tSec: t,
      // x carries the fundamental. Deliberately QUIETER than the harmonic axis in the harmonic test.
      x: fundamental + noise * rnd() + 200,          // +200: a gravity offset that must be removed
      y: 0.4 * fundamental + noise * rnd() - 30,
      z: (harmonicAxis === 'z' ? harmonicAmp * Math.sin((4 * Math.PI * t) / cyc) : 0)
        + noise * rnd() + 980,                        // z holds most of gravity, as when worn
    });
  }
  return rows;
}

/* 1) THE HARMONIC TRAP. The exact failure that produced 10.2/min against a true 6.0.
 *    z is given a harmonic at twice the breathing rate and THREE TIMES the amplitude of the real
 *    signal on x. Picking the loudest axis doubles the reported rate.
 */
{
  const rows = sit({ ratePerMin: 6, amp: 6, harmonicAmp: 18, harmonicAxis: 'z' });
  const r = Breath.analyse(rows);
  assert.strictEqual(r.known, true, `the sit must be analysable (${r.reason})`);
  assert.ok(Math.abs(r.summary.ratePerMin - 6) < 0.8,
    `the rate must be the FUNDAMENTAL 6/min, not the harmonic 12 — got`
    + ` ${r.summary.ratePerMin.toFixed(2)}/min on axis ${r.axis}`);
  assert.notStrictEqual(r.axis, 'z',
    'and must not choose the loud harmonic axis, however much it moves');
  // The harmonic must be NAMED rather than silently discarded: seeing it is how the next reader avoids
  // re-introducing the bug.
  assert.ok(r.harmonics.some((h) => h.axis === 'z' && Math.abs(h.ratio - 2) < 0.35),
    `the 2x harmonic on z must be reported (got ${JSON.stringify(r.harmonics)})`);
  console.log(`✓ a harmonic three times louder than the real signal does not double the rate`
    + ` (${r.summary.ratePerMin.toFixed(2)}/min on ${r.axis}, harmonic on z flagged at`
    + ` ${r.harmonics[0].ratio.toFixed(2)}x)`);
}

// 2) THE RATE IS RIGHT ACROSS THE PLAUSIBLE RANGE, not just at one convenient value.
{
  for (const rate of [4, 6, 9, 12, 18]) {
    const r = Breath.analyse(sit({ ratePerMin: rate, amp: 8, seconds: 300 }));
    assert.strictEqual(r.known, true, `${rate}/min must be analysable (${r.reason})`);
    assert.ok(Math.abs(r.summary.ratePerMin - rate) / rate < 0.12,
      `${rate}/min read as ${r.summary.ratePerMin.toFixed(2)} — more than 12% out`);
  }
  console.log('✓ the rate is recovered within 12% from 4 to 18 breaths/min');
}

/* 3) SHAPE IS RECOVERED, AND IS THE POINT.
 *    "for breath, i think it's the shape... maybe something like the height of the belly outbreath."
 *    riseFrac is where the peak sits in the cycle. A quick-in slow-out breath must read below 0.5 and a
 *    symmetric one at 0.5, or the measure carries no information about shape at all.
 */
{
  const sym = Breath.analyse(sit({ shape: 0.5, amp: 8 }));
  const quick = Breath.analyse(sit({ shape: 0.25, amp: 8 }));
  assert.strictEqual(sym.known, true);
  assert.strictEqual(quick.known, true);
  assert.ok(Math.abs(sym.summary.riseFrac - 0.5) < 0.12,
    `a symmetric cycle must read near 0.5, got ${sym.summary.riseFrac.toFixed(3)}`);
  assert.ok(quick.summary.riseFrac < sym.summary.riseFrac - 0.08,
    `a quick-in slow-out cycle must read clearly lower than symmetric`
    + ` (${quick.summary.riseFrac.toFixed(3)} vs ${sym.summary.riseFrac.toFixed(3)})`);
  // Amplitude tracks depth. The one measure here that is not scale-free, so it is the one that depends
  // on strap tightness — asserted as ordering only, never as an absolute.
  const deep = Breath.analyse(sit({ amp: 20 }));
  const shallow = Breath.analyse(sit({ amp: 4 }));
  assert.ok(deep.summary.amplitudeMg > shallow.summary.amplitudeMg * 2,
    `depth must order correctly (${deep.summary.amplitudeMg.toFixed(1)} vs`
    + ` ${shallow.summary.amplitudeMg.toFixed(1)} mG)`);
  console.log(`✓ shape is measurable: symmetric ${sym.summary.riseFrac.toFixed(2)},`
    + ` quick-in ${quick.summary.riseFrac.toFixed(2)}, and depth orders correctly`);
}

/* 4) REGULARITY. Steady breathing must read steadier than wandering breathing, or the measure cannot
 *    speak to "more smooth in tempo" — which is the half of the hypothesis about consistency rather
 *    than about the shape of one breath.
 */
{
  const steady = Breath.analyse(sit({ jitter: 0, amp: 8 }));
  const wandering = Breath.analyse(sit({ jitter: 0.35, amp: 8 }));
  assert.ok(steady.summary.periodCv < wandering.summary.periodCv,
    `steady breathing must have a lower period CV than wandering`
    + ` (${steady.summary.periodCv.toFixed(3)} vs ${wandering.summary.periodCv.toFixed(3)})`);
  console.log(`✓ regularity separates steady from wandering breathing`
    + ` (CV ${steady.summary.periodCv.toFixed(3)} vs ${wandering.summary.periodCv.toFixed(3)})`);
}

/* 5) GRAVITY MUST NOT REACH THE ANSWER. The fixtures carry offsets of +200, -30 and +980 mG, and
 *    gravity is a hundred times the size of breathing. A module that left it in would be measuring
 *    posture, and the amplitude would be dominated by which way the wearer was leaning.
 */
{
  const plain = Breath.analyse(sit({ amp: 8 }));
  const tilted = Breath.analyse(sit({ amp: 8 }).map((r) => ({ tSec: r.tSec,
    x: r.x + 500, y: r.y - 700, z: r.z - 400 })));
  assert.strictEqual(tilted.known, true, 'a leaning wearer must still be analysable');
  assert.ok(Math.abs(tilted.summary.ratePerMin - plain.summary.ratePerMin) < 0.3,
    `a constant tilt must not change the rate (${plain.summary.ratePerMin.toFixed(2)} vs`
    + ` ${tilted.summary.ratePerMin.toFixed(2)})`);
  assert.ok(Math.abs(tilted.summary.amplitudeMg - plain.summary.amplitudeMg) < 1.5,
    'nor the amplitude, which would otherwise be a measurement of posture');
  console.log('✓ a constant tilt of hundreds of mG changes neither the rate nor the amplitude');
}

/* 6) IT REFUSES RATHER THAN GUESSES. Every refusal names its own cause, because "no breathing found"
 *    from a strap that was not worn and from a strap that was worn badly have different fixes.
 */
{
  const short = Breath.analyse(sit({ seconds: 5 }));
  assert.strictEqual(short.known, false);
  assert.match(short.reason, /samples/, 'too little data must say so');

  // A strap not against the chest: nothing but quantisation noise.
  const still = Array.from({ length: 300 * HZ }, (_, i) => ({ tSec: i / HZ, x: 200, y: -30, z: 980 }));
  const dead = Breath.analyse(still);
  assert.strictEqual(dead.known, false, 'a motionless strap cannot yield a breath');
  assert.match(dead.reason, /not worn|against the chest/,
    `and must say what is wrong, got "${dead.reason}"`);
  assert.ok(!dead.cycles.length, 'with no cycles invented');

  // Garbage timestamps.
  const bad = Breath.analyse(sit({ amp: 8 }).map((r) => ({ ...r, tSec: NaN })));
  assert.strictEqual(bad.known, false, 'unusable timestamps must be refused');
  console.log('✓ short data, an unworn strap and broken timestamps each refuse with their own reason');
}

/* 7) AGREEMENT WITH AN INDEPENDENT SENSOR is reported as a difference, not as a verdict.
 *    Chest movement and heart timing share no hardware and no failure mode, so their agreement is the
 *    only real validation available. What counts as agreement depends on the use, so this returns the
 *    number and lets the caller decide.
 */
{
  const r = Breath.analyse(sit({ ratePerMin: 6, amp: 8 }));
  const ok = Breath.agreementWith(r, 6.43);
  assert.ok(ok && ok.differencePct < 15, `6/min against an RSA 6.43 must agree closely,`
    + ` got ${ok.differencePct.toFixed(1)}%`);
  const bad = Breath.agreementWith(r, 12);
  assert.ok(bad.differencePct > 40, 'and a doubled reference must show a large disagreement');
  assert.strictEqual(Breath.agreementWith(null, 6), null, 'no analysis, no agreement');
  assert.strictEqual(Breath.agreementWith(r, 0), null, 'and no reference, no agreement');
  console.log(`✓ agreement is reported as a percentage difference (${ok.differencePct.toFixed(1)}% against`
    + ' an independent estimate), never as a pass mark');
}

/* 8) WINDOWS, so one marked moment can be compared with another. Cycles belong to a window by their
 *    MIDPOINT: splitting a cycle at the edge would produce a partial one whose shape means nothing.
 */
{
  const r = Breath.analyse(sit({ ratePerMin: 6, amp: 8, seconds: 300 }));
  const early = Breath.inWindow(r, 20, 120);
  const late = Breath.inWindow(r, 180, 280);
  assert.ok(early && late, 'both windows must yield an answer');
  assert.ok(early.cycles >= 5 && late.cycles >= 5, 'each with several cycles');
  assert.ok(Math.abs(early.ratePerMin - late.ratePerMin) < 1,
    'and on a stationary fixture they must agree');
  // A window too small to contain two cycles must return null rather than a one-cycle "average".
  assert.strictEqual(Breath.inWindow(r, 100, 104), null,
    'a window shorter than a breath must refuse, not average one cycle');
  console.log(`✓ windows compare (${early.cycles} vs ${late.cycles} cycles) and refuse when too short`);
}

/* 9) THE INDEPENDENT CROSS-CHECK IS THE GATE THAT MATTERS, AND IT MUST REFUSE.
 *
 * The self-consistency check inside analyse() compares the spectrum with the counted cycles, and on one
 * real sit those agreed with each other to within 2.8% while both sat 41% away from the truth — locked
 * onto the same wrong frequency together. Internal agreement cannot detect that, by construction.
 *
 * So when a heart-derived rate is available from the same strap, disagreement with it refuses. A number
 * that is probably double or half, from a real sensor, with nothing on screen to say so, is the failure
 * this whole module exists to prevent — and it is about to be compared against EEG, where a wrong breath
 * rate would not produce a wrong breath conclusion but a wrong conclusion about the brain.
 */
{
  const rows = sit({ ratePerMin: 6, amp: 8 });
  // Agreeing reference: answered, and marked as checked.
  const ok = Breath.analyse(rows, { referenceRatePerMin: 6.4 });
  assert.strictEqual(ok.known, true, `a close reference must not block the answer (${ok.reason})`);
  assert.strictEqual(ok.referenceChecked, true, 'and the answer must record that it was checked');
  assert.ok(ok.referenceCheck.differencePct < Breath.MAX_REFERENCE_DISAGREEMENT_PCT,
    'with the difference reported');

  // A reference at double the rate: refused, not reconciled.
  const doubled = Breath.analyse(rows, { referenceRatePerMin: 12 });
  assert.strictEqual(doubled.known, false,
    'a reference at twice the rate must REFUSE — that is the factor-of-two error this exists to catch');
  assert.match(doubled.reason, /independent|heart-derived/,
    `and must say the two sensors disagree, got "${doubled.reason}"`);
  assert.match(doubled.reason, /rather than a number/,
    'and that it is reporting nothing rather than guessing');
  assert.strictEqual(doubled.referenceChecked, true, 'the refusal must also be marked as checked');

  // And half.
  assert.strictEqual(Breath.analyse(rows, { referenceRatePerMin: 3 }).known, false,
    'a reference at half the rate must refuse too');

  /* NO REFERENCE IS NOT THE SAME AS A PASSED CHECK. An unchecked number must be distinguishable from a
     checked one, or a caller comparing breath against EEG cannot know which it is holding. */
  const unchecked = Breath.analyse(rows);
  assert.strictEqual(unchecked.known, true, 'without a reference it still answers');
  assert.strictEqual(unchecked.referenceChecked, false,
    'but must NOT claim to have been checked — silence is not a pass');
  assert.strictEqual(unchecked.referenceCheck, null, 'with no check to show');
  console.log('✓ a heart-derived rate at double or half the chest rate refuses outright, and an'
    + ' unchecked answer never claims to have been checked');
}

console.log('\nAll breath tests passed.');
