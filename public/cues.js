/*
 * In-the-moment cues — pure rule logic, no DOM, so the rate-limiting and
 * priority rules are unit-testable.
 *
 * Design constraints, carried from ROADMAP.md:
 *  - SILENCE IS THE DEFAULT. A cue appears only when there is something worth
 *    saying. The failure mode of every meditation app is talking constantly;
 *    an adaptive guide's main advantage is knowing when to shut up.
 *  - Rate limited hard (default: at most one cue every 5 minutes).
 *  - Never scolding, never evaluative. "Wandering is normal, begin again" —
 *    not "you lost focus". Thoughts are the equipment, not the enemy.
 *  - Reward the RETURN, not the stillness. Coming back is the rep.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Cues = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Ordered by priority — the first matching rule wins. `when` gets a snapshot
  // of derived session state and returns true if this cue is worth saying now.
  const RULES = [
    {
      key: 'noisy',
      text: 'Let your jaw and face soften — the signal is picking up tension more than anything else.',
      // Actionable and about measurement, not about their mind. Highest
      // priority because everything else is unreliable while this is true.
      when: (s) => s.noise > 0.5,
    },
    {
      key: 'returns',
      text: 'You keep coming back. That returning is the practice — not the staying.',
      when: (s) => s.recentReturns >= 3,
    },
    {
      key: 'thinking',
      text: 'Thinking is fine. Come back to the breath, and keep it simple.',
      when: (s) => s.activity > 0.66,
    },
    {
      key: 'settled',
      text: 'Settling in now. Nothing to add, nothing to fix.',
      when: (s) => s.calm > 0.66 && s.settledStreakSec > 45,
    },
    {
      key: 'stirred',
      text: 'Wandering is normal. Begin again, gently.',
      when: (s) => s.calm < 0.36,
    },
    {
      key: 'justthis',
      text: 'Just this.',
      // Only for someone who has been steadily settled a long while — the
      // scaffolding should thin out as the sit deepens, not thicken.
      when: (s) => s.settledStreakSec > 300 && s.calm > 0.6,
    },
  ];

  class CueEngine {
    constructor({ minIntervalSec = 300, enabled = true } = {}) {
      this.minIntervalSec = minIntervalSec;
      this.enabled = enabled;
      this.lastAtSec = null;
      this.lastKey = null;
      this.log = []; // { tSec, key, text } — feeds the session report
    }

    // state: { tSec, calm, activity, noise, recentReturns, settledStreakSec }
    // Returns a cue object to show, or null for "say nothing".
    update(state) {
      if (!this.enabled) return null;
      const t = state.tSec;
      // Hold off at the very start of a sit — let someone actually arrive
      // before saying anything to them.
      if (t < 60) return null;
      if (this.lastAtSec != null && t - this.lastAtSec < this.minIntervalSec) return null;

      for (const rule of RULES) {
        if (!rule.when(state)) continue;
        // Don't say the same thing twice in a row — if the only applicable cue
        // is the one just given, stay quiet instead of repeating.
        if (rule.key === this.lastKey) return null;
        this.lastAtSec = t;
        this.lastKey = rule.key;
        const cue = { key: rule.key, text: rule.text, tSec: t };
        this.log.push(cue);
        return cue;
      }
      return null;
    }

    setEnabled(on) {
      this.enabled = !!on;
      return this.enabled;
    }
  }

  return { CueEngine, RULES };
});
