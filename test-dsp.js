/* Verifies the DSP core (FFT, band powers, 12-bit decode, calm smoothing)
 * with no browser and no hardware — pure math checks. */
const assert = require('assert');
const DSP = require('./public/dsp.js');

// 1) FFT correctness: compare against a brute-force DFT on a small N.
function naiveDFT(real) {
  const n = real.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += real[t] * Math.cos(ang);
      si += real[t] * Math.sin(ang);
    }
    re[k] = sr; im[k] = si;
  }
  return { re, im };
}
{
  const n = 16;
  const input = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / n) + 0.3 * i);
  const real = Float64Array.from(input), imag = new Float64Array(n);
  DSP.fft(real, imag);
  const ref = naiveDFT(input);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(real[k] - ref.re[k]) < 1e-8, `re[${k}] mismatch: ${real[k]} vs ${ref.re[k]}`);
    assert.ok(Math.abs(imag[k] - ref.im[k]) < 1e-8, `im[${k}] mismatch: ${imag[k]} vs ${ref.im[k]}`);
  }
  console.log('✓ FFT matches brute-force DFT (N=16)');
}

// 2) A pure 10 Hz tone sampled at 256 Hz for 1s (N=256, 1 Hz/bin) should
//    concentrate power in the alpha band (8-13 Hz) and little elsewhere.
{
  const n = 256, fs = 256, freq = 10;
  const samples = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / fs));
  const powers = DSP.bandPowers(samples, fs);
  const total = Object.values(powers).reduce((a, b) => a + b, 0);
  console.log(`  band powers for a 10Hz tone: ${JSON.stringify(Object.fromEntries(
    Object.entries(powers).map(([k, v]) => [k, v.toFixed(1)])))}`);
  assert.ok(powers.alpha > total * 0.8, `alpha should dominate a 10Hz tone (got ${(powers.alpha/total*100).toFixed(1)}%)`);
  assert.ok(powers.alpha > powers.beta * 5, 'alpha should swamp beta for a 10Hz tone');
  assert.ok(powers.alpha > powers.delta * 5, 'alpha should swamp delta for a 10Hz tone');
  console.log('✓ band-power split correctly isolates a 10Hz tone into alpha');
}

// 3) Same check for a 20 Hz tone -> should land in beta, not alpha.
{
  const n = 256, fs = 256, freq = 20;
  const samples = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / fs));
  const powers = DSP.bandPowers(samples, fs);
  assert.ok(powers.beta > powers.alpha * 5, `20Hz tone should land in beta, not alpha (alpha=${powers.alpha.toFixed(1)} beta=${powers.beta.toFixed(1)})`);
  console.log('✓ band-power split correctly isolates a 20Hz tone into beta');
}

// 4) 12-bit decode: hand-construct a known packing and check the unpack.
{
  // Two 12-bit values 0x123 and 0x456 packed into 3 bytes per the Muse
  // scheme: byte0 = high 8 bits of v0, byte1 = low 4 bits of v0 | high 4 of v1, byte2 = low 8 of v1.
  const v0 = 0x123, v1 = 0x456;
  const b0 = (v0 >> 4) & 0xff;
  const b1 = ((v0 & 0xf) << 4) | ((v1 >> 8) & 0xf);
  const b2 = v1 & 0xff;
  const decoded = DSP.decode12Bit(new Uint8Array([b0, b1, b2]));
  assert.deepStrictEqual(decoded, [v0, v1], `decode12Bit roundtrip failed: got ${decoded}`);
  console.log('✓ 12-bit sample unpacking round-trips correctly');
}

// 5) samplesToMicrovolts: midpoint (0x800) should map to 0 µV; known offsets scale correctly.
{
  const uv = DSP.samplesToMicrovolts([0x800, 0x800 + 100, 0x800 - 100]);
  assert.ok(Math.abs(uv[0]) < 1e-9, 'midpoint should decode to ~0 µV');
  assert.ok(Math.abs(uv[1] - 100 * 0.48828125) < 1e-9, 'positive offset scale mismatch');
  assert.ok(Math.abs(uv[2] + 100 * 0.48828125) < 1e-9, 'negative offset scale mismatch');
  console.log('✓ microvolt scaling correct');
}

// 6) AdaptiveNormalizer: same "rises across a calming session" behavior as
//    the server-side version this was generalized from.
{
  const tracker = new DSP.AdaptiveNormalizer();
  let first = null, last = null;
  for (let i = 0; i <= 400; i++) {
    const prog = Math.min(1, i / 300);
    const ratio = (-0.2 + 0.9 * prog) - (0.4 - 0.5 * prog); // alpha-beta log-ratio proxy
    const calm = tracker.update(ratio);
    if (i === 20) first = calm;
    last = calm;
  }
  console.log(`  AdaptiveNormalizer: start≈${first.toFixed(2)} end≈${last.toFixed(2)}`);
  assert.ok(last > first + 0.15, `value should climb meaningfully (${first.toFixed(2)} -> ${last.toFixed(2)})`);
  console.log('✓ AdaptiveNormalizer tracks a calming session (client-side reimplementation)');
}

