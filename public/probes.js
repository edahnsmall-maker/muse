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
  /*
   * The practitioner's own vocabulary, in their own words. This is the set that gets
   * pressed with the eyes shut, so it is the one that has to fit the practice rather
   * than the software.
   *
   * TWO THINGS WORTH NOTING ABOUT ITS SHAPE:
   *
   * `concentrating` and `absorbed` are the SAME degree of focus with and without
   * effort — the distinction a single focus score cannot make, and the reason effort is
   * a separate axis in labels.js. Having both as one-key marks means the moment of
   * crossing between them is recordable, which is the transition worth detecting.
   *
   * `returned` and `returned-effortless` are two different returns. Coming back to the
   * breath and coming back to not-working-at-it are different acts, and a detector that
   * fired on one would not necessarily fire on the other.
   *
   * ON KENSHO AND SATORI. These are here because they cost nothing to record and
   * because if a handful ever accumulate they are the most interesting data in the
   * project. But they will be far too rare to analyse for a very long time — an
   * event-locked average of three marks is noise with a shape — and NOTHING in this app
   * may ever claim to detect them. They are a record of what the practitioner reports,
   * full stop. The analysis will say "not enough events" for years, and that is
   * correct.
   *
   * Keys avoid M, T, N, V and F, which the app already binds, and avoid digits, which
   * belong to probe answers and grades.
   */
  const TAP_CATEGORIES = [
    {
      key: 'concentrating', kbd: 'C', label: 'Concentrating', arrow: 'ArrowUp',
      hint: 'gathering attention, with effort — starting to focus',
      grades: null,
    },
    {
      key: 'absorbed', kbd: 'A', label: 'Naturally concentrated',
      hint: 'still gathered, but it is holding itself — no work needed',
      grades: null,
    },
    {
      /* "i want to add Being as a note, or add it with shikantaza, so just update the text."
         Added to the label rather than as a new category: shikantaza, just sitting and being are one
         thing under three names, and a separate key for each would split one state's marks across
         three buckets — which is precisely what makes a sit unanalysable. */
      key: 'just-sitting', kbd: 'J', label: 'Just sitting / Being', arrow: 'ArrowDown',
      hint: 'shikantaza — effortless, nothing being done, no object being held',
      grades: null,
    },
    {
      // T, not L, and named "Thinking": it is the most-pressed category by a distance,
      // and the letter should match the word you say to yourself.
      key: 'lost', kbd: 'T', label: 'Thinking', arrow: 'ArrowRight',
      hint: 'gone — press when you notice, the mark is the noticing',
      grades: null,
    },
    {
      key: 'returned', kbd: 'R', label: 'Returned to the object', arrow: 'ArrowLeft',
      hint: 'back on the breath or whatever you are holding',
      grades: null,
    },
    {
      key: 'returned-effortless', kbd: 'E', label: 'Returned to effortlessness',
      hint: 'stopped working at it again — a different return from the one above',
      grades: null,
    },
    {
      key: 'restless', kbd: 'U', label: 'Restless',
      hint: 'unsettled, fidgety, agitated — body or mind',
      grades: [
        { value: 1, label: 'a bit', hint: 'noticeable but sittable' },
        { value: 2, label: 'badly', hint: 'hard to stay' },
      ],
    },
    {
      /* DROWSY, asked for and a real gap. Dullness is not restlessness and it is not
       * absorption, but on the EEG side it is the state most easily mistaken for calm —
       * theta and alpha both rise as you fade — so a score built on alpha cannot tell
       * settling from nodding off. This is the label that makes that distinction
       * testable, and without it a drowsy sit gets filed as a good one. */
      key: 'drowsy', kbd: 'D', label: 'Drowsy',
      hint: 'dull, sinking, fading — not calm, and the two look alike in the signal',
      grades: null,
    },
    {
      key: 'kensho', kbd: 'K', label: 'Kenshō',
      hint: 'a glimpse. Rare — recorded, never inferred, and never claimed by the app',
      grades: null,
    },
    {
      key: 'satori', kbd: 'S', label: 'Satori',
      hint: 'rarer still. Same rule: this is your report, not a measurement',
      grades: null,
    },
  ];

  const TAP_BY_KEY = TAP_CATEGORIES.reduce((m, t) => { m[t.key] = t; return m; }, {});
  /* Only categories that HAVE a letter. A double-tap category has kbd null, and without this guard
     it would be indexed under the string "null" and answer to nothing — or worse, shadow a real
     lookup if another ever shared that fate. */
  const TAP_BY_KBD = TAP_CATEGORIES.reduce((m, t) => {
    if (t.kbd) m[t.kbd] = t;
    return m;
  }, {});
  /* Every category is reachable by a deliberate keystroke now, so this is the whole list. Kept as a
     separate name because the mark bar and the key legend both mean "what can be pressed", and an
     earlier version had a category that could not be. */
  const PRIMARY_TAP_CATEGORIES = TAP_CATEGORIES.slice();

  /*
   * DOUBLE-TAP WINDOW. Two presses of the same category inside this become one mark of the
   * double-tap category instead of two of the original.
   *
   * 1500ms because the gesture has to survive being made with the eyes closed and attention
   * elsewhere, which is slower than a mouse double-click by a wide margin. The cost of it being
   * generous is that two genuine, separate notices of thinking 1.4s apart collapse into one — and
   * that is the right way to be wrong here, because noticing twice in 1.4 seconds is almost always
   * one event being reported twice.
   */
  const DOUBLE_TAP_MS = 1500;

  /*
   * Decide what a tap means given the tap before it.
   *
   * A DOUBLE TAP IS AN INTENSITY, NOT A DIFFERENT STATE. Asked for: "I would like double tapping in
   * general to signify extra strong of any state just like thinking." So pressing any category twice
   * quickly records THAT category, marked strong — rather than switching to a separate category, which
   * is what an earlier version did for Thinking alone.
   *
   * That reframing is the better one and not only because it generalises. A separate category per
   * intensity splits one state's marks across two buckets, and explore.js compares mark kinds BY
   * COUNTING them — so ten Thinkings of which four were strong would have been counted as six and four,
   * two thin sets instead of one usable one. As a flag the count is intact and the strength is still
   * there to filter on.
   *
   * THE SECOND PRESS REPLACES THE FIRST rather than adding to it, which is the part that has to be
   * right for the same reason: one event must be one mark.
   *
   * Returns { category, strong, replaces } where `replaces` is the id of the mark to remove, or null.
   */
  function doubleTap(catKey, { lastKey = null, lastAt = null, lastId = null, lastStrong = false,
    at = 0, windowMs = DOUBLE_TAP_MS } = {}) {
    const inWindow = lastKey === catKey && lastAt != null && (at - lastAt) <= windowMs
      && (at - lastAt) >= 0;
    /* A THIRD press does not climb further — there is no level above strong — and it must not toggle
       back either, or holding a key down flickers the strength of a mark that is already recorded.
       `lastStrong` is what makes press three a no-op instead of a downgrade. */
    if (inWindow && !lastStrong) {
      return { category: catKey, strong: true, replaces: lastId == null ? null : lastId, upgraded: true };
    }
    if (inWindow && lastStrong) {
      return { category: catKey, strong: true, replaces: null, upgraded: false, already: true };
    }
    return { category: catKey, strong: false, replaces: null, upgraded: false };
  }
  /*
   * ARROWS for the four most-used categories, asked for so the common taps can be reached
   * without finding a letter with your eyes shut:
   *
   *          up = concentrating (focusing)
   *   left = returned            right = thinking
   *        down = just sitting
   *
   * Aliases, not separate categories — the same key, the same record, so nothing
   * downstream has to know which finger produced a mark. The four with arrows are the
   * four you press most; the rarer ones (kenshō, satori, restless) stay letters, since a
   * rare mark is worth a deliberate keystroke.
   */
  const TAP_BY_ARROW = TAP_CATEGORIES.reduce((m, t) => {
    if (t.arrow) m[t.arrow] = t;
    return m;
  }, {});

  const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const ARROW_STORE_KEY = 'zenbio.arrowKeys';

  /*
   * WHICH CATEGORY EACH ARROW MARKS, overridable and remembered.
   *
   * Asked for: "i also think it would be nice to be able to assign letters to the arrow keys for ease.
   * like i can just put in a letter in a space and it ties that arrow key to the letter command."
   *
   * The four arrows are the only marks that can be made without looking, which makes them the ones
   * worth spending on the categories a given practice actually uses — and those differ between
   * practitioners and between retreats. The defaults above stay as defaults; this is an override.
   *
   * Stored by KEYBOARD LETTER rather than by category key, because the letter is what gets typed into
   * the box and what appears on the pill. Resolved through TAP_BY_KBD at read time, so a stored letter
   * for a category that no longer exists simply falls back instead of throwing.
   */
  function readArrowMap(storage) {
    const map = {};
    for (const a of ARROWS) if (TAP_BY_ARROW[a]) map[a] = TAP_BY_ARROW[a].kbd;
    try {
      const raw = (storage || localStorage).getItem(ARROW_STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const a of ARROWS) {
          const letter = String(saved && saved[a] || '').toUpperCase();
          // Only a letter that names a real category, so a stale or hand-edited value cannot bind an
          // arrow to nothing and make it silently dead.
          if (letter && TAP_BY_KBD[letter]) map[a] = letter;
          else if (saved && Object.prototype.hasOwnProperty.call(saved, a) && !letter) delete map[a];
        }
      }
    } catch (err) { /* private mode, or corrupt JSON: the defaults are a fine answer */ }
    return map;
  }

  function writeArrowMap(map, storage) {
    const out = {};
    for (const a of ARROWS) {
      const letter = String((map && map[a]) || '').toUpperCase();
      out[a] = letter && TAP_BY_KBD[letter] ? letter : '';
    }
    try { (storage || localStorage).setItem(ARROW_STORE_KEY, JSON.stringify(out)); }
    catch (err) { /* the binding still applies for this session */ }
    return out;
  }

  // The category an arrow marks right now, or null if that arrow is deliberately unbound.
  function tapForArrow(arrowKey, storage) {
    const letter = readArrowMap(storage)[arrowKey];
    return letter ? (TAP_BY_KBD[letter] || null) : null;
  }
  // The glyph to show beside a category, so the panel can teach the mapping.
  const ARROW_GLYPH = {
    ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
  };

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
    TAP_CATEGORIES, TAP_BY_KEY, TAP_BY_KBD, TAP_BY_ARROW, ARROW_GLYPH,
    PRIMARY_TAP_CATEGORIES, DOUBLE_TAP_MS, doubleTap,
    ARROWS, ARROW_STORE_KEY, readArrowMap, writeArrowMap, tapForArrow,
    DEFAULTS, schedule, dueProbe, windowFor, unitsFromProbes, metaAwarenessGap,
    seededRandom,
  };
});
