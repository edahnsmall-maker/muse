/*
 * Getting a session off the machine, as one file.
 *
 * WHY A ZIP, hand-rolled. A session is a markdown summary, a CSV of derived
 * metrics, four channels of raw EEG and one audio file per voice note — a dozen
 * files or more. Downloading them individually means a dozen clicks and a dozen
 * chances to lose one, which is a poor thing to do to somebody at the end of a
 * sit. So: a single archive, written with the STORE method (no compression), which
 * is about seventy lines and no dependency. EEG floats and already-compressed
 * audio would barely deflate anyway.
 *
 * WHAT GOES WHERE, and why it is split at all:
 *
 *   session.md      human-readable. Date, duration, markers and voice notes with
 *                   timestamps. The thing to actually read.
 *   metrics.csv     the 1Hz derived rows — opens directly in Excel.
 *   notes.csv       one row per note, with an EMPTY transcript column. Voice notes
 *                   are deliberately not transcribed on-device: a transcript would
 *                   be a guess about what was said, and transcription is not
 *                   time-critical, so it happens later with a real tool. This file
 *                   is the seam for that.
 *   eeg-ch*.f32     raw EEG, little-endian Float32. NOT CSV: 256Hz x 4 channels
 *                   over 40 minutes is 2.4M samples per channel, past Excel's
 *                   ~1,048,576 row limit, and a 60MB text file besides.
 *   acc.csv, rr.csv small enough to be text, useful enough to be readable.
 *   notes/*.webm    the audio itself.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Exporter = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // CRC-32, table built once. Required by the zip format for every entry; an
  // archive with wrong CRCs opens in some tools and is rejected by others, which
  // is a worse failure than not opening at all.
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }

  function crc32(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return Uint8Array.from(Buffer.from(str, 'utf8'));
  }

  // DOS date/time, which is what the zip header wants. Two-second resolution, and
  // years count from 1980 — a format old enough to have opinions.
  function dosDateTime(date) {
    const d = date || new Date(0);
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const dt = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, dt };
  }

  /*
   * Build a zip from [{ name, bytes }].
   *
   * Uncompressed STORE entries, one local header each, then a central directory,
   * then the end-of-central-directory record. Everything little-endian.
   */
  function zip(files, { date = null } = {}) {
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, dt } = dosDateTime(date);

    for (const f of files) {
      const nameBytes = utf8(f.name);
      const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const sum = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // local file header signature
      local.setUint16(4, 20, true);           // version needed
      local.setUint16(6, 0x0800, true);       // flags: UTF-8 names
      local.setUint16(8, 0, true);            // method 0 = store
      local.setUint16(10, time, true);
      local.setUint16(12, dt, true);
      local.setUint32(14, sum, true);
      local.setUint32(18, data.length, true); // compressed size
      local.setUint32(22, data.length, true); // uncompressed size
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);           // extra field length
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);     // central directory signature
      cen.setUint16(4, 20, true);             // version made by
      cen.setUint16(6, 20, true);             // version needed
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, dt, true);
      cen.setUint32(16, sum, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint16(30, 0, true);             // extra
      cen.setUint16(32, 0, true);             // comment
      cen.setUint16(34, 0, true);             // disk number
      cen.setUint16(36, 0, true);             // internal attrs
      cen.setUint32(38, 0, true);             // external attrs
      cen.setUint32(42, offset, true);        // offset of local header
      central.push(new Uint8Array(cen.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);       // end of central directory
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);

    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const total = all.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const chunk of all) { out.set(chunk, p); p += chunk.length; }
    return out;
  }

  // CSV with the columns fixed up front, so a row missing a key produces an empty
  // cell rather than shifting every subsequent column.
  function toCsv(rows, columns) {
    const cols = columns || Array.from(rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()));
    const cell = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) return `"${v.join(' ')}"`;
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
    return lines.join('\n') + '\n';
  }

  const two = (n) => String(Math.floor(n)).padStart(2, '0');
  function clock(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    return `${two(sec / 60)}:${two(sec % 60)}`;
  }

  // A filename that sorts chronologically and says what it is. Local date, not
  // ISO-UTC: a sit at 6am should not be filed under the previous day.
  function stamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
      + `-${two(d.getHours())}${two(d.getMinutes())}`;
  }

  /*
   * The human-readable half. Voice notes are listed with their timestamp, their
   * length and their filename, so the audio can be found without hunting — and
   * with the transcript line left blank rather than filled with a guess.
   */
  function toMarkdown({ meta, rows = [], notes = [], noteFiles = {} }) {
    const started = new Date(meta.startedAt);
    const L = [];
    L.push(`# Session ${stamp(started)}`);
    L.push('');
    L.push(`- **Started** ${started.toLocaleString()}`);
    L.push(`- **Duration** ${clock(meta.durationSec)} (${Math.round(meta.durationSec || 0)}s)`);
    L.push(`- **Recorded** ${(((meta.bytes || 0) / 1e6)).toFixed(1)} MB`);
    if (!meta.ended) {
      L.push('- **Note** this session was interrupted rather than ended cleanly, so it'
        + ' stops at the last flush (at most a few seconds short).');
    }
    L.push('');

    // General notes first: they describe the whole sit, so they read as preamble
    // rather than as something that happened at minute 23.
    const general = notes.filter((n) => n.anchored === false);
    const timed = notes.filter((n) => n.anchored !== false);
    if (general.length) {
      L.push('## About this sit');
      L.push('');
      for (const n of general) {
        if (n.text) L.push(n.text.split('\n').map((line) => `> ${line}`).join('\n'));
        L.push('');
      }
    }
    if (timed.length) {
      L.push('## Notes');
      L.push('');
      for (const n of timed) {
        const at = new Date(n.at);
        const when = `${clock(n.offsetSec)} (${at.toLocaleTimeString()})`;
        if (n.kind === 'voice') {
          const file = noteFiles[n.id] || '(audio missing)';
          L.push(`### ${when} — voice, ${(n.seconds || 0).toFixed(0)}s`);
          L.push('');
          L.push(`- Audio: \`${file}\``);
          // Left EMPTY on purpose. Transcription happens later with a real tool;
          // anything written here by the app would be a guess about what was said.
          L.push('- Transcript: ');
        } else if (n.kind === 'transition') {
          const lib = labelsLib();
          const t = lib && lib.TRANSITION_BY_KEY[n.transition];
          // Words, not the key: "Came back" is what a person reads six months later.
          L.push(`### ${when} — ${t ? t.label : n.transition || 'transition'}`);
          L.push('');
          if (t) L.push(`_${t.hint}_`);
          L.push('');
        } else {
          const label = n.kind === 'text' ? 'note' : (n.markKind || 'mark');
          L.push(`### ${n.anchored === false ? at.toLocaleTimeString() : when} — ${label}`);
          L.push('');
          if (n.text) L.push(n.text.split('\n').map((line) => `> ${line}`).join('\n'));
          else L.push('_(no text)_');
        }
        L.push('');
      }
    } else if (!general.length) {
      L.push('## Notes');
      L.push('');
      L.push('_none_');
      L.push('');
    }

    // What the app believed, so a later change to any formula can be checked
    // against what was actually on screen at the time.
    const withCalm = rows.filter((r) => typeof r.calm === 'number');
    if (withCalm.length) {
      const vals = withCalm.map((r) => r.calm);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      L.push('## What the app showed at the time');
      L.push('');
      L.push(`- Calm: mean ${(mean * 100).toFixed(0)}, range ${(Math.min(...vals) * 100).toFixed(0)}–${(Math.max(...vals) * 100).toFixed(0)}`);
      L.push(`- ${rows.length} rows of derived metrics in \`metrics.csv\``);
      L.push('');
      L.push('These are recorded because a score cannot be audited later if its output'
        + ' was never kept. Raw EEG is in the `eeg-ch*.f32` files, so every metric here'
        + ' can also be recomputed from scratch with whatever formula comes next.');
      L.push('');
    }

    L.push('## Files');
    L.push('');
    L.push('| File | What |');
    L.push('|---|---|');
    L.push('| `metrics.csv` | 1 row/second of derived scores — opens in Excel |');
    L.push('| `notes.csv` | one row per note, with an empty `transcript` column to fill in |');
    L.push('| `eeg-ch0..3.f32` | raw EEG, little-endian Float32, 256Hz. Too many rows for Excel — read with numpy/node |');
    L.push('| `acc.csv` | accelerometer, mG, 50Hz |');
    L.push('| `rr.csv` | beat-to-beat intervals, ms |');
    if (notes.some((n) => n.kind === 'voice')) L.push('| `notes/*` | voice note audio |');
    L.push('');
    return L.join('\n');
  }

  /*
   * Labels is optional here on purpose. export.js is also loaded by test-export.js in
   * node, where there is no page and no globals — and an export that throws because a
   * schema file is absent would lose a session rather than lose a column.
   */
  function labelsLib() {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./labels.js'); } catch (e) { return null; }
    }
    return (typeof globalThis !== 'undefined' && globalThis.Labels) || null;
  }
  function dimOf(note, key) {
    const L = labelsLib();
    const dims = note && note.dims;
    if (!dims) return '';
    const v = dims[key];
    if (L) return L.validRating(v) ? v : '';
    return Number.isInteger(v) && v >= 1 && v <= 5 ? v : '';
  }
  function quadrantOf(note) {
    const L = labelsLib();
    if (!L || !note || !note.dims) return '';
    return L.quadrant(note.dims) || '';
  }

  function f32Bytes(values) {
    const arr = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) arr[i] = values[i];
    return new Uint8Array(arr.buffer);
  }

  // Extension from the recorded MIME type. Browsers disagree about what they
  // produce, so guessing one and hardcoding it would mislabel the other's files.
  function audioExt(mime) {
    if (!mime) return 'webm';
    if (/mp4|m4a|aac/i.test(mime)) return 'm4a';
    if (/ogg/i.test(mime)) return 'ogg';
    if (/wav/i.test(mime)) return 'wav';
    return 'webm';
  }

  /*
   * Assemble the file list for one loaded session. Pure — takes the plain object
   * that Recorder.loadSession returns plus already-read audio bytes, and returns
   * [{name, bytes}] ready for zip(). Kept separate from the DOM so the layout of
   * an export is testable without a browser.
   */
  function buildFiles(session, audioBytesById = {}) {
    const { meta, eeg = [[], [], [], []], acc = [], rr = [], rows = [], notes = [] } = session;
    const files = [];
    const noteFiles = {};

    for (const n of notes) {
      if (n.kind !== 'voice') continue;
      const name = `notes/voice-${two((n.offsetSec || 0) / 60)}m${two((n.offsetSec || 0) % 60)}s-${n.id}.${audioExt(n.mimeType)}`;
      noteFiles[n.id] = name;
      const bytes = audioBytesById[n.id];
      if (bytes) files.push({ name, bytes });
    }

    files.push({ name: 'session.md', bytes: utf8(toMarkdown({ meta, rows, notes, noteFiles })) });
    files.push({ name: 'metrics.csv', bytes: utf8(toCsv(rows)) });
    files.push({
      name: 'notes.csv',
      bytes: utf8(toCsv(notes.map((n) => ({
        // Blank rather than 0 for a general note: a note about the whole sit has no
        // moment, and writing 0 would place it at the start, which is a claim.
        offsetSec: n.anchored === false ? '' : (n.offsetSec || 0).toFixed(2),
        clock: n.anchored === false ? '' : clock(n.offsetSec),
        // The cross-check. epochMs is on every metrics row too, so alignment never
        // depends on two files agreeing about where zero is.
        epochMs: n.at,
        absoluteTime: new Date(n.at).toISOString(),
        anchored: n.anchored === false ? 'no' : 'yes',
        kind: n.kind,
        markKind: n.markKind || '',
        seconds: n.seconds == null ? '' : n.seconds.toFixed(1),
        audioFile: noteFiles[n.id] || '',
        transition: n.transition || '',
        // Trial bookkeeping. Without these the block structure — and therefore the
        // label for every trial observation — cannot be reconstructed at all.
        trialKey: n.trialKey || '',
        condition: n.condition || '',
        blockIndex: n.blockIndex == null ? '' : n.blockIndex,
        // The self-reported dimensions, one column each, blank when not reported.
        // Blank rather than a midpoint: "not reported" is a real and different value.
        focus: dimOf(n, 'focus'), effort: dimOf(n, 'effort'),
        pull: dimOf(n, 'pull'), tone: dimOf(n, 'tone'),
        // Derived from focus x effort, and only when both were given. This is the
        // column that separates "focused because I was holding it" from "focused
        // because nothing needed holding" — the distinction a single score cannot
        // make, and the first real hypothesis this data can test.
        quadrant: quadrantOf(n),
        text: n.text || '',
        transcript: '',
      })), ['offsetSec', 'clock', 'epochMs', 'absoluteTime', 'anchored', 'kind',
        'markKind', 'transition', 'trialKey', 'condition', 'blockIndex',
        'focus', 'effort', 'pull', 'tone', 'quadrant',
        'seconds', 'audioFile', 'text', 'transcript'])),
    });
    for (let ch = 0; ch < 4; ch++) {
      if (eeg[ch] && eeg[ch].length) files.push({ name: `eeg-ch${ch}.f32`, bytes: f32Bytes(eeg[ch]) });
    }
    /* Every stream gets a time column, in the SAME units as metrics.csv's `t` and
     * notes.csv's `offsetSec` — seconds from the session clock. Without one, lining
     * a note up against chest motion means reconstructing the sample rate by hand
     * and hoping no samples were dropped.
     *
     * Accelerometer time is derived from the index and the rate, so it is nominal:
     * a dropped BLE notification shifts everything after it. RR time is cumulative,
     * which is exact, because each interval IS a duration.
     */
    if (acc.length) {
      const hz = meta.accHz || 50;
      const lines = ['tSec,x,y,z'];
      for (let i = 0; i < acc.length; i++) lines.push(`${(i / hz).toFixed(3)},${acc[i].join(',')}`);
      files.push({ name: 'acc.csv', bytes: utf8(lines.join('\n') + '\n') });
    }
    if (rr.length) {
      const lines = ['tSec,rrMs'];
      let t = 0;
      for (const ms of rr) { t += ms / 1000; lines.push(`${t.toFixed(3)},${ms}`); }
      files.push({ name: 'rr.csv', bytes: utf8(lines.join('\n') + '\n') });
    }

    // A README so the archive explains itself in a year's time, when nobody
    // remembers what a .f32 file is or what sample rate it was written at.
    files.push({
      name: 'README.txt',
      bytes: utf8([
        'Meditation session export.',
        '',
        `Started: ${new Date(meta.startedAt).toISOString()} (${new Date(meta.startedAt).toLocaleString()})`,
        `Duration: ${Math.round(meta.durationSec || 0)}s`,
        '',
        'eeg-ch0..3.f32 are raw little-endian Float32 samples at '
          + `${meta.eegHz || 256}Hz, in microvolts, one file per electrode`,
        '(order: TP9, AF7, AF8, TP10). No header — length is filesize/4.',
        '',
        '  numpy:  np.fromfile("eeg-ch1.f32", dtype="<f4")',
        '  node:   new Float32Array(fs.readFileSync("eeg-ch1.f32").buffer)',
        '',
        `acc.csv is accelerometer in mG at ${meta.accHz || 50}Hz.`,
        'rr.csv is beat-to-beat intervals in milliseconds.',
        'metrics.csv is one row per second of whatever the app computed at the time.',
        'notes.csv has one row per note; the transcript column is intentionally empty.',
        '',
        'Voice notes are NOT transcribed. The recording is what was said; a',
        'transcript generated on-device would be a guess about it.',
      ].join('\n')),
    });
    return { files, noteFiles };
  }

  function archiveName(meta) {
    return `meditation-${stamp(new Date(meta.startedAt))}.zip`;
  }

  return { zip, crc32, toCsv, toMarkdown, buildFiles, archiveName, stamp, clock, audioExt };
});