// 7) encodeCommand: length-prefix must equal byte length of "cmd\n" (i.e. total-1).
{
  const enc = DSP.encodeCommand('p21');
  assert.strictEqual(enc[0], enc.length - 1, 'length prefix should equal remaining byte count');
  assert.strictEqual(new TextDecoder().decode(enc.subarray(1)), 'p21\n', 'command body should be "p21\\n"');
  console.log('✓ command encoding matches the Muse serial protocol');
}

// 8) Artifact detection: a clean small-amplitude signal should pass; a
//    blink/jaw-sized transient should be flagged.
{
  const n = 256;
  const clean = Array.from({ length: n }, (_, i) => 15 * Math.sin((2 * Math.PI * 10 * i) / 256)); // ~30µV p-p
  assert.strictEqual(DSP.isArtifact(clean), false, 'a clean 30µV p-p signal should not be flagged as artifact');

  const spiky = clean.slice();
  spiky[100] += 250; // a single blink/jaw-sized transient
  assert.strictEqual(DSP.isArtifact(spiky), true, 'a 250µV transient should be flagged as artifact');
  console.log('✓ artifact detection distinguishes clean signal from a blink/jaw-sized transient');
}

/* 8b) A CHANNEL CAN FAIL BY BEING TOO QUIET, and isArtifact cannot see that: it only ever
 *     tested the upper bound. A channel delivering flat zeros has a peak-to-peak of 0,
 *     passed as clean, and then alpha/(alpha+beta+1e-9) evaluated to exactly 0 — so a dead
 *     channel was reported as a real, beta-dominant reading of zero, and that fabricated
 *     floor dragged the Flow axis down and lifted the whole recorded trace with it.
 *     Reported as "the history lines still drift, esp when the sensor reads 0 and
 *     everything pushes up".
 */
{
  const n = 256;
  const dead = new Array(n).fill(0);
  assert.strictEqual(DSP.isArtifact(dead), false,
    'precondition: the artifact test genuinely cannot see a dead channel');
  assert.strictEqual(DSP.isFlat(dead), true, 'a channel of flat zeros is not reading');
  // A stuck DC offset is just as dead as zeros, and just as invisible to a p-p threshold
  // measured about the mean.
  assert.strictEqual(DSP.isFlat(new Array(n).fill(-412.5)), true,
    'a channel stuck at a constant offset is also not reading');
  // Quantisation alone must not trip it: the Muse steps at 0.488µV/LSB, so a real but very
  // quiet channel dithers by about 1µV peak-to-peak.
  const dither = Array.from({ length: n }, (_, i) => (i % 2 ? 0.488 : 0));
  assert.strictEqual(DSP.isFlat(dither), true,
    'one LSB of dither is not a reading either — it is below the 3µV floor');
  // And real EEG must never be called flat. 30µV p-p is resting; 6µV is implausibly quiet
  // and must still pass, because the cost of a false "no signal" is a channel thrown away.
  const quiet = Array.from({ length: n }, (_, i) => 3 * Math.sin((2 * Math.PI * 10 * i) / 256));
  assert.strictEqual(DSP.isFlat(quiet), false,
    `6µV p-p is quiet but real and must not be discarded (p-p ${DSP.peakToPeak(quiet).toFixed(1)}µV)`);
  const clean2 = Array.from({ length: n }, (_, i) => 15 * Math.sin((2 * Math.PI * 10 * i) / 256));
  assert.strictEqual(DSP.isFlat(clean2), false, 'and 30µV p-p certainly must not');
  assert.strictEqual(DSP.isFlat([]), true, 'no samples at all is not a reading');
  console.log(`✓ a silent channel is detected as well as a noisy one`
    + ` (floor ${DSP.FLAT_PTP_UV}µV: 1µV dither out, 6µV signal in)`);
}

