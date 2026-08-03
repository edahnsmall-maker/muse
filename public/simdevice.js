/*
 * A SIMULATED MUSE, SO "IT'S BROKEN" CAN BE ANSWERED IN ONE CLICK.
 *
 * WHY THIS EXISTS. Three times now the report has been "none of the panels open", and each time it
 * took a long round trip to find out whether the app was broken or the headband simply wasn't
 * streaming. Those two produce the identical screen: every panel in this app is hidden until a
 * Bluetooth connection succeeds, so a page that is working perfectly and a page that died during
 * script evaluation look exactly alike until data arrives.
 *
 * That ambiguity is the bug. With this module, `direct.html?sim=1` connects to a fake headband and
 * streams fabricated EEG. If the panels open, the app is fine and the problem is the device or the
 * connection. If they do not, the build is broken. One reload, and the question is settled.
 *
 * It also closes a test gap: `test-ui.js` could never exercise anything downstream of a successful
 * connect, because headless Chromium has no Bluetooth. Everything from `pushSamples` to the metrics
 * table to the visuals was unreachable by the suite — which is precisely where the escaped bugs
 * were.
 *
 * HONESTY IS THE HARD REQUIREMENT. Fabricated data that could be mistaken for a sit would be far
 * worse than no simulator: it would put invented numbers into the analysis lab, where they would be
 * indistinguishable from real ones and would quietly corrupt every comparison built on them. So:
 *
 *   * the simulator only runs when the URL asks for it, never by default and never as a fallback;
 *   * `SimDevice.active` is true whenever it is running, so the page can say so on screen;
 *   * anything recorded while it runs is expected to be stamped as simulated by the caller.
 *
 * WHAT IT EMITS. Real Muse packets, byte-for-byte in the same layout the app already decodes: a
 * 2-byte packet index followed by twelve 12-bit samples packed three bytes per two samples. It goes
 * through `DSP.decode12Bit` on the way in exactly like a real headband's does, so this is not a
 * shortcut around the decoder — the decoder is still under test.
 *
 * THE SIGNAL IS SCRIPTED, NOT RANDOM. Noise would prove the pipe is open and nothing else. A slow
 * arc from restless to settled and back exercises the thing that actually matters: whether the
 * metrics and visuals MOVE, and move in the direction the arc says they should. A simulator whose
 * output is stationary cannot tell a live display from a frozen one.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./dsp.js'));
  else root.SimDevice = factory(root.DSP);
})(typeof window !== 'undefined' ? window : globalThis, function (DSP) {

  const EEG_HZ = 256;
  const EEG_PER_PACKET = 12;
  const PPG_HZ = 64;
  const PPG_PER_PACKET = 6;

  /*
   * The arc, in seconds for a full round trip.
   *
   * Ninety seconds rather than the length of a real sit: the point is to see the display respond
   * within the time someone spends checking whether the app works. A ten-minute arc would be more
   * realistic and completely useless for that.
   */
  const ARC_SEC = 90;

  /*
   * PEAK microvolts, not RMS, at each end of the arc.
   *
   * Peak because the constraint that actually bites is peak-to-peak: DSP.isArtifact rejects any
   * window wider than 150 µV, and DSP.isFlat rejects any narrower than 3 µV. Expressed as peaks these
   * gains can be added up, and the worst case is 30 + 16 + 14 = 60 µV, so 120 µV peak-to-peak — under
   * the ceiling with room to spare, and twenty times over the floor. Expressed as RMS the same
   * numbers would leave the peak-to-peak depending on how the phases happened to line up, which is
   * how a simulator ends up intermittently flagged as an artifact.
   */
  const ALPHA_RESTLESS_UV = 6;
  const ALPHA_SETTLED_UV = 30;
  // Beta runs the other way, which is the whole basis of the calm metric.
  const BETA_RESTLESS_UV = 16;
  const BETA_SETTLED_UV = 5;
  /*
   * The 1/f background, present at both ends and unchanging.
   *
   * Not decoration. `DSP.spectralBackground` fits a straight line through log10(power) against
   * log10(frequency) and `individualAlphaPeak` measures the alpha hump's prominence ABOVE that line.
   * Without a real 1/f floor there is no line to fit — log of an empty bin is not a number — and the
   * whole individual-alpha path is unreachable under simulation, which is where a regression in it
   * would hide.
   */
  const BACKGROUND_UV = 14;

  /*
   * The two ends of the head differ, because the app reports and compares channels separately and a
   * simulator that made all four identical would hide anything that treats them as distinct. The
   * frontal pair sees more beta (they sit above the eyes and catch muscle activity); the temporal
   * pair carries more alpha. This is the qualitative pattern of real Muse recordings, not a
   * calibration claim.
   */
  const CHANNEL_GAIN = [
    { alpha: 1.15, beta: 0.85 },   // TP9
    { alpha: 0.85, beta: 1.20 },   // AF7
    { alpha: 0.85, beta: 1.20 },   // AF8
    { alpha: 1.15, beta: 0.85 },   // TP10
  ];

  function seededRandom(seed) {
    let s = (seed | 0) || 1;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  }

  /*
   * The inverse of DSP.decode12Bit, deliberately written as its inverse rather than independently.
   * Two samples share three bytes: the first takes a whole byte plus the high nibble of the next,
   * the second takes the low nibble plus a whole byte.
   */
  function pack12Bit(samples) {
    const out = new Uint8Array(2 + (samples.length * 3) / 2);
    out[0] = 0; out[1] = 1;                       // packet index; the app skips these two bytes
    let o = 2;
    for (let i = 0; i < samples.length; i += 2) {
      const a = samples[i] & 0xfff;
      const b = samples[i + 1] & 0xfff;
      out[o++] = a >> 4;
      out[o++] = ((a & 0xf) << 4) | (b >> 8);
      out[o++] = b & 0xff;
    }
    return out;
  }

  // Microvolts back to the unsigned 12-bit code DSP.samplesToMicrovolts expects, clamped because a
  // real ADC clamps: letting a big value wrap around to a small one would fabricate a discontinuity
  // the hardware cannot produce.
  function uvToCode(uv) {
    return Math.max(0, Math.min(4095, Math.round(uv / 0.48828125 + 0x800)));
  }

  function pack24Bit(values) {
    const out = new Uint8Array(2 + values.length * 3);
    out[0] = 0; out[1] = 1;
    let o = 2;
    for (const v of values) {
      out[o++] = (v >> 16) & 0xff;
      out[o++] = (v >> 8) & 0xff;
      out[o++] = v & 0xff;
    }
    return out;
  }

  /*
   * How settled the simulated meditator is at time t, from 0 (restless) to 1 (settled).
   *
   * A raised cosine rather than a sawtooth: a discontinuity at the turn would show up in every
   * spectrum as broadband energy and would be indistinguishable from an artifact, so the simulator
   * would be manufacturing the very thing the app tries to reject.
   */
  function settledAt(t) {
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / ARC_SEC);
  }

  /*
   * WHY THE ALPHA IS NOT A SINE, which is the one thing about this file worth reading twice.
   *
   * The first version of this simulator used a single 10.2 Hz sine for alpha. It looked right, its
   * band power was right, and `DSP.individualAlphaPeak` refused to find a peak in it — correctly. The
   * IAF gates require a peak at least 1.0 Hz WIDE at half prominence, and that gate is there
   * precisely to reject narrow spectral lines, because a narrow line is what mains hum, a bad
   * electrode or a nearby motor produces, not a brain rhythm. A pure tone is exactly the artifact the
   * gate was written to catch, so a simulator built from pure tones cannot exercise the alpha path at
   * all — the very path most likely to regress unnoticed.
   *
   * So each band is a BAND: a bank of closely spaced components under a Gaussian envelope, giving a
   * hump about 2 Hz wide for alpha and much broader for beta, which is the shape a real resting
   * spectrum has.
   *
   * PRECOMPUTED AND LOOPED, for two reasons. Evaluating ~250 sines per sample at 256 Hz across four
   * channels is 250,000 calls a second, which is real work for no gain. And every component frequency
   * is a multiple of 1/TABLE_SEC, so the table is exactly periodic and the loop point is seamless — a
   * table that did not close on itself would put a click into the signal every eight seconds, which
   * is broadband energy the artifact detector would flag, and the simulator would spend its life
   * looking like a loose electrode.
   */
  const TABLE_SEC = 8;
  const TABLE_N = TABLE_SEC * EEG_HZ;
  const TABLE_STEP_HZ = 1 / TABLE_SEC;          // the finest frequency that closes on the table

  // Snap to the table's frequency grid, so periodicity is a property of the code rather than of
  // whoever last edited a constant.
  function onGrid(hz) { return Math.round(hz / TABLE_STEP_HZ) * TABLE_STEP_HZ; }

  function gaussianBank(centreHz, widthHz, spanHz, stepHz) {
    const out = [];
    for (let hz = centreHz - spanHz; hz <= centreHz + spanHz + 1e-9; hz += stepHz) {
      const f = onGrid(hz);
      if (f <= 0) continue;
      const d = f - centreHz;
      out.push({ hz: f, amp: Math.exp(-(d * d) / (2 * widthHz * widthHz)) });
    }
    return out;
  }

  /*
   * 10.125 Hz, deliberately BETWEEN bins.
   *
   * The lab analyses 4-second windows, so bins are 0.25 Hz apart and their centres are multiples of
   * 0.25. A peak at 10.0 or 10.25 would sit exactly on a bin centre, where a centre-of-gravity
   * estimate that had stopped working would still return the right answer by accident. 10.125 is
   * halfway between two bins and still on the table's 0.125 Hz grid.
   */
  const ALPHA_CENTRE_HZ = onGrid(10.125);
  const BETA_CENTRE_HZ = onGrid(20.125);

  const ALPHA_BANK = gaussianBank(ALPHA_CENTRE_HZ, 0.95, 3.0, TABLE_STEP_HZ);
  const BETA_BANK = gaussianBank(BETA_CENTRE_HZ, 3.2, 7.0, 0.25);

  /*
   * The 1/f background, from 0.5 Hz to just below the useful ceiling.
   *
   * The exponent is 0.9 rather than exactly 1: real EEG backgrounds sit a little shallower than 1/f,
   * and `spectralBackground` fits the slope rather than assuming it, so giving it exactly the slope it
   * would default to would be testing nothing. 45 Hz is where it stops because the Muse's own
   * filtering makes anything above that meaningless.
   */
  const BACKGROUND_BANK = (() => {
    const out = [];
    for (let hz = 0.5; hz <= 45 + 1e-9; hz += 0.25) out.push({ hz: onGrid(hz), amp: Math.pow(hz, -0.9) });
    return out;
  })();

  /*
   * Build one looping waveform, peak-normalised to 1.
   *
   * Peak rather than RMS so the gains that use it are peak microvolts and can simply be added up to
   * bound the peak-to-peak — see the note on the gain constants.
   */
  function buildTable(bank, phaseSeed) {
    const rnd = seededRandom(phaseSeed);
    const table = new Float64Array(TABLE_N);
    for (const { hz, amp } of bank) {
      // Random phases, seeded. Aligned phases would make every component crest together and turn a
      // broadband hum into an impulse train — a spectrum that is right and a waveform that is not.
      const phase = (rnd() + 0.5) * 2 * Math.PI;
      const w = (2 * Math.PI * hz) / EEG_HZ;
      for (let i = 0; i < TABLE_N; i++) table[i] += amp * Math.sin(w * i + phase);
    }
    let peak = 0;
    for (let i = 0; i < TABLE_N; i++) peak = Math.max(peak, Math.abs(table[i]));
    if (peak > 0) for (let i = 0; i < TABLE_N; i++) table[i] /= peak;
    return table;
  }

  // One set of tables per channel, with different phases, so the four channels are not copies of each
  // other — the app compares them (alpha asymmetry, blink-vs-jaw correlation) and identical channels
  // would make those comparisons trivially clean in a way no real headband is.
  const TABLES = [0, 1, 2, 3].map((ch) => ({
    alpha: buildTable(ALPHA_BANK, 101 + ch * 17),
    beta: buildTable(BETA_BANK, 211 + ch * 23),
    background: buildTable(BACKGROUND_BANK, 307 + ch * 29),
  }));

  /*
   * One channel's microvolt value at one instant.
   *
   * `rnd` is still accepted and still used, at a level well under the quantisation-plus-background
   * floor: it breaks the exact periodicity of the loop without adding enough broadband energy to
   * matter. A test that wants a perfectly repeatable spectrum passes a rnd that returns 0.
   */
  function sampleUv(channel, t, settled, rnd) {
    const g = CHANNEL_GAIN[channel] || CHANNEL_GAIN[0];
    const tab = TABLES[channel] || TABLES[0];
    const alphaUv = (ALPHA_RESTLESS_UV + (ALPHA_SETTLED_UV - ALPHA_RESTLESS_UV) * settled) * g.alpha;
    const betaUv = (BETA_RESTLESS_UV + (BETA_SETTLED_UV - BETA_RESTLESS_UV) * settled) * g.beta;
    // Round rather than floor, and wrap: t is derived from an integer sample index, so this lands
    // exactly on a table entry and the wrap is the seam the table was built to make invisible.
    const i = ((Math.round(t * EEG_HZ) % TABLE_N) + TABLE_N) % TABLE_N;
    return alphaUv * tab.alpha[i]
      + betaUv * tab.beta[i]
      + BACKGROUND_UV * tab.background[i]
      + (rnd ? 1.5 * rnd() : 0);
  }

  /*
   * The fake device, over exactly the surface `connect()` in app.js touches: requestDevice, gatt,
   * one service, characteristics with startNotifications/writeValue, and events carrying a DataView.
   *
   * EventTarget rather than a hand-rolled listener list, so `addEventListener` behaves the way the
   * app's real code path expects — including being able to add two listeners, which a naive
   * `onvaluechanged` slot would silently drop.
   */
  function createDevice({ seed = 7 } = {}) {
    const rnd = seededRandom(seed);
    const chars = new Map();
    const uuids = [DSP.CONTROL_CHARACTERISTIC].concat(DSP.EEG_CHARACTERISTICS, DSP.PPG_CHARACTERISTICS);
    const commands = [];
    const subscribed = [];

    for (const uuid of uuids) {
      const target = new EventTarget();
      target.uuid = uuid;
      target.value = null;
      target.startNotifications = async () => { subscribed.push(uuid); return target; };
      target.stopNotifications = async () => target;
      target.writeValue = async (buffer) => {
        /* The wire format is length-prefixed ASCII, and the prefix OVERWRITES the leading 'X':
           encodeCommand builds "X<cmd>\n" and then sets byte 0 to the length, so 'h' goes out as
           [2, 'h', '\n'] — the 'X' is a placeholder for the length byte, not a marker that survives.
           Reading from byte 2, as an obvious-looking implementation does, silently drops every
           single-character command and pushes empty strings instead. That is what this did first. */
        const bytes = new Uint8Array(buffer.buffer || buffer);
        commands.push(String.fromCharCode.apply(null, Array.from(bytes.slice(1, bytes.length - 1))));
      };
      target.emit = (bytes) => {
        target.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        target.dispatchEvent(new Event('characteristicvaluechanged'));
      };
      chars.set(uuid, target);
    }

    const service = {
      uuid: DSP.MUSE_SERVICE,
      async getCharacteristic(uuid) {
        const c = chars.get(uuid);
        // A real device throws NotFoundError for a characteristic it lacks, and app.js relies on
        // that to make PPG optional. Returning undefined instead would break that path.
        if (!c) throw new DOMException('simulated device has no characteristic ' + uuid, 'NotFoundError');
        return c;
      },
    };

    const device = new EventTarget();
    device.name = 'Muse-SIM';
    device.id = 'simulated-muse';
    device.gatt = {
      connected: false,
      device,
      async connect() { this.connected = true; return this; },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      },
      async getPrimaryService(uuid) {
        if (uuid !== DSP.MUSE_SERVICE) throw new DOMException('no such service', 'NotFoundError');
        return service;
      },
    };

    /* Packets are emitted by how many are DUE, not one per timer tick.
     *
     * 256 Hz in twelve-sample packets is 21.33 packets a second — a period of 46.875 ms, which no
     * timer will honour. Firing one packet per tick would silently run the stream slow, and every
     * frequency the app measured would be shifted by the ratio. Deriving the count from elapsed time
     * keeps the sample RATE right, which is the only thing the spectra depend on.
     */
    let elapsedSec = 0;
    let eegPacketsSent = 0;
    let ppgPacketsSent = 0;

    function advance(seconds) {
      elapsedSec += seconds;
      const eegDue = Math.floor((elapsedSec * EEG_HZ) / EEG_PER_PACKET) - eegPacketsSent;
      for (let p = 0; p < eegDue; p++) {
        const startSample = (eegPacketsSent + p) * EEG_PER_PACKET;
        for (let ch = 0; ch < DSP.EEG_CHARACTERISTICS.length; ch++) {
          const codes = [];
          for (let i = 0; i < EEG_PER_PACKET; i++) {
            const t = (startSample + i) / EEG_HZ;
            codes.push(uvToCode(sampleUv(ch, t, settledAt(t), rnd)));
          }
          chars.get(DSP.EEG_CHARACTERISTICS[ch]).emit(pack12Bit(codes));
        }
      }
      eegPacketsSent += eegDue;

      const ppgDue = Math.floor((elapsedSec * PPG_HZ) / PPG_PER_PACKET) - ppgPacketsSent;
      for (let p = 0; p < ppgDue; p++) {
        const startSample = (ppgPacketsSent + p) * PPG_PER_PACKET;
        const values = [];
        for (let i = 0; i < PPG_PER_PACKET; i++) {
          const t = (startSample + i) / PPG_HZ;
          /* A pulse near 60 bpm with a slow respiratory swing on top, because that swing is what the
             breathing estimate is derived from. Centred well inside the 24-bit range so nothing
             clips. */
          const bpm = 60 + 4 * Math.sin((2 * Math.PI * t) / 12);
          values.push(Math.round(600000
            + 25000 * Math.sin((2 * Math.PI * bpm * t) / 60)
            + 6000 * Math.sin((2 * Math.PI * t) / 12)));
        }
        chars.get(DSP.PPG_CHARACTERISTICS[1]).emit(pack24Bit(values));
      }
      ppgPacketsSent += ppgDue;

      return { eegPackets: eegDue, ppgPackets: ppgDue };
    }

    return {
      device, service, chars, commands, subscribed, advance,
      elapsed: () => elapsedSec,
      packetsSent: () => ({ eeg: eegPacketsSent, ppg: ppgPacketsSent }),
    };
  }

  /*
   * Take over navigator.bluetooth and start streaming.
   *
   * `interval` drives the clock in the browser. In a test, pass `autoStart: false` and call
   * `advance()` directly — a simulator that can only run in real time makes every test that uses it
   * slow and flaky, and a thirty-second arc would mean a thirty-second test.
   */
  function install({ target, seed = 7, tickMs = 40, autoStart = true, setInterval: si } = {}) {
    const host = target || (typeof window !== 'undefined' ? window : globalThis);
    const sim = createDevice({ seed });
    const previous = host.navigator && Object.getOwnPropertyDescriptor(host.navigator, 'bluetooth');

    // defineProperty rather than assignment: navigator.bluetooth is an accessor with no setter in a
    // real browser, and a plain assignment to it fails SILENTLY in sloppy mode — which would leave
    // the simulator apparently installed and completely absent.
    Object.defineProperty(host.navigator, 'bluetooth', {
      configurable: true,
      get: () => ({
        async requestDevice() { return sim.device; },
        async getAvailability() { return true; },
        addEventListener() {}, removeEventListener() {},
      }),
    });

    let timer = null;
    if (autoStart) {
      const schedule = si || host.setInterval.bind(host);
      timer = schedule(() => sim.advance(tickMs / 1000), tickMs);
    }

    api.active = true;
    return {
      sim,
      advance: (seconds) => sim.advance(seconds),
      stop() {
        if (timer != null && host.clearInterval) host.clearInterval(timer);
        timer = null;
        if (previous) Object.defineProperty(host.navigator, 'bluetooth', previous);
        else delete host.navigator.bluetooth;
        api.active = false;
      },
    };
  }

  /*
   * Should the simulator run at all?
   *
   * Only when the URL says so. Not on a missing-Bluetooth fallback, not on an error, not on a flag
   * in storage that could outlive the session that set it — every one of those is a way for
   * fabricated data to appear when nobody asked for it, and the person sitting there would have no
   * signal that what they were watching was invented.
   */
  function requested(search) {
    const q = String(search == null ? '' : search);
    return /(?:^|[?&])sim=(1|true|yes)(?:&|$)/i.test(q);
  }

  const api = {
    install, requested, createDevice, pack12Bit, pack24Bit, uvToCode, settledAt, sampleUv,
    ARC_SEC, EEG_HZ, PPG_HZ, EEG_PER_PACKET, PPG_PER_PACKET,
    ALPHA_RESTLESS_UV, ALPHA_SETTLED_UV, BETA_RESTLESS_UV, BETA_SETTLED_UV, BACKGROUND_UV,
    ALPHA_CENTRE_HZ, BETA_CENTRE_HZ, TABLE_SEC,
    // Read by the page to decide whether to show the simulated-data banner and to stamp recordings.
    // Starts false and is only ever set by install(), so nothing can be marked simulated by accident
    // and — more importantly — nothing simulated can go unmarked.
    active: false,
  };
  return api;
});
