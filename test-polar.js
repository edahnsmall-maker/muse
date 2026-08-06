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
  /* SPACED SAMPLES. The tracker only accepts one sample per `minSpacingSec`, so the tests drive an
     explicit clock — see the note on SteadinessTracker for why overlapping samples were the bug. */
  const feed = (tracker, values, stepSec = 25) => {
    let at = 0;
    let last = null;
    for (const v of values) { last = tracker.update(v, at); at += stepSec; }
    return last;
  };
  const t = new Polar.SteadinessTracker();
  assert.strictEqual(t.update(40, 0), null, 'must not guess from one sample');
  assert.strictEqual(t.update(41, 25), null);
  assert.strictEqual(t.update(39, 50), null);
  const steady = t.update(40, 75);
  assert.ok(steady != null && steady > 0.8, `a steady HRV should read high (got ${steady})`);

  const lurching = new Polar.SteadinessTracker();
  const lv = feed(lurching, [20, 90, 25, 85, 30, 95]);
  assert.ok(lv != null && lv < 0.4, `a lurching HRV should read low (got ${lv})`);

  // Relative, not absolute: a person with high resting HRV who is steady must
  // not be penalised for the level.
  const highButSteady = new Polar.SteadinessTracker();
  feed(highButSteady, [140, 143, 138, 141, 139, 142]);
  assert.ok(highButSteady.value() > 0.8,
    `steadiness must be relative to the person, not their absolute HRV (got ${highButSteady.value()})`);
  assert.ok(t.update(NaN, 200) != null, 'garbage input must not destroy the running value');

  /*
   * THE OVERLAP BUG, asserted directly. Reported as "equanimity is ceilinging".
   *
   * The app computes RMSSD over a SIXTY-second rolling window and used to call update() once per
   * heartbeat. Twelve consecutive samples then spanned about ten seconds and were computed from windows
   * sharing ~85% of their beats, so their spread was tiny by construction and got tinier as the buffer
   * filled — the score was measuring its own input overlap, and its slow climb was the buffer filling
   * rather than the practitioner settling. Measured on a real sit's rr.csv: 0.78 climbing to 0.92,
   * above 0.90 for the whole second half.
   *
   * So samples arriving faster than one window apart must be REFUSED, not averaged: it is independence
   * the spread needs, and a mean of overlapping windows is still an overlapping window.
   */
  {
    const spaced = new Polar.SteadinessTracker();
    /* Eighteen beats' worth of updates inside ONE spacing interval, as the app used to do — 15 seconds
       at ~72bpm, which is well under the 20s the tracker requires between independent samples. */
    for (let i = 0; i < 18; i++) spaced.update(70 + (i % 3), i * 0.85);
    assert.strictEqual(spaced.filled, 1,
      `a burst of near-simultaneous samples must count as ONE (counted ${spaced.filled})`);
    assert.strictEqual(spaced.value(), null,
      'and must not produce a score, because there is nothing yet to compare it against');
    // The same values properly spaced do produce one.
    const wide = new Polar.SteadinessTracker();
    feed(wide, [70, 71, 72, 70, 71, 72]);
    assert.strictEqual(wide.filled, 6, 'spaced samples are all accepted');
    assert.ok(wide.value() != null, 'and six of them is a score');
  }
  console.log('✓ SteadinessTracker needs data, is relative, separates steady from lurching, and'
    + ' refuses samples too close together to be independent');
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

