/*
 * Polar H10 protocol + HRV math.
 *
 * The parsing is worth testing hard for one reason: the Heart Rate Measurement
 * characteristic is variable-length, driven by a flags byte, and getting an
 * offset wrong produces plausible-looking nonsense rather than an error. A wrong
 * RR interval doesn't crash anything — it just quietly reports the wrong HRV.
 */
const assert = require('assert');
const Polar = require('./public/polar.js');

// Build a Heart Rate Measurement packet the way the strap would.
function hrmPacket({ hr = 60, rr = [], hr16 = false, energy = null, contact = null }) {
  let flags = 0;
  if (hr16) flags |= 0x01;
  if (contact != null) { flags |= 0x02; if (contact) flags |= 0x04; }
  if (energy != null) flags |= 0x08;
  if (rr.length) flags |= 0x10;

  const bytes = [flags];
  if (hr16) { bytes.push(hr & 0xff, (hr >> 8) & 0xff); } else { bytes.push(hr & 0xff); }
  if (energy != null) bytes.push(energy & 0xff, (energy >> 8) & 0xff);
  for (const ms of rr) {
    const units = Math.round(ms * 1024 / 1000);
    bytes.push(units & 0xff, (units >> 8) & 0xff);
  }
  return new DataView(new Uint8Array(bytes).buffer);
}

// 1) uint8 heart rate, no extras.
{
  const p = Polar.parseHeartRateMeasurement(hrmPacket({ hr: 58 }));
  assert.strictEqual(p.hr, 58);
  assert.deepStrictEqual(p.rr, []);
  assert.strictEqual(p.contact, null, 'contact unknown when the strap does not report it');
  console.log('✓ parses a plain uint8 heart rate');
}

// 2) uint16 heart rate — the flag changes every following offset.
{
  const p = Polar.parseHeartRateMeasurement(hrmPacket({ hr: 300, hr16: true }));
  assert.strictEqual(p.hr, 300, 'a 16-bit HR must be read as 16-bit');
  console.log('✓ parses a uint16 heart rate');
}

// 3) RR intervals, converted from 1/1024s units to ms.
{
  const p = Polar.parseHeartRateMeasurement(hrmPacket({ hr: 60, rr: [1000, 980] }));
  assert.strictEqual(p.rr.length, 2, 'both intervals in one notification must be read');
  assert.ok(Math.abs(p.rr[0] - 1000) < 1.5, `expected ~1000ms, got ${p.rr[0]}`);
  assert.ok(Math.abs(p.rr[1] - 980) < 1.5, `expected ~980ms, got ${p.rr[1]}`);
  console.log('✓ parses RR intervals and converts 1/1024s units to ms');
}

// 4) The energy-expended field must be SKIPPED, not read as an RR interval.
//    This is the offset bug that would produce plausible garbage.
{
  const withEnergy = Polar.parseHeartRateMeasurement(
    hrmPacket({ hr: 60, energy: 1234, rr: [1000] }));
  assert.strictEqual(withEnergy.rr.length, 1, 'energy field must not be mistaken for an interval');
  assert.ok(Math.abs(withEnergy.rr[0] - 1000) < 1.5,
    `energy field must be skipped cleanly, got ${withEnergy.rr[0]}`);

  // Same packet without the energy field must give the same RR — proving the
  // offset is genuinely driven by the flag rather than a fixed guess.
  const without = Polar.parseHeartRateMeasurement(hrmPacket({ hr: 60, rr: [1000] }));
  assert.ok(Math.abs(without.rr[0] - withEnergy.rr[0]) < 0.01,
    'RR must be identical whether or not the energy field is present');
  console.log('✓ skips the energy-expended field so RR offsets stay correct');
}

// 5) Contact status: supported-and-detected, supported-and-not, unsupported.
{
  assert.strictEqual(Polar.parseHeartRateMeasurement(hrmPacket({ contact: true })).contact, true);
  assert.strictEqual(Polar.parseHeartRateMeasurement(hrmPacket({ contact: false })).contact, false);
  assert.strictEqual(Polar.parseHeartRateMeasurement(hrmPacket({})).contact, null,
    'unknown and "not touching skin" must stay distinguishable');
  console.log('✓ distinguishes contact detected / not detected / not reported');
}