/* ==========================================================================
 * INDIVIDUAL ALPHA PEAK
 * ==========================================================================
 * The claim under test is "this is where THIS person's alpha sits", which is worth nothing
 * unless the detector also refuses to answer when there is no peak. So the tests come in
 * pairs: recover a known frequency, and stay silent on noise.
 *
 * The synthetic signal is pink-ish noise (a one-pole filter on white, which gives the ~1/f
 * fall-off real EEG has) with an optional band of five sines spanning ±0.7Hz around a
 * chosen centre — a bump rather than a tone, because a monochromatic line is not what a
 * cortical resonance looks like and the width gate correctly rejects one.
 */
{
  const hz = 256;
  const synth = (seed0, { alphaAmp = 0, centre = 10.3, secs = 180, noise = 8 } = {}) => {
    const n = hz * secs;
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const out = new Float32Array(n);
    const spread = [-0.7, -0.35, 0, 0.35, 0.7];
    const ph = spread.map((_, i) => i * 1.7);   // fixed offsets, so this is reproducible
    let p = 0;
    for (let i = 0; i < n; i++) {
      p = 0.98 * p + rnd() * noise;
      let a = 0;
      spread.forEach((d, k) => { a += Math.sin((2 * Math.PI * (centre + d) * i) / hz + ph[k]); });
      out[i] = p + alphaAmp * a + rnd() * 2;
    }
    return out;
  };
  const peakOf = (sig, opts) => DSP.individualAlphaPeak(DSP.averageSpectrum(sig, hz, opts), opts);

  // 4 SECONDS IS THE POINT, not a preference. 1/windowLength is the frequency resolution,
  // so the live display's 1s windows give 1Hz bins — which cannot represent the answer.
  const sp = DSP.averageSpectrum(synth(13, { alphaAmp: 2.2 }), hz);
  assert.strictEqual(sp.binHz, 0.25, 'a 4s window at 256Hz must give 0.25Hz bins');
  assert.strictEqual(sp.n, 1024, 'and 1024 samples, which the radix-2 FFT takes unpadded');
  assert.strictEqual(DSP.averageSpectrum(synth(13, { alphaAmp: 2.2 }), hz, { windowSec: 1 }).binHz, 1,
    'precondition: a 1s window really does give only 1Hz bins');

  // RECOVERY. Three centres, so this is not one lucky frequency.
  for (const centre of [9.0, 10.3, 12.2]) {
    const pk = peakOf(synth(29, { alphaAmp: 2.2, centre }));
    assert.ok(pk.found, `an obvious ${centre}Hz bump must be found (${pk.reason})`);
    assert.ok(Math.abs(pk.cogHz - centre) < 0.35,
      `and located: wanted ${centre}Hz, got ${pk.cogHz.toFixed(2)}Hz`);
    // The band is the peak ±2Hz, which is what everything downstream uses.
    assert.ok(Math.abs(pk.band[0] - (pk.cogHz - 2)) < 1e-9 || pk.band[0] === 6,
      'the band must be the peak minus 2Hz, or clamped at 6');
    assert.ok(pk.prominence > 2, `and must clear the background (${pk.prominence.toFixed(2)}x)`);
  }

  // The 1/f slope must come out roughly right, or the background being subtracted is not
  // the background. A one-pole filter on white noise is about -2 in log-log.
  const slope = peakOf(synth(31, { alphaAmp: 2.2 })).slope;
  assert.ok(slope < -1.2 && slope > -3,
    `the fitted 1/f slope must be plausible for EEG-like noise (got ${slope.toFixed(2)})`);

  /* NO FALSE PEAKS. Forty realisations of pure noise at each of four durations. This is
     the assertion the whole thing rests on: a detector that names a frequency for noise
     would silently redefine every alpha number downstream to centre on a noise bin. */
  let falsePeaks = 0, tested = 0;
  const reasons = new Set();
  for (const secs of [10, 40, 180, 600]) {
    for (let t = 0; t < 40; t++) {
      const pk = peakOf(synth(t * 977 + 13, { secs }));
      tested++;
      if (pk.found) falsePeaks++; else reasons.add(pk.reason.replace(/[\d.]+/g, 'N'));
    }
  }
  assert.strictEqual(falsePeaks, 0,
    `noise must never produce a peak (${falsePeaks} of ${tested} realisations did)`);
  assert.ok(reasons.size >= 2,
    'and the refusals must be reasoned rather than one blanket rejection: ' + Array.from(reasons).join(' | '));

  // WIDTH IS THE GATE THAT DOES THE WORK, and this records why prominence alone cannot be.
  // Noise reaches 1.77-2.15x on its own; genuinely weak alpha starts around 2.3x. The two
  // distributions nearly touch, so a prominence threshold there would be a coin toss.
  // Widths do not overlap at all: noise never exceeds 0.75Hz, real alpha never under 1.5Hz.
  {
    const noiseStats = [], alphaStats = [];
    for (let t = 0; t < 12; t++) {
      noiseStats.push(peakOf(synth(t * 613 + 5, { secs: 180 }), { minProminence: 0, minWidthHz: 0, minWindows: 0 }));
      alphaStats.push(peakOf(synth(t * 613 + 5, { alphaAmp: 0.7 }), { minProminence: 0, minWidthHz: 0, minWindows: 0 }));
    }
    const w = (a) => a.map((x) => x.widthHz || 0);
    const worstNoise = Math.max(...w(noiseStats)), bestAlphaWidth = Math.min(...w(alphaStats));
    assert.ok(worstNoise < DSP.IAF_MIN_WIDTH_HZ && bestAlphaWidth >= DSP.IAF_MIN_WIDTH_HZ,
      `the width threshold must sit between noise (max ${worstNoise}Hz) and weak alpha`
      + ` (min ${bestAlphaWidth}Hz); it is ${DSP.IAF_MIN_WIDTH_HZ}Hz`);
    const promNoise = Math.max(...noiseStats.map((x) => x.prominence));
    const promAlpha = Math.min(...alphaStats.map((x) => x.prominence));
    assert.ok(promAlpha / promNoise < 2,
      `recording the reason width is the gate: noise reaches ${promNoise.toFixed(2)}x and weak`
      + ` alpha only ${promAlpha.toFixed(2)}x, so prominence barely separates them`);
  }

  // A PEAK OUTSIDE THE SEARCH RANGE must be refused, not reported as the nearest edge.
  for (const centre of [5.5, 15.5]) {
    const pk = peakOf(synth(41, { alphaAmp: 3.0, centre }));
    assert.ok(!pk.found, `a ${centre}Hz bump is not alpha and must not be reported as one`
      + ` (got ${pk.found ? pk.cogHz.toFixed(2) + 'Hz' : ''})`);
  }

  // WEAK BUT REAL must still be found, or the gates are just a refusal machine.
  const weak = peakOf(synth(53, { alphaAmp: 0.7 }));
  assert.ok(weak.found, `weak but real alpha must still be found (${weak.reason})`);
  assert.ok(Math.abs(weak.cogHz - 10.3) < 0.6, `within reason (${weak.cogHz.toFixed(2)}Hz)`);

  // A DEAD CHANNEL yields no spectrum at all, and says so rather than dividing by zero.
  const dead = peakOf(new Float32Array(hz * 120));
  assert.ok(!dead.found && /flat|artifact/i.test(dead.reason),
    `a dead channel must refuse with a reason about the signal (got "${dead.reason}")`);

  /* PER CHANNEL, then the best of them — alpha is posterior, so on this headband the ear
     channels carry it and the forehead pair barely hint at it. The estimate is a property
     of the person, so taking the most prominent channel is right; keeping the table is what
     makes a frontal-only "peak" visible for what it is. */
  {
    const eeg = [
      synth(61, { alphaAmp: 2.4, centre: 10.6 }),   // TP9: strong
      synth(62, { alphaAmp: 0.15 }),                // AF7: essentially none
      synth(63, { alphaAmp: 0.15 }),                // AF8: essentially none
      synth(64, { alphaAmp: 1.2, centre: 10.6 }),   // TP10: present
    ];
    const out = DSP.alphaPeakByChannel(eeg, hz);
    assert.strictEqual(out.fallback, false, 'a session with real alpha must not fall back');
    assert.ok(out.bestName === 'TP9' || out.bestName === 'TP10',
      `the strongest channel must win, not the first (got ${out.bestName})`);
    assert.ok(Math.abs(out.freqHz - 10.6) < 0.35, `at about 10.6Hz (got ${out.freqHz.toFixed(2)})`);
    assert.strictEqual(out.channels.length, 4, 'every channel must be reported, found or not');
    assert.ok(out.channels.filter((c) => c.found).length >= 2, 'both ear channels should show it');

    // AND THE FALLBACK IS LABELLED. Four channels of noise must produce the fixed band with
    // fallback set — an individual band and a population band are different claims.
    const none = DSP.alphaPeakByChannel([0, 1, 2, 3].map((k) => synth(70 + k, { secs: 180 })), hz);
    assert.strictEqual(none.fallback, true, 'no peak anywhere must be reported as a fallback');
    assert.deepStrictEqual(none.band, DSP.BANDS.alpha, 'and must use the fixed 8-13Hz band');
    assert.strictEqual(none.freqHz, null, 'with no frequency claimed at all');
    assert.ok(none.reason, 'and a reason to show');
  }

  console.log(`✓ the individual alpha peak is found (${peakOf(synth(29, { alphaAmp: 2.2 })).cogHz.toFixed(2)}Hz`
    + ` for a 10.3Hz bump), refused on ${tested} noise realisations, and labelled when it falls back`);
}

