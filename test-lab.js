/*
 * Browser tests for lab.html.
 *
 * Driven with real archives built by export.js and handed to the page as real File
 * objects through the real input — not by calling internals. The lab's job is to be
 * trustworthy about null results, so the central assertion is that a session with
 * NOTHING in it says so plainly rather than presenting a table to be misread.
 */
const path = require('path');
const assert = require('assert');
const Module = require('module');

const GLOBAL_MODULES = '/opt/node22/lib/node_modules';
if (!Module.globalPaths.includes(GLOBAL_MODULES)) Module.globalPaths.push(GLOBAL_MODULES);
Module._initPaths();
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

const Exporter = require('./public/export.js');
const PAGE = 'file://' + path.join(__dirname, 'public', 'lab.html');

// Build a session archive with a planted relationship between `calm` and the focus
// label, so the lab has something real to find — and noise features that it must not
// confirm.
/*
 * An archive with MARKS AND NO SPAN LABELS — the state the lab was actually loaded
 * with, and the one it could not analyse.
 *
 * `markSignature` plants a signature in the ten seconds before each tap that is
 * invisible to a comparison of MEANS: calm rises across the window while focus falls,
 * so only the trend and pair features can see it. That is the point of the test — the
 * old search compared means and would report nothing here.
 */
function makeMarkArchive({ id, seedOffset = 0, markSignature = true, marks = 8, minutes = 14 }) {
  const t0 = new Date('2026-07-28T06:00:00').getTime() + seedOffset * 86400000;
  const durationSec = minutes * 60;
  let seed = 5150 + seedOffset * 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const markTimes = [];
  for (let i = 0; i < marks; i++) markTimes.push(60 + Math.round(i * (durationSec - 120) / marks));

  const rows = [];
  for (let t = 0; t < durationSec; t++) {
    let calm = 0.5 + (rnd() - 0.5) * 0.05;
    let focus = 0.5 + (rnd() - 0.5) * 0.05;
    const near = markTimes.find((m) => t >= m - 10 && t < m - 2);
    if (markSignature && near != null) {
      const u = (t - (near - 10)) / 8;          // 0..1 across the window
      calm += (u - 0.5) * 0.30;                 // rising
      focus -= (u - 0.5) * 0.30;                // and moving opposite
    }
    rows.push({ t, epochMs: t0 + t * 1000,
      calm: Math.max(0, Math.min(1, calm)), focus: Math.max(0, Math.min(1, focus)),
      thinking: Math.max(0, Math.min(1, 0.4 + (rnd() - 0.5) * 0.05)), noise: rnd() * 0.1 });
  }

  // Taps only. No `dims` anywhere, so Labels.spans() yields nothing labelled.
  const notes = markTimes.map((at, i) => ({
    id: i + 1, kind: 'transition', at: t0 + at * 1000, offsetSec: at,
    transition: 'returned', text: 'Returned to the object',
  }));

  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec, bytes: 1e6, ended: true, eegHz: 256, accHz: 50 },
    eeg: [[1, 2, 3], [4, 5, 6], [], []], acc: [], rr: [], rows, notes,
  }, {});
  return { name: `marks-${id}.zip`, bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
}

function makeArchive({ id, seedOffset = 0, planted = true, spans = 4, minutes = 20 }) {
  const t0 = new Date('2026-07-28T06:00:00').getTime() + seedOffset * 86400000;
  const durationSec = minutes * 60;
  const spanLen = durationSec / spans;
  let seed = 1234 + seedOffset * 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const labels = [];
  for (let i = 0; i < spans; i++) labels.push(1 + Math.floor(rnd() * 5));

  const rows = [];
  for (let t = 0; t < durationSec; t++) {
    const which = Math.min(spans - 1, Math.floor(t / spanLen));
    const focus = labels[which];
    rows.push({
      t,
      epochMs: t0 + t * 1000,
      // Planted: calm tracks the focus label. Unplanted: calm is noise.
      calm: planted ? Math.max(0, Math.min(1, focus / 6 + (rnd() - 0.5) * 0.18))
        : Math.max(0, Math.min(1, rnd())),
      thinking: Math.max(0, Math.min(1, rnd())),
      drowsy: Math.max(0, Math.min(1, rnd())),
      noise: rnd() * 0.2,
    });
  }

  const notes = [];
  for (let i = 0; i < spans; i++) {
    // A label is given at the END of the stretch it describes.
    const at = Math.round((i + 1) * spanLen);
    notes.push({
      id: i + 1, kind: 'text', at: t0 + at * 1000, offsetSec: at,
      dims: { focus: labels[i], effort: 6 - labels[i] }, text: `span ${i + 1}`,
    });
  }
  notes.push({ id: 99, kind: 'transition', at: t0 + 60000, offsetSec: 60, transition: 'returned' });

  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec, bytes: 1e6, ended: true, eegHz: 256, accHz: 50 },
    eeg: [[1, 2, 3], [4, 5, 6], [], []], acc: [], rr: [], rows, notes,
  }, {});
  return { name: `session-${id}.zip`, bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
}

/*
 * An archive containing a recorded eyes-closed/open control run.
 *
 * `working` decides whether calm actually rises with the eyes closed. Both outcomes
 * are tested, because the FAILURE message is the important one: a control that cannot
 * fail is not a control.
 */
function makeTrialArchive({ id, seedOffset = 0, working = true }) {
  const Trials = require('./public/trials.js');
  const run = Trials.buildBlocks('alpha-control');
  const t0 = new Date('2026-07-28T06:00:00').getTime() + seedOffset * 86400000;
  let seed = 777 + seedOffset;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

  const rows = [];
  for (let t = 0; t < run.totalSec; t++) {
    const at = Trials.blockAt(run, t);
    const closed = at && at.block.condition === 'closed';
    // Working: calm high when closed. Broken: no relationship at all.
    const base = working ? (closed ? 0.72 : 0.3) : 0.5;
    rows.push({
      t, epochMs: t0 + t * 1000,
      calm: Math.max(0, Math.min(1, base + rnd() * 0.08)),
      focus: Math.max(0, Math.min(1, 0.5 + rnd() * 0.1)),
      drowsy: Math.max(0, Math.min(1, 0.4 + rnd() * 0.1)),
    });
  }
  const notes = run.blocks.map((b, i) => ({
    id: i + 1, kind: 'block', at: t0 + b.fromSec * 1000, offsetSec: b.fromSec,
    trialKey: 'alpha-control', condition: b.condition, blockIndex: b.index, text: b.label,
  }));
  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec: run.totalSec, bytes: 1e6, ended: true, eegHz: 256, accHz: 50 },
    eeg: [[1], [2], [], []], acc: [], rr: [], rows, notes,
  }, {});
  return { name: `trial-${id}.zip`, bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
}

/*
 * An archive with REAL EEG in it: pink-ish noise plus a planted alpha bump on the two ear
 * channels, none on the forehead pair, and one channel dead. That is the shape of a real
 * sit on this headband — alpha is posterior, so TP9/TP10 carry it and AF7/AF8 barely hint.
 *
 * 120 seconds because the peak detector refuses on fewer than 20 clean 4-second windows,
 * which is about 45s at 50% overlap. `alpha: false` plants no bump at all, which must
 * produce a labelled fall back to the fixed band rather than a frequency.
 */
/*
 * An archive with ACCELEROMETER data whose movement character is controlled: `restless` decides
 * whether the sit contains large front-loaded movements or almost none. This is the fixture for
 * the whole-session comparison, which is the thing that answers "these two sits felt different —
 * did anything measurable differ?".
 */
function makeMoveArchive({ id, restless = false, secs = 180 }) {
  const t0 = new Date('2026-08-02T07:00:00').getTime();
  const hz = 50;
  const n = hz * secs;
  let seed = restless ? 31 : 17;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  // Movements as a change profile, accumulated — see test-movement.js for why specifying
  // displacement instead gets the units and the shape wrong.
  const bump = new Float64Array(n);
  const moves = restless
    ? Array.from({ length: 12 }, (_, i) => ({ at: 8 + i * 14, dur: 1.2, peakMg: 90, abrupt: true }))
    : [{ at: 60, dur: 2.0, peakMg: 70, abrupt: false }];
  for (const m of moves) {
    const len = Math.round(m.dur * hz);
    const i0 = Math.round(m.at * hz);
    let running = 0;
    for (let k = 0; k <= len && i0 + k < n; k++) {
      const u = k / len;
      const shape = m.abrupt ? (u / 0.12) * Math.exp(1 - u / 0.12) : Math.sin(Math.PI * u);
      running += (m.peakMg / 1.166) * shape;
      bump[i0 + k] += running;
    }
    for (let i = i0 + len + 1; i < n; i++) bump[i] += running;
  }
  const acc = [];
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    acc.push([Math.round(-960 + bump[i] + rnd() * 1.5),
      Math.round(3 + 3 * Math.sin((2 * Math.PI * t) / 4) + rnd() * 1.5),
      Math.round(-380 + bump[i] * 0.6 + rnd() * 1.5)]);
  }
  const rows = [];
  for (let t = 0; t < secs; t++) {
    rows.push({ t, epochMs: t0 + t * 1000,
      calm: restless ? 0.35 : 0.62, noise: 0.05, equanimity: restless ? 0.5 : 0.9 });
  }
  const notes = [{ id: 1, kind: 'transition', at: t0 + 30000, offsetSec: 30, transition: 'lost' }];
  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec: secs, bytes: 1e6, ended: true, eegHz: 256, accHz: hz },
    eeg: [[1, 2, 3], [4, 5, 6], [], []], acc, rr: [], rows, notes,
  }, {});
  return { name: `move-${id}.zip`, bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
}

