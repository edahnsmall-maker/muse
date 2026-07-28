/*
 * The phenomenological schema: what a sit is being labelled ON.
 *
 * WHY THIS IS A FILE AND NOT A DROPDOWN. Everything else in this project measures
 * something. This is the only place that says what the measurements are supposed to
 * be *about*, and it comes from the person practising rather than from the signal
 * processing. If these categories are wrong, no amount of correlation will help:
 * you will find real structure in the data and attach the wrong word to it.
 *
 * These labels are GROUND TRUTH. Nothing in this app may generate them, infer them,
 * or fill them in as a default — a self-report is the one thing here that isn't a
 * guess, and the moment the software starts suggesting them that stops being true.
 *
 * ---------------------------------------------------------------------------
 * THE STRUCTURE, and the reason it is two axes rather than one scale
 *
 * "How good was the sit" collapses two things that come apart in practice:
 *
 *                     effortless
 *                         |
 *        drifting  . . . . . . . .  absorbed
 *      (loose, dreamy)     |      (settled, no work needed)
 *   scattered ------------ + ------------ one-pointed
 *        struggling . . . . . . . .  concentrating
 *      (fighting the mind) |       (holding it by force)
 *                         |
 *                      effortful
 *
 * Both right-hand states are "focused" and a single score cannot tell them apart —
 * but they are different experiences, and plausibly different signals. Both left-hand
 * states are "unfocused" and equally distinct from each other. That 2x2 is the first
 * real hypothesis this app can test, and it is testable precisely because effort and
 * focus are recorded separately.
 *
 * Two more dimensions, which are not about attention but change what attention does:
 *
 *   PULL       whether thoughts are FOLLOWED, not whether they are present. Thoughts
 *              can be loud and ignorable, or quiet and utterly compelling. This is
 *              the distinction that matters in practice and the one a "thinking"
 *              score cannot make: an amplitude cannot tell you whether you went with
 *              it. Reported as "stickiness" or "attachment".
 *   TONE       the emotional colour. Affects everything else and is not reducible to
 *              it: a pleasant scattered sit and an unpleasant scattered sit are not
 *              the same sit.
 *
 * The far negative end of FOCUS gets its own anchor rather than just "very
 * scattered", because it is qualitatively different: not drifting between thoughts
 * but being hit by them one after another. Described as the waterfall.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Labels = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * Each dimension is 1..5 with EVERY point named.
   *
   * Named, not just the ends, because "3 out of 5" means whatever the rater felt
   * that day, and a scale whose middle is undefined drifts between sits — which
   * destroys exactly the across-sit comparison the numbers exist for. Naming all
   * five costs nothing and makes the scale mean the same thing in week six.
   *
   * The wording is the practitioner's own, deliberately. Rewriting it into clinical
   * language would make the labels easier to publish and harder to give honestly.
   */
  const DIMENSIONS = [
    {
      key: 'focus',
      label: 'Focus',
      question: 'Where was attention?',
      // 1 is the waterfall end: not merely unfocused, actively pummelled.
      anchors: [
        'waterfall — thought after thought, no gap',
        'wandering — off somewhere, noticing late',
        'in and out — coming back repeatedly',
        'collected — mostly here, small drifts',
        'one-pointed — steady on the object',
      ],
    },
    {
      key: 'effort',
      label: 'Effort',
      question: 'How much work was it?',
      anchors: [
        'effortless — nothing to do',
        'light — a touch of intention',
        'working — steady application',
        'straining — holding it together',
        'forcing — fighting to stay',
      ],
    },
    {
      key: 'pull',
      label: 'Pull',
      question: 'Did thoughts grab you?',
      // NOT how much thinking there was. Whether it took you.
      anchors: [
        'transparent — thoughts passed through',
        'noticeable — present, easy to leave',
        'tugging — went along a little',
        'gripping — followed most of them',
        'swept — gone with them entirely',
      ],
    },
    {
      key: 'tone',
      label: 'Tone',
      question: 'What was the emotional colour?',
      anchors: [
        'difficult — grief, fear, irritation',
        'uneasy — restless, tight',
        'neutral — plain, uncoloured',
        'pleasant — warm, at ease',
        'luminous — joy, openness',
      ],
    },
  ];

  const BY_KEY = DIMENSIONS.reduce((m, d) => { m[d.key] = d; return m; }, {});

  /*
   * The four quadrants of focus x effort, named so a finding can be stated in
   * words. These are HYPOTHESES about states worth telling apart, not classes the
   * software assigns: the quadrant is derived from what was self-reported.
   *
   * `absorbed` is the one worth the whole exercise — focused with nothing being
   * held — and it is exactly the one a single "calm" or "focus" score cannot
   * distinguish from `concentrating`.
   */
  const QUADRANTS = {
    absorbed: 'focused, and no work being done',
    concentrating: 'focused, but holding it by force',
    drifting: 'unfocused, and not trying',
    struggling: 'unfocused, and fighting it',
  };

  // Midpoint counts as neither side: 3 is the honest "in between", and forcing it
  // into a quadrant would invent a distinction the rater did not make.
  function quadrant({ focus = null, effort = null } = {}) {
    if (focus == null || effort == null || focus === 3 || effort === 3) return null;
    const focused = focus > 3;
    const effortful = effort > 3;
    if (focused) return effortful ? 'concentrating' : 'absorbed';
    return effortful ? 'struggling' : 'drifting';
  }

  /*
   * Transitions — the events, as opposed to the states above.
   *
   * These are the highest-value labels available, and the cheapest: a single
   * keystroke, no menu, no typing, nothing to compose while sitting. "I press a key
   * every time I notice I have come back" is a complete experimental protocol, and
   * it produces the one thing every score here needs — a timestamped moment where a
   * human says what happened.
   *
   * `returned` is deliberately separate from `lost`. They are not two views of one
   * event: noticing you have been gone and re-establishing attention are different
   * moments, sometimes seconds apart, and which one a signal tracks is a real
   * question rather than a labelling detail.
   */
  /*
   * SUPERSEDED BY probes.js TAP_CATEGORIES, which is the authority on keys and adds
   * grades. Kept only so the export and the markdown can name a transition in words,
   * and kept in sync with that file by test-labels.js — two vocabularies for one event
   * silently disagreed about what R, D and K meant, which is worse than either alone.
   */
  const TRANSITIONS = [
    { key: 'returned', label: 'Noticed I was thinking', kbd: 'R',
      hint: 'attention re-established on the object' },
    { key: 'lost', label: 'Gone, only now realised', kbd: 'G',
      hint: 'the moment of realising, not the leaving' },
    { key: 'opening', label: 'Opening / dropping in', kbd: 'D',
      hint: 'a sudden opening or deepening' },
    { key: 'tightening', label: 'Tightening', kbd: 'K',
      hint: 'closed down, effort spiked, contraction' },
    { key: 'letting-go', label: 'Effort dropping', kbd: 'E',
      hint: 'the grip loosening, or letting go entirely' },
  ];

  const TRANSITION_BY_KEY = TRANSITIONS.reduce((m, t) => { m[t.key] = t; return m; }, {});
  const TRANSITION_BY_KBD = TRANSITIONS.reduce((m, t) => { m[t.kbd] = t; return m; }, {});

  // A rating is valid only if it is an integer 1..5. Anything else is refused rather
  // than coerced: a label that was not actually given must not become a 3.
  function validRating(v) {
    return Number.isInteger(v) && v >= 1 && v <= 5;
  }

  /*
   * Normalise a set of dimension ratings, dropping anything invalid or absent.
   *
   * PARTIAL IS FINE and must stay fine. Someone who is sure about focus and unsure
   * about tone should record focus alone; requiring all four would produce four
   * guesses instead of one observation. Absent is a meaningful value here — it means
   * "not reported" and must never be filled in.
   */
  function normalise(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const d of DIMENSIONS) {
      const v = raw[d.key];
      if (validRating(v)) out[d.key] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  // The anchor text for a rating, for display and for the export. Returns null
  // rather than a placeholder when nothing was reported.
  function describe(key, value) {
    const d = BY_KEY[key];
    if (!d || !validRating(value)) return null;
    return d.anchors[value - 1];
  }

  // One line summarising a set of ratings, for the markdown export and the readout.
  function summarise(dims) {
    const norm = normalise(dims);
    if (!norm) return null;
    const parts = DIMENSIONS
      .filter((d) => norm[d.key] != null)
      .map((d) => `${d.label} ${norm[d.key]}/5 (${describe(d.key, norm[d.key])})`);
    const q = quadrant(norm);
    return parts.join(' · ') + (q ? ` — ${q}` : '');
  }

  /*
   * Split labelled spans out of a list of notes, for the analysis side.
   *
   * A dimensional label applies from when it was given back to the previous one (or
   * to the start of the sit), because that is the interval the rater was describing
   * — you rate the stretch you just sat through, not the instant you pressed the
   * button. Whole-sit labels (`anchored === false`) cover everything and are
   * returned separately rather than being turned into a span, since treating a
   * closing reflection as if it described one moment would be a fabrication.
   */
  function spans(notes, { durationSec = null } = {}) {
    const list = (notes || [])
      .filter((n) => n && normalise(n.dims) && n.anchored !== false)
      .sort((a, b) => (a.offsetSec || 0) - (b.offsetSec || 0));
    const wholeSit = (notes || [])
      .filter((n) => n && normalise(n.dims) && n.anchored === false)
      .map((n) => ({ dims: normalise(n.dims), wholeSit: true, note: n }));
    const out = [];
    let from = 0;
    for (const n of list) {
      const to = n.offsetSec || 0;
      // A label given at t=0 describes nothing yet; skip rather than emit an empty
      // span that later code would happily average over.
      if (to > from) out.push({ fromSec: from, toSec: to, dims: normalise(n.dims), note: n });
      from = to;
    }
    if (durationSec != null && durationSec > from && list.length) {
      // The tail after the last label is UNLABELLED, not covered by the last one.
      // Extending it forward would invent a report about time the rater never saw.
      out.push({ fromSec: from, toSec: durationSec, dims: null, note: null });
    }
    return { spans: out, wholeSit };
  }

  return {
    DIMENSIONS, BY_KEY, QUADRANTS, TRANSITIONS, TRANSITION_BY_KEY, TRANSITION_BY_KBD,
    quadrant, validRating, normalise, describe, summarise, spans,
  };
});
