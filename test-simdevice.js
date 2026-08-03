/*
 * Tests for simdevice.js — the simulated headband.
 *
 * WHY THESE PARTICULAR TESTS. A simulator is a measuring instrument for the app, so the failure that
 * matters is not "it crashes" but "it lies quietly". Three ways it could:
 *
 *   1. THE PACKETS COULD BE WRONG. Then every downstream number is wrong in the same way, the app
 *      looks fine under simulation, and the simulator has certified a broken build. So the packing is
 *      tested against the real decoder rather than against a second copy of itself.
 *
 *   2. THE SAMPLE RATE COULD DRIFT. 256 Hz in twelve-sample packets is a 46.875 ms period, which no
 *      timer honours. If packets were emitted one per tick, the stream would run slow and every
 *      frequency the app reports would be shifted by the ratio — invisibly, because a spectrum with
 *      a peak in the wrong place still looks like a spectrum.
 *
 *   3. IT COULD RUN WHEN NOBODY ASKED. That is the one unrecoverable failure: fabricated rows in the
 *      analysis lab cannot be separated from real ones afterwards, because they are the same shape.
 *
 * And one positive requirement: the scripted arc must actually contain the alpha increase it claims,
 * measured with the app's own spectrum code. A simulator whose "settled" end is not measurably more
 * alpha-rich than its "restless" end would let a broken metric pass.
 */
const assert = require('assert');
const SimDevice = require('./public/simdevice.js');
const DSP = require('./public/dsp.js');

// 1) THE PACKING IS THE DECODER'S INVERSE — checked through DSP, not through a second implementation.
{
  const codes = [0, 1, 15, 16, 255, 256, 1000, 2047, 2048, 3000, 4094, 4095];
  const packet = SimDevice.pack12Bit(codes);
  assert.strictEqual(packet.length, 2 + 18, 'a 12-sample packet is 2 index bytes plus 18 data bytes');
  // Exactly what app.js does on a real characteristicvaluechanged: skip the 2-byte packet index.
  const decoded = DSP.decode12Bit(new Uint8Array(packet.buffer, packet.byteOffset + 2));
  assert.deepStrictEqual(decoded, codes, 'every 12-bit code must survive the round trip exactly');
  console.log('✓ pack12Bit is the exact inverse of DSP.decode12Bit across the full 12-bit range');
}

/* 2) MICROVOLTS ROUND-TRIP TO WITHIN ONE QUANTISATION STEP.
 *    The step is 0.48828125 µV, so half a step is the most any value can lose. Asserting a tighter
 *    bound would be asserting something false; asserting a looser one would let a scaling error
 *    through, and a scaling error is exactly what would make a simulated recording look like a
 *    different person's.
 */
{
  const step = 0.48828125;
  for (const uv of [-300, -100, -20, -0.4, 0, 0.4, 20, 100, 300]) {
    const back = DSP.samplesToMicrovolts([SimDevice.uvToCode(uv)])[0];
    assert.ok(Math.abs(back - uv) <= step / 2 + 1e-9,
      `${uv} µV round-tripped to ${back} µV, further than half a quantisation step`);
  }
  // And it CLAMPS rather than wrapping. A wrap would turn a large value into a small one and
  // fabricate a discontinuity no ADC can produce — which the artifact detector would then reject,
  // making the simulator look like a bad electrode.
  assert.strictEqual(SimDevice.uvToCode(99999), 4095, 'above range must clamp to the top code');
  assert.strictEqual(SimDevice.uvToCode(-99999), 0, 'below range must clamp to the bottom code');
  console.log('✓ microvolts survive to within half a quantisation step, and out-of-range clamps');
}

// 3) PPG PACKING ROUND-TRIPS THROUGH THE 24-BIT DECODER.
{
  const vals = [0, 1, 65535, 600000, 16777215];
  const packet = SimDevice.pack24Bit(vals);
  const decoded = DSP.decode24Bit(new Uint8Array(packet.buffer, packet.byteOffset + 2));
  assert.deepStrictEqual(decoded, vals, '24-bit PPG values must round-trip exactly');
  console.log('✓ pack24Bit is the exact inverse of DSP.decode24Bit');
}

