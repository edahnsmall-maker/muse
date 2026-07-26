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
      const bar = el.querySelector('.rBarC');
      const fill = bar.querySelector('i');
      return { cls: fill.className, height: fill.style.height, text: el.textContent };
    });
    assert.strictEqual(inhale.cls, 'up', 'a positive breath amount must fill UPWARD from the midpoint');
    assert.strictEqual(inhale.height, '40%', 'and reach 40% of the bar for an amount of 0.8 (half-range)');
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
      return { cls: fill.className, height: fill.style.height, text: el.textContent };
    });
    assert.strictEqual(exhale.cls, 'dn', 'a negative breath amount must fill DOWNWARD');
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
    assert.strictEqual(absent.fills, 0, 'with no signal the bar must be empty, not centred');
    assert.ok(!/\b(in|out)\b/.test(absent.text),
      `and must not claim a direction (got: ${absent.text})`);

    // Breath must not ALSO appear as a 0-100 composite row.
    const composites = await page.evaluate(() => activeComposites.slice());
    assert.ok(!composites.includes('breath'),
      'breath must not be a composite readout row as well — an exhale is not a low score');
    console.log('✓ breath is exactly one centred row, empty when there is no signal, not duplicated');
  }

  assert.deepStrictEqual(errors, [], `no errors may appear during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll UI tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
