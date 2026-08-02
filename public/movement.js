/*
 * MOVEMENT AND STILLNESS, from the accelerometer that is already in the headband.
 *
 * WHY THIS EXISTS, in the words that asked for it:
 *
 *   "i'm slightly wondering if the brain signals are really good indicators of meditation
 *    quality. i noticed myself that when i'm very calm, some other indicators appear more
 *    obviously (and maybe measurable) such as: less fidgeting, eye gaze less erratic,
 *    movements are more deliberate, but also more smooth in tempo... showing a diff velocity
 *    curve than when i'm riled up (in which case it's more quick at the start and stop would
 *    be my guess)."
 *
 * That is a hypothesis with a testable shape, and — unlike the eye-gaze half of it — the data
 * to test it has been recorded in every single sit already. `acc.csv` is 50Hz three-axis
 * accelerometer, and it has never been analysed by anything.
 *
 * It also deserves to be taken seriously as a RIVAL to the EEG rather than a supplement. A
 * consumer EEG headband measures four electrodes through hair and skin, and every composite
 * built on it is an interpretation. Stillness is nearly a direct measurement: a body that is
 * not moving produces a flat accelerometer trace, and no inference is required to know that.
 * If movement turns out to discriminate better than the brainwave scores, that is a finding
 * about which instrument to trust, and it should not be hidden behind the one that cost more.
 *
 * WHAT IS AND IS NOT MEASURED HERE. Gravity dominates the raw signal — a stationary head
 * reads about 1000mG in whatever direction is down — so nothing useful comes from the raw
 * magnitude. Everything below is built from the SUCCESSIVE DIFFERENCE, which removes any
 * constant orientation exactly and needs no filter design to justify. Slow postural drift is
 * measured separately, from the orientation itself, because slumping over ten minutes and
 * twitching every ten seconds are different things and a practitioner would want to tell them
 * apart.
 *
 * The two shape numbers are the interesting part, and both are dimensionless on purpose so
 * they can be compared across sessions, people and devices:
 *
 *   crest    peak rate of change within a movement, over its own mean rate of change. A
 *            rounded, evenly-paced movement has a low crest. A movement that jumps, holds and
 *            stops has a high one. This is the "different velocity curve" in the quote above.
 *   riseFrac where the peak falls within the movement, as a fraction of its duration. A
 *            symmetric, deliberate movement peaks in the middle (~0.5). "Quick at the start"
 *            is exactly riseFrac well below 0.5, so the guess is directly checkable.
 *
 * Both are named for what they measure rather than borrowed from the motor-control
 * literature's dimensionless-jerk family. Those metrics are defined over velocity profiles
 * from position data; what is available here is acceleration, and dressing a crest factor up
 * in the vocabulary of a validated measure would claim a pedigree it does not have.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Movement = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const DEFAULT_HZ = 50;
  /*
   * QUIET_MG is the line between "still" and "moving", and it was set from real data rather
   * than chosen. On a genuine 7.7-minute sit the per-sample change was: median 3.5mG, p90
   * 13.2mG, p99 37.8mG, max 106mG. So the bulk of a sitting body lives under about 5mG and
   * the excursions that a person would actually call movement are tens of mG. 8mG sits above
   * the noise floor and well below anything deliberate.
   *
   * It is a parameter rather than a constant because it is the one number here that a
   * different mounting or a different device would change, and a threshold that cannot be
   * moved is a threshold nobody can check.
   */
  const QUIET_MG = 8;
  // A movement is not over the instant it dips below the threshold — a reach has a pause in
  // the middle. Gaps shorter than this are bridged, so one gesture counts once.
  const BRIDGE_SEC = 0.3;
  // And anything shorter than this is a sample of noise rather than a movement.
  const MIN_EVENT_SEC = 0.12;
  /*
   * TWO THRESHOLDS, AND THIS IS THE ONE THAT DECIDES WHAT COUNTS AS A MOVEMENT.
   *
   * The first version used QUIET_MG for both jobs and reported 43 movements a minute — one
   * every 1.4 seconds, which is not fidgeting, it is breathing and pulse. So the threshold was
   * swept against a real 7.7-minute sit:
   *
   *   eventMg   events   per min   med. duration   med. riseFrac
   *      15       302     39.6        0.38s            0.10
   *      30       137     18.0        0.44s            0.11
   *      40        74      9.7        1.25s            0.17
   *      50        29      3.8        1.36s            0.24
   *      60        16      2.1        1.75s            0.40
   *
   * There is a structural break between 30 and 40: below it the median event lasts under half
   * a second, which is a twitch or a pulse beat; above it they last over a second, which is
   * what a deliberate adjustment looks like. 50mG also sits above the p99 of the whole sit's
   * per-sample change (37.8mG), so an "event" is genuinely an outlier and not the top of the
   * ordinary distribution.
   *
   * THE THRESHOLD IS FIXED AND ABSOLUTE, and resisting the obvious alternative matters. Scaling
   * it to each session's own noise floor would adapt nicely across people and mountings, and it
   * would also invert the very comparison this exists for: a calmer sit has a lower floor, so a
   * relative threshold would drop, catch more of the small stuff, and report the calm sit as
   * having MORE movements. A fixed line is comparable across sits, which is the whole point.
   *
   * An event's BOUNDARIES still come from QUIET_MG; only its PEAK is tested against EVENT_MG.
   * Using the high threshold for both would have been the easy fix and it would have silently
   * manufactured the result: an event that begins at its own detection threshold has its peak
   * near the front by construction, which is exactly the front-loading the hypothesis predicts.
   * Detecting the shape you set out to measure is the worst available bug here.
   */
  const EVENT_MG = 50;

  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  /*
   * The per-sample change in the acceleration vector, in mG.
   *
   * This is where gravity goes away. A stationary head at any angle reads a constant vector,
   * and the difference between consecutive constant vectors is zero — exactly, with no filter
   * to design, no cutoff to defend and no settling time at the start of the recording. The
   * cost is that a slow lean produces a small signal, which is why sway is measured
   * separately below rather than being lumped in here and lost.
   */
  function changeSeries(rows) {
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i], b = rows[i - 1];
      if (!a || !b) { out.push(null); continue; }
      const dx = Number(a.x) - Number(b.x);
      const dy = Number(a.y) - Number(b.y);
      const dz = Number(a.z) - Number(b.z);
      if (!isFiniteNum(dx) || !isFiniteNum(dy) || !isFiniteNum(dz)) { out.push(null); continue; }
      out.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return out;
  }

  function median(values) {
    const a = values.filter(isFiniteNum).sort((x, y) => x - y);
    if (!a.length) return null;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  /*
   * Discrete movements, with a shape for each.
   *
   * Bridging first, then a minimum duration — in that order, because doing it the other way
   * discards the two halves of a bridged gesture before there is a chance to join them.
   */
  function detectMovements(change, hz, opts = {}) {
    const { quietMg = QUIET_MG, eventMg = EVENT_MG,
      bridgeSec = BRIDGE_SEC, minEventSec = MIN_EVENT_SEC } = opts;
    const bridge = Math.max(1, Math.round(bridgeSec * hz));
    const minLen = Math.max(1, Math.round(minEventSec * hz));
    const spans = [];
    let start = null, quietRun = 0;
    for (let i = 0; i < change.length; i++) {
      const v = change[i];
      const loud = v != null && v >= quietMg;
      if (loud) {
        if (start == null) start = i;
        quietRun = 0;
      } else if (start != null) {
        quietRun++;
        if (quietRun >= bridge) {
          spans.push([start, i - quietRun]);
          start = null; quietRun = 0;
        }
      }
    }
    if (start != null) spans.push([start, change.length - 1]);

    const events = [];
    for (const [i0, i1] of spans) {
      if (i1 - i0 + 1 < minLen) continue;
      let peak = 0, peakAt = i0, sum = 0, n = 0;
      for (let i = i0; i <= i1; i++) {
        const v = change[i];
        if (v == null) continue;
        sum += v; n++;
        if (v > peak) { peak = v; peakAt = i; }
      }
      if (!n || !(peak > 0)) continue;
      // The high threshold, applied to the peak only. Everything below it is respiration,
      // pulse and the small constant motion of being alive.
      if (peak < eventMg) continue;
      const mean = sum / n;
      const durSec = (i1 - i0 + 1) / hz;
      events.push({
        atSec: i0 / hz,
        durSec,
        peakMg: peak,
        meanMg: mean,
        // Total change over the movement: a rough stand-in for how far the head actually went.
        areaMg: sum / hz,
        /* CREST — peak over mean. 1 would be a perfectly flat movement (impossible), ~2 a
           rounded one, 4+ a movement that jumps and stops. Bounded below by 1 by construction,
           which is a useful sanity check on the arithmetic. */
        crest: peak / mean,
        /* RISEFRAC — where the peak sits, as a fraction of the movement. 0.5 is symmetric;
           the "quick at the start" prediction is a value well below it. Guarded against a
           single-sample event, where the notion has no meaning. */
        riseFrac: i1 > i0 ? (peakAt - i0) / (i1 - i0) : 0.5,
      });
    }
    return events;
  }

  /*
   * Slow postural drift, kept apart from movement on purpose.
   *
   * Slumping steadily over ten minutes and twitching every ten seconds are different
   * behaviours with different meanings, and the successive difference above is almost blind to
   * the first. This measures how far the orientation vector wanders per minute, from a coarse
   * average that ignores everything fast — the same quantity a teacher means by "you settled
   * forward through the second half".
   */
  function swayPerMin(rows, hz, { blockSec = 5 } = {}) {
    const block = Math.max(1, Math.round(blockSec * hz));
    const centres = [];
    for (let i = 0; i + block <= rows.length; i += block) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let k = i; k < i + block; k++) {
        const r = rows[k];
        if (!r) continue;
        const x = Number(r.x), y = Number(r.y), z = Number(r.z);
        if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) continue;
        sx += x; sy += y; sz += z; n++;
      }
      if (n) centres.push([sx / n, sy / n, sz / n]);
    }
    if (centres.length < 2) return null;
    let total = 0;
    for (let i = 1; i < centres.length; i++) {
      const a = centres[i], b = centres[i - 1];
      total += Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    }
    const minutes = (centres.length * blockSec) / 60;
    return minutes > 0 ? total / minutes : null;
  }

  /*
   * Everything, for one session.
   *
   * `rows` is acc.csv as parsed: objects with tSec, x, y, z in mG. The sample rate is taken
   * from the data when it can be — a dropped BLE notification makes the nominal 50Hz a lie,
   * and every duration below would inherit that error.
   */
  function analyse(rows, opts = {}) {
    const list = (rows || []).filter((r) => r && isFiniteNum(Number(r.x)));
    const empty = {
      samples: list.length, hz: opts.hz || DEFAULT_HZ, durationSec: 0,
      stillFrac: null, events: [], eventsPerMin: null,
      medianPeakMg: null, medianDurSec: null, medianCrest: null, medianRiseFrac: null,
      swayMgPerMin: null, quietMg: opts.quietMg == null ? QUIET_MG : opts.quietMg,
      eventMg: opts.eventMg == null ? EVENT_MG : opts.eventMg,
      reason: 'not enough accelerometer data',
    };
    if (list.length < 50) return empty;

    /* THE MEASURED RATE, not the nominal one. acc.csv carries a time column precisely so this
       does not have to be assumed; if the times are unusable, fall back and say so. */
    const span = Number(list[list.length - 1].tSec) - Number(list[0].tSec);
    const measuredHz = span > 1 ? (list.length - 1) / span : null;
    const hz = opts.hz || (measuredHz && measuredHz > 5 && measuredHz < 500 ? measuredHz : DEFAULT_HZ);

    const change = changeSeries(list);
    const quietMg = opts.quietMg == null ? QUIET_MG : opts.quietMg;
    const usable = change.filter((v) => v != null);
    if (!usable.length) return Object.assign(empty, { hz, reason: 'accelerometer data unusable' });

    const stillFrac = usable.filter((v) => v < quietMg).length / usable.length;
    const eventMg = opts.eventMg == null ? EVENT_MG : opts.eventMg;
    const events = detectMovements(change, hz, Object.assign({}, opts, { quietMg, eventMg }));
    const durationSec = usable.length / hz;

    return {
      samples: list.length,
      hz,
      durationSec,
      quietMg,
      eventMg,
      /* THE HEADLINE, and the one number here that needs no interpretation at all: the share
         of the sit during which the head was not moving. */
      stillFrac,
      events,
      eventsPerMin: durationSec > 0 ? (events.length * 60) / durationSec : null,
      medianPeakMg: median(events.map((e) => e.peakMg)),
      medianDurSec: median(events.map((e) => e.durSec)),
      // The shape numbers — the actual test of "smoother in tempo when calm".
      medianCrest: median(events.map((e) => e.crest)),
      medianRiseFrac: median(events.map((e) => e.riseFrac)),
      swayMgPerMin: swayPerMin(list, hz),
      medianChangeMg: median(usable),
      reason: null,
    };
  }

  /*
   * A compact summary safe to store and compare, WITHOUT the event list.
   *
   * The events are useful for looking at one sit and useless in a table of twelve, and a
   * hundred of them per session is the kind of thing that quietly fills a browser's storage
   * quota. Same rule the lab already follows for raw EEG.
   */
  function summarise(analysis) {
    if (!analysis) return null;
    const keep = ['samples', 'hz', 'durationSec', 'quietMg', 'eventMg', 'stillFrac', 'eventsPerMin',
      'medianPeakMg', 'medianDurSec', 'medianCrest', 'medianRiseFrac', 'swayMgPerMin',
      'medianChangeMg', 'reason'];
    const out = { eventCount: (analysis.events || []).length };
    for (const k of keep) out[k] = analysis[k] == null ? null : analysis[k];
    return out;
  }

  /*
   * The comparison itself, for the question "these two sits felt different — did anything
   * measurable differ?"
   *
   * Differences and RATIOS, with no p-value anywhere, and that absence is the point. Two
   * sessions are two observations. A rank test across their one-second rows would report a
   * tiny p, and it would be meaningless twice over: rows within a session are heavily
   * autocorrelated so the effective count is a small fraction of the row count, and even with
   * that fixed, n = 2 sessions cannot separate "calmer" from "different day, different room,
   * different hour, different coffee". Describing the difference is honest. Testing it is not.
   */
  function compare(a, b, { keys = null } = {}) {
    const fields = keys || ['stillFrac', 'eventsPerMin', 'medianPeakMg', 'medianDurSec',
      'medianCrest', 'medianRiseFrac', 'swayMgPerMin', 'medianChangeMg'];
    const out = [];
    for (const k of fields) {
      const av = a ? a[k] : null, bv = b ? b[k] : null;
      if (av == null || bv == null) { out.push({ key: k, a: av, b: bv, delta: null, ratio: null }); continue; }
      out.push({
        key: k, a: av, b: bv,
        delta: bv - av,
        // Guarded: a zero baseline has no ratio, and reporting Infinity as a finding is worse
        // than reporting nothing.
        ratio: av !== 0 ? bv / av : null,
      });
    }
    return out;
  }

  const LABELS = {
    stillFrac: { label: 'Stillness', unit: 'share of the sit not moving', better: 'higher' },
    eventsPerMin: { label: 'Movements', unit: 'per minute', better: 'lower' },
    medianPeakMg: { label: 'Movement size', unit: 'mG at the peak', better: 'lower' },
    medianDurSec: { label: 'Movement length', unit: 'seconds', better: null },
    medianCrest: { label: 'Abruptness (crest)', unit: 'peak ÷ mean rate of change', better: 'lower' },
    medianRiseFrac: { label: 'Peak position', unit: '0.5 = symmetric, lower = front-loaded', better: null },
    swayMgPerMin: { label: 'Postural drift', unit: 'mG per minute', better: 'lower' },
    medianChangeMg: { label: 'Baseline motion', unit: 'mG per sample', better: 'lower' },
  };

  return { analyse, summarise, compare, detectMovements, changeSeries, swayPerMin, median,
    LABELS, QUIET_MG, EVENT_MG, DEFAULT_HZ };
});
