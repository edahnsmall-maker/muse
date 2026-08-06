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
  /*
   * THE HEADBAND'S OWN MOTION SENSORS.
   *
   * WHY THEY MATTER HERE. The hypothesis worth testing in this project is not really about brainwaves:
   * "less fidgeting, eye gaze less erratic, movements are more deliberate, but also more smooth in
   * tempo". Head stillness is a direct measurement of most of that, and it was never recorded at all —
   * connect() subscribed to EEG and PPG and nothing else, so seven sits went by with no head motion in
   * them. The chest strap's accelerometer measures breathing, which is a different question.
   *
   * TWO CANDIDATE UUIDs, TRIED IN ORDER, and this is deliberate rather than sloppy. The Muse's
   * characteristic map is not published by the manufacturer; the widely-used community mapping puts
   * accelerometer at 000a and gyroscope at 0009, and I cannot verify that against a real Muse S Gen 2
   * from here. Both are attempted, whichever answers is subscribed, and the failure path is the same
   * one PPG already uses — absent rather than fatal.
   *
   * AND THE RAW BYTES ARE KEPT ALONGSIDE THE DECODE. If the scale factor below is wrong, a stored
   * decode is wrong forever and unrecoverable, while stored bytes can be re-decoded once the true
   * scale is known. Data preservation outranks a tidy schema — the samples are the irreplaceable part.
   */
  const MUSE_IMU_CANDIDATES = [
    '273e000a-4c4d-454d-96be-f03bac821358', // accelerometer, per the community mapping
    '273e0009-4c4d-454d-96be-f03bac821358', // gyroscope on that mapping; tried second
  ];
  /* Muse's documented accelerometer scale: 16-bit signed, 1/16384 g per count, so 1000/16384 mG.
     UNVERIFIED against hardware from here — see above. Anything derived from it is a shape, and a
     shape is unaffected by a constant scale error: stillness, jerk and symmetry all survive a wrong
     gain, which is why they are the measures worth trusting first. */
  const MUSE_IMU_SCALE_MG = 1000 / 16384;
  const MUSE_IMU_FREQUENCY = 52;          // Hz, per the same mapping
  const MUSE_IMU_SAMPLES_PER_PACKET = 3;  // three 3-axis samples per notification

  /*
   * Three 3-axis samples, 16-bit signed big-endian, after the 2-byte packet index.
   *
   * Returns whatever whole samples are present rather than assuming three: a short packet is a real
   * thing on some firmware, and reading past the end would fabricate axes out of undefined.
   */
  function decodeMuseImu(bytes, scale = MUSE_IMU_SCALE_MG) {
    const out = [];
    for (let i = 0; i + 5 < bytes.length; i += 6) {
      const axis = [];
      for (let a = 0; a < 3; a++) {
        const raw = (bytes[i + a * 2] << 8) | bytes[i + a * 2 + 1];
        // Two's complement: 16-bit values above 0x7fff are negative.
        axis.push(((raw & 0x8000) ? raw - 0x10000 : raw) * scale);
      }
      out.push({ x: axis[0], y: axis[1], z: axis[2] });
    }
    return out;
  }

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

  /* ==========================================================================
   * INDIVIDUAL ALPHA PEAK
   * ==========================================================================
   *
   * WHY THIS EXISTS. Every alpha number in the live app comes from a fixed 8-13Hz band,
   * which is a population average and not a person. Individual alpha frequency sits
   * roughly between 7.5 and 13Hz, varies by several Hz between people, and shifts with
   * age, arousal and time of day. If someone's own peak is at 9.2Hz, a fixed 8-13 band
   * spends most of its width measuring their theta shoulder and their low beta, and a
   * genuine change in alpha gets diluted by whatever else lives in the band. Reading the
   * peak from the person makes every alpha figure downstream about them.
   *
   * WHY IT NEEDS 4-SECOND WINDOWS. Frequency resolution is 1/windowLength. The live
   * display uses 1-second windows, which gives 1Hz bins — five bins across the whole of
   * alpha, and no way to tell 9.5Hz from 10.5Hz. Four seconds gives 0.25Hz bins, which
   * resolves a peak to a quarter of a hertz. That is the reason the lab windows are 4s
   * while the live display stays at 1s: it is not a preference, the shorter window cannot
   * represent the answer. 4s at 256Hz is 1024 samples, which is a power of two, so the
   * radix-2 FFT above takes it without padding.
   *
   * WHY A PLAIN PEAK-PICK IS WRONG. EEG power falls off with frequency (the 1/f
   * background), so the largest raw value in 7.5-13Hz is almost always near 7.5 whether or
   * not there is an alpha peak there at all. The background has to be removed first. This
   * fits a straight line to log10(power) against log10(frequency) — which is what 1/f
   * means — over 2-30Hz while EXCLUDING 6.5-14Hz, so the alpha bump cannot pull the fit
   * that is meant to describe everything except the alpha bump.
   */
  const IAF_SEARCH_HZ = [7.5, 13];
  const IAF_WINDOW_SEC = 4;
  /*
   * THE THREE GATES A BUMP HAS TO PASS, and every number here was measured rather than
   * chosen. The measurement: pink noise with no alpha component at all, 25-40 realisations
   * at each of several durations, asking what the detector claims when there is nothing
   * there. Then the same with a deliberately weak alpha component added.
   *
   *                        prominence (max)   half-prominence width
   *   noise only,  10s          3.28                 0.75Hz
   *   noise only,  40s          1.90                 0.50Hz
   *   noise only, 180s          1.77                 0.25Hz
   *   weak alpha (amp 0.7)      2.32-2.56            1.50-1.75Hz
   *   ordinary alpha            12.9                 1.50Hz
   *
   * PROMINENCE ALONE IS NOT ENOUGH, which is the useful finding: noise reaches 1.77-2.15x
   * on its own, and genuinely weak alpha starts around 2.3x, so the two distributions very
   * nearly touch. A threshold there would be a coin toss. WIDTH separates them cleanly —
   * noise never exceeds 0.75Hz at half prominence and real alpha never comes in under
   * 1.5Hz — because a single lucky bin is what noise produces and a bump is what a
   * resonance produces. So width is the real gate and prominence is only a floor.
   *
   * WINDOW COUNT is the third, because both other numbers degrade with less data: at four
   * windows noise reached 3.28x and 0.75Hz. Twenty windows is about 45 seconds of clean
   * signal at 50% overlap, and below it the honest answer is that there is not enough to
   * say.
   *
   * The asymmetry is deliberate. A refused peak costs a labelled fall back to the fixed
   * 8-13Hz band. A false peak silently redefines every alpha number downstream to centre
   * on a noise bin. So these are set to miss a real weak peak rather than invent one.
   */
  const IAF_MIN_PROMINENCE = 1.5;
  const IAF_MIN_WIDTH_HZ = 1.0;
  const IAF_MIN_WINDOWS = 20;

  function pow2Floor(n) { let p = 1; while (p * 2 <= n) p *= 2; return p; }

  /*
   * Welch-style averaged power spectrum: many overlapping windows, averaged.
   *
   * Averaging is the whole point — a single 4s spectrum of EEG is far too noisy to pick a
   * peak out of, and the noise falls as 1/sqrt(windows). Overlapping by half is standard
   * and costs nothing here: independence does not matter for an average, only for the
   * observations the lab later does statistics on (which is why the analysis windows in
   * spectralWindows below do NOT overlap).
   *
   * Bad windows are excluded rather than included-and-hoped-about: a blink is a large slow
   * deflection whose spectrum sits right on top of theta and the bottom of alpha, and a
   * flat channel contributes a spectrum of nothing. How many were dropped is returned, so
   * a peak found from 12 usable windows out of 400 can be treated as the weak claim it is.
   */
  function averageSpectrum(samples, sampleRate, opts = {}) {
    const { windowSec = IAF_WINDOW_SEC, overlap = 0.5, skipBad = true } = opts;
    const want = Math.round(windowSec * sampleRate);
    const n = pow2Floor(want);
    const empty = (reason) => ({ power: null, binHz: sampleRate / Math.max(1, n), n,
      windowSec: n / sampleRate, windows: 0, skipped: 0, reason });
    if (n < 64) return empty('window too short to resolve anything');
    if (!samples || samples.length < n) return empty('not enough samples for one window');
    const step = Math.max(1, Math.round(n * (1 - Math.min(0.95, Math.max(0, overlap)))));
    const slice = (i) => (samples.subarray ? samples.subarray(i, i + n) : samples.slice(i, i + n));
    let acc = null, used = 0, skipped = 0;
    for (let i = 0; i + n <= samples.length; i += step) {
      const w = slice(i);
      if (skipBad && (isArtifact(w) || isFlat(w))) { skipped++; continue; }
      const { power } = powerSpectrum(w, sampleRate);
      if (!acc) acc = new Float64Array(power.length);
      for (let k = 0; k < power.length; k++) acc[k] += power[k];
      used++;
    }
    if (!used) { const e = empty('every window was artifact-flagged or flat'); e.skipped = skipped; return e; }
    for (let k = 0; k < acc.length; k++) acc[k] /= used;
    return { power: acc, binHz: sampleRate / n, n, windowSec: n / sampleRate,
      windows: used, skipped, reason: null };
  }

  /*
   * The 1/f background, as a straight line through log10(power) vs log10(frequency).
   *
   * Least squares, skipping the excluded band and any non-positive bin (log of zero is not
   * a number, and a zeroed bin is missing data rather than very small data). Returns null
   * rather than a fit when there are too few usable points to constrain a line — a
   * two-point "fit" would produce a confident background out of nothing.
   */
  function spectralBackground(spectrum, opts = {}) {
    const { fitLoHz = 2, fitHiHz = 30, excludeLoHz = 6.5, excludeHiHz = 14 } = opts;
    if (!spectrum || !spectrum.power) return null;
    const { power, binHz } = spectrum;
    const xs = [], ys = [];
    for (let i = 1; i < power.length; i++) {
      const f = i * binHz;
      if (f < fitLoHz || f > fitHiHz) continue;
      if (f >= excludeLoHz && f <= excludeHiHz) continue;
      if (!(power[i] > 0)) continue;
      xs.push(Math.log10(f)); ys.push(Math.log10(power[i]));
    }
    if (xs.length < 8) return null;
    let sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { sx += xs[i]; sy += ys[i]; }
    const mx = sx / xs.length, my = sy / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    if (!(den > 0)) return null;
    const b = num / den, a = my - b * mx;
    return { a, b, points: xs.length, at: (f) => Math.pow(10, a + b * Math.log10(f)) };
  }

  /*
   * The peak itself.
   *
   * Two frequencies are reported and they are not the same thing. `freqHz` is the bin with
   * the largest excess over the background — exact, and jumpy, since it can only ever be a
   * multiple of 0.25Hz and one noisy bin decides it. `cogHz` is the centre of gravity of
   * the excess across the peak's own width, which is what the individual band is built
   * from: it uses every bin in the bump instead of one, so it moves smoothly and is the
   * more stable estimate of the same quantity. Corcoran et al. (2018) make the same
   * argument for centre of gravity over argmax.
   *
   * A peak is refused, with a reason, when: the background could not be fitted; the excess
   * never reaches minProminence; or the argmax lands on the very edge of the search range,
   * which means the real bump is outside it — theta below, beta above — and naming the
   * edge frequency would be inventing a peak out of a slope.
   */
  function individualAlphaPeak(spectrum, opts = {}) {
    const { loHz = IAF_SEARCH_HZ[0], hiHz = IAF_SEARCH_HZ[1],
      minProminence = IAF_MIN_PROMINENCE, minWidthHz = IAF_MIN_WIDTH_HZ,
      minWindows = IAF_MIN_WINDOWS, halfWidthHz = 2 } = opts;
    const fixed = { found: false, band: BANDS.alpha.slice(), freqHz: null, cogHz: null,
      prominence: null, slope: null, windows: spectrum ? spectrum.windows || 0 : 0 };
    if (!spectrum || !spectrum.power) {
      return Object.assign(fixed, { reason: (spectrum && spectrum.reason) || 'no spectrum' });
    }
    if ((spectrum.windows || 0) < minWindows) {
      return Object.assign(fixed, { reason: `only ${spectrum.windows || 0} clean windows,`
        + ` need ${minWindows} (about ${Math.round(minWindows * (spectrum.windowSec || 4) / 2)}s of clean signal)` });
    }
    const bg = spectralBackground(spectrum, opts);
    if (!bg) return Object.assign(fixed, { reason: 'could not fit the 1/f background' });
    const { power, binHz } = spectrum;
    const i0 = Math.max(1, Math.ceil(loHz / binHz));
    const i1 = Math.min(power.length - 1, Math.floor(hiHz / binHz));
    if (i1 - i0 < 3) return Object.assign(fixed, { reason: 'search range too narrow for this resolution', slope: bg.b });
    // Excess over the background, per bin.
    const excess = [];
    for (let i = i0; i <= i1; i++) {
      const f = i * binHz, base = bg.at(f);
      excess.push({ i, f, ratio: base > 0 ? power[i] / base : 0, over: power[i] - base });
    }
    let best = excess[0];
    for (const e of excess) if (e.ratio > best.ratio) best = e;
    const out = Object.assign({}, fixed, { freqHz: best.f, prominence: best.ratio, slope: bg.b });
    if (best.ratio < minProminence) {
      return Object.assign(out, { reason: `no bump above the background (best ${best.ratio.toFixed(2)}x, need ${minProminence}x)` });
    }
    if (best.i === i0 || best.i === i1) {
      return Object.assign(out, { reason: `the largest excess is at the edge of ${loHz}-${hiHz}Hz, so the real bump is outside it` });
    }
    /* CENTRE OF GRAVITY over the contiguous run around the peak where the excess is still
       at least half of the peak's. Half-power width rather than a fixed span, so a broad
       bump and a narrow one each get weighted by their own shape. */
    const halfRatio = 1 + (best.ratio - 1) / 2;
    const at = excess.findIndex((e) => e.i === best.i);
    let lo = at, hi = at;
    while (lo > 0 && excess[lo - 1].ratio >= halfRatio) lo--;
    while (hi < excess.length - 1 && excess[hi + 1].ratio >= halfRatio) hi++;
    let wsum = 0, fsum = 0;
    for (let k = lo; k <= hi; k++) {
      const w = Math.max(0, excess[k].over);
      wsum += w; fsum += w * excess[k].f;
    }
    const cog = wsum > 0 ? fsum / wsum : best.f;
    /* The band is cog +/- 2Hz, the Klimesch convention, clamped so it cannot swallow the
       delta floor or reach into the beta range where it would stop meaning alpha. */
    const band = [Math.max(6, cog - halfWidthHz), Math.min(14, cog + halfWidthHz)];
    const widthHz = excess[hi].f - excess[lo].f;
    /* THE GATE THAT DOES THE WORK — see the table above. A one-bin excess is what noise
       produces; a bump is what a resonance produces. Checked after the centre of gravity
       so the refusal can report the width it measured. */
    if (widthHz < minWidthHz) {
      return Object.assign(out, { cogHz: cog, widthHz,
        reason: `the excess is only ${widthHz.toFixed(2)}Hz wide at half prominence,`
          + ` which is what noise looks like (need ${minWidthHz}Hz)` });
    }
    return Object.assign(out, { found: true, cogHz: cog, band, reason: null, widthHz });
  }

  /*
   * Every channel, then the best of them.
   *
   * Per channel because alpha is not evenly distributed over the head: it is strongest
   * posteriorly, so on this headband TP9 and TP10 behind the ears will usually show a peak
   * that AF7 and AF8 on the forehead barely hint at. Taking the most prominent channel is
   * the right call for ESTIMATING the frequency — a peak is a property of the person, not
   * of the electrode — and the per-channel table is kept so a frontal-only "peak" can be
   * seen for what it is.
   *
   * When nothing is found anywhere, `fallback` is true and the band is the fixed 8-13Hz.
   * That case must be labelled wherever the number is shown: an individual band and a
   * population band are different claims and must not look alike.
   */
  function alphaPeakByChannel(eeg, sampleRate, opts = {}) {
    const channels = (eeg || []).map((samples, i) => {
      const spectrum = averageSpectrum(samples, sampleRate, opts);
      const peak = individualAlphaPeak(spectrum, opts);
      return Object.assign({ name: CHANNEL_NAMES[i] || `ch${i}`, channel: i,
        windows: spectrum.windows, skipped: spectrum.skipped, binHz: spectrum.binHz }, peak);
    });
    return pickAlphaPeak(channels);
  }

  /*
   * The best channel out of a set of per-channel results, and the fallback when there is
   * none. Separate from alphaPeakByChannel so the two callers share it: the lab has whole
   * recorded arrays to work from, while the app accumulates spectra as the sit runs and
   * never holds the samples. One place to decide what "the" peak is means the summary
   * screen and the lab cannot disagree about it.
   */
  function pickAlphaPeak(channels) {
    let best = null;
    for (const c of channels || []) {
      if (!c.found) continue;
      if (!best || c.prominence > best.prominence) best = c;
    }
    const list = channels || [];
    return {
      channels: list,
      best: best ? best.channel : null,
      bestName: best ? best.name : null,
      freqHz: best ? best.cogHz : null,
      band: best ? best.band : BANDS.alpha.slice(),
      prominence: best ? best.prominence : null,
      fallback: !best,
      windows: list.reduce((m, c) => Math.max(m, c.windows || 0), 0),
      windowSec: list.length && list[0].binHz ? 1 / list[0].binHz : null,
      reason: best ? null : (list.find((c) => c.reason) || {}).reason || 'no channels',
    };
  }

  /*
   * The same averaged spectrum, accumulated AS THE SIT RUNS.
   *
   * The app cannot use averageSpectrum: it never holds the whole recording. Raw EEG goes
   * straight to IndexedDB in chunks and the in-memory buffer is bounded to two seconds, so
   * measuring a peak from memory would mean either keeping a second full copy of the sit
   * (~10MB) or reading it all back out of storage on the summary screen.
   *
   * Neither is necessary, because an average does not need its inputs kept. This holds a
   * 4-second ring buffer per channel and folds one window's spectrum into a running sum
   * every 2 seconds, then divides at the end. Memory is fixed at one window plus one
   * spectrum — about 12KB per channel — no matter whether the sit is five minutes or two
   * hours, and the answer is identical to running averageSpectrum over the whole recording.
   */
  function SpectrumAccumulator(sampleRate, opts = {}) {
    const { windowSec = IAF_WINDOW_SEC, hopSec = null, skipBad = true } = opts;
    const n = pow2Floor(Math.round(windowSec * sampleRate));
    const hop = Math.max(1, Math.round((hopSec == null ? windowSec / 2 : hopSec) * sampleRate));
    const ring = new Float64Array(n);
    const flat = new Float64Array(n);
    let write = 0, filled = 0, sinceHop = 0;
    let acc = null, windows = 0, skipped = 0;
    function fold() {
      // Oldest-first out of the ring, because a spectrum of a rotated window is not the
      // spectrum of the window.
      for (let i = 0; i < n; i++) flat[i] = ring[(write + i) % n];
      if (skipBad && (isArtifact(flat) || isFlat(flat))) { skipped++; return; }
      const { power } = powerSpectrum(flat, sampleRate);
      if (!acc) acc = new Float64Array(power.length);
      for (let k = 0; k < power.length; k++) acc[k] += power[k];
      windows++;
    }
    return {
      n, windowSec: n / sampleRate, binHz: sampleRate / n,
      push(samples) {
        for (let i = 0; i < samples.length; i++) {
          ring[write] = samples[i];
          write = (write + 1) % n;
          if (filled < n) filled++;
          sinceHop++;
          if (filled === n && sinceHop >= hop) { sinceHop = 0; fold(); }
        }
      },
      spectrum() {
        if (!windows || !acc) {
          return { power: null, binHz: sampleRate / n, n, windowSec: n / sampleRate,
            windows: 0, skipped,
            reason: skipped ? 'every window was artifact-flagged or flat'
              : 'not enough clean signal yet' };
        }
        const out = new Float64Array(acc.length);
        for (let k = 0; k < acc.length; k++) out[k] = acc[k] / windows;
        return { power: out, binHz: sampleRate / n, n, windowSec: n / sampleRate,
          windows, skipped, reason: null };
      },
      // A new sit is a new estimate: alpha frequency shifts with arousal and time of day,
      // so carrying yesterday's windows into today's average would blur exactly the thing
      // being measured.
      reset() { write = 0; filled = 0; sinceHop = 0; acc = null; windows = 0; skipped = 0; },
    };
  }

  /*
   * Band powers per fixed-length window, for the lab's observations.
   *
   * WINDOWS DO NOT OVERLAP HERE, and that is a statistical requirement rather than a
   * preference. The averaged spectrum above overlaps by half because more windows only
   * make an average better. These windows become the OBSERVATIONS the lab correlates,
   * permutes and multiplicity-corrects, and overlapping windows share samples, so they are
   * not independent: the effective count would be smaller than the row count and every
   * p-value would come out optimistic by an unknown factor. Non-overlapping costs half the
   * rows and keeps the arithmetic honest.
   *
   * A channel that is artifact-flagged or flat in a given window yields NULL for that
   * window rather than a number. Same rule as the live display: a gap is true, and a value
   * nobody measured is worse than a missing one.
   *
   * `alphaBand` is the caller's, so this is where an individual alpha band actually gets
   * used. Theta and beta stay fixed: the individual measurement is about where the alpha
   * resonance sits, and it says nothing about where theta ends.
   */
  function bandSeries(eeg, sampleRate, opts = {}) {
    const { windowSec = IAF_WINDOW_SEC, alphaBand = BANDS.alpha, totalBand = [1, 30] } = opts;
    const n = pow2Floor(Math.round(windowSec * sampleRate));
    const chans = eeg || [];
    let len = 0;
    for (const c of chans) if (c && c.length > len) len = c.length;
    const rows = [];
    if (n >= 64) {
      for (let i = 0; i + n <= len; i += n) {
        const row = { tSec: i / sampleRate, channels: [] };
        for (const c of chans) {
          if (!c || i + n > c.length) { row.channels.push(null); continue; }
          const w = c.subarray ? c.subarray(i, i + n) : c.slice(i, i + n);
          if (isArtifact(w) || isFlat(w)) { row.channels.push(null); continue; }
          const sp = powerSpectrum(w, sampleRate);
          row.channels.push({
            alpha: bandPower(sp, alphaBand[0], alphaBand[1]),
            theta: bandPower(sp, BANDS.theta[0], BANDS.theta[1]),
            beta: bandPower(sp, BANDS.beta[0], BANDS.beta[1]),
            total: bandPower(sp, totalBand[0], totalBand[1]),
          });
        }
        rows.push(row);
      }
    }
    return { windowSec: n / sampleRate, n, binHz: sampleRate / n, rows,
      alphaBand: alphaBand.slice() };
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

  /*
   * A CHANNEL CAN FAIL BY BEING TOO QUIET, and until this existed that failure was
   * reported as a clean reading.
   *
   * isArtifact only ever tested the UPPER bound. A channel delivering flat zeros — a
   * stream that arrives but carries nothing — has a peak-to-peak of 0, which is not
   * greater than 150, so it passed as clean. Its band powers are then all zero and
   * alpha/(alpha+beta+1e-9) evaluates to exactly 0, so it was labelled "Beta", marked
   * fresh, and its level of zero was fed to the visual as a real measurement. That is the
   * "sensor reads 0" in "it looks like the history lines still drift, esp when the sensor
   * reads 0 and everything pushes up": a fabricated floor, dragging the axis down and
   * lifting the whole recorded trace with it.
   *
   * 3µV is chosen with room on both sides. The Muse quantises at 0.488µV/LSB, so
   * quantisation alone spans about 1µV peak-to-peak; resting EEG on an electrode that is
   * actually touching skin is 10-50µV over a one-second window. Nothing real lives
   * between those, so this fires only on a channel that is genuinely silent.
   */
  const FLAT_PTP_UV = 3;
  function isFlat(samples, thresholdUv = FLAT_PTP_UV) {
    if (!samples || !samples.length) return true;
    return peakToPeak(samples) < thresholdUv;
  }

  // ---- Blink vs jaw discrimination ---------------------------------------
  // Unlike the interpretive scores, these two are genuinely well-characterised
  // and worth treating as measured rather than inferred:
  //
  //  * A BLINK is a large, slow deflection (roughly 1-4Hz, i.e. delta band)
  //    driven by a single common source in front of the head, so it appears
  //    with the SAME sign on both forehead sensors — strongly positively
  //    correlated between AF7 and AF8.
  //  * JAW / facial MUSCLE is high-frequency broadband activity (EMG, well
  //    above the EEG bands of interest) and is not required to correlate.
  //
  // Separating them matters for two reasons: they need different advice
  // ("soften your jaw" is useless for blinking), and each one explains sudden
  // jumps in every other metric while it is happening.
  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 8) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den < 1e-12 ? 0 : num / den;
  }

  function classifyArtifact(chA, chB, sampleRate) {
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const ptp = Math.max(peakToPeak(chA), peakToPeak(chB));
    const pa = bandPowers(chA, sampleRate), pb = bandPowers(chB, sampleRate);
    const total = (p) => p.delta + p.theta + p.alpha + p.beta + p.gamma + 1e-12;
    const deltaShare = 0.5 * (pa.delta / total(pa) + pb.delta / total(pb));
    const gammaShare = 0.5 * (pa.gamma / total(pa) + pb.gamma / total(pb));
    const corr = pearson(chA, chB);

    // Amplitude gate: resting frontal EEG sits well under ~60µV peak-to-peak,
    // so neither event is claimed at all until the signal is genuinely large.
    const amp = clamp((ptp - 60) / 220);
    const blink = clamp(amp * clamp((deltaShare - 0.32) / 0.40) * clamp((corr - 0.15) / 0.55));
    const jaw = clamp(amp * clamp((gammaShare - 0.08) / 0.22));
    return { blink, jaw, corr, ptp, deltaShare, gammaShare };
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
  /*
   * THE BASELINE LEARNS, THEN IT HOLDS. `holdAfter` is why, and it is the fix for a
   * complaint that has now been made twice.
   *
   * Reported the first time as "i'm not convinced that we should be normalizing
   * everything... if it wasn't normalized it would be a better indicator when i'm
   * generally calm thruout a sit, right?", and the second time as lines that DRIFT. Both
   * are the same defect and it is this: `mu` chases the signal it is measuring. At
   * adapt=0.001 on a 4Hz tick that is a ~250-second time constant, so any level the
   * signal actually holds is subtracted back out of the display. Measured, on a raw
   * signal that steps from 0.3 to 0.8 at one minute and then never moves again:
   *
   *     displayed at 2min  69.2
   *     displayed at 5min  61.7      <- the signal has not changed
   *     displayed at 10min 55.9      <- still has not changed
   *
   * The line slides back to the middle on its own. Every value it passes through is a
   * change the meditator did not make, which is the worst possible thing for a mirror to
   * show, and it is also why a uniformly calm sit and a uniformly agitated one both land
   * near 50 (see the calmAbs note in app.js — rank correlation MINUS 0.32 across seven
   * real sits).
   *
   * So: adapt for the first `holdAfter` USABLE updates to learn this person's scale on
   * this day, then stop moving. After that the map from raw to displayed is fixed for the
   * rest of the sit, so the line moves if and only if the signal moved.
   *
   * Counted in USABLE updates, not ticks. A null raw — an artifact window, a floating
   * electrode — teaches nothing and must not count, or a sit that starts with a badly
   * seated headband would freeze its scale on the two minutes of rubbish that produced no
   * readings at all.
   *
   * `minSd` goes with a hold, because a hold can land on an unrepresentatively quiet
   * stretch. With no floor under the standard deviation, every later excursion divides by
   * almost nothing and saturates at 0 or 100 — a bar pegged at the top reads as a
   * confident detection rather than as "outside the range I calibrated on", which is the
   * failure mode HANDOFF §6 already names for hard clamps. It defaults to 0 rather than to
   * something sensible on purpose: a floor changes the output of a normaliser that has not
   * opted into anything, and `holdAfter = null` has to mean the behaviour is bit-for-bit
   * what it was.
   */
  class AdaptiveNormalizer {
    constructor({ adapt = 0.001, slope = 0.9, smoothing = 0.05,
      holdAfter = null, minSd = 0 } = {}) {
      this.adapt = adapt; this.slope = slope; this.smoothing = smoothing;
      this.holdAfter = holdAfter; this.minSd = minSd;
      this.mu = null; this.varr = 0.25; this.value = 0.5;
      // How many updates carried a real reading. The hold is spent in these, not in time.
      this.clean = 0;
    }
    // Whether the scale is now fixed. The UI says so, because a reader is owed the
    // difference between "relative to the last few minutes" and "relative to the first
    // two" — they support different conclusions.
    get held() { return this.holdAfter != null && this.clean >= this.holdAfter; }
    update(raw) {
      let target = this.value;
      if (raw != null && !Number.isNaN(raw)) {
        if (this.mu === null) this.mu = raw;
        // Learn only while the baseline is still open. Once held, mu and varr are the
        // fixed reference and this is a plain affine map through a logistic.
        if (!this.held) {
          this.clean++;
          this.mu += this.adapt * (raw - this.mu);
          this.varr += this.adapt * ((raw - this.mu) * (raw - this.mu) - this.varr);
        }
        const sd = Math.max(this.minSd, Math.sqrt(this.varr + 1e-6));
        const z = (raw - this.mu) / sd;
        target = 1 / (1 + Math.exp(-z * this.slope));
      }
      this.value += this.smoothing * (target - this.value);
      return this.value;
    }
  }

  /*
   * How long a baseline stays open before it holds, in USABLE updates.
   *
   * 480 is two minutes of clean windows at the app's 4Hz tick. The trade is short and
   * legible in both directions: too brief and the scale is set on however you happened to
   * be sitting in the first thirty seconds, too long and most of the sit is still being
   * re-centred out from under you. Two minutes is also roughly when the 16-second band
   * averager has enough history for the ratio it feeds in to mean anything.
   *
   * Named here rather than at each call site because five normalisers share it, and five
   * copies of a number is how the chart and the visual end up disagreeing about calm.
   */
  const BASELINE_HOLD_UPDATES = 480;
  // The floor under the held standard deviation. See the minSd note above.
  const BASELINE_MIN_SD = 0.05;

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

  // ---- Mental-activity ("thinking") score --------------------------------
  // Deliberately NOT the same thing as `noise`. Noise here means movement
  // artifact — jaw, blink, a shifting headband — which is a measurement
  // problem. This is a signal about cortical activation, computed only from
  // artifact-FREE windows, from three components that all point the same way:
  //
  //   1. beta level      — beta (13-30Hz) rises with active, effortful,
  //                        analytical engagement.
  //   2. variability     — a churning mind's band powers move around a lot;
  //                        a settled one holds steadier. Rolling standard
  //                        deviation of the alpha/beta log-ratio.
  //   3. spike density   — how often the balance shifts abruptly, i.e. the
  //                        rate of discrete "something just happened" events.
  //
  // HONESTY BOUNDARY: this measures mental ACTIVATION, not thoughts. It cannot
  // read content, and it cannot distinguish "solving a problem" from "worrying"
  // from "composing a poem". Present it as activity, never as mind-reading.
  class ActivityTracker {
    /* `holdAfter` is passed straight down to both inner normalisers. Thinking is on the
       chart beside Calm, so if one baseline holds and the other keeps chasing, the two
       lines answer different questions while looking like one picture. */
    constructor({ varWindow = 40, smoothing = 0.06, spikeDecay = 0.94,
      holdAfter = null, minSd = 0 } = {}) {
      this.varWindow = varWindow;      // ticks; 40 @ ~4/sec ≈ 10s
      this.smoothing = smoothing;
      this.spikeDecay = spikeDecay;
      this.betaNorm = new AdaptiveNormalizer({ smoothing: 0.12, holdAfter, minSd });
      this.varNorm = new AdaptiveNormalizer({ smoothing: 0.12, holdAfter, minSd });
      this.ratios = [];
      this.spikeDensity = 0;
      this.value = 0.5;
    }
    update({ betaLog = null, ratio = null, artifact = false, spiked = false } = {}) {
      // Spike density decays continuously, but a spike only counts when the
      // window was clean — an artifact is not a thought.
      this.spikeDensity *= this.spikeDecay;
      if (artifact) return this.value; // hold; don't learn from unusable data
      if (spiked) this.spikeDensity = Math.min(1, this.spikeDensity + 0.5);

      const betaLevel = betaLog == null ? 0.5 : this.betaNorm.update(betaLog);

      let variability = 0.5;
      if (ratio != null && !Number.isNaN(ratio)) {
        this.ratios.push(ratio);
        if (this.ratios.length > this.varWindow) this.ratios.shift();
        if (this.ratios.length >= 4) {
          const mean = this.ratios.reduce((a, b) => a + b, 0) / this.ratios.length;
          const sd = Math.sqrt(
            this.ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.ratios.length
          );
          variability = this.varNorm.update(sd);
        }
      }

      const target = Math.max(0, Math.min(1,
        0.45 * betaLevel + 0.35 * variability + 0.20 * Math.min(1, this.spikeDensity)
      ));
      this.value += this.smoothing * (target - this.value);
      return this.value;
    }
  }

  /*
   * HOW LONG THE DISPLAYED BAND POWERS ARE AVERAGED OVER, and why it is not a preference.
   *
   * THE MEASUREMENT THAT SET IT. Reported as "the scores are so volatile they seem to contradict real
   * life. my calm score doesn't fluctuate so often and wildly." That is correct, and the cause is not
   * the formulas — it is the estimator. Band power from a single 1-second periodogram is a very noisy
   * estimate. Measured on a STATIONARY stochastic EEG model, where the true state never changes by
   * construction, the 2-98% span of log(alpha/beta) is:
   *
   *     1s of signal   1.89 log units       16s   0.49
   *     2s             1.48                 32s   0.25
   *     4s             1.05
   *     8s             0.69
   *
   * Against that, the real changes worth showing are:
   *
   *     a 20% rise in alpha   0.18 log units
   *     a 40% rise            0.34
   *     a DOUBLING of alpha   0.69
   *
   * So at the 1-second window this app shipped with, the second-to-second noise was 1.89 against 0.69
   * for a doubling of alpha — the noise was nearly three times larger than the largest change a person
   * is likely to produce. Every number on screen was mostly estimator noise, and no amount of display
   * smoothing fixes that: smoothing a noisy estimate makes it a smooth wrong estimate.
   *
   * 16 SECONDS is the smallest averaging span at which a doubling of alpha becomes larger than the
   * noise (0.69 against 0.49). It is a floor, not a comfortable margin — 32s would be needed before a
   * 40% change clears the noise — and it is chosen at the floor because averaging costs lag, and lag
   * is not free either: a score that takes a minute to move cannot be read against what you notice
   * yourself doing.
   *
   * NON-OVERLAPPING seconds. The app ticks four times a second on a one-second window, so consecutive
   * estimates share 75% of their samples and are barely independent — averaging sixteen of THOSE buys
   * about four seconds' worth of averaging, not sixteen. One estimate per second, no overlap, is what
   * the numbers above were measured with.
   */
  const BAND_AVERAGE_SEC = 16;

  /*
   * A running average of band powers over the last N non-overlapping seconds.
   *
   * Powers are averaged in the LINEAR domain and logged afterwards by the caller, because the mean of
   * logs is the log of the geometric mean — a different quantity, and one that a single very quiet
   * second drags down hard. Averaging power then taking the log is what "average band power over 16
   * seconds" means.
   *
   * Entries carry a timestamp and expire. Without that, a run of artifact-flagged seconds would leave
   * the last clean average standing indefinitely, and a number from two minutes ago presented as
   * current is worse than no number: it is stale in a way nothing on screen reveals.
   */
  class BandPowerAverager {
    constructor({ seconds = BAND_AVERAGE_SEC, maxAgeSec = null } = {}) {
      this.seconds = Math.max(1, Math.round(seconds));
      // Three times the span: long enough that ordinary blinks do not empty it, short enough that a
      // number can never be older than the window it claims to describe by more than a factor of a few.
      this.maxAgeSec = maxAgeSec == null ? this.seconds * 3 : maxAgeSec;
      this.entries = [];
    }
    push(powers, atSec) {
      if (!powers) return;
      for (const k of ['delta', 'theta', 'alpha', 'beta']) {
        if (!Number.isFinite(powers[k])) return;      // a partial estimate is not an estimate
      }
      this.entries.push({ powers, at: atSec });
      this.trim(atSec);
    }
    trim(nowSec) {
      if (nowSec != null) {
        while (this.entries.length && nowSec - this.entries[0].at > this.maxAgeSec) this.entries.shift();
      }
      while (this.entries.length > this.seconds) this.entries.shift();
    }
    // How many seconds of clean signal are actually behind the current answer. Reported rather than
    // assumed, so the caller can say "settling" instead of presenting a one-second estimate as a
    // sixteen-second one.
    filled(nowSec) {
      this.trim(nowSec);
      return this.entries.length;
    }
    mean(nowSec) {
      this.trim(nowSec);
      const n = this.entries.length;
      if (!n) return null;
      const out = { delta: 0, theta: 0, alpha: 0, beta: 0, seconds: n };
      for (const e of this.entries) {
        out.delta += e.powers.delta; out.theta += e.powers.theta;
        out.alpha += e.powers.alpha; out.beta += e.powers.beta;
      }
      out.delta /= n; out.theta /= n; out.alpha /= n; out.beta /= n;
      return out;
    }
    reset() { this.entries = []; }
  }

  /* ==========================================================================
   * THE COMPOSITES, AS ABSOLUTE BAND SHARES
   * ==========================================================================
   *
   * WHY THIS EXISTS. Every composite in this app used to be built from AdaptiveNormalizer outputs —
   * within-sit z-scores of log band power, squashed through a logistic. Two consequences, both fatal
   * and both now measured on real recordings:
   *
   *   1. A NORMALISED SCORE CANNOT SAY WHAT A SIT WAS. The normaliser subtracts the sit's own running
   *      mean, so a uniformly calm sit and a uniformly agitated one both land near 50 by construction.
   *      Across seven sits the displayed Calm spanned 42.3-52.9 while the underlying alpha/beta spanned
   *      more than twofold, and their rank correlation was MINUS 0.32 — the best sit scored lowest.
   *
   *   2. A RATIO OF TWO NORMALISED NUMBERS IS ALMOST A CONSTANT. `drowsy` was normTheta/(normTheta +
   *      normAlpha). Both inputs hover at 0.5, so the ratio hovers at 0.5. Measured on a whole retreat
   *      sit it moved between 0.55 and 0.66 — a sixth of the display, for a metric that is supposed to
   *      distinguish wide awake from falling asleep. `focus` and `openness` had the same shape.
   *
   * The second one is the deeper mistake: a ratio of band powers is ALREADY scale-free. Normalising
   * each side first does not make it comparable, it removes the only information the ratio carried.
   *
   * So these take raw (16-second averaged) band powers and return shares. Nothing here has a fitted
   * parameter except `CALM_WINDOW`, which is a display window and is documented as one.
   */

  /*
   * THE THREE SHARES OF 4-30Hz. theta, alpha and beta as fractions of their own sum, so they add to 1
   * and each is a share of the same whole — one simplex, comparable between sits and between people
   * without any calibration. Delta is deliberately excluded: at a forehead electrode 1-4Hz is mostly
   * eye movement, blinks and electrode drift, and this app's own classifyArtifact() detects a blink AS
   * energy in that band. Gamma is excluded because above 30Hz a dry frontal electrode is reading muscle.
   */
  function bandShares(powers) {
    if (!powers) return null;
    const theta = powers.theta, alpha = powers.alpha, beta = powers.beta;
    for (const v of [theta, alpha, beta]) {
      if (!Number.isFinite(v) || v < 0) return null;
    }
    const all = theta + alpha + beta;
    const fast = alpha + beta;
    if (!(all > 0) || !(fast > 0)) return null;
    return {
      theta: theta / all,
      alpha: alpha / all,
      beta: beta / all,
      // Alpha against the fast band only, ignoring theta. The contrast that orders real sits — see
      // CALM_WINDOW. 0.5 means equal alpha and beta power, for every person on every day.
      alphaOfFast: alpha / fast,
    };
  }

  /*
   * CALM'S DISPLAY WINDOW — the one fitted pair of numbers in the project, and the story of how it was
   * got wrong once is the important part of this comment.
   *
   * THE MEASUREMENT is `alphaOfFast`: alpha's share of alpha plus beta at the frontal pair. It needs no
   * calibration and 0.5 always means equal alpha and beta power. What it does not do is use the width of
   * a 0-100 display: measured over 1762 seconds of real recording, this person's share runs p5 0.253 to
   * p95 0.497. The window maps that observed range onto the display range, and nothing more.
   *
   * FIRST ATTEMPT, AND WHY IT WAS WRONG. The window was set to [0.20, 0.42] by fitting it to four sits
   * with written descriptions, and it put the peak retreat sit at 91 — which looked like a triumph. Then
   * a deliberately non-meditative session arrived for contrast: 26 minutes at 11:46pm, "just a test, i'm
   * trying to figure this out and it's noisy", with notes reading "noisy from TV" and "moving the mouse
   * and listening to music". It scored 72 on that window, and its 15-20 minute block scored 86.
   *
   * Fitting to four labels had produced a window that called a late-night TV session calm. So the window
   * is now taken from the pooled DISTRIBUTION of every recording available, which is a property of the
   * signal rather than of anyone's opinion about a sit, and rounded to two figures because 1762 seconds
   * from one person on one headband does not support a third.
   *
   * WHAT THE SCORE DOES AND DOES NOT SEPARATE, measured as AUC — the chance that a random second of the
   * Zen sit outscores a random second of the non-Zen session. 0.5 is a coin toss.
   *
   *   sit                                                  share    old Calm   new Calm    AUC vs non-Zen
   *   "thinking pulling me a lot"                          0.224     42-53         5
   *   "working, not meditating"                            0.268     42-53        11
   *   "very calm, not a lot of effort"                      0.349     42-53        38
   *   NON-ZEN: 26min, TV on, moving the mouse, music        0.373       50         49        (reference)
   *   "Zen mind, but I sneezed and the sensors went out"    0.356       20         41            0.41
   *   "relaxed, mind settling naturally"                    0.395     42-53        60
   *   "85% Zen mind. attentive, calm, slow breathing."      0.445       47         80            0.78
   *
   * So: the peak sit is now clearly separated from a working session and from an agitated one, which is
   * what the score could not do at all before — it spanned 42-53 across all of them with a rank
   * correlation of MINUS 0.32 against the physiology. But AUC 0.78 is fair, not good, and the non-Zen
   * session lands mid-scale rather than low. Someone watching TV late at night has as much frontal alpha
   * as someone in deep zazen at 7am: measured, 72,833 against 74,867 in the same units, a 3% difference.
   * This score cannot tell those two apart and the caveat in metrics.js says so.
   *
   * WHAT DID SEPARATE THEM, for whoever works on this next. Not alpha — BETA and GAMMA. The non-Zen
   * session had 1.4x the beta power and 1.7x the gamma of the peak sit, and beta's share of the band
   * separated at AUC 0.74 in the correct direction. Gamma at a dry forehead electrode is mostly facial
   * EMG, so the cleanest single discriminator available here is closer to "is your face still" than to
   * anything about attention. `alpha/(alpha+beta+gamma)` measured AUC 0.787 against this one's 0.778,
   * which is not a real improvement on two sessions but is the direction worth more data.
   *
   * WHAT THIS IS NOT. Not a claim about physiology, not per-sit adaptation (which is the thing that broke
   * this in the first place), and not validation: three sessions from one person on one headband. It is a
   * FIXED, MONOTONE transform — it cannot reorder two sits, it is identical in every recording, and the
   * unmapped share is written to `metrics.csv` as `calmAbs`, so every sit can be re-scored when the
   * window turns out wrong again.
   *
   * `expandSoft` rather than a clamp: a hard clamp draws every excursion past the window as a dead flat
   * line pressed against the edge, which reads as a confident detection rather than an out-of-range one.
   */
  const CALM_WINDOW = Object.freeze({ lo: 0.25, hi: 0.50 });

  function calmFromShares(shares) {
    if (!shares || !Number.isFinite(shares.alphaOfFast)) return null;
    const t = (shares.alphaOfFast - CALM_WINDOW.lo) / (CALM_WINDOW.hi - CALM_WINDOW.lo);
    // The same saturating map VizCore.expandSoft uses, inlined so dsp.js keeps no dependency on it.
    return 0.5 + 0.5 * Math.tanh((t - 0.5) * 2.4);
  }

  /*
   * THINKING: beta's share of the whole 4-30Hz band.
   *
   * Not `1 - calm`. Beta against alpha alone is the same axis Calm already reports, so pairing them
   * would put one fact on the panel twice. Beta's share of everything is a different question — how
   * much of what is going on is fast — and it can rise while alpha rises too, if theta is what gave way.
   *
   * The honest confound, stated because it cannot be removed at this electrode: frontal beta includes
   * EMG from the jaw and the small muscles of the face. `jaw` is reported separately so a reader can
   * see when that is likely, and it is why the second retreat sit reads higher on this than the first.
   */
  function thinkingFromShares(shares) {
    return shares && Number.isFinite(shares.beta) ? shares.beta : null;
  }

  /*
   * DROWSY: slow-wave dominance AND alpha having given way, as a PRODUCT.
   *
   * Reported as "the drowsiness is all off". It was theta's share against alpha, and it read 0.52-0.70
   * through a sit the practitioner described as "attentive, calm" with the head accelerometer showing
   * 90% stillness and no forward pitch drift at all. It was not wrong about the spectrum — frontal
   * theta really was twice alpha — it was wrong about what that means.
   *
   * THE PROBLEM IS REAL AND HAS NO SPECTRAL-ONLY ANSWER. Frontal midline theta is the signature of
   * absorbed internal attention, and sleep-onset theta is the signature of falling asleep, and at a
   * forehead electrode over one-second windows they look the same. Theta alone therefore cannot
   * separate them and never could.
   *
   * What DOES separate them is alpha. In drowsiness alpha attenuates and fragments as theta rises; in
   * absorbed meditation alpha is sustained. So this is a conjunction: slow activity has to dominate the
   * band AND alpha has to have lost the fast contest. On the retreat sits, where alpha won that contest
   * more decisively than in any previous recording, it reads 29 and 32 instead of 59 and 60.
   *
   * A PRODUCT, NOT A GEOMETRIC MEAN. `sqrt(a*b)` is used elsewhere in this codebase for conjunctions
   * and would be wrong here: it lets a large theta alone carry the score, which is exactly the failure
   * being fixed. The product's practical range is compressed toward the bottom — sleep onset models to
   * about 0.46 — and that is the honest shape of a conjunction rather than something to stretch out.
   */
  function drowsyFromShares(shares) {
    if (!shares || !Number.isFinite(shares.theta) || !Number.isFinite(shares.alphaOfFast)) return null;
    return Math.max(0, Math.min(1, shares.theta * (1 - shares.alphaOfFast)));
  }

  /*
   * FOCUS: theta's share of the whole band.
   *
   * Frontal midline theta is the best-supported attention marker available at this placement, and this
   * is it, unscaled. Its practical range is roughly 0.2-0.55 and it is deliberately NOT stretched to
   * fill the display the way Calm is — there is no set of independently-described sits to anchor a
   * window with, and inventing one would be the calibration this file exists to avoid.
   *
   * It shares its numerator with Drowsy on purpose. Theta rising is the same event; whether it is
   * attention or sleepiness is what Drowsy's alpha term decides. Reading them together is the point.
   *
   * metrics.js combines this with `1 - variability` as a geometric mean, so Focus also requires the
   * signal to be holding still. That part stays in metrics.js because variability is not a band share.
   */
  function focusFromShares(shares) {
    return shares && Number.isFinite(shares.theta) ? shares.theta : null;
  }

  return {
    BAND_AVERAGE_SEC, BandPowerAverager,
    bandShares, CALM_WINDOW, calmFromShares, thinkingFromShares, drowsyFromShares, focusFromShares,
    MUSE_SERVICE, CONTROL_CHARACTERISTIC, EEG_CHARACTERISTICS, CHANNEL_NAMES,
    EEG_FREQUENCY, EEG_SAMPLES_PER_PACKET,
    PPG_CHARACTERISTICS, PPG_CHANNEL_NAMES, PPG_FREQUENCY, PPG_SAMPLES_PER_PACKET,
    MUSE_IMU_CANDIDATES, MUSE_IMU_SCALE_MG, MUSE_IMU_FREQUENCY, MUSE_IMU_SAMPLES_PER_PACKET,
    decodeMuseImu,
    encodeCommand, decode12Bit, decode24Bit, samplesToMicrovolts,
    hannWindow, fft, powerSpectrum, bandPower, BANDS, bandPowers,
    IAF_SEARCH_HZ, IAF_WINDOW_SEC, IAF_MIN_PROMINENCE, IAF_MIN_WIDTH_HZ, IAF_MIN_WINDOWS,
    pow2Floor,
    averageSpectrum, spectralBackground, individualAlphaPeak, alphaPeakByChannel,
    pickAlphaPeak, SpectrumAccumulator, bandSeries,
    ARTIFACT_PTP_UV, peakToPeak, isArtifact, FLAT_PTP_UV, isFlat, pearson, classifyArtifact,
    detectBeats, estimateBreathingPeriod,
    AdaptiveNormalizer, SpikeDetector, ActivityTracker,
    BASELINE_HOLD_UPDATES, BASELINE_MIN_SD,
  };
});
