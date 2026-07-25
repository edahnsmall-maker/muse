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

console.log('\nAll DSP tests passed.');
