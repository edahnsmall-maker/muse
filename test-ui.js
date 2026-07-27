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
      host.innerHTML = breathRow();
      const probe = (label) => {
        const r = host.querySelector('.rRow');
        const kids = r.children.length;
        const h = r.getBoundingClientRect().height;
        return { label, kids, h: Math.round(h) };
      };
      const results = [probe('breath')];
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
    await page.evaluate(() => { breathAmount = null; breathRising = null; strapBreathSec = null; });
    console.log(`✓ readout rows stay on one line (${rows.map((r) => r.label + ' ' + r.h + 'px').join(', ')})`);
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

  assert.deepStrictEqual(errors, [], `no errors may appear during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll UI tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
