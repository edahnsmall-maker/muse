/*
 * Pure DSP + Muse protocol math — no browser or Node-only APIs.
 * Usable both in the browser (attaches to `window.DSP`) and under Node
 * (via require) so the numerically risky parts can be unit-tested without
 * a real headset.
 *
 * Muse BLE protocol constants (service/characteristic UUIDs, the 12-bit
 * sample packing, the microvolt scale factor, and the command encoding)
 * come from the documented Muse BLE protocol used by the open-source
 * muse-js library (github.com/urish/muse-js, MIT licensed) — reimplemented
 * here in vanilla JS with no external dependencies.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DSP = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // ---- Muse BLE protocol constants -----------------------------------
  const MUSE_SERVICE = 0xfe8d;
  const CONTROL_CHARACTERISTIC = '273e0001-4c4d-454d-96be-f03bac821358';
  const EEG_CHARACTERISTICS = [
    '273e0003-4c4d-454d-96be-f03bac821358', // TP9
    '273e0004-4c4d-454d-96be-f03bac821358', // AF7
    '273e0005-4c4d-454d-96be-f03bac821358', // AF8
    '273e0006-4c4d-454d-96be-f03bac821358', // TP10
  ];
  const CHANNEL_NAMES = ['TP9', 'AF7', 'AF8', 'TP10'];
  const EEG_FREQUENCY = 256; // Hz
  const EEG_SAMPLES_PER_PACKET = 12;

  const PPG_CHARACTERISTICS = [
    '273e000f-4c4d-454d-96be-f03bac821358', // ambient
    '273e0010-4c4d-454d-96be-f03bac821358', // infrared
    '273e0011-4c4d-454d-96be-f03bac821358', // red
  ];
  const PPG_CHANNEL_NAMES = ['ambient', 'infrared', 'red'];
  const PPG_FREQUENCY = 64; // Hz
  const PPG_SAMPLES_PER_PACKET = 6;

  // ---- Command encoding (length-prefixed ASCII "serial" protocol) ----
  function encodeCommand(cmd) {
    const encoded = new TextEncoder().encode(`X${cmd}\n`);
    encoded[0] = encoded.length - 1;
    return encoded;
  }

  // ---- 12-bit sample unpacking -----------------------------------------
  // 12 samples arrive packed 3 bytes per 2 samples (18 bytes for 12 samples).
  function decode12Bit(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      if (i % 3 === 0) {
        out.push((bytes[i] << 4) | (bytes[i + 1] >> 4));
      } else {
        out.push(((bytes[i] & 0xf) << 8) | bytes[i + 1]);
        i++;
      }
    }
    return out;
  }

  // Muse's documented scale: unsigned 12-bit -> microvolts, centered at 0x800.
  function samplesToMicrovolts(raw12bit) {
    return raw12bit.map((n) => 0.48828125 * (n - 0x800));
  }

  // PPG samples arrive as plain 24-bit unsigned values, 3 bytes each (no
  // centering/scaling — used as a relative light-intensity waveform here).
  function decode24Bit(bytes) {
    const out = [];
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      out.push((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
    }
    return out;
  }

  // ---- Windowing --------------------------------------------------------
  function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    return w;
  }

  // ---- Iterative radix-2 FFT (in place, N must be a power of 2) --------
  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curWr = 1, curWi = 0;
        const half = len / 2;
        for (let k = 0; k < half; k++) {
          const ur = real[i + k], ui = imag[i + k];
          const vr = real[i + k + half] * curWr - imag[i + k + half] * curWi;
          const vi = real[i + k + half] * curWi + imag[i + k + half] * curWr;
          real[i + k] = ur + vr; imag[i + k] = ui + vi;
          real[i + k + half] = ur - vr; imag[i + k + half] = ui - vi;
          const nextWr = curWr * wr - curWi * wi;
          const nextWi = curWr * wi + curWi * wr;
          curWr = nextWr; curWi = nextWi;
        }
      }
    }
  }

  // Windowed power spectrum of a real signal. Returns magnitude-squared
  // per bin (index i ⇒ i * sampleRate/n Hz), for i in [0, n/2].
  function powerSpectrum(samples, sampleRate) {
    const n = samples.length;
    const win = hannWindow(n);
    const real = new Float64Array(n), imag = new Float64Array(n);
    for (let i = 0; i < n; i++) real[i] = samples[i] * win[i];
    fft(real, imag);
    const bins = n / 2 + 1;
    const power = new Float64Array(bins);
    for (let i = 0; i < bins; i++) power[i] = real[i] * real[i] + imag[i] * imag[i];
    return { power, binHz: sampleRate / n };
  }

  function bandPower(spectrum, loHz, hiHz) {
    const { power, binHz } = spectrum;
    const lo = Math.max(0, Math.round(loHz / binHz));
    const hi = Math.min(power.length - 1, Math.round(hiHz / binHz));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += power[i];
    return sum;
  }

  const BANDS = {
    delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 45],
  };

  function bandPowers(samples, sampleRate) {
    const spectrum = powerSpectrum(samples, sampleRate);
    const out = {};
    for (const [name, [lo, hi]] of Object.entries(BANDS)) out[name] = bandPower(spectrum, lo, hi);
    return out;
  }

  // ---- Artifact detection ------------------------------------------------
  // Blinks, jaw clenching, talking, and head movement produce much larger
  // electrical swings than resting cortical EEG, especially at frontal
  // electrodes (AF7/AF8 sit right above the eyes and near the jaw). A
  // simple mean-removed peak-to-peak amplitude check catches most of this —
  // not a clinical-grade rejection method, just enough to stop obvious
  // noise from reading as "less calm". Threshold is a rough heuristic
  // (typical resting frontal EEG is well under 100µV peak-to-peak; blinks
  // and jaw/facial muscle activity commonly exceed 150-300µV) — tune per
  // your own signal if it feels too trigger-happy or too lax.
  const ARTIFACT_PTP_UV = 150;

  function peakToPeak(samples) {
    let mean = 0;
    for (const s of samples) mean += s;
    mean /= samples.length;
    let lo = Infinity, hi = -Infinity;
    for (const s of samples) {
      const c = s - mean;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    return hi - lo;
  }

  function isArtifact(samples, thresholdUv = ARTIFACT_PTP_UV) {
    return peakToPeak(samples) > thresholdUv;
  }

  // ---- Heartbeat detection from a raw PPG channel ------------------------
  // Not clinical-grade (a real pulse oximeter does far more), but enough to
  // recover approximate beat timing from a reasonable signal: detrend with
  // a moving average to remove slow baseline drift (ambient light, motion),
  // then pick local maxima that clear a relative-amplitude threshold and
  // respect a minimum refractory distance so noise can't be double-counted.
  function detectBeats(samples, sampleRate, { maxBpm = 180 } = {}) {
    const n = samples.length;
    const maWin = Math.max(1, Math.round(sampleRate * 0.75));
    const detrended = new Float64Array(n);
    const q = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      q.push(samples[i]); sum += samples[i];
      if (q.length > maWin) sum -= q.shift();
      detrended[i] = samples[i] - sum / q.length;
    }
    let maxAbs = 0;
    for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(detrended[i]));
    const threshold = maxAbs * 0.35;
    const minDistance = Math.round((sampleRate * 60) / maxBpm);
    const beats = [];
    for (let i = 1; i < n - 1; i++) {
      if (detrended[i] > threshold && detrended[i] >= detrended[i - 1] && detrended[i] >= detrended[i + 1]) {
        if (!beats.length || i - beats[beats.length - 1] >= minDistance) beats.push(i);
      }
    }
    return beats.map((i) => i / sampleRate); // beat times in seconds
  }

  // ---- Breathing period from beat-to-beat timing (RSA) -------------------
  // Heart rate speeds up on the inhale and slows on the exhale — respiratory
  // sinus arrhythmia. Resample the instantaneous beat-to-beat interval onto
  // a uniform low-rate grid, then find the dominant frequency in the normal
  // breathing band (6-30 breaths/min) with the same FFT used for EEG bands.
  // Returns the estimated breathing period in seconds, or null if there
  // isn't enough data yet to say anything trustworthy.
  function estimateBreathingPeriod(beatTimes, { minBreathsPerMin = 6, maxBreathsPerMin = 30 } = {}) {
    if (beatTimes.length < 6) return null;
    const ibi = [];
    for (let i = 1; i < beatTimes.length; i++) ibi.push({ t: beatTimes[i], v: beatTimes[i] - beatTimes[i - 1] });
    const dur = ibi[ibi.length - 1].t - ibi[0].t;
    if (dur < 8) return null; // need several breath cycles' worth of beats

    // Fixed-interval resampling: spacing must be exactly 1/resampleHz, not
    // "however many samples fit across dur" — those two only coincide when
    // dur happens to land exactly on a power of two, otherwise the true
    // sample spacing silently drifts from what powerSpectrum() is told to
    // assume, skewing every frequency estimate by that same ratio.
    const resampleHz = 4;
    const dt = 1 / resampleHz;
    let pow2 = 32;
    while (pow2 < dur / dt) pow2 *= 2;
    const series = new Float64Array(pow2);
    let ptr = 0;
    const tStart = ibi[0].t;
    for (let i = 0; i < pow2; i++) {
      const t = tStart + i * dt;
      while (ptr < ibi.length - 1 && ibi[ptr + 1].t < t) ptr++;
      series[i] = ibi[Math.min(ptr, ibi.length - 1)].v;
    }
    let mean = 0;
    for (let i = 0; i < series.length; i++) mean += series[i];
    mean /= series.length;
    for (let i = 0; i < series.length; i++) series[i] -= mean;

    const spectrum = powerSpectrum(Array.from(series), resampleHz);
    const loHz = minBreathsPerMin / 60, hiHz = maxBreathsPerMin / 60;
    const lo = Math.max(1, Math.round(loHz / spectrum.binHz));
    const hi = Math.min(spectrum.power.length - 1, Math.round(hiHz / spectrum.binHz));
    let bestBin = -1, bestPower = -1;
    for (let i = lo; i <= hi; i++) {
      if (spectrum.power[i] > bestPower) { bestPower = spectrum.power[i]; bestBin = i; }
    }
    if (bestBin < 0) return null;
    const freqHz = bestBin * spectrum.binHz;
    return freqHz > 0 ? 1 / freqHz : null;
  }

  // ---- Adaptive 0..1 normalization (same math server.js's step() uses for
  // ---- "calm", generalized into a reusable class) ------------------------
  // Not calm-specific: normalizes ANY unbounded signal against a slow
  // running mean/variance of the wearer's own session — used for calm, and
  // equally for independent alpha-level/beta-level tracking so the visual
  // can respond to more than one blended number.
  class AdaptiveNormalizer {
    constructor({ adapt = 0.001, slope = 0.9, smoothing = 0.05 } = {}) {
      this.adapt = adapt; this.slope = slope; this.smoothing = smoothing;
      this.mu = null; this.varr = 0.25; this.value = 0.5;
    }
    update(raw) {
      let target = this.value;
      if (raw != null && !Number.isNaN(raw)) {
        if (this.mu === null) this.mu = raw;
        this.mu += this.adapt * (raw - this.mu);
        this.varr += this.adapt * ((raw - this.mu) * (raw - this.mu) - this.varr);
        const z = (raw - this.mu) / Math.sqrt(this.varr + 1e-6);
        target = 1 / (1 + Math.exp(-z * this.slope));
      }
      this.value += this.smoothing * (target - this.value);
      return this.value;
    }
  }

  // ---- Spike detection against a slow baseline, not the previous tick ----
  // A real bug lived here once: comparing each reading to the immediately
  // preceding one, at a 250ms sample rate, means ordinary tick-to-tick
  // measurement jitter alone clears most thresholds almost every tick — the
  // detector reads as "always spiking" instead of catching genuine, sudden,
  // sustained shifts. Comparing to a slow-moving baseline (baselineRate is
  // the fraction it catches up per tick — small, so ~seconds of time
  // constant) means routine jitter self-cancels around that baseline and
  // only a real, sustained departure from it counts as a spike.
  class SpikeDetector {
    constructor({ threshold = 0.16, baselineRate = 0.08, decay = 0.85 } = {}) {
      this.threshold = threshold; this.baselineRate = baselineRate; this.decay = decay;
      this.baseline = null; this.spike = 0;
    }
    update(value) {
      this.spike *= this.decay;
      if (value != null && !Number.isNaN(value)) {
        if (this.baseline === null) this.baseline = value;
        if (Math.abs(value - this.baseline) > this.threshold) this.spike = 1.0;
        this.baseline += this.baselineRate * (value - this.baseline);
      }
      return this.spike;
    }
  }

  return {
    MUSE_SERVICE, CONTROL_CHARACTERISTIC, EEG_CHARACTERISTICS, CHANNEL_NAMES,
    EEG_FREQUENCY, EEG_SAMPLES_PER_PACKET,
    PPG_CHARACTERISTICS, PPG_CHANNEL_NAMES, PPG_FREQUENCY, PPG_SAMPLES_PER_PACKET,
    encodeCommand, decode12Bit, decode24Bit, samplesToMicrovolts,
    hannWindow, fft, powerSpectrum, bandPower, BANDS, bandPowers,
    ARTIFACT_PTP_UV, peakToPeak, isArtifact,
    detectBeats, estimateBreathingPeriod,
    AdaptiveNormalizer, SpikeDetector,
  };
});