/* 8d) The 4-second analysis windows. Non-overlapping is a statistical requirement, not a
 *     preference: these rows become the observations the lab correlates and permutes, and
 *     overlapping windows share samples, so the effective count would be smaller than the
 *     row count and every p-value optimistic by an unknown factor.
 */
{
  const hz = 256, secs = 40;
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const n = hz * secs;
  const eeg = [0, 1, 2, 3].map((k) => {
    const a = new Float32Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) { p = 0.98 * p + rnd() * 8; a[i] = p + (k < 2 ? 2.2 : 0.4) * Math.sin((2 * Math.PI * 10.3 * i) / hz); }
    return a;
  });
  eeg[3].fill(0);                                   // one dead channel

  const bs = DSP.bandSeries(eeg, hz, { alphaBand: [8.25, 12.25] });
  assert.strictEqual(bs.windowSec, 4, 'the lab window is 4 seconds');
  assert.strictEqual(bs.binHz, 0.25, 'giving 0.25Hz resolution');
  assert.strictEqual(bs.rows.length, secs / 4,
    `non-overlapping means ${secs / 4} rows for ${secs}s, not ${secs / 2} (got ${bs.rows.length})`);
  // Times must be the window starts, four seconds apart.
  assert.deepStrictEqual(bs.rows.slice(0, 3).map((r) => r.tSec), [0, 4, 8]);
  // The dead channel is NULL in every window, not a number. Same rule as the live display.
  assert.ok(bs.rows.every((r) => r.channels[3] === null),
    'a dead channel must yield null per window, never a fabricated power');
  assert.ok(bs.rows.every((r) => r.channels[0] && r.channels[0].alpha > 0),
    'and a live channel must yield real power');
  // The alpha band actually used is the caller's, which is the whole point of measuring it.
  const wide = DSP.bandSeries(eeg, hz, { alphaBand: [8, 13] });
  assert.notStrictEqual(wide.rows[0].channels[0].alpha, bs.rows[0].channels[0].alpha,
    'a different alpha band must produce a different alpha power, or the band is ignored');
  assert.deepStrictEqual(bs.alphaBand, [8.25, 12.25], 'and the band used is reported back');
  console.log(`✓ 4-second lab windows: ${bs.rows.length} non-overlapping rows for ${secs}s,`
    + ` ${bs.binHz}Hz bins, dead channels null`);
}