// 6) Truncated and empty buffers must not throw or invent a reading.
{
  assert.deepStrictEqual(Polar.parseHeartRateMeasurement(null), { hr: null, rr: [], contact: null });
  assert.deepStrictEqual(
    Polar.parseHeartRateMeasurement(new DataView(new Uint8Array([0x00]).buffer)),
    { hr: null, rr: [], contact: null }, 'a 1-byte packet has no HR to read');
  // Flags claim a 16-bit HR but only one byte follows.
  const truncated = Polar.parseHeartRateMeasurement(new DataView(new Uint8Array([0x01, 0x3c]).buffer));
  assert.strictEqual(truncated.hr, null, 'a truncated 16-bit HR must read as no data, not garbage');
  console.log('✓ truncated packets produce no reading rather than a fabricated one');
}

// 7) RMSSD against a hand-computed value.
{
  assert.strictEqual(Polar.rmssd([]), null, 'no data -> null');
  assert.strictEqual(Polar.rmssd([1000]), null, 'one interval has no successive difference');
  // Differences: +20, -20, +20 -> squares 400,400,400 -> mean 400 -> sqrt 20
  const v = Polar.rmssd([1000, 1020, 1000, 1020]);
  assert.ok(Math.abs(v - 20) < 1e-9, `expected exactly 20, got ${v}`);
  // A perfectly regular series has zero variability.
  assert.strictEqual(Polar.rmssd([900, 900, 900]), 0);
  console.log('✓ RMSSD matches a hand-computed value');
}

// 8) SDNN, mean, and bpm.
{
  assert.strictEqual(Polar.sdnn([1000]), null);
  assert.ok(Math.abs(Polar.sdnn([1000, 1000, 1000]) - 0) < 1e-9);
  assert.ok(Math.abs(Polar.meanRR([900, 1100]) - 1000) < 1e-9);
  assert.ok(Math.abs(Polar.bpmFromRR([1000, 1000]) - 60) < 1e-9, '1000ms intervals are 60bpm');
  assert.ok(Math.abs(Polar.bpmFromRR([500]) - 120) < 1e-9, '500ms intervals are 120bpm');
  assert.strictEqual(Polar.bpmFromRR([]), null);
  console.log('✓ SDNN, mean interval, and bpm conversion are correct');
}

// 9) THE IMPORTANT ONE. A single missed beat must be rejected, because RMSSD
//    squares successive differences — so one doubled interval contributes two
//    enormous terms and would read as a sudden flood of parasympathetic calm at
//    exactly the moment the strap slipped.
{
  const buf = new Polar.RrBuffer({ windowSec: 60 });
  const clean = [];
  for (let i = 0; i < 30; i++) clean.push(1000 + (i % 2 ? 15 : -15));
  clean.forEach((rr) => buf.push(rr));
  const before = Polar.rmssd(buf.values());

  // A missed beat: one interval about twice as long.
  const accepted = buf.push(2000);
  assert.strictEqual(accepted, false, 'a doubled interval must be rejected');
  const after = Polar.rmssd(buf.values());
  assert.ok(Math.abs(after - before) < 1e-9, 'a rejected beat must not change RMSSD at all');

  // Show what would have happened without rejection, so the test documents the
  // magnitude of the bug it prevents.
  const unfiltered = Polar.rmssd(clean.concat([2000]));
  assert.ok(unfiltered > before * 2,
    `an unrejected missed beat should have inflated RMSSD a lot (${before.toFixed(1)} -> ${unfiltered.toFixed(1)})`);
  console.log(`✓ a missed beat is rejected (would have inflated RMSSD ${before.toFixed(1)}ms -> ${unfiltered.toFixed(1)}ms)`);
}

// 10) Out-of-range intervals rejected; reject rate reported.
{
  const buf = new Polar.RrBuffer();
  assert.strictEqual(buf.push(1000), true);
  assert.strictEqual(buf.push(50), false, '50ms is 1200bpm — impossible');
  assert.strictEqual(buf.push(5000), false, '5000ms is 12bpm — implausible');
  assert.strictEqual(buf.push(NaN), false);
  assert.strictEqual(buf.push(null), false);
  assert.strictEqual(buf.length, 1, 'only the plausible interval was kept');
  assert.ok(buf.rejectRate() > 0.7, `reject rate should be high here (got ${buf.rejectRate()})`);
  console.log('✓ implausible intervals are rejected and the reject rate is reported');
}

