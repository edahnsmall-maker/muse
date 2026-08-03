/*
 * IS THE DEVICE CLOCK TELLING THE TRUTH?
 *
 * WHY THIS EXISTS. Reported three times, escalating:
 *
 *   "the dates/times don't look right. i just recorded this right now, 8/1 957 am EST"
 *   "why is the date and time still off tho? it's off by a day and an hour and a half"
 *   "i just recorded this (8/3) and the date still says 7/31. i think all these dates might be off."
 *
 * The app has no clock of its own. Every timestamp is `Date.now()`, and every displayed date is
 * that value rendered in the device's timezone. Told that a date is wrong, the app has previously
 * been able to do nothing but explain how timestamps are produced — which is not a fix, and after
 * the third report it stops being an acceptable answer.
 *
 * WHAT CAN ACTUALLY BE DETERMINED WITHOUT A NETWORK. There are two clocks in a browser and they
 * fail differently:
 *
 *   Date.now()          wall clock. Can be wrong by any amount, can be edited, can be corrected by
 *                       NTP mid-session, and in a virtual machine can drift or freeze outright.
 *   performance.now()   monotonic. Counts elapsed time since the page loaded. Cannot jump, cannot
 *                       go backwards, and is unaffected by what the wall clock believes.
 *
 * Neither knows the true time. But COMPARING them proves whether the wall clock is behaving: over
 * any interval they must advance together. If ten monotonic seconds pass while the wall clock
 * advances eleven, or nine, or minus eighty-six thousand, the wall clock is unreliable and every
 * timestamp derived from it is suspect. That is a measurement, not a guess, and it needs nothing
 * but the two clocks already present.
 *
 * WHAT THIS CANNOT DO, stated plainly because the temptation to overclaim is strong. A wall clock
 * that is wrong by exactly three days and otherwise ticking perfectly is INVISIBLE to this check —
 * both clocks advance at the same rate, and nothing on the device knows what day it is. So the
 * user's specific symptom may well be undetectable here. What this catches is a clock that is
 * moving wrongly (drifting, frozen, stepping), which is the failure mode of a VM or a machine
 * whose time sync is broken, and which produces exactly the pattern of ever-growing error that was
 * reported across three days. For the invisible case there is `offsetMs` below: a correction the
 * user states once, applied to what is displayed, never to what is recorded.
 *
 * SENSITIVITY. Measured against the sample rate rather than assumed: at a 250ms tick, a drift of
 * 0.5% shows as 1.25ms per tick, which is well inside the jitter of setInterval and invisible at
 * that scale. Over a 10-minute sit it is 3 seconds, which is unmistakable. So this integrates over
 * the whole session rather than sampling instants, and reports the drift as a RATE (parts per
 * thousand) plus the accumulated error, because those two answer different questions: the rate says
 * whether the clock is broken, the accumulated error says whether this sit's timestamps are usable.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ClockCheck = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * How much wall-clock error is worth mentioning.
   *
   * A tick scheduled every 250ms does not arrive every 250ms — a busy tab, a garbage collection or
   * a backgrounded window delays it, and `Date.now()` and `performance.now()` both see that delay
   * equally, so ordinary jitter cancels out of the DIFFERENCE. What does not cancel is the wall
   * clock moving at the wrong rate or stepping.
   *
   * 2 seconds accumulated, or 5 parts per thousand of rate error, are both far above anything a
   * healthy machine produces over a sit and far below the multi-hour errors reported. A backgrounded
   * tab is the one benign case that can trip the accumulated threshold, which is why a step is
   * distinguished from a drift below: a single jump is usually the operating system correcting the
   * clock, and a steady rate error is usually a broken one.
   */
  const DRIFT_MS = 2000;
  const RATE_PPT = 5;
  // A jump larger than this within one tick cannot be drift — no clock drifts a minute in 250ms.
  // It is either an NTP correction, a manual change, or a suspend/resume.
  const STEP_MS = 60000;

  function create({ now = () => Date.now(), mono = null } = {}) {
    /* The monotonic source is injected so this is testable without waiting in real time. Falling
       back to Date.now() when there is no performance clock makes the check a no-op rather than a
       liar: with only one clock there is nothing to compare, and it says so. */
    const monotonic = mono
      || (typeof performance !== 'undefined' && performance.now
        ? () => performance.now()
        : null);

    const wall0 = now();
    const mono0 = monotonic ? monotonic() : null;
    let lastWall = wall0;
    let lastMono = mono0;
    // Steps are accumulated separately from drift. Mixing them would let one suspend/resume look
    // like a badly-running clock for the rest of the sit.
    let steps = [];
    let driftMs = 0;

    return {
      available: !!monotonic,

      /*
       * Call this as often as convenient — the app calls it from its 250ms tick. Every call
       * compares how far each clock has advanced since the previous call.
       */
      sample() {
        if (!monotonic) return null;
        const w = now();
        const m = monotonic();
        const dw = w - lastWall;
        const dm = m - lastMono;
        lastWall = w;
        lastMono = m;
        const err = dw - dm;
        if (Math.abs(err) >= STEP_MS) {
          steps.push({ atMono: m, byMs: err });
        } else {
          driftMs += err;
        }
        return err;
      },

      /*
       * What is known so far. `usable` is the question the rest of the app actually asks: can this
       * session's timestamps be trusted to within a couple of seconds?
       */
      report() {
        if (!monotonic) {
          return { available: false, usable: true, elapsedSec: 0, driftMs: 0, ratePpt: 0,
            steps: [], stepMs: 0, verdict: null,
            reason: 'no monotonic clock on this device, so nothing can be cross-checked' };
        }
        const elapsedMono = monotonic() - mono0;
        const elapsedSec = elapsedMono / 1000;
        const stepMs = steps.reduce((a, s) => a + s.byMs, 0);
        // Rate error in parts per thousand, from drift only: a step is not a rate.
        const ratePpt = elapsedMono > 0 ? (driftMs / elapsedMono) * 1000 : 0;
        const bigDrift = Math.abs(driftMs) >= DRIFT_MS;
        const bigRate = elapsedSec >= 30 && Math.abs(ratePpt) >= RATE_PPT;
        const stepped = steps.length > 0;
        let verdict = null;
        if (stepped && (bigDrift || bigRate)) verdict = 'stepped-and-drifting';
        else if (stepped) verdict = 'stepped';
        else if (bigDrift || bigRate) verdict = 'drifting';
        return {
          available: true,
          // A step is a correction and leaves the times AFTER it fine; a drift means the whole
          // session's timestamps are progressively wrong.
          usable: !(bigDrift || bigRate),
          elapsedSec,
          driftMs,
          ratePpt,
          steps: steps.slice(),
          stepMs,
          verdict,
          reason: verdict ? describe({ driftMs, ratePpt, steps, elapsedSec }) : null,
        };
      },

      // A new sit starts a new measurement: carrying a previous session's steps forward would
      // report a correction that happened yesterday as a fault in today's recording.
      reset() {
        lastWall = now();
        lastMono = monotonic ? monotonic() : null;
        steps = [];
        driftMs = 0;
      },
    };
  }

  function describe({ driftMs, ratePpt, steps, elapsedSec }) {
    const parts = [];
    if (steps.length) {
      const biggest = steps.reduce((a, s) => (Math.abs(s.byMs) > Math.abs(a.byMs) ? s : a), steps[0]);
      const mins = Math.abs(biggest.byMs) / 60000;
      parts.push(`the clock jumped ${biggest.byMs > 0 ? 'forward' : 'back'} by`
        + ` ${mins >= 60 ? (mins / 60).toFixed(1) + ' hours' : mins.toFixed(1) + ' minutes'}`
        + (steps.length > 1 ? ` (${steps.length} jumps in all)` : ''));
    }
    if (Math.abs(driftMs) >= DRIFT_MS || Math.abs(ratePpt) >= RATE_PPT) {
      parts.push(`it has ${driftMs > 0 ? 'gained' : 'lost'} ${Math.abs(driftMs / 1000).toFixed(1)}s`
        + ` over ${Math.round(elapsedSec)}s of real time (${Math.abs(ratePpt).toFixed(1)} parts`
        + ' per thousand)');
    }
    return parts.join(', and ');
  }

  /*
   * A CORRECTION THE USER STATES, for the case the cross-check cannot see.
   *
   * A clock wrong by a constant amount ticks perfectly, so nothing on the device can detect it. The
   * only source of truth is the person, who can look at a watch. `offsetMs` is stored once and
   * applied to what is DISPLAYED, never to what is recorded: `epochMs` in every export stays
   * exactly what the device believed, so a correction can be revised or undone later, and two
   * archives are still comparable even if the offset changed between them. Rewriting recorded
   * timestamps would destroy that, and would make the raw data disagree with itself.
   */
  const OFFSET_KEY = 'zenbio.clockOffsetMs';

  function readOffset(store) {
    try {
      const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!s) return 0;
      const v = Number(s.getItem(OFFSET_KEY));
      return Number.isFinite(v) ? v : 0;
    } catch (err) { return 0; }
  }

  function writeOffset(ms, store) {
    try {
      const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!s) return 0;
      const v = Number(ms);
      if (!Number.isFinite(v) || v === 0) s.removeItem(OFFSET_KEY);
      else s.setItem(OFFSET_KEY, String(Math.round(v)));
      return Number.isFinite(v) ? Math.round(v) : 0;
    } catch (err) { return 0; }
  }

  /*
   * The offset implied by the user saying "it is actually HH:MM right now".
   *
   * Only the time of day is asked for, because that is what someone can read off a watch without
   * thinking. The date is inferred: the correction is taken to be the one under twelve hours in
   * magnitude, which is right for a timezone error and for a clock a few minutes out. A clock wrong
   * by whole days needs the date too, so `dateISO` is accepted for that case.
   */
  function offsetFromStatedTime(statedHHMM, { now = Date.now(), dateISO = null } = {}) {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(statedHHMM || ''));
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2]);
    if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
    const base = new Date(now);
    if (dateISO) {
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
      if (!d) return null;
      base.setFullYear(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    }
    base.setHours(hh, mm, 0, 0);
    let off = base.getTime() - now;
    if (!dateISO) {
      /* WRAP TO THE NEAREST DAY, then REFUSE IF THE ANSWER IS AMBIGUOUS.
       *
       * A clock reading 22:10 told "it is actually 09:57" is either 12h13m fast or 11h47m slow.
       * Both are arithmetically consistent and nothing in a time of day can separate them. The
       * first version of this wrapped to the smaller magnitude and returned it, which is a coin
       * toss dressed as a calculation — and a twelve-hour error in the wrong direction would put
       * every recorded sit on the wrong day, which is the exact problem this exists to fix.
       *
       * So near the half-day boundary it returns null and the caller has to ask for the date. The
       * window is two hours wide because a plausible clock fault is a timezone (whole or half
       * hours, up to about 14) or a few minutes of drift; nothing plausible lands at 11 hours.
       */
      const DAY = 86400000;
      while (off > DAY / 2) off -= DAY;
      while (off < -DAY / 2) off += DAY;
      const AMBIGUOUS_FROM = 10 * 3600 * 1000;
      if (Math.abs(off) > AMBIGUOUS_FROM) return null;
    }
    return Math.round(off);
  }

  return { create, describe, readOffset, writeOffset, offsetFromStatedTime,
    OFFSET_KEY, DRIFT_MS, RATE_PPT, STEP_MS };
});
