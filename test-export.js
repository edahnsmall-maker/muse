/*
 * Export tests.
 *
 * THE POINT OF THE ZIP TEST: it is validated by the system `unzip`, not by a
 * reader written in this repo. A hand-rolled archive checked with a hand-rolled
 * parser is the self-consistency trap that let a wrong PMD decode pass its tests
 * for days — the parser and the writer share the same misunderstanding and agree
 * with each other. An external tool has no such loyalty, and CRC-32 gives it
 * something to actually check the bytes against.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const Exporter = require('./public/export.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zenexport-'));

// 1) CRC-32 against published values. Not against our own second implementation.
{
  const enc = (s) => Uint8Array.from(Buffer.from(s, 'utf8'));
  // The canonical check value for CRC-32: "123456789" -> 0xCBF43926.
  assert.strictEqual(Exporter.crc32(enc('123456789')), 0xcbf43926,
    'CRC-32 of "123456789" must be the standard check value 0xCBF43926');
  assert.strictEqual(Exporter.crc32(enc('')), 0, 'CRC-32 of nothing is 0');
  assert.strictEqual(Exporter.crc32(enc('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  console.log('✓ CRC-32 matches published check values');
}

// 2) A REAL unzip must accept the archive and return the bytes unharmed.
{
  const eeg = new Float32Array([1.5, -2.25, 1e-7, 12345.75]);
  const files = [
    { name: 'session.md', bytes: Uint8Array.from(Buffer.from('# hello\n\nnote: café ☕\n', 'utf8')) },
    { name: 'metrics.csv', bytes: Uint8Array.from(Buffer.from('t,calm\n0,0.5\n1,0.61\n', 'utf8')) },
    { name: 'eeg-ch1.f32', bytes: new Uint8Array(eeg.buffer) },
    { name: 'notes/voice-00m12s-1.webm', bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9]) },
  ];
  const archive = Exporter.zip(files, { date: new Date('2026-07-27T09:15:00') });
  const zipPath = path.join(tmp, 'a.zip');
  fs.writeFileSync(zipPath, Buffer.from(archive));

  let haveUnzip = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (e) { haveUnzip = false; }

  if (haveUnzip) {
    // -t tests every entry's CRC. This is the assertion that matters: it proves
    // the headers, the sizes and the checksums all agree with the actual bytes.
    const out = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    assert.match(out, /No errors detected/i, `unzip -t must pass:\n${out}`);

    const dest = path.join(tmp, 'out');
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest]);

    // Bytes back out, exactly. Including a nested path and non-ASCII text.
    assert.strictEqual(fs.readFileSync(path.join(dest, 'session.md'), 'utf8'),
      '# hello\n\nnote: café ☕\n', 'UTF-8 text must survive intact');
    const backF32 = new Float32Array(
      Uint8Array.from(fs.readFileSync(path.join(dest, 'eeg-ch1.f32'))).buffer);
    assert.deepStrictEqual(Array.from(backF32), Array.from(eeg),
      'raw EEG floats must survive bit-identically through the archive');
    assert.deepStrictEqual(
      Array.from(fs.readFileSync(path.join(dest, 'notes/voice-00m12s-1.webm'))),
      [0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9], 'a nested binary entry must survive');
    console.log('✓ the archive passes `unzip -t` and every byte round-trips (validated externally)');
  } else {
    // Do not silently pass. A skipped external check must announce itself, or the
    // suite reports success for a test that did not run.
    console.log('⚠ `unzip` not available — the EXTERNAL zip validation did NOT run');
  }

  // An empty archive must still be a valid archive rather than a truncated file.
  const empty = Exporter.zip([]);
  assert.strictEqual(empty.length, 22, 'an empty zip is just the end-of-central-directory record');
  assert.deepStrictEqual(Array.from(empty.slice(0, 4)), [0x50, 0x4b, 0x05, 0x06],
    'and it must carry the EOCD signature');
}

// 3) CSV: fixed columns, so a row missing a key leaves a blank cell rather than
//    shifting every column after it — which would silently corrupt the file.
{
  const csv = Exporter.toCsv([
    { t: 0, calm: 0.5, focus: 0.4 },
    { t: 1, calm: 0.6 },                    // focus missing
    { t: 2, calm: null, focus: 0.9 },
  ], ['t', 'calm', 'focus']);
  assert.strictEqual(csv, 't,calm,focus\n0,0.5,0.4\n1,0.6,\n2,,0.9\n');

  // Commas, quotes and newlines in a note must not break the row.
  const tricky = Exporter.toCsv([{ text: 'he said "hi", then left\nabruptly' }], ['text']);
  assert.strictEqual(tricky, 'text\n"he said ""hi"", then left\nabruptly"\n');
  // Arrays (the per-channel levels) must not spill into neighbouring columns.
  const arr = Exporter.toCsv([{ levels: [1, 2, 3], t: 0 }], ['t', 'levels']);
  assert.strictEqual(arr, 't,levels\n0,"1 2 3"\n');
  console.log('✓ CSV keeps its columns aligned through missing keys, quotes and commas');
}

// 4) The assembled export: what a session actually turns into.
{
  const session = {
    meta: { startedAt: new Date('2026-07-27T06:05:00').getTime(), durationSec: 1830,
      bytes: 9_400_000, ended: true, eegHz: 256, accHz: 50 },
    eeg: [[1, 2], [3, 4], [5, 6], [7, 8]],
    acc: [[1000, 10, -20], [1001, 11, -21]],
    rr: [812, 799],
    rows: [{ t: 0, calm: 0.13, focus: 0.4 }, { t: 1, calm: 0.9, focus: 0.5 }],
    notes: [
      { id: 1, kind: 'voice', at: new Date('2026-07-27T06:12:30').getTime(),
        offsetSec: 450, seconds: 14.2, mimeType: 'audio/mp4' },
      { id: 2, kind: 'mark', at: new Date('2026-07-27T06:20:00').getTime(),
        offsetSec: 900, markKind: 'settling', text: 'dropped in suddenly' },
    ],
  };
  const { files, noteFiles } = Exporter.buildFiles(session, { 1: Uint8Array.from([1, 2, 3]) });
  const names = files.map((f) => f.name);

  for (const want of ['session.md', 'metrics.csv', 'notes.csv', 'README.txt',
    'eeg-ch0.f32', 'eeg-ch3.f32', 'acc.csv', 'rr.csv']) {
    assert.ok(names.includes(want), `the export must contain ${want} (got ${names.join(', ')})`);
  }
  // Safari records mp4, Chrome records webm. Hardcoding either mislabels the other.
  assert.ok(names.some((n) => n === 'notes/voice-07m30s-1.m4a'),
    `an audio/mp4 note must be named .m4a, not .webm (got ${names.join(', ')})`);
  assert.strictEqual(noteFiles[1], 'notes/voice-07m30s-1.m4a');

  const md = Buffer.from(files.find((f) => f.name === 'session.md').bytes).toString('utf8');
  // The transcript line must be present and EMPTY: a slot to fill in, never a
  // guess at what was said.
  assert.match(md, /- Transcript: *$/m, 'the markdown must leave an empty transcript slot');
  assert.match(md, /notes\/voice-07m30s-1\.m4a/, 'and point at the audio file by name');
  assert.match(md, /07:30/, 'a note must be findable by its clock time');
  assert.match(md, /dropped in suddenly/, 'a typed mark must appear as text');
  // The recorded score, which is the point of keeping composites at all.
  assert.match(md, /Calm: mean 52, range 13–90/,
    'the summary must report what the app claimed at the time, so it can be audited');

  const notesCsv = Buffer.from(files.find((f) => f.name === 'notes.csv').bytes).toString('utf8');
  assert.match(notesCsv, /^offsetSec,clock,epochMs,absoluteTime,anchored,kind,markKind,transition,trialKey,condition,blockIndex,response,latencySec,tapCategory,grade,focus,effort,pull,tone,quadrant,seconds,audioFile,text,transcript$/m,
    'notes.csv must expose the label columns and an empty transcript column');
  assert.match(notesCsv, /2026-07-27T13:12:30\.000Z|2026-07-27T06:12:30/,
    'and an absolute timestamp, so notes can be aligned to an external recording');
  assert.ok(notesCsv.trim().split('\n').length === 3, 'one header plus one row per note');

  /* THE SKEW TEST. metrics.csv `t` and notes.csv `offsetSec` must share an origin.
   *
   * They did not: `t` counted from the first successful FFT and `offsetSec` from
   * the first raw sample, which arrives earlier. Notes were therefore offset from
   * the signal by an unmeasured amount, which would have quietly corrupted every
   * attempt to line a note up against what the brain was doing — the entire point
   * of taking notes. Checked here at the export boundary, where the two columns
   * meet, using one event stamped once.
   */
  {
    const t0 = new Date('2026-07-27T06:00:00').getTime();
    const at = t0 + 123456;                       // 123.456s into the sit
    const { files: f } = Exporter.buildFiles({
      meta: { startedAt: t0, durationSec: 300, bytes: 1, ended: true },
      eeg: [[], [], [], []], acc: [], rr: [],
      rows: [{ t: (at - t0) / 1000, epochMs: at, calm: 0.5 }],
      notes: [{ id: 9, kind: 'text', at, offsetSec: (at - t0) / 1000, text: 'now' }],
    }, {});
    const metricsRow = Buffer.from(f.find((x) => x.name === 'metrics.csv').bytes)
      .toString('utf8').trim().split('\n')[1].split(',');
    const noteRow = Buffer.from(f.find((x) => x.name === 'notes.csv').bytes)
      .toString('utf8').trim().split('\n')[1].split(',');
    const metricsCols = Buffer.from(f.find((x) => x.name === 'metrics.csv').bytes)
      .toString('utf8').split('\n')[0].split(',');
    const mT = parseFloat(metricsRow[metricsCols.indexOf('t')]);
    const mEpoch = parseFloat(metricsRow[metricsCols.indexOf('epochMs')]);
    const nOffset = parseFloat(noteRow[0]);
    const nEpoch = parseFloat(noteRow[2]);
    assert.ok(Math.abs(mT - nOffset) < 0.01,
      `a note and a metrics row at the SAME instant must land at the same offset (${mT} vs ${nOffset})`);
    assert.strictEqual(mEpoch, nEpoch,
      'and carry the same absolute epoch, so alignment never depends on a shared origin');
    assert.strictEqual(mEpoch, at, 'absolute time must be the real wall clock, not a derived guess');
  }

  // A general note (one about the whole sit rather than a moment) must NOT be
  // placed at 0. Writing 0 would put it at the start of the sit, which is a claim.
  {
    const { files: f } = Exporter.buildFiles({
      meta: { startedAt: Date.now(), durationSec: 60, bytes: 1, ended: true },
      eeg: [[], [], [], []], acc: [], rr: [], rows: [],
      notes: [{ id: 1, kind: 'text', at: Date.now(), offsetSec: 12, anchored: false, text: 'quiet day' }],
    }, {});
    const csv = Buffer.from(f.find((x) => x.name === 'notes.csv').bytes).toString('utf8');
    const row = csv.trim().split('\n')[1].split(',');
    assert.strictEqual(row[0], '', 'a general note must have a BLANK offset, not 0');
    assert.strictEqual(row[4], 'no', 'and be marked as not anchored to a moment');
    const md = Buffer.from(f.find((x) => x.name === 'session.md').bytes).toString('utf8');
    assert.match(md, /## About this sit[\s\S]*quiet day/,
      'a general note reads as preamble, not as something that happened at minute 0');
  }

  // Time columns on the other streams, in the same units as everything else.
  {
    const { files: f } = Exporter.buildFiles({
      meta: { startedAt: Date.now(), durationSec: 10, bytes: 1, ended: true, accHz: 50 },
      eeg: [[], [], [], []],
      acc: [[1000, 0, 0], [1001, 0, 0], [1002, 0, 0]],
      rr: [800, 900], rows: [], notes: [],
    }, {});
    const accCsv = Buffer.from(f.find((x) => x.name === 'acc.csv').bytes).toString('utf8');
    assert.strictEqual(accCsv, 'tSec,x,y,z\n0.000,1000,0,0\n0.020,1001,0,0\n0.040,1002,0,0\n',
      'accelerometer rows must carry a time in seconds at the declared rate');
    const rrCsv = Buffer.from(f.find((x) => x.name === 'rr.csv').bytes).toString('utf8');
    assert.strictEqual(rrCsv, 'tSec,rrMs\n0.800,800\n1.700,900\n',
      'RR time is cumulative, because each interval IS a duration');
  }

  // Raw EEG must be binary, not text: 40 minutes at 256Hz is 2.4M samples, past
  // Excel's row limit and a 60MB text file.
  const ch0 = files.find((f) => f.name === 'eeg-ch0.f32');
  assert.strictEqual(ch0.bytes.length, 8, '2 floats is 8 bytes, not a CSV of digits');
  assert.deepStrictEqual(Array.from(new Float32Array(ch0.bytes.buffer, ch0.bytes.byteOffset, 2)), [1, 2]);

  // A missing audio blob must not produce a broken archive entry, and the markdown
  // must say the audio is missing rather than pointing at a file that is not there.
  const { files: noAudio } = Exporter.buildFiles(session, {});
  assert.ok(!noAudio.some((f) => f.name.startsWith('notes/')),
    'a note whose audio failed to load must not create an empty file');
  const md2 = Buffer.from(noAudio.find((f) => f.name === 'session.md').bytes).toString('utf8');
  assert.match(md2, /voice-07m30s-1\.m4a/, 'the name is still recorded so it can be matched up later');

  assert.match(Exporter.archiveName(session.meta), /^meditation-2026-07-27-0605\.zip$/,
    'the archive name must carry the LOCAL date and time, so a 6am sit is not filed under yesterday');
  console.log('✓ a session exports to markdown + CSVs + raw binary + audio, correctly named');
}