// 11) The window is trimmed by DURATION, not by count — at 50bpm a fixed count
//     spans twice the time it does at 100bpm.
{
  const slow = new Polar.RrBuffer({ windowSec: 10 });
  for (let i = 0; i < 40; i++) slow.push(1200);   // 50bpm
  const fast = new Polar.RrBuffer({ windowSec: 10 });
  for (let i = 0; i < 40; i++) fast.push(600);    // 100bpm
  assert.ok(slow.elapsedMs <= 10000 + 1200, `slow window should hold ~10s (got ${slow.elapsedMs}ms)`);
  assert.ok(fast.elapsedMs <= 10000 + 600, `fast window should hold ~10s (got ${fast.elapsedMs}ms)`);
  assert.ok(fast.length > slow.length, 'the same duration means more beats at a faster heart rate');
  console.log('✓ the rolling window is bounded by time, not beat count');
}

// 12) beatTimes() feeds DSP.estimateBreathingPeriod — recovering real breathing
//     from RSA. ECG-grade beat timing is much cleaner than temple PPG, so this
//     is the better source for the same computation.
{
  const DSP = require('./public/dsp.js');
  const buf = new Polar.RrBuffer({ windowSec: 120 });
  // 60bpm carrier with a 5-second breathing modulation embedded in the timing.
  const truePeriod = 5.0;
  let t = 0;
  for (let i = 0; i < 120; i++) {
    const rr = 1000 + 60 * Math.sin((2 * Math.PI * t) / truePeriod);
    buf.push(rr);
    t += rr / 1000;
  }
  const times = buf.beatTimes();
  assert.ok(times.length > 60, 'should have accumulated plenty of beats');
  assert.ok(times.every((v, i) => i === 0 || v > times[i - 1]), 'beat times must increase');
  const est = DSP.estimateBreathingPeriod(times);
  assert.ok(est != null, 'should recover a breathing period from RSA');
  assert.ok(Math.abs(est - truePeriod) < 1.0,
    `should recover the embedded ${truePeriod}s breathing period (got ${est.toFixed(2)}s)`);
  console.log(`✓ breathing recovered from RR intervals via RSA: ${est.toFixed(2)}s for a true ${truePeriod}s`);
}

// 13) SteadinessTracker: reports null until it has enough, then distinguishes a
//     steady HRV from a lurching one. Steadiness is a different claim from
//     level — a person can have high HRV and still be reacting to everything.
{
  const t = new Polar.SteadinessTracker();
  assert.strictEqual(t.update(40), null, 'must not guess from one sample');
  assert.strictEqual(t.update(41), null);
  assert.strictEqual(t.update(39), null);
  const steady = t.update(40);
  assert.ok(steady != null && steady > 0.8, `a steady HRV should read high (got ${steady})`);

  const lurching = new Polar.SteadinessTracker();
  [20, 90, 25, 85, 30, 95].forEach((v) => lurching.update(v));
  const lv = lurching.value();
  assert.ok(lv != null && lv < 0.4, `a lurching HRV should read low (got ${lv})`);

  // Relative, not absolute: a person with high resting HRV who is steady must
  // not be penalised for the level.
  const highButSteady = new Polar.SteadinessTracker();
  [140, 143, 138, 141, 139, 142].forEach((v) => highButSteady.update(v));
  assert.ok(highButSteady.value() > 0.8,
    `steadiness must be relative to the person, not their absolute HRV (got ${highButSteady.value()})`);
  assert.ok(t.update(NaN) != null, 'garbage input must not destroy the running value');
  console.log('✓ SteadinessTracker needs data, is relative, and separates steady from lurching');
}

