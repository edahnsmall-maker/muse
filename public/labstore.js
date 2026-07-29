/*
 * The lab's memory.
 *
 * WHY THIS EXISTS. The lab was a scratchpad: drop archives in, look, reload, start
 * again. Asked for directly — "is there a way to save the lab analyses so I can open
 * them up later?" — and it matters for more than convenience.
 *
 * A finding in this project is never a result. The only thing that turns a candidate
 * into a result is showing up AGAIN in sits recorded after it was found, and that
 * comparison is impossible if the earlier finding was never written down. Re-running the
 * search on more data and getting a different answer teaches nothing unless you can see
 * what the previous answer was. So the saved analysis is the record that makes the
 * replication argument available at all.
 *
 * TWO KINDS OF THING ARE STORED, and they are deliberately separate:
 *
 *   sessions   the loaded sits, so reopening the lab restores what was there. Parsed,
 *              not the original zips — see the note on trimForStore.
 *   analyses   dated snapshots of a report: the prose, the numbers behind it, and which
 *              sits it covered. Immutable once written. Re-running the search later
 *              produces a NEW snapshot rather than overwriting an old one, because the
 *              whole point is being able to compare them.
 *
 * Its own database, not the app's. The app's holds recordings of somebody's brain; this
 * holds derived analysis. Mixing them would mean a lab bug could damage the only copy of
 * a sit, and "clear the lab" would be a frightening thing to offer.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.LabStore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const DB_NAME = 'zenbio-lab';
  const DB_VERSION = 1;
  const SESSIONS = 'sessions';
  const ANALYSES = 'analyses';

  function open({ name = DB_NAME, indexedDB: idb = null } = {}) {
    const db = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!db) return Promise.reject(new Error('no IndexedDB in this browser'));
    return new Promise((resolve, reject) => {
      const req = db.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // keyPath 'sessionId' is the archive's filename. Re-dropping the same file
        // REPLACES rather than duplicates, which is what a person expects after
        // re-exporting a sit they had already looked at.
        if (!d.objectStoreNames.contains(SESSIONS)) d.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
        if (!d.objectStoreNames.contains(ANALYSES)) {
          d.createObjectStore(ANALYSES, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('could not open the lab store'));
    });
  }

  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }

  /*
   * What of a loaded session is worth keeping.
   *
   * NOT THE RAW EEG, and that is a decision rather than an oversight. A 40-minute sit is
   * ~2.4 million float samples per channel; the derived rows the analysis actually reads
   * are 2400 of them. Keeping the raw would multiply the stored size by about a thousand
   * for data no current view touches, and would quietly fill a browser's quota after a
   * handful of sits — at which point storing anything fails, including the small things.
   *
   * The cost is real and worth stating: the planned "recompute features from raw EEG"
   * work (see ROADMAP) needs the archives dropped in again. That is a deliberate trade,
   * not a thing to discover later, so `hasRaw` records whether the original archive had
   * raw EEG at all.
   */
  function trimForStore(session) {
    const read = session.read || {};
    return {
      sessionId: session.sessionId,
      file: session.file,
      error: session.error || null,
      durationSec: session.durationSec == null ? null : session.durationSec,
      notes: session.notes || [],
      spans: session.spans || [],
      wholeSit: session.wholeSit || [],
      trialBlocks: session.trialBlocks || [],
      read: {
        metrics: read.metrics || [],
        notes: read.notes || [],
        warnings: read.warnings || [],
        eegHz: read.eegHz || null,
        files: read.files || [],
      },
      hasRaw: !!(read.eeg && read.eeg.some((ch) => ch && ch.length)),
      storedAt: session.storedAt || null,
    };
  }

  // Restored sessions must look exactly like freshly-loaded ones to everything
  // downstream, or the views quietly behave differently depending on where the data came
  // from. The absent raw EEG is represented as four empty channels rather than missing.
  function rehydrate(stored) {
    const s = Object.assign({}, stored);
    s.read = Object.assign({ eeg: [[], [], [], []], acc: [], rr: [], audio: {}, markdown: '' },
      stored.read || {});
    return s;
  }

  async function putSessions(db, list, { now = null } = {}) {
    const rows = (list || []).map((s) => {
      const t = trimForStore(s);
      // Stamped at write time so the loaded list can be ordered, and so a stale entry is
      // identifiable. Passed in rather than read from the clock, so a test is not
      // racing one.
      t.storedAt = t.storedAt || now || Date.now();
      return t;
    });
    await tx(db, SESSIONS, 'readwrite', (store) => { for (const r of rows) store.put(r); });
    return rows.length;
  }

  async function loadSessions(db) {
    const rows = await tx(db, SESSIONS, 'readonly', (store) => store.getAll());
    return (rows || [])
      .sort((a, b) => (a.storedAt || 0) - (b.storedAt || 0))
      .map(rehydrate);
  }

  function deleteSession(db, sessionId) {
    return tx(db, SESSIONS, 'readwrite', (store) => store.delete(sessionId));
  }

  function clearSessions(db) {
    return tx(db, SESSIONS, 'readwrite', (store) => store.clear());
  }

  /*
   * Save one analysis. Append-only on purpose — see the note at the top of the file.
   *
   * `reports` is what Findings produced, `markdown` the handoff text. Both are kept: the
   * prose so it can be read back without re-deriving anything, and the structured
   * reports so a later version of the lab can compare two snapshots field by field
   * rather than by diffing English.
   */
  async function saveAnalysis(db, { title = null, reports = [], markdown = '',
    sessions: sessionRows = [], savedAt = null, note = '' } = {}) {
    const record = {
      title: title || 'Analysis',
      savedAt: savedAt || Date.now(),
      note,
      reports,
      markdown,
      // WHICH SITS IT COVERED. A finding is only comparable against a later one if you
      // can see whether the later run simply had more data, so the input set is part of
      // the record rather than something to remember.
      sessions: sessionRows,
      sessionCount: sessionRows.length,
    };
    const id = await tx(db, ANALYSES, 'readwrite', (store) => store.add(record));
    return Object.assign({ id }, record);
  }

  async function listAnalyses(db) {
    const rows = await tx(db, ANALYSES, 'readonly', (store) => store.getAll());
    // Newest first: the most recent analysis is the one being compared against.
    return (rows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  function getAnalysis(db, id) {
    return tx(db, ANALYSES, 'readonly', (store) => store.get(id));
  }

  function deleteAnalysis(db, id) {
    return tx(db, ANALYSES, 'readwrite', (store) => store.delete(id));
  }

  return {
    DB_NAME, SESSIONS, ANALYSES,
    open, trimForStore, rehydrate,
    putSessions, loadSessions, deleteSession, clearSessions,
    saveAnalysis, listAnalyses, getAnalysis, deleteAnalysis,
  };
});
