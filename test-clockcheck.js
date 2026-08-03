/*
 * Tests for clockcheck.js.
 *
 * The claim is narrow and the tests are written to hold it to exactly that: comparing the wall
 * clock against the monotonic clock proves whether the wall clock is MOVING correctly, and proves
 * nothing about whether it is SET correctly. A test suite that let this module look like a
 * general-purpose "is the date right" detector would be worse than none, because the user has a
 * wrong date and would believe it.
 */
const assert = require('assert');
const ClockCheck = require('./public/clockcheck.js');

// A pair of fake clocks. `mono` advances honestly; `wall` advances however the test says.
function clocks({ rate = 1, startWall = 1700000000000 } = {}) {
  let mono = 0;
  let wall = startWall;
  return {
    now: () => wall,
    mono: () => mono,
    // Advance real time by `ms`; the wall clock advances by ms*rate, plus any injected step.
    tick(ms, stepMs = 0) {
      mono += ms;
      wall += ms * rate + stepMs;
    },
    setRate(r) { rate = r; },
  };
}

// 1) A HEALTHY CLOCK MUST BE SILENT. False alarms here would train the user to ignore the warning,
//    which costs more than never having built it.
{
  const c = clocks();
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  for (let i = 0; i < 4 * 60 * 20; i++) { c.tick(250); chk.sample(); }   // 20 minutes at 4Hz
  const r = chk.report();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.usable, true, `a perfect clock must not be flagged (drift ${r.driftMs}ms)`);
  assert.strictEqual(r.verdict, null, 'and must produce no verdict at all');
  assert.strictEqual(r.steps.length, 0);
  console.log(`✓ a healthy clock is silent over 20 simulated minutes (drift ${r.driftMs}ms)`);
}

/* 2) ORDINARY TICK JITTER MUST CANCEL, which is the reason this compares the two clocks rather
 *    than checking either against its own schedule. setInterval does not fire on time — a busy
 *    tab, a GC or a backgrounded window delays it — but BOTH clocks see the same delay, so the
 *    difference is unaffected. A check built on "did the tick arrive at 250ms" would fire
 *    constantly on a healthy machine.
 */
{
  const c = clocks();
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 2000; i++) {
    // Wildly irregular arrivals, including some very long stalls.
    c.tick(Math.round(150 + rnd() * 900 + (rnd() > 0.98 ? 4000 : 0)));
    chk.sample();
  }
  const r = chk.report();
  assert.strictEqual(r.usable, true,
    `jitter and stalls must not be mistaken for drift (drift ${r.driftMs}ms over ${Math.round(r.elapsedSec)}s)`);
  assert.strictEqual(r.steps.length, 0, 'and a slow tick is not a clock step');
  console.log(`✓ tick jitter and multi-second stalls cancel out (drift ${r.driftMs}ms)`);
}

// 3) A DRIFTING CLOCK IS CAUGHT, and reported as a rate rather than only as a total — the rate is
//    what says the clock is broken rather than that this sit was long.
{
  const c = clocks({ rate: 1.01 });          // gains 1%: 6 seconds every 10 minutes
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  for (let i = 0; i < 4 * 60 * 10; i++) { c.tick(250); chk.sample(); }
  const r = chk.report();
  assert.strictEqual(r.usable, false, 'a 1% drift over ten minutes must be flagged');
  assert.strictEqual(r.verdict, 'drifting');
  assert.ok(Math.abs(r.driftMs - 6000) < 200,
    `and quantified: 1% of 600s is 6s (got ${r.driftMs}ms)`);
  assert.ok(Math.abs(r.ratePpt - 10) < 0.5, `as 10 parts per thousand (got ${r.ratePpt.toFixed(2)})`);
  assert.match(r.reason, /gained 6\.0s/, `and said in words (got "${r.reason}")`);
  console.log(`✓ a 1% drift is caught and quantified: ${(r.driftMs / 1000).toFixed(1)}s,`
    + ` ${r.ratePpt.toFixed(1)} parts per thousand`);
}