// 14) Breath PHASE from RSA. This is the new capability: not just how fast you
//     are breathing but WHERE in the breath you are, so a bar can swell on the
//     inhale and contract on the exhale.
{
  // Build an RR series whose timing is modulated by a known breathing phase, so
  // the recovered phase can be checked against ground truth.
  const period = 5.0;
  const rrs = [];
  const truePhaseAt = [];   // 0..1 through the breath cycle, at each beat
  let t = 0;
  for (let i = 0; i < 200; i++) {
    // Heart rate RISES on the inhale, so RR (the interval) SHORTENS. The sign
    // matters: getting it backwards would render every inhale as an exhale.
    const phase = (t % period) / period;          // 0 = start of inhale
    const rr = 1000 - 70 * Math.sin(2 * Math.PI * phase);
    rrs.push(rr);
    truePhaseAt.push(phase);
    t += rr / 1000;
  }

  const sig = Polar.breathSignal(rrs);
  assert.ok(sig && sig.length > 40, 'should produce a respiratory waveform');
  assert.ok(Math.min(...sig) < -0.5 && Math.max(...sig) > 0.5,
    `the waveform should use most of its range (got ${Math.min(...sig).toFixed(2)}..${Math.max(...sig).toFixed(2)})`);

  // It must be a smooth oscillation at roughly the breathing rate, not noise:
  // count zero crossings and compare with the expected number of half-cycles.
  let crossings = 0;
  for (let i = 1; i < sig.length; i++) if ((sig[i] < 0) !== (sig[i - 1] < 0)) crossings++;
  const spanSec = sig.length / 4;                  // default 4Hz grid
  const expected = (2 * spanSec) / period;
  assert.ok(Math.abs(crossings - expected) < expected * 0.4,
    `should oscillate at about the breathing rate (${crossings} crossings, expected ~${expected.toFixed(0)})`);

  // MEASURE the lag rather than assuming it. Cross-correlate the recovered
  // waveform against the true inhale/exhale waveform and find the best shift.
  const hz = 4;
  const trueWave = [];
  for (let i = 0; i < sig.length; i++) {
    // The grid starts at the first beat time; reconstruct true phase on it.
    const tt = (rrs[0] / 1000) + i / hz;
    trueWave.push(Math.sin(2 * Math.PI * ((tt % period) / period)));
  }
  let bestShift = 0, bestCorr = -Infinity;
  for (let shift = 0; shift < Math.round(period * hz); shift++) {
    let c = 0, n = 0;
    for (let i = shift; i < sig.length; i++) { c += sig[i] * trueWave[i - shift]; n++; }
    if (n > 20 && c / n > bestCorr) { bestCorr = c / n; bestShift = shift; }
  }
  const lagSec = bestShift / hz;
  assert.ok(bestCorr > 0.2,
    `the recovered waveform must actually correlate with the real breath (best ${bestCorr.toFixed(2)})`);
  // A fraction of a cycle is expected and acceptable; a lag near a full cycle
  // would mean inhale and exhale are effectively swapped.
  assert.ok(lagSec < period * 0.45,
    `lag must stay well under half a cycle or inhale reads as exhale (measured ${lagSec.toFixed(2)}s of ${period}s)`);
  console.log(`✓ breath phase recovered from RSA, correlation ${bestCorr.toFixed(2)}, measured lag ${lagSec.toFixed(2)}s of a ${period}s cycle`);
}

// 15) breathPhaseNow: reports a usable amount and direction, or null when there
//     genuinely isn't enough data — never a fabricated midpoint.
{
  assert.strictEqual(Polar.breathPhaseNow([]), null, 'no data -> null, not 0');
  assert.strictEqual(Polar.breathPhaseNow([1000, 1000, 1000]), null, 'too few beats -> null');
  // A perfectly regular heart has no respiratory modulation to find.
  const flat = new Array(80).fill(1000);
  assert.strictEqual(Polar.breathPhaseNow(flat), null,
    'a completely flat series has no breath signal, and must say so rather than reporting the midpoint');

  const rrs = [];
  let t = 0;
  for (let i = 0; i < 200; i++) {
    const rr = 1000 - 70 * Math.sin((2 * Math.PI * t) / 5);
    rrs.push(rr); t += rr / 1000;
  }
  const now = Polar.breathPhaseNow(rrs);
  assert.ok(now != null, 'should report a phase');
  assert.ok(now.amount >= -1 && now.amount <= 1, `amount must be in range (got ${now.amount})`);
  assert.strictEqual(typeof now.rising, 'boolean', 'must say whether the breath is rising');
  console.log('✓ breathPhaseNow reports amount and direction, and null when there is no signal');
}

// 16) resampleHr puts beats on an EVEN grid. Uneven spacing fed to a filter that
//     assumes even spacing is the exact bug that once skewed every breathing
//     estimate in dsp.js.
{
  assert.strictEqual(Polar.resampleHr([1000, 1000], 4), null, 'too short -> null');
  // 60bpm for a while then 120bpm: the grid must cover the real elapsed time,
  // not the beat count.
  const rrs = new Array(20).fill(1000).concat(new Array(20).fill(500));
  const hr = Polar.resampleHr(rrs, 4);
  const durSec = (20 * 1000 + 20 * 500) / 1000;
  assert.ok(Math.abs(hr.length - durSec * 4) <= 4,
    `grid length should follow elapsed time (${hr.length} samples for ${durSec}s at 4Hz)`);
  assert.ok(hr[2] > 55 && hr[2] < 65, `should start near 60bpm (got ${hr[2].toFixed(1)})`);
  assert.ok(hr[hr.length - 3] > 110, `should end near 120bpm (got ${hr[hr.length - 3].toFixed(1)})`);
  console.log('✓ resampleHr produces an evenly-spaced grid covering real elapsed time');
}