function makeEegArchive({ id, centre = 10.6, alpha = true, secs = 120 }) {
  const t0 = new Date('2026-07-28T06:00:00').getTime();
  const hz = 256;
  const n = hz * secs;
  const chan = (seed0, amp) => {
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const out = new Array(n);
    const spread = [-0.7, -0.35, 0, 0.35, 0.7];
    const ph = spread.map((_, i) => i * 1.7);
    let p = 0;
    for (let i = 0; i < n; i++) {
      p = 0.98 * p + rnd() * 8;
      let a = 0;
      if (amp) spread.forEach((d, k) => { a += Math.sin((2 * Math.PI * (centre + d) * i) / hz + ph[k]); });
      out[i] = p + amp * a + rnd() * 2;
    }
    return out;
  };
  const eeg = [
    chan(101, alpha ? 2.4 : 0),     // TP9  — strong, or nothing
    chan(102, 0),                   // AF7  — frontal, no alpha
    chan(103, 0),                   // AF8  — frontal, no alpha
    new Array(n).fill(0),           // TP10 — dead, so the null path is exercised too
  ];
  const rows = [];
  for (let t = 0; t < secs; t++) rows.push({ t, epochMs: t0 + t * 1000, calm: 0.5, noise: 0.05 });
  const notes = [{ id: 1, kind: 'transition', at: t0 + 30000, offsetSec: 30, transition: 'returned' }];
  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec: secs, bytes: 1e6, ended: true, eegHz: hz, accHz: 50 },
    eeg, acc: [], rr: [], rows, notes,
  }, {});
  return { name: `eeg-${id}.zip`, bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
}

/* `expectRows` because not every dropped file becomes a row: a duplicate recording is refused on
   purpose, so waiting for one row per file would hang on exactly the test that checks that. */
async function drop(page, archives, expectRows = archives.length) {
  await page.setInputFiles('#file', archives.map((a) => ({
    name: a.name, mimeType: 'application/zip', buffer: a.bytes,
  })));
  // The page reads and parses asynchronously; wait for the table rather than sleeping.
  await page.waitForFunction((n) => document.querySelectorAll('#loaded tbody tr, #loaded table tr').length >= n + 1,
    expectRows, { timeout: 15000 });
  await page.waitForTimeout(400);
}

/*
 * Switch tabs, and wait for the pane to actually render.
 *
 * The lab is tabbed now (Explore / Sessions / Compare / Signals / Learn) and renders only the visible
 * pane, because each renderer walks every loaded session. These tests were written when everything was
 * on one scroll, so each one now has to go to the tab that owns the thing it is asserting about — which
 * is also a better test, since it exercises the path a reader actually takes.
 */