/* 8e) THE STREAMING ACCUMULATOR MUST GIVE THE SAME ANSWER AS THE BATCH ONE.
 *
 *     The app cannot call averageSpectrum: raw EEG goes straight to storage and the
 *     in-memory buffer is bounded to two seconds, so measuring a peak from memory would mean
 *     keeping a second full copy of the sit or reading it all back on the summary screen.
 *     Neither is needed, because an average does not need its inputs kept — but only if the
 *     incremental version really is the same computation. That is what this asserts, fed in
 *     12-sample chunks because that is the Muse's packet size and a ring buffer is exactly
 *     where an off-by-one hides.
 */
{
  const hz = 256, secs = 180, n = hz * secs;
  let seed = 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const sig = new Float32Array(n);
  const spread = [-0.7, -0.35, 0, 0.35, 0.7];
  const ph = spread.map((_, i) => i * 1.7);
  let p = 0;
  for (let i = 0; i < n; i++) {
    p = 0.98 * p + rnd() * 8;
    let a = 0;
    spread.forEach((d, k) => { a += Math.sin((2 * Math.PI * (10.3 + d) * i) / hz + ph[k]); });
    sig[i] = p + 2.2 * a + rnd() * 2;
  }
  const batch = DSP.averageSpectrum(sig, hz);
  const acc = DSP.SpectrumAccumulator(hz);
  for (let i = 0; i < n; i += DSP.EEG_SAMPLES_PER_PACKET) {
    acc.push(sig.subarray(i, Math.min(n, i + DSP.EEG_SAMPLES_PER_PACKET)));
  }
  const live = acc.spectrum();
  assert.strictEqual(live.windows, batch.windows,
    `the same number of windows must be folded in (${live.windows} vs ${batch.windows})`);
  const lp = DSP.individualAlphaPeak(live), bp = DSP.individualAlphaPeak(batch);
  assert.ok(Math.abs(lp.cogHz - bp.cogHz) < 1e-9,
    `streaming and batch must agree exactly (${lp.cogHz} vs ${bp.cogHz})`);
  assert.ok(Math.abs(lp.prominence - bp.prominence) < 1e-9,
    `including the prominence (${lp.prominence} vs ${bp.prominence})`);

  // Before there is enough signal, it must refuse rather than answer from a half-filled ring.
  const fresh = DSP.SpectrumAccumulator(hz);
  fresh.push(sig.subarray(0, hz));                    // one second
  const early = fresh.spectrum();
  assert.strictEqual(early.power, null, 'a ring with less than one window in it has no spectrum');
  assert.strictEqual(early.windows, 0);
  assert.ok(early.reason, 'and says why');
  assert.strictEqual(DSP.individualAlphaPeak(early).found, false,
    'so no peak can be claimed from it');

  // reset() must genuinely clear it — a new sit is a new estimate, and carrying yesterday's
  // windows in would blur the thing being measured.
  acc.reset();
  assert.strictEqual(acc.spectrum().windows, 0, 'reset must empty the accumulator');

  // Memory is fixed: a two-hour sit must cost no more than a three-minute one. Asserted via
  // the window count growing while nothing else does — the ring and the spectrum are
  // allocated once, at construction.
  const long = DSP.SpectrumAccumulator(hz);
  for (let rep = 0; rep < 4; rep++) for (let i = 0; i < n; i += 12) long.push(sig.subarray(i, i + 12));
  assert.ok(long.spectrum().windows > batch.windows * 3,
    'a longer sit must fold in more windows, not silently stop accumulating');
  assert.strictEqual(long.n, batch.n, 'while the window size stays fixed');

  console.log(`✓ the streaming accumulator matches the batch spectrum exactly`
    + ` (${live.windows} windows, peak ${lp.cogHz.toFixed(4)}Hz both ways) and holds fixed memory`);
}