// 23) THE REAL FRAMES. This replaces a test that encoded 6-bit deltas exactly the
//     way the decoder decoded them and then asserted it got them back — a test that
//     could only ever confirm the decoder agreed with itself, and which passed
//     happily while a strap sitting still reported 16 million mG.
//
//     These are bytes a real H10 sent, and the thing asserted about them is gravity.
{
  const fx = require('./fixtures/h10-acc-frames.js');
  let all = [];
  for (const [n, hex] of fx.frames.entries()) {
    const out = Polar.decodeAccFrame(fx.toView(hex), { channels: 3 });
    assert.ok(out, `real frame ${n} must decode`);
    assert.strictEqual(out.frameType, 1, 'the H10 sends 16-bit ACC frames');
    // 216 content bytes / (3 channels x 2 bytes) = 36. Not 1, which is what the
    // delta reading produced when it hit 0xcd as a "bit width" and bailed.
    assert.strictEqual(out.samples.length, 36,
      `real frame ${n} carries 36 samples, not ${out.samples.length}`);
    all = all.concat(out.samples);
  }
  assert.strictEqual(all.length, 216);

  // GRAVITY. Not negotiable, and not something this file defines.
  const mags = all.map((s) => Polar.accelMagnitude(s));
  const mean = mags.reduce((a, c) => a + c, 0) / mags.length;
  assert.ok(mean > 950 && mean < 1075,
    `216 samples from a strap at rest must average ~1000 mG, got ${mean.toFixed(1)}`);
  // Every single sample, not just the average: an average can be dragged to 1000 by
  // symmetric garbage, which is precisely what a wrong decode produces.
  for (const [i, m] of mags.entries()) {
    assert.ok(m > 900 && m < 1150, `sample ${i} reads ${m.toFixed(0)} mG, not gravity`);
  }
  // A body at rest is also STEADY. Thrashing within the right average is still wrong.
  const sd = Math.sqrt(mags.reduce((a, c) => a + (c - mean) ** 2, 0) / mags.length);
  assert.ok(sd < 40, `magnitude must be steady at rest, got sd ${sd.toFixed(1)} mG`);
  assert.ok(Polar.looksLikeGravity(all.slice(-40)).ok, 'the gravity verdict must pass');

  /* WHAT GRAVITY CANNOT CATCH, established by deliberately breaking the decode:
   *   sample width wrong (16 -> 8 bit)  -> caught (72 samples, not 36)
   *   byte order wrong (LE -> BE)       -> caught (23374 mG)
   *   content offset off by one         -> caught (35 samples, not 36)
   *   AXIS ORDER PERMUTED               -> NOT caught, and cannot be
   * Magnitude is sqrt(x^2+y^2+z^2), which is invariant under permuting the axes, so
   * nothing here establishes which axis is which. That matters for the breath work:
   * do NOT write code that assumes a named axis is normal to the chest wall. Pick
   * the axis at runtime by respiratory-band power, which needs no such assumption.
   */
  console.log(`✓ 216 real H10 samples decode to gravity: ${mean.toFixed(1)} ± ${sd.toFixed(1)} mG`);
}

// 23b) The rest of that captured session, checked against the same real bytes.
{
  const fx = require('./fixtures/h10-acc-frames.js');
  // The settings response that explained error 5: no `channels` in it.
  const set = Polar.parseControlResponse(fx.toView(fx.accSettingsRaw));
  assert.strictEqual(set.isResponse, true);
  assert.strictEqual(set.errorCode, 0);
  assert.deepStrictEqual(set.settings,
    { sampleRate: [25, 50, 100, 200], resolution: [16], range: [2, 4, 8] },
    'the real ACC settings response must parse to exactly what the device sent');
  assert.ok(!('channels' in set.settings),
    'the H10 does not advertise channels — sending it is what error 5 objected to');
  assert.deepStrictEqual(Polar.accStartSettingIds(set.settings), [0, 1, 2]);

  // ECG as the control condition: a different type, a different shape, same parser.
  const ecg = Polar.parseControlResponse(fx.toView(fx.ecgSettingsRaw));
  assert.deepStrictEqual(ecg.settings, { sampleRate: [130], resolution: [14] },
    'the H10 reports ECG at 130Hz/14-bit');

  // The feature bitmap, cross-checked against the settings responses above: mask
  // 0x05 claims ECG and ACC, and both of those answered. Two independent sources
  // agreeing is what makes the inferred layout believable.
  const f = Polar.parseFeatures(fx.toView(fx.featuresRaw));
  assert.strictEqual(f.looksValid, true, 'the 0x0F marker must be recognised');
  assert.deepStrictEqual(f.types, ['ECG', 'ACC'],
    'mask 0x05 means ECG and ACC, which is exactly what answered GET SETTINGS');

  // The accepted START, and the STOP of a stream that was not running.
  const ok = Polar.parseControlResponse(fx.toView(fx.startAcceptedRaw));
  assert.strictEqual(ok.command, Polar.PMD_CMD_START);
  assert.strictEqual(ok.errorCode, 0, 'the corrected start request was accepted');
  const stop = Polar.parseControlResponse(fx.toView(fx.stopNothingRunningRaw));
  assert.strictEqual(stop.command, Polar.PMD_CMD_STOP);
  assert.strictEqual(stop.errorCode, 6,
    'stopping a stream that is not running answers 6, so the pre-emptive STOP is harmless');
  console.log('✓ the real control responses parse: features, both settings, start, stop');
}

