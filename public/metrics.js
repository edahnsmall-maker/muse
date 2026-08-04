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
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Metrics = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

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
      source: 'alpha minus beta log-power at AF7/AF8, normalised to your session baseline',
      caveat: 'Alpha rises in relaxed wakefulness — but it also rises with drowsiness. This cannot distinguish settled from sleepy. Frontal alpha is also affected by eye movement.',
    },
    {
      key: 'thinking', label: 'Thinking', tier: 'moderate',
      source: 'beta level, plus how much the band balance churns, plus the rate of abrupt shifts',
      caveat: 'This is cortical activation and signal instability. It cannot read thought content, and cannot tell problem-solving from worrying from composing a poem.',
    },
    {
      key: 'focus', label: 'Focus', tier: 'moderate',
      source: 'steadiness of frontal theta (4-8Hz)',
      caveat: 'Frontal-midline theta is the best-replicated focused-attention marker in meditation research, but true Fz sits BETWEEN our two sensors so this is a proxy of a proxy — and theta also rises with drowsiness.',
    },
    {
      key: 'drowsy', label: 'Drowsy', tier: 'moderate',
      source: "theta's share of theta plus alpha — theta rising as alpha gives way",
      caveat: 'Included mainly as a CONFOUND CHECK rather than a goal. If this is high, treat Calm and Focus with suspicion — the same band changes look like both settling and falling asleep. Delta is deliberately excluded: on a forehead electrode it is mostly eye movement and drift, and this app already treats delta energy across both frontal sensors as a BLINK, so counting it here made blinking look like dozing.',
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
      case 'thinking': return has(f.activity) ? clamp01(f.activity) : null;
      case 'focus':
        /* THETA PRESENT *AND* HOLDING STILL, as a geometric mean rather than a weighted penalty.
         *
         * This used to be `thetaLevel * (1 - 0.55 * variability)`, and the 0.55 came from nowhere.
         * A geometric mean says the same thing — both conditions must hold, neither substitutes for
         * the other — with no free parameter to invent. It is also better behaved at the edges: if
         * theta is absent the answer is 0 regardless of steadiness, which is what "sustained
         * attention" should mean, whereas the weighted form still returned 0.45 of nothing.
         */
        if (!has(f.thetaLevel)) return null;
        return clamp01(Math.sqrt(
          clamp01(f.thetaLevel) * (1 - clamp01(has(f.variability) ? f.variability : 0.5))));
      case 'drowsy':
        /* THETA'S SHARE OF THETA PLUS ALPHA. Delta is deliberately NOT in it.
         *
         * Two changes, for two different reasons.
         *
         * FIRST, it stopped being a weighted sum. It was `0.5*theta + 0.5*delta - 0.35*alpha + 0.17`
         * — four invented numbers, one of which (+0.17) existed only to drag the result back into
         * range after the subtraction. The intent was always "slow activity rising while alpha
         * falls", and that is a ratio, bounded 0..1 by construction with nothing to tune.
         *
         * SECOND, and this is the part that was reported as wrong — "i dont know what the drowsy
         * metric is based on, but it's not reading me right" — delta came out.
         *
         * Delta on a forehead electrode is not mostly brain. It is eye movement, blinks, and slow
         * electrode drift. This app says so itself, in classifyArtifact(): a blink is detected AS a
         * large deflection in roughly 1-4Hz appearing on both frontal sensors, which is the delta
         * band. So the same energy that made the app report a blink also pushed Drowsy up. Anyone
         * sitting with their eyes flickering, or with the headband settling on their skin, read as
         * falling asleep. Two parts of one app cannot disagree about what delta means.
         *
         * Theta against alpha is the pairing that actually tracks sleep onset — theta rises as alpha
         * gives way — and it is the standard drowsiness contrast for that reason. Losing delta loses
         * some real slow-wave signal along with the artifact; that is the right trade when the
         * artifact and the signal are inseparable at this electrode placement.
         */
        if (!has(f.thetaLevel) || !has(f.alphaLevel)) return null;
        {
          const theta = clamp01(f.thetaLevel);
          const total = theta + clamp01(f.alphaLevel);
          return total > 0 ? clamp01(theta / total) : null;
        }
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
        if (!has(f.alphaLevel) || !has(f.betaLevel)) return null;
        {
          const a = clamp01(f.alphaLevel), b = clamp01(f.betaLevel);
          if (!(a + b > 0)) return null;
          const share = a / (a + b);
          const steady = 1 - clamp01(has(f.variability) ? f.variability : 0.5);
          return clamp01(Math.sqrt(share * steady));
        }
      default: return null;
    }
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  return { TIERS, METRICS, get, tierOf, tierInfo, defaultSelectable, displayed, compute };
});
