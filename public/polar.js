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

  return {
    HR_SERVICE, HR_MEASUREMENT, BATTERY_SERVICE, BATTERY_LEVEL,
    RR_UNIT_MS, RR_MIN_MS, RR_MAX_MS, RR_MAX_STEP_FRACTION,
    parseHeartRateMeasurement,
    rmssd, sdnn, meanRR, bpmFromRR,
    RrBuffer, SteadinessTracker,
  };
});