// 24) Garbage in must not produce confident output.
{
  assert.strictEqual(Polar.decodeAccFrame(null), null);
  assert.strictEqual(Polar.decodeAccFrame(new DataView(new ArrayBuffer(4))), null, 'too short');
  // Wrong measurement type must be refused rather than decoded as ACC.
  const wrongType = new Uint8Array(20); wrongType[0] = 0; // ECG
  assert.strictEqual(Polar.decodeAccFrame(new DataView(wrongType.buffer)), null,
    'an ECG frame must not be decoded as acceleration');
  // An unknown frame type has an unknown sample width, so there is nothing to do
  // but refuse. Guessing 16-bit here would produce numbers with no basis.
  const badType = new Uint8Array([Polar.PMD_TYPE_ACC, 0,0,0,0,0,0,0,0, 7, 1,0,2,0,3,0]);
  assert.strictEqual(Polar.decodeAccFrame(new DataView(badType.buffer)), null,
    'an unrecognised frame type must be refused, not assumed');
  // A PARTIAL sample must sink the whole frame. Decoding as far as it goes would
  // hand back plausible samples from a frame we demonstrably misunderstand.
  const ragged = new Uint8Array([Polar.PMD_TYPE_ACC, 0,0,0,0,0,0,0,0, 1, 1,0, 2,0, 3,0, 4,0]);
  assert.strictEqual(ragged.length - 10, 8, 'fixture is 8 content bytes: one triplet plus two');
  assert.strictEqual(Polar.decodeAccFrame(new DataView(ragged.buffer)), null,
    'content that is not a whole number of samples must be refused entirely');
  // And the length check must not be so strict that real frames fail it.
  const fx = require('./fixtures/h10-acc-frames.js');
  assert.ok(Polar.decodeAccFrame(fx.toView(fx.frames[0])), 'a real frame must still decode');
  console.log('✓ malformed ACC frames are refused rather than decoded into nonsense');
}