// 17) BREATH-HOLD. Reported from real use: holding at the top of an inhale
//     produced a confident flat line around +50% instead of no reading. A held
//     breath has no respiratory modulation, so there is nothing for RSA to see.
//     The old gate checked the whole 60s window, which still contained ~55s of
//     real breathing, so it could never fire.
{
  const rrs = [];
  let t = 0;
  // 45 seconds of real breathing...
  while (t < 45) { const rr = 1000 - 70 * Math.sin((2 * Math.PI * t) / 5); rrs.push(rr); t += rr / 1000; }
  const breathing = Polar.breathPhaseNow(rrs);
  assert.ok(breathing != null, 'normal breathing must produce a reading');

  // ...then a 15-second hold: heart rate settles, no respiratory modulation at
  // all. A tiny residual drift remains, which is exactly what used to be
  // inflated into a plateau.
  const held = rrs.slice();
  for (let i = 0; i < 15; i++) held.push(1000 + (i % 2 ? 0.4 : -0.4));
  const holdResult = Polar.breathPhaseNow(held);
  assert.strictEqual(holdResult, null,
    `a held breath must read as NO SIGNAL, not as a confident plateau (got ${JSON.stringify(holdResult)})`);

  // And the whole-window RMS is still large during the hold, proving the old
  // gate could not have caught this.
  const wholeWindowRms = Math.sqrt(
    Polar.resampleHr(held, 4).reduce((a, b, _, arr) => a + (b - arr.reduce((x, y) => x + y, 0) / arr.length) ** 2, 0)
    / Polar.resampleHr(held, 4).length);
  assert.ok(wholeWindowRms > Polar.RSA_MIN_BPM,
    `the full window still looks active during a hold (${wholeWindowRms.toFixed(2)} bpm) — which is why gating on it failed`);

  // Recovery: once breathing resumes, a reading must come back.
  const resumed = held.slice();
  let t2 = 0;
  while (t2 < 20) { const rr = 1000 - 70 * Math.sin((2 * Math.PI * t2) / 5); resumed.push(rr); t2 += rr / 1000; }
  assert.ok(Polar.breathPhaseNow(resumed) != null, 'resuming breathing must restore the reading');
  console.log('\u2713 a held breath reads as no signal, and a reading returns when breathing resumes');
}

// ============================================================================
// PMD accelerometer.
//
// A WARNING ABOUT THESE TESTS. The delta-frame tests below build their fixtures
// with the same assumptions the decoder uses, so they prove the decoder is
// SELF-CONSISTENT and crash-free. They do NOT prove it matches what the strap
// actually sends. That can only be established against gravity — see
// looksLikeGravity() and docs/polar-pmd.md. Do not read a green suite here as
// "the accelerometer works".
// ============================================================================

// 18) Settings TLV parsing, against a realistic settings response. This part IS
//     unambiguous: the spec's settings table gives each type's width.
{
  // [0xF0][cmd=1][type=ACC][err=0][more=0] then TLVs:
  //   type0 sampleRate,  4 items: 25, 50, 100, 200
  //   type1 resolution,  1 item: 16
  //   type2 range,       3 items: 2, 4, 8
  //   type4 channels,    1 item: 3
  const bytes = new Uint8Array([
    0xf0, 0x01, 0x02, 0x00, 0x00,
    0x00, 0x04, 25, 0, 50, 0, 100, 0, 200, 0,
    0x01, 0x01, 16, 0,
    0x02, 0x03, 2, 0, 4, 0, 8, 0,
    0x04, 0x01, 3,
  ]);
  const r = Polar.parseControlResponse(new DataView(bytes.buffer));
  assert.ok(r.isResponse, 'should recognise a 0xF0 control response');
  assert.strictEqual(r.command, Polar.PMD_CMD_GET_SETTINGS);
  assert.strictEqual(r.measurementType, Polar.PMD_TYPE_ACC);
  assert.strictEqual(r.errorCode, 0);
  assert.deepStrictEqual(r.settings.sampleRate, [25, 50, 100, 200],
    'the H10 advertises 25/50/100/200Hz — this is the documented capability');
  assert.deepStrictEqual(r.settings.resolution, [16]);
  assert.deepStrictEqual(r.settings.range, [2, 4, 8]);
  assert.deepStrictEqual(r.settings.channels, [3]);
  assert.ok(/^f0 01 02/.test(r.raw), 'raw hex must be reported so a real response can be eyeballed');
  console.log('\u2713 PMD settings response parses into sample rates, resolution, range and channels');
}

