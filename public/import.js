/*
 * Reading a session archive back in.
 *
 * The counterpart to export.js, and deliberately a separate file: a reader that
 * shares code with the writer shares its misunderstandings, and would agree with a
 * malformed archive rather than reject it. The zip test in test-export.js validates
 * the writer against the system `unzip`; this reader is validated against archives
 * produced by the system `zip`, so neither is checked only against its own twin.
 *
 * Entries are located from the CENTRAL DIRECTORY, not by scanning for local file
 * headers. Scanning is what tolerant readers do, and a tolerant reader will happily
 * find a "file" inside a run of EEG floats that happens to contain 50 4B 03 04.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Importer = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  /*
   * Find the end-of-central-directory record.
   *
   * Searched BACKWARDS from the end, because the EOCD is last and a forward scan
   * could match its signature inside file data. Bounded by the maximum comment
   * length (65535) plus the record itself, which is as far as it can legally be.
   */
  function findEocd(view) {
    const min = Math.max(0, view.byteLength - (22 + 0xffff));
    for (let i = view.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    // Browsers: DecompressionStream. Node: zlib. Neither is required for archives
    // this app writes (it uses STORE), but a zip made by any other tool will be
    // deflated, and silently failing on those would be a poor surprise.
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (typeof module !== 'undefined' && module.exports) {
      const zlib = require('zlib');
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
    }
    throw new Error('this archive is compressed and nothing here can decompress it');
  }

  /*
   * Parse an archive into { name -> Uint8Array }.
   *
   * Throws with a readable message rather than returning something partial: half an
   * imported session would be analysed as though it were whole.
   */
  async function unzip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 22) throw new Error('not a zip archive (too short)');
    const eocd = findEocd(view);
    if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error(`corrupt central directory at entry ${n + 1} of ${count}`);
      }
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOff = view.getUint32(p + 42, true);
      const name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));

      if (view.getUint32(localOff, true) !== SIG_LOCAL) {
        throw new Error(`entry "${name}" points at no local header`);
      }
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataAt = localOff + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataAt, dataAt + compSize);

      if (method === 0) files[name] = raw;
      else if (method === 8) files[name] = await inflateRaw(raw);
      else throw new Error(`entry "${name}" uses unsupported compression method ${method}`);

      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /*
   * CSV back to rows of objects, with numeric-looking cells converted.
   *
   * EMPTY STAYS NULL, never 0. A blank cell in these exports means "not reported" —
   * an unreported dimension, an unanchored note, a metric with no inputs — and
   * turning those into zeroes would put fabricated observations into the analysis,
   * which is the single worst thing that can happen to this dataset.
   */
  function parseCsv(text) {
    const rows = [];
    let field = '';
    let row = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows[0];
    return rows.slice(1)
      .filter((r) => r.some((c) => c !== ''))
      .map((r) => {
        const o = {};
        header.forEach((h, i) => {
          const v = r[i];
          if (v === undefined || v === '') { o[h] = null; return; }
          // Only convert what is unambiguously a number. "00m12s" and "2026-07-28"
          // must stay strings.
          const num = Number(v);
          o[h] = (Number.isFinite(num) && /^-?\d*\.?\d+(e-?\d+)?$/i.test(v.trim())) ? num : v;
        });
        return o;
      });
  }

  function f32(bytes) {
    if (!bytes || !bytes.byteLength) return new Float32Array(0);
    if (bytes.byteLength % 4 !== 0) {
      throw new Error(`a .f32 file must be a whole number of floats (got ${bytes.byteLength} bytes)`);
    }
    // Copy rather than aliasing: the subarray from unzip() is a view into the whole
    // archive and may not be 4-byte aligned, which Float32Array will refuse.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
  }

  /*
   * A whole session, from one archive.
   *
   * Reports what it FOUND rather than assuming a shape: an archive missing its raw
   * EEG is still analysable for its labels, and one with no labels is still worth
   * plotting. `warnings` carries anything absent, so the lab can say so instead of
   * quietly analysing less than the user thinks.
   */
  async function readSessionArchive(buffer) {
    const files = await unzip(buffer);
    const text = (name) => (files[name] ? decodeUtf8(files[name]) : null);
    const warnings = [];

    /*
     * SIMULATED ARCHIVES ARE IDENTIFIED HERE, BEFORE ANY OF THEM IS READ AS A MEASUREMENT.
     *
     * The app can generate a complete, well-formed sit from a scripted waveform (`?sim=1`, see
     * simdevice.js). Those rows have the same columns, the same sample rate and the same plausible
     * ranges as real ones, so once one is pooled with real sits nothing in the data can separate it
     * again — every comparison built on the pool is quietly contaminated and stays that way.
     *
     * So this is detected at the door and surfaced as a first-class field rather than a warning that
     * a caller might not print. The marker is a FILE, which survives renaming; the filename prefix
     * does not reach here at all, because a browser file input gives whatever the file is called now.
     */
    const simulated = !!files['SIMULATED.txt'];
    if (simulated) {
      warnings.push('SIMULATED DATA — this archive was produced by the signal simulator with no'
        + ' headband connected. It is not a recording of anyone and must not be pooled with real'
        + ' sits.');
    }

    const metricsText = text('metrics.csv');
    const notesText = text('notes.csv');
    if (!metricsText) warnings.push('no metrics.csv — the per-second scores are missing');
    if (!notesText) warnings.push('no notes.csv — this session carries no labels');

    const eeg = [];
    for (let ch = 0; ch < 4; ch++) {
      const b = files[`eeg-ch${ch}.f32`];
      eeg.push(b ? f32(b) : new Float32Array(0));
    }
    if (eeg.every((c) => !c.length)) {
      warnings.push('no raw EEG — features cannot be recomputed, only the stored scores read');
    }

    const accText = text('acc.csv');
    /* Head motion, kept under its own name. It answers a different question from acc.csv — stillness
       rather than breathing — and a lab that merged them could not separate them again. */
    const headAccText = text('head-acc.csv');
    const headRawText = text('head-acc-raw.csv');
    const rrText = text('rr.csv');
    const readme = text('README.txt') || '';
    // The sample rate is written into the README rather than the data, so read it
    // from there instead of assuming 256 — a wrong rate silently rescales every
    // frequency in the analysis.
    const hzMatch = readme.match(/at\s+(\d+)\s*Hz/i);
    const eegHz = hzMatch ? Number(hzMatch[1]) : null;
    if (!eegHz) warnings.push('sample rate not stated in README.txt — assuming 256Hz');

    const audio = {};
    for (const name of Object.keys(files)) {
      if (name.startsWith('notes/')) audio[name] = files[name];
    }

    return {
      files: Object.keys(files).sort(),
      simulated,
      markdown: text('session.md'),
      metrics: metricsText ? parseCsv(metricsText) : [],
      notes: notesText ? parseCsv(notesText) : [],
      acc: accText ? parseCsv(accText) : [],
      headAcc: headAccText ? parseCsv(headAccText) : [],
      // Present or not, reported either way: a sit recorded before the headband's accelerometer was
      // subscribed at all has none, and that is a fact about the recording rather than a gap to fill.
      headAccRaw: headRawText ? parseCsv(headRawText) : [],
      rr: rrText ? parseCsv(rrText) : [],
      eeg,
      eegHz: eegHz || 256,
      audio,
      warnings,
    };
  }

  return { unzip, parseCsv, f32, readSessionArchive, findEocd };
});
