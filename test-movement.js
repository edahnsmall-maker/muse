/*
 * Tests for movement.js — stillness and movement shape from the head accelerometer.
 *
 * The claim this module makes is that a smooth, deliberate movement and an abrupt one can be
 * told apart from acceleration alone. So the central tests SYNTHESISE both shapes and check
 * that the numbers separate them, rather than checking that the arithmetic runs. A metric that
 * cannot distinguish the two things it was built to distinguish is worse than no metric,
 * because it will be believed.
 */
const assert = require('assert');
const Movement = require('./public/movement.js');

/*
 * THE FIXTURE IS DEFINED IN THE DOMAIN THE MODULE MEASURES, which took two attempts to get
 * right and both mistakes are worth recording.
 *
 * The module works from the per-sample CHANGE in the acceleration vector. So a movement is
 * specified here by the change profile it should produce, in mG per sample, and the signal added
 * to the accelerometer is that profile's running sum. Specifying displacement instead went wrong
 * twice:
 *
 *   1. Amplitudes were sized as if they were the measured quantity. A displacement bump of 260
 *      over 1.5s at 50Hz peaks at about 13mG of change — under the 50mG event threshold — so
 *      every movement test found nothing.
 *   2. The "abrupt" shape was a fast rise followed by an abrupt return, which is a STEP in
 *      displacement, and a step differentiates into one enormous spike at the join. The detected
 *      event then ended at that spike, putting the peak at riseFrac 1.00 — the exact opposite of
 *      the front-loading it was written to represent.
 *
 * Defining the change profile directly makes both impossible: `peakMg` is the peak per-sample
 * change, in the same units the thresholds are in, and the shapes differ only in WHERE that peak
 * falls.
 */
const SMOOTH = (u) => Math.sin(Math.PI * u);                       // symmetric, peaks at u=0.5
// A gamma-shaped pulse peaking at u=0.12: fast onset, long tail. This is "quick at the start".
const ABRUPT = (u) => (u / 0.12) * Math.exp(1 - u / 0.12);