// 19) The conversion factor is an IEEE754 float, and the spec says using it is
//     MANDATORY or the values are wrong. So it must survive parsing exactly.
{
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, 0.00061, true);
  const f = new Uint8Array(buf);
  const bytes = new Uint8Array([0xf0, 0x01, 0x02, 0x00, 0x00, 0x05, 0x01, f[0], f[1], f[2], f[3]]);
  const r = Polar.parseControlResponse(new DataView(bytes.buffer));
  assert.ok(Math.abs(r.settings.conversionFactor[0] - 0.00061) < 1e-9,
    `conversion factor must round-trip exactly (got ${r.settings.conversionFactor[0]})`);
  console.log('\u2713 the conversion factor survives as a float');
}

// 20) Malformed settings must yield "found nothing", never confident nonsense.
{
  const junk = new Uint8Array([0xf0, 0x01, 0x02, 0x00, 0x00, 0x63, 0xff, 0xff, 0xff]);
  const r = Polar.parseControlResponse(new DataView(junk.buffer));
  assert.deepStrictEqual(r.settings, {}, 'an unrecognised setting type must stop parsing, not guess');
  assert.strictEqual(Polar.parseControlResponse(null), null);
  assert.strictEqual(Polar.parseControlResponse(new DataView(new ArrayBuffer(2))), null,
    'a too-short response is no response');
  console.log('\u2713 malformed settings parse to nothing rather than to nonsense');
}

// 21) The start command's exact bytes, checked against the spec's TLV shape.
//
// This test used to assert that `channels` was always sent, which is the exact
// wrong assumption a real H10 refused five times over. The device's own settings
// response named sampleRate, resolution and range and nothing else, so the default
// is those three \u2014 the test now pins the corrected behaviour.
{
  const cmd = Polar.buildAccStartCommand({ sampleRate: 50, resolution: 16, range: 2 });
  assert.deepStrictEqual(Array.from(cmd), [
    0x02, 0x02,             // start, ACC
    0x00, 0x01, 50, 0x00,   // sample rate 50Hz  (uint16)
    0x01, 0x01, 16, 0x00,   // resolution 16 bits (uint16)
    0x02, 0x01, 2, 0x00,    // range +/-2G        (uint16)
  ], 'by default the start command must send exactly the settings the H10 advertises');
  assert.ok(!Array.from(cmd).includes(0x04) || Array.from(cmd).indexOf(0x04) < 2,
    'setting id 4 (channels) must not be sent by default: the H10 does not advertise it');
  // Still reachable for a device that DOES advertise channels.
  const withCh = Polar.buildAccStartCommand({ include: [0, 1, 2, 4], channels: 3 });
  assert.deepStrictEqual(Array.from(withCh).slice(-3), [0x04, 0x01, 3],
    'a device that advertises channels must still be able to receive it');
  // 200Hz needs both bytes, which is the case a one-byte encoding would break.
  const fast = Polar.buildAccStartCommand({ sampleRate: 200 });
  assert.strictEqual(fast[4], 200); assert.strictEqual(fast[5], 0);
  assert.deepStrictEqual(Array.from(Polar.buildStopCommand()), [0x03, 0x02]);
  console.log('\u2713 the ACC start/stop commands have the documented byte layout');
}