// 9) AdaptiveNormalizer freezes exactly (no drift) when fed a null value, so
//    an artifact-flagged window can be skipped without disturbing the display.
{
  const tracker = new DSP.AdaptiveNormalizer();
  for (let i = 0; i < 50; i++) tracker.update(0.6); // settle to some non-default value
  const held = tracker.value;
  for (let i = 0; i < 20; i++) {
    const out = tracker.update(null);
    assert.strictEqual(out, held, 'value must not drift while input is null (artifact frozen)');
  }
  console.log('✓ AdaptiveNormalizer holds steady through a run of artifact-flagged (null) windows');
}

// 10) 24-bit decode round-trip.
{
  const v0 = 0x123456;
  const decoded = DSP.decode24Bit(new Uint8Array([(v0 >> 16) & 0xff, (v0 >> 8) & 0xff, v0 & 0xff]));
  assert.deepStrictEqual(decoded, [v0], `decode24Bit roundtrip failed: got ${decoded}`);
  console.log('✓ 24-bit PPG sample decode round-trips correctly');
}

// 11) Beat detection + breathing-period estimation on a synthetic PPG
//     signal: a heart-rate carrier whose instantaneous frequency is
//     phase-modulated by a known respiration rate (respiratory sinus
//     arrhythmia) — the pipeline should recover a period close to the
//     true breathing period from nothing but the raw waveform.
{
  const fs = DSP.PPG_FREQUENCY; // 64Hz
  const hrHz = 1.2;              // 72 bpm carrier
  const modDepthHz = 0.15;       // heart rate swings ±0.15Hz with breathing
  const trueRespHz = 0.2;        // 12 breaths/min -> 5s true period
  const durationSec = 90;
  const n = Math.round(durationSec * fs);
  const samples = new Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const instHr = hrHz + modDepthHz * Math.sin(2 * Math.PI * trueRespHz * t);
    phase += (2 * Math.PI * instHr) / fs;
    const raw = Math.sin(phase);
    const pulseShape = Math.max(0, raw) ** 2; // peaked, PPG-like pulse lobes
    samples[i] = pulseShape + 0.02 * (Math.random() - 0.5);
  }

  const beats = DSP.detectBeats(samples, fs);
  const expectedBeats = durationSec * hrHz;
  console.log(`  detected ${beats.length} beats (~${expectedBeats.toFixed(0)} expected for ${hrHz * 60}bpm over ${durationSec}s)`);
  assert.ok(Math.abs(beats.length - expectedBeats) < expectedBeats * 0.25,
    `beat count should be roughly right (got ${beats.length}, expected ~${expectedBeats.toFixed(0)})`);

  const period = DSP.estimateBreathingPeriod(beats);
  const truePeriod = 1 / trueRespHz;
  console.log(`  estimated breathing period ${period.toFixed(2)}s (true period ${truePeriod.toFixed(2)}s)`);
  assert.ok(period !== null, 'should produce a breathing-period estimate with 90s of clean synthetic data');
  assert.ok(Math.abs(period - truePeriod) < truePeriod * 0.3,
    `estimated period should be close to the true respiration period (got ${period.toFixed(2)}s, true ${truePeriod.toFixed(2)}s)`);
  console.log('✓ breathing period recovered from synthetic PPG via respiratory sinus arrhythmia');
}

