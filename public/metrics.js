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
      source: 'theta and delta rising while alpha declines',
      caveat: 'Included mainly as a CONFOUND CHECK rather than a goal. If this is high, treat Calm and Focus with suspicion — the same band changes look like both settling and falling asleep.',
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

  const byKey = Object.fromEntries(METRICS.map((m) => [m.key, m]));

  function get(key) { return byKey[key] || null; }
  function tierOf(key) { const m = byKey[key]; return m ? m.tier : null; }
  function tierInfo(tier) { return TIERS[tier] || null; }

  // Metrics safe to present as the headline of a visual. Speculative ones are
  // deliberately excluded from being a DEFAULT — you can select them on
  // purpose, but nothing should silently drive the whole screen off a score
  // that has no validated basis.
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
        // Steady frontal theta, penalised by instability. Theta present AND
        // holding still is the closest thing to "sustained attention" here.
        if (!has(f.thetaLevel)) return null;
        return clamp01(f.thetaLevel * (1 - 0.55 * (has(f.variability) ? f.variability : 0.5)));
      case 'drowsy':
        if (!has(f.thetaLevel) || !has(f.deltaLevel) || !has(f.alphaLevel)) return null;
        return clamp01(0.5 * f.thetaLevel + 0.5 * f.deltaLevel - 0.35 * f.alphaLevel + 0.17);
      case 'blink': return has(f.blink) ? clamp01(f.blink) : null;
      case 'jaw': return has(f.jaw) ? clamp01(f.jaw) : null;
      case 'asymmetry':
        // 0.5 is balanced; >0.5 means more left-frontal alpha.
        if (!has(f.alphaLeft) || !has(f.alphaRight)) return null;
        return clamp01(0.5 + 0.5 * Math.tanh((f.alphaLeft - f.alphaRight) * 2));
      case 'hrv': return has(f.hrvLevel) ? clamp01(f.hrvLevel) : null;
      case 'equanimity':
        if (!has(f.hrvSteadiness)) return null;
        return clamp01(f.hrvSteadiness);
      case 'openness':
        // Alpha up, beta down, and very little churn — the pattern the zazen
        // literature describes. Explicitly exploratory.
        if (!has(f.alphaLevel) || !has(f.betaLevel)) return null;
        return clamp01(0.55 * f.alphaLevel + 0.25 * (1 - f.betaLevel)
          + 0.20 * (1 - (has(f.variability) ? f.variability : 0.5)));
      default: return null;
    }
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  return { TIERS, METRICS, get, tierOf, tierInfo, defaultSelectable, compute };
});
