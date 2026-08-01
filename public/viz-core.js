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

  // Electrode names, in the same order as CHANNEL_COLORS. Kept here rather than
  // read from DSP so visual.js depends only on viz-core — and so a legend can
  // name what it is drawing without the renderer knowing about the BLE layer.
  const CHANNEL_LABELS = ['TP9', 'AF7', 'AF8', 'TP10'];

  // Eclipse uses its own warm palette rather than the channel hues: the
  // eclipse metaphor wants a sun's corona, and hot magenta/orange/gold on a
  // LIGHT ground is what makes it read as vivid. (Saturated colour added onto
  // near-black trends toward pale grey — that was the real reason earlier
  // versions looked colourless.) Channel order is preserved so each sensor
  // still owns one hue.
  /* Every pair must be TELLABLE APART now that these are keyed in a legend.
     TP9 magenta and TP10 rose were [255,55,165] and [255,80,120] — 51 apart in RGB,
     below the 60 minimum test-ui.js already enforces on the chart palette, and side by
     side in the Eclipse key they read as the same colour. Two swatches you cannot
     distinguish are worse than none: you conclude a sensor is duplicated or dead.
     TP10 moved to a cooler rose-violet, which keeps the warm corona intact — every hue
     here still has a red channel at or near full — while separating it from TP9. */
  const CORONA_COLORS = [
    [255, 55, 165],  // TP9  — magenta
    [255, 125, 55],  // AF7  — orange
    [255, 196, 70],  // AF8  — gold
    [232, 90, 210],  // TP10 — rose-violet
  ];

  /*
   * Iris's palette, which is NOT per-electrode: the disc is coloured by mind state,
   * so warm means thinking and cool means calm regardless of which sensor said so.
   *
   * Here rather than inline in visual.js's irisMindColor specifically so the legend
   * can key off the same constants the renderer mixes. That is not a tidiness
   * preference — the first version of the Iris legend keyed TP9/AF7/AF8/TP10 because
   * it was written from `renderIris`, while the mode actually dispatches to
   * `renderIrisSediment`, which uses none of those colours. It would have named four
   * electrodes for a picture that never draws one, and been believed.
   *
   * Thresholds and mixes live with the renderer; only the endpoints are shared.
   */
  const IRIS_MOOD = {
    thinkingLo: [168, 36, 72],   // deep red, at the threshold
    thinkingHi: [255, 94, 62],   // hot orange-red, thinking high
    calmLo: [44, 150, 176],      // teal, at the threshold
    calmHi: [88, 221, 164],      // green, deeply settled
    mixedLo: [88, 116, 190],     // neither clearly winning
    mixedHi: [170, 88, 164],
    uncertain: [92, 132, 178],   // blue-grey: no clear state
    focusTint: [235, 205, 120],  // gold, mixed in as focus rises
    noiseTint: [112, 112, 120],  // grey: the signal is not trustworthy
  };

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
    { key: 'eclipse', label: 'Eclipse', family: 'core', blurb: 'stillness grows as a void; thinking flares at its edge' },
    { key: 'iris',    label: 'Iris',    family: 'core', blurb: 'your session laid down as a rose window' },
    { key: 'pulse',  label: 'Pulse',  family: 'core', blurb: 'a clock hand sweeps; each metric bulges where it flared' },
    { key: 'corona', label: 'Corona', family: 'core', blurb: 'the same sweep, overlapping and bleeding into one field' },
    { key: 'silk',   label: 'Silk',   family: 'core', blurb: 'iridescent folds settle into a line; thoughts lift slow peaks' },
    { key: 'flow',   label: 'Flow',   family: 'core', blurb: 'a live trace, dissolving as it ages' },
    { key: 'bloom',  label: 'Bloom',  family: 'core', hidden: true, blurb: 'gradients that appear on real events' },
    { key: 'field',  label: 'Field',  family: 'core', hidden: true, blurb: 'one soft band of colour per sensor' },
    { key: 'breath', label: 'Breath', family: 'core', blurb: 'just slow breathing — nothing to read' },
    { key: 'glassbloom', label: 'Slow Bloom', family: 'glass', hidden: true, blurb: 'Bloom rebuilt as slow glass flowers and overlapping light' },
    { key: 'glasssilk', label: 'Glass Silk', family: 'glass', hidden: true, blurb: 'Silk rebuilt as luminous panes that settle into a calm seam' },
    { key: 'prism',  label: 'Prism', family: 'glass', hidden: true, blurb: 'glass-light veils cool with calm and warm with thinking' },
    { key: 'lattice', label: 'Lattice', family: 'glass', hidden: true, blurb: 'sacred geometry steadies as focus returns' },
    { key: 'horizon', label: 'Horizon', family: 'glass', hidden: true, blurb: 'a cinematic focus line that smooths as the mind settles' },
    { key: 'aurora', label: 'Aurora', family: 'glass', hidden: true, blurb: 'slow curtains of colour ripple with thought and cool with calm' },
    { key: 'cathedral', label: 'Cathedral', family: 'glass', hidden: true, blurb: 'a quiet stained-glass rose that becomes orderly with focus' },
    { key: 'tide', label: 'Tide', family: 'glass', hidden: true, blurb: 'slow concentric waves flatten as calm returns' },
  ];

  /*
   * Cycling must SKIP hidden modes, or the keyboard walks through visuals the
   * picker doesn't offer. Hidden modes stay in the array — their index is their
   * identity, and renumbering would silently repoint any stored preference — they
   * are simply not reachable by cycling or by the picker.
   */
  /*
   * Rescale a series to its OWN recent range, for display.
   *
   * Reported as "it looks like it's compressed on the bottom third of the screen", and
   * it was: Flow maps every channel onto one vertical band straight from its value, and
   * the expansion curve it uses was written on the assumption that "every value here is
   * adaptively normalised against the wearer's own baseline, so a real session occupies
   * roughly 0.35..0.75". That is true of the composite scores and FALSE of the per-
   * channel series, which is a raw alpha/(alpha+beta) ratio — deliberately so, since a
   * bounded ratio needs no normaliser to be meaningful.
   *
   * The consequence: a beta-dominant sit (eyes open, thinking, which is most of them)
   * has that ratio sitting around 0.2 for every electrode, so all the traces pin to the
   * floor of the band and the shape — the only thing a live trace is for — is squeezed
   * into the bottom fraction of the space it was given.
   *
   * PERCENTILES, NOT MIN/MAX. One artifact spike sets the max and flattens everything
   * else against the floor; the 5th/95th are robust to exactly that.
   *
   * `minSpan` is the part that keeps this honest. Without it, a channel that genuinely
   * did not move gets its own noise stretched to fill the frame and reads as violent
   * activity — inventing a signal, which is worse than the squashing this fixes. A
   * series whose real range is narrower than minSpan stays narrow on screen.
   */
  /*
   * Hold a range STEADY across frames, widening at once and narrowing slowly.
   *
   * Reported straight after auto-ranging shipped: "the entire line seemed to sort of
   * sink and raise a little bit almost arbitrarily... it feels like the axes are
   * unstable." Exactly right, and it is the cost of recomputing the range every frame.
   * Because the same range is applied to the whole visible history, any change to it
   * moves every past sample — so a range that twitches makes the recorded past appear
   * to move, which is the one thing a history plot must never do.
   *
   * Fast attack, slow release, borrowed from audio gain control:
   *   WIDEN IMMEDIATELY. A sample outside the range would otherwise be clipped, and
   *   silently flattening a real excursion against the edge is worse than a nudge.
   *   NARROW SLOWLY. Nothing is lost by a range that is temporarily too wide — the
   *   trace just uses a little less of the band — so contraction is rate-limited to a
   *   few percent per second and the axis reads as still.
   *
   * `rate` is per second and needs dt, so time is passed in rather than read: same rule
   * as everything else in this file.
   */
  function settleRange(current, target, dtSec, { rate = 0.06 } = {}) {
    if (!target) return current || null;
    if (!current) return { min: target.min, max: target.max, span: target.span };
    const k = Math.min(1, Math.max(0, (rate * Math.max(0, dtSec)) / 1));
    // Widening is instant in whichever direction needs it; narrowing eases.
    const ease = (from, to, widening) => (widening ? to : from + (to - from) * k);
    const min = ease(current.min, target.min, target.min < current.min);
    const max = ease(current.max, target.max, target.max > current.max);
    return { min, max, span: max - min };
  }

  /*
   * How much of this series is sample-to-sample noise rather than signal.
   *
   * The MEDIAN absolute successive difference, not the mean: one artifact would drag a mean
   * upward and report a clean series as noisy. Median is unmoved by a handful of outliers,
   * which is exactly the property wanted for something that decides how far to stretch.
   */
  function noiseLevel(values) {
    const d = [];
    for (let i = 1; i < values.length; i++) {
      const a = values[i - 1], b = values[i];
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      d.push(Math.abs(b - a));
    }
    if (d.length < 4) return 0;
    d.sort((x, y) => x - y);
    return d[Math.floor(d.length / 2)];
  }

  /*
   * NO NOISE-BASED FLOOR HERE, and that is a decision with a measurement behind it.
   *
   * A `noiseFloorMult` was written first — refuse to stretch a series so far that one noisy
   * sample dominates — and then measured across four regimes of drift and noise. It never
   * once changed the range: after smoothing, the median successive difference is far below
   * the fixed 0.12 floor, so `8 x noise` was always the smaller number. Shipping a
   * safeguard that never fires is worse than not shipping one, because it advertises
   * protection that is not there. Removed rather than tuned until it looked busy.
   *
   * The measured jitter after smoothing is ~1.8% of the band in ordinary regimes. The one
   * case still worth watching is a genuine range SMALLER than the noise (7.6% at nine
   * samples of smoothing, 3.5% at twenty-one) — noted in ROADMAP rather than guessed at.
   */
  function autoRange(values, { minSpan = 0.12, lo = 0.05, hi = 0.95 } = {}) {
    const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length < 4) return null;               // not enough to know a range
    const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
    let min = at(lo), max = at(hi);
    const span = max - min;
    if (span < minSpan) {
      // Widen symmetrically about the middle of what was seen, so a steady series sits
      // in the middle of the band rather than being pushed to an edge.
      const mid = (min + max) / 2;
      min = mid - minSpan / 2;
      max = mid + minSpan / 2;
    }
    return { min, max, span: max - min };
  }

  // Where `value` sits in that range, 0..1, clamped. Values outside the percentile
  // window are pinned rather than allowed off the band — an artifact should reach the
  // edge and stop, not leave the frame.
  function inRange(value, range) {
    if (value == null || !range || range.span <= 0) return null;
    return Math.min(1, Math.max(0, (value - range.min) / range.span));
  }

  function visibleModes() { return MODES.filter((m) => !m.hidden); }
  // `dir` of -1 walks backwards. Needed because the keyboard now has both `]` and `[`:
  // with forward-only cycling through seven visuals, going back one meant six presses.
  function nextMode(index, dir = 1) {
    const unit = dir < 0 ? -1 : 1;
    for (let step = 1; step <= MODES.length; step++) {
      // + MODES.length before the second modulo: JS `%` keeps the sign of the dividend,
      // so a backwards walk past index 0 would otherwise produce a negative index.
      const i = (((index + unit * step) % MODES.length) + MODES.length) % MODES.length;
      if (!MODES[i].hidden) return i;
    }
    return index;
  }

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

  // Same idea as expand(), but saturating instead of clamping. A hard clamp
  // draws every excursion beyond the band as a dead flat line pressed against
  // the edge of the frame — fine for a radius, ugly for a trace, and visible in
  // headless screenshots as flat-topped peaks. This asymptotes toward 0 and 1
  // without ever reaching them, so an unusually big excursion still reads as
  // bigger than a merely large one.
  function expandSoft(v, lo = 0.35, hi = 0.75, knee = 2.4) {
    if (v == null || Number.isNaN(v)) return 0.5;
    if (hi <= lo) return 0.5;
    const t = (v - lo) / (hi - lo);
    return 0.5 + 0.5 * Math.tanh((t - 0.5) * knee);
  }

  // Centred moving average over a time series, null-safe and NON-wrapping.
  //
  // Needed because expandSoft() amplifies whatever jitter is already there:
  // stretching the middle third of the range to fill the frame multiplies
  // sample-to-sample noise by the same factor. Fixing "the line is flat" that
  // way directly produced "the line is too jumpy". The answer is not less
  // expansion — it is smoothing in TIME, which removes the jitter and keeps the
  // real excursions.
  //
  // Centred rather than a running EMA on purpose: an EMA lags, and a lagging
  // trace next to a live head that is not lagging looks wrong. A centred window
  // has no phase error. Ends use whatever part of the window exists.
  function smoothSeries(values, window = 5) {
    if (!Array.isArray(values)) return [];
    const half = Math.floor(window / 2);
    if (half < 1) return values.slice();
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let sum = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        const v = values[i + k];
        if (v == null || Number.isNaN(v)) continue;
        sum += v; n++;
      }
      // A run with no usable neighbours at all stays null rather than becoming
      // a fabricated number.
      out[i] = n ? sum / n : (values[i] == null ? null : values[i]);
    }
    return out;
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
    // hand passed.
    //
    // `leadIn` is what closes the seam. Fading on age alone leaves the freshest
    // bin at full height sitting immediately next to the oldest bin at zero —
    // adjacent in space, a whole revolution apart in time — which draws as a
    // hard step at twelve o'clock. Ramping the newest few bins up from nothing
    // makes the trail taper at BOTH ends, so it closes on itself invisibly. The
    // cost is that the bulge lags the hand by a fraction of a second, which is
    // not perceptible.
    faded(bin, curve = 1.15, leadIn = 0.06) {
      const a = this.age(bin);
      const tail = Math.pow(1 - a, curve);
      const lead = leadIn > 0 ? Math.min(1, a / leadIn) : 1;
      return this.values[bin] * tail * lead;
    }

    // The whole ring as a smoothed profile, ready to become radii.
    //
    // `smoothBins` matters more than it looks. Physiological scores jitter
    // second to second, and one bin per sample turns that jitter into a
    // seismograph outline — sharp angular spikes that read as a broken shape
    // rather than a bleeding gradient. A short circular moving average keeps the
    // real rise and fall while removing the noise, and it must WRAP, or the
    // smoothing itself reintroduces a discontinuity at twelve o'clock.
    profile({ curve = 1.15, leadIn = 0.06, smoothBins = 7 } = {}) {
      const raw = new Array(this.bins);
      for (let b = 0; b < this.bins; b++) raw[b] = this.faded(b, curve, leadIn);
      const half = Math.max(0, Math.floor(smoothBins / 2));
      if (!half) return raw;
      const out = new Array(this.bins);
      for (let b = 0; b < this.bins; b++) {
        let sum = 0, n = 0;
        for (let k = -half; k <= half; k++) {
          sum += raw[(b + k + this.bins) % this.bins];
          n++;
        }
        out[b] = sum / n;
      }
      return out;
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
  // `base` is where that metric's ring sits, as a fraction of the disc radius,
  // and `out` is which way its bulge grows. The arrangement is deliberate: the
  // steadier, quieter states live INSIDE the void and glow outward from within
  // it, while the noisy, flaring ones live outside and peak past the rim. So
  // settling reads as the centre filling with light, and thinking reads as
  // something spiking at the edges — which is how they actually feel.
  //
  // The bases overlap rather than being neatly stacked: rings bleed into each
  // other like gradients instead of sitting in tidy separate lanes, but each
  // still starts somewhere different so you can pick it out.
  const PULSE_METRICS = [
    { key: 'calm', label: 'Calm', color: [242, 200, 121], base: 0.30, out: -1 },
    { key: 'focus', label: 'Focus', color: [125, 211, 252], base: 0.46, out: -1 },
    { key: 'thinking', label: 'Thinking', color: [255, 125, 171], base: 0.62, out: 1 },
    { key: 'drowsy', label: 'Drowsy', color: [155, 140, 255], base: 0.78, out: 1 },
  ];

  // What a visual is currently showing, as label/colour pairs — so a legend is
  // generated from the same source the renderer draws from and cannot drift out
  // of sync with it. That drift is not hypothetical: the chart's electrode
  // colours had diverged from the visual's, so a ribbon and its own line on the
  // graph were different colours.
  function legendEntries({ composites = false, breath = false } = {}) {
    const out = composites
      ? PULSE_METRICS.map((m) => ({ label: m.label, color: m.color }))
      : CHANNEL_LABELS.map((label, i) => ({ label, color: CHANNEL_COLORS[i] }));
    // Breath last, and white, matching how it is drawn: a phase about a midpoint
    // rather than one of the four levels.
    if (breath) out.push({ label: 'Breath', color: [255, 255, 255], faint: true });
    return out;
  }

  /*
   * A KEY FOR EVERY VISUAL, not just Flow.
   *
   * Reported twice: "I don't know what these colors actually mean. Thinking and
   * drowsy." A visual that responds to your physiology and does not say what it is
   * responding to is decoration — you cannot use it to notice anything, because you
   * cannot tell a real change from a rendering flourish.
   *
   * TWO KINDS OF ENTRY, because these visuals encode two different kinds of thing:
   *
   *   { label, color }  a colour key — this hue IS that series
   *   { text }          an encoding, in words: what growing, brightening or
   *                     flattening means. Pulse's colours are a key; Eclipse's
   *                     expanding void is not a colour at all, and no swatch can
   *                     explain it.
   *
   * THE NOTES ARE DERIVED FROM THE RENDERERS, and every one below was read out of
   * the drawing code rather than guessed from the mode's blurb. A legend that is
   * plausible but wrong is worse than none: it would be believed, and it would send
   * someone looking for a state change that the picture never showed. Whoever edits
   * a renderer's encoding has to edit its note here too — test-viz.js checks that
   * the colours still come from the same arrays the renderers index, which catches
   * the palette half of that drift but cannot check the prose.
   */
  const LEGENDS = {
    // Warm corona palette, one hue per electrode — see CORONA_COLORS.
    eclipse: {
      palette: 'corona',
      notes: ['void grows — settling', 'corona reaches out — thinking'],
    },
    /* MIND STATE, NOT ELECTRODES — see IRIS_MOOD and visual.js's irisMindColor.
       The disc is one colour per moment, chosen from calm/thinking/focus/noise, and
       deposited outward as a record of the sit. This is the mode the "I don't know
       what these colors mean" complaint was about, and the answer is the palette
       rather than a channel key. */
    iris: {
      swatches: [
        { label: 'thinking', color: IRIS_MOOD.thinkingHi },
        { label: 'calm', color: IRIS_MOOD.calmHi },
        { label: 'focus', color: IRIS_MOOD.focusTint },
        { label: 'poor signal', color: IRIS_MOOD.noiseTint, faint: true },
      ],
      /* `%DEPOSIT%` is filled in by legendFor from the interval the renderer is
         actually using. Hardcoding "every 5s" was accurate only when no session
         timer was set — with a 40-minute timer the rings are 20s apart, and a key
         that states the wrong number is the thing this whole file exists to
         prevent. */
      notes: ['colour is the whole mind, not one sensor',
        'a ring laid down every %DEPOSIT%, growing outward',
        'so the middle is the start of the sit'],
    },
    // One SweepRing per composite metric, PULSE_REV_SEC per revolution.
    pulse: {
      palette: 'metrics',
      notes: ['one lane each · 24s per turn', 'bulges where it flared'],
    },
    corona: {
      palette: 'metrics',
      notes: ['all four in one field · 24s per turn', 'colour shows which flared'],
    },
    /* Silk has no per-series colour: its hue is a cool-to-warm mix driven by focus
       (renderSilk mixes [60,190,255]..[154,91,230] toward [255,110,69]..[255,200,151]).
       So the swatches name the ENDS of that mix rather than four series. */
    silk: {
      swatches: [
        { label: 'focused', color: [255, 150, 110] },
        { label: 'unfocused', color: [80, 190, 250] },
      ],
      notes: ['flat horizon — calm', 'peaks and vibration — thinking'],
    },
    /* Flow is the only mode that follows the Sensors/Composites switch, so its key is
       whatever is actually being traced right now.
       The note is not optional: each line is scaled to its OWN recent range (see
       autoRange), so vertical position shows change rather than level. Without saying
       so, two lines crossing looks like two values becoming equal, which it is not. */
    flow: { follows: true, notes: ['height is each line’s own recent range, not a level'] },
    // No colour key: Breath draws one form and is explicitly "nothing to read".
    // The two lines are still worth having — which direction is the in-breath is
    // the one thing about it that is not self-evident.
    breath: { notes: ['expanding — in-breath', 'contracting — out-breath'] },
  };

  // "20s", or "1m 40s" once the interval passes a minute. Whole seconds only: this is
  // a caption, and "every 20.4s" reads as precision nobody asked for.
  function humanInterval(sec) {
    const s = Math.max(1, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }

  function legendFor(modeKey, {
    composites = false, breath = false, depositSec = null, omitSeries = null,
  } = {}) {
    const spec = LEGENDS[modeKey];
    if (!spec) return [];                      // hidden/experimental modes: no key yet
    /* `omitSeries` drops lines that are not being drawn — an electrode with no contact
       is absent from the picture, and a key naming it is a small lie of its own: the
       reader looks for a line that was never there and concludes it is flat. */
    const omitted = new Set(omitSeries || []);
    const keep = (list) => list.filter((e) => !omitted.has(e.label));
    if (spec.follows) {
      const base = keep(legendEntries({ composites, breath }));
      // A key with nothing in it gets no caption either — an electrode that never made
      // contact is absent from the picture, so there is nothing for a note to describe.
      if (!base.length) return base;
      return base.concat((spec.notes || []).map((text) => ({ text })));
    }
    const out = [];
    if (spec.palette === 'metrics') {
      out.push(...PULSE_METRICS.map((m) => ({ label: m.label, color: m.color })));
    } else if (spec.palette === 'corona') {
      out.push(...CHANNEL_LABELS.map((label, i) => ({ label, color: CORONA_COLORS[i] })));
    } else if (spec.palette === 'channels') {
      out.push(...CHANNEL_LABELS.map((label, i) => ({ label, color: CHANNEL_COLORS[i] })));
    }
    if (spec.swatches) out.push(...spec.swatches.map((s) => ({ ...s })));
    if (omitted.size) {
      for (let i = out.length - 1; i >= 0; i--) if (omitted.has(out[i].label)) out.splice(i, 1);
    }
    if (spec.notes) {
      // Only substitute when the interval is actually known. Otherwise drop the line
      // rather than print a placeholder or invent a default — a key that says the
      // wrong number is worse than one that says nothing.
      const deposit = depositSec != null && depositSec > 0 ? humanInterval(depositSec) : null;
      for (const text of spec.notes) {
        if (!text.includes('%DEPOSIT%')) { out.push({ text }); continue; }
        if (deposit) out.push({ text: text.replace('%DEPOSIT%', deposit) });
      }
    }
    return out;
  }

  return {
    CHANNEL_COLORS, CHANNEL_LABELS, legendEntries, LEGENDS, legendFor, IRIS_MOOD,
    CORONA_COLORS, CHANNEL_ANGLES, angleDelta, lobeWeight,
    MODES, nextMode, visibleModes, autoRange, inRange, settleRange, noiseLevel, EventDetector, BloomField, wobble, expand, expandSoft, smoothSeries,
    BREATH_PATTERNS, nextPattern, breathPattern, ease,
    SweepRing, DeviationTracker, PULSE_METRICS,
  };
});