// 4b) THE LABELS. These are the ground truth the whole project needs, so the export
//     must carry them per-dimension and must not invent the ones that were not given.
{
  const Labels = require('./public/labels.js');
  const t0 = new Date('2026-07-28T06:00:00').getTime();
  const { files } = Exporter.buildFiles({
    meta: { startedAt: t0, durationSec: 1200, bytes: 1e6, ended: true },
    eeg: [[], [], [], []], acc: [], rr: [], rows: [],
    notes: [
      // Focused with no effort: the state a single score cannot tell from the next one.
      { id: 1, kind: 'text', at: t0 + 600000, offsetSec: 600,
        dims: { focus: 5, effort: 1, pull: 1 }, text: 'it opened' },
      // Focused by force. Same focus rating, different experience.
      { id: 2, kind: 'text', at: t0 + 900000, offsetSec: 900,
        dims: { focus: 5, effort: 5 }, text: 'holding on hard' },
      // A partial report, and an invalid value that must not survive.
      { id: 3, kind: 'text', at: t0 + 1000000, offsetSec: 1000, dims: { tone: 4, focus: 99 } },
      // A one-key transition, no dimensions at all.
      { id: 4, kind: 'transition', at: t0 + 300000, offsetSec: 300, transition: 'returned' },
    ],
  }, {});
  const csv = Buffer.from(files.find((f) => f.name === 'notes.csv').bytes).toString('utf8');
  const lines = csv.trim().split('\n');
  const cols = lines[0].split(',');
  const col = (row, name) => row.split(',')[cols.indexOf(name)];
  const rows = lines.slice(1);

  const absorbed = rows.find((r) => col(r, 'text') === 'it opened');
  const concentrating = rows.find((r) => col(r, 'text') === 'holding on hard');
  assert.strictEqual(col(absorbed, 'focus'), '5');
  assert.strictEqual(col(absorbed, 'effort'), '1');
  assert.strictEqual(col(absorbed, 'quadrant'), 'absorbed');
  assert.strictEqual(col(concentrating, 'focus'), '5');
  assert.strictEqual(col(concentrating, 'quadrant'), 'concentrating');
  // THE POINT: identical focus, different state. If these two ever collapse to the
  // same label the export has stopped carrying the distinction worth testing.
  assert.notStrictEqual(col(absorbed, 'quadrant'), col(concentrating, 'quadrant'));

  const partial = rows.find((r) => col(r, 'tone') === '4');
  assert.strictEqual(col(partial, 'focus'), '',
    'an out-of-range rating must export as blank, never coerced to a number');
  assert.strictEqual(col(partial, 'quadrant'), '',
    'and no quadrant without both of its axes');
  assert.strictEqual(col(partial, 'effort'), '', 'an unreported dimension stays blank');

  const trans = rows.find((r) => col(r, 'transition') === 'returned');
  assert.ok(trans, 'a one-key transition must appear in notes.csv');
  assert.strictEqual(col(trans, 'focus'), '', 'a transition carries no ratings');

  // The markdown must name the transition in words, since that is the readable file.
  const md = Buffer.from(files.find((f) => f.name === 'session.md').bytes).toString('utf8');
  assert.match(md, new RegExp(Labels.TRANSITION_BY_KEY.returned.label),
    'the markdown must say "Came back", not "returned"');
  console.log('✓ labels export per-dimension, with the quadrant, and blanks stay blank');
}

// 5) An interrupted session must SAY it was interrupted. Silently exporting a
//    truncated sit as though it were complete is the kind of quiet dishonesty
//    this project keeps having to remove.
{
  const md = Exporter.toMarkdown({
    meta: { startedAt: Date.now(), durationSec: 300, bytes: 1e6, ended: false },
    rows: [], notes: [],
  });
  assert.match(md, /interrupted/i, 'an unclean session must be labelled as such');
  const clean = Exporter.toMarkdown({
    meta: { startedAt: Date.now(), durationSec: 300, bytes: 1e6, ended: true },
    rows: [], notes: [],
  });
  assert.ok(!/interrupted/i.test(clean), 'and a clean one must not be');
  console.log('✓ an interrupted session is labelled, not passed off as complete');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll export tests passed.');
