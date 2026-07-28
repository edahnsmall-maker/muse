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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
        verdict: document.querySelector('#out .headline').textContent,
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

  assert.deepStrictEqual(errors, [], `no errors during interaction:\n  ${errors.join('\n  ')}`);
  await browser.close();
  console.log('\nAll lab tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
