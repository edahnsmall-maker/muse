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
