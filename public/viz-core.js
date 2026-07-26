/*
 * Pure visual-logic core — no canvas, no DOM, no time-of-day calls, so the
 * parts that are easy to get subtly wrong (event detection, bloom
 * lifecycles, mode cycling) are unit-testable under Node. Same discipline
 * as dsp.js and chart.js. All time is passed IN as a parameter.
 *
 * The drawing itself lives in visual.js and is deliberately thin on top of
 * this.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VizCore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // One distinct hue per electrode. This is the direct fix for "still no
  // color": every previous version computed a SINGLE highlight colour and
  // added it for all four bands, so the image was structurally monochrome
  // (dark navy + one blue-white) no matter how the numbers were tuned.
  // Order matches DSP.CHANNEL_NAMES: [TP9, AF7, AF8, TP10]. These are kept
  // in sync with the data-graph legend colours on purpose, so a ribbon in
  // the visual and its line on the graph are recognisably the same channel.
  const CHANNEL_COLORS = [
    [125, 211, 252], // TP9  — teal
    [167, 139, 250], // AF7  — violet
    [251, 146, 160], // AF8  — coral
    [110, 231, 183], // TP10 — mint
  ];

  // Eclipse uses its own warm palette rather than the channel hues: the
  // eclipse metaphor wants a sun's corona, and hot magenta/orange/gold on a
  // LIGHT ground is what makes it read as vivid. (Saturated colour added onto
  // near-black trends toward pale grey — that was the real reason earlier
  // versions looked colourless.) Channel order is preserved so each sensor
  // still owns one hue.
  const CORONA_COLORS = [
    [255, 55, 165],  // TP9  — magenta
    [255, 125, 55],  // AF7  — orange
    [255, 196, 70],  // AF8  — gold
    [255, 80, 120],  // TP10 — rose
  ];

  // Where each sensor actually sits on the head. The screen is treated as a
  // plan view from above with the nose toward the top, so the left forehead
  // sensor appears upper-left, and so on. Angles are radians CLOCKWISE FROM
  // 12 O'CLOCK; convert with x = cx + r*sin(a), y = cy - r*cos(a).
  // Order matches DSP.CHANNEL_NAMES: [TP9, AF7, AF8, TP10].
  //
  // Worth doing because it converts an arbitrary decoration into a readable
  // map: when the left side of the image reacts, that IS your left forehead.
  const CHANNEL_ANGLES = [-135, -45, 45, 135].map((d) => (d * Math.PI) / 180);

  // Shortest signed angular distance between two angles, in radians.
  function angleDelta(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Weight 0..1 for "how much does this angle belong to that sensor" — a
  // gaussian lobe, so each hue is localised to its own quadrant instead of
  // being smeared evenly around the whole ring.
  function lobeWeight(angle, channelIndex, width = 0.95) {
    const d = angleDelta(angle, CHANNEL_ANGLES[channelIndex]);
    return Math.exp(-(d * d) / (width * width));
  }

  const MODES = [
    { key: 'eclipse', label: 'Eclipse', blurb: 'stillness grows as a void; thinking flares at its edge' },
    { key: 'iris',    label: 'Iris',    blurb: 'your session laid down as a rose window' },
    { key: 'pulse',  label: 'Pulse',  blurb: 'a clock hand sweeps; each metric bulges where it flared' },
    { key: 'flow',   label: 'Flow',   blurb: 'a live trace, dissolving as it ages' },
    { key: 'bloom',  label: 'Bloom',  blurb: 'gradients that appear on real events' },
    { key: 'field',  label: 'Field',  blurb: 'one soft band of colour per sensor' },
    { key: 'breath', label: 'Breath', blurb: 'just slow breathing — nothing to read' },
  ];

  function nextMode(index) { return (index + 1) % MODES.length; }

  // ---- Significant-event detection ---------------------------------------
  // "Gradients emerge when certain events happen in the data that amount to
  // something significant." Two kinds of significant event:
  //   * a per-channel spike (a real, sustained shift in that electrode's
  //     alpha/beta balance — already debounced by DSP.SpikeDetector)
  //   * a calm-zone transition, with hysteresis so ordinary wobble around a
  //     single threshold can't chatter events forever. You must cross ABOVE
  //     `hi` or BELOW `lo` to change zone; anything between holds.
  class EventDetector {
    constructor({ hi = 0.62, lo = 0.42 } = {}) {
      this.hi = hi; this.lo = lo; this.zone = null;
    }
    update({ calm = null, spikes = [] } = {}) {
      const events = [];
      spikes.forEach((s, i) => {
        // Only a freshly-triggered spike counts; the decaying tail doesn't
        // re-fire an event every tick on the way down.
        if (s != null && s > 0.9) events.push({ type: 'spike', channel: i, strength: s });
      });
      if (calm != null && !Number.isNaN(calm)) {
        // A starting value in the dead band must still establish a zone
        // ('mid'), otherwise this.zone stays null and the first REAL
        // crossing gets swallowed by the don't-fire-on-startup guard.
        const first = this.zone === null;
        let zone = first ? 'mid' : this.zone;
        if (calm > this.hi) zone = 'high';
        else if (calm < this.lo) zone = 'low';
        if (zone !== this.zone) {
          // No event on the very first classification — that's just the
          // starting state, not a transition the person made.
          if (!first && zone !== 'mid') {
            events.push({ type: zone === 'high' ? 'settled' : 'stirred' });
          }
          this.zone = zone;
        }
      }
      return events;
    }
  }

  // ---- Blooms: soft gradients that emerge, expand, and fade --------------
  // Deterministic given the timestamps passed in; holds a bounded list so a
  // long session can't grow it without limit.
  class BloomField {
    constructor({ max = 20, life = 7000 } = {}) {
      this.max = max; this.life = life; this.blooms = [];
    }
    spawn({ x, y, color, strength = 1, at }) {
      this.blooms.push({ x, y, color, strength, born: at });
      if (this.blooms.length > this.max) this.blooms.shift(); // drop oldest
    }
    // Returns currently-visible blooms with derived radius/alpha, and prunes
    // expired ones. alpha rises then falls (sin curve) so a bloom emerges
    // softly rather than popping in.
    update(now) {
      this.blooms = this.blooms.filter((b) => now - b.born < this.life);
      return this.blooms.map((b) => {
        const age = (now - b.born) / this.life; // 0..1
        return {
          x: b.x, y: b.y, color: b.color,
          radius: 0.06 + 0.40 * age,
          alpha: b.strength * Math.sin(Math.PI * age),
        };
      });
    }
  }

  // ---- Guided breathing patterns -----------------------------------------
  // "Follow me" tracks the wearer's own measured rate. The others are fixed
  // classical patterns — a pacer to breathe WITH rather than a readout.
  // Durations are seconds per phase.
  const BREATH_PATTERNS = [
    { key: 'measured', label: 'Follow me', phases: null },
    { key: 'coherent', label: 'Coherent 5·5', phases: [['in', 5], ['out', 5]] },
    { key: 'box', label: 'Box 4·4·4·4', phases: [['in', 4], ['hold', 4], ['out', 4], ['holdOut', 4]] },
    { key: 'relax', label: 'Relaxing 4·7·8', phases: [['in', 4], ['hold', 7], ['out', 8]] },
  ];

  function nextPattern(index) { return (index + 1) % BREATH_PATTERNS.length; }

  // Ease so the turn-around at each end is gentle — the user asked for
  // "steady, slow in and slow out", which a raw linear ramp does not give.
  function ease(x) { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); }

  // Returns { amount, label, phase } for a patterned breath at time tSec.
  // amount is 0 (fully exhaled) .. 1 (fully inhaled). 'hold' phases keep the
  // amount pinned at whichever end they follow, so the visual genuinely
  // stops moving during a hold rather than drifting.
  function breathPattern(pattern, tSec) {
    if (!pattern || !pattern.phases) return null;
    const total = pattern.phases.reduce((sum, p) => sum + p[1], 0);
    let pos = tSec % total;
    if (pos < 0) pos += total;
    for (const [kind, dur] of pattern.phases) {
      if (pos < dur) {
        const f = pos / dur;
        if (kind === 'in') return { amount: ease(f), label: 'Breathe in', phase: kind };
        if (kind === 'out') return { amount: 1 - ease(f), label: 'Breathe out', phase: kind };
        if (kind === 'hold') return { amount: 1, label: 'Hold', phase: kind };
        return { amount: 0, label: 'Hold', phase: kind }; // holdOut
      }
      pos -= dur;
    }
    return { amount: 0, label: 'Hold', phase: 'holdOut' }; // unreachable in practice
  }

  // ---- Range expansion ---------------------------------------------------
  // Both the calm score and the activity score are ADAPTIVELY NORMALISED, which
  // means they sit near 0.5 by construction and in practice only range over
  // roughly 0.35..0.75. Feeding such a value straight into a visual property
  // wastes most of that property's range: mapping calm to a radius as
  // (0.28 + 0.34*calm) moved the radius by only ~12%, which reads on screen as
  // "it didn't change at all".
  //
  // expand() stretches the band the signal actually occupies to a full 0..1,
  // clamping outside it, so realistic excursions produce visible change.
  function expand(v, lo = 0.35, hi = 0.75) {
    if (v == null || Number.isNaN(v)) return 0.5;
    if (hi <= lo) return 0.5;
    return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  }

  // ---- Smooth deterministic wobble ---------------------------------------
  // Sum of a few sines — no RNG, no per-frame state, and bounded, so it
  // can't drift or accumulate precision problems over a long session.
  function wobble(t, seed) {
    return 0.55 * Math.sin(t * 0.31 + seed * 1.7)
         + 0.30 * Math.sin(t * 0.53 + seed * 3.1)
         + 0.15 * Math.sin(t * 0.87 + seed * 5.3);
  }

  // ---- Pulse: a clock-sweep ring per metric ------------------------------
  // The hand goes round once every few seconds and resets to twelve. Wherever
  // it is now, the ring bulges by however much that metric is doing; the bulge
  // then STAYS and fades as the hand travels on. So a rising metric reads as a
  // spiral of growth — small at three o'clock, bigger at six, biggest at nine —
  // and a subsiding one reads as the reverse, all within one revolution.
  //
  // Pure ring-buffer logic, kept here so the wrap-around and the fade (the two
  // things certain to be subtly wrong on a first attempt) are unit-testable.
  class SweepRing {
    constructor({ bins = 120, revSec = 5 } = {}) {
      this.bins = Math.max(8, bins);
      this.revSec = revSec > 0 ? revSec : 5;
      this.values = new Array(this.bins).fill(0);
      this.cursor = 0;
      this.started = false;
    }

    binAt(tSec) {
      const t = Number.isFinite(tSec) ? tSec : 0;
      let frac = (t % this.revSec) / this.revSec;
      if (frac < 0) frac += 1;
      return Math.min(this.bins - 1, Math.floor(frac * this.bins));
    }

    // Writes `value` into EVERY bin the hand has crossed since the last call,
    // not just the one it landed on. A dropped frame or a slow device would
    // otherwise leave unwritten gaps still holding values from the previous
    // revolution — visible as a ragged notch in the ring.
    write(tSec, value) {
      const target = this.binAt(tSec);
      const v = Math.max(0, Math.min(1, value == null || Number.isNaN(value) ? 0 : value));
      if (!this.started) {
        this.values[target] = v;
        this.cursor = target;
        this.started = true;
        return target;
      }
      let i = this.cursor, guard = 0;
      while (i !== target && guard++ <= this.bins) {
        i = (i + 1) % this.bins;
        this.values[i] = v;
      }
      this.cursor = target;
      return target;
    }

    // 0 = the hand is here right now; approaching 1 = a full revolution ago,
    // i.e. about to be overwritten.
    age(bin) {
      return ((this.cursor - bin + this.bins) % this.bins) / this.bins;
    }

    // The bulge to actually draw: what was recorded, faded by how long ago the
    // hand passed. The oldest bin always lands near 0, so the trail dies out on
    // its own rather than leaving a hard step where the ring buffer wraps.
    faded(bin, curve = 1.15) {
      return this.values[bin] * Math.pow(1 - this.age(bin), curve);
    }
  }

  // "Activity" for Pulse means CHANGE against the metric's own slow baseline,
  // which is what the eye reads as flaring. A little of the absolute level is
  // mixed back in so a steadily-high metric still has presence rather than
  // vanishing — a ring showing nothing during sustained calm would be
  // reporting the opposite of the truth.
  class DeviationTracker {
    constructor({ rate = 0.02, gain = 3.2, levelMix = 0.30 } = {}) {
      this.rate = rate; this.gain = gain; this.levelMix = levelMix;
      this.baseline = null;
    }
    update(v) {
      if (v == null || Number.isNaN(v)) return 0;
      const lvl = Math.max(0, Math.min(1, v));
      if (this.baseline === null) { this.baseline = lvl; return this.levelMix * lvl; }
      const dev = Math.min(1, Math.abs(lvl - this.baseline) * this.gain);
      this.baseline += this.rate * (lvl - this.baseline);
      return Math.min(1, this.levelMix * lvl + (1 - this.levelMix) * dev);
    }
  }

  // Which metrics Pulse draws, and in what colour. Deliberately the same hues
  // as the data panel's composite legend, so a ring and its line on the graph
  // are recognisably the same thing.
  const PULSE_METRICS = [
    { key: 'calm', label: 'Calm', color: [242, 200, 121] },
    { key: 'thinking', label: 'Thinking', color: [255, 125, 171] },
    { key: 'focus', label: 'Focus', color: [125, 211, 252] },
    { key: 'drowsy', label: 'Drowsy', color: [155, 140, 255] },
  ];

  return {
    CHANNEL_COLORS, CORONA_COLORS, CHANNEL_ANGLES, angleDelta, lobeWeight,
    MODES, nextMode, EventDetector, BloomField, wobble, expand,
    BREATH_PATTERNS, nextPattern, breathPattern, ease,
    SweepRing, DeviationTracker, PULSE_METRICS,
  };
});
