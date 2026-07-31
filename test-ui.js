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
const Labels = require('./public/labels.js');
const Labels_quadrant = (d) => Labels.quadrant(d);

// startRecording() deliberately resets the session clock, which is right for the app
// and wrong for a test that wants to sit at a known offset. This arms recording while
// keeping the clock the test just set.
const ARM_WITHOUT_RESET = `
  window.ensureRecordingForTest = async () => {
    recArmed = true; recError = null;
    await ensureRecording();
    renderRecBtn();
    return !!recSession;
  };
`;

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
  await page.evaluate(ARM_WITHOUT_RESET);

  assert.deepStrictEqual(errors, [], `the page must load without console errors:\n  ${errors.join('\n  ')}`);
  console.log('✓ direct.html loads without throwing');

  /* 0) THE CONNECT CONTROL MUST BE VISIBLE ON A FRESH LOAD.
   *
   * Reported from a live page showing nothing but the Record button. The device
   * buttons had been moved inside #controls, which sat at opacity 0 until connect()
   * succeeded — so reaching Connect required having already connected.
   *
   * THE REASON THE EXISTING TESTS MISSED IT, which is the part worth remembering:
   * `.click()` works on an opacity-0 element, and so does `offsetParent`. Both of the
   * checks already in this file therefore passed on an invisible control. Only the
   * COMPUTED STYLE catches this, so that is what is asserted.
   */
  {
    const st = await page.evaluate(() => {
      const bar = document.getElementById('controls');
      const cs = getComputedStyle(bar);
      const r = document.getElementById('devToggle').getBoundingClientRect();
      return {
        opacity: Number(cs.opacity),
        visibility: cs.visibility,
        display: cs.display,
        onScreen: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
        label: document.getElementById('devToggle').textContent,
      };
    });
    assert.ok(st.opacity > 0.9,
      `the controls bar must be VISIBLE before anything is connected (opacity ${st.opacity});`
      + ' the device buttons live inside it, so hiding it makes connecting impossible');
    assert.strictEqual(st.visibility, 'visible');
    assert.notStrictEqual(st.display, 'none');
    assert.ok(st.onScreen, 'and the Connect pill must be on screen, not below the fold');
    assert.strictEqual(st.label, 'Connect');
    console.log('✓ the Connect control is visible and on screen on a fresh load');
  }

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

  /* 7a2) "NOISY" MUST SAY HOW NOISY, because it covers two situations with different
   *      fixes. Asked directly, of two channels reading Noisy for a whole sit: "but
   *      why's it dead at all?" — and the app could not answer.
   *
   *      ~150-600µV: the electrode IS on skin, picking up muscle or movement. Fixable
   *      by sitting differently, and a hint the threshold may be tight for a temporal
   *      channel. >600µV: the input is floating and railing toward the ends of its
   *      ±1000µV range. That is not noise, it is no contact, and sitting still will
   *      never fix it.
   */
  {
    const out = await page.evaluate(() => {
      const W = 256;
      const set = (ch, ptp) => {
        buffers[ch].length = 0;
        for (let i = 0; i < W; i++) buffers[ch].push((i % 2 ? 0.5 : -0.5) * ptp);
      };
      set(0, 900);   // railing: no contact
      set(1, 300);   // on skin but noisy
      set(2, 40);    // healthy
      set(3, 20);    // healthy
      const ch = computeChannelLabels();
      return ch.map((c) => ({ name: c.name, label: c.label,
        ptp: c.ptp == null ? null : Math.round(c.ptp), floating: c.floating }));
    });

    assert.strictEqual(out[0].label, 'No contact',
      `a railing electrode must say so, not "Noisy" (got "${out[0].label}" at ${out[0].ptp}µV)`);
    assert.strictEqual(out[0].floating, true);
    assert.strictEqual(out[1].label, 'Noisy',
      `an electrode on skin picking up muscle is Noisy, not disconnected (got "${out[1].label}")`);
    assert.strictEqual(out[1].floating, false);
    assert.ok(out[1].ptp >= 250 && out[1].ptp <= 350,
      `the µV figure must be real, not decorative (got ${out[1].ptp})`);
    assert.ok(!/Noisy|No contact/.test(out[2].label) && !/Noisy/.test(out[3].label),
      `a clean channel must report its band, not a fault (${out[2].label}, ${out[3].label})`);
    // The number reaches the screen, and ONLY for the faulty channels — four numbers to
    // ignore all sit is how a diagnostic becomes invisible.
    const shown = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('#readoutRows .rLabel'))
        .map((e) => e.parentElement.textContent);
      return texts.filter((t) => /µV/.test(t)).length;
    });
    assert.ok(shown <= 2, `only faulty channels show a µV figure (got ${shown} rows)`);
    console.log(`✓ a railing electrode reads "No contact" and a noisy one reports its`
      + ` amplitude (${out[0].ptp}µV vs ${out[1].ptp}µV)`);
  }

  // 7b) A DEAD ELECTRODE MUST DRAW NOTHING, not a flat line at mid-range.
  //     Reported as "any clues as to why TP10 looks dead?" — with a perfectly flat
  //     green line through the centre of the Live feed. That line was fabricated:
  //     sampleHistory held the previous value when a channel had no valid reading, and
  //     50 when there had never been one, so an electrode not touching the head was
  //     drawn as the steadiest, most perfectly balanced channel on the plot.
  {
    const out = await page.evaluate(() => {
      const strokes = [];
      const g = chartCanvas.getContext('2d');
      const realStroke = g.stroke.bind(g);
      const realMove = g.moveTo.bind(g);
      const realLine = g.lineTo.bind(g);
      let pending = [];
      g.moveTo = (x, y) => { pending.push([x, y]); realMove(x, y); };
      g.lineTo = (x, y) => { pending.push([x, y]); realLine(x, y); };
      g.stroke = () => { if (pending.length) strokes.push({ style: g.strokeStyle, pts: pending }); pending = []; realStroke(); };

      // Reset the histories, then feed 30 seconds in which TP10 NEVER reports and TP9
      // reports, drops out for a stretch, and comes back.
      for (const k of Object.keys(histories)) histories[k] = new Chart.History(HISTORY_LEN);
      seriesMode = 'sensors';
      for (let t = 0; t < 30; t++) {
        const chans = DSP.CHANNEL_NAMES.map((name, i) => {
          if (name === 'TP10') return { name, label: 'Noisy', pct: null, artifact: true };
          if (name === 'TP9' && t >= 10 && t < 20) return { name, label: 'Noisy', pct: null, artifact: true };
          return { name, label: 'Alpha', pct: 0.3 + 0.1 * i, artifact: false };
        });
        sampleHistory({ calm: 0.5, artifactRate: 0.2 }, chans);
      }
      // sampleHistory re-renders on every sample, so only the LAST frame's paths
      // describe the finished series. Counting all 30 frames' worth would just count
      // renders.
      strokes.length = 0;
      renderChart();
      const colorOf = (n) => SENSOR_SERIES.find((s) => s.key === n).color;
      const forSeries = (n) => strokes.filter((s) =>
        String(s.style).toLowerCase() === colorOf(n).toLowerCase());
      const res = {
        tp10Strokes: forSeries('TP10').length,
        tp10Values: histories.TP10.values.slice(0, 4),
        tp9Runs: forSeries('TP9').length,
        af7Runs: forSeries('AF7').length,
        af7Flat: forSeries('AF7').every((s) => s.pts.length > 2),
      };
      g.stroke = realStroke; g.moveTo = realMove; g.lineTo = realLine;
      for (const k of Object.keys(histories)) histories[k] = new Chart.History(HISTORY_LEN);
      return res;
    });

    assert.deepStrictEqual(out.tp10Values, [null, null, null, null],
      'a channel with no valid window must record NO VALUE, not 50 and not a held'
      + ` previous value (got ${JSON.stringify(out.tp10Values)})`);
    assert.strictEqual(out.tp10Strokes, 0,
      `an electrode that never reported must draw nothing — it drew ${out.tp10Strokes}`
      + ' path(s). A flat line at mid-chart is the most confident-looking line on the'
      + ' plot and it comes from no data at all.');
    assert.strictEqual(out.tp9Runs, 2,
      `a channel that dropped out and came back must draw two separate runs, not one`
      + ` bridged line (got ${out.tp9Runs})`);
    assert.ok(out.af7Runs >= 1 && out.af7Flat,
      'and a channel that reported the whole time must still draw one continuous line');
    console.log('✓ a dead electrode draws nothing and a dropout breaks the line,'
      + ' instead of being fabricated at 50');
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
    assert.match(out.whileRecording.label, /Listening/, 'and say so in words');
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
    assert.match(out.restoredLabel, /Hold to speak/, 'and the button must return to its resting label');
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

  /* 15a2) SAVED SESSIONS: a name you choose, and a mark count.
   *
   * Asked for: "would be cool to be able to name them or tag them with a little memorable
   * note. and see how many markers are in the session (for analysis later). some will be
   * useless." The count is the load-bearing half — a sit with no marks cannot contribute
   * to any event-locked analysis, and a date plus a duration does not say which those are.
   */
  {
    const out = await page.evaluate(async () => {
      const db = await Recorder.open({ name: 'zenbio-name-' + Math.floor(performance.now()) });
      recDb = db;
      const withMarks = await Recorder.startSession(db, { startedAt: Date.now() - 600000 });
      for (let i = 0; i < 3; i++) {
        await withMarks.addNote({ kind: 'transition', transition: 'lost', anchored: true });
      }
      // A whole-sit reflection must NOT count as a mark: it describes the sit, not a
      // moment in it, so counting it would make a sit with no usable epochs look usable.
      await withMarks.addNote({ kind: 'text', text: 'closing thoughts', anchored: false });
      await withMarks.end();
      const bare = await Recorder.startSession(db, { startedAt: Date.now() - 300000 });
      await bare.end();

      await openSessions();
      const rows = Array.from(document.querySelectorAll('.sesRow')).map((r) => ({
        id: r.dataset.id,
        text: r.querySelector('.sesMeta').textContent,
        hasInput: !!r.querySelector('.sesLabel'),
      }));

      // Name one through the real input, the way a person does.
      const input = document.querySelector(`.sesRow[data-id="${withMarks.id}"] .sesLabel`);
      input.value = 'first good sit — rain outside';
      input.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 250));
      const listed = await Recorder.listSessions(db);
      const named = listed.find((m) => m.id === withMarks.id);
      // And it must reach the export, or a named sit is unrecognisable in the lab.
      const md = Exporter.toMarkdown({ meta: named, rows: [], notes: [] });

      document.getElementById('summary').classList.remove('show');
      await Recorder.deleteSession(db, withMarks.id);
      await Recorder.deleteSession(db, bare.id);
      db.close(); recDb = null;
      return { rows, marksOf: listed.map((m) => [m.id, m.markCount]),
        label: named.label, mdFirstLine: md.split('\n')[0],
        withMarksId: withMarks.id, bareId: bare.id };
    });

    const counts = new Map(out.marksOf);
    assert.strictEqual(counts.get(out.withMarksId), 3,
      `three taps must count as three marks, and the whole-sit note must not count`
      + ` (got ${counts.get(out.withMarksId)})`);
    assert.strictEqual(counts.get(out.bareId), 0, 'and a sit with none must count zero');
    const bareRow = out.rows.find((r) => r.id === out.bareId);
    assert.match(bareRow.text, /no marks/,
      `a sit with nothing marked must SAY so rather than showing a quiet 0`
      + ` (got "${bareRow.text}")`);
    const markedRow = out.rows.find((r) => r.id === out.withMarksId);
    assert.match(markedRow.text, /3 marks/, `and a marked one must show its count`);
    assert.ok(out.rows.every((r) => r.hasInput), 'every row must offer a name field');
    assert.strictEqual(out.label, 'first good sit — rain outside',
      `the name must persist (got ${JSON.stringify(out.label)})`);
    assert.match(out.mdFirstLine, /first good sit/,
      `and reach the export title, or a named sit is unrecognisable in the lab`
      + ` (got "${out.mdFirstLine}")`);
    console.log('✓ saved sessions take a name and show their mark count, calling out the'
      + ' ones with none');
  }

  // 15b) THE SUMMARY OFFERS THE DATA, not just the prose report.
  //      Asked for directly: "when you see the summarized session, it would be nice to
  //      have it download the the data as well here." The report is what happened, for
  //      reading; the archive is the numbers the analysis lab and any AI handoff need.
  //      Absent when there is no recorded session, because a button producing an empty
  //      archive after an unrecorded sit would imply the sit was captured.
  {
    const out = await page.evaluate(async () => {
      // A summary needs live signal to have anything to summarise. Feed it a plausible
      // minute so the real screen renders rather than the "nothing yet" one.
      sessionLog.length = 0;
      for (let t = 0; t < 60; t++) {
        sessionLog.push({ t, calm: 0.4 + 0.2 * Math.sin(t / 9), focus: 0.5, thinking: 0.4,
          drowsy: 0.2, artifact: 0, levels: [0.4, 0.5, 0.5, 0.4] });
      }

      // First: no session at all. The Data button must not be offered.
      recSession = null; lastRecSession = null; recArmed = false;
      selfRating = 4;                      // skip the rating screen
      openSummary();
      const dry = { data: !!document.getElementById('sumData'),
        report: !!document.getElementById('sumDownload') };
      closeSummary();

      // Now a real recorded sit, stopped the way the app stops one.
      const db = await Recorder.open({ name: 'zenbio-sum-' + Math.floor(performance.now()) });
      recDb = db;
      sessionStartedAt = Date.now() - 120000;
      recArmed = true; recError = null;
      selfRating = 4;                      // closeSummary above resets it
      await ensureRecording();
      for (let ch = 0; ch < 4; ch++) recSession.pushEeg(ch, [ch + 0.5, ch + 1.5, ch + 2.5]);
      recSession.pushRow({ t: 0, calm: 0.4 });
      recSession.pushRow({ t: 1, calm: 0.7 });
      await recSession.addNote({ kind: 'transition', transition: 'returned', anchored: true });
      const id = recSession.id;
      await stopRecording();               // nulls recSession, opens the summary
      const wet = { data: !!document.getElementById('sumData'),
        sessionId: summarySessionId(), matches: summarySessionId() === id };

      // Press it, intercepting the download.
      let captured = null, filename = null;
      const realCreate = URL.createObjectURL;
      const realClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b) => { captured = b; return 'blob:stub'; };
      HTMLAnchorElement.prototype.click = function () { filename = this.download; };
      const btn = document.getElementById('sumData');
      const restingLabel = btn.textContent;
      btn.click();
      // The label must change while it works — building the archive re-reads every raw
      // chunk and CRC-32s it, which on a long sit looks like a dead button.
      const busyLabel = btn.textContent;
      for (let i = 0; i < 60 && !captured; i++) await new Promise((r) => setTimeout(r, 50));
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
      const bytes = captured ? new Uint8Array(await captured.arrayBuffer()) : null;

      /* And the dead end: "nothing to summarise" means too little live signal for a
         sparkline, NOT that nothing was recorded. That branch used to offer only
         Close, so a sit whose headband dropped early had its raw chunks, notes and
         taps stranded in the database with no way to reach them. */
      closeSummary();
      sessionLog.length = 0;               // force the no-stats branch
      lastRecSession = { id };             // but a recorded session still exists
      selfRating = 4;
      openSummary();
      const stranded = { title: document.getElementById('summaryTitle').textContent,
        data: !!document.getElementById('sumData') };

      closeSummary();
      await Recorder.deleteSession(db, id);
      db.close(); recDb = null; lastRecSession = null; selfRating = null;
      return { dry, wet, stranded, filename, restingLabel, busyLabel,
        type: captured && captured.type,
        head: bytes ? Array.from(bytes.slice(0, 4)) : null,
        size: bytes ? bytes.length : 0,
        settled: btn.textContent };
    });

    assert.ok(out.dry.report, 'the report download is always offered');
    assert.ok(!out.dry.data,
      'but the DATA download must not appear when nothing was recorded — it would'
      + ' imply the sit was captured');
    assert.ok(out.wet.data, 'after a recorded sit the data download must be there');
    assert.ok(out.wet.matches,
      `the summary must reach the sit that was just stopped (id ${out.wet.sessionId});`
      + ' stopRecording nulls recSession before opening the summary, which is what'
      + ' lastRecSession exists for');
    assert.notStrictEqual(out.busyLabel, out.restingLabel,
      `the button must say it is working (stayed "${out.busyLabel}")`);
    assert.strictEqual(out.settled, out.restingLabel, 'and go back to its label after');
    assert.strictEqual(out.type, 'application/zip');
    assert.deepStrictEqual(out.head, [0x50, 0x4b, 0x03, 0x04],
      'and produce a real zip, not an empty blob');
    assert.match(out.filename, /^meditation-.*\.zip$/, `named for the sit (got ${out.filename})`);
    assert.match(out.stranded.title, /Nothing to summarise/,
      `precondition: the no-stats branch must be the one showing (got "${out.stranded.title}")`);
    assert.ok(out.stranded.data,
      '"Nothing to summarise yet" must STILL offer the data. Too little live signal for'
      + ' a sparkline does not mean nothing was recorded — a sit whose headband dropped'
      + ' early still has raw chunks, notes and taps saved, and this branch offered'
      + ' only Close, stranding all of it.');
    console.log(`✓ the summary downloads the data as well as the report, including when`
      + ` there is nothing to summarise (${out.filename}, ${out.size} bytes)`);
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

  // 17) RECORDING IS EXPLICIT. It used to start on the first sample and never stop,
  //     so leaving the tab open recorded the rest of the day into one session.
  {
    const out = await page.evaluate(async () => {
      recArmed = false; recSession = null; recError = null;
      // Feed real samples with recording OFF. Nothing may be captured.
      pushSamples(1, [1, 2, 3, 4]);
      await new Promise((r) => setTimeout(r, 120));
      const idleStarted = !!recSession;
      const idleLabel = document.getElementById('recBtn').textContent;

      await startRecording();
      pushSamples(1, [5, 6, 7, 8]);
      const armedHasSession = !!recSession;
      const id = recSession && recSession.id;
      const db = recDb;
      renderRecBtn();
      const liveLabel = document.getElementById('recBtn').textContent;
      const liveClass = document.getElementById('recBtn').classList.contains('on');

      // Stopping must close the session AND open the summary — that is the moment
      // the sit becomes a thing with an end and its notes attached.
      document.getElementById('summary').classList.remove('show');
      await stopRecording();
      await new Promise((r) => setTimeout(r, 120));
      const afterStop = {
        armed: recArmed, session: !!recSession,
        label: document.getElementById('recBtn').textContent,
        summaryOpen: document.getElementById('summary').classList.contains('show'),
      };
      const stored = id ? await Recorder.loadSession(db, id) : null;

      // And nothing may be captured after stopping either.
      pushSamples(1, [9, 9, 9, 9]);
      await new Promise((r) => setTimeout(r, 120));
      const afterStopCaptured = !!recSession;

      document.getElementById('summary').classList.remove('show');
      if (id) await Recorder.deleteSession(db, id);
      return { idleStarted, idleLabel, armedHasSession, liveLabel, liveClass, afterStop,
        afterStopCaptured, endedFlag: stored && stored.meta.ended,
        capturedSamples: stored ? stored.eeg[1].length : null };
    });

    assert.strictEqual(out.idleStarted, false,
      'samples arriving with recording OFF must not start a session — that was the bug');
    assert.strictEqual(out.idleLabel, 'Record', 'the idle button must invite you to start');
    assert.ok(out.armedHasSession, 'pressing Record must open a session');
    assert.match(out.liveLabel, /^Stop · \d+:\d\d$/,
      `a live button must offer Stop and show elapsed time (got "${out.liveLabel}")`);
    assert.ok(out.liveClass, 'and be visually distinct while live');
    assert.strictEqual(out.afterStop.armed, false, 'Stop must disarm');
    assert.strictEqual(out.afterStop.session, false, 'and release the session');
    assert.strictEqual(out.afterStop.label, 'Record', 'and return to inviting a new one');
    assert.ok(out.afterStop.summaryOpen,
      'stopping must open the summary — that is when the sit gets packaged');
    assert.strictEqual(out.endedFlag, true, 'the stored session must be marked ended, not interrupted');
    // 4 samples were pushed while armed; the 4 before and 4 after must be absent.
    assert.strictEqual(out.capturedSamples, 4,
      `only samples from inside the recording may be kept (got ${out.capturedSamples})`);
    assert.strictEqual(out.afterStopCaptured, false, 'and nothing may resume capturing after Stop');
    console.log('✓ recording starts and stops only when asked, and Stop packages the sit');
  }

  // 18) The chrome: fewer visuals, a collapsed device control, no stuck messages.
  {
    const out = await page.evaluate(async () => {
      // The device buttons must be OUT of the way but still reachable — they used to
      // sit in the middle of the screen for the whole sit.
      const devices = document.getElementById('devices');
      const toggle = document.getElementById('devToggle');
      const collapsed = devices.hidden;
      toggle.click();
      const opened = !devices.hidden;
      const connectReachable = !!document.getElementById('connect').offsetParent;
      toggle.click();
      const reclosed = devices.hidden;

      // The stuck "session complete" message: once the timer fired, the only line
      // that cleared the status was guarded by !timerDone, so it stayed forever.
      // Deliberately with no EEG result: the timer check used to live below the
      // `if (!result) return` in the tick, so a headband that dropped out meant the
      // timer silently never completed and the sit never got packaged.
      for (const b of buffers) b.length = 0;
      timerEndAt = Date.now() - 10; timerDone = false;
      await new Promise((r) => setTimeout(r, 400));
      const firedWithoutEeg = timerDone;
      const rightAfter = document.getElementById('status').textContent;
      document.getElementById('summary').classList.remove('show');
      statusLockUntil = Date.now() + 250;      // shorten the 5s lock for the test
      await new Promise((r) => setTimeout(r, 900));
      const later = document.getElementById('status').textContent;
      timerEndAt = null; timerDone = false;

      return {
        collapsed, opened, connectReachable, reclosed, rightAfter, later, firedWithoutEeg,
        visuals: Array.from(document.querySelectorAll('#modeBar .pill')).map((p) => p.textContent),
        controls: Array.from(document.querySelectorAll('#controls .pill')).map((p) => p.textContent),
        groups: document.querySelectorAll('#controls .pillGroup').length,
      };
    });

    assert.ok(out.collapsed, 'the device buttons must start collapsed, not covering the visual');
    assert.ok(out.opened && out.connectReachable,
      'and must be genuinely reachable when expanded, not merely present in the DOM');
    assert.ok(out.reclosed, 'and collapse again');

    assert.ok(out.firedWithoutEeg,
      'the timer must complete even with no EEG signal — it is a wall clock, not a data event');
    assert.match(out.rightAfter, /session complete/, 'the timer ending must say so');
    // It must stop SAYING it. What replaces it depends on state — with no headband
    // streaming, "gathering signal" is the correct next message — so the assertion
    // is that the completion notice cleared, not that the line went empty.
    assert.ok(!/session complete/.test(out.later),
      `"session complete" must expire like any other message (still showing "${out.later}")`);

    const wanted = ['Eclipse', 'Iris', 'Pulse', 'Corona', 'Silk', 'Flow', 'Breath'];
    assert.deepStrictEqual(out.visuals, wanted,
      `only the seven kept visuals may be offered (got ${out.visuals.join(', ')})`);

    // The two removed pills, and consistent capitalisation.
    assert.ok(!out.controls.some((t) => /Mark this moment/.test(t)),
      'the Mark pill is gone — training mode already prompts for M');
    assert.ok(!out.controls.some((t) => /Fullscreen/.test(t)), 'and Fullscreen');
    assert.ok(out.controls.some((t) => /^Summarize session$/.test(t)), 'renamed to Summarize session');
    for (const t of out.controls) {
      assert.match(t, /^[A-Z]/, `every control must start with a capital (got "${t}")`);
    }
    assert.ok(out.groups >= 3, `the bar must be grouped rather than one flat row (got ${out.groups})`);
    console.log(`✓ ${out.visuals.length} visuals, ${out.groups} control groups, devices collapse, no stuck message`);
  }

  // 19) THE SENSORS/COMPOSITES SWITCH must survive the 250ms tick.
  //
  //     Reported as "it flickers and takes ten clicks". The cause: the whole readout,
  //     including these two pills, was assigned to #readout.innerHTML on every tick.
  //     The nodes were destroyed and rebuilt four times a second, so hover restarted
  //     constantly, and a click whose mousedown and mouseup straddled a rebuild
  //     landed on two different elements and fired no click event at all.
  {
    /* Feed REAL EEG so the full readout path runs.
     *
     * The first version of this test set up a strap-only readout, which takes the
     * tick's early-return branch and never reaches the view switch at all — so it
     * passed even with the bug deliberately reintroduced. A regression test that
     * does not enter the code path it guards is worse than none: it reports safety.
     * Verified by injection after this change.
     */
    await page.evaluate(async () => {
      strapDevice = null;
      viewMode = 'sensors';
      // ~20uV of alpha-ish signal on the frontal pair: enough for computeCalm() to
      // return a result, small enough not to trip the artifact rejector.
      for (let ch = 0; ch < 4; ch++) {
        const block = [];
        for (let i = 0; i < 600; i++) {
          block.push(18 * Math.sin((2 * Math.PI * 10 * i) / 256) + 4 * Math.sin((2 * Math.PI * 6 * i) / 256));
        }
        pushSamples(ch, block);
      }
      lastDataAt = Date.now();
      await new Promise((r) => setTimeout(r, 700));
    });
    // Prove the full path is actually running, or everything below is vacuous.
    const live = await page.evaluate(() => ({
      rows: document.getElementById('readoutRows').children.length,
      switchVisible: !!document.querySelector('#viewSwitch [data-view="composites"]').offsetParent,
    }));
    assert.ok(live.rows > 3,
      `the FULL readout must be rendering, or this test guards nothing (got ${live.rows} rows)`);
    assert.ok(live.switchVisible, 'and the switch must be on screen');

    // ROOT CAUSE: the node must be the SAME object after several ticks. Everything
    // else follows from this, and it is the assertion that cannot pass by luck.
    const identity = await page.evaluate(async () => {
      const before = document.querySelector('#viewSwitch [data-view="composites"]');
      before.dataset.probe = 'marked';               // survives only if the node does
      const headBefore = document.getElementById('readoutHead');
      await new Promise((r) => setTimeout(r, 900));  // ~4 ticks
      const after = document.querySelector('#viewSwitch [data-view="composites"]');
      return {
        same: before === after,
        probeSurvived: after.dataset.probe === 'marked',
        headSame: headBefore === document.getElementById('readoutHead'),
        rowsStillRender: document.getElementById('readoutRows').children.length > 0,
      };
    });
    assert.ok(identity.same,
      'the Composites pill must be the SAME node after several ticks — rebuilding it is what swallowed clicks');
    assert.ok(identity.probeSurvived, 'and must not be replaced by an identical copy');
    assert.ok(identity.headSame, 'the readout header must be stable too');
    assert.ok(identity.rowsStillRender,
      'while the ROWS must still update — the fix must not freeze the readout');

    /* THE SWITCH MUST NOT MOVE when the view changes.
     *
     * #readout is anchored by its bottom with a content-driven height, so a change
     * in row count moves its TOP — and the tabs live at the top. Sensors renders 9
     * rows and Composites 11, which moved the tabs 54px, twice their own height. So
     * clicking Composites shifted the tabs out from under the cursor and the next
     * click hit nothing. This made the test below flaky, which is how it was found.
     */
    const geometry = await page.evaluate(async () => {
      const at = async (mode) => {
        viewMode = mode; renderViewSwitch();
        await new Promise((r) => setTimeout(r, 600));
        const r = document.querySelector('#viewSwitch [data-view="composites"]').getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height) };
      };
      const sensors = await at('sensors');
      const composites = await at('composites');
      viewMode = 'sensors'; renderViewSwitch();
      await new Promise((r) => setTimeout(r, 300));
      return { sensors, composites };
    });
    assert.strictEqual(geometry.sensors.top, geometry.composites.top,
      `the switch must not move when the view changes (${geometry.sensors.top} -> ${geometry.composites.top}px);`
      + ' a target that moves out from under the cursor cannot be clicked');
    assert.strictEqual(geometry.sensors.left, geometry.composites.left, 'nor sideways');

    // THE REPRODUCTION: a real mouse press with a tick deliberately in the middle.
    // This is what a slow human click looks like, and it is what used to fail.
    await page.evaluate(() => { viewMode = 'sensors'; renderViewSwitch(); });
    const box = await page.evaluate(() => {
      const r = document.querySelector('#viewSwitch [data-view="composites"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });
    assert.ok(box.w > 0 && box.h > 0, 'the pill must actually be laid out and clickable');
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.waitForTimeout(400);            // a tick (or two) lands mid-click
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await page.evaluate(() => ({
      viewMode,
      activeLabel: document.querySelector('#viewSwitch .pill.active').textContent,
    }));
    assert.strictEqual(after.viewMode, 'composites',
      'a slow click spanning a tick must still switch view — this is the reported bug');
    assert.strictEqual(after.activeLabel, 'Composites',
      'and the active pill must reflect it');

    // And back again via the OTHER pill, so the toggle is not one-way.
    const sBox = await page.evaluate(() => {
      const r = document.querySelector('#viewSwitch [data-view="sensors"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(sBox.x, sBox.y);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const back = await page.evaluate(() => {
      const v = viewMode;
      for (const b of buffers) b.length = 0;
      viewMode = 'sensors'; renderViewSwitch();
      return v;
    });
    assert.strictEqual(back, 'sensors', 'clicking Sensors must switch back');
    console.log('✓ the Sensors/Composites switch survives the tick: stable nodes, slow clicks register');
  }

  // 20) Connect and Timer live in the BAR, and open upward from it. The device
  //     buttons were still floating in the middle of the screen before this.
  {
    const out = await page.evaluate(async () => {
      const bar = document.getElementById('controls');
      const devices = document.getElementById('devices');
      const picker = document.getElementById('timerPicker');
      const devPill = document.getElementById('devToggle');
      const timerPill = document.getElementById('timerLink');

      const inBar = { connect: bar.contains(devPill), timer: bar.contains(timerPill) };
      // Both panels must be anchored to the bar, not to the middle of the screen.
      const anchored = { devices: bar.contains(devices), picker: bar.contains(picker) };

      devPill.click();
      const devOpen = !devices.hidden;
      const devLabel = devPill.textContent;
      const connectReachable = !!document.getElementById('connect').offsetParent;
      // A device panel that opens BELOW the fold is the bug being fixed.
      const r = document.getElementById('connect').getBoundingClientRect();
      const onScreen = r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;

      // Opening the timer must close the devices — two popovers over each other in
      // the same corner is unusable.
      timerPill.click();
      const afterTimer = { devicesHidden: devices.hidden, pickerOpen: !picker.hidden,
        choices: picker.querySelectorAll('button').length };

      // Choosing a duration sets the timer, closes the popover, and the pill shows
      // the countdown without needing to be opened.
      picker.querySelector('[data-min="10"]').click();
      renderTimerPill();
      const afterChoice = { pickerHidden: picker.hidden, label: timerPill.textContent,
        endSet: timerEndAt != null };

      // And Clear must remove it rather than set a zero-length timer.
      timerPill.click();
      const hasClear = !!picker.querySelector('[data-min="0"]');
      picker.querySelector('[data-min="0"]').click();
      renderTimerPill();
      const afterClear = { endSet: timerEndAt != null, label: timerPill.textContent };

      devices.hidden = true; devicesOpen = false; picker.hidden = true;
      return { inBar, anchored, devOpen, devLabel, connectReachable, onScreen,
        afterTimer, afterChoice, hasClear, afterClear };
    });

    assert.ok(out.inBar.connect && out.inBar.timer,
      'Connect and Timer must be pills in the bottom bar, not floating elsewhere');
    assert.ok(out.anchored.devices && out.anchored.picker,
      'both panels must be anchored to the bar so they cannot cover the visual');
    assert.ok(out.devOpen, 'the Connect pill must open the device panel');
    assert.strictEqual(out.devLabel, 'Connect',
      'the pill just says Connect — the buttons inside already report what is linked');
    assert.ok(out.connectReachable && out.onScreen,
      'and the device buttons must be fully on screen, which is the reported bug');
    assert.ok(out.afterTimer.devicesHidden,
      'opening the timer must close the device panel — one popover at a time');
    assert.ok(out.afterTimer.pickerOpen && out.afterTimer.choices >= 4,
      `the timer popover must offer its durations (got ${out.afterTimer.choices})`);
    assert.ok(out.afterChoice.pickerHidden && out.afterChoice.endSet,
      'choosing a duration must set the timer and close the popover');
    assert.match(out.afterChoice.label, /^Timer \d+:\d\d$/,
      `the pill must carry the countdown (got "${out.afterChoice.label}")`);
    assert.ok(out.hasClear, 'a running timer must offer Clear');
    assert.strictEqual(out.afterClear.endSet, false, 'Clear must remove the timer');
    assert.strictEqual(out.afterClear.label, 'Timer', 'and the pill must go back to resting');
    console.log('✓ Connect and Timer are bar pills opening upward, and the timer clears');
  }

  // 21) THE RATING SCREEN, and why it stopped appearing: selfRating was set once and
  //     never reset, so the second summary in one page load skipped straight past it.
  {
    const out = await page.evaluate(async () => {
      // NOT a private database here: startRecording() -> ensureRecording() opens the
      // real one by name and reassigns recDb, so a handle set up front would be
      // replaced and this test would look for its notes in the wrong place. The
      // sessions it creates are deleted at the end.
      const runSit = async () => {
        await startRecording();
        // Enough of a log for summarize() to return stats.
        for (let i = 0; i < 6; i++) sessionLog.push({ t: i, calm: 0.4 + i * 0.05, noise: 0 });
        if (recSession) recSession.pushRow({ t: 0, calm: 0.5 });
        await stopRecording();
        await new Promise((r) => setTimeout(r, 120));
      };

      await runSit();
      const first = {
        title: summaryTitleEl.textContent,
        hasRating: !!document.querySelector('[data-rate]'),
        hasNoteBox: !!document.getElementById('sumNote'),
      };
      // Rate it AND write words. Both before any number is shown.
      document.querySelector('[data-rate="4"]').click();
      const stillOpen = !!document.getElementById('sumNote');
      document.getElementById('sumNote').value = 'scattered, but in a new way';
      const id1 = lastRecSession && lastRecSession.id;
      document.getElementById('sumDone').click();
      await new Promise((r) => setTimeout(r, 180));
      const afterSave = { title: summaryTitleEl.textContent, rating: selfRating };
      const notes1 = id1 ? await Recorder.listNotes(recDb, id1) : [];

      // SECOND sit, same page load. The rating screen must come back.
      summaryEl.classList.remove('show');
      await runSit();
      const second = {
        title: summaryTitleEl.textContent,
        hasRating: !!document.querySelector('[data-rate]'),
        rating: selfRating,
      };
      const id2 = lastRecSession && lastRecSession.id;
      document.getElementById('sumSkip').click();
      await new Promise((r) => setTimeout(r, 150));
      summaryEl.classList.remove('show');
      for (const id of [id1, id2]) if (id) await Recorder.deleteSession(recDb, id);
      lastRecSession = null; selfRating = null;
      return { first, stillOpen, afterSave, second,
        closingNote: notes1.find((n) => n.closing) || null };
    });

    assert.ok(out.first.hasRating, 'stopping must offer the 1-5 rating');
    assert.ok(out.first.hasNoteBox,
      'and a place to write what it was like — a digit cannot say "scattered in a new way"');
    assert.ok(out.stillOpen,
      'picking a number must NOT close the screen, or the note can never be written');
    assert.strictEqual(out.afterSave.rating, 4, 'the rating must be kept');
    assert.match(out.afterSave.title, /shape of your sit/, 'and then the numbers are revealed');
    assert.ok(out.closingNote, 'the written note must be saved against the session');
    assert.strictEqual(out.closingNote.text, 'scattered, but in a new way');
    assert.strictEqual(out.closingNote.anchored, false,
      'a closing reflection is about the whole sit, not a moment in it');

    // The actual bug.
    assert.strictEqual(out.second.rating, null,
      'a new recording must clear the previous rating');
    assert.ok(out.second.hasRating,
      'the rating screen must appear again for a second sit in the same page load — it did not, because selfRating was never reset');
    console.log('✓ the rating screen returns each sit, and takes words as well as a number');
  }

  // 22) ONE-KEY TRANSITIONS. The only label that can be given without damaging the
  //     sit: one keystroke, no menu, nothing to compose, eyes shut.
  {
    const out = await page.evaluate(async () => {
      // Backdate the clock BEFORE starting, so the recorder's meta.startedAt and the
      // session clock stay the single value they are meant to be. Moving one after
      // the fact is what exposed notes carrying two disagreeing time fields.
      sessionStartedAt = Date.now() - 45000;      // pretend we are 45s into a sit
      recArmed = false; recSession = null;
      await ensureRecordingForTest();
      const before = markerLog.length;
      // Real keyboard events, not direct calls: the binding is the thing under test.
      // T not L: "Lost in thought" became "Thinking" on T, since it is the category
      // pressed most and the letter should match the word you say to yourself.
      for (const k of ['r', 'T', 'c']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      }
      // A key held down must not repeat into dozens of marks.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));

      const id = recSession && recSession.id;
      await stopRecording({ summary: false });
      const notes = id ? await Recorder.listNotes(recDb, id) : [];
      const transitions = notes.filter((n) => n.kind === 'transition');
      if (id) await Recorder.deleteSession(recDb, id);
      markerLog.clear();
      return {
        added: markerLog.length === 0,
        marksMade: before === 0,
        kinds: transitions.map((n) => n.transition),
        offsets: transitions.map((n) => Math.round(n.offsetSec)),
        anchored: transitions.every((n) => n.anchored !== false),
      };
    });
    // probes.js TAP_CATEGORIES is the single authority on these keys now; an earlier
    // version had labels.js disagreeing with it about what R, D and K meant.
    // The practitioner's own vocabulary; probes.js TAP_CATEGORIES is its single
    // authority, and labels.js mirrors it for naming in the export.
    assert.deepStrictEqual(out.kinds, ['returned', 'lost', 'concentrating'],
      `R T C must record returned/lost/concentrating (got ${out.kinds.join(', ')})`);
    // Case-insensitive: nobody checks caps lock mid-sit.
    assert.strictEqual(out.kinds.length, 3, 'a held key must not repeat into extra marks');
    assert.ok(out.offsets.every((o) => o >= 40 && o <= 60),
      `transitions must be stamped on the session clock (got ${out.offsets.join(', ')})`);
    assert.ok(out.anchored, 'a transition is a moment, so it must be anchored in time');
    console.log(`✓ one-key transitions record on the session clock: ${out.kinds.join(' ')}`);
  }

  // 21c) STOP MUST NOT BE OVERTAKEN BY START, and a start right after a stop must not
  //      be swallowed. Found by accident: turning Training on now arms a recording, and
  //      that made a later test see a session it had not created.
  //
  //      ensureRecording checked recArmed once at the top and then awaited
  //      Recorder.open() and startSession(). Stopping during those awaits — two
  //      keystrokes apart in practice — left the guard already passed, so it published
  //      a fresh recSession that nothing would ever end(): the button says "Record"
  //      while a live session writes to IndexedDB for the rest of the page's life.
  //      And the old `if (recStarting) return` meant the NEXT start was dropped on the
  //      floor, leaving "Waiting for data…" on screen with nothing recording.
  {
    const out = await page.evaluate(async () => {
      recArmed = false; recSession = null; recError = null; lastRecSession = null;

      // Stop while the session is still opening.
      const starting = startRecording();
      await stopRecording({ summary: false });
      await starting;
      await new Promise((r) => setTimeout(r, 250));
      const orphan = { armed: recArmed, session: !!recSession,
        button: document.getElementById('recBtn').textContent };

      // Now start again immediately. This must actually record.
      await startRecording();
      await new Promise((r) => setTimeout(r, 250));
      const restarted = { armed: recArmed, session: !!recSession,
        id: recSession && recSession.id,
        button: document.getElementById('recBtn').textContent };

      const id = recSession && recSession.id;
      await stopRecording({ summary: false });
      if (id != null && recDb) await Recorder.deleteSession(recDb, id);
      recArmed = false; recSession = null; lastRecSession = null; selfRating = null;
      document.getElementById('summary').classList.remove('show');
      return { orphan, restarted };
    });

    assert.strictEqual(out.orphan.armed, false, 'the stop must hold');
    assert.strictEqual(out.orphan.session, false,
      'a session opened after the stop must NOT be published — it would write to the'
      + ` database forever with nothing to end it (button read "${out.orphan.button}")`);
    assert.ok(out.restarted.armed && out.restarted.session,
      'and a start immediately after a stop must really record, not be swallowed by the'
      + ` previous attempt still being in flight (button read "${out.restarted.button}")`);
    console.log('✓ stop cannot be overtaken by an in-flight start, and the next start'
      + ' still records');
  }

  /* 22a2) ARROWS, SHIFT+T, SPACE, AND CUES OFF. A batch of keyboard changes asked for
   *       together, all of them about being able to work with your eyes shut.
   */
  {
    const out = await page.evaluate(async () => {
      sessionStartedAt = Date.now() - 30000;
      recArmed = false; recSession = null; recError = null;
      await ensureRecordingForTest();
      markerLog.clear();

      const press = async (init) => {
        const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
        document.dispatchEvent(e);
        await new Promise((r) => setTimeout(r, 60));
        return e.defaultPrevented;
      };

      // The four arrows: up focusing, down just sitting, left returned, right thinking.
      const prevented = [];
      for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
        prevented.push(await press({ key: k }));
      }
      const arrowKinds = markerLog.list().map((m) => m.kind);

      // Shift+T is Training; plain T must NOT toggle it, since T is now a tap.
      const trainBefore = trainingMode;
      await press({ key: 'T', shiftKey: true });
      const afterShift = trainingMode;
      await press({ key: 'T', shiftKey: true });        // back off
      const beforePlain = markerLog.length;
      await press({ key: 't' });
      const plainTapped = markerLog.length - beforePlain;
      const plainKind = markerLog.list()[markerLog.length - 1].kind;

      const id = recSession && recSession.id;
      const stored = id ? await Recorder.listNotes(recDb, id) : [];
      await stopRecording({ summary: false });
      if (id) await Recorder.deleteSession(recDb, id);
      markerLog.clear(); setTrainingMode(false);
      document.getElementById('summary').classList.remove('show');
      selfRating = null; lastRecSession = null;

      return { prevented, arrowKinds, trainBefore, afterShift,
        plainTapped, plainKind, cuesOn: cueEngine.enabled,
        cuePill: document.getElementById('cueToggle').textContent,
        storedKinds: stored.filter((n) => n.transition).map((n) => n.transition) };
    });

    assert.deepStrictEqual(out.arrowKinds,
      ['concentrating', 'just-sitting', 'returned', 'lost'],
      `the arrows must map up/down/left/right to focusing/just-sitting/returned/thinking`
      + ` (got ${out.arrowKinds.join(', ')})`);
    assert.ok(out.prevented.every(Boolean),
      'and must preventDefault, or the page scrolls under every mark');
    assert.ok(out.storedKinds.length >= 4, 'arrow taps must be recorded like any other');

    assert.strictEqual(out.trainBefore, false, 'precondition: training starts off');
    assert.strictEqual(out.afterShift, true, 'Shift+T must toggle Training');
    assert.strictEqual(out.plainTapped, 1,
      'plain T must record a tap, not toggle Training — it is the most-pressed category');
    assert.strictEqual(out.plainKind, 'lost', 'and that tap is Thinking');

    // Cues off by default: an unrequested interruption is opted into, not out of.
    assert.strictEqual(out.cuesOn, false, 'cues must be OFF on load');
    assert.match(out.cuePill, /Cues: off/, 'and the pill must say so');
    console.log('✓ arrows tap the four common categories, Shift+T is Training, plain T is'
      + ' Thinking, and cues start off');
  }

  // 22b) A MARK MADE WHILE NOTHING IS RECORDING MUST SAY SO.
  //      markerLog.add() always succeeds, so the screen flash fires and the on-screen
  //      count goes up whether or not a session exists. A whole sit was tapped through
  //      under the impression it was being saved, and the confirmation looked identical
  //      to a saved one. The mark still belongs in the live display; the wording is
  //      what has to differ.
  {
    const out = await page.evaluate(async () => {
      recArmed = false; recSession = null; recError = null;
      markerLog.clear();
      const before = markerLog.length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const unsaved = { status: document.getElementById('status').textContent,
        counted: markerLog.length - before, session: !!recSession };

      // Now with a session, the same key must NOT carry the warning.
      sessionStartedAt = Date.now() - 20000;
      recArmed = false; recSession = null;
      await ensureRecordingForTest();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const saved = { status: document.getElementById('status').textContent,
        session: !!recSession };

      const id = recSession && recSession.id;
      await stopRecording({ summary: false });
      if (id) await Recorder.deleteSession(recDb, id);
      markerLog.clear();
      return { unsaved, saved };
    });

    assert.strictEqual(out.unsaved.session, false, 'precondition: nothing recording');
    assert.strictEqual(out.unsaved.counted, 1,
      'the mark still counts on screen — it is the confirmation wording that changes');
    assert.match(out.unsaved.status, /won.t be saved|not recording/i,
      'a mark made with no recording running must say it is not being saved, got: '
      + JSON.stringify(out.unsaved.status));
    assert.ok(out.saved.session, 'precondition: a session exists for the second half');
    assert.doesNotMatch(out.saved.status, /won.t be saved|not recording/i,
      'and it must NOT cry wolf once a recording IS running, got: '
      + JSON.stringify(out.saved.status));
    console.log('✓ a mark made while nothing is recording says so, and only then');
  }

  // 23) The closing screen's dimension grid. Optional, clearable, and it shows the
  //     ANCHOR TEXT — a digit alone drifts in meaning between sits.
  {
    const out = await page.evaluate(async () => {
      await startRecording();
      for (let i = 0; i < 6; i++) sessionLog.push({ t: i, calm: 0.5, noise: 0 });
      const id = recSession && recSession.id;
      await stopRecording();
      await new Promise((r) => setTimeout(r, 150));

      const grid = document.getElementById('dimGrid');
      const rows = grid ? grid.querySelectorAll('.dimRow').length : 0;
      // Focused, effortlessly: the state a single score cannot distinguish.
      document.querySelector('.dimDot[data-dim="focus"][data-val="5"]').click();
      document.querySelector('.dimDot[data-dim="effort"][data-val="1"]').click();
      const wordShown = document.querySelector('[data-word="focus"]').textContent;
      // Clicking the same value again must clear it — a mis-click must not become a
      // permanent rating, and "I don't know" has to remain sayable.
      document.querySelector('.dimDot[data-dim="effort"][data-val="1"]').click();
      const clearedWord = document.querySelector('[data-word="effort"]').textContent;
      document.querySelector('.dimDot[data-dim="effort"][data-val="1"]').click();

      document.querySelector('[data-rate="4"]').click();
      document.getElementById('sumNote').value = 'it opened on its own';
      document.getElementById('sumDone').click();
      await new Promise((r) => setTimeout(r, 200));

      const notes = id ? await Recorder.listNotes(recDb, id) : [];
      const closing = notes.find((n) => n.closing);
      if (id) await Recorder.deleteSession(recDb, id);
      summaryEl.classList.remove('show');
      selfRating = null; lastRecSession = null;
      return { rows, wordShown, clearedWord, closing: closing || null };
    });

    assert.strictEqual(out.rows, 4, 'all four dimensions must be offered');
    assert.match(out.wordShown, /one-pointed/,
      `choosing 5 must show what 5 MEANS (got "${out.wordShown}")`);
    assert.strictEqual(out.clearedWord, '',
      'clicking the same value again must clear it, so a mis-click is not permanent');
    assert.ok(out.closing, 'the closing note must be saved');
    assert.deepStrictEqual(out.closing.dims, { focus: 5, effort: 1 },
      'the ratings must be stored as given, with unreported dimensions absent');
    assert.strictEqual(out.closing.text, 'it opened on its own');
    assert.strictEqual(out.closing.anchored, false, 'a closing report covers the whole sit');
    // And the derived state, which is the reason effort is recorded separately.
    assert.strictEqual(Labels_quadrant(out.closing.dims), 'absorbed');
    console.log('✓ the closing screen records all four dimensions, in words, and clears on re-click');
  }

  // 24) A WHOLE TRIAL PROTOCOL, driven through the real tick. Blocks must be cued at
  //     their boundaries and recorded with their condition, or the labels the whole
  //     validation effort depends on are simply absent.
  {
    const out = await page.evaluate(async () => {
      // A short synthetic protocol, so the test runs in seconds rather than minutes.
      // Injected rather than shortening the real ones, which have to stay long enough
      // to be usable — a 2-second meditation block is not a meditation block.
      Trials.BY_KEY['test-proto'] = {
        key: 'test-proto', label: 'Test', purpose: 'test', blurb: '', expectation: 'x',
        blockSec: 1, settleSec: 0.3, repeats: 2,
        conditions: [
          { key: 'a', label: 'Aye', instruction: 'do A' },
          { key: 'b', label: 'Bee', instruction: 'do B' },
        ],
      };
      const tones = [];
      const realTone = window.tone;
      window.tone = (hz) => tones.push(hz);

      await startRecording();
      const id = recSession && recSession.id;
      await startTrial('test-proto');
      const started = { hud: !document.getElementById('trialHud').hidden,
        link: document.getElementById('trialsLink').textContent };

      // Let the real tick drive it to completion: 2 repeats x 2 conditions x 1s.
      const seen = [];
      const deadline = Date.now() + 8000;
      while (trialRun && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const instr = document.getElementById('trialInstr').textContent;
        const settling = document.getElementById('trialHud').classList.contains('settling');
        if (instr && (!seen.length || seen[seen.length - 1].instr !== instr)) {
          seen.push({ instr, settling });
        }
      }
      const finished = { run: trialRun, hud: document.getElementById('trialHud').hidden,
        link: document.getElementById('trialsLink').textContent };

      const notes = id ? await Recorder.listNotes(recDb, id) : [];
      window.tone = realTone;
      if (id) await Recorder.deleteSession(recDb, id);
      delete Trials.BY_KEY['test-proto'];
      summaryEl.classList.remove('show');
      selfRating = null;
      return {
        started, finished, seen, tones,
        blocks: notes.filter((n) => n.kind === 'block')
          .sort((a, b) => a.blockIndex - b.blockIndex)
          .map((n) => ({ c: n.condition, i: n.blockIndex, t: n.offsetSec })),
        trialStart: notes.find((n) => n.kind === 'trial-start') || null,
        trialEnd: notes.find((n) => n.kind === 'trial-end') || null,
      };
    });

    assert.ok(out.started.hud, 'starting a trial must show the instruction');
    assert.match(out.started.link, /^Trial: /, 'and the pill must say a trial is running');

    // Every block recorded, in order, with its condition — this is the label.
    assert.strictEqual(out.blocks.length, 4, `four blocks must be recorded (got ${out.blocks.length})`);
    assert.deepStrictEqual(out.blocks.map((b) => b.i), [0, 1, 2, 3], 'indexed in order');
    const conds = out.blocks.map((b) => b.c);
    for (let i = 1; i < conds.length; i++) {
      assert.notStrictEqual(conds[i], conds[i - 1],
        `conditions must alternate in the RECORD too (got ${conds.join(',')})`);
    }
    // Boundaries must be stamped on the session clock, increasing.
    for (let i = 1; i < out.blocks.length; i++) {
      assert.ok(out.blocks[i].t > out.blocks[i - 1].t, 'block times must increase');
    }

    /* One audible cue per boundary, at two distinct pitches — the protocol is meant to
     * be followed with the eyes closed, so a screen-only boundary would be missed.
     *
     * Filtered to the two BOUNDARY pitches rather than taking the first four sounds:
     * the app also chimes at the end of the protocol and again when a recording stops,
     * and an assertion that counts every sound breaks whenever another one is added
     * for a good reason. */
    const boundaryTones = out.tones.filter((hz) => hz === 660 || hz === 440);
    assert.strictEqual(boundaryTones.length, 4,
      `one cue per block (got ${boundaryTones.length} of ${out.tones.join(',')})`);
    assert.strictEqual(new Set(boundaryTones).size, 2,
      `each condition needs its own pitch so it is identifiable unseen (got ${boundaryTones.join(',')})`);
    assert.ok(out.tones.some((hz) => hz !== 660 && hz !== 440),
      'and a distinct chime at the end, not just more boundary tones');

    // The settling phase must have been visible at least once, or the meditator is
    // never told which stretch does not count.
    assert.ok(out.seen.some((v) => v.settling),
      'the settling phase must be shown, so it is clear that stretch is not measured');

    assert.strictEqual(out.finished.run, null, 'the trial must end itself when the blocks run out');
    assert.ok(out.finished.hud, 'and hide the instruction');
    assert.strictEqual(out.finished.link, 'Trials', 'and reset the pill');
    assert.ok(out.trialStart && out.trialEnd, 'the run must be bracketed in the record');
    assert.strictEqual(out.trialEnd.completed, true, 'and marked as completed rather than abandoned');
    console.log(`✓ a full trial runs, cues each boundary audibly, and records`
      + ` ${out.blocks.length} labelled blocks: ${conds.join(' ')}`);
  }

  // 25) PROBES: the unbiased half of the labelling, and the only way to sample states
  //     that went unnoticed. Tied to Training mode, because being interrupted
  //     unpredictably is the last thing anyone wants in an ordinary sit.
  {
    const out = await page.evaluate(async () => {
      const tones = [];
      const realTone = window.tone;
      window.tone = (hz) => tones.push(hz);

      setTrainingMode(false);
      sessionStartedAt = Date.now() - 300000;   // 5 minutes into a sit
      recArmed = false; recSession = null;
      await ensureRecordingForTest();
      const id = recSession && recSession.id;

      // OFF by default: with training off, no probe may fire however overdue.
      probeTimes = [10]; probeAnswers = [];
      updateProbes();
      const whileOff = { fired: !!probePending, hud: probeHudEl.hidden };

      setTrainingMode(true);
      const armedVisible = !document.getElementById('armedBar').hidden;
      // Training on is NOT consent to be interrupted: probes stay off until asked for.
      updateProbes();
      const probesOffByDefault = !!probePending;
      // Opt in through the real control in the training panel, not by setting the flag.
      document.querySelector('[data-probe-toggle]').click();
      updateProbes();
      // The cue is two notes, the second on a short delay so they read as a pair
      // rather than a chord — so wait for it before counting.
      await new Promise((r) => setTimeout(r, 300));
      const fired = {
        pending: !!probePending,
        hud: !probeHudEl.hidden,
        options: probeOptsEl.querySelectorAll('[data-resp]').length,
        // The question must be about the moment BEFORE the cue, since the cue itself
        // redirects attention.
        question: document.getElementById('probeQ').textContent,
        meta: probeMetaEl.textContent,
        tones: tones.slice(),
      };

      // Answer by keyboard, which is the path that must work with eyes barely open.
      await new Promise((r) => setTimeout(r, 700));   // a measurable latency
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const answered = { pending: !!probePending, hud: probeHudEl.hidden,
        count: probeAnswers.length, response: probeAnswers[0] && probeAnswers[0].response,
        latency: probeAnswers[0] && probeAnswers[0].latencySec };

      // A MISS is data too — it usually means gone, or asleep — so it must be recorded
      // rather than left hanging.
      probeTimes = [10, 20];
      updateProbes();
      const secondFired = !!probePending;
      if (probePending) probePending.cuedAt = Date.now() - 60000;   // force the timeout
      updateProbes();
      await new Promise((r) => setTimeout(r, 200));
      const missed = probeAnswers.find((a) => a.missed);

      const notes = id ? await Recorder.listNotes(recDb, id) : [];
      window.tone = realTone;
      setTrainingMode(false);
      await stopRecording({ summary: false });
      if (id) await Recorder.deleteSession(recDb, id);
      probeTimes = []; probeAnswers = []; probePending = null;
      probesEnabled = false;
      return { whileOff, armedVisible, probesOffByDefault, fired, answered, missed: !!missed,
        stored: notes.filter((n) => n.kind === 'probe').map((n) => ({
          r: n.response, l: n.latencySec, missed: n.missed, at: n.probeAtSec })) };
    });

    assert.strictEqual(out.whileOff.fired, false,
      'with Training off, no probe may fire — probes must be opt-in');
    /* AND TRAINING ALONE IS NOT CONSENT TO BE INTERRUPTED. Reported: "in training mode, I
       don't want the popups to come up." One switch was meaning two things — turning on
       the tap panel also signed you up for a question every few minutes. Probes are now
       separately opt-in and off by default. */
    assert.strictEqual(out.probesOffByDefault, false,
      'probes must be OFF until asked for, even with training on');
    assert.ok(out.armedVisible, 'Training on must show which key records what');
    assert.ok(out.fired.pending && out.fired.hud, 'an overdue probe must fire and show');
    assert.strictEqual(out.fired.options, 5, 'five one-tap options');
    assert.match(out.fired.question, /just before/,
      'the question must ask about the moment BEFORE the cue, not the moment of it');
    assert.match(out.fired.meta, /BEFORE the sound/, 'and say so again by the buttons');
    /* Audible, and a PAIR of pitches rather than one — so a probe is never mistaken for
     * a trial block boundary, which is a single tone.
     *
     * Not an exact count: the page's own 250ms tick calls updateProbes() concurrently
     * with the test, so how many cue pairs land inside the sampling window is timing
     * dependent. The property that matters is two distinct pitches, not how many times
     * they played. */
    assert.ok(out.fired.tones.length >= 2,
      `a probe must be audible (got ${out.fired.tones.length} tones)`);
    assert.ok(new Set(out.fired.tones).size >= 2,
      `and use two distinct pitches so it cannot be confused with a trial boundary's`
      + ` single tone (got ${Array.from(new Set(out.fired.tones)).join(', ')})`);

    assert.strictEqual(out.answered.pending, false, 'answering must clear the probe');
    assert.ok(out.answered.hud, 'and hide it');
    assert.strictEqual(out.answered.response, 'unaware-off',
      'key 3 must record "off, just realised" — the state self-catching cannot see');
    assert.ok(out.answered.latency >= 0.8,
      `latency must be measured from the cue (got ${out.answered.latency})`);

    assert.ok(out.missed, 'an unanswered probe must be recorded as missed, not dropped');
    const storedMiss = out.stored.find((n) => n.missed);
    assert.ok(storedMiss, 'and the miss must reach storage');
    const storedAnswer = out.stored.find((n) => n.r === 'unaware-off');
    assert.ok(storedAnswer && storedAnswer.l >= 0.8, 'the answer and its latency must persist');
    assert.ok(storedAnswer.at != null, 'with the SCHEDULED time, not the answer time —'
      + ' the labelled window is measured from when the cue fired');
    console.log('✓ probes are opt-in, audible, one-tap, latency-timed, and misses are recorded');
  }

  // 26) POPOVERS: exactly one open, toggling off on a second press, and dismissed by an
  //     outside click. Reported live: the Timer panel would not close, and it covered
  //     the Connect panel underneath so neither could be dismissed.
  {
    const out = await page.evaluate(async () => {
      const dev = document.getElementById('devices');
      const timer = document.getElementById('timerPicker');
      const trials = document.getElementById('trialPicker');
      const hidden = () => ({ dev: dev.hidden, timer: timer.hidden, trials: trials.hidden });
      setPopover(null);

      document.getElementById('devToggle').click();
      const afterDev = hidden();
      // THE BUG: opening the timer left the devices panel open behind it.
      document.getElementById('timerLink').click();
      const afterTimer = hidden();
      // AND THE OTHER HALF: a second press must close it.
      document.getElementById('timerLink').click();
      const afterSecond = hidden();

      document.getElementById('trialsLink').click();
      const afterTrials = hidden();
      // An outside click dismisses.
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const afterOutside = hidden();

      // Choosing a duration must close the panel too, not leave it open over the bar.
      document.getElementById('timerLink').click();
      const opts = timer.querySelectorAll('button').length;
      timer.querySelector('[data-min="10"]').click();
      const afterChoice = { hidden: hidden(), endSet: timerEndAt != null };
      timerEndAt = null; timerDone = false; setPopover(null);
      return { afterDev, afterTimer, afterSecond, afterTrials, afterOutside, afterChoice, opts };
    });

    assert.deepStrictEqual(out.afterDev, { dev: false, timer: true, trials: true },
      'Connect opens only the device panel');
    assert.deepStrictEqual(out.afterTimer, { dev: true, timer: false, trials: true },
      'opening the Timer must CLOSE the device panel — two open at once is what buried'
      + ' Connect underneath and made both undismissable');
    assert.deepStrictEqual(out.afterSecond, { dev: true, timer: true, trials: true },
      'a second press on Timer must close it');
    assert.deepStrictEqual(out.afterTrials, { dev: true, timer: true, trials: false },
      'and Trials replaces whatever was open');
    assert.deepStrictEqual(out.afterOutside, { dev: true, timer: true, trials: true },
      'an outside click must dismiss the open popover');
    assert.ok(out.opts >= 4, `the timer must offer its durations (got ${out.opts})`);
    assert.ok(out.afterChoice.hidden.timer && out.afterChoice.endSet,
      'choosing a duration sets the timer and closes the panel');
    console.log('✓ one popover at a time, toggling off, and dismissed by an outside click');
  }

  // 26b) POPOVERS ACTUALLY DISAPPEAR — asserted on computed style and painted size,
  //      not on the `hidden` property.
  //
  //      The test above passed while the Connect panel stayed on screen. `hidden` is
  //      only an attribute; it takes effect through the UA sheet's
  //      `[hidden] { display: none }`, which ANY author rule setting `display`
  //      overrides — and `#devices { display: flex }` is an ID selector, so it won
  //      outright. The panel was never hideable: `dev.hidden === true` the whole time.
  //      So the assertion has to be something the eye could also check.
  //
  //      Same rule for `#timerPicker { display: flex }`, and that one produced the
  //      "mysterious black dot": empty until renderTimerPicker fills it on first open,
  //      it painted a 22x22 box (10px padding + 1px border, dark, 12px radius) at the
  //      popover origin, overlapping the devices panel's lower edge.
  {
    const out = await page.evaluate(async () => {
      const ids = ['devices', 'timerPicker', 'trialPicker'];
      const paint = () => ids.map((id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        return { id, display: getComputedStyle(el).display,
          w: Math.round(r.width), h: Math.round(r.height) };
      });
      setPopover(null);
      const atRest = paint();

      document.getElementById('devToggle').click();
      const opened = paint();
      document.getElementById('devToggle').click();
      const closed = paint();

      /* And nothing anywhere on the page paints a small filled SQUARE with nothing in
         it — the generalised form of the dot, since the next empty container to grow a
         `display` rule would look identical.
         The bounds are deliberate and both are needed. Square-ish excludes bar fills
         (`<i style="width:37%">` is legitimately empty, and is a long thin sliver).
         The 14px floor excludes the intentional indicator dots — .tierLight and
         .legendItem .swatch are 7-8px squares that are supposed to be empty. An empty
         container collapses to its padding plus border, which in this stylesheet is
         22px, comfortably above the floor. */
      const blobs = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 14 || r.width > 40 || r.height < 14 || r.height > 40) continue;
        const aspect = r.width / r.height;
        if (aspect < 0.6 || aspect > 1.7) continue;
        const solid = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
        const empty = !(el.textContent || '').trim() && el.children.length === 0;
        if (solid && empty) blobs.push({ sel: el.id ? '#' + el.id : el.tagName,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height) });
      }
      return { atRest, opened, closed, blobs };
    });

    for (const p of out.atRest) {
      assert.strictEqual(p.display, 'none',
        `#${p.id} must not be painted before it is opened — it was ${p.display} at`
        + ` ${p.w}x${p.h}px. An empty popover ${p.w}px square IS the black dot.`);
    }
    const devOpen = out.opened.find((p) => p.id === 'devices');
    assert.ok(devOpen.display !== 'none' && devOpen.w > 100,
      `Connect must open a real panel (got ${devOpen.display} at ${devOpen.w}px)`);
    const devClosed = out.closed.find((p) => p.id === 'devices');
    assert.strictEqual(devClosed.display, 'none',
      'a second press on Connect must make the panel GONE, not merely set hidden —'
      + ` computed display was ${devClosed.display} at ${devClosed.w}x${devClosed.h}px`);
    assert.strictEqual(devClosed.w, 0, 'and it must occupy no space');
    assert.deepStrictEqual(out.blobs, [],
      `no element may paint a small filled box with nothing in it: ${JSON.stringify(out.blobs)}`);
    console.log('✓ popovers vanish by computed style, and nothing paints an empty dot');
  }

  // 27) The bar is three LABELLED groups, in the order the practice uses them.
  {
    const groups = await page.evaluate(() => Array.from(
      document.querySelectorAll('#controls .pillGroup')).map((g) => ({
        label: g.querySelector('.groupLabel').textContent,
        pills: Array.from(g.querySelectorAll('.pills .pill')).map((p) => p.textContent.trim()),
      })));
    assert.strictEqual(groups.length, 3, `three groups (got ${groups.length})`);
    assert.deepStrictEqual(groups.map((g) => g.label), ['View', 'Practice', 'Session']);
    // The arrangement asked for: settings live with what they affect, and Connect sits
    // with the session controls rather than in a group of its own.
    assert.ok(groups[0].pills.some((p) => /^Cues/.test(p)), 'Cues belongs with the view controls');
    /* Response is NOT in the bar any more. It moved into the Metrics panel, both
       because it was asked for ("maybe the sensitivity button can kinda go in the
       metrics") and because it had to: fourteen pills across three labelled groups
       needed ~1770px, a 1920px window offers 1728 after padding, and the bar wrapped
       Session onto its own row at anything narrower. */
    assert.ok(!groups.some((g) => g.pills.some((p) => /^Response/.test(p))),
      'Response belongs in the Metrics panel, not in the bar');
    const resp = await page.evaluate(() => {
      const el = document.getElementById('responseToggle');
      return el ? { inReadout: !!el.closest('#readout'), text: el.textContent } : null;
    });
    assert.ok(resp && resp.inReadout,
      'but it must still exist, inside the Metrics panel — a control that vanishes in a'
      + ' reorganisation is worse than a crowded bar');
    assert.ok(groups[1].pills.some((p) => /^Trials$/.test(p)), 'Trials belongs with Practice');
    assert.ok(groups[1].pills.some((p) => /^Timer/.test(p)), 'and Timer');
    assert.ok(groups[2].pills.some((p) => /^Connect$/.test(p)), 'Connect belongs with Session');
    assert.ok(groups[2].pills.some((p) => /^Saved sessions$/.test(p)));
    /* THE LAB HAS TO BE REACHABLE. It was only openable by knowing to type lab.html
       into the address bar, which is not a way to reach anything — the whole validation
       side of this project was effectively hidden. A real <a> with target=_blank, not a
       click handler that navigates: opening it must not tear down a recording sit. */
    const lab = await page.evaluate(() => {
      const a = document.getElementById('labLink');
      if (!a) return null;
      return { tag: a.tagName, href: a.getAttribute('href'), target: a.target,
        text: a.textContent.trim(), inSession: !!a.closest('.pillGroup')
          && a.closest('.pillGroup').querySelector('.groupLabel').textContent === 'Session',
        underlined: getComputedStyle(a).textDecorationLine };
    });
    assert.ok(lab, 'the bar must offer a way into the analysis lab');
    assert.strictEqual(lab.tag, 'A', 'a real link, so it can open in a new tab');
    assert.strictEqual(lab.href, 'lab.html');
    assert.strictEqual(lab.target, '_blank',
      'opening the lab must not navigate away from a sit that may be recording');
    assert.ok(lab.inSession, 'and it belongs with the Session controls');
    assert.strictEqual(lab.underlined, 'none', 'styled as a pill, not as a link');
    // Every pill must still be somewhere: a reorganisation that loses a control is worse
    // than a messy bar.
    const all = groups.flatMap((g) => g.pills);
    for (const must of ['Metrics', 'Live feed', 'Visuals', 'Summarize session']) {
      assert.ok(all.some((p) => p.startsWith(must)), `${must} must not be lost in the regroup`);
    }
    console.log(`✓ the bar is 3 labelled groups: ${groups.map((g) => `${g.label} (${g.pills.length})`).join(', ')}`);
  }

  // 27b) V IS THE VOICE NOTE AND NOTHING ELSE.
  //      V was bound twice inside one keydown handler: to visual.cycleMode and then to
  //      startVoiceNote. Both ran, and only the voice branch guarded `e.repeat` — so
  //      holding V to speak walked through every visualisation, one per key-repeat.
  //      Ordering the branches cannot fix that; the collision itself had to go.
  {
    const out = await page.evaluate(async () => {
      const modeOf = () => visual.currentMode().key;
      const before = modeOf();
      // Hold V the way the browser reports a held key: one event, then repeats.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', repeat: true, bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      const afterHold = modeOf();

      // `]` and `[` are the cycle keys now, and `[` must go back rather than forward
      // through six visuals to arrive at the previous one.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
      const afterNext = modeOf();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }));
      const afterPrev = modeOf();
      return { before, afterHold, afterNext, afterPrev };
    });

    assert.strictEqual(out.afterHold, out.before,
      `holding V must not change the visual — it went ${out.before} -> ${out.afterHold}`);
    assert.notStrictEqual(out.afterNext, out.before, '] must advance the visual');
    assert.strictEqual(out.afterPrev, out.before,
      `[ must step back to where ] came from (${out.before} -> ${out.afterNext} -> ${out.afterPrev})`);
    console.log(`✓ V no longer cycles visuals; ] and [ step forward and back (${out.afterNext})`);
  }

  // 27c) THE HOLD GESTURE SURVIVES THE BUTTON CHANGING SIZE UNDER THE FINGER.
  //      Reported as "if I hold the button down, it just flashes, and then it
  //      disappears immediately". The label goes from "Hold to speak V" to
  //      "Listening… release to save", the pill grows by ~40px and re-flows the bar,
  //      and the pointer — which never moved — is suddenly outside the element it
  //      pressed. `pointerleave` fired and stopped the recording at once.
  {
    // Press, let the label change, and confirm recording is still live even though the
    // element under the original pointer position is no longer the button.
    const held = await page.evaluate(async () => {
      const btn = document.getElementById('voiceNote');
      const box = btn.getBoundingClientRect();
      const at = { x: Math.round(box.left + 6), y: Math.round(box.top + box.height / 2) };
      const widthBefore = box.width;
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7,
        clientX: at.x, clientY: at.y, button: 0 }));
      await new Promise((r) => setTimeout(r, 350));   // getUserMedia + MediaRecorder.start
      const widthAfter = btn.getBoundingClientRect().width;
      // What is under the finger now? If the pill grew, this is no longer the pill.
      const under = document.elementFromPoint(at.x, at.y);
      const stillRecording = !!(mediaRecorder && mediaRecorder.state === 'recording');
      const label = btn.textContent;
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7,
        clientX: at.x, clientY: at.y }));
      await new Promise((r) => setTimeout(r, 250));
      return { widthBefore, widthAfter, stillRecording, label,
        // The premise of the bug, asserted rather than assumed: the pointer never
        // moved, and what sits under it is no longer the button it pressed.
        underIsButton: under === btn || btn.contains(under),
        stoppedAfter: !mediaRecorder };
    });
    assert.ok(held.widthAfter > held.widthBefore,
      'precondition: the label change must actually widen the pill, or this test proves'
      + ` nothing (${held.widthBefore} -> ${held.widthAfter})`);
    assert.ok(held.stillRecording,
      `the recording must survive the label change — it was already stopped.`
      + ` label="${held.label}", width ${held.widthBefore}->${held.widthAfter}`);
    assert.match(held.label, /Listening/, 'and the button must say it is listening');
    assert.ok(held.stoppedAfter, 'releasing must stop it and release the microphone');
    console.log('✓ hold-to-speak survives the button re-flowing under the pointer'
      + ` (${Math.round(held.widthBefore)} -> ${Math.round(held.widthAfter)}px)`);
  }

  // 27d) A RELEASE THAT BEATS getUserMedia MUST STILL STOP THE MICROPHONE.
  //      startVoiceNote awaits the permission/stream, which is slower than a short
  //      press. stopVoiceNote would find `mediaRecorder === null`, do nothing, and the
  //      recorder would start a moment later with nothing left to stop it — the mic
  //      stays open for the rest of the sit, indicator light and all.
  {
    const out = await page.evaluate(async () => {
      startVoiceNote();            // not awaited: the release lands mid-flight
      stopVoiceNote();
      await new Promise((r) => setTimeout(r, 600));
      return { recorder: mediaRecorder ? mediaRecorder.state : null };
    });
    assert.strictEqual(out.recorder, null,
      `a press released before the mic opened must not leave a recorder running`
      + ` (state: ${out.recorder})`);
    console.log('✓ a press released before the microphone opened still closes it');
  }

  // 27e) PANELS MOVE. Reported: Live feed opens over its own pill so it cannot be
  //      closed, and the training clock lands under the Record button. A fixed corner
  //      per panel cannot suit every combination that happens to be open.
  {
    const out = await page.evaluate(async () => {
      const el = document.getElementById('dataPanel');
      const grip = el.querySelector(':scope > .panelGrip');
      if (!grip) return { noGrip: true };
      const from = el.getBoundingClientRect();
      const g = grip.getBoundingClientRect();
      const at = { x: Math.round(g.left + g.width / 2), y: Math.round(g.top + g.height / 2) };
      const send = (type, dx = 0, dy = 0) => grip.dispatchEvent(new PointerEvent(type,
        { bubbles: true, pointerId: 3, button: 0, clientX: at.x + dx, clientY: at.y + dy }));
      send('pointerdown');
      send('pointermove', 120, -80);
      send('pointerup', 120, -80);
      await new Promise((r) => setTimeout(r, 30));
      const to = el.getBoundingClientRect();
      const saved = localStorage.getItem('zenbio.panel.dataPanel');

      // Double-clicking the grip puts it back, and forgets the position — otherwise the
      // only way out of a bad drag is clearing browser storage.
      grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      const reset = el.getBoundingClientRect();
      const clearedStore = localStorage.getItem('zenbio.panel.dataPanel');

      // A drag must NOT be triggered by clicking a control inside the panel.
      const toggle = document.getElementById('dataToggle');
      const beforeClick = el.getBoundingClientRect();
      toggle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 4, button: 0,
        clientX: Math.round(beforeClick.left + 30), clientY: Math.round(beforeClick.top + 30) }));
      toggle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 4,
        clientX: Math.round(beforeClick.left + 130), clientY: Math.round(beforeClick.top + 30) }));
      toggle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4,
        clientX: Math.round(beforeClick.left + 130), clientY: Math.round(beforeClick.top + 30) }));
      const afterInnerDrag = el.getBoundingClientRect();

      return {
        dx: Math.round(to.left - from.left), dy: Math.round(to.top - from.top),
        saved: saved ? JSON.parse(saved) : null,
        resetBack: Math.abs(reset.left - from.left) < 2 && Math.abs(reset.top - from.top) < 2,
        clearedStore,
        innerDragMoved: Math.abs(afterInnerDrag.left - beforeClick.left) > 2,
      };
    });

    assert.ok(!out.noGrip, 'every draggable panel must carry a grip to drag it by');
    assert.strictEqual(out.dx, 120, `dragging right 120px must move the panel 120px (got ${out.dx})`);
    assert.strictEqual(out.dy, -80, `and up 80px (got ${out.dy})`);
    assert.ok(out.saved && Number.isFinite(out.saved.x),
      `the position must persist, got ${JSON.stringify(out.saved)}`);
    assert.ok(out.resetBack, 'double-clicking the grip must put the panel back where it started');
    assert.strictEqual(out.clearedStore, null, 'and must forget the stored position');
    assert.ok(!out.innerDragMoved,
      'dragging from a control INSIDE the panel must not move the panel — that would'
      + ' make the Live feed collapse toggle unusable');
    console.log('✓ panels drag by their grip, persist, reset on double-click, and'
      + ' ignore drags that start on a control');
  }

  // 27f) The panels that were reported as being in the way are all draggable, and the
  //      grip survives the panels that rebuild their own innerHTML.
  {
    const out = await page.evaluate(async () => {
      setTrainingMode(true);
      renderArmedBar();            // rebuilds innerHTML — this is what ate the old grip
      renderModeBar();
      const check = (id) => {
        const el = document.getElementById(id);
        return { id, present: !!el, grip: !!(el && el.querySelector(':scope > .panelGrip')) };
      };
      const r = ['readout', 'dataPanel', 'modeBar', 'armedBar'].map(check);
      // While we are here: the training pill must LIGHT UP, not just change its word.
      const pill = document.getElementById('trainToggle');
      const on = { active: pill.classList.contains('active'), text: pill.textContent };
      // The mark hint belongs at the TOP of this panel, with the keys it describes,
      // rather than in a separate corner element under a large elapsed clock.
      const hint = armedBarEl.querySelector('.armedHint');
      const firstChip = armedBarEl.querySelector('.a');
      const hintFirst = !!(hint && firstChip
        && hint.compareDocumentPosition(firstChip) & Node.DOCUMENT_POSITION_FOLLOWING);
      setTrainingMode(false);
      const off = { active: pill.classList.contains('active'), text: pill.textContent };
      // Turning training ON now starts a recording (see setTrainingMode), so this test
      // has to put that back or it leaks an armed recorder into everything after it.
      const autoArmed = recArmed;
      await stopRecording({ summary: false });
      recArmed = false; recSession = null; lastRecSession = null; selfRating = null;
      return { r, on, off, autoArmed, hintText: hint && hint.textContent,
        hintFirst, clockGone: !document.getElementById('trainClock') };
    });

    for (const p of out.r) {
      assert.ok(p.present, `#${p.id} must exist`);
      assert.ok(p.grip, `#${p.id} must still have its grip after a re-render —`
        + ' innerHTML rebuilds destroy children, which is why the drag listeners live'
        + ' on the panel and the grip is re-inserted');
    }
    assert.ok(out.on.active, `the Training pill must highlight when on (text: "${out.on.text}")`);
    assert.ok(!out.off.active, 'and stop highlighting when off');
    // Asked for: drop the elapsed clock, and put the hint at the top of the word panel.
    // A running clock is a thing to watch, which is the opposite of what a sit needs,
    // and the Record pill already shows elapsed time for anyone who wants it.
    assert.ok(out.clockGone, 'the separate elapsed-time clock element must be gone');
    assert.match(out.hintText || '', /press\s*M\s*to mark/i,
      `the armed panel must carry the mark hint (got ${JSON.stringify(out.hintText)})`);
    assert.ok(out.hintFirst, 'and it must be at the TOP, above the categories');
    // Asked for: "when you hit training, maybe it auto records." Training exists to
    // gather data, and every label it collects is worthless if nothing is saving them.
    assert.ok(out.autoArmed,
      'turning Training on must start recording — a sit tapped through with nothing'
      + ' armed produces marks that look identical to saved ones and are not kept');
    console.log('✓ four panels drag, grips survive re-renders, Training highlights,'
      + ' and the mark hint heads the word panel');
  }

  // 28) THE TIMER RUNNING OUT MUST STOP THE RECORDING. Reported: it did not, and the
  //     sit had to be stopped by hand. Driven through the REAL tick and the REAL timer
  //     pill, because the previous claim that this worked was an inference from a
  //     screenshot rather than a check.
  {
    const out = await page.evaluate(async () => {
      const chimes = [];
      const realTone = window.tone;
      window.tone = (hz) => chimes.push(hz);

      // Start recording, THEN set a timer — the order a person actually uses.
      await startRecording();
      const id = recSession && recSession.id;
      const armedBefore = recArmed;
      document.getElementById('summary').classList.remove('show');

      // A timer already in the past, so the very next tick must fire it.
      timerEndAt = Date.now() - 5;
      timerDone = false;

      // Wait for the page's own 250ms tick rather than calling checkTimerDone().
      const deadline = Date.now() + 4000;
      while (recArmed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      /* POLL FOR THE CHIMES, do not sleep for them. This was `setTimeout(400)` and it
         was flaky: recArmed goes false at the TOP of stopRecording, but the three notes
         are scheduled after `await sess.end()` and the last lands 380ms after that — so
         the fixed window began before the chimes even existed and only sometimes
         covered the third. The harness note at the top of this file describes exactly
         this trap; the test had it anyway. */
      const chimeDeadline = Date.now() + 4000;
      while (chimes.length < 3 && Date.now() < chimeDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const stored = id ? await Recorder.loadSession(recDb, id) : null;
      const after = {
        armed: recArmed, session: !!recSession,
        button: document.getElementById('recBtn').textContent,
        summaryOpen: document.getElementById('summary').classList.contains('show'),
        timerDone,
        ended: stored && stored.meta.ended,
        chimes: chimes.slice(),
      };
      window.tone = realTone;
      if (id) await Recorder.deleteSession(recDb, id);
      timerEndAt = null; timerDone = false;
      document.getElementById('summary').classList.remove('show');
      selfRating = null; lastRecSession = null;
      return { armedBefore, after };
    });

    assert.ok(out.armedBefore, 'the test must actually be recording before the timer fires');
    assert.strictEqual(out.after.timerDone, true, 'the timer must have fired');
    assert.strictEqual(out.after.armed, false,
      'the timer running out MUST stop the recording — it should not need stopping by hand');
    assert.strictEqual(out.after.session, false, 'and release the session');
    assert.strictEqual(out.after.button, 'Record', 'and the button must offer a new one');
    assert.strictEqual(out.after.ended, true,
      'the stored session must be marked ended, not left looking interrupted');
    assert.ok(out.after.summaryOpen, 'and the summary must open, since the sit is over');
    // Audible, because your eyes are probably shut when the timer runs out.
    assert.ok(out.after.chimes.length >= 3,
      `stopping must chime (got ${out.after.chimes.join(',')})`);
    console.log('✓ the timer running out stops the recording, chimes, and opens the summary');
  }

  assert.deepStrictEqual(errors, [], `no errors may appear during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll UI tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
