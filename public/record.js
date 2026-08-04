/*
 * Durable session recording.
 *
 * WHY THIS EXISTS. Until this file, nothing was saved. `sessionLog` was an
 * in-memory array, raw EEG was a 2-second rolling buffer, and a page reload — or
 * a phone locking its screen — destroyed the entire sit. That is fine for an
 * afternoon of development and unacceptable for a retreat, where the interesting
 * moment happens once and is not repeatable.
 *
 * TWO DESIGN COMMITMENTS, both learned the hard way elsewhere in this project:
 *
 * 1. SAVE THE RAW SIGNAL, not just the derived scores. Every composite in
 *    metrics.js is going to change — that is what the validation work is for — and
 *    a session stored as "calm: 0.62" is worthless the moment the calm formula
 *    moves. Raw EEG at 256Hz is about 10MB for a 40-minute sit, which is nothing,
 *    and everything else can be recomputed from it forever.
 *
 * 2. FLUSH AS YOU GO. Anything held in memory until the end of the session is
 *    lost by whatever ends the session unexpectedly, which on a phone is the
 *    common case rather than the exception. Chunks are committed every few
 *    seconds, so a crash costs seconds rather than the sit.
 *
 * Storage is IndexedDB, not localStorage: localStorage caps out around 5MB, is
 * synchronous (so writing to it stutters the render loop), and cannot hold a
 * typed array or a Blob without base64-inflating it by a third. IndexedDB
 * structured-clones Float32Array and Blob natively, at their real size.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Recorder = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const DB_NAME = 'zenbio';
  const DB_VERSION = 1;
  // Object stores. `chunks` is the bulk of it, keyed [sessionId, seq] so a whole
  // session reads back in order with one cursor and no sorting.
  const STORE_SESSIONS = 'sessions';
  const STORE_CHUNKS = 'chunks';
  const STORE_NOTES = 'notes';

  // How often buffered samples are committed. 4s is the trade: shorter means more
  // transactions competing with the render loop, longer means more lost on a
  // crash. At 256Hz x 4 channels a 4s chunk is 16KB, which is a comfortable size
  // for a single structured clone.
  const FLUSH_MS = 4000;

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function open({ name = DB_NAME, indexedDB = null } = {}) {
    const idb = indexedDB || (typeof globalThis !== 'undefined' ? globalThis.indexedDB : null);
    if (!idb) return Promise.reject(new Error('IndexedDB is not available'));
    return new Promise((resolve, reject) => {
      const req = idb.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          db.createObjectStore(STORE_CHUNKS, { keyPath: ['sessionId', 'seq'] });
        }
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          // Voice notes and text notes both live here, keyed by their own id, with
          // an index on session so a sit's labels read back together.
          const s = db.createObjectStore(STORE_NOTES, { keyPath: 'id', autoIncrement: true });
          s.createIndex('bySession', 'sessionId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open the database'));
    });
  }

  /*
   * A recording in progress.
   *
   * `startedAt` is an ABSOLUTE wall-clock time, and every sample offset is
   * relative to it. That combination is what lets a voice note recorded on a phone
   * be aligned afterwards against a CSV recorded by a different app on the same
   * phone — the fallback path for iOS, where Web Bluetooth may not be available at
   * all. Storing only relative time would make that alignment impossible.
   */
  function Session(db, id, meta) {
    let seq = 0;
    let ended = false;
    // Pending samples per stream, flushed together so one timer serves all of them.
    /* headAcc is the HEADBAND's motion, kept separate from acc (the chest strap's). They measure
       different things — head stillness versus breathing — and merging them would be irreversible.
       headRaw is the undecoded bytes, kept because the Muse IMU scale factor is unverified and a
       wrong decode stored alone could never be corrected. */
    const pending = { eeg: [[], [], [], []], acc: [], rr: [], row: [], headAcc: [], headRaw: [] };
    let bytesWritten = 0;
    let lastFlushAt = meta.startedAt;
    let flushError = null;

    function offsetSec(at) { return (at - meta.startedAt) / 1000; }

    /*
     * Commit whatever has accumulated.
     *
     * EEG is stored as Float32Array rather than a plain array: it is a quarter the
     * memory, it structured-clones without conversion, and it is the layout any
     * later analysis wants. The other streams are small and stay as objects, where
     * being self-describing is worth more than the bytes.
     */
    async function flush() {
      if (ended) return 0;
      const chunks = [];
      const at = Date.now();
      for (let ch = 0; ch < 4; ch++) {
        if (!pending.eeg[ch].length) continue;
        chunks.push({
          sessionId: id, seq: seq++, kind: 'eeg', channel: ch,
          t0: offsetSec(lastFlushAt), hz: meta.eegHz || 256,
          data: Float32Array.from(pending.eeg[ch]),
        });
        pending.eeg[ch] = [];
      }
      for (const kind of ['acc', 'rr', 'row', 'headAcc', 'headRaw']) {
        if (!pending[kind].length) continue;
        chunks.push({
          sessionId: id, seq: seq++, kind,
          t0: offsetSec(lastFlushAt), data: pending[kind].slice(),
        });
        pending[kind] = [];
      }
      lastFlushAt = at;
      if (!chunks.length) return 0;
      try {
        const tx = db.transaction([STORE_CHUNKS, STORE_SESSIONS], 'readwrite');
        const store = tx.objectStore(STORE_CHUNKS);
        for (const c of chunks) {
          store.put(c);
          bytesWritten += c.data instanceof Float32Array
            ? c.data.byteLength : JSON.stringify(c.data).length;
        }
        // Keep the session row current on every flush, so a session interrupted by
        // a crash still reports an honest duration and size rather than looking
        // like it never started.
        tx.objectStore(STORE_SESSIONS).put(Object.assign({}, meta, {
          id, bytes: bytesWritten, durationSec: offsetSec(at), ended: false,
        }));
        await txDone(tx);
        flushError = null;
      } catch (err) {
        // A failed flush must NEVER take down the session. Losing four seconds of
        // recording is bad; losing the sit because the disk was briefly full is
        // worse. The error is remembered so the UI can say so.
        flushError = (err && err.message) || 'write failed';
        return 0;
      }
      return chunks.length;
    }

    const timer = setInterval(() => { flush(); }, FLUSH_MS);

    return {
      id,
      get meta() { return meta; },
      get bytes() { return bytesWritten; },
      get error() { return flushError; },
      // Raw EEG, per channel, exactly as it arrives from the headband.
      pushEeg(channel, samples) {
        if (ended || channel < 0 || channel > 3) return;
        const buf = pending.eeg[channel];
        for (let i = 0; i < samples.length; i++) buf.push(samples[i]);
      },
      pushAcc(samples) {
        if (ended) return;
        for (const s of samples) pending.acc.push([s.x, s.y, s.z]);
      },
      pushRr(values) {
        if (ended) return;
        for (const v of values) pending.rr.push(v);
      },
      /* The headband's own accelerometer, decoded, plus the bytes it came from.
         Both, on purpose: see the note on `pending`. The raw copy is about 6 bytes per sample at
         52Hz — roughly 19KB a minute, against the ~1MB a minute the EEG already costs, so
         preserving it is free in any terms that matter. */
      pushHeadAcc(samples, rawBytes) {
        if (ended) return;
        for (const s of samples) pending.headAcc.push([s.x, s.y, s.z]);
        if (rawBytes && rawBytes.length) pending.headRaw.push(Array.from(rawBytes));
      },
      // The 1Hz derived row. Kept even though it is recomputable, because it is
      // tiny and it records what the app BELIEVED at the time — which is the thing
      // to compare against when a formula later changes.
      pushRow(row) { if (!ended) pending.row.push(row); },
      flush,
      async addNote(note) {
        // Notes are written immediately rather than buffered. A label is the
        // scarcest thing in this whole system — there are a few dozen per retreat
        // against millions of samples — so it is never worth risking one to save a
        // transaction.
        const tx = db.transaction([STORE_NOTES], 'readwrite');
        const at = Date.now();
        // offsetSec is computed HERE, from meta.startedAt, which is the session
        // clock. Callers must not pass their own copy: two fields for one instant,
        // derived in two places, can only ever drift apart — which is exactly the
        // bug that put notes and metrics.csv on different origins.
        const rec = Object.assign({
          sessionId: id, at,
          // Same origin as every metrics row: meta.startedAt IS the session clock.
          // A note may deliberately have no offset (a general note about the whole
          // sit rather than a moment), which is why null is allowed through.
          offsetSec: offsetSec(at),
        }, note);
        const req = tx.objectStore(STORE_NOTES).add(rec);
        const key = await promisify(req);
        await txDone(tx);
        return key;
      },
      async end() {
        if (ended) return;
        await flush();
        ended = true;
        clearInterval(timer);
        const tx = db.transaction([STORE_SESSIONS], 'readwrite');
        tx.objectStore(STORE_SESSIONS).put(Object.assign({}, meta, {
          id, bytes: bytesWritten, durationSec: offsetSec(Date.now()), ended: true,
        }));
        await txDone(tx);
      },
    };
  }

  async function startSession(db, meta = {}) {
    const startedAt = meta.startedAt || Date.now();
    // A time-ordered id, so listing sessions needs no sort and two sessions
    // started in the same millisecond cannot collide.
    const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${Math.floor(startedAt % 1000)}`;
    const full = Object.assign({ startedAt, eegHz: 256, accHz: 50 }, meta, { startedAt });
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    tx.objectStore(STORE_SESSIONS).put(Object.assign({}, full, {
      id, bytes: 0, durationSec: 0, ended: false,
    }));
    await txDone(tx);
    return Session(db, id, full);
  }

  /*
   * Sessions newest first, each with a COUNT OF ITS MARKS.
   *
   * Asked for: "see how many markers are in the session (for analysis later). some will
   * be useless." Exactly right — a sit with no marks cannot contribute to any
   * event-locked analysis, and there is no way to tell from a date and a duration. The
   * count makes the useless ones visible at a glance instead of after exporting them.
   *
   * Counted from the notes rather than kept as a running total on the session, because a
   * total maintained in two places drifts, and this list is opened rarely enough that
   * reading the index costs nothing.
   */
  async function listSessions(db) {
    const tx = db.transaction([STORE_SESSIONS, STORE_NOTES], 'readonly');
    const all = await promisify(tx.objectStore(STORE_SESSIONS).getAll());
    const notes = await promisify(tx.objectStore(STORE_NOTES).getAll());
    const counts = new Map();
    const byKind = new Map();
    /*
     * THE GENERAL NOTE, carried in the listing.
     *
     * "since i've been leaving notes that describe my general state of mind, it would be
     * useful to see that to know what to add to the analysis." It is the best name a sit
     * has — written at the one moment the sit is still fresh — and it costs nothing to
     * include here, because this function already reads every note to count the marks.
     *
     * That it is free is the whole point. The lab used to get this by rebuilding each sit's
     * archive from its raw EEG and re-parsing it, which is ~1.2 seconds per sit of work to
     * recover a string that was two object stores away.
     *
     * The GENERAL one specifically: `anchored === false` means it describes the whole sit
     * rather than a moment in it, and a timed mark's text would name the sit after one
     * thing that happened inside it.
     */
    const general = new Map();
    for (const n of notes || []) {
      if (!n || n.sessionId == null) continue;
      if ((n.anchored === false || n.anchored === 'no') && n.text && String(n.text).trim()
          && !general.has(n.sessionId)) {
        general.set(n.sessionId, String(n.text).trim().replace(/\s+/g, ' '));
      }
      // What counts as a mark: anything that names a moment. Probe answers included —
      // they are labelled moments too — but not the closing whole-sit reflection, which
      // describes the sit rather than a point in it.
      const isMark = n.kind === 'transition' || n.kind === 'mark' || n.kind === 'probe'
        || n.kind === 'tap-grade' || n.transition || n.tapCategory || n.markKind;
      if (!isMark || n.anchored === false) continue;
      counts.set(n.sessionId, (counts.get(n.sessionId) || 0) + 1);
      /* A TALLY BY KIND, not just a total. Asked for: "maybe from the saved sessions i can see more
         detail (tally of marks)". A total of eleven does not say whether a sit is usable — eleven
         marks all of one kind cannot support any comparison between kinds, and that is exactly the
         analysis these marks exist for. The breakdown makes an unusable sit visible in the list
         instead of after an export.
         Keyed on whatever the note actually carries, in the order the app itself prefers: the tap
         category first (that is what the arrow keys write), then the transition, then the mark kind. */
      const kind = n.tapCategory || n.transition || n.markKind || n.kind || 'mark';
      if (!byKind.has(n.sessionId)) byKind.set(n.sessionId, new Map());
      const m = byKind.get(n.sessionId);
      m.set(kind, (m.get(kind) || 0) + 1);
    }
    return all
      .map((m) => Object.assign({}, m, {
        markCount: counts.get(m.id) || 0,
        // '' rather than null for a sit with no general note: it is a name that was not
        // written, not a reading that is missing, and every caller treats it as a string.
        generalNote: general.get(m.id) || '',
        // Plain array of [kind, count], commonest first, so the caller does no sorting and the
        // structure survives being cloned or serialised — a Map would not.
        markTally: Array.from((byKind.get(m.id) || new Map()).entries())
          .sort((x, y) => y[1] - x[1]),
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // A short memorable note on a sit, so a list of dates becomes a list of sits you
  // remember. Stored on the session's own record and carried into the export.
  async function labelSession(db, sessionId, label) {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const meta = await promisify(store.get(sessionId));
    if (!meta) return null;
    meta.label = String(label == null ? '' : label).slice(0, 120);
    await promisify(store.put(meta));
    return meta.label;
  }

  /*
   * Read a session back whole: chunks reassembled per stream, plus its notes.
   *
   * Chunks are concatenated in `seq` order rather than by their `t0`, because seq
   * is the order they were written and t0 is derived from a clock that can jump.
   */
  async function loadSession(db, sessionId) {
    const tx = db.transaction([STORE_CHUNKS, STORE_SESSIONS, STORE_NOTES], 'readonly');
    const meta = await promisify(tx.objectStore(STORE_SESSIONS).get(sessionId));
    if (!meta) return null;
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
    const chunks = await promisify(tx.objectStore(STORE_CHUNKS).getAll(range));
    const notes = await promisify(tx.objectStore(STORE_NOTES).index('bySession').getAll(sessionId));
    chunks.sort((a, b) => a.seq - b.seq);

    const eeg = [[], [], [], []];
    const acc = [], rr = [], rows = [], headAcc = [], headRaw = [];
    for (const c of chunks) {
      if (c.kind === 'eeg') { const d = c.data; for (let i = 0; i < d.length; i++) eeg[c.channel].push(d[i]); }
      else if (c.kind === 'acc') acc.push(...c.data);
      else if (c.kind === 'rr') rr.push(...c.data);
      else if (c.kind === 'row') rows.push(...c.data);
      else if (c.kind === 'headAcc') headAcc.push(...c.data);
      else if (c.kind === 'headRaw') headRaw.push(...c.data);
    }
    return { meta, eeg, acc, rr, rows, headAcc, headRaw,
      notes: notes.sort((a, b) => a.at - b.at) };
  }

  /*
   * Amend a note that is already written.
   *
   * Needed because notes are written the instant they are made — a tap is saved before you
   * have said anything about it — and the context you want to add arrives at the end of the
   * sit. Without this, annotating a tap at the summary screen changed only the on-screen
   * marker list, so the report would carry the context and `notes.csv` would not, which is
   * the file the lab actually reads.
   *
   * A MERGE, not a replace, and it refuses to touch the identity fields. `at`, `offsetSec`
   * and `sessionId` are what every alignment downstream depends on: the whole reason a tap
   * is worth having is that its timestamp is the moment you noticed, and an edit screen must
   * not be able to move it.
   */
  async function updateNote(db, noteId, patch) {
    const tx = db.transaction([STORE_NOTES], 'readwrite');
    const store = tx.objectStore(STORE_NOTES);
    const existing = await promisify(store.get(noteId));
    if (!existing) { await txDone(tx); return null; }
    const safe = Object.assign({}, patch);
    for (const locked of ['id', 'sessionId', 'at', 'offsetSec']) delete safe[locked];
    const merged = Object.assign({}, existing, safe);
    store.put(merged);
    await txDone(tx);
    return merged;
  }

  // Remove a single note. Needed because a typed note is written the moment it is
  // saved, so changing your mind about one has to be possible afterwards.
  async function deleteNote(db, noteId) {
    const tx = db.transaction([STORE_NOTES], 'readwrite');
    tx.objectStore(STORE_NOTES).delete(noteId);
    await txDone(tx);
  }

  // The notes for one session, oldest first. Read on its own rather than via
  // loadSession, which also pulls megabytes of EEG that a notes list has no use for.
  async function listNotes(db, sessionId) {
    const tx = db.transaction([STORE_NOTES], 'readonly');
    const notes = await promisify(tx.objectStore(STORE_NOTES).index('bySession').getAll(sessionId));
    return notes.sort((a, b) => a.at - b.at);
  }

  async function deleteSession(db, sessionId) {
    const tx = db.transaction([STORE_CHUNKS, STORE_SESSIONS, STORE_NOTES], 'readwrite');
    tx.objectStore(STORE_SESSIONS).delete(sessionId);
    tx.objectStore(STORE_CHUNKS).delete(IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]));
    const idx = tx.objectStore(STORE_NOTES).index('bySession');
    const keys = await promisify(idx.getAllKeys(sessionId));
    for (const k of keys) tx.objectStore(STORE_NOTES).delete(k);
    await txDone(tx);
  }

  /*
   * How much room is left, as the browser sees it.
   *
   * Reported rather than assumed. Quotas differ enormously between platforms, and
   * iOS has historically been both smaller and willing to evict — so the app needs
   * to be able to warn before a multi-day retreat quietly stops recording, instead
   * of discovering it afterwards.
   */
  async function quota() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
      return null;
    }
    const est = await navigator.storage.estimate();
    return {
      usageBytes: est.usage || 0,
      quotaBytes: est.quota || 0,
      fraction: est.quota ? (est.usage || 0) / est.quota : null,
    };
  }

  // Ask the browser not to evict this data under pressure. Best-effort: it can be
  // refused, and a refusal is not an error worth surfacing mid-session.
  async function persist() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return false;
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }

  return {
    open, startSession, listSessions, labelSession, loadSession, deleteSession, quota, persist,
    deleteNote, updateNote, listNotes,
    DB_NAME, DB_VERSION, FLUSH_MS,
    STORE_SESSIONS, STORE_CHUNKS, STORE_NOTES,
  };
});