/* 4) THE SAMPLE RATE IS RIGHT, AND RIGHT ACROSS UNEVEN TICKS.
 *    Advancing in ragged steps is the realistic case — a browser timer is never on time — and the
 *    count must depend only on total elapsed time, never on how it was chopped up.
 */
{
  const a = SimDevice.createDevice();
  let packets = 0;
  // Deliberately ugly step sizes, none of them a multiple of the packet period.
  for (const ms of [7, 40, 13, 250, 3, 100, 87, 500]) packets += a.advance(ms / 1000).eegPackets;
  const elapsed = (7 + 40 + 13 + 250 + 3 + 100 + 87 + 500) / 1000;
  const expected = Math.floor((elapsed * SimDevice.EEG_HZ) / SimDevice.EEG_PER_PACKET);
  assert.strictEqual(packets, expected,
    `after ${elapsed}s of ragged ticks the count must be ${expected}, not ${packets}`);

  // The same total, in one step, must give the same count — that is the property that guarantees the
  // rate cannot drift with timer jitter.
  const b = SimDevice.createDevice();
  assert.strictEqual(b.advance(elapsed).eegPackets, expected,
    'one big step and many ragged steps must agree');

  // And the rate itself is 256 Hz, not merely self-consistent.
  const c = SimDevice.createDevice();
  const oneSecond = c.advance(1).eegPackets * SimDevice.EEG_PER_PACKET;
  assert.ok(Math.abs(oneSecond - SimDevice.EEG_HZ) <= SimDevice.EEG_PER_PACKET,
    `one second must deliver about ${SimDevice.EEG_HZ} samples, got ${oneSecond}`);
  console.log(`✓ the stream holds ${SimDevice.EEG_HZ} Hz through ragged ticks (${expected} packets`
    + ` either way)`);
}

/* 5) THE ARC IS REAL: measurably more alpha when settled than when restless, measured with the app's
 *    own spectrum code rather than by inspecting the generator's parameters. Checking the parameters
 *    would only prove the constants are what they are; the question is whether the SIGNAL carries it
 *    through packing, quantisation and the spectrum.
 */
{
  const rnd = () => 0;                          // noise off: this is a claim about the arc, not luck
  function bandPowerAt(centreSec) {
    const n = 1024;                             // 4 s at 256 Hz — the lab's window length
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t = centreSec + i / SimDevice.EEG_HZ;
      const code = SimDevice.uvToCode(SimDevice.sampleUv(0, t, SimDevice.settledAt(t), rnd));
      samples.push(DSP.samplesToMicrovolts([code])[0]);
    }
    const spec = DSP.averageSpectrum(samples, SimDevice.EEG_HZ, { windowSec: 4 });
    assert.ok(spec.power, `the spectrum must be computable (${spec.reason})`);
    const power = (lo, hi) => {
      let sum = 0;
      for (let i = 1; i < spec.power.length; i++) {
        const f = i * spec.binHz;
        if (f >= lo && f < hi) sum += spec.power[i];
      }
      return sum;
    };
    return { alpha: power(8, 13), beta: power(13, 30) };
  }
  // The arc is a raised cosine over ARC_SEC: 0 is the restless trough, half the period is the
  // settled peak.
  const restless = bandPowerAt(0);
  const settled = bandPowerAt(SimDevice.ARC_SEC / 2);
  assert.ok(settled.alpha > restless.alpha * 3,
    `settled alpha must clearly exceed restless alpha (${settled.alpha.toFixed(1)} vs`
    + ` ${restless.alpha.toFixed(1)})`);
  assert.ok(settled.beta < restless.beta,
    `and beta must move the other way (${settled.beta.toFixed(1)} vs ${restless.beta.toFixed(1)})`);
  // Alpha/beta ratio is the basis of the calm metric, so that is the ratio that has to swing.
  const ratio = (b) => b.alpha / b.beta;
  assert.ok(ratio(settled) > ratio(restless) * 5,
    `the alpha/beta ratio must swing across the arc (${ratio(settled).toFixed(2)} vs`
    + ` ${ratio(restless).toFixed(2)})`);
  console.log(`✓ the arc swings alpha/beta from ${ratio(restless).toFixed(2)} restless to`
    + ` ${ratio(settled).toFixed(2)} settled`);
}

