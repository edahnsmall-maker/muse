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

async function drop(page, archives) {
  await page.setInputFiles('#file', archives.map((a) => ({
    name: a.name, mimeType: 'application/zip', buffer: a.bytes,
  })));
  // The page reads and parses asynchronously; wait for the table rather than sleeping.
  await page.waitForFunction((n) => document.querySelectorAll('#loaded tbody tr, #loaded table tr').length >= n + 1,
    archives.length, { timeout: 15000 });
  await page.waitForTimeout(400);
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
    const drawn = await page.evaluate(() => {
      const c = document.querySelector('#timelines canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
      return { lit, w: c.width, legend: document.querySelector('#timelines .legend').textContent };
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
        renderTimelines();
        const c = document.querySelector('#timelines canvas');
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
      renderTimelines();
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

  assert.deepStrictEqual(errors, [], `no errors during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll lab tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