// 21b) The setting ids sent must come from the device's response, not from a guess.
//      Driven by the ACTUAL bytes a real H10 returned, which is the only reason
//      this is more than another assumption checked against itself.
{
  const real = { sampleRate: [25, 50, 100, 200], resolution: [16], range: [2, 4, 8] };
  assert.deepStrictEqual(Polar.accStartSettingIds(real), [0, 1, 2],
    'the real H10 advertises rate, resolution and range \u2014 send those three');
  assert.deepStrictEqual(Polar.accStartSettingIds(Object.assign({ channels: [3] }, real)),
    [0, 1, 2, 4], 'a device that advertises channels must get channels');
  assert.deepStrictEqual(Polar.accStartSettingIds(null), [0, 1, 2],
    'with no settings response, fall back to what the H10 documents');
  assert.deepStrictEqual(Polar.accStartSettingIds({}), [0, 1, 2],
    'an empty settings object must not produce an empty start command');

  // The refused request and the corrected one must actually differ, or the fix is
  // cosmetic. This is the whole content of the bug, in one assertion.
  const wrong = Polar.buildAccStartCommand({ include: [0, 1, 2, 4] });
  const right = Polar.buildAccStartCommand({ include: Polar.accStartSettingIds(real) });
  assert.notDeepStrictEqual(Array.from(wrong), Array.from(right),
    'the corrected start request must differ from the one the device refused');
  assert.strictEqual(right.length, wrong.length - 3,
    'the correction is precisely the removal of the 3-byte channels setting');

  // Candidate values must all be ones the device named \u2014 sweeping unsupported
  // values wastes the search and muddies which axis is at fault.
  const cands = Polar.accParamCandidates(real);
  assert.ok(cands.length > 1, 'a device offering several rates and ranges gives several candidates');
  for (const c of cands) {
    assert.ok(real.sampleRate.includes(c.sampleRate), `rate ${c.sampleRate} was not advertised`);
    assert.ok(real.range.includes(c.range), `range ${c.range} was not advertised`);
    assert.ok(real.resolution.includes(c.resolution), `resolution ${c.resolution} was not advertised`);
  }
  assert.deepStrictEqual(cands[0], { sampleRate: 50, resolution: 16, range: 2 },
    'the first candidate must be 50Hz at the finest range: breathing is slow and small');
  console.log('\u2713 start requests carry the settings the device advertised, and no others');
}

// 21c) A control-point notification without the 0xF0 marker must not be read as a
//      response. Doing so reports byte 3 of something else as an error code, which
//      invents a number and attributes it to the device.
{
  const notResponse = new DataView(new Uint8Array([0x02, 0x02, 0x00, 0x05]).buffer);
  const r = Polar.parseControlResponse(notResponse);
  assert.strictEqual(r.isResponse, false,
    'a payload not starting with 0xF0 must be flagged as not a response');
  const real = new DataView(new Uint8Array([0xf0, 0x02, 0x02, 0x05, 0x00]).buffer);
  const r2 = Polar.parseControlResponse(real);
  assert.strictEqual(r2.isResponse, true);
  assert.strictEqual(r2.command, Polar.PMD_CMD_START);
  assert.strictEqual(r2.errorCode, 5);
  // The error name is a guess from the SDK, so it must never appear alone.
  assert.match(Polar.describeError(5), /^5 \(/,
    'an error description must lead with the number the device actually sent');
  assert.strictEqual(Polar.describeError(99), '99',
    'an unknown code must be reported as the bare number, not invented');
  console.log('\u2713 only 0xF0-marked payloads count as control responses');
}

// 22) signedLE: pure arithmetic, hand-checkable, no circularity.
{
  assert.strictEqual(Polar.signedLE(new Uint8Array([0x10, 0x00]), 0, 2), 16);
  assert.strictEqual(Polar.signedLE(new Uint8Array([0xf0, 0xff]), 0, 2), -16);
  assert.strictEqual(Polar.signedLE(new Uint8Array([0xff, 0x7f]), 0, 2), 32767);
  assert.strictEqual(Polar.signedLE(new Uint8Array([0x00, 0x80]), 0, 2), -32768);
  assert.strictEqual(Polar.signedLE(new Uint8Array([0x80]), 0, 1), -128);
  assert.strictEqual(Polar.signedLE(new Uint8Array([0xff, 0xff, 0xff]), 0, 3), -1);
  console.log('\u2713 signedLE handles 8/16/24-bit two\u2019s-complement correctly');
}

// 23) Round-trip through a frame built the way the decoder expects.
//     SELF-CONSISTENCY ONLY — see the warning above.
{
  // Encode 3-channel 16-bit samples with 6-bit LSB-first signed deltas.
  const ref = [900, -120, 400];
  const deltas = [[3, -2, 1], [-4, 5, 0], [7, 1, -3]];
  const bits = [];
  for (const d of deltas) for (const v of d) {
    const u = v < 0 ? v + 64 : v;                 // 6-bit two's complement
    for (let k = 0; k < 6; k++) bits.push((u >> k) & 1);
  }
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, k) => { if (bit) packed[k >> 3] |= 1 << (k & 7); });

  const head = [Polar.PMD_TYPE_ACC, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // type, 8-byte ts, frameType=1
  const refBytes = [];
  for (const v of ref) { const u = v < 0 ? v + 65536 : v; refBytes.push(u & 0xff, (u >> 8) & 0xff); }
  const frame = new Uint8Array([...head, ...refBytes, 6, deltas.length, ...packed]);

  const out = Polar.decodeAccFrame(new DataView(frame.buffer));
  assert.ok(out, 'should decode');
  assert.strictEqual(out.frameType, 1);
  assert.strictEqual(out.samples.length, 1 + deltas.length, 'reference sample plus one per delta');
  assert.deepStrictEqual(out.samples[0], { x: 900, y: -120, z: 400 }, 'reference sample, signed');
  // Deltas ACCUMULATE — each sample is the previous plus its delta, not the
  // reference plus its delta. Getting this wrong yields a plausible-looking
  // signal that simply never drifts.
  assert.deepStrictEqual(out.samples[1], { x: 903, y: -122, z: 401 });
  assert.deepStrictEqual(out.samples[2], { x: 899, y: -117, z: 401 });
  assert.deepStrictEqual(out.samples[3], { x: 906, y: -116, z: 398 });
  console.log('\u2713 delta frames accumulate from the reference sample (self-consistency only)');
}