/* 6) THE WHOLE INDIVIDUAL-ALPHA PATH RUNS ON SIMULATED DATA, AND RECOVERS THE PEAK IT WAS GIVEN.
 *
 *    This test is why the simulator's alpha is a band and not a sine. Every gate has to pass on the
 *    same signal — a real 1/f background for `spectralBackground` to fit, enough prominence above it,
 *    a hump at least 1.0 Hz wide, and enough clean windows — and the recovered centre has to be the
 *    one that was put in. The peak sits BETWEEN bins (10.125 Hz against 0.25 Hz bins), so a
 *    centre-of-gravity estimate that had silently degenerated to argmax would land on a bin centre
 *    and be caught here.
 *
 *    Sixty seconds because IAF_MIN_WINDOWS is 20 and 50%-overlapped 4-second windows need about 42
 *    seconds to reach it. Forty seconds gave 19 and the peak was refused — which is the gate working,
 *    and worth recording as the reason for the length rather than leaving it as a magic number.
 */
{
  const rnd = () => 0;
  const n = SimDevice.EEG_HZ * 60;
  const samples = [];
  const centre = SimDevice.ARC_SEC / 2;         // the settled end, where alpha is strongest
  for (let i = 0; i < n; i++) {
    const t = centre + i / SimDevice.EEG_HZ;
    samples.push(DSP.samplesToMicrovolts([SimDevice.uvToCode(SimDevice.sampleUv(0, t, SimDevice.settledAt(t), rnd))])[0]);
  }
  // Nothing in this signal may be mistaken for a bad electrode, at either bound.
  assert.strictEqual(DSP.isArtifact(samples), false, 'the simulated signal must not read as an artifact');
  assert.strictEqual(DSP.isFlat(samples), false, 'nor as a dead channel');

  const spec = DSP.averageSpectrum(samples, SimDevice.EEG_HZ, { windowSec: 4 });
  assert.ok(spec.power, `the spectrum must be computable (${spec.reason})`);
  assert.strictEqual(spec.skipped, 0, 'and no window may be thrown away');

  const bg = DSP.spectralBackground(spec);
  assert.ok(bg, 'a 1/f background must be fittable — without one the IAF path is unreachable');
  assert.ok(bg.b < -0.4 && bg.b > -1.6,
    `the fitted slope must look like a real background, got ${bg.b.toFixed(2)}`);

  const peak = DSP.individualAlphaPeak(spec);
  assert.ok(peak && peak.found, `a peak must be found (${peak && peak.reason})`);
  assert.ok(peak.widthHz >= 1,
    `the hump must clear the 1 Hz width gate, got ${peak.widthHz} Hz — a narrower one is a spectral`
    + ' line, which is what mains hum looks like');
  /* cogHz, not freqHz. freqHz is the winning BIN and can only ever be a multiple of 0.25; cogHz is
     the centre of gravity across the hump and is the number the app actually reports. Asserting
     against freqHz would be asserting that a bin index is close to 10.125, which it cannot help
     being. */
  assert.ok(Math.abs(peak.cogHz - SimDevice.ALPHA_CENTRE_HZ) < 0.2,
    `the centre of gravity must land on the ${SimDevice.ALPHA_CENTRE_HZ} Hz it was built around, got`
    + ` ${peak.cogHz.toFixed(3)} Hz`);
  // And it must be BETWEEN bins. Landing exactly on one would mean the interpolation collapsed to
  // argmax, which is the failure this off-bin centre frequency exists to expose.
  assert.ok(Math.abs((peak.cogHz / spec.binHz) - Math.round(peak.cogHz / spec.binHz)) > 0.05,
    `the recovered centre (${peak.cogHz}) sits on a bin centre, so no interpolation ran`);
  console.log(`✓ the full IAF path runs on simulated data and recovers ${peak.cogHz.toFixed(3)} Hz`
    + ` from a ${SimDevice.ALPHA_CENTRE_HZ} Hz band (${peak.widthHz} Hz wide, prominence`
    + ` ${peak.prominence.toFixed(1)}×, background slope ${bg.b.toFixed(2)})`);
}

/* 7) IT ONLY RUNS WHEN ASKED. The unrecoverable failure mode, so the accepted forms are enumerated
 *    and everything nearby is checked to be refused — including the shapes a typo or a stale
 *    bookmark would produce.
 */
{
  for (const yes of ['?sim=1', '?sim=true', '?sim=yes', '?a=b&sim=1', '?sim=1&a=b', '?SIM=1']) {
    assert.strictEqual(SimDevice.requested(yes), true, `${yes} must enable the simulator`);
  }
  for (const no of ['', '?', '?sim=0', '?sim', '?sim=', '?sim=2', '?simulate=1', '?nosim=1',
    '?xsim=1', '?sim=1x', '?asim=1', null, undefined]) {
    assert.strictEqual(SimDevice.requested(no), false,
      `${JSON.stringify(no)} must NOT enable the simulator`);
  }
  console.log('✓ the simulator runs only for an explicit sim=1, and nothing adjacent to it');
}

