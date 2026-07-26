/*
 * Polar H10 chest strap — protocol parsing and HRV math.
 *
 * WHY A SECOND DEVICE AT ALL
 * Every interpretive score in this app comes from four EEG electrodes, and the
 * two that matter sit on a forehead that sweats, moves, and tenses. A chest
 * strap is a completely different kind of measurement: ECG-grade beat timing,
 * far more robust than EEG in a room full of people, and the direct source for
 * the one thing metrics.js has been returning `null` for since it was written —
 * HRV, which is what `equanimity` needs.
 *
 * WHY THE STANDARD SERVICE, NOT POLAR'S OWN
 * Polar also exposes a proprietary PMD service for raw ECG and accelerometer.
 * We don't use it. The standard Bluetooth Heart Rate Service (0x180D) already
 * carries RR intervals — the beat-to-beat timings — which is exactly and only
 * what HRV is computed from. Standard, documented, stable across firmware, and
 * it works with any HR strap rather than just this one.
 *
 * TWO DEVICES AT ONCE IS FINE
 * Web Bluetooth connects devices independently. Each requestDevice() call needs
 * its own user gesture (a click), and each returns its own GATT connection. The
 * Muse and the strap do not contend for anything.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Polar = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Standard Bluetooth SIG assigned numbers.
  const HR_SERVICE = 0x180d;
  const HR_MEASUREMENT = 0x2a37;
  const BATTERY_SERVICE = 0x180f;
  const BATTERY_LEVEL = 0x2a19;

  // RR intervals arrive in units of 1/1024 of a second, not milliseconds.
  const RR_UNIT_MS = 1000 / 1024;

  // Physiologically plausible beat-to-beat interval, in ms: 2000 -> 30bpm,
  // 300 -> 200bpm. Anything outside this is a dropped or doubled beat.
  const RR_MIN_MS = 300;
  const RR_MAX_MS = 2000;
  // A real beat-to-beat change is small. A jump this large is an ectopic beat or
  // a missed detection, and it MUST be discarded before computing RMSSD —
  // RMSSD squares successive differences, so one missed beat can inflate it
  // several-fold and would read as a sudden flood of parasympathetic calm.
  const RR_MAX_STEP_FRACTION = 0.25;

  // Minimum respiratory swing in heart rate, in bpm, for a breath phase to be
  // worth reporting. Real RSA at rest is several bpm; below this the "waveform"
  // is noise. RSA also shrinks as heart rate rises, so a fast heart legitimately
  // yields no reading — which must show as no reading, not as a pegged bar.
  const RSA_MIN_BPM = 1.2;

  /*
   * Heart Rate Measurement characteristic (0x2A37).
   *
   * Byte 0 is a flags bitfield; everything after it is variable-length and must
   * be walked in order. Getting the offsets wrong silently yields plausible
   * nonsense rather than an error, which is why this is a pure function with
   * tests rather than inline in a BLE callback.
   *
   *   bit 0  HR value is uint16 (else uint8)
   *   bit 1  sensor contact feature supported
   *   bit 2  sensor contact detected
   *   bit 3  energy expended field present (2 bytes, skipped)
   *   bit 4  RR intervals present (the part we actually want)
   */
  function parseHeartRateMeasurement(view) {
    if (!view || view.byteLength < 2) return { hr: null, rr: [], contact: null };
    const flags = view.getUint8(0);
    const hr16 = (flags & 0x01) !== 0;
    const contactSupported = (flags & 0x02) !== 0;
    const contactDetected = (flags & 0x04) !== 0;
    const energyPresent = (flags & 0x08) !== 0;
    const rrPresent = (flags & 0x10) !== 0;

    let i = 1;
    let hr = null;
    if (hr16) {
      if (view.byteLength < i + 2) return { hr: null, rr: [], contact: null };
      hr = view.getUint16(i, true); i += 2;
    } else {
      hr = view.getUint8(i); i += 1;
    }
    if (energyPresent) i += 2;

    const rr = [];
    if (rrPresent) {
      // Several intervals can arrive in one notification, so consume until the
      // buffer runs out rather than assuming exactly one.
      while (i + 1 < view.byteLength) {
        rr.push(view.getUint16(i, true) * RR_UNIT_MS);
        i += 2;
      }
    }
    return {
      hr: hr > 0 ? hr : null,
      rr,
      // null (not false) when the strap doesn't report contact at all, so
      // "unknown" and "definitely not touching skin" stay distinguishable.
      contact: contactSupported ? contactDetected : null,
    };
  }

  // --- HRV -----------------------------------------------------------------
  // RMSSD: root mean square of successive differences. The standard short-term
  // HRV measure, and the right one for windows of a minute or so — SDNN needs
  // longer to mean anything.
  function rmssd(rrs) {
    if (!Array.isArray(rrs) || rrs.length < 2) return null;
    let sum = 0, n = 0;
    for (let i = 1; i < rrs.length; i++) {
      const d = rrs[i] - rrs[i - 1];
      sum += d * d; n++;
    }
    return n ? Math.sqrt(sum / n) : null;
  }

  function sdnn(rrs) {
    if (!Array.isArray(rrs) || rrs.length < 2) return null;
    const mean = rrs.reduce((a, b) => a + b, 0) / rrs.length;
    const varSum = rrs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
    return Math.sqrt(varSum / (rrs.length - 1));
  }

  function meanRR(rrs) {
    if (!Array.isArray(rrs) || !rrs.length) return null;
    return rrs.reduce((a, b) => a + b, 0) / rrs.length;
  }

  function bpmFromRR(rrs) {
    const m = meanRR(rrs);
    return m && m > 0 ? 60000 / m : null;
    }

  /*
   * Rolling RR buffer with artifact rejection.
   *
   * The rejection is not optional politeness. A chest strap occasionally misses
   * a beat, which produces one interval about twice as long as its neighbours.
   * RMSSD squares successive differences, so a single such interval contributes
   * two enormous terms and can multiply the result — appearing as a dramatic
   * surge of calm at the exact moment the strap slipped.
   */
  class RrBuffer {
    constructor({ windowSec = 60 } = {}) {
      this.windowSec = windowSec;
      this.rrs = [];        // accepted intervals, ms
      this.elapsedMs = 0;   // total accepted time, for trimming the window
      this.accepted = 0;
      this.rejected = 0;
    }

    push(rrMs) {
      if (!Number.isFinite(rrMs) || rrMs < RR_MIN_MS || rrMs > RR_MAX_MS) {
        this.rejected++;
        return false;
      }
      const prev = this.rrs.length ? this.rrs[this.rrs.length - 1] : null;
      if (prev != null && Math.abs(rrMs - prev) / prev > RR_MAX_STEP_FRACTION) {
        this.rejected++;
        return false;
      }
      this.rrs.push(rrMs);
      this.accepted++;
      // Trim to the window by total duration, not by count — at 50bpm a fixed
      // count spans twice the time it does at 100bpm.
      let total = this.rrs.reduce((a, b) => a + b, 0);
      while (this.rrs.length > 2 && total > this.windowSec * 1000) {
        total -= this.rrs.shift();
      }
      this.elapsedMs = total;
      return true;
    }

    // Fraction of intervals thrown away. High means the strap needs attention,
    // and the same discipline as the EEG side: say so rather than quietly
    // reporting numbers derived from bad input.
    rejectRate() {
      const total = this.accepted + this.rejected;
      return total ? this.rejected / total : 0;
    }

    // Beat times in SECONDS from the start of the window, which is the shape
    // DSP.estimateBreathingPeriod wants for recovering breathing from RSA.
    beatTimes() {
      const out = [];
      let t = 0;
      for (const rr of this.rrs) { t += rr / 1000; out.push(t); }
      return out;
    }

    get length() { return this.rrs.length; }
    values() { return this.rrs.slice(); }
  }

  /*
   * Tracks how STEADY the HRV is, which is a different claim from how high it
   * is. `equanimity` in metrics.js is described as physiological
   * non-reactivity, and the honest reading of that is "RMSSD is not lurching
   * around", not "RMSSD is large". A person can have high HRV and still be
   * reacting to everything.
   *
   * Returns 0..1 where 1 is very steady. Needs a few RMSSD samples before it
   * says anything, and returns null until then rather than guessing.
   */
  class SteadinessTracker {
    constructor({ history = 12, scale = 0.35 } = {}) {
      this.history = history;
      this.scale = scale;   // relative spread that maps to "not steady at all"
      this.samples = [];
    }
    update(rmssdMs) {
      if (!Number.isFinite(rmssdMs) || rmssdMs <= 0) return this.value();
      this.samples.push(rmssdMs);
      if (this.samples.length > this.history) this.samples.shift();
      return this.value();
    }
    value() {
      if (this.samples.length < 4) return null;
      const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      if (mean <= 0) return null;
      const sd = Math.sqrt(this.samples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.samples.length);
      // Coefficient of variation, inverted. Relative rather than absolute so it
      // doesn't just track resting HRV level, which differs hugely per person.
      const cv = sd / mean;
      return Math.max(0, Math.min(1, 1 - cv / this.scale));
    }
  }

  /* --- Breath PHASE, not just rate -----------------------------------------
   *
   * Until now this project had breathing RATE only. RSA tells you the frequency
   * of the respiratory modulation in heart timing; it does not tell you where in
   * the cycle you are right now, so nothing could swell on the inhale and
   * contract on the exhale. This closes that gap.
   *
   * The mechanism: heart rate genuinely accelerates during inhalation and
   * decelerates during exhalation. So instantaneous heart rate, with its slow
   * drift removed, IS the breath waveform — positive means inhaling, negative
   * means exhaling. No extra sensor required, and the chest strap's beat timing
   * is clean enough to make it work.
   *
   * TWO HONEST LIMITS, both unavoidable:
   *  1. RSA lags the actual breath by a fraction of a cycle — the heart responds
   *     to breathing, it doesn't predict it.
   *  2. Detrending with a centred window means the most recent sample has a
   *     one-sided window, which biases it.
   * Together these put "now" somewhat in the past. test-polar.js MEASURES the
   * total lag against a synthetic signal rather than leaving it a guess, so the
   * number is known instead of hoped for.
   *
   * A held breath cannot be represented by this method at all: there is no
   * respiratory modulation during a hold, so it correctly reports NO reading
   * rather than a bar pinned at the top. See the recent-amplitude gate below.
   *
   * If this proves too laggy to breathe along with, the real fix is the strap's
   * ACCELEROMETER via Polar's PMD service (protocol transcribed in
   * docs/polar-pmd.md): the H10 sits on the ribcage, so chest
   * wall movement is direct breath measurement with no physiological lag at all.
   * That is a bigger protocol job. Head-mounted accelerometry on the Muse is NOT
   * the answer — the head barely moves with breathing and mostly reports
   * postural sway.
   */

  // Instantaneous heart rate resampled onto a uniform grid. RR intervals arrive
  // one per beat, i.e. unevenly in time, and every downstream filter assumes
  // even spacing — the same mistake that once skewed every breathing estimate in
  // dsp.js.
  function resampleHr(rrs, hz = 4) {
    if (!Array.isArray(rrs) || rrs.length < 4 || !(hz > 0)) return null;
    const times = [], hrs = [];
    let acc = 0;
    for (const rr of rrs) {
      acc += rr / 1000;
      times.push(acc);
      hrs.push(60000 / rr);
    }
    const dur = times[times.length - 1] - times[0];
    const n = Math.floor(dur * hz);
    if (n < 8) return null;
    const out = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = times[0] + i / hz;
      while (j < times.length - 2 && times[j + 1] < t) j++;
      const span = times[j + 1] - times[j];
      const f = span > 1e-9 ? (t - times[j]) / span : 0;
      out[i] = hrs[j] + (hrs[j + 1] - hrs[j]) * Math.max(0, Math.min(1, f));
    }
    return out;
  }

  // The respiratory waveform: instantaneous HR with its slow drift removed and
  // amplitude normalised, so it reads -1 (fully exhaled) .. +1 (fully inhaled)
  // regardless of how big a given person's RSA happens to be.
  function breathSignal(rrs, { hz = 4, trendSec = 10, recentSec = 12 } = {}) {
    const hr = resampleHr(rrs, hz);
    if (!hr) return null;
    const half = Math.max(1, Math.round((trendSec * hz) / 2));
    const detr = new Array(hr.length);
    for (let i = 0; i < hr.length; i++) {
      let sum = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        const idx = i + k;
        if (idx < 0 || idx >= hr.length) continue;
        sum += hr[idx]; n++;
      }
      detr[i] = hr[i] - sum / n;
    }
    // Normalise by RMS rather than peak: one artefactual excursion would
    // otherwise squash the entire rest of the waveform toward zero.
    const rms = Math.sqrt(detr.reduce((a, b) => a + b * b, 0) / detr.length);
    if (!(rms > 1e-9)) return null;

    // Gate on RECENT amplitude, not the whole window.
    //
    // This is the breath-hold bug, reported from real use: hold at the top of an
    // inhale and the bar settled into a confident flat line around +50% instead
    // of reporting nothing. A held breath has NO respiratory modulation, so there
    // is nothing for this method to see — what was being drawn was heart rate
    // decaying back toward its own recent average, which the normalisation below
    // then inflated. Checking the full window could never catch it, because 55 of
    // the last 60 seconds were still full of real breathing.
    //
    // Note what this cannot do: RSA cannot distinguish "holding at full inhale"
    // from "no signal at all", because both look identical in heart timing. So a
    // hold correctly reads as no reading rather than as a pinned bar. Getting the
    // truthful picture — the chest held expanded, the bar staying at the top —
    // needs chest-wall movement from the strap accelerometer.
    const recentN = Math.max(8, Math.round(recentSec * hz));
    const recent = detr.slice(-Math.min(recentN, detr.length));
    const recentRms = Math.sqrt(recent.reduce((a, b) => a + b * b, 0) / recent.length);
    if (recentRms < RSA_MIN_BPM) return null;

    // Normalise by the FULL-window RMS, not the recent one. A shrinking
    // denominator amplifies whatever residual is left as the oscillation dies —
    // which is precisely what turned a decaying artifact into a stable plateau.
    //
    // tanh, not a hard clamp. Clamping made the output sit at exactly +/-1 for
    // long stretches — the bar pegged at 100 and stopped moving, which reads as a
    // held breath rather than as "the signal is bigger than expected".
    return detr.map((v) => Math.tanh(v / (rms * 1.3)));
  }

  // Where in the breath you are right now.
  //   amount: -1 fully exhaled .. 0 midpoint .. +1 fully inhaled
  //   rising: true while inhaling
  // Returns null rather than guessing when there isn't enough clean data.
  function breathPhaseNow(rrs, opts = {}) {
    const sig = breathSignal(rrs, opts);
    if (!sig || sig.length < 6) return null;
    const i = sig.length - 1;
    const prev = sig[Math.max(0, i - 2)];
    return { amount: sig[i], rising: sig[i] > prev };
  }

  return {
    HR_SERVICE, HR_MEASUREMENT, BATTERY_SERVICE, BATTERY_LEVEL,
    resampleHr, breathSignal, breathPhaseNow,
    RR_UNIT_MS, RR_MIN_MS, RR_MAX_MS, RR_MAX_STEP_FRACTION, RSA_MIN_BPM,
    parseHeartRateMeasurement,
    rmssd, sdnn, meanRR, bpmFromRR,
    RrBuffer, SteadinessTracker,
  };
});
