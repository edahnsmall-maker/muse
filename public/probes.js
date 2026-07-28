/*
 * The labelling protocol: how a sit produces usable data fast.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF LABEL, WITH DIFFERENT BIASES. Both are needed.
 *
 * SELF-CAUGHT. You notice something and mark it. Cheap, precise in time, and it gives
 * the exact moment of an event — the instant of coming back, which is the thing a
 * detector would have to fire on. But it is systematically biased: you can only mark
 * what you NOTICE, and noticing is itself a skill that varies. A sit with few marks
 * might be a steady sit or a sit so lost that nothing got caught, and self-caught
 * marks alone cannot tell those apart. It can never sample the state "gone, and not
 * aware of being gone", because by definition that state produces no mark.
 *
 * PROBE-CAUGHT. A cue interrupts at an unpredictable moment and you report what was
 * happening. Unbiased with respect to your meta-awareness, because the sampling is
 * decided by a clock rather than by whether you noticed. It is the only way to
 * observe the states that go unnoticed, and it gives a PROPORTION rather than a
 * count — "off the object 40% of the time" instead of "caught myself nine times".
 *
 * Put together they measure something neither can alone: the gap between how often
 * you were actually wandering (probe-caught) and how often you caught it
 * (self-caught) IS a measure of meta-awareness. See `metaAwarenessGap` below.
 *
 * ---------------------------------------------------------------------------
 * FOUR DESIGN RULES, each of which changes what the data means
 *
 * 1. PROBE INTERVALS MUST BE RANDOM. A cue every two minutes exactly becomes a cue
 *    you wait for, and waiting for it is a different mental state from the one being
 *    sampled. Jittered intervals make the sample unpredictable and therefore
 *    representative.
 * 2. THE PROBE ASKS ABOUT THE MOMENT BEFORE IT. The cue itself interrupts and
 *    redirects attention, so "what is happening now" samples the interruption. The
 *    question has to be "where was your attention just before this sound".
 * 3. THE LABELLED DATA IS THE WINDOW BEFORE THE PROBE, and the seconds after are
 *    EXCLUDED. Answering is a deliberate cognitive act — reading, choosing, tapping —
 *    and including it would mix the response into the state it describes.
 * 4. ONE TAP. A probe that takes twenty seconds and four scales destroys the sit it
 *    is measuring. Five options, one tap, no reading required after the first few.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Probes = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * Probe responses. Five, chosen so the whole set can be held in mind and answered
   * without reading — which is what makes a one-tap answer possible.
   *
   * The distinction that earns its place here is `aware` vs `unaware`: being off the
   * object and knowing it, versus discovering it only when the cue arrived. Those feel
   * different, plausibly look different, and the second is the state self-caught
   * marking can never sample. Collapsing them would throw away the one thing probes
   * are uniquely for.
   *
   * `dull` is separate from both because it is neither focused nor thinking — a state
   * a single scattered/focused axis has nowhere to put, and one that a "calm" score
   * built on alpha may well score highly, which is worth being able to catch.
   */
  const RESPONSES = [
    { key: 'on', kbd: '1', label: 'With it',
      hint: 'attention was on the object', onTask: true, aware: true },
    { key: 'aware-off', kbd: '2', label: 'Off, and I knew',
      hint: 'drifted, and I was aware of drifting', onTask: false, aware: true },
    { key: 'unaware-off', kbd: '3', label: 'Off, just realised',
      hint: 'gone, and only the cue told me — the state self-catching cannot see',
      onTask: false, aware: false },
    { key: 'waterfall', kbd: '4', label: 'Waterfall',
      hint: 'thought after thought, no gap', onTask: false, aware: false },
    { key: 'dull', kbd: '5', label: 'Dull / blank',
      hint: 'not thinking, but not present either — drowsy, foggy',
      onTask: false, aware: true },
  ];
  const RESPONSE_BY_KEY = RESPONSES.reduce((m, r) => { m[r.key] = r; return m; }, {});
  const RESPONSE_BY_KBD = RESPONSES.reduce((m, r) => { m[r.kbd] = r; return m; }, {});

  /*
   * Armed tap categories: the self-caught side.
   *
   * "Armed" means you choose the category ONCE, before or during the sit, and then
   * every tap records that category with no further decision. Choosing per tap sounds
   * more informative and is worse: the choosing is a deliberative act in the middle of
   * a sit, it takes seconds, and it biases towards whichever option is easiest to
   * find. One key, one meaning, no menu.
   *
   * `grades` allow a second, optional press to say how far it went — the difference
   * between beginning to loosen and complete effortlessness, which is a real
   * distinction and a rare event worth being able to mark as rare.
   */
  const TAP_CATEGORIES = [
    {
      key: 'returned', kbd: 'R', label: 'Noticed I was thinking',
      hint: 'the moment of catching it — tap as soon as you realise',
      grades: null,
    },
    {
      key: 'letting-go', kbd: 'E', label: 'Effort dropping',
      hint: 'the grip loosening, or letting go entirely',
      grades: [
        { value: 1, label: 'loosening', hint: 'still working, but less' },
        { value: 2, label: 'effortless', hint: 'nothing being held at all — rare' },
      ],
    },
    {
      key: 'tightening', kbd: 'K', label: 'Tightening',
      hint: 'closing down, straining, contraction',
      grades: [
        { value: 1, label: 'a little', hint: 'a touch of strain' },
        { value: 2, label: 'gripping', hint: 'clamped down' },
      ],
    },
    {
      key: 'opening', kbd: 'D', label: 'Opening / dropping in',
      hint: 'a sudden widening or deepening',
      grades: [
        { value: 1, label: 'a shift', hint: 'something changed' },
        { value: 2, label: 'dropped right in', hint: 'unmistakable — rare' },
      ],
    },
  ];
  const TAP_BY_KEY = TAP_CATEGORIES.reduce((m, t) => { m[t.key] = t; return m; }, {});
  const TAP_BY_KBD = TAP_CATEGORIES.reduce((m, t) => { m[t.kbd] = t; return m; }, {});

  const DEFAULTS = {
    minGapSec: 90,      // never two probes closer than this
    maxGapSec: 240,     // and never so far apart that a 20-minute sit gets one
    firstGapSec: 60,    // a little time to settle before the first
    preWindowSec: 30,   // the stretch a probe's answer describes
    postExcludeSec: 20, // contaminated by the act of answering
    responseTimeoutSec: 25,
  };

  function seededRandom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 0x100000000;
    };
  }

  /*
   * Probe times for a sit of known length.
   *
   * Precomputed rather than decided as the sit goes, so the schedule is a property of
   * the session and appears in the export — an analysis can then tell a probe that was
   * MISSED from a probe that was never scheduled, which are very different facts.
   *
   * Seeded, so a schedule is reproducible; jittered, so it is unpredictable to the
   * person sitting. Both at once.
   */
  function schedule(durationSec, opts = {}) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const rnd = seededRandom(cfg.seed || 1);
    const times = [];
    let t = cfg.firstGapSec + rnd() * (cfg.maxGapSec - cfg.minGapSec) * 0.5;
    while (t < durationSec - cfg.postExcludeSec) {
      times.push(Math.round(t));
      t += cfg.minGapSec + rnd() * (cfg.maxGapSec - cfg.minGapSec);
    }
    return times;
  }

  // Due now? Compares against the schedule rather than a running timer, so a paused or
  // reloaded page cannot drift the schedule out of step with what was exported.
  function dueProbe(times, answeredCount, tSec) {
    if (answeredCount >= times.length) return null;
    const at = times[answeredCount];
    return tSec >= at ? { index: answeredCount, atSec: at } : null;
  }

  /*
   * The analysis window for a probe: the stretch BEFORE it.
   *
   * Bounded below by the previous probe's exclusion, so two probes close together
   * cannot both claim the same seconds — double-counting a stretch would make two
   * observations out of one piece of evidence.
   */
  function windowFor(probeAtSec, { prevProbeAtSec = null } = {}, opts = {}) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    let from = probeAtSec - cfg.preWindowSec;
    if (prevProbeAtSec != null) from = Math.max(from, prevProbeAtSec + cfg.postExcludeSec);
    from = Math.max(0, from);
    // A window squeezed to nothing is not a window. Refusing is better than emitting a
    // one-second average and calling it a 30-second state.
    if (probeAtSec - from < 8) return null;
    return { fromSec: from, toSec: probeAtSec };
  }

  /*
   * Probe answers to analysis units.
   *
   * Two labels per probe, both derived from the same tap: `onTask` (was attention on
   * the object) and `aware` (did you know where it was). Separating them is what makes
   * "gone and knew it" distinguishable from "gone and didn't", which is the whole
   * reason for probing.
   *
   * `latencySec` becomes a FEATURE, not a label. How long somebody takes to answer is
   * itself informative — a slow answer suggests further to come back from — but it is
   * behaviour rather than self-report, so it belongs with the measurements.
   */
  function unitsFromProbes(answers, metrics, { sessionId = 'sit', opts = {} } = {}) {
    const sorted = (answers || []).slice().sort((a, b) => a.atSec - b.atSec);
    const units = [];
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const r = RESPONSE_BY_KEY[a.response];
      if (!r) continue;
      const win = windowFor(a.atSec, { prevProbeAtSec: i > 0 ? sorted[i - 1].atSec : null }, opts);
      if (!win) continue;
      const rows = (metrics || []).filter((row) => row && row.t != null
        && row.t >= win.fromSec && row.t < win.toSec);
      if (!rows.length) continue;
      const features = {};
      for (const key of Object.keys(rows[0])) {
        if (key === 't' || key === 'epochMs' || key === 'levels') continue;
        const vals = rows.map((row) => row[key]).filter((v) => v != null && Number.isFinite(v));
        if (vals.length) features[key] = vals.reduce((x, y) => x + y, 0) / vals.length;
      }
      if (!Object.keys(features).length) continue;
      if (a.latencySec != null) features.probeLatency = a.latencySec;
      units.push({
        sessionId, features,
        labels: { onTask: r.onTask ? 1 : 0, aware: r.aware ? 1 : 0 },
        response: r.key, fromSec: win.fromSec, toSec: win.toSec, samples: rows.length,
      });
    }
    return units;
  }

  /*
   * The meta-awareness gap.
   *
   * Probes say what proportion of the time attention was off the object. Self-caught
   * taps say how often you noticed. If you were off 40% of a 20-minute sit but caught
   * yourself three times, a great deal went unnoticed — and that difference is a
   * measure of meta-awareness rather than of concentration.
   *
   * Reported with its own n, and refused below a handful of probes, because a
   * proportion from three samples is not a proportion. This is the number most at risk
   * of being over-interpreted, so it carries its uncertainty rather than standing
   * alone.
   */
  function metaAwarenessGap({ answers = [], selfCaughtCount = 0, durationSec = null } = {}) {
    const valid = answers.filter((a) => RESPONSE_BY_KEY[a.response]);
    if (valid.length < 5 || !durationSec) {
      return { ok: false, probes: valid.length,
        reason: valid.length < 5 ? 'fewer than 5 probes — a proportion needs more'
          : 'session length unknown' };
    }
    const off = valid.filter((a) => !RESPONSE_BY_KEY[a.response].onTask);
    const unaware = valid.filter((a) => !RESPONSE_BY_KEY[a.response].aware);
    const offFraction = off.length / valid.length;
    // Episodes implied by the probes, from the time spent off and a typical episode
    // length. A rough conversion and labelled as such — the honest comparison is the
    // DIRECTION of the gap, not its exact size.
    const minutesOff = (offFraction * durationSec) / 60;
    return {
      ok: true,
      probes: valid.length,
      offFraction,
      unawareFraction: unaware.length / valid.length,
      minutesOff,
      selfCaughtCount,
      selfCaughtPerMinuteOff: minutesOff > 0 ? selfCaughtCount / minutesOff : null,
      note: 'A low catch rate against a high off-task fraction means much of the'
        + ' wandering went unnoticed. That is a statement about meta-awareness, not'
        + ' about concentration — and both are worth tracking separately.',
    };
  }

  return {
    RESPONSES, RESPONSE_BY_KEY, RESPONSE_BY_KBD,
    TAP_CATEGORIES, TAP_BY_KEY, TAP_BY_KBD,
    DEFAULTS, schedule, dueProbe, windowFor, unitsFromProbes, metaAwarenessGap,
    seededRandom,
  };
});
