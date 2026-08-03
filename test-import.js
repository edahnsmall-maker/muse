/*
 * Tests for reading a session archive back.
 *
 * THE POINT: the reader is checked against archives produced by the SYSTEM `zip`,
 * not only by our own writer. A reader and a writer developed together share their
 * misunderstandings and will agree with each other about a malformed file — the same
 * circularity that let a wrong PMD decode pass for days. An external producer has no
 * such loyalty, and it also exercises DEFLATE, which our writer never emits.
 *
 * The round trip through our own writer is tested too, because that is the path a
 * real session actually takes.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const Importer = require('./public/import.js');
const Exporter = require('./public/export.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zenimport-'));
const have = (cmd) => {
  try { execFileSync(cmd, ['-h'], { stdio: 'ignore' }); return true; }
  catch (e) { return e.status !== undefined && e.status !== 127; }
};

(async () => {
  // 1) An archive from the SYSTEM zip, including a DEFLATE-compressed entry.
  {
    let ok = false;
    try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); ok = true; } catch (e) { ok = false; }
    if (ok) {
      const dir = path.join(tmp, 'src');
      fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
      // Highly compressible, so `zip` definitely chooses DEFLATE rather than STORE.
      fs.writeFileSync(path.join(dir, 'session.md'), '# hi\n' + 'a'.repeat(5000) + '\ncafé ☕\n');
      fs.writeFileSync(path.join(dir, 'metrics.csv'), 't,calm\n0,0.5\n1,0.75\n');
      const floats = new Float32Array([1.5, -2.25, 1000.125]);
      fs.writeFileSync(path.join(dir, 'eeg-ch1.f32'), Buffer.from(floats.buffer));
      fs.writeFileSync(path.join(dir, 'notes', 'voice-1.webm'), Buffer.from([1, 2, 3, 4]));
      const zipPath = path.join(tmp, 'external.zip');
      execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: dir });

      const files = await Importer.unzip(fs.readFileSync(zipPath));
      const names = Object.keys(files);
      for (const want of ['session.md', 'metrics.csv', 'eeg-ch1.f32', 'notes/voice-1.webm']) {
        assert.ok(names.includes(want), `${want} must be found (got ${names.join(', ')})`);
      }
      assert.match(new TextDecoder().decode(files['session.md']), /café ☕/,
        'UTF-8 must survive a foreign archive');
      assert.deepStrictEqual(Array.from(Importer.f32(files['eeg-ch1.f32'])), Array.from(floats),
        'floats must come back bit-identical through DEFLATE');
      assert.deepStrictEqual(Array.from(files['notes/voice-1.webm']), [1, 2, 3, 4]);
      console.log('✓ archives from the system `zip` read correctly, DEFLATE included');
    } else {
      // Announce a skipped external check. A suite that quietly passes a test it did
      // not run is reporting safety it has not established.
      console.log('⚠ `zip` not available — the EXTERNAL archive test did NOT run');
    }
  }

  // 2) Malformed input must be REFUSED with a readable reason, not half-read. Half an
  //    imported session would be analysed as though it were whole.
  {
    await assert.rejects(() => Importer.unzip(new Uint8Array([1, 2, 3])), /too short/);
    await assert.rejects(
      () => Importer.unzip(new Uint8Array(200)), /no end-of-central-directory/);

    // A file whose CONTENT contains a local-header signature must not be mistaken for
    // an entry. This is why the reader walks the central directory instead of
    // scanning: a run of EEG floats can easily contain 50 4B 03 04.
    const sneaky = Exporter.zip([{
      name: 'eeg-ch0.f32',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
    }]);
    const files = await Importer.unzip(sneaky);
    assert.deepStrictEqual(Object.keys(files), ['eeg-ch0.f32'],
      'a signature inside file data must not become a phantom entry');
    console.log('✓ malformed archives are refused, and data is not mistaken for structure');
  }

  // 3) CSV: EMPTY MUST STAY NULL. A blank cell means "not reported" — an unreported
  //    dimension, an unanchored note, a metric with no inputs — and turning those into
  //    zeroes would inject fabricated observations into the analysis.
  {
    const rows = Importer.parseCsv('a,b,c\n1,,x\n2,3,\n');
    assert.strictEqual(rows[0].b, null, 'a blank cell must be null, never 0');
    assert.strictEqual(rows[1].c, null);
    assert.strictEqual(rows[0].a, 1, 'numbers are converted');
    assert.strictEqual(rows[0].c, 'x', 'text stays text');

    // Quoting, including a comma and a newline inside a note.
    const q = Importer.parseCsv('text,n\n"he said ""hi"", then left\nabruptly",4\n');
    assert.strictEqual(q.length, 1, 'a quoted newline must not split the row');
    assert.strictEqual(q[0].text, 'he said "hi", then left\nabruptly');
    assert.strictEqual(q[0].n, 4);

    // Things that look numeric but are not must stay strings, or a timestamp becomes
    // arithmetic.
    const s = Importer.parseCsv('a,b,c,d\n2026-07-28,00m12s,1e3,0.5\n');
    assert.strictEqual(s[0].a, '2026-07-28');
    assert.strictEqual(s[0].b, '00m12s');
    assert.strictEqual(s[0].c, 1000, 'exponent notation is a number');
    assert.strictEqual(s[0].d, 0.5);
    console.log('✓ CSV parsing keeps blanks null and does not turn dates into numbers');
  }

  // 4) The full round trip: what export.js writes, import.js reads back.
  {
    const t0 = new Date('2026-07-28T06:00:00').getTime();
    const session = {
      meta: { startedAt: t0, durationSec: 1200, bytes: 5e6, ended: true, eegHz: 256, accHz: 50 },
      eeg: [[1, 2, 3], [4, 5, 6], [], []],
      acc: [[1000, 5, -10], [1001, 6, -11]],
      rr: [820, 810],
      rows: [{ t: 0, calm: 0.4, focus: 0.3, epochMs: t0 },
        { t: 1, calm: 0.55, focus: null, epochMs: t0 + 1000 }],
      notes: [
        { id: 1, kind: 'text', at: t0 + 600000, offsetSec: 600,
          dims: { focus: 5, effort: 1 }, text: 'opened up' },
        { id: 2, kind: 'transition', at: t0 + 300000, offsetSec: 300, transition: 'returned' },
      ],
    };
    const { files } = Exporter.buildFiles(session, {});
    const archive = Exporter.zip(files, { date: new Date(t0) });
    const read = await Importer.readSessionArchive(archive);

    assert.strictEqual(read.eegHz, 256, 'the sample rate must be recovered from the README');
    assert.deepStrictEqual(Array.from(read.eeg[1]), [4, 5, 6], 'raw EEG round-trips');
    assert.strictEqual(read.eeg[3].length, 0, 'a channel with no data reads as empty, not missing');
    assert.strictEqual(read.metrics.length, 2);
    assert.strictEqual(read.metrics[0].calm, 0.4);
    assert.strictEqual(read.metrics[1].focus, null,
      'a metric that was null must come back null, not 0 — it had no inputs');
    assert.strictEqual(read.metrics[0].epochMs, t0, 'absolute time survives as a number');

    const labelled = read.notes.find((n) => n.text === 'opened up');
    assert.strictEqual(labelled.focus, 5);
    assert.strictEqual(labelled.effort, 1);
    assert.strictEqual(labelled.quadrant, 'absorbed');
    assert.strictEqual(labelled.pull, null, 'an unreported dimension stays null');
    const trans = read.notes.find((n) => n.transition === 'returned');
    assert.ok(trans, 'transitions survive the round trip');

    assert.strictEqual(read.acc.length, 2);
    assert.strictEqual(read.acc[0].tSec, 0, 'accelerometer time column survives');
    assert.strictEqual(read.rr[0].rrMs, 820);
    assert.match(read.markdown, /Session 2026-07-28/);
    assert.deepStrictEqual(read.warnings, [],
      `a complete archive must produce no warnings (got ${read.warnings.join('; ')})`);
    console.log('✓ a full export round-trips: raw, metrics, labels, transitions, timings');
  }

  // 5) An INCOMPLETE archive must still open, and must say what is missing rather
  //    than quietly analysing less than the user thinks it is analysing.
  {
    const partial = Exporter.zip([
      { name: 'notes.csv', bytes: Uint8Array.from(Buffer.from('offsetSec,text\n10,hello\n', 'utf8')) },
    ]);
    const read = await Importer.readSessionArchive(partial);
    assert.strictEqual(read.notes.length, 1, 'what is present must still be read');
    assert.ok(read.warnings.some((w) => /metrics\.csv/.test(w)), 'and absences named');
    assert.ok(read.warnings.some((w) => /no raw EEG/.test(w)));
    assert.ok(read.warnings.some((w) => /sample rate/.test(w)),
      'a missing sample rate must be flagged — a wrong rate silently rescales every'
      + ' frequency in the analysis');
    assert.strictEqual(read.eegHz, 256, 'and the assumed fallback stated, not hidden');

    // A .f32 that is not a whole number of floats is a corrupt file, not a short one.
    assert.throws(() => Importer.f32(new Uint8Array(7)), /whole number of floats/);
    assert.strictEqual(Importer.f32(new Uint8Array(0)).length, 0);
    console.log('✓ an incomplete archive opens, and names what is missing');
  }

  /* A SIMULATED SIT MUST STILL BE IDENTIFIABLE AFTER A ROUND TRIP THROUGH A REAL ZIP.
   *
   * The app can produce a complete, well-formed sit with no headband attached (`?sim=1`). Its rows
   * have the same columns, the same sample rate and the same plausible ranges as real ones, so once
   * one is pooled with real sits NOTHING in the data can separate it again — every comparison built
   * on that pool is contaminated permanently and silently.
   *
   * So the marker is tested as a chain, end to end, with each link checked separately: three
   * independent markers on the way out, and the one that survives a rename recovered on the way back
   * in. A test that only checked `meta.simulated` would prove the flag was set and nothing about
   * whether it reaches the person reading the archive a month later.
   */
  {
    const meta = { startedAt: Date.parse('2026-08-03T09:57:00Z'), durationSec: 60, bytes: 4096,
      ended: true, eegHz: 256, simulated: true };
    const rows = Array.from({ length: 60 }, (_, i) => ({ t: i, calm: 0.5, noise: 0 }));

    // 1) The filename, which is the marker that shows up in a folder of sits without anything
    //    being opened.
    assert.match(Exporter.archiveName(meta), /^SIMULATED-/,
      'a simulated sit must be obvious from its filename');
    assert.doesNotMatch(Exporter.archiveName({ startedAt: meta.startedAt }), /SIMULATED/,
      'and a real one must not be labelled — a marker that fires on everything says nothing');

    // 2) The report, at the top, before anything that reads like a result.
    const md = Exporter.toMarkdown({ meta, rows, notes: [] });
    assert.match(md, /SIMULATED DATA/, 'session.md must say so');
    const firstResult = md.indexOf('What the app showed');
    assert.ok(md.indexOf('SIMULATED DATA') < (firstResult === -1 ? md.length : firstResult),
      'and must say so BEFORE the numbers, not in a footnote under them');
    assert.doesNotMatch(Exporter.toMarkdown({ meta: { startedAt: meta.startedAt, durationSec: 60 },
      rows, notes: [] }), /SIMULATED/, 'a real sit gets no banner');

    // 3) A file in the archive, and the reader must recover it from the archive alone — the filename
    //    prefix is gone by the time a browser file input hands the bytes over, so the file is the
    //    only marker that survives a rename.
    const { files } = Exporter.buildFiles({ meta, rows, notes: [] });
    assert.ok(files.some((f) => f.name === 'SIMULATED.txt'),
      'the archive must carry a warning file whose NAME is the warning');
    const zipped = Exporter.zip(files);
    const read = await Importer.readSessionArchive(new Uint8Array(zipped));
    assert.strictEqual(read.simulated, true,
      'the reader must recover the marker from the archive contents, not from its name');
    assert.ok(read.warnings.some((w) => /SIMULATED/.test(w)),
      'and must warn in words, so a caller that only prints warnings still says it');

    // And the negative case, through the same path: a real archive must come back clean, or the
    // marker is worthless.
    const realMeta = { startedAt: meta.startedAt, durationSec: 60, bytes: 4096, ended: true, eegHz: 256 };
    const realRead = await Importer.readSessionArchive(
      new Uint8Array(Exporter.zip(Exporter.buildFiles({ meta: realMeta, rows, notes: [] }).files)));
    assert.strictEqual(realRead.simulated, false, 'a real archive must read as real');
    console.log('✓ a simulated sit is marked in its filename, its report and its contents, and the'
      + ' reader recovers it after a rename');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nAll import tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