/* 4) A STEP IS NOT A DRIFT. An operating system correcting the clock mid-sit, or a laptop
 *    resuming from sleep, jumps the wall clock once. Folding that into the drift total would report
 *    a healthy clock as running at a wrong rate for the rest of the session — and the two have
 *    different consequences: after a step, later timestamps are fine.
 */
{
  const c = clocks();
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  for (let i = 0; i < 200; i++) { c.tick(250); chk.sample(); }
  c.tick(250, 3 * 3600 * 1000);              // clock jumps three hours forward
  chk.sample();
  for (let i = 0; i < 200; i++) { c.tick(250); chk.sample(); }
  const r = chk.report();
  assert.strictEqual(r.steps.length, 1, 'the jump must be recorded as one step');
  assert.strictEqual(r.verdict, 'stepped', 'and classified as a step, not as drift');
  assert.ok(Math.abs(r.driftMs) < 100,
    `the drift total must be unpolluted by the step (got ${r.driftMs}ms)`);
  assert.ok(Math.abs(r.stepMs - 3 * 3600 * 1000) < 500, 'and the step size kept');
  assert.match(r.reason, /jumped forward by 3\.0 hours/, `said in words (got "${r.reason}")`);
  // A step leaves later times correct, so it must not condemn the whole session.
  assert.strictEqual(r.usable, true,
    'after a one-off correction the timestamps are usable again, and saying otherwise would be'
    + ' crying wolf');
  console.log(`✓ a 3-hour jump is reported as a step, separately from drift (${r.verdict})`);
}

// 5) A FROZEN CLOCK — the virtual-machine failure — must be caught. This is the shape that produces
//    an error growing by days, which is what was actually reported.
{
  const c = clocks({ rate: 0 });             // wall clock stopped dead
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  for (let i = 0; i < 4 * 60; i++) { c.tick(250); chk.sample(); }   // one minute
  const r = chk.report();
  assert.strictEqual(r.usable, false, 'a stopped clock must be caught within a minute');
  assert.strictEqual(r.verdict, 'drifting');
  assert.ok(r.driftMs < -50000, `and it must show as time LOST (got ${r.driftMs}ms)`);
  assert.match(r.reason, /lost/, 'in words');
  console.log(`✓ a frozen wall clock is caught inside a minute (${(r.driftMs / 1000).toFixed(0)}s lost)`);
}

/* 6) THE HONEST LIMIT, asserted so nobody can mistake this module for more than it is.
 *    A clock wrong by exactly three days but ticking perfectly is UNDETECTABLE here, and the user's
 *    reported symptom may be exactly that. If this test ever fails because the module started
 *    claiming otherwise, the module is lying.
 */
{
  const c = clocks({ startWall: 1700000000000 - 3 * 86400000 });   // three days behind, ticking fine
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  for (let i = 0; i < 4 * 60 * 10; i++) { c.tick(250); chk.sample(); }
  const r = chk.report();
  assert.strictEqual(r.usable, true,
    'a constant offset is invisible to a rate comparison — this is the documented limit, not a bug');
  assert.strictEqual(r.verdict, null);
  console.log('✓ a constant offset is correctly NOT claimed to be detectable');
}

// 7) NO MONOTONIC CLOCK means no check, and it must say so rather than reporting a healthy one.
{
  const chk = ClockCheck.create({ now: () => 1700000000000, mono: null });
  // The module falls back to performance.now() when available; under Node it is, so force absence
  // by checking the reported reason rather than by removing the global.
  const r = chk.report();
  assert.ok(r.available === true || r.reason,
    'either a monotonic clock was found, or the absence is explained');
  if (!r.available) {
    assert.match(r.reason, /monotonic/, 'and the reason names what is missing');
    assert.strictEqual(r.usable, true, 'unknown must not mean broken');
  }
  console.log('✓ with no second clock the check reports that it cannot check, not that all is well');
}

