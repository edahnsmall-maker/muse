/*
 * Markers — moments the meditator flags and describes during a sit, paired
 * with what the data was doing around them.
 *
 * WHY THIS IS THE IMPORTANT FILE
 * Every interpretive score in this app is currently unvalidated (see
 * metrics.js). The only thing that can change that is LABELLED GROUND TRUTH:
 * moments where a human says what was actually happening, lined up against
 * what the algorithms claimed at that same moment. That is what this produces.
 *
 * Notes are written AT THE MOMENT, not afterwards. That was a considered
 * decision by the person actually using this: when you intend to leave many
 * marks in one sit, deferring the words means spending the sit rehearsing a
 * list of things to remember, which damages the sit far more than a few
 * seconds of typing does. Interrupting once, briefly, and then letting go is
 * cheaper than holding a growing burden of recall.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Markers = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // A few one-tap categories, so a marker can carry meaning without typing.
  // Kept short on purpose: a long menu is its own distraction.
  const KINDS = [
    { key: 'note', label: 'Note', hint: 'something happened worth remembering' },
    { key: 'thought', label: 'Caught thinking', hint: 'noticed I was lost in thought' },
    { key: 'sound', label: 'Sound', hint: 'an external noise or interruption' },
    { key: 'body', label: 'Body', hint: 'pain, itch, restlessness, shifting posture' },
    { key: 'emotion', label: 'Emotion', hint: 'fear, grief, joy, irritation arising' },
    { key: 'settled', label: 'Settled', hint: 'it opened up / dropped in' },
  ];

  class MarkerLog {
    constructor() { this.markers = []; this.nextId = 1; }

    // Starting a new recording starts a new sit. Ids keep counting rather than
    // restarting at 1, so a marker id is unique for the life of the page and two
    // sits' markers can never be confused if they end up side by side.
    clear() { this.markers.length = 0; return this; }

    // tSec = seconds since session start. Returns the created marker.
    // durationSec is optional and describes how long the thing being marked
    // lasted, which the meditator supplies — it is not inferred from data.
    /*
     * `noteId` links a marker to the row already written in storage.
     *
     * Without it, annotating a mark at the end of a sit could only change the on-screen list
     * and the report — while `notes.csv`, which is the file the lab reads, kept the empty
     * original. Two records of one event, disagreeing, with the more authoritative one wrong.
     */
    add(tSec, { kind = 'note', note = null, durationSec = null, noteId = null } = {}) {
      const safeT = Number.isFinite(tSec) ? Math.max(0, tSec) : 0;
      const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
      const m = { id: this.nextId++, tSec: safeT, kind, note, durationSec: dur, noteId };
      this.markers.push(m);
      this.markers.sort((a, b) => a.tSec - b.tSec);
      return m;
    }

    // Set after the fact, because the storage write is awaited and the marker has to exist
    // on screen the instant the key is pressed rather than a transaction later.
    setNoteId(id, noteId) {
      const m = this.markers.find((x) => x.id === id);
      if (m) m.noteId = noteId;
      return m || null;
    }

    annotate(id, note, durationSec) {
      const m = this.markers.find((x) => x.id === id);
      if (!m) return null;
      m.note = note;
      if (durationSec !== undefined) {
        m.durationSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
      }
      return m;
    }

    setKind(id, kind) {
      const m = this.markers.find((x) => x.id === id);
      if (!m) return null;
      m.kind = kind;
      return m;
    }

    remove(id) {
      const before = this.markers.length;
      this.markers = this.markers.filter((x) => x.id !== id);
      return this.markers.length < before;
    }

    list() { return this.markers.slice(); }
    get length() { return this.markers.length; }
  }

  // The part that makes pattern-finding possible: what were the metrics doing
  // just BEFORE this marker versus just AFTER it?
  //
  // Why before/after rather than "at": a person marks a moment a beat or two
  // late — you notice you were thinking, THEN you press. So the interesting
  // signal usually sits in the window leading up to the mark. Reporting both
  // sides, and the change between them, lets a reader judge that for
  // themselves instead of trusting an alignment assumption.
  function contextAround(marker, samples, { windowSec = 30, keys = null } = {}) {
    if (!marker || !Array.isArray(samples) || !samples.length) return null;
    const t = marker.tSec;
    const before = samples.filter((s) => s.t >= t - windowSec && s.t < t);
    const after = samples.filter((s) => s.t >= t && s.t <= t + windowSec);
    if (!before.length && !after.length) return null;

    // Which numeric fields to summarise. Inferred from the data when not given,
    // so a new metric appearing in the log shows up here automatically.
    const fields = keys || [...new Set(
      samples.flatMap((s) => Object.keys(s).filter((k) => k !== 't' && typeof s[k] === 'number'))
    )];

    const mean = (rows, k) => {
      const vals = rows.map((r) => r[k]).filter((v) => typeof v === 'number' && !Number.isNaN(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const out = { tSec: t, windowSec, beforeCount: before.length, afterCount: after.length, fields: {} };
    for (const k of fields) {
      const b = mean(before, k);
      const a = mean(after, k);
      out.fields[k] = { before: b, after: a, delta: (b == null || a == null) ? null : a - b };
    }
    return out;
  }

  // Ranks markers by how much anything moved around them — a cheap way to
  // surface "these are the moments actually worth looking at" without claiming
  // any causal story about them.
  function rankByMovement(markers, samples, opts = {}) {
    return markers
      .map((m) => {
        const ctx = contextAround(m, samples, opts);
        if (!ctx) return { marker: m, context: null, movement: 0 };
        const deltas = Object.values(ctx.fields)
          .map((f) => (f.delta == null ? 0 : Math.abs(f.delta)));
        return { marker: m, context: ctx, movement: deltas.length ? Math.max(...deltas) : 0 };
      })
      .sort((a, b) => b.movement - a.movement);
  }

  function kindLabel(key) {
    const k = KINDS.find((x) => x.key === key);
    return k ? k.label : 'Note';
  }

  return { KINDS, MarkerLog, contextAround, rankByMovement, kindLabel };
});
