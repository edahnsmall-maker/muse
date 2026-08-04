/*
 * EXPLORE — "What do you want to understand?"
 *
 * WHY THIS EXISTS. Reported plainly: "the lab is a bit hard to use for a novice like that." It was.
 * The lab presented rank correlations, multiplicity-adjusted p-values, train/test splits and surrogate
 * bands to somebody who wants to know whether their sits differ. All of that machinery is correct and
 * none of it answers the question in the form it was asked.
 *
 * So this module answers questions instead of reporting statistics: pick an experience you marked, a
 * window, and something to compare it against, and get sentences back.
 *
 * THE HONESTY PROBLEM, AND WHY CONSISTENCY REPLACES SIGNIFICANCE.
 *
 * The obvious way to build this is to pool every marked moment across every sit and run one test. That
 * is what the existing search does, and for a novice reader it is actively misleading, because a
 * p-value computed over pooled marks answers "could this pattern have arisen by chance if nothing were
 * happening" — a question nobody asked — while quietly assuming the sits are interchangeable. They are
 * not. Measured on seven real recordings, the displayed calm score spanned 42-53 across ALL of them
 * while the underlying physiology spanned more than twofold; sits differ in electrode fit, time of day,
 * and how much of the signal was usable.
 *
 * So the headline here is a COUNT: in how many separate sits did this pattern appear in the same
 * direction? That is the question a practitioner is actually asking — "does this repeat?" — and it has
 * three properties a p-value does not:
 *
 *   1. It cannot be manufactured by pooling. Each sit votes once, however many marks it contains, so
 *      one sit with forty marks cannot outvote seven sits with five.
 *   2. It degrades honestly. Two sits can produce "2 of 2" and the reader can see that 2 is small.
 *      A p-value of 0.03 from two sits looks identical to one from twenty.
 *   3. It is checkable by hand. Anyone can open two sessions and see whether the direction agrees.
 *
 * The per-sit direction still needs a threshold, and that threshold is the one judgement call in here.
 * It is set against measurement noise rather than chosen: see MIN_EFFECT.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not fit anything, does not call itself a model, and does
 * not report a confidence percentage. A mock of this screen showed "Confidence 82%" beside
 * "Personalized model", and there is no model here and no basis for 82. Inventing one would be the same
 * failure as the weighted coefficients this project already removed — a guess wearing the clothes of a
 * calibration.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./analysis.js'));
  } else root.Explore = factory(root.Analysis);
})(typeof window !== 'undefined' ? window : globalThis, function (Analysis) {

  /*
   * How big a within-sit difference counts as "this sit shows the pattern".
   *
   * Expressed in standard deviations of the same signal WITHIN that sit, so it travels across signals
   * with different units — alpha share in percent, breathing in breaths per minute, HRV in
   * milliseconds — without a per-signal constant for each.
   *
   * 0.2 is the conventional floor for a difference worth noticing at all, and it is used here as a
   * FLOOR rather than a target: anything smaller than a fifth of the sit's own variation cannot be
   * distinguished from where in the sit you happened to look. Nothing about the number is tuned to
   * produce a particular answer, and raising it only ever makes this module report less.
   */
  const MIN_EFFECT = 0.2;

  /*
   * Below this many marks in a sit, that sit does not get a vote.
   *
   * Not a statistical threshold — a definitional one. A "difference between marked and unmarked
   * moments" computed from one mark is a difference between one moment and the rest of the sit, which
   * is a description of that moment and not a pattern.
   */
  const MIN_MARKS_PER_SESSION = 3;

  // And below this many voting sits, no count is reported as a pattern at all. Two sits agreeing is
  // a coin landing the same way twice.
  const MIN_SESSIONS = 3;

  /*
   * The questions this can answer, in the words somebody would ask them.
   *
   * A closed list rather than free text. Every entry here maps to a comparison the data can actually
   * support; a text box would accept "am I getting better at meditating", which it cannot.
   */
  const QUESTIONS = [
    {
      key: 'before-mark',
      ask: 'What happens in the seconds before I mark {experience}?',
      needs: 'marks',
      // The window sits BEFORE the mark because a mark records the moment of NOTICING. The state
      // being labelled is what preceded the press.
      window: { preSec: 20, postSec: 0 },
      compare: 'rest',
    },
    {
      key: 'after-mark',
      ask: 'What happens in the seconds after I mark {experience}?',
      needs: 'marks',
      window: { preSec: 0, postSec: 20 },
      compare: 'rest',
    },
    {
      key: 'between-marks',
      ask: 'How does {experience} differ from {other}?',
      needs: 'two-marks',
      window: { preSec: 20, postSec: 0 },
      compare: 'other',
    },
    {
      key: 'whole-sits',
      ask: 'Do my calmer sits look different from my busier ones?',
      needs: 'sessions',
      window: null,
      compare: 'sessions',
    },
  ];

  /*
   * The signals a question is answered against, in plain language, with what each one is worth.
   *
   * `comparable` says whether the number means the same thing in two different sits. It is not a
   * detail: every EEG composite in this app is normalised within the sit, so pooling them across sits
   * compares each sit against itself. Anything not comparable is excluded from whole-session questions
   * and allowed for within-sit ones, where a relative scale is fine.
   */
  const SIGNALS = [
    { key: 'calmAbs', label: 'EEG — alpha share', comparable: true,
      plain: 'how much of the fast-and-slow balance at your forehead is alpha',
      caveat: 'Higher is not automatically better. Alpha is suppressed when the eyes are open, so'
        + ' eyes-open sitting shows less of it than eyes-closed rest.' },
    { key: 'breathPerMin', label: 'Breathing — rate', comparable: true,
      plain: 'breaths per minute, from the way breathing modulates heart timing',
      caveat: 'Needs the chest strap. Comes from heart-rate variation, so it lags the actual breath'
        + ' by about a fifth of a cycle and needs roughly a minute of beats to estimate at all.' },
    { key: 'hrvMs', label: 'Heart — beat-to-beat variation', comparable: true,
      plain: 'RMSSD in milliseconds: how much consecutive heartbeats differ',
      caveat: 'Needs the chest strap. Rises with slow breathing, so it partly measures the breath'
        + ' rather than anything independent of it.' },
    { key: 'hrBpm', label: 'Heart — rate', comparable: true,
      plain: 'beats per minute',
      caveat: 'Needs the chest strap. Moves with posture, caffeine and time of day.' },
    { key: 'calm', label: 'Calm score (relative)', comparable: false,
      plain: 'the app’s calm score, rescaled against this sit’s own recent range',
      caveat: 'CANNOT be compared between sits. Rescaled within each recording, so a uniformly calm'
        + ' sit and a uniformly busy one both sit near the middle.' },
    { key: 'thinking', label: 'Thinking score (relative)', comparable: false,
      plain: 'the app’s thinking score',
      caveat: 'CANNOT be compared between sits, for the same reason as the calm score.' },
  ];
  const SIGNAL_BY_KEY = SIGNALS.reduce((m, s) => { m[s.key] = s; return m; }, {});

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  function sd(xs) {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  }
  const finite = (xs) => xs.filter((v) => v != null && Number.isFinite(v));

  /*
   * One sit's verdict on one signal: did the marked windows differ from the rest of that sit?
   *
   * Returns the direction and the size in units of that sit's own spread, or a reason it could not be
   * answered. Never returns a direction with no size behind it — a sign with no magnitude is what turns
   * measurement noise into a finding.
   */
  function sessionVote(rows, marks, signalKey, { preSec = 20, postSec = 0 } = {}) {
    const inWindow = [];
    const outside = [];
    const usable = (rows || []).filter((r) => r && r.t != null
      && r[signalKey] != null && Number.isFinite(r[signalKey]));
    if (!usable.length) return { known: false, reason: 'this sit has no readings for that signal' };
    if (!marks || marks.length < MIN_MARKS_PER_SESSION) {
      return { known: false,
        reason: `only ${(marks || []).length} marks in this sit; ${MIN_MARKS_PER_SESSION} are needed` };
    }
    const near = (t) => marks.some((m) => t >= m - preSec && t <= m + postSec);
    for (const r of usable) (near(r.t) ? inWindow : outside).push(r[signalKey]);
    if (inWindow.length < 3 || outside.length < 3) {
      return { known: false,
        reason: `the windows cover almost the whole sit (${inWindow.length} in, ${outside.length} out),`
          + ' so there is nothing left to compare against' };
    }
    const spread = sd(usable.map((r) => r[signalKey]));
    if (!(spread > 0)) {
      return { known: false, reason: 'this signal never changed in this sit, so no difference exists' };
    }
    const diff = mean(inWindow) - mean(outside);
    const effect = diff / spread;
    return {
      known: true,
      // Direction only when the size clears the floor. Below it the sign is not information.
      direction: Math.abs(effect) < MIN_EFFECT ? 0 : Math.sign(effect),
      effect,
      diff,
      inN: inWindow.length,
      outN: outside.length,
      inMean: mean(inWindow),
      outMean: mean(outside),
    };
  }

  /*
   * The answer: how many sits agreed, in which direction, and how many could not say.
   *
   * `sessions` is an array of { id, label, rows, marksBySignalKind } — whatever the caller has parsed.
   * This module never reads a file.
   */
  function askAcrossSessions(sessions, { signalKey, markTimes, window: win } = {}) {
    const votes = [];
    for (const s of sessions || []) {
      const marks = (markTimes && markTimes[s.id]) || [];
      const v = sessionVote(s.rows, marks, signalKey, win || {});
      votes.push(Object.assign({ sessionId: s.id, label: s.label || s.id }, v));
    }
    const answered = votes.filter((v) => v.known);
    const up = answered.filter((v) => v.direction > 0);
    const down = answered.filter((v) => v.direction < 0);
    const flat = answered.filter((v) => v.direction === 0);
    /* The winning direction is whichever has more sits, and a tie is a tie rather than a coin toss —
       reporting one of two equal counts as "the" direction is how a null becomes a finding. */
    const leading = up.length === down.length ? flat.concat(up, down).slice(0, 0) : (up.length > down.length ? up : down);
    const agree = leading.length;
    return {
      signalKey,
      votes,
      sessionsAnswered: answered.length,
      sessionsTotal: votes.length,
      agree,
      direction: up.length === down.length ? 0 : (up.length > down.length ? 1 : -1),
      up: up.length,
      down: down.length,
      flat: flat.length,
      // The typical size among the agreeing sits, so the sentence can say how big as well as how often.
      medianEffect: median(leading.map((v) => Math.abs(v.effect))),
      strength: strengthOf(answered.length, agree, votes.length),
    };
  }

  function median(xs) {
    const a = finite(xs).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  }

  /*
   * The badge, and the reasoning that sets it.
   *
   * Deliberately coarse: four states, no percentage. A number like "82% confident" would imply a
   * calibration that does not exist, and the honest resolution of "how sure are you" here is a count
   * with a word attached.
   *
   * A MAJORITY IS NOT ENOUGH FOR THE TOP TIER. With n sits each voting up or down, half of them
   * agreeing is what chance produces; the threshold for "repeats" is therefore set well above half —
   * three quarters — and even then it is called a repeating pattern rather than an effect.
   */
  function strengthOf(answered, agree, total) {
    if (answered < MIN_SESSIONS) {
      return { key: 'insufficient', label: 'Not enough sessions',
        why: `${answered} of ${total} sits could answer this; ${MIN_SESSIONS} are needed before a`
          + ' count means anything' };
    }
    const share = agree / answered;
    if (agree >= 3 && share >= 0.75) {
      return { key: 'repeats', label: `Repeats · seen in ${agree} of ${answered} sessions`,
        why: 'The same direction appeared in at least three quarters of the sits that could answer.'
          + ' That is more agreement than chance produces, and it is still association rather than'
          + ' cause.' };
    }
    if (share >= 0.5) {
      return { key: 'possible', label: `Possible pattern · seen in ${agree} of ${answered} sessions`,
        why: 'More sits agreed than disagreed, but not by enough to rule out where you happened to'
          + ' look. Worth more sits.' };
    }
    return { key: 'unclear', label: `Unclear · ${agree} of ${answered} sessions`,
      why: 'The sits disagree about the direction, which is what no pattern looks like.' };
  }

  /*
   * The sentence to put on screen.
   *
   * Written so the LIMIT is the plain reading, not a footnote. "May" and "in these sits" are load
   * bearing: every one of these is a description of a handful of recordings from one person.
   */
  function describe(answer, { experience = 'that mark' } = {}) {
    const sig = SIGNAL_BY_KEY[answer.signalKey] || { label: answer.signalKey };
    if (answer.strength.key === 'insufficient') {
      return `Not enough to say yet about ${sig.label.toLowerCase()} — ${answer.strength.why}.`;
    }
    if (answer.strength.key === 'unclear') {
      return `${sig.label} shows no consistent pattern around ${experience}:`
        + ` ${answer.up} sits went one way and ${answer.down} the other.`;
    }
    const word = answer.direction > 0 ? 'higher' : 'lower';
    const size = answer.medianEffect == null ? ''
      : ` by about ${answer.medianEffect.toFixed(1)} times the sit’s own variation`;
    const hedge = answer.strength.key === 'repeats' ? 'is' : 'may be';
    return `${sig.label} ${hedge} ${word} around ${experience}${size}`
      + ` — ${answer.strength.label.replace(/^[^·]+· /, '')}.`;
  }

  /*
   * What to do next, given what came back.
   *
   * Every branch names an ACTION rather than a statistic, because the honest answer to almost
   * everything here is "more sits" and that needs saying in a way somebody can act on.
   */
  function nextStep(answers, sessions) {
    const answered = answers.filter((a) => a.strength.key !== 'insufficient');
    if (!answered.length) {
      return `Sit and mark a few more times. With ${sessions.length} usable`
        + ` session${sessions.length === 1 ? '' : 's'} there is not enough to compare —`
        + ` ${MIN_SESSIONS} is the minimum and ten is where this starts to be worth reading.`;
    }
    const repeats = answers.filter((a) => a.strength.key === 'repeats');
    if (repeats.length) {
      return 'Run the same question on sits you have not looked at yet. A pattern that survives'
        + ' sessions you did not use to find it is the only kind worth believing.';
    }
    return 'Add more sessions before drawing anything from this. The direction is not stable yet,'
      + ' and the cheapest way to change that is more marked sits rather than a different analysis.';
  }

  return {
    QUESTIONS, SIGNALS, SIGNAL_BY_KEY,
    MIN_EFFECT, MIN_MARKS_PER_SESSION, MIN_SESSIONS,
    sessionVote, askAcrossSessions, strengthOf, describe, nextStep, median,
  };
});