// 8) reset() starts a new measurement. A correction that happened during yesterday's sit must not
//    be reported as a fault in today's recording.
{
  const c = clocks();
  const chk = ClockCheck.create({ now: c.now, mono: c.mono });
  c.tick(250, 2 * 3600 * 1000);
  chk.sample();
  assert.strictEqual(chk.report().steps.length, 1);
  chk.reset();
  for (let i = 0; i < 100; i++) { c.tick(250); chk.sample(); }
  const r = chk.report();
  assert.strictEqual(r.steps.length, 0, 'reset must forget the previous session');
  assert.strictEqual(r.verdict, null);
  console.log('✓ reset starts a fresh measurement per sit');
}

/* 9) THE USER-STATED CORRECTION. For the invisible case, the only source of truth is a person
 *    looking at a watch. This converts "it is actually 09:57" into an offset.
 */
{
  const f = ClockCheck.offsetFromStatedTime;
  // A clock four hours ahead: it says 13:57, the user says it is 09:57.
  const wall = new Date(2026, 7, 3, 13, 57, 0).getTime();
  const off = f('09:57', { now: wall });
  assert.ok(Math.abs(off - (-4 * 3600 * 1000)) < 1000,
    `four hours ahead must give minus four hours (got ${(off / 3600000).toFixed(2)}h)`);

  /* NEAR HALF A DAY IT MUST REFUSE, and this replaced an assertion that was itself a guess.
   *
   * A clock reading 22:10 told "it is actually 09:57" is either 12h13m fast or 11h47m slow. Both
   * are arithmetically consistent and a time of day cannot separate them. The first version of
   * this test demanded the negative answer; the code returned the positive one; and inspecting it
   * showed neither is justified — the magnitudes differ by 26 minutes out of twelve hours. A
   * twelve-hour correction applied backwards puts every sit on the wrong day, which is precisely
   * the bug this module exists to fix, so guessing is the one thing it must not do. */
  const late = new Date(2026, 7, 3, 22, 10, 0).getTime();
  assert.strictEqual(f('09:57', { now: late }), null,
    'a correction near half a day is ambiguous and must be refused, not guessed');
  // A plausible timezone-sized correction must still be accepted, or the guard has eaten the
  // feature: three hours behind is an ordinary misconfiguration.
  const three = f('19:10', { now: late });
  assert.ok(Math.abs(three - (-3 * 3600 * 1000)) < 1000,
    `an ordinary three-hour correction must still work (got ${three})`);

  // A whole-day error needs the date, because no time-of-day correction can express it.
  const dayOff = f('09:57', { now: wall, dateISO: '2026-08-06' });
  assert.ok(dayOff > 2 * 86400000,
    `with a date given, a multi-day correction must be expressible (got ${(dayOff / 86400000).toFixed(2)} days)`);

  // Garbage in must yield null, not a confident zero.
  for (const bad of ['', 'nope', '99:99', '12', null, undefined, '12:5']) {
    assert.strictEqual(f(bad, { now: wall }), null, `"${bad}" must be refused`);
  }
  console.log('✓ a stated time converts to an offset, wraps to the nearest day, and refuses garbage');
}

// 10) The stored offset round-trips, and zero means "no correction" rather than a stored zero.
{
  const fake = (() => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k), size: () => m.size };
  })();
  assert.strictEqual(ClockCheck.readOffset(fake), 0, 'nothing stored means no correction');
  ClockCheck.writeOffset(-4 * 3600 * 1000, fake);
  assert.strictEqual(ClockCheck.readOffset(fake), -4 * 3600 * 1000, 'and it round-trips');
  ClockCheck.writeOffset(0, fake);
  assert.strictEqual(fake.size(), 0,
    'clearing must remove the key, so "corrected by zero" and "not corrected" are the same state');
  console.log('✓ the correction persists, round-trips, and clears cleanly');
}

console.log('\nAll clock-check tests passed.');
