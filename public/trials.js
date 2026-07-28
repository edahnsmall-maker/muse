/*
 * Calibration trials — guided protocols where the INSTRUCTION IS THE LABEL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE MOST IMPORTANT FILE IN THE PROJECT
 *
 * Every score the app shows is unvalidated, and the reason it has stayed that way is
 * that labels are scarce. Waiting for interesting moments to happen and describing
 * them afterwards produces a handful of soft, retrospective judgements per sit — so
 * validation is months away and the judgements are contaminated by whatever the
 * screen was showing at the time.
 *
 * A trial inverts that. The experimenter decides the condition IN ADVANCE and the
 * meditator follows an instruction, so the label is known before any data arrives and
 * cannot be coloured by it. Twenty minutes of alternating blocks yields twenty
 * labelled observations with a hard ground truth, which is more usable evidence than
 * a month of retrospective notes.
 *
 * ---------------------------------------------------------------------------
 * THE POSITIVE CONTROL COMES FIRST, and it is not a meditation trial at all
 *
 * `alpha-control` alternates eyes closed and eyes open. Alpha power over posterior
 * channels rises markedly when the eyes close and drops when they open — the Berger
 * effect, known since the 1920s, one of the most reliable findings in
 * electroencephalography, and entirely independent of anything about meditation.
 *
 * So it is a check on the APPARATUS rather than on the practitioner. If this pipeline
 * cannot recover eyes-closed alpha, then the electrodes, the filtering, the band
 * calculations, the timing, or the export is broken — and every subtle meditation
 * finding produced by the same pipeline is worthless regardless of how good it looks.
 * If it CAN, the machinery is sound and a null result on a meditation trial is a fact
 * about meditation rather than a fact about the wiring.
 *
 * This is the same principle that rescued the accelerometer work. Gravity has no
 * loyalty to a decoder; the Berger effect has no loyalty to this app. Find the ground
 * truth you do not control, and check against that first.
 *
 * RUN IT BEFORE ANY OTHER TRIAL, and again whenever the results start looking
 * surprising.
 *
 * ---------------------------------------------------------------------------
 * COUNTERBALANCING is not decoration
 *
 * Blocks alternate rather than running all of one condition then all of the other,
 * because a sit drifts: people settle, get drowsy, get uncomfortable, and electrodes
 * dry out. Ten minutes of A followed by ten of B would confound the condition with
 * time-in-sit perfectly, and the difference found would be indistinguishable from
 * "later in the sit". Alternating, and starting on a side that varies between
 * sessions, is what makes the comparison about the condition.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Trials = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * Instructions are written to be followed with the eyes closed and the mind
   * unsteady: short, concrete, and about what to DO. "Maintain meta-awareness of
   * attentional set" is not an instruction anybody can obey mid-sit.
   *
   * `settleSec` is dead time after each cue, excluded from analysis. A block boundary
   * is not instantaneous — it takes a few seconds to actually start deliberately
   * thinking, and including that transition in either condition blurs both.
   */
  const PROTOCOLS = [
    {
      key: 'alpha-control',
      label: 'Eyes closed / open',
      purpose: 'positive control — does the apparatus work at all?',
      blurb: 'Alpha rises when the eyes close. This is textbook and has nothing to do'
        + ' with meditation, so it checks the equipment rather than you. Run it first,'
        + ' and again whenever a result looks surprising.',
      expectation: 'alpha (and calm, which is built on it) should be clearly HIGHER in'
        + ' the eyes-closed blocks. If it is not, something in the signal chain is'
        + ' wrong and no other trial here can be trusted.',
      blockSec: 30,
      settleSec: 4,
      repeats: 6,
      conditions: [
        { key: 'closed', label: 'Eyes closed', instruction: 'Close your eyes. Rest.' },
        { key: 'open', label: 'Eyes open', instruction: 'Open your eyes. Look at one spot, softly.' },
      ],
    },
    {
      key: 'think-breath',
      label: 'Deliberate thinking / breath',
      purpose: 'does the thinking score detect thinking?',
      blurb: 'Alternate between thinking on purpose and following the breath. Because'
        + ' the condition is chosen in advance, the label cannot be influenced by what'
        + ' the screen is showing.',
      expectation: 'if `thinking` cannot separate these blocks, it does not measure'
        + ' thinking — whatever else it may be measuring.',
      blockSec: 60,
      settleSec: 6,
      repeats: 5,
      conditions: [
        { key: 'thinking', label: 'Think on purpose',
          instruction: 'Plan something in detail. Words, in your head, deliberately.' },
        { key: 'breath', label: 'Follow the breath',
          instruction: 'Just the breath. Let thoughts go as they arrive.' },
      ],
    },
    {
      key: 'effort-contrast',
      label: 'Effortful / effortless focus',
      purpose: 'are the two kinds of focus distinguishable?',
      blurb: 'Both blocks are focused. One holds attention by force, the other rests'
        + ' in it. This is the distinction a single focus score cannot make, and the'
        + ' one worth the whole exercise.',
      expectation: 'a score that reads both blocks the same is measuring focus but not'
        + ' effort — which means "absorbed" and "concentrating" look identical to it.',
      blockSec: 60,
      settleSec: 8,
      repeats: 4,
      conditions: [
        { key: 'effortful', label: 'Hold it tightly',
          instruction: 'Grip the breath. Do not let attention move at all.' },
        { key: 'effortless', label: 'Let it rest',
          instruction: 'Stay with the breath, but stop working. Let it hold itself.' },
      ],
    },
    {
      key: 'return-count',
      label: 'Count the returns',
      purpose: 'ground truth for the moment of coming back',
      blurb: 'One long block. Press R every time you notice you have come back. No'
        + ' judging, no counting in your head — the keypress is the record.',
      expectation: 'gives timestamped moments to test any "returning" or "caught'
        + ' thinking" detector against. Also measures your own return rate, which is'
        + ' worth knowing on its own.',
      blockSec: 600,
      settleSec: 10,
      repeats: 1,
      conditions: [
        { key: 'open-monitoring', label: 'Sit, and mark each return',
          instruction: 'Follow the breath. Press R the moment you notice you had left.' },
      ],
    },
  ];

  const BY_KEY = PROTOCOLS.reduce((m, p) => { m[p.key] = p; return m; }, {});

  /*
   * Build the block sequence for a run.
   *
   * `startWith` alternates between runs rather than being random, because with four
   * or six repeats a random start can easily give the same side several sessions
   * running, and then order and condition are confounded across the whole dataset
   * rather than within one sit. Deterministic alternation guarantees balance.
   *
   * Every block carries the absolute times it covers AND an `analyseFrom` that skips
   * the settling period, so the analysis never has to re-derive the exclusion — and
   * cannot forget to.
   */
  function buildBlocks(protocolKey, { startWith = 0, offsetSec = 0 } = {}) {
    const p = BY_KEY[protocolKey];
    if (!p) return null;
    const blocks = [];
    let t = offsetSec;
    const n = p.conditions.length;
    for (let r = 0; r < p.repeats; r++) {
      for (let i = 0; i < n; i++) {
        const cond = p.conditions[(i + startWith) % n];
        blocks.push({
          index: blocks.length,
          repeat: r,
          condition: cond.key,
          label: cond.label,
          instruction: cond.instruction,
          fromSec: t,
          // The settling period belongs to no condition. Including it would blur both.
          analyseFromSec: t + p.settleSec,
          toSec: t + p.blockSec,
          settleSec: p.settleSec,
        });
        t += p.blockSec;
      }
    }
    return { protocol: p, blocks, totalSec: t - offsetSec, startWith };
  }

  // Total wall time, so the UI can say how long a protocol takes before it starts
  // rather than after.
  function durationSec(protocolKey) {
    const b = buildBlocks(protocolKey);
    return b ? b.totalSec : null;
  }

  /*
   * Which block is active at a given time, and how long until the next cue.
   *
   * Pure, so the runner's behaviour is testable without a clock or a page. `phase` is
   * 'settling' or 'recording' — the UI shows both, because a meditator being told
   * "this bit does not count" is more likely to actually change what they are doing
   * before it does.
   */
  function blockAt(run, tSec) {
    if (!run || !run.blocks.length) return null;
    const b = run.blocks.find((x) => tSec >= x.fromSec && tSec < x.toSec);
    if (!b) return null;
    return {
      block: b,
      phase: tSec < b.analyseFromSec ? 'settling' : 'recording',
      remainingSec: Math.max(0, b.toSec - tSec),
      elapsedSec: tSec - b.fromSec,
      isLast: b.index === run.blocks.length - 1,
    };
  }

  /*
   * True exactly on a boundary crossing, so a cue fires once rather than every tick.
   *
   * `prevSec == null` means the run has just STARTED, and that is a crossing into the
   * first block — not "no crossing". The first version returned null there, which
   * meant block 0 got no cue and no record: the meditator never heard the tone that
   * begins the protocol, and the opening block's label was missing from the data
   * entirely. Every subsequent block was fine, which is exactly the kind of bug that
   * survives a casual look at the output.
   */
  function crossedBoundary(run, prevSec, nowSec) {
    if (!run) return null;
    if (prevSec == null) {
      return run.blocks.find((b) => nowSec >= b.fromSec && nowSec < b.toSec) || null;
    }
    for (const b of run.blocks) {
      if (prevSec < b.fromSec && nowSec >= b.fromSec) return b;
    }
    return null;
  }

  /*
   * Turn a finished run into analysis units.
   *
   * One observation PER BLOCK, with the settling period excluded — matching what
   * `unitsFromSpans` does for hand-labelled spans, and for the same reason: a 60-second
   * block is one observation about that block, not sixty.
   *
   * The condition is emitted as `labels.condition`, an ordinal index rather than a
   * string, so it can go straight into a rank correlation. Two conditions become 0/1,
   * which for Spearman is a rank-biserial comparison — exactly the right test for
   * "does this feature differ between two groups".
   */
  function unitsFromRun(run, metrics, { sessionId = 'trial' } = {}) {
    if (!run || !metrics) return [];
    const order = run.protocol.conditions.map((c) => c.key);
    const units = [];
    for (const b of run.blocks) {
      const rows = metrics.filter((r) => r && r.t != null
        && r.t >= b.analyseFromSec && r.t < b.toSec);
      if (!rows.length) continue;
      const features = {};
      for (const key of Object.keys(rows[0])) {
        if (key === 't' || key === 'epochMs' || key === 'levels') continue;
        const vals = rows.map((r) => r[key]).filter((v) => v != null && Number.isFinite(v));
        if (vals.length) features[key] = vals.reduce((a, c) => a + c, 0) / vals.length;
      }
      if (!Object.keys(features).length) continue;
      units.push({
        // Blocks within one sit are NOT independent sessions. Using the real session
        // id keeps the held-out split honest: a trial run in one sit cannot validate
        // itself, and pretending each block is a session would leak badly.
        sessionId,
        features,
        labels: { condition: order.indexOf(b.condition) },
        conditionKey: b.condition,
        blockIndex: b.index,
        fromSec: b.analyseFromSec,
        toSec: b.toSec,
        samples: rows.length,
      });
    }
    return units;
  }

  /*
   * The plain-language read on a control trial: did the expected effect appear?
   *
   * Deliberately narrow. It reports the direction and size of the difference in one
   * named feature between two conditions and NOTHING about significance, because with
   * six blocks a p-value would be theatre. The point is to catch a broken apparatus,
   * where the effect is either obvious or absent.
   */
  function controlCheck(units, { feature = 'calm', expectHigherIn = 'closed' } = {}) {
    const a = units.filter((u) => u.conditionKey === expectHigherIn)
      .map((u) => u.features[feature]).filter((v) => v != null);
    const others = units.filter((u) => u.conditionKey !== expectHigherIn)
      .map((u) => u.features[feature]).filter((v) => v != null);
    if (a.length < 2 || others.length < 2) {
      return { ok: null, reason: `not enough blocks with a ${feature} value`, feature };
    }
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = (xs) => {
      const m = mean(xs);
      return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
    };
    const mA = mean(a), mB = mean(others);
    // Pooled SD, so the difference is reported in units of the variation actually
    // present rather than as a bare gap that could be anything.
    const pooled = Math.sqrt((sd(a) ** 2 + sd(others) ** 2) / 2);
    const diff = mA - mB;
    /* ZERO WITHIN-CONDITION VARIANCE IS NOT "UNMEASURABLE".
     *
     * If every closed block reads 0.7 and every open block 0.3, the effect size is
     * formally infinite — the conditions are perfectly separated, which is the
     * STRONGEST possible result, not an absent one. The first version of this returned
     * null there and would have reported a flawless control as untestable.
     *
     * Genuinely unmeasurable is the other case: no variance AND no difference, where
     * the feature is simply constant. That has to fail, because a constant cannot be
     * tracking a large known effect.
     */
    const degenerate = pooled <= 1e-9;
    const separated = Math.abs(diff) > 1e-9;
    const d = degenerate ? (separated ? Infinity * Math.sign(diff) : 0) : diff / pooled;
    return {
      feature,
      expectHigherIn,
      meanExpected: mA,
      meanOther: mB,
      difference: diff,
      effectSize: d,
      // A generous threshold on purpose: this is a broken-equipment detector, not a
      // significance test. The Berger effect is large, so a small or reversed
      // difference is the interesting outcome.
      ok: d > 0.5,
      reason: (degenerate && !separated)
        ? `${feature} is constant across both conditions — it cannot be tracking anything`
        : null,
    };
  }

  return {
    PROTOCOLS, BY_KEY, buildBlocks, durationSec, blockAt, crossedBoundary,
    unitsFromRun, controlCheck,
  };
});