// 12) Not enough data yet -> null, not a bogus number.
{
  assert.strictEqual(DSP.estimateBreathingPeriod([0, 0.8, 1.6]), null, 'too few beats should return null, not guess');
  console.log('✓ breathing estimate declines to guess when there is not enough data');
}

// 13) SpikeDetector: this is a regression test for a real bug — comparing
//     each reading to the raw previous tick instead of a slow baseline
//     meant ordinary measurement jitter alone triggered "spike" on almost
//     every tick (a wall of white/black static, live on real hardware).
//     Noisy-but-stationary data (oscillating within the threshold) should
//     essentially never spike; a genuine sustained jump should.
{
  const det = new DSP.SpikeDetector({ threshold: 0.16, baselineRate: 0.08, decay: 0.85 });
  let spikesWhileStationary = 0;
  for (let i = 0; i < 200; i++) {
    const jitter = 0.5 + 0.06 * Math.sin(i * 1.3); // bounded well under the 0.16 threshold
    const spike = det.update(jitter);
    if (spike >= 0.999) spikesWhileStationary++; // only true immediately after a fresh trigger
  }
  assert.strictEqual(spikesWhileStationary, 0,
    `stationary jitter under the threshold should never spike (got ${spikesWhileStationary} triggers) — ` +
    `this is exactly the bug where tick-to-tick noise alone caused constant spiking`);
  console.log('✓ SpikeDetector ignores stationary jitter that stays under threshold');
}
{
  const det = new DSP.SpikeDetector({ threshold: 0.16, baselineRate: 0.08, decay: 0.85 });
  for (let i = 0; i < 40; i++) det.update(0.3); // let the baseline settle at 0.3
  const beforeJump = det.spike;
  const atJump = det.update(0.7); // a real, sustained 0.4 shift — well over threshold
  assert.ok(beforeJump < 0.5, 'should be quiet before the jump');
  assert.ok(atJump > 0.9, `a genuine sustained shift should trigger a spike (got ${atJump.toFixed(2)})`);
  console.log('✓ SpikeDetector catches a genuine sustained shift away from baseline');
}

// 14) ActivityTracker measures DEPARTURE FROM YOUR OWN BASELINE, not an
//     absolute scale — the same design choice as the calm score, because
//     there is no population-level "correct" beta level. So the meaningful
//     test is a WITHIN-session change: sit steady, then start churning, and
//     activity should climb. (Comparing two separate sessions would prove
//     nothing: a constantly-busy signal is its own baseline and normalises
//     back toward the middle, which is intended behaviour, not a bug.)
{
  const t = new DSP.ActivityTracker();
  for (let i = 0; i < 240; i++) {
    t.update({ betaLog: -1.0 + 0.01 * Math.sin(i / 9), ratio: 0.8 + 0.01 * Math.sin(i / 7), spiked: false });
  }
  const settled = t.value;
  for (let i = 0; i < 80; i++) {
    t.update({ betaLog: 1.2 + 0.5 * Math.sin(i / 3), ratio: 0.6 * Math.sin(i / 2.1) + 0.5 * Math.sin(i / 1.3), spiked: i % 20 === 0 });
  }
  const churning = t.value;
  console.log(`  settled≈${settled.toFixed(2)} -> churning≈${churning.toFixed(2)}`);
  assert.ok(churning > settled + 0.15,
    `activity should climb clearly when the mind starts churning (${settled.toFixed(2)} -> ${churning.toFixed(2)})`);
  assert.ok(settled >= 0 && settled <= 1 && churning >= 0 && churning <= 1, 'activity must stay within 0..1');

  // And it should come back down when things settle again.
  for (let i = 0; i < 200; i++) {
    t.update({ betaLog: -1.0 + 0.01 * Math.sin(i / 9), ratio: 0.8 + 0.01 * Math.sin(i / 7), spiked: false });
  }
  assert.ok(t.value < churning - 0.1, `activity should fall again when the mind settles (stayed at ${t.value.toFixed(2)})`);
  console.log('✓ ActivityTracker rises when the mind churns and falls when it settles');
}

// 15) Movement artifact must NOT be read as thinking. This is the honesty
//     boundary the whole metric depends on: `noise` is a measurement problem,
//     activity is a signal about the person. An artifact-flagged tick must
//     hold the value and must not let a spike through.
{
  const t = new DSP.ActivityTracker();
  for (let i = 0; i < 100; i++) t.update({ betaLog: -1, ratio: 0.5, spiked: false });
  const settled = t.value;
  // Now slam it with huge artifact-flagged values, as a jaw clench would.
  for (let i = 0; i < 60; i++) {
    const out = t.update({ betaLog: 40, ratio: 25, artifact: true, spiked: true });
    assert.strictEqual(out, settled, 'activity must not move at all on artifact-flagged ticks');
  }
  assert.strictEqual(t.value, settled, 'and must be unchanged afterwards');
  console.log('✓ movement artifact never registers as mental activity');
}

