/*
 * Real-browser DOM tests for direct.html.
 *
 * WHY THIS EXISTS
 * Every other suite here tests pure logic. Nothing tested the PAGE, and a bug
 * escaped straight to the user's hands because of it: the device buttons lived
 * inside the same element that setStatus() overwrites, so the first status
 * message deleted them from the DOM. "Connect to Muse" became unpressable, and
 * the heart-strap button became unreachable. No amount of unit-testing the
 * signal maths could have caught that.
 *
 * Chromium is already present (Playwright), so the page can just be loaded and
 * poked at. These are lifecycle assertions, not visual ones — screenshots are
 * tools/shoot.js's job.
 */
const path = require('path');
const assert = require('assert');
const Module = require('module');

const GLOBAL_MODULES = '/opt/node22/lib/node_modules';
if (!Module.globalPaths.includes(GLOBAL_MODULES)) Module.globalPaths.push(GLOBAL_MODULES);
Module._initPaths();
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

const PAGE = 'file://' + path.join(__dirname, 'public', 'direct.html');

// Poll for a condition rather than sleeping a fixed amount. The page's own tick
// runs every 250ms, and a fixed sleep that is "obviously long enough" is exactly
// how a suite becomes flaky under load — which is worse than no test, because it
// trains you to ignore failures.
async function waitFor(page, fn, label, timeoutMs = 6000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn);
    if (last) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Headless Chromium has no navigator.bluetooth, and the page correctly removes
  // both device buttons in that case — so stub it before load to exercise the
  // path a real user is on.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'bluetooth', {
      value: { requestDevice: () => new Promise(() => {}) }, configurable: true,
    });
  });
  await page.goto(PAGE);
  await page.waitForTimeout(600);

  assert.deepStrictEqual(errors, [], `the page must load without console errors:\n  ${errors.join('\n  ')}`);
  console.log('✓ direct.html loads without throwing');

  // 1) Both device buttons exist, and neither starts disabled.
  {
    const st = await page.evaluate(() => ({
      connect: !!document.getElementById('connect'),
      strap: !!document.getElementById('connectStrap'),
      connectDisabled: document.getElementById('connect').disabled,
      strapDisabled: document.getElementById('connectStrap').disabled,
    }));
    assert.ok(st.connect && st.strap, 'both device buttons must be present');
    assert.ok(!st.connectDisabled && !st.strapDisabled, 'neither button should start disabled');
    console.log('✓ both device buttons are present and enabled at startup');
  }

  // 2) THE REGRESSION TEST. setStatus() overwrites its element's innerHTML, so
  //    the device buttons must not live inside it. This is the exact call that
  //    used to destroy them.
  {
    // museConnecting mirrors the real path: the picker is open, so the tick must
    // NOT clear the message. Without this the tick wipes it within 250ms — which
    // is correct product behaviour, and was the source of an earlier flaky run.
    await page.evaluate(() => {
      museConnecting = true;
      setStatus('choose your Muse in the browser picker…');
    });
    // Wait for the device bar to have actually re-rendered rather than sleeping a
    // guessed interval: renderDevices() runs on the page's own 250ms tick.
    await waitFor(page, () => document.getElementById('connect').disabled,
      'the headband button to disable while a connection is in flight');
    const st = await page.evaluate(() => ({
      connect: !!document.getElementById('connect'),
      strap: !!document.getElementById('connectStrap'),
      statusText: document.getElementById('status').textContent,
    }));
    assert.ok(st.connect, 'the headband button must SURVIVE a status message');
    assert.ok(st.strap, 'the strap button must SURVIVE a status message');
    assert.ok(/picker/.test(st.statusText),
      'and the message must persist while the picker is open, not be wiped by the tick');
    await page.evaluate(() => { museConnecting = false; });
    await waitFor(page, () => !document.getElementById('connect').disabled,
      'the button to re-enable once the attempt ends');
    console.log('✓ device buttons survive a status message (the bug that made them unpressable)');
  }

  // 3) A transient status message must EXPIRE on its own. The strap's "HRV needs
  //    about 20s of beats" message stuck forever, because the only code that
  //    cleared the status sat behind an early return requiring Muse data — so
  //    with no headband streaming, the app looked frozen.
  {
    await page.evaluate(() => {
      setStatus('heart strap linked — HRV needs about 20s of beats');
      statusLockUntil = Date.now() + 400;
    });
    await waitFor(page, () => {
      const el = document.getElementById('status');
      return el.classList.contains('hidden') && !el.textContent;
    }, 'the transient status message to clear itself');
    console.log('✓ a transient status message expires without any device connected');
  }

  // 4) The device bar keeps rendering on its own timer, independent of EEG data.
  {
    await page.evaluate(() => { museConnecting = true; });
    await waitFor(page, () => /connecting/i.test(document.getElementById('connect').textContent),
      'the device bar to re-render into its connecting state');
    await page.evaluate(() => { museConnecting = false; });
    await waitFor(page, () => /Connect headband/.test(document.getElementById('connect').textContent),
      'the device bar to return to its idle state');
    console.log('✓ the device bar re-renders on its own timer, not off EEG data');
  }

  // 5) Strap-only operation renders a readout. The strap alone measures heart
  //    rate, HRV and a breathing rate, none of which need the headband.
  {
    const st = await page.evaluate(() => {
      // Pretend a strap is connected and feeding beats.
      strapDevice = { gatt: { connected: true } };
      hrBpm = 57;
      for (let i = 0; i < 30; i++) rrBuffer.push(1000 + (i % 2 ? 12 : -12));
      hrvRmssd = Polar.rmssd(rrBuffer.values());
      renderStrapOnlyReadout();
      return {
        html: document.getElementById('readout').textContent,
        shown: document.getElementById('readout').classList.contains('show'),
      };
    });
    assert.ok(st.shown, 'the readout must be visible with only a strap connected');
    assert.ok(/57 bpm/.test(st.html), `heart rate should show (got: ${st.html})`);
    assert.ok(/HRV/.test(st.html), 'HRV should show');
    assert.ok(/not connected/.test(st.html),
      'and it must say the headband is absent rather than implying EEG data exists');
    console.log('✓ a strap-only session renders heart rate, HRV, and says the headband is absent');
  }

  // 6) The breath row is a CENTRED bar: the midpoint is the turnaround, above it
  //    is the in-breath and below it the out-breath. A 0..100 left-to-right fill
  //    would render an exhale as a low score, which is a different claim.
  {
    const inhale = await page.evaluate(() => {
      breathAmount = 0.8; breathRising = true;
      const el = document.createElement('div');
      el.innerHTML = breathRow();
      const fill = el.querySelector('.rBarC i');
      return { cls: fill.className, height: fill.style.width, text: el.textContent };
    });
    assert.strictEqual(inhale.cls, 'rt', 'a positive breath amount must fill RIGHT of centre');
    assert.strictEqual(inhale.height, '40%', 'and reach 40% of the bar width for an amount of 0.8 (half-range)');
    assert.ok(/in/.test(inhale.text), 'and be labelled as an in-breath');
    // Exactly ONE row. An earlier version rendered breath as a composite bar, a
    // rate row AND a phase bar — three rows all labelled "Breath".
    const rowCount = await page.evaluate(() => {
      const el = document.createElement('div');
      el.innerHTML = breathRow();
      return el.querySelectorAll('.rRow').length;
    });
    assert.strictEqual(rowCount, 1, 'breath must be exactly one row');

    const exhale = await page.evaluate(() => {
      breathAmount = -0.6; breathRising = false;
      const el = document.createElement('div');
      el.innerHTML = breathRow();
      const fill = el.querySelector('.rBarC i');
      return { cls: fill.className, height: fill.style.width, text: el.textContent };
    });
    assert.strictEqual(exhale.cls, 'lf', 'a negative breath amount must fill LEFT of centre');
    assert.strictEqual(exhale.height, '30%');
    assert.ok(/out/.test(exhale.text), 'and be labelled as an out-breath');

    // No respiratory signal: the bar must be EMPTY rather than parked at the
    // midpoint, and must not claim a direction. "We can't see your breath" and
    // "you're at the turnaround" are different statements.
    const absent = await page.evaluate(() => {
      breathAmount = null; breathRising = null;
      const el = document.createElement('div');
      el.innerHTML = breathRow();
      return { fills: el.querySelectorAll('.rBarC i').length, text: el.textContent };
    });
    assert.strictEqual(absent.fills, 0, 'with no signal the bar must be empty, not sitting at centre');
    assert.ok(!/\b(in|out)\b/.test(absent.text),
      `and must not claim a direction (got: ${absent.text})`);

    // Breath must not ALSO appear as a 0-100 composite row.
    const composites = await page.evaluate(() => activeComposites.slice());
    assert.ok(!composites.includes('breath'),
      'breath must not be a composite readout row as well — an exhale is not a low score');
    console.log('✓ breath is exactly one centred row, empty when there is no signal, not duplicated');
  }

  // 7) Chart series colours must be TELLABLE APART. This has caused the same
  //    confusion twice: TP9's hue was identical to Focus's, so an electrode read
  //    as a dead composite; then breath shipped at an RGB distance of 17 from
  //    Focus, so a correctly-drawn line was invisible on top of another one.
  //    Lines that cannot be distinguished are worse than absent — you conclude
  //    the metric is broken.
  {
    const report = await page.evaluate(() => {
      const hex = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
      const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
      const check = (series) => {
        const worst = [];
        for (let i = 0; i < series.length; i++) {
          for (let j = i + 1; j < series.length; j++) {
            worst.push({
              a: series[i].key, b: series[j].key,
              d: Math.round(dist(hex(series[i].color), hex(series[j].color))),
            });
          }
        }
        return worst.sort((x, y) => x.d - y.d)[0];
      };
      // Only within-group matters: sensors and composites are never shown at once.
      return { sensors: check(SENSOR_SERIES), composites: check(COMPOSITE_SERIES) };
    });
    const MIN = 60;
    for (const [group, w] of Object.entries(report)) {
      assert.ok(w.d >= MIN,
        `${group}: "${w.a}" and "${w.b}" are only ${w.d} apart in RGB — pick a distinguishable colour (min ${MIN})`);
    }
    console.log(`✓ chart colours are distinguishable (closest pair: sensors ${report.sensors.d}, composites ${report.composites.d})`);
  }

  // 8) The accelerometer decode reports its own gravity verdict, and says so
  //    plainly when the decode is wrong. A delta-compressed decode cannot be
  //    validated by a test built from the same assumptions, so the runtime shows
  //    the magnitude and whether it looks like gravity.
  {
    const good = await page.evaluate(() => {
      accAvailable = true;
      accSamples = [{ x: 20, y: -60, z: 998 }, { x: 25, y: -55, z: 1002 },
                    { x: 18, y: -62, z: 995 }, { x: 22, y: -58, z: 1000 }];
      accVerdict = Polar.looksLikeGravity(accSamples);
      accMag = accVerdict.meanMilliG;
      return { ok: accVerdict.ok, mag: Math.round(accMag) };
    });
    assert.ok(good.ok, 'a body at rest must be judged as gravity');
    assert.ok(Math.abs(good.mag - 1000) < 60, `and read near 1000 mG (got ${good.mag})`);

    const bad = await page.evaluate(() => {
      // What a wrong resolution assumption produces: right shape, wrong scale.
      accSamples = [{ x: 1, y: -2, z: 25 }, { x: 1, y: -1, z: 25 }, { x: 0, y: -2, z: 24 }, { x: 1, y: -2, z: 25 }];
      accVerdict = Polar.looksLikeGravity(accSamples);
      accMag = accVerdict.meanMilliG;
      return accVerdict.ok;
    });
    assert.strictEqual(bad, false,
      'a mis-scaled decode must be rejected, however smooth the numbers look');
    await page.evaluate(() => { accAvailable = false; accVerdict = null; accMag = null; accSamples = []; });
    console.log('✓ the accelerometer decode reports its own gravity verdict');
  }

  // 9) READOUT ROWS MUST NOT WRAP. Measured, not eyeballed. This has now broken
  //    twice: once when .rVal had no nowrap so "8/min · strap" split across three
  //    lines, and again when .rRow became a THREE-column grid while breathRow()
  //    still emitted four children, pushing the value onto its own grid row. Both
  //    reached the user. A single-line row is a measurable property, so measure it.
  {
    const rows = await page.evaluate(() => {
      // Values containing a space are the hazard — a bare number always fits.
      const host = document.createElement('div');
      host.id = 'wrapProbe';
      // Same width the real panel gives its rows.
      const readout = document.getElementById('readout');
      host.style.cssText = `position:absolute;left:-9999px;top:0;width:${readout.clientWidth}px;`
        + `font:${getComputedStyle(readout).font};`;
      document.body.appendChild(host);
      breathAmount = 0.5; breathRising = true; strapBreathSec = 10;   // -> "6/min in"
      breathSource = 'rsa'; breathHolding = false;
      host.innerHTML = breathRow();
      const probe = (label) => {
        const r = host.querySelector('.rRow');
        const kids = r.children.length;
        const h = r.getBoundingClientRect().height;
        return { label, kids, h: Math.round(h) };
      };
      const results = [probe('breath rsa')];
      // The chest-motion row: a longer label (it carries a source tag) and a
      // different value. The 3-children rule is easy to break by adding one.
      breathSource = 'chest'; breathHolding = false;
      host.innerHTML = breathRow();
      results.push(probe('breath chest'));
      // And a HELD breath, the state the accelerometer exists to show.
      breathHolding = true;
      host.innerHTML = breathRow();
      const heldRow = host.querySelector('.rRow');
      results.push(Object.assign(probe('breath hold'), {
        text: heldRow.textContent,
        barWidth: heldRow.querySelector('.rBarC i')
          ? heldRow.querySelector('.rBarC i').style.width : null,
        drained: !!heldRow.querySelector('.rBarC i.held'),
      }));
      breathHolding = false; breathSource = null;
      // And a text-valued row from the main helper: "73 bpm" is the case that wrapped.
      host.innerHTML = '<div class="rRow"><span class="rLabel">Heart</span>'
        + '<span class="rBar"></span><span class="rVal">73 bpm</span></div>';
      results.push(probe('heart 73 bpm'));
      host.innerHTML = '<div class="rRow"><span class="rLabel">HRV (RMSSD)</span>'
        + '<span class="rBar"></span><span class="rVal">30 ms</span></div>';
      results.push(probe('hrv 30 ms'));
      host.remove();
      return results;
    });
    for (const r of rows) {
      assert.strictEqual(r.kids, 3,
        `${r.label}: .rRow is a 3-column grid, so a row must have exactly 3 children (has ${r.kids}) — a 4th wraps the value onto its own line`);
      assert.ok(r.h <= 34,
        `${r.label}: row is ${r.h}px tall, so its value wrapped onto a second line (expect a single ~27px row)`);
    }
    // The hold row specifically: a held breath must say so, must KEEP its position
    // (the chest is somewhere — that is the information), and must stop looking
    // live. RSA could not express any of this, which is why holding showed nothing.
    const held = rows.find((r) => r.label === 'breath hold');
    assert.match(held.text, /hold/, 'a held breath must say "hold", not a direction');
    assert.ok(!/\bin\b|\bout\b/.test(held.text),
      `a held breath has no direction, so it must not claim one (got "${held.text}")`);
    assert.strictEqual(held.barWidth, '25%',
      'a hold must keep the bar where the chest actually is, not zero it');
    assert.ok(held.drained, 'a held bar must be visually distinct from a live one');
    await page.evaluate(() => {
      breathAmount = null; breathRising = null; strapBreathSec = null;
      breathSource = null; breathHolding = false;
    });
    console.log(`✓ readout rows stay on one line (${rows.map((r) => r.label + ' ' + r.h + 'px').join(', ')})`);
    console.log(`✓ a held breath reads as "${held.text.trim()}" and keeps its position at ${held.barWidth}`);
  }

  // 10) The strap request MUST declare the PMD service in optionalServices.
  //     Web Bluetooth grants access per-service at pairing time; anything not
  //     declared fails with "Origin is not allowed to access the service" even on a
  //     device you are already connected to. This is exactly why the accelerometer
  //     never started — the decode was fine, the permission was never requested.
  //     Capturing the real options is a direct assertion on the actual cause.
  {
    const opts = await page.evaluate(async () => {
      let captured = null;
      navigator.bluetooth.requestDevice = (o) => {
        captured = o;
        return Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotFoundError' }));
      };
      strapConnecting = false; strapDevice = null;
      await connectStrap();
      return captured;
    });
    assert.ok(opts, 'connectStrap must call requestDevice');
    assert.ok(Array.isArray(opts.optionalServices),
      'the strap request must declare optionalServices');
    const declared = opts.optionalServices.map((u) => String(u).toLowerCase());
    const pmd = await page.evaluate(() => Polar.PMD_SERVICE.toLowerCase());
    assert.ok(declared.includes(pmd),
      `optionalServices must include the PMD service ${pmd} or the accelerometer can never start (got ${JSON.stringify(declared)})`);
    // And the heart rate service must still be the filter, or the picker shows
    // every Bluetooth device in range.
    assert.ok(opts.filters && opts.filters.length, 'must still filter on the heart rate service');
    console.log('✓ the strap request declares the PMD service, so the accelerometer can be reached');
  }

  // 11) Each accelerometer failure mode must read DIFFERENTLY. They have different
  //     fixes, so a single "reading…" for all of them wastes a round trip — which
  //     is exactly what happened.
  {
    const states = await page.evaluate(() => {
      const out = {};
      const reset = () => {
        accAvailable = true; accStartError = null; accFrames = 0; accDecoded = 0;
        accFirstHead = null; accMag = null; accVerdict = null; accVariant = null;
      };
      // The REAL function the readout calls, not a copy of its branch order — a
      // mirrored copy passes while the screen says something else, which is
      // exactly the bug this suite exists to catch.
      const label = () => accStatusText();
      reset(); out.silent = label();
      reset(); accStartError = 5; accVariant = null; out.refused = label();
      reset(); accFrames = 12; accFirstHead = [2, 1]; out.undecodable = label();
      reset(); accVariant = 'count8'; accFrames = 12; accDecoded = 12;
      accSamples = [{ x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: 1000 }];
      accVerdict = Polar.looksLikeGravity(accSamples); accMag = accVerdict.meanMilliG;
      out.working = label();
      accAvailable = false; accFrames = 0; accDecoded = 0; accSamples = []; accVerdict = null; accMag = null;
      return out;
    });
    assert.strictEqual(states.silent, 'no frames', 'accepted but silent must say so');
    assert.strictEqual(states.refused, 'refused 5',
      'a start refused by every variant must name the error code the device returned');
    assert.strictEqual(states.undecodable, '12f t2/1',
      'undecodable frames must report the count and the measurement/frame type bytes');
    assert.ok(/^1000mG/.test(states.working), `a working decode reports the magnitude (got ${states.working})`);
    assert.strictEqual(new Set(Object.values(states)).size, 4,
      'all four states must be distinguishable from each other');
    console.log('✓ each accelerometer failure mode reports something different: '
      + Object.values(states).join(' / '));
  }

  // 12) The strap log button is a debugging affordance, so it must be absent from a
  //     healthy session and present the moment there is something worth sending.
  //     It exists because each round of protocol guesswork otherwise costs a
  //     physical reconnect plus a summary typed by hand, which loses the bytes.
  {
    const seen = await page.evaluate(async () => {
      const btn = document.getElementById('copyStrapLog');
      const out = {};
      strapDevice = { gatt: { connected: true } };
      accStartError = null; accVariant = 'ids 0+1+2'; accNonResponses = 0;
      accFrames = 10; accDecoded = 10; accMag = 1000;
      accVerdict = { meanMilliG: 1000, ok: true };
      renderDevices(); out.healthy = btn.hidden;

      accStartError = 5; accVariant = null;
      renderDevices(); out.refused = btn.hidden;

      // And it must produce the settings response and the attempted bytes, since
      // those are the two things that actually explain a refusal.
      pmdLog.accSettingsRaw = 'f0 01 02 00 00';
      pmdLog.attempts = [{ tag: '50hz/r2/b16/ids 0+1+2', sent: '02 02 00 01 32 00', code: 5 }];
      let copied = null;
      navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
      btn.click();
      await new Promise((r) => setTimeout(r, 50));
      out.copied = copied;

      strapDevice = null; accStartError = null; accFrames = 0; accDecoded = 0;
      accMag = null; accVerdict = null; accVariant = null; pmdLog.attempts = [];
      return out;
    });
    assert.strictEqual(seen.healthy, true,
      'a working accelerometer must not put a debug button in front of a meditator');
    assert.strictEqual(seen.refused, false, 'a refused start must offer the log');
    assert.ok(seen.copied, 'clicking must actually copy something');
    const log = JSON.parse(seen.copied);
    assert.strictEqual(log.accSettingsRaw, 'f0 01 02 00 00',
      'the log must carry the raw settings response');
    assert.strictEqual(log.attempts[0].sent, '02 02 00 01 32 00',
      'the log must carry the exact bytes that were refused');
    assert.strictEqual(log.lastError, 5, 'and the code the device answered with');
    console.log('✓ the strap log is hidden when healthy, offered on refusal, and carries the bytes');
  }

  // 13) DURABLE RECORDING. Until this existed, a page reload destroyed the whole
  //     sit, and raw EEG was never kept at all — only a 2-second rolling buffer.
  //     For a retreat, where the interesting moment happens once, that is the
  //     difference between having data and not.
  {
    const out = await page.evaluate(async () => {
      // A private database per run, so the test never touches real sessions.
      const name = 'zenbio-test-' + Math.floor(performance.now());
      const db = await Recorder.open({ name });
      const started = Date.now();
      const sess = await Recorder.startSession(db, { startedAt: started, note: 'test sit' });

      // Feed each stream something identifiable, across more than one flush, so
      // reassembly across chunk boundaries is exercised rather than assumed.
      const expected = [[], [], [], []];
      for (let round = 0; round < 3; round++) {
        for (let ch = 0; ch < 4; ch++) {
          const block = [];
          for (let i = 0; i < 256; i++) block.push(ch * 1000 + round * 256 + i);
          sess.pushEeg(ch, block);
          expected[ch].push(...block);
        }
        sess.pushAcc([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
        sess.pushRr([812, 799]);
        sess.pushRow({ t: round, calm: 0.5 + round / 10 });
        await sess.flush();
      }
      const noteKey = await sess.addNote({ kind: 'text', text: 'something is happening' });

      // NOT calling end(): this is the crash case. A phone that locks its screen
      // or a tab that gets evicted never gets to run cleanup, so everything
      // flushed so far must already be durable on its own.
      const crash = await Recorder.loadSession(db, sess.id);

      await sess.end();
      const clean = await Recorder.loadSession(db, sess.id);
      const list = await Recorder.listSessions(db);

      // Raw fidelity: a float that survives storage must come back bit-identical,
      // because everything downstream will be recomputed from it.
      const eegOk = clean.eeg.every((chan, ch) =>
        chan.length === expected[ch].length && chan.every((v, i) => v === expected[ch][i]));

      const q = await Recorder.quota();
      await Recorder.deleteSession(db, sess.id);
      const afterDelete = await Recorder.loadSession(db, sess.id);
      db.close();
      return {
        crashSamples: crash.eeg[0].length,
        crashNotes: crash.notes.length,
        eegOk,
        lengths: clean.eeg.map((c) => c.length),
        accFirst: clean.acc[0], accCount: clean.acc.length,
        rrCount: clean.rr.length, rowCount: clean.rows.length,
        noteText: clean.notes[0] && clean.notes[0].text,
        noteHasAbsoluteTime: !!(clean.notes[0] && clean.notes[0].at > 1e12),
        noteOffsetIsNumber: typeof (clean.notes[0] || {}).offsetSec === 'number',
        noteKey: noteKey != null,
        ended: clean.meta.ended, bytes: clean.meta.bytes,
        listed: list.length >= 1,
        deleted: afterDelete === null,
        quota: q ? Math.round(q.quotaBytes / 1e6) : null,
      };
    });

    // The crash case first, because it is the one that matters at a retreat.
    assert.strictEqual(out.crashSamples, 768,
      `a session interrupted WITHOUT end() must still hold everything flushed (got ${out.crashSamples} of 768 samples)`);
    assert.strictEqual(out.crashNotes, 1,
      'a label must be durable the moment it is made, not at the end of the sit');

    assert.ok(out.eegOk, 'raw EEG must round-trip bit-identically across chunk boundaries');
    assert.deepStrictEqual(out.lengths, [768, 768, 768, 768], 'all four channels must survive');
    assert.deepStrictEqual(out.accFirst, [1, 2, 3], 'accelerometer samples must keep their axes');
    assert.strictEqual(out.accCount, 6);
    assert.strictEqual(out.rrCount, 6);
    assert.strictEqual(out.rowCount, 3);
    assert.strictEqual(out.noteText, 'something is happening');
    // Absolute time is what lets a voice note be aligned against a recording made
    // by a DIFFERENT app on the same phone — the iOS fallback path, where Web
    // Bluetooth may be unavailable and the EEG comes from Mind Monitor instead.
    assert.ok(out.noteHasAbsoluteTime,
      'a note must carry absolute wall-clock time, or it cannot be aligned to an external recording');
    assert.ok(out.noteOffsetIsNumber, 'and an offset within the session, for in-app use');
    assert.strictEqual(out.ended, true);
    assert.ok(out.bytes > 12000, `bytes written should reflect 3072 floats (got ${out.bytes})`);
    assert.ok(out.listed, 'the session must appear in the session list');
    assert.strictEqual(out.deleted, true, 'and delete must actually remove it');
    console.log(`✓ sessions persist across a crash: 768 raw samples/channel, notes durable immediately`
      + `${out.quota ? `, ~${out.quota}MB quota available` : ''}`);
  }

  // 14) VOICE NOTES. The retreat-critical path, and the one I cannot test on the
  //     actual phone — so the gesture, the storage and the Blob round-trip are all
  //     pinned here. A note must survive as real audio, not as a record that a
  //     note happened.
  {
    const out = await page.evaluate(async () => {
      // Stub getUserMedia and MediaRecorder: headless Chromium has no microphone,
      // and the thing under test is the gesture -> storage path, not the codec.
      const track = { stopped: false, stop() { this.stopped = true; } };
      // defineProperty, not assignment: mediaDevices is a read-only accessor on
      // Navigator, so `navigator.mediaDevices = ...` silently does nothing. (The
      // real constraint behind this: getUserMedia needs a secure context, exactly
      // like Web Bluetooth — one more reason the phone build has to be HTTPS.)
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        configurable: true, writable: true,
      });
      let live = null;
      window.MediaRecorder = class {
        constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; this._h = {}; live = this; }
        addEventListener(k, f) { this._h[k] = f; }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          this._h.dataavailable({ data: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/webm' }) });
          this._h.stop();
        }
      };
      // A real session to file the note against.
      const db = await Recorder.open({ name: 'zenbio-voice-' + Math.floor(performance.now()) });
      recDb = db;
      recSession = await Recorder.startSession(db, { startedAt: Date.now() - 5000 });
      sessionStartedAt = Date.now() - 5000;

      const btn = document.getElementById('voiceNote');
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const whileRecording = {
        flagged: btn.classList.contains('rec'),
        label: btn.textContent,
        recorderLive: live && live.state === 'recording',
      };
      // Hold past the 0.8s minimum, or it is discarded as a fumbled press.
      await new Promise((r) => setTimeout(r, 900));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));

      const loaded = await Recorder.loadSession(db, recSession.id);
      const note = loaded.notes.find((n) => n.kind === 'voice');
      const bytes = note && note.audio ? new Uint8Array(await note.audio.arrayBuffer()) : null;

      // And a fumbled press must NOT create a note.
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const after = await Recorder.loadSession(db, recSession.id);

      await recSession.end();
      await Recorder.deleteSession(db, recSession.id);
      db.close();
      recSession = null; recDb = null; sessionStartedAt = null;
      return {
        whileRecording,
        micReleased: track.stopped,
        hasNote: !!note,
        seconds: note && note.seconds,
        mime: note && note.mimeType,
        audioBytes: bytes ? Array.from(bytes) : null,
        hasAbsoluteTime: !!(note && note.at > 1e12),
        voiceNoteCount: after.notes.filter((n) => n.kind === 'voice').length,
        restoredLabel: btn.textContent,
      };
    });

    assert.ok(out.whileRecording.flagged, 'the button must show it is live — you cannot see the screen mid-sit');
    assert.match(out.whileRecording.label, /listening/, 'and say so in words');
    assert.ok(out.whileRecording.recorderLive, 'the recorder must actually be running');
    assert.ok(out.hasNote, 'releasing the button must store a voice note');
    // The audio itself, byte for byte. A note recording that a note happened is
    // worthless — the recording IS the label.
    assert.deepStrictEqual(out.audioBytes, [1, 2, 3, 4, 5, 6, 7, 8],
      'the audio must round-trip through IndexedDB as real bytes');
    assert.strictEqual(out.mime, 'audio/webm');
    assert.ok(out.seconds >= 0.8, `the note must record its own length (got ${out.seconds})`);
    assert.ok(out.hasAbsoluteTime,
      'a voice note needs absolute time, so it can be aligned to a recording made by another app');
    assert.ok(out.micReleased,
      'the microphone track must be stopped, or the mic indicator stays on and drains the battery all sit');
    assert.strictEqual(out.voiceNoteCount, 1,
      'a fumbled sub-second press must not create a second note');
    assert.match(out.restoredLabel, /hold to speak/, 'and the button must return to its resting label');
    console.log(`✓ a held voice note stores real audio (${out.seconds.toFixed(1)}s), releases the mic, and ignores fumbles`);
  }

  // 15) THE WHOLE ROUND TRIP: record -> store -> panel -> download. The pieces are
  //     tested separately; this is the one that fails if they do not meet.
  {
    const out = await page.evaluate(async () => {
      const db = await Recorder.open({ name: 'zenbio-dl-' + Math.floor(performance.now()) });
      recDb = db;
      const started = Date.now() - 60000;
      const sess = await Recorder.startSession(db, { startedAt: started });
      for (let ch = 0; ch < 4; ch++) sess.pushEeg(ch, [ch + 0.5, ch + 1.5, ch + 2.5]);
      sess.pushRow({ t: 0, calm: 0.13 });
      sess.pushRow({ t: 1, calm: 0.9 });
      await sess.addNote({ kind: 'mark', markKind: 'settling', text: 'dropped in', tSec: 30 });
      await sess.addNote({ kind: 'voice', audio: new Blob([new Uint8Array([7, 7, 7])],
        { type: 'audio/webm' }), mimeType: 'audio/webm', seconds: 3.2, tSec: 40 });
      await sess.end();

      // Open the real panel and read what it offers.
      await openSessions();
      const row = document.querySelector(`.sesRow[data-id="${sess.id}"]`);
      const panel = {
        visible: document.getElementById('summary').classList.contains('show'),
        title: document.getElementById('summaryTitle').textContent,
        rowText: row ? row.querySelector('.sesWhen').textContent : null,
        hasDownload: !!(row && row.querySelector('[data-act="dl"]')),
      };

      // Intercept the download rather than actually saving a file.
      let captured = null;
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
      const realClick = HTMLAnchorElement.prototype.click;
      let filename = null;
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      await downloadSession(db, sess.id);
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;

      const bytes = captured ? Array.from(new Uint8Array(await captured.arrayBuffer())) : null;
      document.getElementById('summary').classList.remove('show');
      await Recorder.deleteSession(db, sess.id);
      db.close();
      recDb = null;
      return { panel, filename, size: bytes ? bytes.length : 0,
        head: bytes ? bytes.slice(0, 4) : null, type: captured && captured.type };
    });

    assert.ok(out.panel.visible, 'the saved-sessions panel must open');
    assert.strictEqual(out.panel.title, 'Saved sessions');
    assert.ok(out.panel.hasDownload, 'each session must offer a download');
    assert.match(out.panel.rowText, /\dm \ds/, `a row must show its duration (got "${out.panel.rowText}")`);
    // The filename carries the date, which is what was asked for: a folder of these
    // should be sortable and identifiable without opening any of them.
    assert.match(out.filename, /^meditation-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/,
      `the download must be named with its date (got "${out.filename}")`);
    assert.strictEqual(out.type, 'application/zip');
    // PK\x03\x04 — a real local file header, so the browser produced an archive and
    // not an empty or truncated blob.
    assert.deepStrictEqual(out.head, [0x50, 0x4b, 0x03, 0x04],
      'the blob must actually begin with a zip local file header');
    assert.ok(out.size > 400, `the archive should contain real files (got ${out.size} bytes)`);
    console.log(`✓ record -> store -> panel -> download works end to end (${out.filename}, ${out.size} bytes)`);
  }

  // 16) TEXT NOTES: write, stamp or not, review, delete.
  {
    const out = await page.evaluate(async () => {
      const db = await Recorder.open({ name: 'zenbio-notes-' + Math.floor(performance.now()) });
      recDb = db;
      sessionStartedAt = Date.now() - 90000;          // 1:30 into a sit
      recSession = await Recorder.startSession(db, { startedAt: sessionStartedAt });

      openNotes();
      const box = document.getElementById('noteBox');
      const anchorBox = document.getElementById('noteAnchor');

      // Anchored note.
      anchorBox.checked = true; anchorBox.dispatchEvent(new Event('change'));
      box.value = 'a wave of something, hard to name';
      await saveNote();

      // General note about the whole sit.
      anchorBox.checked = false; anchorBox.dispatchEvent(new Event('change'));
      box.value = 'quiet day overall,\nvery little thinking';
      await saveNote();
      // Checked here, after a REAL save: the box clears so the next note can be
      // typed straight away.
      const cleared = box.value;

      // A whitespace-only note must not be stored — and must NOT wipe the box
      // either, since somebody mid-thought should not lose what they typed.
      box.value = '   ';
      await saveNote();
      const keptAfterEmptySave = box.value;

      await new Promise((r) => setTimeout(r, 120));
      const items = Array.from(document.querySelectorAll('.noteItem')).map((el) => ({
        when: el.querySelector('.noteWhen').textContent,
        text: el.querySelector('.noteText').textContent,
      }));

      // Delete the newest.
      document.querySelector('.noteItem .noteX').click();
      await new Promise((r) => setTimeout(r, 150));
      const afterDelete = document.querySelectorAll('.noteItem').length;

      const stored = await Recorder.listNotes(db, recSession.id);
      const anchoredNote = stored.find((n) => n.anchored === true);

      // The toggle must be remembered across a reopen — it is a preference, and
      // re-setting it every sit is exactly the friction that stops notes happening.
      document.getElementById('summary').classList.remove('show');
      openNotes();
      const rememberedUnanchored = !document.getElementById('noteAnchor').checked;

      document.getElementById('summary').classList.remove('show');
      await recSession.end();
      await Recorder.deleteSession(db, recSession.id);
      db.close();
      recSession = null; recDb = null; sessionStartedAt = null;
      return { items, cleared, keptAfterEmptySave, afterDelete, stored: stored.length,
        anchoredOffset: anchoredNote && anchoredNote.offsetSec,
        rememberedUnanchored };
    });

    assert.strictEqual(out.items.length, 2,
      `two notes should be listed, and a whitespace-only note must not save (got ${out.items.length})`);
    // Newest first: the note you just wrote is the one you might want to remove.
    assert.match(out.items[0].text, /quiet day overall/, 'newest note must be listed first');
    assert.strictEqual(out.items[0].when, 'whole sit',
      'an unanchored note must say so, not show a fake timestamp');
    assert.match(out.items[1].when, /^0[12]:\d\d$/,
      `an anchored note must show its clock time (got "${out.items[1].when}")`);
    assert.ok(Math.abs(out.anchoredOffset - 90) < 3,
      `and be stamped ~90s into the sit, on the shared session clock (got ${out.anchoredOffset})`);
    // Multi-line text must survive as typed.
    assert.match(out.items[0].text, /very little thinking/, 'newlines in a note must be kept');
    assert.strictEqual(out.cleared, '', 'the box must clear after saving, ready for the next note');
    assert.strictEqual(out.keptAfterEmptySave, '   ',
      'but a rejected empty save must not destroy what was typed');
    assert.strictEqual(out.afterDelete, 1, 'deleting a note must remove it from the list');
    assert.strictEqual(out.stored, 1, 'and from storage, not just the display');
    assert.ok(out.rememberedUnanchored, 'the stamp toggle must persist between openings');
    console.log('✓ text notes save, stamp or not, list newest-first, and delete');
  }

  assert.deepStrictEqual(errors, [], `no errors may appear during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll UI tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