/* 8) `active` IS FALSE UNTIL INSTALLED AND FALSE AGAIN AFTER STOPPING.
 *    The page reads this flag to decide whether to show the banner and whether to stamp a recording
 *    as simulated. If it could be true without the simulator running the app would cry wolf; if it
 *    could be false while the simulator ran, invented data would be recorded unmarked. The second is
 *    the one that matters, so it is asserted at every step.
 */
{
  assert.strictEqual(SimDevice.active, false, 'nothing is simulated until something installs it');
  // A stand-in host, so the test never touches the real navigator: install() replaces
  // navigator.bluetooth, and a test that leaked that would corrupt every suite run after it.
  const host = { navigator: {}, setInterval: () => 1, clearInterval: () => {} };
  const handle = SimDevice.install({ target: host, autoStart: false });
  assert.strictEqual(SimDevice.active, true, 'install() must mark the session simulated');
  assert.ok(host.navigator.bluetooth, 'and must put a bluetooth surface on the host');
  handle.stop();
  assert.strictEqual(SimDevice.active, false, 'stop() must clear the flag');
  assert.strictEqual(host.navigator.bluetooth, undefined,
    'and must remove a bluetooth surface it invented rather than leaving a fake one behind');
  console.log('✓ the simulated flag tracks the simulator exactly, and install() is reversible');
}

/* 9) THE FAKE DEVICE ANSWERS THE SURFACE app.js ACTUALLY USES, and refuses what a real one refuses.
 *    The PPG path in connect() depends on getCharacteristic THROWING NotFoundError for a missing
 *    characteristic — that is how PPG stays optional. A fake that returned undefined instead would
 *    turn an optional feature into a crash, and only on the simulated path, which is the worst place
 *    for a difference to live.
 */
{
  (async () => {
    const s = SimDevice.createDevice();
    const gatt = await s.device.gatt.connect();
    assert.strictEqual(gatt.connected, true, 'connect() must report a connection');
    const service = await gatt.getPrimaryService(DSP.MUSE_SERVICE);
    const control = await service.getCharacteristic(DSP.CONTROL_CHARACTERISTIC);
    await control.startNotifications();
    for (const cmd of ['h', 'p50', 's', 'd']) await control.writeValue(DSP.encodeCommand(cmd));
    assert.deepStrictEqual(s.commands, ['h', 'p50', 's', 'd'],
      'the start sequence must arrive at the device, decoded from the wire format');

    await assert.rejects(() => service.getCharacteristic('not-a-real-uuid'),
      (e) => e.name === 'NotFoundError',
      'a missing characteristic must throw NotFoundError, as a real device does');

    // Events must carry a DataView positioned exactly as the app expects, and adding two listeners
    // must reach both — a hand-rolled single-slot handler would silently drop one.
    const eeg = await service.getCharacteristic(DSP.EEG_CHARACTERISTICS[0]);
    await eeg.startNotifications();
    let seen = 0;
    let samples = null;
    eeg.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      samples = DSP.decode12Bit(new Uint8Array(v.buffer, v.byteOffset + 2));
      seen++;
    });
    eeg.addEventListener('characteristicvaluechanged', () => { seen += 100; });
    s.advance(1);
    assert.ok(seen >= 101, `both listeners must fire (saw ${seen})`);
    assert.strictEqual(samples.length, SimDevice.EEG_PER_PACKET, '12 samples per packet');
    assert.ok(samples.every((c) => c >= 0 && c <= 4095), 'every code inside the 12-bit range');

    // Disconnecting must fire the event the app listens for to tear the session down.
    let disconnected = false;
    s.device.addEventListener('gattserverdisconnected', () => { disconnected = true; });
    s.device.gatt.disconnect();
    assert.strictEqual(disconnected, true, 'disconnect() must fire gattserverdisconnected');

    console.log('✓ the fake device answers the real Web Bluetooth surface, throws NotFoundError for a'
      + ' missing characteristic, and announces disconnection');
    console.log('\nAll simulated-device tests passed.');
  })().catch((e) => { console.error(e); process.exit(1); });
}
