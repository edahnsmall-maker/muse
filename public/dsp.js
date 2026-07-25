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

  // ---- Adaptive "calm" scoring (same math as server.js's step(), --------
  // ---- generalized into a reusable, testable class) ----------------------
  class CalmTracker {
    constructor({ adapt = 0.001, slope = 0.9, smoothing = 0.05 } = {}) {
      this.adapt = adapt; this.slope = slope; this.smoothing = smoothing;
      this.mu = null; this.varr = 0.25; this.calm = 0.5;
    }
    update(ratio) {
      let target = this.calm;
      if (ratio != null && !Number.isNaN(ratio)) {
        if (this.mu === null) this.mu = ratio;
        this.mu += this.adapt * (ratio - this.mu);
        this.varr += this.adapt * ((ratio - this.mu) * (ratio - this.mu) - this.varr);
        const z = (ratio - this.mu) / Math.sqrt(this.varr + 1e-6);
        target = 1 / (1 + Math.exp(-z * this.slope));
      }
      this.calm += this.smoothing * (target - this.calm);
      return this.calm;
    }
  }

  return {
    MUSE_SERVICE, CONTROL_CHARACTERISTIC, EEG_CHARACTERISTICS, CHANNEL_NAMES,
    EEG_FREQUENCY, EEG_SAMPLES_PER_PACKET,
    encodeCommand, decode12Bit, samplesToMicrovolts,
    hannWindow, fft, powerSpectrum, bandPower, BANDS, bandPowers,
    CalmTracker,
  };
});
