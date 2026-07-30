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

  /* === PMD: chest-wall motion from the strap's accelerometer =================
   *
   * Protocol transcribed from Polar's official spec into docs/polar-pmd.md. Read
   * that before changing anything here.
   *
   * WHY BOTHER, when RSA already gives a breath signal: RSA measures the
   * respiratory MODULATION OF HEART TIMING, so it lags by about a fifth of a
   * cycle, shrinks as heart rate rises, and cannot represent a held breath at all
   * (no modulation means no signal, however expanded the chest is). The strap sits
   * on the ribcage. Its accelerometer measures the chest wall moving, which is
   * breathing itself — no lag, works at any heart rate, and a hold reads as a hold.
   *
   * THE DANGEROUS PART: a wrong decode of a delta-compressed stream does not
   * throw. It yields smooth, plausible, wrong numbers, and a unit test written
   * from the same wrong assumption passes. So the real check is gravity —
   * accelMagnitude() below must read ~1000 mG at rest. Nothing in this file
   * proves itself.
   */
  const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
  const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

  const PMD_TYPE_ACC = 2;
  const PMD_CMD_GET_SETTINGS = 1;
  const PMD_CMD_START = 2;
  const PMD_CMD_STOP = 3;
  const PMD_RESPONSE = 0xf0;

  // Setting id -> width in bytes, from the spec's settings table. Type 5
  // (conversion factor) is an IEEE754 float, handled separately.
  const PMD_SETTING_SIZE = { 0: 2, 1: 2, 2: 2, 4: 1, 5: 4 };
  const PMD_SETTING_NAME = {
    0: 'sampleRate', 1: 'resolution', 2: 'range', 4: 'channels', 5: 'conversionFactor',
  };

  // Every payload here is little-endian.
  function u16le(b, i) { return b[i] | (b[i + 1] << 8); }

  /*
   * Control-point response. Layout is [0xF0, command, measurementType, errorCode,
   * moreFlag, ...payload].
   *
   * UNVERIFIED: the exact width of the error code and the presence of the "more"
   * byte are not spelled out in the part of the spec that was transcribable. This
   * parser therefore reports `raw` hex alongside its interpretation, so a real
   * response can be checked by eye rather than trusted.
   */
  function parseControlResponse(view) {
    if (!view || view.byteLength < 4) return null;
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const raw = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    return {
      raw,
      isResponse: b[0] === PMD_RESPONSE,
      command: b[1],
      measurementType: b[2],
      errorCode: b[3],
      more: b.length > 4 ? b[4] : 0,
      settings: parseSettings(b, 5),
    };
  }

  /*
   * Settings TLV list: [type][itemCount][value...] repeated. Used both in the
   * settings response (where several values are offered per type) and to build a
   * start request (where exactly one is chosen).
   *
   * Stops rather than throwing on anything it does not recognise — a
   * mis-positioned start offset should degrade to "found nothing", not to
   * confident nonsense.
   */
  function parseSettings(bytes, offset = 0) {
    const out = {};
    let i = offset;
    while (i + 1 < bytes.length) {
      const type = bytes[i];
      const size = PMD_SETTING_SIZE[type];
      if (size == null) break;                  // unknown type: stop, don't guess
      const count = bytes[i + 1];
      if (count === 0 || count > 16) break;     // implausible: stop
      i += 2;
      const vals = [];
      for (let k = 0; k < count; k++) {
        if (i + size > bytes.length) return out;
        if (type === 5) {
          const dv = new DataView(bytes.buffer, bytes.byteOffset + i, 4);
          vals.push(dv.getFloat32(0, true));
        } else if (size === 1) {
          vals.push(bytes[i]);
        } else {
          vals.push(u16le(bytes, i));
        }
        i += size;
      }
      out[PMD_SETTING_NAME[type] || type] = vals;
    }
    return out;
  }

  /*
   * Bytes to write to the control point to start an ACC stream.
   *
   * Defaults chosen for BREATHING, not for motion capture: 50Hz is far more than
   * enough for a signal that oscillates every few seconds, and the SMALLEST range
   * (2G) gives the finest resolution for the tens-of-milli-g excursions the chest
   * wall actually produces. A wider range would throw that precision away.
   */
  function buildAccStartCommand({
    sampleRate = 50, resolution = 16, range = 2, channels = 3,
    countBytes = 1,
    /*
     * WHICH settings to send, by id, in order. This is the whole ballgame.
     *
     * A real H10 refused five different encodings with the same code, and its
     * settings response said why: it advertises exactly
     *   {sampleRate:[25,50,100,200], resolution:[16], range:[2,4,8]}
     * and nothing else. Every attempt had either sent `channels` (id 4) — which
     * the device never offered — or omitted `range`, which it requires. So the
     * default is now the three ids it named, and callers should pass the ids the
     * device actually advertised rather than a fixed set. Sending a setting the
     * device did not offer is what "invalid parameter" meant.
     */
    include = [0, 1, 2],
  } = {}) {
    const values = { 0: sampleRate, 1: resolution, 2: range, 4: channels };
    const out = [PMD_CMD_START, PMD_TYPE_ACC];
    for (const id of include) {
      const size = PMD_SETTING_SIZE[id];
      if (size == null) continue;                 // unknown id: never invent bytes
      out.push(id);
      // The item-count field's width was not pinned down by the spec text, so it
      // stays parameterised — but it is NOT the cause of the refusals above.
      if (countBytes === 2) out.push(1, 0); else out.push(1);
      const value = values[id] || 0;
      for (let i = 0; i < size; i++) out.push((value >> (8 * i)) & 0xff);
    }
    return new Uint8Array(out);
  }

  /*
   * The setting ids to send, taken from what the device advertised.
   *
   * Ids 0/1/2 (rate, resolution, range) in ascending order, keeping only those
   * the device named, because an unadvertised setting is refused and a missing
   * required one is too. The conversion factor (5) is reported BY the device and
   * never sent to it. If no settings response arrived, fall back to the three
   * the H10 documents.
   */
  function accStartSettingIds(settings) {
    if (!settings) return [0, 1, 2];
    const ids = [];
    for (const [id, name] of [[0, 'sampleRate'], [1, 'resolution'], [2, 'range'], [4, 'channels']]) {
      const v = settings[name];
      if (v && v.length) ids.push(id);
    }
    return ids.length ? ids : [0, 1, 2];
  }

  /*
   * Candidate start-request shapes, tried in order until the device accepts one.
   *
   * This exists because the H10 refused the first attempt with error code 5 and
   * the spec's error table was not in the transcribable part of the PDF — so
   * rather than guess what 5 means and guess again, ask the device. It answers
   * every attempt with an accept or a code, which makes this a search with a
   * definite end rather than a fishing expedition.
   *
   * Ordered by how likely each is to be the real format.
   */
  const ACC_START_VARIANTS = [
    { label: 'advertised', opts: {} },                            // rate+res+range
    { label: 'advertised+ch', opts: { include: [0, 1, 2, 4] } },   // the old default
    { label: 'advertised count16', opts: { countBytes: 2 } },
    { label: 'rate+res', opts: { include: [0, 1] } },
    { label: 'rate+res+ch', opts: { include: [0, 1, 4] } },
  ];

  /*
   * Candidate PARAMETER VALUES, for when every request shape above is refused
   * with the same code. Identical codes across five different encodings say the
   * encoding is not what the device objects to — so the next axis to vary is the
   * values themselves.
   *
   * Ordered so the cheapest hypotheses come first: the H10's documented sample
   * rates at the finest range, then wider ranges, then the coarse rate. `channels`
   * stays at 3 throughout because a 3-axis accelerometer has no other answer.
   */
  const ACC_PARAM_VARIANTS = [
    { sampleRate: 50, resolution: 16, range: 2 },
    { sampleRate: 25, resolution: 16, range: 2 },
    { sampleRate: 200, resolution: 16, range: 2 },
    { sampleRate: 100, resolution: 16, range: 2 },
    { sampleRate: 50, resolution: 16, range: 4 },
    { sampleRate: 50, resolution: 16, range: 8 },
    { sampleRate: 25, resolution: 16, range: 8 },
    { sampleRate: 200, resolution: 16, range: 8 },
    { sampleRate: 52, resolution: 16, range: 2 },   // Verity-style rate, in case
    { sampleRate: 50, resolution: 8, range: 2 },    // in case resolution is bytes
  ];

  /*
   * Every combination the device itself advertised, as (rate × range) at the
   * advertised resolution. Preferred over the list above whenever a settings
   * response actually arrived: values the device named cannot be "unsupported",
   * which narrows the cause to the encoding or to something else entirely.
   *
   * Ordered to put the lowest range first (finest resolution for a small signal)
   * and 50Hz first among rates, matching what breathing actually needs.
   */
  function accParamCandidates(settings) {
    const list = (v, fallback) => (v && v.length ? v.slice() : fallback);
    if (!settings) return ACC_PARAM_VARIANTS.slice();
    const rates = list(settings.sampleRate, [50]).sort((a, b) => Math.abs(a - 50) - Math.abs(b - 50));
    const ranges = list(settings.range, [2]).sort((a, b) => a - b);
    const resolutions = list(settings.resolution, [16]);
    const out = [];
    for (const range of ranges) {
      for (const sampleRate of rates) {
        for (const resolution of resolutions) out.push({ sampleRate, resolution, range });
      }
    }
    return out.length ? out : ACC_PARAM_VARIANTS.slice();
  }

  /*
   * The control point's READ value: which measurement types this device offers.
   *
   * Worth doing before any negotiation, because it answers "does this device
   * support ACC at all" without a START — and if the answer is no, no request
   * shape or parameter value will ever work and the search should not run.
   *
   * UNVERIFIED LAYOUT. Read as [0x0F, featureBitmask, ...]: bit N set means
   * measurement type N is available. `raw` is returned alongside so a real
   * response can be read by eye instead of trusted, and `looksValid` says whether
   * the leading marker was what we expected. Treat `types` as an inference.
   */
  const PMD_FEATURE_READ = 0x0f;
  const PMD_TYPE_NAME = {
    0: 'ECG', 1: 'PPG', 2: 'ACC', 3: 'PPI', 5: 'GYRO', 6: 'MAG',
    9: 'SDK_MODE', 10: 'LOCATION', 11: 'PRESSURE', 12: 'TEMPERATURE',
  };
  function parseFeatures(view) {
    if (!view || view.byteLength < 2) return null;
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const raw = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    const mask = b[1];
    const types = [];
    for (let bit = 0; bit < 8; bit++) {
      if (mask & (1 << bit)) types.push(PMD_TYPE_NAME[bit] || `type${bit}`);
    }
    return { raw, looksValid: b[0] === PMD_FEATURE_READ, mask, types };
  }

  /*
   * Control-point response codes.
   *
   * NOT from the transcribed spec — the PDF's error table is in an image. This is
   * the enum from Polar's own SDK source, written down because "5" alone is
   * unactionable, but it is UNVERIFIED and callers must keep showing the number.
   * If a name here contradicts what the device actually does, believe the device.
   */
  const PMD_ERROR_NAMES = {
    0: 'success',
    1: 'invalid op code',
    2: 'invalid measurement type',
    3: 'not supported',
    4: 'invalid length',
    5: 'invalid parameter',
    6: 'already in state',
    7: 'invalid resolution',
    8: 'invalid sample rate',
    9: 'invalid range',
    10: 'invalid MTU',
    11: 'invalid number of channels',
    12: 'invalid state',
    13: 'device in charger',
  };
  // Always parenthesised and always alongside the number, so a wrong guess here
  // can never be mistaken for the device's own words.
  function describeError(code) {
    const n = PMD_ERROR_NAMES[code];
    return n ? `${code} (${n}?)` : String(code);
  }

  function buildStopCommand(type = PMD_TYPE_ACC) {
    return new Uint8Array([PMD_CMD_STOP, type]);
  }

  function buildGetSettingsCommand(type = PMD_TYPE_ACC) {
    return new Uint8Array([PMD_CMD_GET_SETTINGS, type]);
  }

  // Signed little-endian integer of `size` bytes.
  function signedLE(bytes, i, size) {
    let v = 0;
    for (let s = 0; s < size; s++) v |= bytes[i + s] << (8 * s);
    const signBit = 1 << (size * 8 - 1);
    return (v & signBit) ? v - (1 << (size * 8)) : v;
  }

  /*
   * Decode one PMD ACC data frame into samples of {x, y, z} in mG.
   *
   * Frame layout, VERIFIED against 216 samples from a real H10 (see
   * fixtures/h10-acc-frames.js):
   *   [0]       measurement type   (2 = ACC)
   *   [1..8]    timestamp
   *   [9]       frame type         (0 = 8-bit, 1 = 16-bit, 2 = 24-bit, signed mG)
   *   [10..]    a flat array of samples: channels x bytesPerSample, signed LE
   *
   * THE H10 DOES NOT DELTA-COMPRESS ITS ACC FRAMES, whatever the spec's delta
   * section implies. This code used to implement that section, and the frames make
   * the mistake unmissable: content is 216 bytes, exactly 36 samples x 3 channels x
   * 2 bytes, with no width or count header anywhere in it. Reading byte 16 as a
   * "delta bit width" got 0xcd = 205, which the guard rejected — so it kept the
   * seed sample, silently discarded the other 35, and dropped the effective rate
   * from 50Hz to about 1.4Hz. Worse, on frames where that byte happened to be <= 32
   * the delta path ran and invented values, which is how a strap sitting still
   * reported 16 million mG.
   *
   * The delta code is gone rather than kept for other devices. Speculative decoders
   * that no available hardware exercises are how the 16-million-mG reading happened
   * in the first place; if a device turns up that needs one, write it then, against
   * its bytes.
   *
   * A frame whose content is not a whole number of samples is REFUSED, not decoded
   * as far as it goes. Returning a short read here would hand plausible numbers to
   * a caller that has no way to know they are wrong.
   */
  function decodeAccFrame(view, { channels = 3 } = {}) {
    if (!view || view.byteLength < 11) return null;
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (b[0] !== PMD_TYPE_ACC) return null;
    const frameType = b[9];
    const bytesPer = frameType === 0 ? 1 : frameType === 1 ? 2 : frameType === 2 ? 3 : 0;
    if (!bytesPer || channels < 1 || channels > 3) return null;

    const content = b.length - 10;
    const stride = channels * bytesPer;
    // The length check IS the structural test. 216 % 6 === 0 is what says "flat
    // array of triplets" rather than "something with headers in it".
    if (content < stride || content % stride !== 0) return null;

    const samples = [];
    for (let i = 10; i + stride <= b.length; i += stride) {
      const s = [];
      for (let ch = 0; ch < channels; ch++) s.push(signedLE(b, i + ch * bytesPer, bytesPer));
      samples.push({ x: s[0], y: s[1] || 0, z: s[2] || 0 });
    }
    return { frameType, samples };
  }

  /*
   * THE VERIFICATION. At rest the total acceleration a body experiences is
   * gravity, so this must sit steadily near 1000 mG. If it reads 30, or 400000,
   * or thrashes, the decode above is wrong — regardless of how smooth the numbers
   * look. This is the one check that cannot be faked by a test, because gravity is
   * not something this code controls.
   */
  function accelMagnitude(sample) {
    if (!sample) return null;
    const { x = 0, y = 0, z = 0 } = sample;
    return Math.sqrt(x * x + y * y + z * z);
  }

  // Is a decode plausibly correct? Generous bounds — the point is to catch
  // "obviously not accelerations", not to grade sensor quality.
  function looksLikeGravity(samples, { tolerance = 0.45 } = {}) {
    if (!Array.isArray(samples) || samples.length < 4) return null;
    const mags = samples.map(accelMagnitude).filter((m) => m != null);
    if (!mags.length) return null;
    const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
    return {
      meanMilliG: mean,
      ok: mean > 1000 * (1 - tolerance) && mean < 1000 * (1 + tolerance),
    };
  }

  /* === Breathing from chest-wall motion (PMD stage 2) =======================
   *
   * The strap sits on the chest, so the accelerometer sees the chest wall move
   * directly. Compared with RSA this is the better signal in every way that
   * matters here: no ~1s lag, and — the thing the user actually asked for — a
   * BREATH HOLD is visible, because the chest genuinely stops. RSA cannot see a
   * hold at all; "holding at full inhale" and "no signal" look identical in heart
   * timing.
   *
   * TWO THINGS THIS CANNOT KNOW BY ITSELF, both established by the gravity work:
   *
   * 1. WHICH AXIS faces the chest wall. Magnitude is sqrt(x²+y²+z²), invariant
   *    under permuting axes, so nothing verified about the decode says which is
   *    which — and the strap can be worn either way up. So the axis is CHOSEN AT
   *    RUNTIME, as the one carrying the most respiratory-band power. Never
   *    hardcode one.
   *
   * 2. WHICH DIRECTION is inhale. A chest expanding could move the chosen axis
   *    positive or negative depending on how the strap is oriented, and no amount
   *    of accelerometer data settles it. Physiology does: heart rate RISES on
   *    inhalation, so the RSA signal — lagging but directionally certain — can
   *    orient this one. `resolveSign()` cross-correlates the two and the answer
   *    is reported as `signKnown`, so the UI can decline to say "in" or "out"
   *    until it is actually known rather than guessing at a coin flip.
   *
   * The two sensors fix each other's weakness: RSA knows which way is in, the
   * accelerometer knows when and how much.
   */
  const ACC_BREATH_DEFAULTS = {
    inHz: 50,          // native ACC rate
    outHz: 5,          // decimated: 10x Nyquist for a 0.5Hz signal, tiny buffers
    windowSec: 45,     // several breaths even at 4/min
    trendSec: 12,      // high-pass corner: removes gravity and posture drift
    smoothSec: 1.0,    // low-pass corner: removes sway, footsteps, heartbeat knock
    minSec: 20,        // refuse to report a rate before this much data
    minMilliG: 3,      // absolute floor: below this nothing is moving
    holdFraction: 0.35, // recent amplitude below this fraction of the window = held
    minRateSec: 2,     // 30 breaths/min
    maxRateSec: 20,    // 3 breaths/min
    minCorrelation: 0.3,
  };

  // Centred moving average. Centred, not trailing: a trailing filter shifts the
  // waveform in time, and the whole point of using the accelerometer is that it
  // does NOT lag.
  function movingAverage(xs, halfWidth) {
    const out = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      let sum = 0, n = 0;
      for (let k = -halfWidth; k <= halfWidth; k++) {
        const j = i + k;
        if (j < 0 || j >= xs.length) continue;
        sum += xs[j]; n++;
      }
      out[i] = sum / n;
    }
    return out;
  }

  function rms(xs) {
    if (!xs.length) return 0;
    return Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
  }

  /*
   * Dominant period by autocorrelation, in samples.
   *
   * Autocorrelation rather than counting zero crossings: a breath waveform is not
   * a clean sinusoid, and a little noise around a crossing invents whole cycles.
   * Returns null when nothing in the plausible band correlates well enough, which
   * is the honest answer for a chest that is moving irregularly.
   */
  function dominantPeriod(xs, { minLag, maxLag, minCorrelation }) {
    const n = xs.length;
    if (n < maxLag + 8) return null;
    const v = xs.reduce((a, b) => a + b * b, 0);
    if (!(v > 1e-12)) return null;
    const r = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += xs[i] * xs[i + lag];
      // Normalise by the overlap, so long lags are not penalised for having fewer
      // terms — otherwise slow breathing is systematically rejected.
      r.push((sum / (n - lag)) / (v / n));
    }
    let bestI = 0;
    for (let i = 1; i < r.length; i++) if (r[i] > r[bestI]) bestI = i;
    if (r[bestI] < minCorrelation) return null;

    /* Take the FIRST strong peak, not the tallest.
     *
     * A periodic signal correlates with itself at every multiple of its period, so
     * a 12/min breath scores just as well at a 20s lag as at its true 5s one — and
     * with the overlap normalisation above, the long lag can win outright. The
     * first test written for this reported 3.0/min for a 12/min input.
     *
     * So: accept the shortest lag that is a genuine local maximum and comes within
     * a whisker of the best score. This is the standard fix for octave errors in
     * pitch detection, and it fails toward the fundamental rather than a harmonic.
     */
    const good = r[bestI] * 0.85;
    for (let i = 1; i < r.length - 1; i++) {
      if (r[i] >= good && r[i] > r[i - 1] && r[i] >= r[i + 1]) {
        return { lag: minLag + i, r: r[i] };
      }
    }
    return { lag: minLag + bestI, r: r[bestI] };
  }

  function AccelBreath(options = {}) {
    const cfg = Object.assign({}, ACC_BREATH_DEFAULTS, options);
    const decimate = Math.max(1, Math.round(cfg.inHz / cfg.outHz));
    const keep = Math.round(cfg.windowSec * cfg.outHz);
    const axes = [[], [], []];
    let pending = [[], [], []];
    // The in/out orientation, once RSA has settled it. Persisted across estimates
    // because it only changes when the strap is physically re-seated.
    let sign = 0;
    // True once the orientation came from the person rather than from RSA. Latched, so
    // the per-tick inference cannot quietly undo a correction.
    let signManual = false;

    function push(samples) {
      if (!samples || !samples.length) return;
      for (const s of samples) {
        pending[0].push(s.x); pending[1].push(s.y); pending[2].push(s.z);
        if (pending[0].length >= decimate) {
          // Block-average as the anti-aliasing filter for the decimation.
          for (let a = 0; a < 3; a++) {
            const blk = pending[a];
            axes[a].push(blk.reduce((x, y) => x + y, 0) / blk.length);
            if (axes[a].length > keep) axes[a].shift();
          }
          pending = [[], [], []];
        }
      }
    }

    // Band-passed series for one axis: detrend (high-pass) then smooth (low-pass).
    function band(a) {
      const xs = axes[a];
      if (xs.length < 8) return null;
      const trend = movingAverage(xs, Math.max(1, Math.round((cfg.trendSec * cfg.outHz) / 2)));
      const ac = xs.map((v, i) => v - trend[i]);
      return movingAverage(ac, Math.max(1, Math.round((cfg.smoothSec * cfg.outHz) / 2)));
    }

    function seconds() { return axes[0].length / cfg.outHz; }

    /*
     * Orient the signal using RSA, whose direction is known from physiology.
     * `reference` is a breath series from breathSignal() — any length, any scale.
     * Correlation is taken at the lag that maximises |r|, because RSA lags the
     * mechanical breath by about a second and a zero-lag correlation would
     * therefore understate it.
     */
    function resolveSign(reference) {
      // A sign set by the person is not a hypothesis to be re-tested. See setSign.
      if (signManual) return sign;
      const est = pick();
      if (!est) return sign;
      const own = band(est.axis);
      if (!own || !reference || reference.length < 8) return sign;
      // Both series end at "now", so align them from the end.
      const n = Math.min(own.length, reference.length);
      const a = own.slice(-n);
      const b = reference.slice(-n);

      /* THE SHIFT BUDGET MUST SCALE WITH THE BREATH PERIOD.
       *
       * A fixed 2.5s window was the first attempt, and it inverted the answer: at
       * 12 breaths/min the period is 5s, so a 2.5s shift is exactly antiphase and
       * scores |r| ~ 1 just like the correct alignment — then edge effects decide
       * which wins. The test caught it reporting a flip for a chest that was
       * already in phase.
       *
       * RSA's lag was measured at about 1.0s in a 5s cycle, i.e. a fifth of a
       * period, so a quarter-period cap covers the real lag with margin while
       * making antiphase unreachable by construction.
       */
      const per = dominantPeriod(own, {
        minLag: Math.round(cfg.minRateSec * cfg.outHz),
        maxLag: Math.round(cfg.maxRateSec * cfg.outHz),
        minCorrelation: cfg.minCorrelation,
      });
      // No detectable period means no reliable orientation. Leave it unknown.
      if (!per) return sign;
      const maxShift = Math.min(Math.round(per.lag * 0.25), Math.round(2.5 * cfg.outHz));

      let bestAbs = 0, bestR = 0;
      for (let shift = 0; shift <= maxShift && shift < n - 8; shift++) {
        // Shift the REFERENCE later, since RSA trails the mechanical signal.
        let sum = 0, va = 0, vb = 0;
        for (let i = 0; i + shift < n; i++) {
          sum += a[i] * b[i + shift]; va += a[i] * a[i]; vb += b[i + shift] * b[i + shift];
        }
        if (!(va > 1e-12 && vb > 1e-12)) continue;
        const r = sum / Math.sqrt(va * vb);
        if (Math.abs(r) > bestAbs) { bestAbs = Math.abs(r); bestR = r; }
      }
      /* HARDER TO CHANGE AN ANSWER THAN TO GIVE ONE.
       *
       * This runs every tick, and RSA is a weak, lagging, noisy reference. At the bare
       * threshold the inferred sign can flip back and forth between ticks, which on
       * screen is a breath trace that inverts every few seconds — worse than a
       * consistently wrong sign, because a consistent one can at least be read
       * backwards. Establishing a sign takes the ordinary threshold; overturning an
       * established one takes a clearly stronger correlation.
       */
      const wanted = sign === 0 ? cfg.minCorrelation
        : Math.min(0.95, cfg.minCorrelation + 0.2);
      const proposed = bestR > 0 ? 1 : -1;
      if (bestAbs >= wanted || (sign !== 0 && proposed === sign && bestAbs >= cfg.minCorrelation)) {
        sign = proposed;
      }
      return sign;
    }

    /*
     * Set the orientation from OUTSIDE — from the person, who is the only reliable
     * reference there is.
     *
     * The header note above is honest that the accelerometer cannot know which way is
     * inhale and that RSA is used to infer it. What it did not provide was a way to
     * correct a wrong inference, and the failure is invisible from inside: an inverted
     * trace is a perfectly good signal drawn upside down, so nothing in the data looks
     * wrong. Reported as exactly that — "is it possible that the graph is inverted even
     * if the data is good".
     *
     * `manual` latches it. Without the latch the automatic resolution would overwrite a
     * correction on the next tick, which is indistinguishable from the button not
     * working.
     */
    function setSign(next, { manual = true } = {}) {
      sign = next > 0 ? 1 : next < 0 ? -1 : 0;
      signManual = !!manual && sign !== 0;
      return sign;
    }

    /*
     * One-press calibration: called WHILE BREATHING IN.
     *
     * Takes the chest position now and orients so that this moment reads as inhaling.
     * More reliable than asking someone to judge whether a trace looks inverted, which
     * is the same question one step removed — and it needs no reference signal at all,
     * so it works when RSA is too weak to have settled the sign in the first place.
     *
     * Refuses rather than guesses when the chest is not clearly displaced: at the
     * turnaround the signal is near zero and its sign is noise, so a press mistimed to
     * the top of the breath would latch a coin flip and be trusted.
     */
    function calibrateInhaling() {
      const est = pick();
      if (!est) return { ok: false, reason: 'no breathing signal yet' };
      const sig = est.series;
      if (!sig || !sig.length) return { ok: false, reason: 'no breathing signal yet' };
      const now = sig[sig.length - 1];
      /* A THIRD of the typical excursion, and the bound is set by filter lag rather
       * than by taste. The series is band-passed and smoothed with smoothSec = 1.0,
       * which on a 5-second breath is about 70 degrees of phase — measured: at the raw
       * signal's zero crossing the filtered value is still 0.57 of amplitude. So
       * "where the chest is" here means roughly a second ago, and a press near the
       * turnaround can land on the wrong side of zero. Requiring a clear displacement
       * refuses exactly those presses instead of latching them. */
      if (!(Math.abs(now) > (est.amp || 0) * 0.35)) {
        return { ok: false, reason: 'chest is near the turnaround — press mid-inhale' };
      }
      setSign(now > 0 ? 1 : -1, { manual: true });
      return { ok: true, sign };
    }

    // Give the inference back its say, e.g. after the strap is re-worn the other way up.
    function clearManualSign() { signManual = false; sign = 0; return sign; }

    // Which axis is carrying the breath: the one with the most band-passed power.
    function pick() {
      let best = null;
      for (let a = 0; a < 3; a++) {
        const bp = band(a);
        if (!bp) continue;
        const amp = rms(bp);
        if (!best || amp > best.amp) best = { axis: a, amp, series: bp };
      }
      return best;
    }

    /*
     * The current state of the breath, or a reason there isn't one.
     *
     * `holding` is the point of this whole exercise. It is decided RELATIVELY —
     * recent amplitude against the window's — because how far a chest visibly
     * moves depends on the person, the strap tension and where it sits, and an
     * absolute threshold in mG would be wrong for everyone but whoever it was
     * tuned on. The absolute floor is only a backstop for a strap lying on a table.
     */
    function estimate() {
      const est = pick();
      if (!est || seconds() < cfg.minSec) {
        return { amount: null, rising: null, bpm: null, holding: false,
          axis: est ? est.axis : null, amplitudeMilliG: est ? est.amp : null,
          signKnown: sign !== 0, seconds: seconds(), reason: 'warming up' };
      }
      const sig = est.series;
      const recentN = Math.max(6, Math.round(6 * cfg.outHz));
      const recentAmp = rms(sig.slice(-recentN));
      const holding = recentAmp < cfg.minMilliG
        || recentAmp < est.amp * cfg.holdFraction;

      const per = dominantPeriod(sig, {
        minLag: Math.round(cfg.minRateSec * cfg.outHz),
        maxLag: Math.round(cfg.maxRateSec * cfg.outHz),
        minCorrelation: cfg.minCorrelation,
      });
      const bpm = per ? 60 / (per.lag / cfg.outHz) : null;

      if (holding) {
        // A hold is NOT "no data" — the chest is somewhere, and where it is
        // carries the information the user was looking for. Report the position
        // and say it is held; do not report a direction, because there isn't one.
        const held = sign === 0 ? null
          : Math.tanh((sign * sig[sig.length - 1]) / (est.amp * 1.3 || 1));
        return { amount: held, rising: null, bpm, holding: true, axis: est.axis,
          amplitudeMilliG: recentAmp, signKnown: sign !== 0,
          seconds: seconds(), reason: 'chest still' };
      }

      const i = sig.length - 1;
      const oriented = (sign || 1) * sig[i];
      const prev = (sign || 1) * sig[Math.max(0, i - 2)];
      return {
        amount: Math.tanh(oriented / (est.amp * 1.3)),
        rising: oriented > prev,
        bpm, holding: false, axis: est.axis, amplitudeMilliG: recentAmp,
        signKnown: sign !== 0, seconds: seconds(), reason: null,
      };
    }

    return { push, estimate, resolveSign, setSign, calibrateInhaling, clearManualSign, pick,
      seconds, band, get sign() { return sign; }, get signManual() { return signManual; },
      reset() {
        axes[0].length = 0; axes[1].length = 0; axes[2].length = 0;
        pending = [[], [], []];
        // A manual orientation SURVIVES a reset: it describes how the strap is worn, not
        // the contents of the buffer, and losing it on every reconnect would mean
        // re-calibrating several times a sit.
        if (!signManual) sign = 0;
      } };
  }

  return {
    HR_SERVICE, HR_MEASUREMENT, BATTERY_SERVICE, BATTERY_LEVEL,
    PMD_SERVICE, PMD_CONTROL, PMD_DATA, PMD_TYPE_ACC,
    PMD_CMD_GET_SETTINGS, PMD_CMD_START, PMD_CMD_STOP, PMD_RESPONSE,
    parseControlResponse, parseSettings, buildAccStartCommand, buildStopCommand,
    buildGetSettingsCommand, parseFeatures, describeError, accStartSettingIds,
    PMD_FEATURE_READ, PMD_TYPE_NAME, PMD_ERROR_NAMES,
    ACC_START_VARIANTS, ACC_PARAM_VARIANTS, accParamCandidates,
    decodeAccFrame, signedLE, accelMagnitude, looksLikeGravity,
    resampleHr, breathSignal, breathPhaseNow,
    AccelBreath, ACC_BREATH_DEFAULTS, movingAverage, dominantPeriod,
    RR_UNIT_MS, RR_MIN_MS, RR_MAX_MS, RR_MAX_STEP_FRACTION, RSA_MIN_BPM,
    parseHeartRateMeasurement,
    rmssd, sdnn, meanRR, bpmFromRR,
    RrBuffer, SteadinessTracker,
  };
});