// A sit: gravity in a fixed direction, plus small respiration-scale motion, plus whatever
// movements are asked for. mG throughout, 50Hz, exactly as acc.csv carries it.
function synth({ secs = 120, hz = 50, breathMg = 3, movements = [], drift = 0, seed = 11 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  const n = Math.round(secs * hz);
  /* The movement contribution, built as a change profile and then accumulated. The x and z
     components together scale the magnitude by sqrt(1 + 0.6^2) = 1.166, so the profile is
     divided by that to make `peakMg` mean what it says. */
  const bump = new Float64Array(n);
  for (const m of movements) {
    const shape = m.shape === 'abrupt' ? ABRUPT : SMOOTH;
    const len = Math.round(m.dur * hz);
    const i0 = Math.round(m.at * hz);
    let running = 0;
    for (let k = 0; k <= len && i0 + k < n; k++) {
      running += (m.peakMg / 1.166) * shape(k / len);
      bump[i0 + k] += running;
    }
    // Hold the displacement after the movement ends: releasing it would be a second movement.
    for (let i = i0 + len + 1; i < n; i++) bump[i] += running;
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    let x = -960 + drift * t;
    let y = 3;
    let z = -380;
    // Respiration: a slow sine, small.
    y += breathMg * Math.sin((2 * Math.PI * t) / 4);
    x += breathMg * 0.5 * Math.sin((2 * Math.PI * t) / 4 + 1);
    // Sensor noise, well under the quiet threshold.
    x += rnd() * 1.5; y += rnd() * 1.5; z += rnd() * 1.5;
    x += bump[i];
    z += bump[i] * 0.6;
    rows.push({ tSec: Number(t.toFixed(3)), x, y, z });
  }
  return rows;
}

// 1) A STILL SIT IS REPORTED AS STILL, and produces no movements. If breathing alone trips the
//    detector, every number downstream is a measure of being alive rather than of practice.
{
  const a = Movement.analyse(synth({ secs: 120 }));
  assert.strictEqual(a.reason, null, `a clean 2-minute recording must analyse (${a.reason})`);
  assert.ok(a.stillFrac > 0.95,
    `a still sit must read as still — got ${(a.stillFrac * 100).toFixed(1)}% still`);
  assert.strictEqual(a.events.length, 0,
    `breathing and sensor noise must not count as movements (got ${a.events.length})`);
  assert.ok(Math.abs(a.hz - 50) < 0.5, `the rate must be measured from the data (got ${a.hz})`);
  console.log(`✓ a still sit reads as ${(a.stillFrac * 100).toFixed(1)}% still with no movements`);
}

// 2) MOVEMENTS ARE FOUND, once, each — not split into pieces and not merged into one.
{
  const a = Movement.analyse(synth({ secs: 120, movements: [
    { at: 20, dur: 1.5, peakMg: 80, shape: 'smooth' },
    { at: 60, dur: 1.5, peakMg: 80, shape: 'smooth' },
    { at: 95, dur: 1.5, peakMg: 80, shape: 'smooth' },
  ] }));
  assert.strictEqual(a.events.length, 3,
    `three movements must be found as three events (got ${a.events.length}`
    + ` at ${a.events.map((e) => e.atSec.toFixed(1)).join(', ')}s)`);
  const times = a.events.map((e) => e.atSec);
  for (const [i, want] of [20, 60, 95].entries()) {
    assert.ok(Math.abs(times[i] - want) < 1.0,
      `event ${i} must be located near ${want}s (got ${times[i].toFixed(2)})`);
  }
  assert.ok(a.eventsPerMin > 1.2 && a.eventsPerMin < 1.8,
    `three movements in two minutes is ~1.5/min (got ${a.eventsPerMin.toFixed(2)})`);
  console.log(`✓ three movements are found once each, at ${times.map((t) => t.toFixed(0) + 's').join(', ')}`);
}

/* 3) THE CENTRAL CLAIM: a smooth movement and an abrupt one must come out different.
 *
 *    "movements are more deliberate, but also more smooth in tempo, as if the pace during the
 *     movement... showing a diff velocity curve than when i'm riled up (in which case it's more
 *     quick at the start and stop would be my guess)."
 *
 *    Same amplitude and same duration in both, so nothing but the SHAPE can produce the
 *    difference. If these two came out alike the metric would be measuring size, not tempo.
 */
{
  const smooth = Movement.analyse(synth({ seed: 3, secs: 120, movements: [
    { at: 20, dur: 1.6, peakMg: 80, shape: 'smooth' },
    { at: 55, dur: 1.6, peakMg: 80, shape: 'smooth' },
    { at: 90, dur: 1.6, peakMg: 80, shape: 'smooth' },
  ] }));
  const abrupt = Movement.analyse(synth({ seed: 3, secs: 120, movements: [
    { at: 20, dur: 1.6, peakMg: 80, shape: 'abrupt' },
    { at: 55, dur: 1.6, peakMg: 80, shape: 'abrupt' },
    { at: 90, dur: 1.6, peakMg: 80, shape: 'abrupt' },
  ] }));
  assert.ok(smooth.events.length === 3 && abrupt.events.length === 3,
    `both shapes must be detected before they can be compared`
    + ` (smooth ${smooth.events.length}, abrupt ${abrupt.events.length})`);

  /* MEASURED SEPARATION, and it says which of the two numbers to trust:
   *
   *              smooth   abrupt   ratio
   *   crest       1.50     1.91     1.28x
   *   riseFrac    0.514    0.174    0.34 apart, ~3x
   *
   * PEAK POSITION IS THE STRONG DISCRIMINATOR and crest is the weak one. Worth knowing before
   * reading a real comparison: a 20% difference in crest between two sits is within what these
   * shapes produce for a much larger underlying difference, while riseFrac moves a long way.
   * The thresholds below are set to the measured values with margin, not to round numbers. */
  assert.ok(abrupt.medianCrest > smooth.medianCrest * 1.2,
    `an abrupt movement must have a higher crest than a smooth one of the same size and length`
    + ` (smooth ${smooth.medianCrest.toFixed(2)}, abrupt ${abrupt.medianCrest.toFixed(2)})`);

  // RISEFRAC: the front-loaded shape must peak much earlier in its own span. This is the direct
  // check on "quick at the start", and it separates far more cleanly than crest.
  assert.ok(abrupt.medianRiseFrac < smooth.medianRiseFrac - 0.25,
    `the front-loaded shape must peak much earlier (smooth ${smooth.medianRiseFrac.toFixed(2)},`
    + ` abrupt ${abrupt.medianRiseFrac.toFixed(2)})`);
  assert.ok(smooth.medianRiseFrac > 0.4 && smooth.medianRiseFrac < 0.6,
    `and a symmetric movement must peak in the middle, which also checks the fixture itself`
    + ` (got ${smooth.medianRiseFrac.toFixed(2)})`);
  // The separation on peak position must be the larger of the two, or the guidance above is wrong.
  const crestSep = abrupt.medianCrest / smooth.medianCrest;
  const riseSep = smooth.medianRiseFrac / abrupt.medianRiseFrac;
  assert.ok(riseSep > crestSep,
    `peak position must separate the shapes more strongly than crest does`
    + ` (rise ${riseSep.toFixed(2)}x vs crest ${crestSep.toFixed(2)}x)`);
  console.log(`✓ smooth vs abrupt separate on shape alone: crest`
    + ` ${smooth.medianCrest.toFixed(2)} vs ${abrupt.medianCrest.toFixed(2)}, peak position`
    + ` ${smooth.medianRiseFrac.toFixed(2)} vs ${abrupt.medianRiseFrac.toFixed(2)}`);
}

/* 4) THE EVENT ENVELOPE MUST COME FROM THE QUIET LINE, not the event line — and the reason is
 *    not the one first written here.
 *
 *    The first version of this test predicted that clipping the onset would bias riseFrac
 *    DOWNWARD, manufacturing front-loading. Measured, and that is wrong: clipping a symmetric
 *    bump at a high threshold removes both tails symmetrically, so its peak stays in the middle
 *    (0.514 -> 0.523, no bias at all).
 *
 *    What clipping actually does is worse and less obvious. It pulls every shape TOWARD the
 *    middle, because whatever the profile, a window drawn tightly around the peak has the peak
 *    near its centre. So the abrupt shape moves 0.174 -> 0.316 and the separation between the
 *    two shapes collapses from 0.340 to 0.207 — a 40% loss of the only strong discriminator
 *    this module has. The metric does not become biased, it becomes BLIND, which is harder to
 *    notice from the outside.
 */
{
  const three = (shape, opts) => Movement.analyse(synth({ seed: 3, secs: 120, movements: [
    { at: 20, dur: 1.6, peakMg: 80, shape },
    { at: 55, dur: 1.6, peakMg: 80, shape },
    { at: 90, dur: 1.6, peakMg: 80, shape },
  ] }), opts);
  const proper = { smooth: three('smooth'), abrupt: three('abrupt') };
  // quietMg raised to the event threshold: boundaries and detection on the same line.
  const clipped = { smooth: three('smooth', { quietMg: 50 }), abrupt: three('abrupt', { quietMg: 50 }) };
  for (const set of [proper, clipped]) {
    assert.ok(set.smooth.events.length === 3 && set.abrupt.events.length === 3,
      'both configurations must still detect the movements, or this compares nothing');
  }
  const sep = (o) => Math.abs(o.smooth.medianRiseFrac - o.abrupt.medianRiseFrac);
  assert.ok(sep(proper) > sep(clipped) * 1.4,
    `taking the envelope from the quiet line must preserve the shape difference that clipping`
    + ` destroys (quiet line ${sep(proper).toFixed(3)}, clipped ${sep(clipped).toFixed(3)})`);
  // And the mechanism, asserted rather than described: clipping pulls the asymmetric shape
  // toward the middle while leaving the symmetric one alone.
  assert.ok(clipped.abrupt.medianRiseFrac > proper.abrupt.medianRiseFrac + 0.1,
    `clipping must pull the front-loaded shape toward the centre`
    + ` (${proper.abrupt.medianRiseFrac.toFixed(3)} -> ${clipped.abrupt.medianRiseFrac.toFixed(3)})`);
  assert.ok(Math.abs(clipped.smooth.medianRiseFrac - proper.smooth.medianRiseFrac) < 0.05,
    `while leaving a symmetric shape where it was`
    + ` (${proper.smooth.medianRiseFrac.toFixed(3)} -> ${clipped.smooth.medianRiseFrac.toFixed(3)})`);
  assert.ok(proper.smooth.medianDurSec > clipped.smooth.medianDurSec,
    'and the quiet line must capture more of each movement');
  console.log(`✓ the envelope comes from the quiet line: clipping would shrink the shape`
    + ` separation from ${sep(proper).toFixed(3)} to ${sep(clipped).toFixed(3)}`);
}

// 5) A PAUSE INSIDE ONE GESTURE must not become two movements. A reach has a hesitation in it.
{
  const rows = synth({ seed: 9, secs: 60, movements: [
    { at: 20, dur: 0.7, peakMg: 92, shape: 'smooth' },
    { at: 20.85, dur: 0.7, peakMg: 92, shape: 'smooth' },   // 150ms apart: one gesture
  ] });
  const a = Movement.analyse(rows);
  assert.strictEqual(a.events.length, 1,
    `two bumps 150ms apart are one movement (got ${a.events.length})`);
  const far = Movement.analyse(synth({ seed: 9, secs: 60, movements: [
    { at: 20, dur: 0.7, peakMg: 92, shape: 'smooth' },
    { at: 25, dur: 0.7, peakMg: 92, shape: 'smooth' },      // 5s apart: two
  ] }));
  assert.strictEqual(far.events.length, 2,
    `and five seconds apart they are two (got ${far.events.length})`);
  console.log('✓ a pause inside a gesture counts once; separate gestures count separately');
}

// 6) POSTURAL DRIFT is measured separately from movement, because slumping over ten minutes
//    and twitching every ten seconds are different things.
{
  const still = Movement.analyse(synth({ seed: 4, secs: 180, drift: 0 }));
  const leaning = Movement.analyse(synth({ seed: 4, secs: 180, drift: 0.5 }));  // 0.5mG/s
  assert.ok(leaning.swayMgPerMin > still.swayMgPerMin * 2,
    `a steady lean must show up as drift (still ${still.swayMgPerMin.toFixed(1)},`
    + ` leaning ${leaning.swayMgPerMin.toFixed(1)} mG/min)`);
  // And crucially it must NOT be counted as movements — that is the point of separating them.
  assert.strictEqual(leaning.events.length, 0,
    `a slow lean is not a movement (got ${leaning.events.length} events)`);
  assert.ok(leaning.stillFrac > 0.95,
    `nor does it make the sit read as restless (${(leaning.stillFrac * 100).toFixed(1)}% still)`);
  console.log(`✓ a slow lean registers as drift (${leaning.swayMgPerMin.toFixed(0)} vs`
    + ` ${still.swayMgPerMin.toFixed(0)} mG/min) without counting as movement`);
}

/* 7) THE THRESHOLD IS ABSOLUTE, and this records why.
 *    Scaling it to each session's own noise floor would adapt across people and mountings — and
 *    invert the comparison it exists for. A calmer sit has a lower floor, so a relative
 *    threshold drops, catches more small motion, and reports the calm sit as having MORE
 *    movements. Demonstrated rather than asserted.
 */
{
  const quiet = synth({ seed: 6, secs: 120, breathMg: 2, movements: [
    { at: 30, dur: 1.5, peakMg: 80, shape: 'smooth' }] });
  const restless = synth({ seed: 6, secs: 120, breathMg: 9, movements: [
    { at: 30, dur: 1.5, peakMg: 80, shape: 'smooth' },
    { at: 50, dur: 1.5, peakMg: 80, shape: 'smooth' },
    { at: 70, dur: 1.5, peakMg: 80, shape: 'smooth' },
    { at: 90, dur: 1.5, peakMg: 80, shape: 'smooth' }] });
  const fixedQuiet = Movement.analyse(quiet).events.length;
  const fixedRestless = Movement.analyse(restless).events.length;
  assert.ok(fixedRestless > fixedQuiet,
    `with a fixed threshold the restless sit must show more movements`
    + ` (${fixedQuiet} vs ${fixedRestless})`);
  // The relative version, for the record: threshold at 10x each sit's own median change.
  const rel = (rows) => {
    const med = Movement.median(Movement.changeSeries(rows));
    return Movement.analyse(rows, { eventMg: Math.max(10, med * 10) }).events.length;
  };
  const relQuiet = rel(quiet), relRestless = rel(restless);
  assert.ok(relQuiet >= fixedQuiet,
    `a relative threshold on the quieter sit lowers the bar and finds at least as much`
    + ` (fixed ${fixedQuiet}, relative ${relQuiet})`);
  console.log(`✓ the fixed threshold keeps the comparison the right way round`
    + ` (fixed ${fixedQuiet} vs ${fixedRestless}; relative would give ${relQuiet} vs ${relRestless})`);
}

// 8) DEGRADES SAFELY. No accelerometer, a truncated file, or nonsense must produce nulls and a
//    reason, never a confident number.
{
  for (const bad of [null, [], [{ tSec: 0, x: 1, y: 2, z: 3 }], undefined]) {
    const a = Movement.analyse(bad);
    assert.strictEqual(a.stillFrac, null, 'too little data must yield no stillness figure');
    assert.ok(a.reason, 'and must say why');
    assert.deepStrictEqual(a.events, []);
  }
  // Non-numeric rows are dropped rather than turning into NaN.
  const messy = synth({ secs: 60 }).map((r, i) => (i % 20 === 0 ? { tSec: r.tSec, x: '', y: '', z: '' } : r));
  const a = Movement.analyse(messy);
  assert.ok(a.stillFrac != null && a.stillFrac > 0.9, 'a few bad rows must not sink the analysis');
  assert.ok(Number.isFinite(a.medianChangeMg), 'and must not produce NaN');
  console.log('✓ missing, short and malformed accelerometer data yield nulls with a reason');
}

/* 9) COMPARISON DESCRIBES AND DOES NOT TEST, and the absence of a p-value is deliberate.
 *    Two sessions are two observations. A rank test over their one-second rows would report a
 *    tiny p and be meaningless twice over: rows within a session are heavily autocorrelated so
 *    the effective count is a fraction of the row count, and n = 2 sessions cannot separate
 *    "calmer" from "different day, different room, different hour".
 */
{
  const a = Movement.summarise(Movement.analyse(synth({ seed: 2, secs: 120, movements: [
    { at: 30, dur: 1.5, peakMg: 80, shape: 'smooth' }] })));
  const b = Movement.summarise(Movement.analyse(synth({ seed: 2, secs: 120, movements: [
    { at: 30, dur: 1.5, peakMg: 80, shape: 'abrupt' },
    { at: 60, dur: 1.5, peakMg: 80, shape: 'abrupt' },
    { at: 90, dur: 1.5, peakMg: 80, shape: 'abrupt' }] })));
  const rows = Movement.compare(a, b);
  const byKey = {};
  for (const r of rows) byKey[r.key] = r;
  assert.ok(byKey.eventsPerMin.delta > 0, 'the comparison must report the direction of a change');
  assert.ok(byKey.eventsPerMin.ratio > 1, 'and a ratio');
  for (const r of rows) {
    assert.ok(!('p' in r) && !('pValue' in r) && !('significant' in r),
      `comparison rows must carry no p-value: two sessions are two observations (${r.key})`);
  }
  // Every key must be labelled for a human, or the table is a wall of camelCase.
  for (const r of rows) {
    assert.ok(Movement.LABELS[r.key], `${r.key} needs a human label`);
    assert.ok(Movement.LABELS[r.key].unit, `${r.key} needs its units stated`);
  }
  // A missing metric on either side must come through as null, not as a fabricated zero.
  const half = Movement.compare(a, Object.assign({}, b, { medianCrest: null }));
  assert.strictEqual(half.find((r) => r.key === 'medianCrest').delta, null,
    'a metric missing on one side has no difference, which is not the same as no change');
  // And a zero baseline has no ratio: reporting Infinity as a finding is worse than nothing.
  const zeroed = Movement.compare(Object.assign({}, a, { eventsPerMin: 0 }), b);
  assert.strictEqual(zeroed.find((r) => r.key === 'eventsPerMin').ratio, null,
    'a zero baseline must yield no ratio rather than Infinity');
  console.log('✓ comparison reports differences and ratios, carries no p-value, and labels every'
    + ' metric with its units');
}

// 10) The stored summary must be small and must not carry the event list — a hundred events per
//     session is how a browser's storage quota quietly fills up.
{
  const a = Movement.analyse(synth({ secs: 300, movements: Array.from({ length: 40 },
    (_, i) => ({ at: 5 + i * 7, dur: 1.4, peakMg: 80, shape: 'smooth' })) }));
  const s = Movement.summarise(a);
  assert.ok(a.events.length > 20, `precondition: the analysis found events (${a.events.length})`);
  assert.strictEqual(s.events, undefined, 'the stored summary must not carry the event list');
  assert.strictEqual(s.eventCount, a.events.length, 'but must keep the count');
  assert.ok(JSON.stringify(s).length < 500,
    `the summary must stay small (${JSON.stringify(s).length} bytes)`);
  console.log(`✓ the stored summary is ${JSON.stringify(s).length} bytes and keeps the count,`
    + ` not the ${a.events.length} events`);
}

console.log('\nAll movement tests passed.');
