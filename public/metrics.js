/*
 * The metric registry — and, more importantly, an honest account of how much
 * each metric is actually worth.
 *
 * WHY THIS FILE EXISTS
 * The user asked directly: are the composite scores valid, and where did the
 * calm score come from? Honest answer: "calm" is alpha minus beta (log power)
 * at the two forehead sensors, normalised against that person's own session
 * baseline. The alpha/beta ratio is a common relaxation index in the EEG
 * literature, so it is not arbitrary — but the band edges, the weights, the
 * smoothing and the thresholds were all chosen by hand here, and none of it
 * has been validated against any ground truth. The same is true of "thinking".
 *
 * Writing more code cannot make a metric valid. Validity needs labelled data:
 * the person marking what was actually happening, compared against what the
 * algorithm claimed. So instead of quietly presenting guesses as measurements,
 * every metric here carries an explicit TIER and a caveat, and the UI is
 * expected to show them. A speculative score is fine to look at; a speculative
 * score dressed up as an instrument is not.
 */
/* DSP is a dependency now, because the composites are band shares and the band-share formulas live
   there — see the note above DSP.bandShares. Resolved the same way the rest of this project resolves
   its modules: `require` under Node for the tests, the global under a browser where dsp.js is loaded
   first by direct.html. Asserted rather than assumed: a missing DSP here would silently return null for
   every composite, which is indistinguishable on screen from a headband that is not reading. */