// 24b) BREATHING FROM CHEST MOTION. The ground truth here is a frequency and an
//      axis that the test constructs and the implementation is never told, so this
//      is not the decoder-agrees-with-itself trap: a wrong band-pass, a wrong
//      decimation or a hardcoded axis all fail it.
{
  const HZ = 50;
  // A synthetic strap: gravity parked on `gravityAxis`, breathing on `breathAxis`,
  // plus a little broadband noise so nothing succeeds only on a clean sinusoid.
  const synth = ({ breathAxis, gravityAxis, bpm, seconds, amplitude = 40, noise = 3, holdAfter = null }) => {
    const out = [];
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
    for (let n = 0; n < seconds * HZ; n++) {
      const t = n / HZ;
      const held = holdAfter != null && t >= holdAfter;
      const v = [0, 0, 0];
      v[gravityAxis] = 1000;
      // A hold freezes the chest wherever it was, which is what a real hold does.
      const phase = held ? 2 * Math.PI * (bpm / 60) * holdAfter : 2 * Math.PI * (bpm / 60) * t;
      v[breathAxis] += amplitude * Math.sin(phase);
      for (let a = 0; a < 3; a++) v[a] += noise * rand();
      out.push({ x: v[0], y: v[1], z: v[2] });
    }
    return out;
  };

  // 1) The axis must be FOUND, not assumed. Breathing is placed on each axis in
  //    turn, with gravity somewhere else, and each must be picked out.
  for (const breathAxis of [0, 1, 2]) {
    const gravityAxis = (breathAxis + 1) % 3;
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis, gravityAxis, bpm: 12, seconds: 40 }));
    const est = b.estimate();
    assert.strictEqual(est.axis, breathAxis,
      `breathing on axis ${breathAxis} must be found there, not on ${est.axis}`);
    // 12 breaths/min from a signal the estimator was never told the rate of.
    assert.ok(est.bpm != null && Math.abs(est.bpm - 12) < 1.5,
      `rate should be ~12/min, got ${est.bpm == null ? 'null' : est.bpm.toFixed(1)}`);
    assert.strictEqual(est.holding, false, 'a breathing chest is not holding');
    assert.ok(est.amount != null && Math.abs(est.amount) <= 1);
  }

  // 2) Gravity must not be mistaken for breath. It is 25x larger than the
  //    respiratory excursion, so a missing high-pass shows up here.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 2, gravityAxis: 0, bpm: 12, seconds: 40 }));
    assert.strictEqual(b.estimate().axis, 2,
      'the axis holding 1000mG of gravity must not win on amplitude');
  }

  // 3) SLOW breathing, which is what a meditator actually does. 4/min has a 15s
  //    period, longer than the detrend window's half-width — the case a careless
  //    high-pass corner silently eats.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 1, gravityAxis: 2, bpm: 4.5, seconds: 60 }));
    const est = b.estimate();
    assert.ok(est.bpm != null && Math.abs(est.bpm - 4.5) < 1.0,
      `4.5/min must survive the high-pass, got ${est.bpm == null ? 'null' : est.bpm.toFixed(1)}`);
  }

  // 4) THE BREATH HOLD — the thing that was asked for and could not be done with
  //    RSA. Breathe for 40s, then stop. The chest stops moving, and that must be
  //    reported as holding rather than as a confident continuing waveform.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 2, gravityAxis: 0, bpm: 12, seconds: 55, holdAfter: 40 }));
    const est = b.estimate();
    assert.strictEqual(est.holding, true,
      `a chest that stopped 15s ago must read as holding (amp ${est.amplitudeMilliG.toFixed(1)}mG)`);
    // And it must NOT have gone quiet: a hold has a position, which is the whole
    // point. Position needs the sign, so establish it first.
    b.resolveSign(b.band(2));
    assert.ok(b.estimate().amount != null,
      'a hold must still report WHERE the chest is, once in/out is known');
  }

  // 5) Mid-breath is not holding. The hold test above must not be passing because
  //    the detector says "holding" to everything.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 2, gravityAxis: 0, bpm: 12, seconds: 55, holdAfter: 54.5 }));
    assert.strictEqual(b.estimate().holding, false,
      'half a second of stillness is not a breath hold');
  }

  // 6) A strap on a table reads as holding, not as very faint breathing.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 2, gravityAxis: 0, bpm: 12, seconds: 40, amplitude: 0, noise: 0.5 }));
    assert.strictEqual(b.estimate().holding, true, 'a motionless strap is not breathing');
  }

  // 7) Before there is enough data, say so rather than guessing.
  {
    const b = Polar.AccelBreath();
    b.push(synth({ breathAxis: 2, gravityAxis: 0, bpm: 12, seconds: 8 }));
    const est = b.estimate();
    assert.strictEqual(est.amount, null, '8 seconds is not enough for a breath estimate');
    assert.strictEqual(est.reason, 'warming up');
  }
  console.log('✓ accelerometer breath finds its own axis, its rate, and a breath hold');
}