// 16) ActivityTracker survives being fed nothing useful (all nulls) without
//     producing NaN — the render path multiplies this into geometry.
{
  const t = new DSP.ActivityTracker();
  for (let i = 0; i < 50; i++) t.update({});
  assert.ok(Number.isFinite(t.value), `value must stay finite with no inputs (got ${t.value})`);
  assert.ok(t.value >= 0 && t.value <= 1, 'and stay in range');
  console.log('✓ ActivityTracker stays finite and in-range with no usable input');
}

// 17) Blink vs jaw discrimination — these are the only two metrics in the app
//     presented as MEASURED rather than inferred, so they need to actually
//     discriminate. Synthetic signals with known character.
{
  const fs = DSP.EEG_FREQUENCY, n = 256;
  const rest = (i) => 12 * Math.sin((2 * Math.PI * 10 * i) / fs); // calm ~24uV p-p alpha

  const clean = { a: [], b: [] };
  for (let i = 0; i < n; i++) { clean.a.push(rest(i)); clean.b.push(rest(i) + 3); }
  const rc = DSP.classifyArtifact(clean.a, clean.b, fs);
  assert.ok(rc.blink < 0.05 && rc.jaw < 0.05, `clean signal must claim neither (blink ${rc.blink}, jaw ${rc.jaw})`);

  // A blink: large, slow (~3Hz), and the SAME on both forehead sensors.
  const bl = { a: [], b: [] };
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const d = (t > 0.3 && t < 0.65) ? 200 * Math.sin((Math.PI * (t - 0.3)) / 0.35) : 0;
    bl.a.push(rest(i) + d); bl.b.push(rest(i) + d * 0.95);
  }
  const rb = DSP.classifyArtifact(bl.a, bl.b, fs);
  assert.ok(rb.blink > 0.3, `a blink-shaped event should register as a blink (got ${rb.blink.toFixed(2)})`);
  assert.ok(rb.blink > rb.jaw * 3, `and must not be mistaken for jaw (blink ${rb.blink.toFixed(2)} vs jaw ${rb.jaw.toFixed(2)})`);

  // Jaw/muscle: high-frequency burst of comparable amplitude.
  const jw = { a: [], b: [] };
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const e = (t > 0.2 && t < 0.8) ? 90 * Math.sin((2 * Math.PI * 40 * i) / fs) : 0;
    jw.a.push(rest(i) + e); jw.b.push(rest(i) + e * 0.8);
  }
  const rj = DSP.classifyArtifact(jw.a, jw.b, fs);
  assert.ok(rj.jaw > 0.3, `a high-frequency burst should register as jaw/muscle (got ${rj.jaw.toFixed(2)})`);
  assert.ok(rj.jaw > rj.blink * 3, `and must not be mistaken for a blink (jaw ${rj.jaw.toFixed(2)} vs blink ${rj.blink.toFixed(2)})`);
  console.log('✓ blink and jaw are told apart from each other and from clean signal');
}

// 18) A large slow deflection on only ONE side is not a blink. Blinks come from
//     a common frontal source and appear on both sensors together; a one-sided
//     drift is far more likely a loose electrode.
{
  const fs = DSP.EEG_FREQUENCY, n = 256;
  const a = [], b = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const d = (t > 0.3 && t < 0.65) ? 220 * Math.sin((Math.PI * (t - 0.3)) / 0.35) : 0;
    a.push(12 * Math.sin((2 * Math.PI * 10 * i) / fs) + d);   // only channel A
    b.push(12 * Math.sin((2 * Math.PI * 9 * i) / fs));
  }
  const r = DSP.classifyArtifact(a, b, fs);
  assert.ok(r.blink < 0.25, `a one-sided deflection should not be confidently called a blink (got ${r.blink.toFixed(2)})`);
  console.log('✓ a one-sided deflection is not claimed as a blink');
}

// 19) pearson(): correct on the textbook cases, and safe on degenerate input.
{
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.ok(Math.abs(DSP.pearson(x, x) - 1) < 1e-9, 'identical series correlate at +1');
  assert.ok(Math.abs(DSP.pearson(x, x.map((v) => -v)) + 1) < 1e-9, 'inverted series correlate at -1');
  assert.strictEqual(DSP.pearson([1, 1, 1, 1, 1, 1, 1, 1], x), 0, 'a flat series has no correlation, not NaN');
  assert.strictEqual(DSP.pearson([1, 2], [1, 2]), 0, 'too-short input returns 0 rather than a bogus 1');
  console.log('✓ pearson is correct and degrades safely');
}

console.log('\nAll DSP tests passed.');