async function showTab(page, tab) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForFunction((t) => {
    const el = document.querySelector('.pane:not([hidden])');
    return el && el.dataset.pane === t;
  }, tab, { timeout: 8000 });
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch();
  /* An EXPLICIT context, because one test needs a second page in the same storage.
     browser.newPage() creates an implicit context that refuses to hold another page, and
     browser.newPage() twice creates two contexts with two separate IndexedDBs — which
     would make the app-to-lab handoff look broken when it is not. */
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE);
  await page.waitForTimeout(300);
  assert.deepStrictEqual(errors, [], `the lab must load without errors:\n  ${errors.join('\n  ')}`);
  console.log('✓ lab.html loads without throwing');

  // 1) Ingest: real archives through the real file input, and the summary must report
  //    what was actually found rather than what was hoped for.
  {
    await drop(page, [makeArchive({ id: 'a', seedOffset: 0 })]);
    const st = await page.evaluate(() => ({
      count: sessions.length,
      spans: sessions[0].spans.filter((s) => s.dims).length,
      transitions: sessions[0].notes.filter((n) => n.kind === 'transition').length,
      rows: sessions[0].read.metrics.length,
      table: document.getElementById('loaded').textContent,
      warnings: sessions[0].read.warnings,
    }));
    assert.strictEqual(st.count, 1);
    assert.strictEqual(st.rows, 1200, '20 minutes at 1Hz');
    assert.strictEqual(st.spans, 4, 'four labelled spans must be recovered from notes.csv');
    assert.strictEqual(st.transitions, 1, 'and the one-key transition');
    assert.match(st.table, /session-a\.zip/);
    assert.deepStrictEqual(st.warnings, [], 'a complete archive must not warn');
    console.log('✓ archives ingest through the real input, with spans and transitions recovered');
  }

  // 2) The timeline must draw, and must NOT bridge gaps in the data. Joining across a
  //    dropout invents values and hides the artifacts a reader most needs to see.
  {
    /* THE TAB MUST BE OPEN FOR A CANVAS TEST. A canvas inside a display:none pane measures zero
       width, so it draws into a degenerate box — 190 lit pixels instead of thousands. That is the
       real behaviour and the right one: the page re-renders on tab switch precisely so a chart is
       correct once it can measure itself. Which means a canvas assertion has to take the path a
       reader takes. Text assertions do not; they read fine from a hidden subtree. */
    await showTab(page, 'sessions');
    /* THE TIMELINE LIVES BEHIND THE ROW'S ARROW NOW.
       The page-wide Timelines section was removed on request — "the timelines aren't really useful for
       me" — and the mark tally it was being read for moved into the table. The drawing is unchanged,
       so this test still checks the same thing; it just takes the path a reader now takes. */
    await page.click('[data-expand="0"]');
    await page.waitForTimeout(700);
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('tr.sesDetail canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
      return { lit, w: c.width, legend: document.querySelector('tr.sesDetail .legend').textContent };
    });
    assert.ok(drawn, 'a timeline canvas must exist');
    assert.ok(drawn.lit > 500, `the timeline must actually draw something (lit ${drawn.lit})`);
    assert.match(drawn.legend, /calm/, 'and name its series');
    assert.match(drawn.legend, /transition/, 'and explain the markers');

    /* The gap rule, as a DIFFERENTIAL measurement.
     *
     * A raw pixel count in the gap column proves nothing: the label bands fill the
     * full height of every column and the other three series draw there too. So
     * measure the same column twice — once with calm present, once with it nulled —
     * and compare. Everything else contributes identically to both, so the
     * difference isolates the calm line. If a gap were bridged, nulling the data
     * would change nothing.
     */
    const gap = await page.evaluate(() => {
      const sample = () => {
        // renderSitDetail, not renderTimelines: the drawing moved into the expanded row, so this is
        // the call that actually redraws the canvas under test.
        renderSitDetail(0);
        const c = document.querySelector('tr.sesDetail canvas');
        const ctx = c.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const x = Math.round((500 / 1200) * c.clientWidth * dpr);
        const col = ctx.getImageData(x, 0, 1, c.height).data;
        let lit = 0;
        for (let i = 3; i < col.length; i += 4) if (col[i] > 40) lit++;
        return lit;
      };
      const original = sessions[0].read.metrics.map((r) => r.calm);
      const withCalm = sample();
      sessions[0].read.metrics.forEach((r, i) => { if (i > 400 && i < 600) r.calm = null; });
      const withGap = sample();
      sessions[0].read.metrics.forEach((r, i) => { r.calm = original[i]; });
      renderSitDetail(0);
      return { withCalm, withGap };
    });
    assert.ok(gap.withGap < gap.withCalm,
      `nulling calm inside a range must remove its line from that column`
      + ` (${gap.withCalm} -> ${gap.withGap} lit pixels); if it does not, the gap is`
      + ' being bridged by a straight line, which invents values');
    console.log('✓ timelines draw, name their series, and leave gaps as gaps');
  }

  // 3) *** THE ONE THAT MATTERS *** One session cannot validate anything, and the lab
  //     must say so instead of presenting its strongest correlation as a result.
  {
    const v = await page.evaluate(() => {
      // Restore the data damaged by the gap test.
      sessions.length = 0;
      return null;
    });
    await drop(page, [makeArchive({ id: 'solo', seedOffset: 3 })]);
    const single = await page.evaluate(() => ({
      verdict: document.querySelector('#out .headline').textContent,
      confirmed: Analysis.search(Analysis.unitsFromSpans(sessions.map((s) => ({
        sessionId: s.sessionId, metrics: s.read.metrics, spans: s.spans,
      })))).confirmed.length,
    }));
    assert.match(single.verdict, /Not enough data yet|nothing could be held back/,
      `one session must be reported as unvalidatable, in plain words (got "${single.verdict}")`);
    console.log('✓ a single session is reported as unvalidatable, not as a result');
  }

  // 4) NOISE ACROSS MANY SESSIONS must still confirm nothing, and say so in words.
  {
    await page.evaluate(() => { sessions.length = 0; });
    const noisy = [];
    for (let i = 0; i < 8; i++) noisy.push(makeArchive({ id: `n${i}`, seedOffset: 10 + i, planted: false }));
    await drop(page, noisy);
    const st = await page.evaluate(() => ({
      verdict: document.querySelector('#out .headline').textContent,
      body: document.getElementById('out').textContent,
      loaded: sessions.length,
    }));
    assert.strictEqual(st.loaded, 8);
    assert.match(st.verdict, /No pattern found|Not enough data yet/,
      `unrelated data must produce a null verdict (got "${st.verdict}")`);
    assert.match(st.verdict, /expected outcome|cannot mean anything/,
      'and frame it as the expected result rather than as a failure');
    // The size of the search must be on screen next to the result. A correlation
    // without the number of comparisons behind it is not evidence.
    assert.match(st.body, /comparisons/,
      'the number of comparisons must be shown alongside the table');
    assert.match(st.body, /held out/i, 'and the held-out column explained');
    console.log('✓ eight unrelated sessions produce a null verdict, with the search size shown');
  }

  // 5) A PLANTED relationship across many sessions must be found and marked as
  //    holding on the held-out sits. Otherwise the lab is only a no-detector.
  {
    await page.evaluate(() => { sessions.length = 0; });
    const planted = [];
    for (let i = 0; i < 10; i++) planted.push(makeArchive({ id: `p${i}`, seedOffset: 30 + i, planted: true }));
    await drop(page, planted);
    const st = await page.evaluate(() => {
      const res = Analysis.search(Analysis.unitsFromSpans(sessions.map((s) => ({
        sessionId: s.sessionId, metrics: s.read.metrics, spans: s.spans,
      }))), { iterations: 800 });
      return {
        // The SPANS headline specifically. The marks search renders first now, and
        // reading "the first headline" silently compared the wrong section.
        verdict: document.querySelector('#out [data-source="spans"] .headline').textContent,
        confirmed: res.confirmed.map((c) => c.key),
        calmFocus: res.tests.find((t) => t.key === 'calm~focus') || null,
        units: res.units,
      };
    });
    assert.ok(st.units >= 30, `ten sessions x four spans should give ~40 observations (got ${st.units})`);
    assert.ok(st.calmFocus, 'calm~focus must be among the comparisons');
    assert.ok(st.calmFocus.heldUp === true,
      `the planted relationship must hold on held-out sessions (train ${st.calmFocus.trainRho}, test ${st.calmFocus.testRho})`);
    assert.ok(st.confirmed.includes('calm~focus'),
      `and be confirmed (confirmed: ${st.confirmed.join(', ') || 'none'})`);
    // The verdict must also carry the warning, so a survivor is not read as a result.
    assert.match(st.verdict, /candidates, not/,
      'a positive verdict must refuse the word "conclusion"');
    console.log(`✓ a planted relationship is found across sessions and held out`
      + ` (train ${st.calmFocus.trainRho.toFixed(2)}, held-out ${st.calmFocus.testRho.toFixed(2)})`);
  }

  // 6) A corrupt archive must be named, not silently skipped — otherwise the analysis
  //    covers fewer sessions than the screen suggests.
  {
    await page.evaluate(() => { sessions.length = 0; render(); });
    await page.setInputFiles('#file', [{
      name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from([1, 2, 3, 4, 5]),
    }]);
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => ({
      text: document.getElementById('loaded').textContent,
      errored: sessions.filter((s) => s.error).length,
    }));
    assert.strictEqual(st.errored, 1, 'a broken archive must be kept and marked, not dropped');
    assert.match(st.text, /broken\.zip/, 'and named on screen');
    console.log('✓ a corrupt archive is named on screen rather than silently skipped');
  }

  // 7) TRIAL BLOCKS must be rebuilt from the RECORD and reported per protocol, with
  //    the positive control called out as a check on the equipment.
  {
    await page.evaluate(() => { sessions.length = 0; render(); });
    await drop(page, [
      makeTrialArchive({ id: 'ok1', seedOffset: 60, working: true }),
      makeTrialArchive({ id: 'ok2', seedOffset: 61, working: true }),
    ]);
    const st = await page.evaluate(() => ({
      blocks: sessions[0].trialBlocks.length,
      conditions: sessions[0].trialBlocks.map((b) => b.condition),
      // The settle window must be excluded on the way back IN, not just on the way out.
      settleSkipped: sessions[0].trialBlocks.every((b) => b.analyseFromSec > b.fromSec),
      contiguous: sessions[0].trialBlocks.every((b, i, a) =>
        i === 0 || Math.abs(b.fromSec - a[i - 1].toSec) < 0.01),
      text: document.getElementById('trials') ? document.getElementById('trials').textContent : '',
    }));
    assert.strictEqual(st.blocks, 12, '6 repeats x 2 conditions must be recovered');
    for (let i = 1; i < st.conditions.length; i++) {
      assert.notStrictEqual(st.conditions[i], st.conditions[i - 1],
        'the recovered blocks must still alternate');
    }
    assert.ok(st.settleSkipped, 'the settling window must be excluded when reading back');
    assert.ok(st.contiguous,
      'each block must end where the next begins — derived from the record, not the'
      + ' protocol definition, so a cut-short run reports what actually happened');
    assert.match(st.text, /positive control/i, 'the control must be labelled as one');
    assert.match(st.text, /CONTROL PASSED/,
      `a working apparatus must be reported as passing (got: ${st.text.slice(0, 200)})`);
    assert.match(st.text, /Berger/, 'and say why that is the expected result');
    console.log('✓ trial blocks are rebuilt from the record, and a good control reports PASSED');
  }

  // 8) *** A BROKEN APPARATUS MUST FAIL LOUDLY. *** A control that cannot fail is not
  //     a control, and this is the message that saves weeks of chasing a phantom.
  {
    await page.evaluate(() => { sessions.length = 0; render(); });
    await drop(page, [
      makeTrialArchive({ id: 'bad1', seedOffset: 70, working: false }),
      makeTrialArchive({ id: 'bad2', seedOffset: 71, working: false }),
    ]);
    const st = await page.evaluate(() => ({
      text: document.getElementById('trials').textContent,
      bad: !!document.querySelector('#trials .verdict.bad'),
    }));
    assert.match(st.text, /CONTROL FAILED/,
      `no eyes-closed alpha effect must be reported as a FAILURE (got: ${st.text.slice(0, 200)})`);
    assert.match(st.text, /NOTHING else on this page means anything/,
      'and must say plainly that the rest of the analysis is void until it passes');
    assert.match(st.text, /electrode contact/, 'and name the first thing to check');
    assert.ok(st.bad, 'and be styled as a failure, not as a neutral result');
    console.log('✓ a broken apparatus reports CONTROL FAILED and voids the rest');
  }

  // 9) THE HANDOFF FILE — the thing actually pasted into a conversation. It has to
  //    carry its own guardrails, or handing a table to an AI just relocates the
  //    credulity problem to a different reader.
  {
    await page.evaluate(() => { sessions.length = 0; render(); });
    const planted = [];
    for (let i = 0; i < 10; i++) planted.push(makeArchive({ id: `h${i}`, seedOffset: 90 + i, planted: true }));
    await drop(page, planted);

    const md = await page.evaluate(() => {
      // Intercept the clipboard so the real button path is exercised rather than
      // buildHandoff() being called directly.
      let copied = null;
      navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
      document.getElementById('copyHandoff').click();
      return new Promise((r) => setTimeout(() => r(copied), 120));
    });

    assert.ok(md, 'the copy button must produce a document');
    // The limits must come before any finding, or the reader meets numbers first.
    const limits = md.indexOf('cannot support');
    const firstFinding = md.indexOf('### Candidates');
    assert.ok(limits > 0, 'the handoff must state what the data cannot support');
    assert.ok(firstFinding === -1 || limits < firstFinding,
      'and state it BEFORE the findings');
    for (const must of ['Causal claims', 'Clinical', 'by session, never by sample',
      'too weak to be worth interpreting']) {
      assert.ok(md.includes(must), `the handoff must include "${must}"`);
    }
    // The session table gives exposure at a glance.
    assert.match(md, /\| trial-|\| session-h0\.zip \|/, 'sessions must be listed with their sizes');
    // Findings must appear in ENGLISH, not as coefficients.
    assert.match(md, /was (higher|lower) when you were closer to/,
      'a finding must be a sentence, not a row of numbers');
    // And small enough to paste anywhere — findings only, never the signal.
    assert.ok(md.length < 20000, `the handoff must stay small (got ${md.length} bytes)`);
    assert.ok(!md.includes('eeg-ch'), 'no raw data references');
    console.log(`✓ the handoff copies as ${(md.length / 1024).toFixed(1)}kB of prose,`
      + ' limits first, no raw signal');
  }

  /* 10) MARKS ALONE ARE ENOUGH, and the signature can be a shape rather than a level.
   *
   * The reported state: "I pulled up three studies, but although I have markers, I
   * didn't label spans... so I have markers, but no spans." The lab only knew how to
   * analyse hand-labelled spans, so a fully-marked sit produced "no labelled spans,
   * nothing to correlate" — a tooling dead end presented as a null result.
   *
   * The planted signature is deliberately invisible to a comparison of MEANS: calm
   * rises across the ten seconds before each tap while focus falls. Only the trend and
   * pair features can see it, so this also tests that the broader signature vocabulary
   * does something the old mean-only search could not.
   */
  {
    await page.evaluate(() => { sessions.length = 0; });
    const files = [];
    for (let i = 0; i < 6; i++) files.push(makeMarkArchive({ id: i, seedOffset: 80 + i }));
    await drop(page, files);

    const st = await page.evaluate(() => {
      const forAnalysis = sessions.map((s) => ({
        sessionId: s.sessionId, metrics: s.read.metrics, spans: s.spans, notes: s.notes,
      }));
      const spanUnits = Analysis.unitsFromSpans(forAnalysis);
      const markUnits = Analysis.unitsFromMarks(forAnalysis,
        { leadSec: 10, tailSec: 2 });
      const res = Analysis.search(markUnits, { iterations: 800 });
      const marksSection = document.querySelector('#out [data-source="marks"]');
      return {
        spanUnits: spanUnits.length,
        markUnits: markUnits.length,
        controls: markUnits.filter((u) => u.isControl).length,
        featureKinds: Array.from(new Set(Object.keys(markUnits[0].features)
          .map((k) => k.split('.').pop()))).sort(),
        confirmed: res.confirmed.map((c) => c.key),
        sectionShown: !!marksSection,
        sectionText: marksSection ? marksSection.textContent : '',
        spansNote: !!document.querySelector('#out [data-source="spans"]'),
      };
    });

    assert.strictEqual(st.spanUnits, 0,
      'precondition: these archives must have NO labelled spans, or the test proves nothing');
    assert.ok(st.markUnits >= 60,
      `six sits x eight marks plus controls should give plenty of units (got ${st.markUnits})`);
    assert.ok(st.controls > 0,
      'random control windows are required — with one tap category there is otherwise'
      + ' nothing to contrast against, and a one-class label has no variance at all');
    assert.deepStrictEqual(st.featureKinds, ['level', 'pair', 'range', 'swing', 'trend', 'trio'],
      `every signature kind must be built (got ${st.featureKinds.join(', ')})`);
    assert.ok(st.sectionShown, 'the marks search must render even with no spans present');
    assert.ok(!st.spansNote, 'and no spans section, since there are none');
    // The window and the dropped tail have to be STATED, not assumed: the reader is
    // being told what "before the mark" means, and it is an analysis choice.
    assert.match(st.sectionText, /8 seconds ending 2s before/,
      'the section must say exactly what window it used');
    assert.match(st.sectionText, /random windows/,
      'and that it is comparing against random windows from the same sits');
    // The planted shape must actually be found, by the features that can see it.
    assert.ok(st.confirmed.some((k) => /\.trend~/.test(k)),
      `the rising trend must be found (confirmed: ${st.confirmed.join(', ') || 'none'})`);
    assert.ok(st.confirmed.some((k) => /\.pair~/.test(k)),
      `and the two lines moving opposite (confirmed: ${st.confirmed.join(', ') || 'none'})`);
    console.log(`✓ marks alone are analysable: ${st.markUnits} windows, no spans needed,`
      + ` and a trend/pair signature invisible to means is found`);
  }

  /* 11) THE LAB REMEMBERS. Asked for directly: "is there a way to save the lab analyses
   *     so I can open them up later?"
   *
   *     Two things have to survive a reload, and the second matters more than convenience:
   *     the loaded sits, and DATED SNAPSHOTS of what the search said. A finding here is
   *     only ever a candidate, and the only thing that turns one into a result is showing
   *     up again in sits recorded afterwards — a comparison that is impossible if the
   *     earlier answer was never written down.
   */
  {
    await page.evaluate(async () => {
      sessions.length = 0;
      if (store) await LabStore.clearSessions(store);
      for (const a of (store ? await LabStore.listAnalyses(store) : [])) {
        await LabStore.deleteAnalysis(store, a.id);
      }
    });
    const files = [];
    for (let i = 0; i < 4; i++) files.push(makeMarkArchive({ id: i, seedOffset: 200 + i }));
    await drop(page, files);

    const before = await page.evaluate(async () => {
      document.getElementById('saveAnalysis').click();
      await new Promise((r) => setTimeout(r, 400));
      const saved = await LabStore.listAnalyses(store);
      return {
        loaded: sessions.length,
        savedCount: saved.length,
        title: saved[0] && saved[0].title,
        markdownLen: saved[0] ? (saved[0].markdown || '').length : 0,
        sessionsInRecord: saved[0] ? saved[0].sessionCount : 0,
        // Raw EEG must NOT be stored: a 40-minute sit is ~1000x larger raw than the
        // rows any view reads, and keeping it would fill the quota after a few sits.
        storedHasEeg: (await LabStore.loadSessions(store))
          .some((s) => s.read.eeg.some((ch) => ch.length)),
      };
    });
    assert.strictEqual(before.loaded, 4, 'precondition: four sits loaded');
    assert.strictEqual(before.savedCount, 1, 'Save must write exactly one snapshot');
    assert.ok(before.markdownLen > 500,
      `the snapshot must contain the report prose (got ${before.markdownLen} bytes)`);
    assert.strictEqual(before.sessionsInRecord, 4,
      'and record WHICH sits it rested on, or a later stronger result cannot be told'
      + ' apart from simply having more data');
    assert.ok(!before.storedHasEeg,
      'raw EEG must not be persisted — it is ~1000x the size of the rows the analysis'
      + ' reads, and filling the quota would break storing the small things too');

    // RELOAD. Everything above has to still be there.
    await page.reload();
    await page.waitForFunction(() => typeof store !== 'undefined' && sessions.length > 0,
      null, { timeout: 8000 });
    const after = await page.evaluate(async () => ({
      loaded: sessions.length,
      loadedNames: sessions.map((s) => s.file).sort(),
      metricsRows: sessions[0].read.metrics.length,
      marks: sessions[0].notes.filter((n) => n.transition).length,
      savedCount: (await LabStore.listAnalyses(store)).length,
      // The analysis must re-run from restored data, not just display a stale table.
      reran: !!document.querySelector('#out [data-source="marks"]'),
      savedListed: !!document.querySelector('[data-open-analysis]'),
    }));
    assert.strictEqual(after.loaded, 4, 'the loaded sits must survive a reload');
    assert.ok(after.metricsRows > 100,
      `and carry their metric rows, or nothing can be re-analysed (got ${after.metricsRows})`);
    assert.ok(after.marks > 0, 'and their marks');
    assert.ok(after.reran,
      'the search must re-run from the restored data, not show an empty page');
    assert.strictEqual(after.savedCount, 1, 'the saved snapshot must survive too');
    assert.ok(after.savedListed, 'and be listed and reopenable');

    // Opening a snapshot shows what it said THEN. Re-deriving would print today's answer
    // under yesterday's date, which is the one thing a record must never do.
    const opened = await page.evaluate(async () => {
      document.querySelector('[data-open-analysis]').click();
      await new Promise((r) => setTimeout(r, 250));
      const v = document.getElementById('analysisView');
      return { text: v ? v.textContent : '', hasThen: /said THEN/.test(v ? v.textContent : '') };
    });
    assert.ok(opened.hasThen, 'a reopened snapshot must say it is not a fresh run');
    assert.ok(opened.text.length > 400, 'and show the saved prose');

    // Removing a sit must forget it, or it returns on the next reload and the Remove
    // button looks broken.
    await page.evaluate(async () => {
      document.querySelector('[data-drop]').click();
      await new Promise((r) => setTimeout(r, 300));
    });
    await page.reload();
    await page.waitForFunction(() => typeof store !== 'undefined', null, { timeout: 8000 });
    await page.waitForTimeout(600);
    const removed = await page.evaluate(() => sessions.length);
    assert.strictEqual(removed, 3,
      `Remove must delete from storage as well as memory (got ${removed} after reload)`);

    await page.evaluate(async () => {
      await LabStore.clearSessions(store);
      for (const a of await LabStore.listAnalyses(store)) await LabStore.deleteAnalysis(store, a.id);
    });
    console.log('✓ the lab remembers: sits and dated snapshots survive a reload,'
      + ' raw EEG is not stored, and Remove really removes');
  }

  /* 12) THE APP CAN HAND A SIT STRAIGHT TO THE LAB. Asked for: "at the end of a
   *     recording session, open the data directly in the analysis lab."
   *
   *     Downloading a zip and dragging it back in is a step that gets skipped, and a sit
   *     that never reaches the lab never gets analysed. The two pages share one
   *     IndexedDB — same origin, including over file://, where both report an origin of
   *     "file://" — so the app writes the archive to an inbox and the lab drains it on
   *     open. Archive BYTES, so a handed-over sit and a dropped file go through the same
   *     parse: two ingest paths meant to agree eventually stop agreeing.
   */
  {
    await page.evaluate(async () => {
      sessions.length = 0;
      if (store) await LabStore.clearSessions(store);
    });
    const handed = makeMarkArchive({ id: 'handed', seedOffset: 300 });

    // Write it the way the app does, from a DIFFERENT page, so this exercises the
    // cross-page path rather than the lab talking to itself.
    /* page.context(), NOT browser.newPage(). The latter creates a fresh BrowserContext
       with its OWN storage, so the writer would be talking to a different IndexedDB and
       this test would report the feature broken when it is not. Same trap as the real
       thing depends on avoiding: the handoff works precisely because the two pages share
       an origin and a store. */
    const writer = await context.newPage();
    await writer.goto(PAGE.replace('lab.html', 'direct.html'));
    await writer.waitForTimeout(500);
    const wrote = await writer.evaluate(async ({ name, b64 }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const db = await LabStore.open();
      await LabStore.putIncoming(db, { name, bytes });
      const waiting = await LabStore.countIncoming(db);
      db.close();
      return { waiting, origin: location.origin };
    }, { name: handed.name, b64: handed.bytes.toString('base64') });
    assert.strictEqual(wrote.waiting, 1, 'the app must be able to write to the lab inbox');
    await writer.close();

    // Now open the lab: it must pick the sit up, parse it, and analyse it.
    await page.reload();
    await page.waitForFunction(() => typeof store !== 'undefined' && sessions.length > 0,
      null, { timeout: 8000 });
    const got = await page.evaluate(async () => ({
      loaded: sessions.map((s) => s.file),
      metricsRows: sessions[0] ? sessions[0].read.metrics.length : 0,
      marks: sessions[0] ? sessions[0].notes.filter((n) => n.transition).length : 0,
      inboxLeft: await LabStore.countIncoming(store),
      analysed: !!document.querySelector('#out [data-source="marks"]'),
    }));
    assert.deepStrictEqual(got.loaded, [handed.name],
      `the handed-over sit must appear in the lab (got ${got.loaded.join(', ') || 'nothing'})`);
    assert.ok(got.metricsRows > 100,
      `and be fully parsed, not just named (got ${got.metricsRows} rows)`);
    assert.ok(got.marks > 0, 'with its marks');
    assert.ok(got.analysed, 'and analysed on arrival');
    // CONSUMED ONCE. Read-and-delete in one transaction, so a sit cannot be delivered
    // twice — reopening the lab would otherwise re-add it on every visit.
    assert.strictEqual(got.inboxLeft, 0, 'the inbox must be emptied by delivery');

    await page.reload();
    await page.waitForFunction(() => typeof store !== 'undefined', null, { timeout: 8000 });
    await page.waitForTimeout(600);
    const again = await page.evaluate(() => sessions.length);
    assert.strictEqual(again, 1,
      `reopening must not duplicate the handed-over sit (got ${again} copies)`);

    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    console.log('✓ the app hands a sit straight to the lab: parsed, analysed on arrival,'
      + ' and delivered exactly once');
  }

  /* 13) THE CLIP LIBRARY renders, and the baseline choice is real.
   *
   * Asked for: every marked epoch from -15s to +15s, overlaid with the average and a
   * time-matched surrogate band — plus, specifically, the within-session-normalised trace
   * WITHOUT baseline subtraction as well as a baseline-corrected option, "since the mark
   * is when I notice I was thinking" and the seconds before it are where the effect lives.
   */
  {
    await page.evaluate(async () => {
      sessions.length = 0;
      if (store) await LabStore.clearSessions(store);
    });
    const files = [];
    for (let i = 0; i < 4; i++) files.push(makeMarkArchive({ id: `clip${i}`, seedOffset: 400 + i }));
    await drop(page, files);

    const out = await page.evaluate(() => {
      const host = document.getElementById('clips');
      const canvas = document.getElementById('clipCanvas');
      const opts = (id) => Array.from(document.querySelectorAll(`#${id} option`))
        .map((o) => o.value);
      // Something must actually be painted: an empty canvas would pass any structural check.
      const ctx = canvas.getContext('2d');
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
      return {
        shown: !!host.textContent.trim(),
        text: host.textContent,
        cats: opts('clipCat'),
        feats: opts('clipFeat'),
        baselines: opts('clipBase'),
        litPixels: lit,
        width: canvas.width,
      };
    });

    assert.ok(out.shown, 'the clip library must render when marks are loaded');
    assert.ok(out.cats.includes('returned'),
      `the mark categories must be offered (got ${out.cats.join(', ')})`);
    assert.deepStrictEqual(out.baselines, ['none', 'far', 'detrend'],
      'all three baseline modes must be selectable, with none first');
    assert.ok(out.litPixels > 2000,
      `the canvas must actually be drawn on (only ${out.litPixels} lit pixels)`);
    // The window and the reading instruction both have to be stated: a smooth average is
    // not a finding, and someone reading this needs to be told that in the view itself.
    assert.match(out.text, /−15s to \+15s/, 'the window must be stated');
    assert.match(out.text, /leaving the band is the finding/,
      'and the view must say that a smooth average is not one');
    assert.match(out.text, /standard deviations of that signal within its own sit/,
      'and name its vertical units, since they are per-session z scores');

    // Changing the baseline must actually change the picture, not just the label.
    const changed = await page.evaluate(async () => {
      const before = document.getElementById('clipCanvas')
        .getContext('2d').getImageData(0, 0, 880, 300).data.join(',').length;
      const sel = document.getElementById('clipBase');
      sel.value = 'far';
      sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 200));
      const after = document.getElementById('clipCanvas')
        .getContext('2d').getImageData(0, 0, 880, 300).data.join(',').length;
      return { before, after, note: document.getElementById('clips').textContent };
    });
    assert.notStrictEqual(changed.before, changed.after,
      'switching the baseline must redraw, not merely relabel');
    assert.match(changed.note, /never the seconds\s+next to the mark/,
      'and far-baselining must explain that it avoids the adjacent seconds');

    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    console.log('✓ the clip library draws every epoch with its average and surrogate band,'
      + ' and all three baseline modes redraw it');
  }

  /* ---- INDIVIDUAL ALPHA PEAK, from a real archive with real samples in it -----------
   *
   * "do individual alpha peak and four-second lab windows. Keep one-second windows for the
   * live display." The claim being made on screen is "this is where YOUR alpha sits", so
   * the test cares as much about the refusal as the detection: a session with no alpha must
   * say it is using the fixed population band, in words, rather than quietly naming a
   * frequency picked out of noise.
   */
  {
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    await page.reload();
    await page.waitForTimeout(300);
    await drop(page, [makeEegArchive({ id: 'a', centre: 10.6 })]);

    const found = await page.evaluate(() => {
      const s = sessions.find((x) => !x.error);
      return {
        text: document.getElementById('alpha').textContent.replace(/\s+/g, ' '),
        freqHz: s.alpha.freqHz, bestName: s.alpha.bestName, fallback: s.alpha.fallback,
        band: s.alpha.band,
        perChannel: s.alpha.channels.map((c) => ({ name: c.name, found: c.found, reason: c.reason })),
        spectraRows: s.spectra.rows.length,
        windowSec: s.spectra.windowSec,
        binHz: s.spectra.binHz,
        // The columns the recomputed series offers, which is what makes it useful.
        keys: Analysis.seriesKeys(s.spectra.rows),
      };
    });
    assert.strictEqual(found.fallback, false, 'a planted alpha bump must be found, not fallen back from');
    assert.ok(Math.abs(found.freqHz - 10.6) < 0.4,
      `the peak must be located near the planted 10.6Hz (got ${found.freqHz})`);
    assert.strictEqual(found.bestName, 'TP9', 'and attributed to the channel that carries it');
    assert.ok(Math.abs(found.band[0] - (found.freqHz - 2)) < 1e-6,
      'the individual band is the peak ±2Hz');
    // The forehead pair had no alpha planted and must be reported as not found, with a
    // reason — a channel silently missing from the table is indistinguishable from one that
    // was never read.
    for (const name of ['AF7', 'AF8', 'TP10']) {
      const c = found.perChannel.find((x) => x.name === name);
      assert.strictEqual(c.found, false, `${name} has no alpha planted and must not report one`);
      assert.ok(c.reason, `${name} must say WHY it found none`);
    }
    assert.match(found.text, /10\.\d\d Hz/, 'the panel must state the frequency');
    assert.match(found.text, /TP9/, 'and which channel it came from');
    assert.match(found.text, /above the 1\/f background/,
      'and that the claim is relative to the fitted background, not a raw maximum');

    // FOUR-SECOND WINDOWS, non-overlapping.
    assert.strictEqual(found.windowSec, 4, 'the lab windows are 4 seconds');
    assert.strictEqual(found.binHz, 0.25, 'which is what buys 0.25Hz resolution');
    assert.strictEqual(found.spectraRows, 30,
      `120s of non-overlapping 4s windows is 30 rows (got ${found.spectraRows})`);
    assert.ok(found.keys.includes('TP9 alphaRel') && found.keys.includes('TP9 alphaLog'),
      `the recomputed series must expose per-electrode alpha columns (got ${found.keys.join(', ')})`);
    assert.ok(found.keys.includes('alphaRel avg'),
      'and one headline column, so there is something to search without picking an electrode');
    assert.ok(!found.keys.some((k) => k.startsWith('TP10')),
      `the dead channel must contribute no columns at all (got ${found.keys.join(', ')})`);

    // THE SOURCE SWITCH must actually change what the analysis reads.
    const switched = await page.evaluate(async () => {
      const sel = document.getElementById('srcSel');
      const before = clipFeatureOptions();
      sel.value = 'spectra';
      sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: clipFeatureOptions(), source: analysisSource };
    });
    assert.strictEqual(switched.source, 'spectra');
    assert.ok(switched.before.includes('calm') && !switched.before.some((k) => k.includes('alphaRel')),
      `metrics.csv must not carry the recomputed columns (got ${switched.before.join(', ')})`);
    assert.ok(switched.after.some((k) => k.includes('alphaRel')),
      `switching source must offer the recomputed columns (got ${switched.after.join(', ')})`);

    /* AND THE DERIVED RESULTS MUST SURVIVE A RELOAD. The store drops raw EEG on purpose, so
       if the peak were not persisted a restored session would silently fall back to the
       fixed band — the same screen quietly answering a different question. */
    await page.evaluate(async () => { await persist(); });
    await page.reload();
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => {
      const s = sessions.find((x) => !x.error);
      return { hasRaw: !!(s.read.eeg && s.read.eeg.some((c) => c && c.length)),
        freqHz: s.alpha && s.alpha.freqHz, rows: s.spectra && s.spectra.rows.length,
        text: document.getElementById('alpha').textContent.replace(/\s+/g, ' ') };
    });
    assert.strictEqual(restored.hasRaw, false, 'precondition: the store really does drop raw EEG');
    assert.ok(Math.abs(restored.freqHz - found.freqHz) < 1e-9,
      `the measured peak must survive without the samples (${restored.freqHz} vs ${found.freqHz})`);
    assert.strictEqual(restored.rows, found.spectraRows, 'and so must the 4-second series');

    // THE FALLBACK, LABELLED. Noise-only EEG must name no frequency.
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    await page.reload();
    await page.waitForTimeout(300);
    await drop(page, [makeEegArchive({ id: 'none', alpha: false })]);
    const none = await page.evaluate(() => {
      const s = sessions.find((x) => !x.error);
      return { fallback: s.alpha.fallback, freqHz: s.alpha.freqHz, band: s.alpha.band,
        text: document.getElementById('alpha').textContent.replace(/\s+/g, ' ') };
    });
    assert.strictEqual(none.fallback, true, 'no alpha anywhere must be reported as a fallback');
    assert.strictEqual(none.freqHz, null, 'with no frequency claimed');
    assert.deepStrictEqual(none.band, [8, 13], 'and the fixed population band in use');
    assert.match(none.text, /No alpha peak found/, 'said plainly on screen');
    assert.match(none.text, /FIXED 8–13Hz band/,
      'and named as the population average it is, not left looking like a measurement');
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    console.log(`✓ individual alpha peak: ${found.freqHz.toFixed(2)}Hz from ${found.bestName},`
      + ` band ${found.band.map((b) => b.toFixed(2)).join('–')}Hz, ${found.spectraRows} four-second`
      + ` windows, survives a reload, and falls back in labelled words when there is no peak`);
  }

  /* ---- WHOLE SESSIONS: comparing two sits as sits ------------------------------------
   *
   * "i want it to also examine the overall recording to look for something qualitatively
   * different, if it can... i have 2 sessions i'd like to compare." Everything the lab did
   * before this was locked to marks, which answers "what happens when I notice I was thinking"
   * and cannot answer "was this sit different from that one".
   *
   * The fixture makes one sit nearly motionless and the other full of abrupt movements, so the
   * comparison has a right answer. And the honesty requirement is asserted as hard as the
   * arithmetic: no p-value may appear, because two sits are two observations.
   */
  {
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    await page.reload();
    await page.waitForTimeout(300);
    await drop(page, [makeMoveArchive({ id: 'calm', restless: false }),
      makeMoveArchive({ id: 'restless', restless: true })]);

    const out = await page.evaluate(async () => {
      // A is the calm sit, B the restless one.
      const ids = sessions.filter((s) => !s.error).map((s) => s.sessionId);
      wholeA = ids.find((i) => /calm/.test(i));
      wholeB = ids.find((i) => /restless/.test(i));
      renderWhole();
      await new Promise((r) => setTimeout(r, 150));
      const calm = sessions.find((s) => s.sessionId === wholeA);
      const restless = sessions.find((s) => s.sessionId === wholeB);
      return {
        text: document.getElementById('whole').textContent.replace(/\s+/g, ' '),
        calm: calm.movement, restless: restless.movement,
        calmSeries: Object.keys(calm.wholeStats.series).sort(),
        calmStats: calm.wholeStats.series.calm,
        hasSelects: !!document.getElementById('wholeA') && !!document.getElementById('wholeB'),
      };
    });

    // The measurement must get the answer right, or the view is decoration.
    assert.ok(out.calm && out.restless, 'both sits must carry a movement summary');
    assert.ok(out.calm.stillFrac > out.restless.stillFrac,
      `the calm sit must be stiller (${out.calm.stillFrac.toFixed(3)} vs ${out.restless.stillFrac.toFixed(3)})`);
    assert.ok(out.restless.eventsPerMin > out.calm.eventsPerMin,
      `and the restless one must show more movements (${out.calm.eventsPerMin.toFixed(2)}`
      + ` vs ${out.restless.eventsPerMin.toFixed(2)} per minute)`);
    assert.ok(out.restless.medianRiseFrac < out.calm.medianRiseFrac,
      `the restless sit's movements must be more front-loaded — this is the whole hypothesis`
      + ` (${out.calm.medianRiseFrac} vs ${out.restless.medianRiseFrac})`);

    // The view must show it, and offer a way to pick which two.
    assert.ok(out.hasSelects, 'the comparison must let you choose which two sessions');
    assert.match(out.text, /Stillness/, 'the movement table must be on screen');
    assert.match(out.text, /Peak position/, 'including the shape measure');
    assert.match(out.text, /not the EEG/i,
      'and must say the movement numbers come from the accelerometer rather than the brainwaves');

    /* NO P-VALUE REPORTED, which is not the same as never mentioning one. The first version of
     * this assertion banned the string "p-value" outright and failed on the section's own
     * disclaimer — the paragraph explaining why there is no p-value contains the words. So it
     * looks for a REPORTED figure (p = 0.03, p<0.001) and for a significance claim, and leaves
     * the explanation alone. */
    assert.doesNotMatch(out.text, /\bp\s*[=<>]\s*0?\.\d/,
      `a two-session comparison must not report a p-value (text: "${out.text.slice(0, 300)}")`);
    assert.doesNotMatch(out.text, /statistically significant|is significant|significant difference/i,
      'nor claim significance');
    assert.match(out.text, /no p-value appears anywhere on purpose/,
      'but it must say outright that the absence is deliberate, so nobody adds one later');
    assert.match(out.text, /two observations/,
      'and must say why: two sits are two observations');
    assert.match(out.text, /different day, different room/,
      'naming the confounds it cannot rule out');

    // Whole-sit descriptors must include the spread, not only the mean — a score pinned near its
    // ceiling has a high mean and no room to discriminate.
    assert.ok(out.calmSeries.includes('calm') && out.calmSeries.includes('equanimity'),
      `the recorded scores must be summarised (got ${out.calmSeries.join(', ')})`);
    for (const k of ['mean', 'median', 'p25', 'p75', 'n']) {
      assert.ok(out.calmStats[k] != null, `each series needs ${k}`);
    }
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    console.log(`✓ whole sessions compare as sessions: stillness`
      + ` ${(out.calm.stillFrac * 100).toFixed(1)}% vs ${(out.restless.stillFrac * 100).toFixed(1)}%,`
      + ` movements ${out.calm.eventsPerMin.toFixed(1)} vs ${out.restless.eventsPerMin.toFixed(1)}/min,`
      + ` peak position ${out.calm.medianRiseFrac} vs ${out.restless.medianRiseFrac}, and no p-value`);
  }

  /* ---- THE SAME SIT UNDER TWO FILENAMES MUST BE REFUSED ------------------------------
   *
   * A real findings report listed one session twice, and both `...-2346.zip` and
   * `...-2346 (1).zip` — what a browser names a re-download. Session ids are filenames, so those
   * are distinct sessions downstream, and two things break: n is inflated, and one copy can land
   * in training while the other lands in the held-out set. That is precisely the leak that
   * splitting by session exists to prevent, and it would let a finding be "confirmed" on the very
   * seconds it was fitted on.
   */
  {
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    await page.reload();
    await page.waitForTimeout(300);
    const archive = makeMoveArchive({ id: 'orig', restless: false });
    // The same bytes under a different name, exactly as a re-download arrives.
    const copy = { name: 'move-orig (1).zip', bytes: archive.bytes };
    await drop(page, [archive, copy], 1);       // two files, one row: the copy is refused
    const out = await page.evaluate(() => ({
      count: sessions.filter((s) => !s.error).length,
      files: sessions.map((s) => s.file),
      dupText: document.getElementById('loaded').textContent.replace(/\s+/g, ' '),
      keys: sessions.map((s) => s.contentKey),
    }));
    assert.strictEqual(out.count, 1,
      `the same recording twice must load once (got ${out.files.join(', ')})`);
    assert.match(out.dupText, /Refused 1 duplicate/,
      'and must say it refused one, or a vanished file looks like a failed drop');
    assert.match(out.dupText, /same sit as/, 'naming which sit it duplicated');
    assert.match(out.dupText, /both sides of the train\/test split/,
      'and why it matters, since the cost is a leak rather than clutter');
    assert.ok(out.keys[0], 'identity must come from the recording, not the filename');

    /* AND A GENUINELY DIFFERENT SIT MUST STILL LOAD. A duplicate check that rejects real data is
       worse than none — this is the assertion that keeps it from becoming one. */
    await drop(page, [makeMoveArchive({ id: 'other', restless: true, secs: 200 })], 2);
    const after = await page.evaluate(() => ({
      count: sessions.filter((s) => !s.error).length,
      keys: sessions.map((s) => s.contentKey),
    }));
    assert.strictEqual(after.count, 2, 'a different recording must still be accepted');
    assert.notStrictEqual(after.keys[0], after.keys[1],
      'two different sits must have different identities');
    await page.evaluate(async () => { await LabStore.clearSessions(store); });
    console.log('✓ the same recording under a different filename is refused, by recording identity'
      + ' rather than by name, and a genuinely different sit still loads');
  }

  /* THE SHELL AND THE EXPLORE TAB.
   *
   * Built after a mockup, for a stated reason: "the lab is a bit hard to use for a novice like that."
   * Everything on this page used to be one scroll of six analyses with no indication of where to start.
   *
   * The assertions that matter here are the honesty ones, because a screen that answers in SENTENCES
   * can mislead in ways a table cannot. Three of them:
   *   - a question with no possible answer must not be offered;
   *   - "not enough data" must never be phrased as "no effect";
   *   - when every available signal is one that cannot be compared between sits, the screen must say so
   *     rather than quietly answering a between-sits question with within-sit numbers.
   */
  {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const pg = await ctx.newPage();
    const shellErrors = [];
    pg.on('pageerror', (e) => shellErrors.push(e.message));
    await pg.goto(PAGE);

    /* EVERY MODULE CACHE-BUSTED, AND A VISIBLE FAILURE — neither of which this page had.
     *
     * direct.html gained both after two outages where one bad module took the whole app down silently.
     * The lab never did, and it produced the identical report: "the lab doesn't seem to work at all...
     * the tabs don't work and the add session button doesn't work." Every renderer runs from one
     * render() call, so a single module failing to load — a browser holding a cached copy from before
     * explore.js existed — throws there and takes the tabs and the file input with it. */
    const labHtml = require('fs').readFileSync(
      require('path').join(__dirname, 'public', 'lab.html'), 'utf8');
    const labIncludes = labHtml.match(/<script src="[^"]+"><\/script>/g) || [];
    const labUnversioned = labIncludes.filter((t) => !/\?v=/.test(t));
    assert.deepStrictEqual(labUnversioned, [],
      'every lab module must be cache-busted, or one stale file takes the whole page down: '
      + labUnversioned.join(' '));
    const labVersions = new Set((labHtml.match(/\?v=([^"']+)/g) || []).map((x) => x.slice(3)));
    assert.strictEqual(labVersions.size, 1,
      `the lab's assets must share one version, found ${JSON.stringify([...labVersions])}`);
    const labHandler = labHtml.indexOf("addEventListener('error'");
    assert.ok(labHandler > 0 && labHandler < labHtml.indexOf('<script src='),
      'and the failure handler must be installed before the first module can throw');

    const tabs = await pg.$$eval('.tab', (els) => els.map((e) => e.dataset.tab));
    /* Your sits leads. See the note on the landing pane below: with nothing analysed until it is
       asked for, a page that opens on a question opens on "not enough data". */
    assert.deepStrictEqual(tabs, ['sessions', 'explore', 'compare', 'signals', 'learn'],
      'five tabs, in order, with Your sits first');
    /* NO "My model" TAB. The mockup showed one, next to "Confidence 82%" and "Personalized model".
       Nothing here is fitted and there is no basis for 82, and a tab named for a thing that does not
       exist is worse than a missing tab. */
    assert.ok(!tabs.includes('model'), 'there must be no model tab, because there is no model');

    /* YOUR SITS is what you land on, and it changed FROM Explore deliberately.
       Leading with a question made sense while the lab analysed every sit on page load — the sits were
       all read by the time you looked. Nothing is analysed until it is asked for now, so a question
       asked on arrival can only answer "not enough data", which teaches the reader that the page never
       has an answer. The first screen has to be the one that says what there is. */
    assert.strictEqual(await pg.$eval('.pane:not([hidden])', (e) => e.dataset.pane), 'sessions',
      'the lab must open on Your sits');
    assert.match(await pg.$eval('#loaded h2', (e) => e.textContent), /your sits/i,
      'and lead with what there is to look at');
    await pg.click('.tab[data-tab="explore"]');
    await pg.waitForTimeout(600);
    assert.match(await pg.$eval('#explore h2', (e) => e.textContent), /what do you want to understand/i,
      'Explore still leads with the question');

    /*
     * FOUR SITS WITH A PLANTED EFFECT, because the first version of this test used makeArchive() and
     * passed VACUOUSLY: that fixture carries exactly one transition, so no mark kind reached the
     * three-per-sit floor, the experience dropdown was empty, and every assertion about its contents
     * was true of nothing. A test that cannot fail is worse than no test.
     *
     * Five 'lost' marks per sit, four sits (above the three-session floor), and calmAbs genuinely
     * raised in the twenty seconds before each mark — so this exercises the answer path all the way to
     * the "Repeats" badge rather than only the not-enough-data path.
     */
    const shellArchive = (id, seed) => {
      const t0 = Date.parse('2026-08-02T08:00:00Z') + seed * 86400000;
      const marks = [40, 90, 140, 190, 240];
      let sd = seed * 7919 + 11;
      const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff - 0.5; };
      const rows = [];
      for (let t = 0; t < 300; t++) {
        const near = marks.some((m) => t >= m - 20 && t <= m);
        rows.push({ t, epochMs: t0 + t * 1000, noise: 0.02,
          calm: 0.5 + rnd() * 0.1,
          calmAbs: 0.30 + (near ? 0.06 : 0) + rnd() * 0.01 });
      }
      const notes = marks.map((m, i) => ({ id: i + 1, kind: 'transition', at: t0 + m * 1000,
        offsetSec: m, transition: 'lost', tapCategory: 'lost', text: 'Thinking', anchored: true }));
      const { files } = Exporter.buildFiles({
        meta: { startedAt: t0, durationSec: 300, bytes: 1e6, ended: true, eegHz: 256 },
        eeg: [[1, 2, 3], [4, 5, 6], [], []], acc: [], rr: [], rows, notes,
      }, {});
      return { name: `shell-${id}.zip`,
        bytes: Buffer.from(Exporter.zip(files, { date: new Date(t0) })) };
    };
    const shellArchives = [1, 2, 3, 4].map((i) => shellArchive(i, i));
    await pg.setInputFiles('#file', shellArchives.map((a) => ({
      name: a.name, mimeType: 'application/zip', buffer: a.bytes,
    })));
    await pg.waitForFunction(() => sessions.filter((x) => !x.error).length >= 4, null, { timeout: 20000 });
    await pg.waitForTimeout(800);

    const ex = await pg.evaluate(() => ({
      experiences: [...(document.getElementById('expSel') || { options: [] }).options]
        .map((o) => o.textContent),
      findings: [...document.querySelectorAll('#explore .finding')].map((f) => ({
        say: f.querySelector('.say').textContent.replace(/\s+/g, ' '),
        badge: (f.querySelector('.badge') || {}).textContent || '',
        why: (f.querySelector('.why') || {}).textContent || '',
      })),
      body: document.querySelector('[data-pane="explore"]').textContent.replace(/\s+/g, ' '),
    }));

    /* NOT VACUOUS. The assertions below are about the CONTENTS of the experience list, so an empty list
       would make every one of them true of nothing — which is exactly how the first version of this
       test passed while proving nothing. */
    assert.ok(ex.experiences.length >= 1,
      'at least one answerable experience must be offered, or the assertions below test nothing');
    assert.ok(ex.findings.length >= 1, 'and at least one finding must be produced');

    /* THE PLANTED EFFECT MUST BE FOUND, AND CALLED WHAT IT IS. The positive control for the whole
       screen: calmAbs was raised before every mark in all four sits, so the badge has to say it
       repeats. Without this, all the honesty assertions could be satisfied by a screen that finds
       nothing ever. */
    const alphaFinding = ex.findings.find((f) => /alpha share/i.test(f.say));
    assert.ok(alphaFinding, `the alpha-share finding must appear (got ${JSON.stringify(
      ex.findings.map((f) => f.say.slice(0, 40)))})`);
    assert.match(alphaFinding.badge, /Repeats/,
      `a planted effect in all four sits must read as repeating, got "${alphaFinding.badge}"`);
    assert.match(alphaFinding.say, /higher/, 'and name the direction it was planted in');
    assert.match(alphaFinding.badge, /4 of 4/, 'and count all four sits');

    /* NO UNANSWERABLE QUESTIONS OFFERED. The first version listed every kind found in the archives,
       including "text · 9 marks in 0 sits" and "voice · 3 marks in 0 sits" — general notes and voice
       memos, which are not moments at all. Picking one returned "not enough", indistinguishable from a
       real null. */
    for (const label of ex.experiences) {
      assert.doesNotMatch(label, /in 0 sits/,
        `"${label}" cannot answer anything and must not be offered`);
      assert.doesNotMatch(label, /^(text|voice)\b/,
        `"${label}" is not a marked moment and must not be offered as an experience`);
    }

    // Every finding carries a badge whose text is a COUNT, never a percentage.
    for (const f of ex.findings) {
      assert.ok(f.badge, `a finding with no badge hides its own evidence: "${f.say}"`);
      assert.doesNotMatch(f.badge, /%/, `badge "${f.badge}" must not carry a confidence percentage`);
      assert.ok(f.why.length > 20, 'and must explain the basis of that badge');
      // Two explanations joined into prose, not run together: the first version produced "3 are needed
      // before a count means anything CANNOT be compared between sits" as one sentence.
      assert.doesNotMatch(f.why, /[a-z] [A-Z]{4,}/,
        `two sentences ran together without punctuation: "${f.why}"`);
    }
    assert.doesNotMatch(ex.body, /confidence/i,
      'nothing on this screen may report a confidence — there is no model behind one');

    /* "NOT ENOUGH" MUST NOT READ AS "NO EFFECT". These fixtures have two sits, which is below the
       three-session floor, so this is the exact case where the two get conflated. */
    const short = ex.findings.filter((f) => /Not enough/i.test(f.badge));
    for (const f of short) {
      assert.doesNotMatch(f.say, /no consistent pattern|no difference|no effect/i,
        `"${f.say}" is an absence of DATA and must never be phrased as an absence of effect`);
      assert.match(f.say, /Not enough/i, 'and must say so plainly');
    }

    // And the tabs must actually switch, each to its own content.
    for (const [tab, heading] of [['explore', /what do you want to understand/i],
      ['compare', /Whole sessions|Patterns/],
      ['signals', /alpha|Clip/i], ['learn', /What these numbers are/]]) {
      await pg.click(`.tab[data-tab="${tab}"]`);
      await pg.waitForTimeout(1200);
      assert.strictEqual(await pg.$eval('.pane:not([hidden])', (e) => e.dataset.pane), tab,
        `the ${tab} tab must show the ${tab} pane`);
      const h = await pg.evaluate(() => {
        const el = document.querySelector('.pane:not([hidden]) h2');
        return el ? el.textContent : '';
      });
      assert.match(h, heading, `the ${tab} pane must render its own content, got "${h}"`);
    }

    /* LEARN MUST LEAD WITH THE COMPARABILITY WARNING. It is the single most consequential thing about
       these numbers and it was discovered the hard way: measured over seven real sits the displayed calm
       score spanned 42-53 while the physiology spanned twofold, ranking the sits in slightly OPPOSITE
       order. Anyone comparing sits on that score reaches a conclusion that is worse than none. */
    await pg.click('.tab[data-tab="learn"]');
    await pg.waitForTimeout(600);
    const learn = await pg.$eval('[data-pane="learn"]', (e) => e.textContent.replace(/\s+/g, ' '));
    assert.match(learn, /cannot be compared between sits/i,
      'Learn must warn that most scores cannot be compared between sits');
    assert.match(learn, /OPPOSITE order|opposite/i, 'and give the measured reason');
    assert.match(learn, /cannot tell you/i, 'and state what this lab cannot do');

    assert.deepStrictEqual(shellErrors, [],
      `the shell must render without errors:\n  ${shellErrors.join('\n  ')}`);
    await pg.close();
    await ctx.close();
    console.log(`✓ five tabs, Your sits first, ${ex.experiences.length} answerable experiences offered`
      + ' (none unanswerable), badges are counts not percentages, "not enough" never reads as "no'
      + ' effect", and Learn leads with what cannot be compared');
  }

  /* 16) THE LAB MUST OPEN INSTANTLY, AND THE SITS LIST MUST BE USEFUL WITH NOTHING ANALYSED.
   *
   * This is the test for the freeze, and its absence is why the freeze shipped: nothing here had ever
   * loaded lab.html with the app's database already full. Reported as "the lab is still freezing even
   * after a hard reload", and the hard reload is the tell — it was never a caching problem.
   *
   * The lab used to analyse the twelve most recent sits on page load. Analysing a sit means reading its
   * raw EEG out of IndexedDB, rebuilding it into an archive, parsing that back, and running an alpha
   * peak and a spectral series over the samples. Measured before the fix, in this same headless
   * Chromium: 9.3s before a single row appeared for 8 sits of 30 minutes, 19.9s for 14 of 40 — and
   * identical on the second and third load, because none of it was cached. On a phone that is minutes,
   * and it grows with every sit recorded.
   *
   * WHAT IS ASSERTED, and why each one is the property that actually matters:
   *
   *   - the list appears fast, with EVERY recording in it. A fast page that lists nothing is not a fix.
   *   - it is useful with nothing analysed: the sit's own general note as its name, its length, and its
   *     mark tally by kind. Those decide which sits are worth reading, so they must not cost a read.
   *   - the heavy work happens on demand and STAYS done. A sit analysed once must never be analysed
   *     again, which is the difference between a one-off wait and a wait on every visit.
   *
   * Seeded straight into the app's object stores rather than by driving a recording: the shape is
   * record.js's own (see its onupgradeneeded), and a 30-minute sit cannot be recorded in a test.
   */
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const bootErrors = [];
    pg.on('pageerror', (e) => bootErrors.push(e.message));

    const SITS = 6, MINUTES = 12;
    await pg.goto(PAGE.replace('lab.html', 'direct.html'));
    const seeded = await pg.evaluate(async ({ sits, minutes }) => {
      const HZ = 256, FLUSH = 4;
      const db = await Recorder.open();
      let bytes = 0;
      for (let s = 0; s < sits; s++) {
        const startedAt = Date.UTC(2026, 5, 3 + s, 6, 30, 0);
        const id = `seeded-${s}`;
        const durationSec = minutes * 60;
        const tx = db.transaction([Recorder.STORE_SESSIONS, Recorder.STORE_CHUNKS,
          Recorder.STORE_NOTES], 'readwrite');
        const chunks = tx.objectStore(Recorder.STORE_CHUNKS);
        let seq = 0, sitBytes = 0;
        for (let t = 0; t < durationSec; t += FLUSH) {
          for (let ch = 0; ch < 4; ch++) {
            const d = new Float32Array(HZ * FLUSH);
            for (let i = 0; i < d.length; i++) {
              const tt = t + i / HZ;
              d[i] = 22 * Math.sin(2 * Math.PI * 10.1 * tt) + 14 * Math.sin(2 * Math.PI * 6 * tt)
                + 40 * (Math.sin(i * 12.9898) * 43758.5453 % 1 - 0.5);
            }
            chunks.put({ sessionId: id, seq: seq++, kind: 'eeg', channel: ch, t0: t, hz: HZ, data: d });
            sitBytes += d.byteLength;
          }
          const rows = [];
          for (let i = 0; i < FLUSH; i++) {
            rows.push({ t: t + i, epochMs: startedAt + (t + i) * 1000,
              absoluteTime: new Date(startedAt + (t + i) * 1000).toISOString(),
              calm: 0.5, thinking: 0.4, focus: 0.5, noise: 0.05, calmAbs: 0.4 });
          }
          chunks.put({ sessionId: id, seq: seq++, kind: 'row', t0: t, data: rows });
        }
        const notes = tx.objectStore(Recorder.STORE_NOTES);
        // The general note: unanchored, and the thing the row is named by.
        notes.put({ sessionId: id, at: startedAt + 900, offsetSec: null, anchored: false,
          kind: 'general', text: `day ${s + 1} — scattered at first, then settled` });
        for (let k = 0; k < 8; k++) {
          notes.put({ sessionId: id, at: startedAt + (40 + k * 60) * 1000, offsetSec: 40 + k * 60,
            kind: 'transition', transition: k % 2 ? 'lost' : 'returned',
            tapCategory: k % 2 ? 'lost' : 'returned' });
        }
        tx.objectStore(Recorder.STORE_SESSIONS).put({ id, startedAt, eegHz: HZ, accHz: 50,
          durationSec, bytes: sitBytes, ended: true, label: '' });
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        bytes += sitBytes;
      }
      db.close();
      return { bytes };
    }, { sits: SITS, minutes: MINUTES });

    const openAt = Date.now();
    await pg.goto(PAGE);
    await pg.waitForSelector('#loaded table tr.sesMain', { timeout: 30000 });
    const firstPaint = Date.now() - openAt;

    const listed = await pg.$$eval('#loaded table tr.sesMain', (rows) => rows.length);
    assert.strictEqual(listed, SITS,
      `every recording on the device must be listed (got ${listed} of ${SITS})`);
    /* 6 seconds against a pre-fix 9.3s for a comparable load, in the same browser. Deliberately loose:
       this is a "did the O(sits) work leave the boot path" check running on shared CI hardware, not a
       benchmark. The pre-fix code cannot pass it — it did not paint a row for 9 seconds. */
    assert.ok(firstPaint < 6000,
      `the sits list must appear without analysing anything (took ${firstPaint}ms for`
      + ` ${(seeded.bytes / 1e6).toFixed(0)}MB of EEG)`);

    // Nothing analysed, and every row says so rather than showing a blank.
    assert.strictEqual(await pg.$$eval('[data-analyse]', (b) => b.length), SITS,
      'each unread sit must offer to be analysed');

    // USEFUL WITH NOTHING READ. The note names the sit, and the tally is there to choose by.
    const firstRow = await pg.$eval('#loaded table tr.sesMain', (tr) => ({
      name: tr.children[1].textContent.replace(/\s+/g, ' ').trim(),
      length: tr.children[3].textContent.trim(),
      marks: tr.children[4].textContent.replace(/\s+/g, ' ').trim(),
    }));
    assert.match(firstRow.name, /scattered at first/,
      `the sit must be named by its own general note (got "${firstRow.name}")`);
    assert.match(firstRow.length, /^\d+:\d\d$/, `and show its length (got "${firstRow.length}")`);
    assert.match(firstRow.marks, /\d+×/,
      `and its mark tally by kind, with nothing analysed (got "${firstRow.marks}")`);

    // ---- on demand, and it stays done ------------------------------------------------
    const analyseAt = Date.now();
    await pg.click('[data-analyse]');
    /* Waited on the PROGRESS element emptying, not on the buttons vanishing. They vanish the instant
       the run starts — the cell reads "waiting..." — so the obvious condition is true immediately and a
       test that used it would navigate away mid-analysis. It did, and it read as a persistence bug. */
    await pg.waitForFunction(() => {
      const p = document.getElementById('analyseProgress');
      return p && !p.innerHTML.trim();
    }, null, { timeout: 90000 });
    assert.strictEqual(await pg.$$eval('[data-analyse]', (b) => b.length), SITS - 1,
      'the analysed sit must drop out of the unread list');
    const analysed = await pg.$eval('#loaded table tr.sesMain', (tr) =>
      tr.children[6].textContent.replace(/\s+/g, ' ').trim());
    assert.ok(/complete|warning/i.test(analysed),
      `an analysed row must carry a signal verdict (got "${analysed}")`);
    console.log(`  analysed one ${MINUTES}-minute sit on demand in ${Date.now() - analyseAt}ms`);

    // THE POINT: it must not be analysed again. This is what turns a per-load wait into a one-off.
    const reloadAt = Date.now();
    await pg.reload();
    await pg.waitForSelector('#loaded table tr.sesMain', { timeout: 30000 });
    const reloadMs = Date.now() - reloadAt;
    assert.strictEqual(await pg.$$eval('[data-analyse]', (b) => b.length), SITS - 1,
      'an already-analysed sit must not need analysing again after a reload');
    assert.ok(reloadMs < 6000, `and the reload must still be immediate (took ${reloadMs}ms)`);

    /* SETTING A SIT ASIDE PERSISTS. Pressing x used to drop it from memory and from the lab's store,
       which worked until the next reload read it back off the device — so the sit returned and the
       button read as broken. */
    await pg.click('[data-exclude]');
    await pg.waitForSelector('[data-include]', { timeout: 10000 });
    await pg.reload();
    await pg.waitForSelector('#loaded table tr.sesMain', { timeout: 30000 });
    assert.strictEqual(await pg.$$eval('[data-include]', (b) => b.length), 1,
      'a set-aside sit must stay set aside across a reload');
    assert.strictEqual(await pg.$$eval('#loaded table tr.sesMain', (r) => r.length), SITS - 1,
      'and must be out of the main list, without deleting the recording');

    assert.deepStrictEqual(bootErrors, [],
      `the lab must boot without errors:\n  ${bootErrors.join('\n  ')}`);
    await pg.close();
    await ctx.close();
    console.log(`✓ the lab opens in ${firstPaint}ms with ${SITS} sits and`
      + ` ${(seeded.bytes / 1e6).toFixed(0)}MB of EEG on the device, names each by its own note, shows`
      + ` its mark tally with nothing analysed, analyses on demand, and never re-analyses`);
  }

  assert.deepStrictEqual(errors, [], `no errors during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll lab tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