// 24c) IN vs OUT cannot be known from the accelerometer alone — the strap can be
//      worn either way up. RSA settles it, because heart rate rises on inhalation.
{
  const HZ = 50, OUT = 5;
  const chest = (flip) => {
    const out = [];
    for (let n = 0; n < 40 * HZ; n++) {
      const t = n / HZ;
      out.push({ x: 1000, y: 0, z: flip * 40 * Math.sin(2 * Math.PI * 0.2 * t) });
    }
    return out;
  };
  // An RSA-style reference at the same rate, in phase with true inhalation.
  const reference = [];
  for (let n = 0; n < 40 * OUT; n++) reference.push(Math.sin(2 * Math.PI * 0.2 * (n / OUT)));

  const up = Polar.AccelBreath();
  up.push(chest(+1));
  assert.strictEqual(up.estimate().signKnown, false,
    'direction must not be claimed before anything has established it');
  up.resolveSign(reference);
  assert.strictEqual(up.sign, 1, 'a chest in phase with RSA needs no flip');
  assert.strictEqual(up.estimate().signKnown, true);

  const down = Polar.AccelBreath();
  down.push(chest(-1));
  down.resolveSign(reference);
  assert.strictEqual(down.sign, -1,
    'a strap worn the other way up must be detected and flipped');

  // The flip must actually change the reported direction, or it is decorative.
  const a = up.estimate().amount, d = down.estimate().amount;
  assert.ok(a != null && d != null);
  assert.ok(Math.abs(a - d) < 0.35,
    `both orientations must report the SAME breath position after correction (${a.toFixed(2)} vs ${d.toFixed(2)})`);

  // Noise must not be mistaken for a direction.
  const noiseRef = [];
  let seed = 7;
  for (let n = 0; n < 40 * OUT; n++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noiseRef.push((seed / 0x7fffffff) * 2 - 1); }
  const na = Polar.AccelBreath();
  na.push(chest(+1));
  na.resolveSign(noiseRef);
  assert.strictEqual(na.sign, 0, 'an uncorrelated reference must leave the direction unknown');
  console.log('✓ in/out is resolved against RSA, and left unknown when it cannot be');
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

/*
 * THE ORIENTATION CAN BE SET BY THE PERSON, and once set it stays set.
 *
 * Asked: "is it possible that the belly band accelerometer graph is inverted even if the
 * data is good?" Yes — by design, and the file says so: the strap can be worn either way
 * up, magnitude is blind to sign, so which direction is inhale is INFERRED by correlating
 * against RSA. A wrong inference draws a perfectly good signal upside down, and nothing
 * in the data looks wrong, so it could be neither noticed nor corrected.
 */
{
  const HZ = 50, OUT = 5;
  // A clean 5s breath on axis 1, with the chest moving NEGATIVE on inhale — i.e. the
  // strap worn the other way up from whatever the inference happens to prefer.
  const feed = (ab, seconds, phase = 0) => {
    for (let i = 0; i < seconds * HZ; i++) {
      const t = i / HZ;
      const v = -300 * Math.sin(2 * Math.PI * (t + phase) / 5);
      ab.push([{ x: 20, y: v, z: 980 }]);
    }
  };

  // 1) A manual sign survives the per-tick inference, which is the whole point: without
  //    the latch, resolveSign would overwrite the correction on the next tick and the
  //    button would be indistinguishable from broken.
  {
    const ab = Polar.AccelBreath();
    feed(ab, 60);
    ab.setSign(-1);
    assert.strictEqual(ab.sign, -1);
    assert.strictEqual(ab.signManual, true);
    // A reference that would push it the other way must be ignored.
    const ref = [];
    for (let i = 0; i < 60 * OUT; i++) ref.push(-Math.sin(2 * Math.PI * (i / OUT) / 5));
    ab.resolveSign(ref);
    assert.strictEqual(ab.sign, -1,
      'a sign set by the person must not be overwritten by the RSA inference');
    // And it survives a reset: it describes how the strap is WORN, not the buffer, so
    // losing it on every reconnect would mean re-calibrating several times a sit.
    ab.reset();
    assert.strictEqual(ab.sign, -1, 'a manual orientation must survive a reset');
    ab.clearManualSign();
    assert.strictEqual(ab.sign, 0, 'and giving the inference its say again clears it');
    assert.strictEqual(ab.signManual, false);
  }

  // 2) One-press calibration: pressed mid-inhale, it orients so that NOW reads as
  //    inhaling. More reliable than asking someone whether a trace looks upside down,
  //    which is the same question one step removed.
  {
    const ab = Polar.AccelBreath();
    // Stop where the axis is clearly displaced, then calibrate as if inhaling.
    feed(ab, 61.25);                      // a quarter period past 60s: near an extreme
    const before = ab.estimate();
    const res = ab.calibrateInhaling();
    assert.strictEqual(res.ok, true, `calibration should succeed mid-breath: ${res.reason}`);
    const after = ab.estimate();
    assert.ok(after.amount > 0,
      `after calibrating while inhaling, the reading must say inhaled (got ${after.amount})`);
    assert.strictEqual(after.signKnown, true, 'and the direction is now known');
    // The MAGNITUDE is untouched — this flips the reading, it does not rescale it.
    if (before.amount != null) {
      assert.ok(Math.abs(Math.abs(after.amount) - Math.abs(before.amount)) < 1e-9,
        'flipping the sign must not change how much the chest has moved');
    }
    void before;
  }

  // 3) It REFUSES at the turnaround. There the signal is near zero and its sign is
  //    noise, so a mistimed press would latch a coin flip and then be trusted.
  {
    const ab = Polar.AccelBreath();
    /* 60.3s, not 60. The band-pass and 1s smoothing shift the phase by about 70
       degrees on a 5s breath, so the FILTERED turnaround is not at the raw zero
       crossing — measured, the filtered value there is still 0.57 of amplitude. This is
       where the signal the calibration actually reads is near zero. */
    feed(ab, 60.3);
    const res = ab.calibrateInhaling();
    assert.strictEqual(res.ok, false,
      'pressing at the turnaround must refuse rather than latch a coin flip');
    assert.match(res.reason, /turnaround/i, `and say why: ${res.reason}`);
    assert.strictEqual(ab.sign, 0, 'and leave the orientation unset');
    const empty = Polar.AccelBreath().calibrateInhaling();
    assert.strictEqual(empty.ok, false, 'and with no data at all it refuses too');
  }

  // 4) HYSTERESIS: an established sign takes more evidence to overturn than to set.
  //    resolveSign runs every tick against a weak, lagging, noisy reference; at the bare
  //    threshold the inferred sign flips between ticks, which draws a breath trace that
  //    inverts every few seconds — worse than a consistently wrong sign, because a
  //    consistent one can at least be read backwards.
  {
    const ab = Polar.AccelBreath();
    feed(ab, 60);
    const inPhase = [];
    for (let i = 0; i < 60 * OUT; i++) inPhase.push(-Math.sin(2 * Math.PI * (i / OUT) / 5));
    ab.resolveSign(inPhase);
    const settled = ab.sign;
    assert.notStrictEqual(settled, 0, 'a clean reference must settle the sign');
    /* A reference too weak to ESTABLISH a sign must also be too weak to overturn one.
       Calibrated rather than guessed: the coherent part is scaled down until a fresh
       tracker declines to settle at all (verified below), because with 300 samples the
       random part averages away and even a small coherent component correlates
       strongly — an earlier version of this test used 0.35 amplitude against 0.9 noise
       and still cleared the threshold comfortably. */
    const weak = [];
    let seed = 5;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 60 * OUT; i++) {
      weak.push(0.03 * Math.sin(2 * Math.PI * (i / OUT) / 5) + (rnd() - 0.5));
    }
    const fresh = Polar.AccelBreath();
    feed(fresh, 60);
    assert.strictEqual(fresh.resolveSign(weak), 0,
      'precondition: this reference must be too weak to establish a sign at all');

    ab.resolveSign(weak);
    assert.strictEqual(ab.sign, settled,
      'a reference too weak to establish a sign must not overturn an established one');
  }
  console.log('✓ breath direction can be set by the person, survives the inference and a'
    + ' reset, refuses at the turnaround, and does not flip on weak evidence');
}

console.log('\nAll Polar tests passed.');