(function (root, factory) {
  const dsp = (typeof module !== 'undefined' && module.exports)
    ? require('./dsp.js') : root.DSP;
  if (!dsp || typeof dsp.bandShares !== 'function') {
    throw new Error('metrics.js needs dsp.js (bandShares) — check the script order in direct.html');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(dsp);
  else root.Metrics = factory(dsp);
})(typeof window !== 'undefined' ? window : globalThis, function (DSP) {

  const TIERS = {
    solid: {
      label: 'measured',
      note: 'A direct, well-characterised signature in the raw signal. Not an interpretation.',
    },
    moderate: {
      label: 'proxy',
      note: 'A literature-backed proxy, computed relative to your own baseline. Directional only — it can tell you "more than before", not "how much".',
    },
    speculative: {
      label: 'exploratory',
      note: 'No validated real-time marker for this exists on 4-channel consumer EEG. Shown because it may be interesting to watch, NOT because it is established. Do not draw conclusions.',
    },
  };

  // `source` says what it is actually computed from. `caveat` says what it
  // cannot tell you. Both are shown in the UI on request.
  const METRICS = [
    {
      key: 'calm', label: 'Calm', tier: 'moderate',
      source: 'alpha\u2019s share of alpha+beta at AF7/AF8, on a fixed scale (DSP.CALM_WINDOW) \u2014 the same in every sit, never normalised to the sit itself',
      caveat: 'Alpha rises in relaxed wakefulness \u2014 but it also rises with drowsiness, and this cannot distinguish settled from sleepy. Measured limit: a 26-minute non-meditative session (TV on, moving the mouse, late at night) scored 49 against a peak zazen sit\u2019s 79, and had the same frontal alpha power to within 3%. Separation between them is AUC 0.78, which is fair rather than good. What actually differed was beta and gamma, not alpha.',
    },
    {
      key: 'thinking', label: 'Thinking', tier: 'moderate',
      source: 'beta\u2019s share of theta+alpha+beta at AF7/AF8 \u2014 how much of what is going on is fast',
      caveat: 'This is cortical activation. It cannot read thought content, and cannot tell problem-solving from worrying from composing a poem. Frontal beta also contains jaw and facial muscle, which is why `jaw` is reported separately. Measured: it separated a non-meditative session from a zazen sit at AUC 0.74, slightly better than Calm did.',
    },
    {
      key: 'focus', label: 'Focus', tier: 'moderate',
      source: 'theta\u2019s share of theta+alpha+beta at AF7/AF8, times how still the signal is holding',
      caveat: 'Frontal-midline theta is the best-replicated focused-attention marker in meditation research, but true Fz sits BETWEEN our two sensors so this is a proxy of a proxy \u2014 and theta also rises with drowsiness. It shares its theta term with Drowsy on purpose: whether rising theta is attention or sleepiness is what Drowsy\u2019s alpha term decides, so the two are meant to be read together.',
    },
    {
      key: 'drowsy', label: 'Drowsy', tier: 'moderate',
      source: "theta's share of theta+alpha+beta, times how far alpha has lost the fast contest \u2014 slow-wave dominance AND alpha giving way, both required",
      caveat: 'Included mainly as a CONFOUND CHECK rather than a goal. If this is high, treat Calm and Focus with suspicion \u2014 the same band changes look like both settling and falling asleep. It used to be theta against alpha alone and read 59 through a sit reported as "attentive, calm" with the head accelerometer showing 90% stillness and no forward pitch drift; frontal midline theta in absorbed attention really is about twice alpha, so no theta-vs-alpha ratio could have separated absorption from sleep onset. Alpha is what separates them, so alpha is now required. Delta is deliberately excluded: on a forehead electrode it is mostly eye movement and drift, and this app already treats delta energy across both frontal sensors as a BLINK, so counting it here made blinking look like dozing.',
    },
    {
      key: 'blink', label: 'Blinks', tier: 'solid',
      source: 'large slow deflections appearing together on both forehead sensors',
      caveat: 'A genuine, well-characterised signature — but it is eye movement, not a brain state. Useful because it explains sudden jumps in everything else.',
    },
    {
      key: 'jaw', label: 'Jaw / muscle', tier: 'solid',
      source: 'high-frequency broadband power (muscle EMG)',
      caveat: 'Muscle tension, not brain activity. Worth seeing precisely because it corrupts every other metric while it is happening.',
    },
    {
      key: 'asymmetry', label: 'L / R balance', tier: 'speculative',
      source: 'alpha difference between AF7 (left) and AF8 (right)',
      caveat: 'Frontal alpha asymmetry is often linked to approach/withdrawal affect, but effect sizes are small, findings are contested, and single-session values are unreliable. Do not read mood from this.',
    },
    {
      key: 'breath', label: 'Breath', tier: 'moderate',
      source: 'where you are in the breath cycle, from the respiratory modulation of heart timing (RSA) via the chest strap',
      caveat: 'This is a real phase estimate, not a guess at a rhythm — but the heart RESPONDS to breathing rather than predicting it, so it lags the actual breath by roughly a fifth of a cycle (measured: 1.0s in a 5s cycle). Breath-holding or an irregular pattern makes it unreliable. For true zero-lag phase you would need chest-wall movement from the strap accelerometer.',
    },
    {
      key: 'hrv', label: 'HRV', tier: 'moderate',
      source: 'RMSSD over a rolling 60s window of beat-to-beat intervals from a chest strap, normalised to your own baseline',
      caveat: 'RMSSD is a standard, well-defined measurement and the strap is ECG-grade, so the NUMBER is solid. What it means is the proxy part: higher RMSSD indicates parasympathetic (rest) activation, which correlates with calm — but it also rises with slow breathing regardless of mental state, so you can move it deliberately without settling at all.',
    },
    {
      key: 'equanimity', label: 'Equanimity', tier: 'speculative',
      source: 'how STEADY that HRV is (coefficient of variation of RMSSD), not how high it is',
      caveat: 'There is NO established marker for equanimity. This is physiological non-reactivity, which is related to but genuinely not the same thing. Steadiness rather than level is the deliberate choice: a person can have high HRV and still be reacting to everything.',
    },
    {
      key: 'openness', label: 'Open awareness', tier: 'speculative',
      source: 'sustained anterior alpha with low beta and low variability',
      caveat: 'Inspired by the classic zazen finding (alpha spreading forward and persisting with eyes open), but no validated real-time marker exists. This is the hardest thing here to measure and the easiest to fool yourself about.',
    },
  ];

  /*
   * WHAT THE LIVE APP SHOWS, as opposed to what can be computed.
   *
   * Eleven metrics were on offer and the honest count of validated ones was zero: two "solid"
   * entries, and both of them are artifacts rather than brain states — a blink and a clenched jaw
   * are the most trustworthy things this headband measures. Meanwhile the numbers a practitioner
   * actually reads were moderate-to-speculative interpretations built on invented coefficients.
   *
   * Breadth also costs statistical power, measurably. The lab's multiplicity correction spends real
   * power per comparison: a 469-comparison search over 71 observations can only report a
   * correlation of 0.43 or stronger, while narrowing to 20 comparisons brings that floor to 0.33.
   * So every extra metric on display is roughly a tenth of an effect size that can no longer be
   * detected. Feature-rich and data-poor is not a neutral trade.
   *
   * So `display: false` retires a metric from the live screen WITHOUT deleting it: the lab still
   * computes it, the raw EEG is still kept, and the formula can be re-examined at any time. What
   * goes is the implication that it is a reading. `openness` and `asymmetry` are retired on the
   * strength of their own caveats — "no validated real-time marker exists" and "do not read mood
   * from this". `equanimity` is kept on the display at the practitioner's explicit request, and
   * keeps its exploratory tier and its caveat.
   */
  const DISPLAY = { openness: false, asymmetry: false };
  for (const m of METRICS) m.display = DISPLAY[m.key] !== false;

  const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m]));

  function get(key) { return byKey[key] || null; }
  function tierOf(key) { const m = byKey[key]; return m ? m.tier : null; }
  function tierInfo(tier) { return TIERS[tier] || null; }

  // Metrics safe to present as the headline of a visual. Speculative ones are
  // deliberately excluded from being a DEFAULT — you can select them on
  // purpose, but nothing should silently drive the whole screen off a score
  // that has no validated basis.
  // What the live app offers. The lab uses METRICS directly, because a candidate labelled as a
  // candidate is exactly what a lab is for.
  function displayed() { return METRICS.filter((m) => m.display); }

  function defaultSelectable() {
    return METRICS.filter((m) => m.tier !== 'speculative').map((m) => m.key);
  }

  // --- Composite computations ------------------------------------------------
  // Each takes an already-normalised feature bundle and returns 0..1, or null
  // when the inputs needed simply are not available. Returning null matters:
  // a metric with no data must read as "no data", never as zero.
  function compute(key, f) {
    const has = (v) => v != null && !Number.isNaN(v);
    switch (key) {
      // Clamped, not passed through: these feed geometry downstream, so an
      // out-of-range input must not propagate into a radius or a colour.
      case 'calm': return has(f.calm) ? clamp01(f.calm) : null;
      /*
       * THINKING, DROWSY, FOCUS AND OPENNESS ARE ABSOLUTE BAND SHARES NOW.
       *
       * Each of them used to be built from AdaptiveNormalizer outputs — a within-sit z-score of log band
       * power. Measured on a whole retreat sit, `drowsy` was normTheta/(normTheta+normAlpha) and moved
       * between 0.55 and 0.66: a sixth of the display, for a metric that has to tell wide awake from
       * falling asleep. Both inputs hover at 0.5 by construction, so their ratio does too.
       *
       * The formulas themselves live in dsp.js (`bandShares` and the four functions beside it), where
       * they can be unit-tested against synthetic spectra and re-used by the lab, rather than being
       * spelled out here from features that have already been transformed. Read the notes there: they
       * carry the six-sit table and the reason Drowsy is a product rather than a geometric mean.
       */
      case 'thinking': return DSP.thinkingFromShares(f.shares);
      case 'focus': {
        /* THETA PRESENT *AND* HOLDING STILL, as a geometric mean — the conjunction is kept, only its
           theta term changed. `1 - variability` is the one within-sit quantity that belongs in a
           composite: "is the signal churning right now" is genuinely a question about this sit, unlike
           "is there a lot of theta", which is a question about the person. Sustained attention needs
           both, and the geometric mean will not let a large theta alone carry it. */
        const theta = DSP.focusFromShares(f.shares);
        if (theta == null) return null;
        return clamp01(Math.sqrt(theta * (1 - clamp01(has(f.variability) ? f.variability : 0.5))));
      }
      case 'drowsy': return DSP.drowsyFromShares(f.shares);
      /* THE PREVIOUS DROWSY was theta/(theta+alpha) on normalised levels, and before that a weighted
         sum with a +0.17 in it whose only job was to drag the result back into range. Both are gone.
         The delta band stays excluded for the reason that removal established and which has not
         changed: on a forehead electrode 1-4Hz is mostly eye movement, and this app's own
         classifyArtifact() detects a blink AS energy in that band, so the same volts that raised a
         blink warning also raised Drowsy. Two parts of one app cannot disagree about what delta is. */
      case 'blink': return has(f.blink) ? clamp01(f.blink) : null;
      case 'jaw': return has(f.jaw) ? clamp01(f.jaw) : null;
      case 'asymmetry':
        /* A LATERALITY INDEX, which is the standard parameter-free form: the difference over the
         * sum. 0.5 is balanced, above 0.5 is more left-frontal alpha.
         *
         * This used to be `0.5 + 0.5*tanh((L-R)*2)`, and the gain of 2 was chosen to make the
         * curve look right. A tanh with an invented gain decides how much difference counts as a
         * lot, which is exactly the judgement this file has no basis for making.
         */
        if (!has(f.alphaLeft) || !has(f.alphaRight)) return null;
        {
          const sum = clamp01(f.alphaLeft) + clamp01(f.alphaRight);
          if (!(sum > 0)) return null;
          return clamp01(0.5 + 0.5 * ((clamp01(f.alphaLeft) - clamp01(f.alphaRight)) / sum));
        }
      // Mapped so 0.5 is the turnaround between in and out, which is what makes
      // a centred bar and a mid-line trace mean the right thing.
      case 'breath': return has(f.breathPhase) ? clamp01(0.5 + 0.5 * f.breathPhase) : null;
      case 'hrv': return has(f.hrvLevel) ? clamp01(f.hrvLevel) : null;
      case 'equanimity':
        if (!has(f.hrvSteadiness)) return null;
        return clamp01(f.hrvSteadiness);
      case 'openness':
        /* ALPHA'S SHARE AGAINST BETA, held steady — the pattern the zazen literature describes,
         * as a ratio times a steadiness, combined by geometric mean.
         *
         * This used to be `0.55*alpha + 0.25*(1-beta) + 0.20*(1-variability)`: three weights that
         * happen to sum to 1.0, chosen because that looked like calibration. Worse than the others,
         * because a weighted sum lets a HIGH alpha compensate for a churning signal and still
         * report open awareness, which is the opposite of what the finding describes. The
         * conjunction form cannot do that: churn pulls the whole thing down.
         */
        /* THE SHARE IS ABSOLUTE NOW (DSP.bandShares.alphaOfFast) for the same reason as the others: it
           was alphaLevel/(alphaLevel+betaLevel), a ratio of two within-sit z-scores, which sits at 0.5
           whatever the sit was doing. Steadiness is still the normalised churn — that one is genuinely a
           within-sit quantity, since "is the signal holding still" is a question about this sit. */
        if (!f.shares || !has(f.shares.alphaOfFast)) return null;
        {
          const steady = 1 - clamp01(has(f.variability) ? f.variability : 0.5);
          return clamp01(Math.sqrt(clamp01(f.shares.alphaOfFast) * steady));
        }
      default: return null;
    }
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  return { TIERS, METRICS, get, tierOf, tierInfo, defaultSelectable, displayed, compute };
});