// 24) Garbage in must not produce confident output.
{
  assert.strictEqual(Polar.decodeAccFrame(null), null);
  assert.strictEqual(Polar.decodeAccFrame(new DataView(new ArrayBuffer(4))), null, 'too short');
  // Wrong measurement type must be refused rather than decoded as ACC.
  const wrongType = new Uint8Array(20); wrongType[0] = 0; // ECG
  assert.strictEqual(Polar.decodeAccFrame(new DataView(wrongType.buffer)), null,
    'an ECG frame must not be decoded as acceleration');
  // An absurd bit width must stop the loop, not spin.
  const bad = new Uint8Array([Polar.PMD_TYPE_ACC, 0,0,0,0,0,0,0,0, 1, 1,0, 2,0, 3,0, 200, 250, 9,9,9,9]);
  const r = Polar.decodeAccFrame(new DataView(bad.buffer));
  assert.ok(r === null || r.samples.length <= 2, 'an implausible bit width must halt decoding');
  console.log('\u2713 malformed ACC frames are refused rather than decoded into nonsense');
}

// 25) THE CHECK THAT ACTUALLY MATTERS. A correct decode of a body at rest reads
//     ~1000 mG, because that is gravity. This is the one assertion here that a
//     wrong decode cannot satisfy by accident, and it is why the runtime shows
//     the live magnitude rather than trusting this suite.
{
  const atRest = [{ x: 20, y: -60, z: 998 }, { x: 25, y: -55, z: 1002 }, { x: 18, y: -62, z: 995 }, { x: 22, y: -58, z: 1000 }];
  const g = Polar.looksLikeGravity(atRest);
  assert.ok(g.ok, `a body at rest must read as gravity (got ${g.meanMilliG.toFixed(0)} mG)`);
  assert.ok(Math.abs(g.meanMilliG - 1000) < 60, 'and close to 1000 mG');
  assert.ok(Math.abs(Polar.accelMagnitude({ x: 0, y: 0, z: 1000 }) - 1000) < 1e-9);

  // These are what a botched decode looks like: right shape, wrong scale.
  assert.strictEqual(Polar.looksLikeGravity(atRest.map((s) => ({ x: s.x / 40, y: s.y / 40, z: s.z / 40 }))).ok,
    false, 'values 40x too small must be rejected — a wrong resolution assumption looks exactly like this');
  assert.strictEqual(Polar.looksLikeGravity(atRest.map((s) => ({ x: s.x * 256, y: s.y * 256, z: s.z * 256 }))).ok,
    false, 'values 256x too large must be rejected — a byte-order or width error looks like this');
  assert.strictEqual(Polar.looksLikeGravity([]), null, 'no samples is no verdict, not a pass');
  assert.strictEqual(Polar.looksLikeGravity(null), null);
  console.log('\u2713 looksLikeGravity accepts a body at rest and rejects mis-scaled decodes');
}

console.log('\nAll Polar tests passed.');
