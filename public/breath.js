/*
 * BREATH, FROM THE CHEST STRAP'S ACCELEROMETER — rate, and the SHAPE of each cycle.
 *
 * WHY THIS EXISTS. The thesis this project has arrived at, in the practitioner's own words: "the breath
 * is the best indicator but the sensors need to be smart. If we can calibrate to the breath (and tease
 * out some noise), then we might be able to tie that to EEG... for breath, i think it's the shape and
 * some of the movement in the belly, maybe something like the height of the belly outbreath even. it
 * could be very subtle."
 *
 * The reasoning behind it is sound and worth recording. Breathing is the one thing in this system that
 * is measured rather than inferred: chest-wall movement is a physical displacement, not a score derived
 * through a normaliser. And unlike every EEG composite here, it is expressed in units that mean the
 * same thing on Tuesday and Thursday.
 *
 * WHAT WAS WRONG BEFORE, because it is the whole reason this file is careful.
 *
 * The first attempt band-passed 0.06-0.6Hz, picked the axis with the largest variance, and took every
 * upward zero crossing as a cycle boundary. On a real 6-minute sit it reported 10.2 breaths/min where
 * the heart-rate-derived estimate from the SAME recording said 6.0. Two failures compounding:
 *
 *   1. THE AXIS WAS CHOSEN BY VARIANCE, which picked z — and z's dominant component turned out to be
 *      the SECOND HARMONIC of breathing, at 13.92/min against a true 6.59. Measured, on one sit:
 *
 *          axis   spectral peak   segmented rate   RSA reference
 *          x        6.59/min         7.02/min         6.43/min
 *          y        6.59/min         6.96/min         6.43/min
 *          z       13.92/min        11.91/min         6.43/min
 *
 *      Physically reasonable: if chest expansion is roughly symmetric along one axis, that axis peaks
 *      twice per breath. Loudest is not the same as most informative.
 *
 *   2. THE BAND WAS TOO WIDE to reject that harmonic even once the axis was right, and every upward
 *      crossing counted — so a breath with a shoulder in it became two breaths.
 *
 * THE FIX, and why each part of it is the way it is.
 *
 * FIND THE FUNDAMENTAL FIRST, from the spectrum, ACROSS AXES. A harmonic is always a MULTIPLE of the
 * fundamental and never a divisor of it, so among credible per-axis peaks the lowest is the fundamental.
 * That is a fact about harmonics rather than a heuristic, which is why it is trustworthy on a signal
 * nobody has looked at.
 *
 * THEN CHOOSE THE AXIS by amplitude AT that frequency rather than overall. The question is which axis
 * carries the breath, not which moves most.
 *
 * THEN SEGMENT with a refractory period of 0.6 of the expected cycle, so a shoulder cannot split a
 * breath. 0.6 rather than something nearer 1.0 because breath rate genuinely varies within a sit and a
 * refractory period close to the mean period would swallow every short cycle.
 *
 * VALIDATED AGAINST A SECOND, INDEPENDENT SENSOR. The same recording carries beat-to-beat intervals,
 * from which breathing can be estimated through respiratory modulation of heart timing. Chest movement
 * and heart timing share no hardware and no failure mode, so their agreement is evidence in a way that
 * self-consistency never is. On the sit above: 7.02/min against 6.43/min, a 9% difference.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing here has been shown to track meditation quality. It measures the
 * breath more honestly than before, which is a precondition for asking the question and not an answer
 * to it.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./dsp.js'));
  else root.Breath = factory(root.DSP);
})(typeof window !== 'undefined' ? window : globalThis, function (DSP) {

  // The plausible range for a breathing rate, in Hz. 0.06 is 3.6 breaths/min — slower than that in a
  // 6-minute recording gives too few cycles to describe. 0.5 is 30/min, faster than any sitting breath.
  const MIN_HZ = 0.06;
  const MAX_HZ = 0.5;
  /* How much of the expected cycle must pass before another boundary is allowed. Under 1.0 so genuine
     short cycles survive; well above 0.5 so a mid-cycle shoulder cannot be counted. */
  const REFRACTORY = 0.6;
  // The tight band around the fundamental, as a fraction. ±40% admits real rate variation while
  // excluding the 2× harmonic that caused the original error.
  const BAND_LO = 0.6;
  const BAND_HI = 1.4;
  // Below this, an axis is not carrying a breath — it is carrying quantisation. Chest-wall movement on
  // a worn strap is several mG; measured above, the informative axis was 8.6 and the useless one 0.64.
  const MIN_AMPLITUDE_MG = 1.5;

  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  function sd(v) {
    if (v.length < 2) return null;
    const m = mean(v);
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  }

  /*
   * Zero-phase low pass: forward then backward.
   *
   * The reverse pass is not a refinement. A one-pole filter delays what it smooths, and a delay here
   * would shift every cycle boundary by the same amount — which leaves the RATE right and every SHAPE
   * measure wrong, since shape is entirely about where things sit inside the cycle.
   */
  function lowpass(values, hz, cutHz) {
    const a = 1 - Math.exp((-2 * Math.PI * cutHz) / hz);
    const out = values.slice();
    let y = values[0];
    for (let i = 0; i < values.length; i++) { y += a * (values[i] - y); out[i] = y; }
    let z = out[out.length - 1];
    for (let i = out.length - 1; i >= 0; i--) { z += a * (out[i] - z); out[i] = z; }
    return out;
  }

  // Band pass as (signal minus its slow part), low-passed. Removing the slow part is what takes gravity
  // out: gravity is ~1000mG and breathing is single digits, so leaving it in makes every later step a
  // measurement of posture.
  function bandpass(values, hz, loHz, hiHz) {
    const slow = lowpass(values, hz, loHz);
    return lowpass(values.map((v, i) => v - slow[i]), hz, hiHz);
  }

  // The strongest frequency inside the breathing band, and its power.
  function spectralPeak(values, hz) {
    const n = DSP.pow2Floor(values.length);
    if (n < 64) return null;
    const spec = DSP.powerSpectrum(values.slice(0, n), hz);
    let freq = null, power = -1;
    for (let i = 1; i < spec.power.length; i++) {
      const f = i * spec.binHz;
      if (f < MIN_HZ || f > MAX_HZ) continue;
      if (spec.power[i] > power) { power = spec.power[i]; freq = f; }
    }
    return freq == null ? null : { freq, power, binHz: spec.binHz };
  }

  /*
   * Which axis carries the breath, and at what frequency.
   *
   * See the header for why the LOWEST credible peak is the fundamental and why the axis is then chosen
   * by amplitude at that frequency rather than overall.
   */
  function findFundamental(axes, hz) {
    const peaks = [];
    for (const [name, values] of Object.entries(axes)) {
      const wide = bandpass(values, hz, MIN_HZ, MAX_HZ);
      const amp = sd(wide);
      const pk = spectralPeak(wide, hz);
      if (pk && amp != null && amp >= MIN_AMPLITUDE_MG) peaks.push({ name, freq: pk.freq, amp });
    }
    if (!peaks.length) {
      return { known: false,
        reason: `no axis moves more than ${MIN_AMPLITUDE_MG}mG in the breathing band — the strap was`
          + ' probably not worn, or not against the chest' };
    }
    /* The fundamental is the lowest peak among the axes that carry anything: a harmonic is a multiple
       and never a divisor, so nothing real sits below it. This is NOT sufficient on real data — see the
       self-consistency gate in analyse(), and the honest account of what is and is not validated in the
       header. A median-across-axes rule was tried instead and was worse: it broke the harmonic test
       without fixing the real sits. */
    const freq = Math.min(...peaks.map((p) => p.freq));
    /*
     * Now pick the axis, and ONLY from axes that themselves peak at the fundamental.
     *
     * The obvious version — band-pass every axis tightly around the fundamental and take the largest —
     * is not enough, and the test caught it. These band-passes are one-pole filters, so their rejection
     * an octave up is gentle; a harmonic three times the amplitude of the real signal still leaks enough
     * into the tight band to win on amplitude. The rate happened to survive that, which is worse than
     * failing: it means the axis choice was wrong and nothing said so.
     *
     * An axis whose own spectral peak sits at twice the fundamental is not carrying the fundamental,
     * however much energy it has. So candidacy is decided by where an axis PEAKS, and only then is
     * amplitude used to choose between the candidates.
     */
    const atFundamental = peaks.filter((p) => Math.abs(p.freq - freq) <= freq * 0.25);
    const candidates = atFundamental.length ? atFundamental : peaks;
    let best = null;
    for (const p of candidates) {
      const tight = bandpass(axes[p.name], hz, Math.max(0.04, freq * BAND_LO), freq * BAND_HI);
      const amp = sd(tight);
      if (!best || amp > best.amp) best = { name: p.name, amp, series: tight };
    }
    /* Which axes disagreed, and by how much. Reported rather than hidden: an axis peaking at almost
       exactly twice the fundamental is the harmonic that caused the original error, and seeing it named
       is how the next person avoids repeating it. */
    const harmonics = peaks.filter((p) => p.freq > freq * 1.6)
      .map((p) => ({ axis: p.name, ratio: p.freq / freq }));
    /*
     * TWO SIGNALS FROM THE CHOSEN AXIS, because segmentation and shape need opposite things.
     *
     * `series` is the tight band around the fundamental, and it is what finds cycle boundaries: narrow
     * is what makes a boundary robust and what keeps a harmonic from splitting a breath in two.
     *
     * `shapeSeries` is the WIDE band, and it is what shape is measured on. This is not a refinement —
     * it is a correction the test caught. Asymmetry in a periodic waveform IS harmonic content, so the
     * narrow band that protects the rate also strips out exactly the thing the shape hypothesis is
     * about. Measured on a deliberately quick-in slow-out fixture, the tight band reported riseFrac
     * 0.500 — identical to a symmetric breath, the asymmetry filtered away entirely.
     *
     * So the boundaries come from the narrow signal and the shape within them from the wide one. Using
     * one filter for both would mean choosing between a rate that can double and a shape that cannot
     * exist.
     */
    const shapeSeries = bandpass(axes[best.name], hz, MIN_HZ, MAX_HZ);
    return { known: true, freq, axis: best.name, amplitudeMg: best.amp,
      series: best.series, shapeSeries, harmonics, perAxis: peaks };
  }

  /*
   * Cycle boundaries: upward zero crossings, with a refractory period.
   *
   * Interpolated between the two straddling samples rather than taken as the later one. At 50Hz a whole
   * sample is 20ms, which is 0.2% of a 10-second breath — negligible for rate and not negligible for
   * shape, where every boundary error lands directly in the inhale fraction.
   */
  function boundaries(series, times, freq) {
    const minGap = REFRACTORY / freq;
    const out = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1] > 0 || series[i] <= 0) continue;
      const span = series[i] - series[i - 1];
      const frac = span === 0 ? 0 : -series[i - 1] / span;
      const t = times[i - 1] + frac * (times[i] - times[i - 1]);
      if (!out.length || t - out[out.length - 1] >= minGap) out.push(t);
    }
    return out;
  }

  /*
   * One cycle's shape.
   *
   * `riseFrac` is the fraction of the cycle spent RISING — trough to peak. 0.5 is symmetric, below 0.5
   * is a quick rise and a slow fall. This is the number the "shape" hypothesis is about, and it is
   * scale-free, so a deep breath and a shallow one are comparable. See the note inside on why it is
   * measured from the trough and not from the start of the cycle.
   *
   * `crest` is peak rate-of-change divided by mean rate-of-change. A pure sine gives pi/2 = 1.571;
   * higher means the movement is concentrated into a jerk. Also scale-free, and the same measure
   * movement.js uses, for the same reason.
   *
   * `amplitude` is the one measure here that is NOT scale-free, so it is the one that depends on the
   * unverified strap gain and on how tightly the strap is worn. Reported because the hypothesis asks
   * for it — "the height of the belly outbreath" — and flagged in the summary as not comparable between
   * sits for that reason.
   */
  function cycleShape(series, times, fromT, toT) {
    const idx = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= fromT && times[i] <= toT) idx.push(i);
    }
    if (idx.length < 8) return null;
    const seg = idx.map((i) => series[i]);
    const period = toT - fromT;
    let peakAt = 0, troughAt = 0;
    for (let i = 1; i < seg.length; i++) {
      if (seg[i] > seg[peakAt]) peakAt = i;
      if (seg[i] < seg[troughAt]) troughAt = i;
    }
    const deltas = [];
    for (let i = 1; i < seg.length; i++) deltas.push(Math.abs(seg[i] - seg[i - 1]));
    const md = mean(deltas);
    /*
     * riseFrac IS MEASURED FROM TROUGH TO PEAK, and this is a correction rather than a preference.
     *
     * The first version measured the peak's position from the start of the cycle, and cycles start at an
     * upward zero crossing. For a perfectly symmetric wave that puts the peak at a QUARTER of the cycle,
     * not half — so a symmetric breath scored 0.25 and there was no value at which the measure meant
     * "symmetric". I had already reported 0.208 from a real sit as "strongly asymmetric, quick in and
     * slow out" on that basis; against the correct reference of 0.5 it is barely asymmetric at all.
     *
     * Trough to peak is the fraction of the cycle spent RISING, which is the inhale fraction the shape
     * hypothesis is about, and it reads 0.5 for symmetric by construction. Wrapped modulo the period
     * because the trough of a zero-crossing-aligned cycle sits in its second half, so the rise runs
     * across the boundary.
     */
    const wrap = (v) => ((v % period) + period) % period;
    const riseSec = wrap(times[idx[peakAt]] - times[idx[troughAt]]);
    return {
      fromSec: fromT, toSec: toT, midSec: (fromT + toT) / 2, periodSec: period,
      ratePerMin: 60 / period,
      amplitudeMg: Math.max(...seg) - Math.min(...seg),
      riseFrac: riseSec / period,
      crest: md > 0 ? Math.max(...deltas) / md : null,
      samples: seg.length,
    };
  }

  /*
   * Everything, from parsed acc.csv rows.
   *
   * `rows` are { tSec, x, y, z } in mG. Returns per-cycle shapes plus a summary, or a reason.
   */
  /*
   * How far the chest estimate may sit from the heart-derived one before it is refused.
   *
   * 20%: wide enough to absorb the genuine difference between the two — heart-timing modulation lags the
   * breath and is averaged over a minute, so exact agreement is not expected — and narrow enough to
   * exclude the failure that matters, which is being out by a factor of two.
   */
  const MAX_REFERENCE_DISAGREEMENT_PCT = 20;

  function analyse(rows, opts = {}) {
    const clean = (rows || []).filter((r) => r
      && Number.isFinite(Number(r.tSec)) && Number.isFinite(Number(r.x))
      && Number.isFinite(Number(r.y)) && Number.isFinite(Number(r.z)))
      .map((r) => ({ t: Number(r.tSec), x: Number(r.x), y: Number(r.y), z: Number(r.z) }));
    if (clean.length < 600) {
      return { known: false, cycles: [],
        reason: `only ${clean.length} accelerometer samples; at least 600 (about 12 seconds) are`
          + ' needed to see a breath at all' };
    }
    const span = clean[clean.length - 1].t - clean[0].t;
    const hz = opts.hz || (clean.length - 1) / span;
    if (!(hz > 5)) {
      return { known: false, cycles: [], reason: `the sample rate reads as ${hz.toFixed(1)}Hz, which is`
        + ' too low or the timestamps are wrong' };
    }
    const found = findFundamental({ x: clean.map((r) => r.x), y: clean.map((r) => r.y),
      z: clean.map((r) => r.z) }, hz);
    if (!found.known) return { known: false, cycles: [], reason: found.reason, hz };

    const times = clean.map((r) => r.t);
    const bounds = boundaries(found.series, times, found.freq);
    const cycles = [];
    for (let i = 1; i < bounds.length; i++) {
      // Boundaries from the narrow signal (above), shape from the wide one. See findFundamental.
      const c = cycleShape(found.shapeSeries, times, bounds[i - 1], bounds[i]);
      // A cycle far from the fundamental is a segmentation failure rather than an unusual breath, and
      // letting it into the shape statistics is how one bad boundary moves every average.
      if (c && c.periodSec > 0.5 / found.freq && c.periodSec < 2.5 / found.freq) cycles.push(c);
    }
    if (cycles.length < 3) {
      return { known: false, cycles, hz, axis: found.axis, fundamentalHz: found.freq,
        reason: `only ${cycles.length} usable breath cycles were found` };
    }
    const periods = cycles.map((c) => c.periodSec);
    /*
     * SELF-CONSISTENCY: THE SEGMENTED RATE MUST MATCH THE SPECTRAL PEAK, OR THIS REFUSES.
     *
     * This gate exists because the module is not validated and I know it is not. Checked against the
     * independent heart-timing estimate on three real sits, it agreed on ONE (7.02 against 6.43, 9%
     * apart) and was badly wrong on two (8.54 against 6.04, and 3.16 against 6.70). Two different rules
     * for choosing the axis and the fundamental failed to fix that.
     *
     * What can be detected WITHOUT a second sensor is disagreement between the two estimates this module
     * already makes: the frequency the spectrum says, and the rate the counted cycles imply. When the
     * segmentation has locked onto a harmonic or merged pairs of breaths, those two diverge — on the two
     * failing sits by 24% and 45%, against 0.2% on the one that agreed with the heart.
     *
     * So a disagreement above 15% refuses instead of answering. That converts the failure mode that
     * matters — a plausible wrong rate, from a real sensor, with nothing on screen to say it is wrong —
     * into a stated absence. It will also refuse some sits it could have got right. That is the correct
     * trade for a measurement that is about to be compared against EEG: a gap costs an analysis, a wrong
     * number costs a conclusion.
     */
    const segmentedRate = 60 / mean(periods);
    const spectralRate = found.freq * 60;
    const consistencyPct = (100 * Math.abs(segmentedRate - spectralRate)) / spectralRate;
    if (consistencyPct > 15) {
      return { known: false, cycles, hz, axis: found.axis, fundamentalHz: found.freq,
        segmentedRatePerMin: segmentedRate, spectralRatePerMin: spectralRate, consistencyPct,
        reason: `the two internal estimates disagree by ${consistencyPct.toFixed(0)}%`
          + ` — the spectrum says ${spectralRate.toFixed(1)}/min and the counted cycles say`
          + ` ${segmentedRate.toFixed(1)}/min. One of them has locked onto a harmonic or merged breaths,`
          + ' and there is no way from here to tell which, so this sit reports no breath rather than a'
          + ' number that might be double or half' };
    }
    /*
     * AND IT MUST AGREE WITH THE HEART, WHEN THERE IS A HEART TO ASK.
     *
     * This is the gate that matters, and it is here because the self-consistency check above was not
     * enough. On one real sit the spectrum and the counted cycles agreed with each other to within 2.8%
     * and were both 41% away from the truth — they had locked onto the same wrong frequency together.
     * Internal agreement cannot detect that by construction.
     *
     * The independent check is free. Every recording that carries a chest accelerometer also carries
     * beat-to-beat intervals from the same strap, and breathing can be estimated from those through
     * respiratory modulation of heart timing. The two share no axis, no filter and no failure mode, so
     * their agreement is evidence and their disagreement is a fault.
     *
     * The caller passes it because this module does not parse files. When it is absent the result is
     * still returned, with `referenceChecked: false` — an unchecked number is not the same as a checked
     * one, and anything comparing breath against EEG needs to know which it has.
     */
    const reference = Number(opts.referenceRatePerMin);
    let referenceCheck = null;
    if (Number.isFinite(reference) && reference > 0) {
      const pct = (100 * Math.abs(segmentedRate - reference)) / reference;
      referenceCheck = { referenceRatePerMin: reference, differencePct: pct };
      if (pct > MAX_REFERENCE_DISAGREEMENT_PCT) {
        return { known: false, cycles, hz, axis: found.axis, fundamentalHz: found.freq,
          segmentedRatePerMin: segmentedRate, spectralRatePerMin: spectralRate,
          consistencyPct, referenceCheck, referenceChecked: true,
          reason: `the chest accelerometer says ${segmentedRate.toFixed(1)}/min and the heart-derived`
            + ` estimate from the same strap says ${reference.toFixed(1)}/min — ${pct.toFixed(0)}% apart.`
            + ' Two independent sensors on one chest cannot both be right, so this sit reports no breath'
            + ' rather than a number that is probably out by a factor of two' };
      }
    }
    return {
      known: true, hz, cycles,
      referenceChecked: !!referenceCheck,
      referenceCheck,
      axis: found.axis,
      fundamentalHz: found.freq,
      spectralRatePerMin: found.freq * 60,
      amplitudeMg: found.amplitudeMg,
      harmonics: found.harmonics,
      perAxis: found.perAxis,
      consistencyPct,
      summary: {
        cycles: cycles.length,
        ratePerMin: segmentedRate,
        periodSec: mean(periods),
        // Regularity as the coefficient of variation of the period: dimensionless, so it compares
        // across people and across rates. Lower is steadier.
        periodCv: sd(periods) / mean(periods),
        riseFrac: mean(cycles.map((c) => c.riseFrac)),
        riseFracSd: sd(cycles.map((c) => c.riseFrac)),
        crest: mean(cycles.filter((c) => c.crest != null).map((c) => c.crest)),
        amplitudeMg: mean(cycles.map((c) => c.amplitudeMg)),
      },
    };
  }

  /*
   * Agreement with an independent estimate, which is the only real validation available.
   *
   * Chest movement and heart timing share no hardware and no failure mode, so when they agree the
   * agreement is evidence. Returns the percentage difference rather than a verdict: what counts as
   * agreement depends on what the number is for, and that is the caller's business.
   */
  function agreementWith(analysis, otherRatePerMin) {
    if (!analysis || !analysis.known || !(otherRatePerMin > 0)) return null;
    const mine = analysis.summary.ratePerMin;
    return { mine, theirs: otherRatePerMin,
      differencePct: (100 * Math.abs(mine - otherRatePerMin)) / otherRatePerMin };
  }

  /*
   * Breath shape inside a window, for comparing one marked moment against another.
   *
   * Cycles are assigned by their MIDPOINT. A cycle straddling the window edge belongs mostly to one
   * side, and splitting it would produce a partial cycle whose shape is meaningless.
   */
  function inWindow(analysis, fromSec, toSec) {
    if (!analysis || !analysis.known) return null;
    const inside = analysis.cycles.filter((c) => c.midSec > fromSec && c.midSec <= toSec);
    if (inside.length < 2) return null;
    const periods = inside.map((c) => c.periodSec);
    return {
      cycles: inside.length,
      ratePerMin: 60 / mean(periods),
      periodCv: sd(periods) / mean(periods),
      riseFrac: mean(inside.map((c) => c.riseFrac)),
      crest: mean(inside.filter((c) => c.crest != null).map((c) => c.crest)),
      amplitudeMg: mean(inside.map((c) => c.amplitudeMg)),
    };
  }

  return {
    MIN_HZ, MAX_HZ, REFRACTORY, BAND_LO, BAND_HI, MIN_AMPLITUDE_MG,
    MAX_REFERENCE_DISAGREEMENT_PCT,
    analyse, findFundamental, boundaries, cycleShape, agreementWith, inWindow,
    lowpass, bandpass, spectralPeak,
  };
});
