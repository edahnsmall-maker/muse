/*
 * Looking for patterns without finding ones that aren't there.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE
 *
 * The purpose of this file is to be SUSPICIOUS. Everything else in the project
 * produces numbers; this decides whether a number means anything, and the failure
 * mode is not a crash — it is a confident, plausible, false finding that then gets
 * built into the app and shown to somebody as if it described their mind.
 *
 * THE ARITHMETIC THAT MAKES THIS NECESSARY. With ~40 candidate features and a
 * handful of time windows you are making a few hundred comparisons. At the
 * conventional p < 0.05, roughly one in twenty of those comes up "significant" from
 * pure noise — so a few dozen findings are expected in a dataset with no structure
 * whatsoever. A tool that reports the strongest correlation it can find, from a few
 * dozen labels, is not a discovery tool. It is a random number generator with a
 * narrative attached.
 *
 * So three defences, none of them optional:
 *
 *   1. HELD-OUT VALIDATION. A pattern is found on some sessions and scored on
 *      others it has never seen. Split by SESSION, never by sample: samples within
 *      one sit are heavily autocorrelated, so a random sample-level split leaks the
 *      answer and every method looks brilliant.
 *   2. MULTIPLICITY CORRECTION. The number of comparisons made is counted and
 *      reported, and thresholds are adjusted for it. A p-value quoted without the
 *      count of tests behind it is not evidence.
 *   3. A NULL BASELINE. The same search is run on shuffled labels. If real labels
 *      do not beat shuffled ones, there is nothing here — and that comparison, not
 *      the raw correlation, is the actual result.
 *
 * Everything returns its own uncertainty, and refuses rather than guesses when there
 * is not enough data. `null` here means "cannot say", and must never be rendered as
 * zero, or as absence of an effect.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Below this many labelled units, no correlation is worth computing. Not a
  // statistical threshold so much as a refusal: with 6 points a single outlier
  // moves r by 0.4, and anything reported would be an artefact of one moment.
  const MIN_N = 8;

  function mean(xs) {
    const v = xs.filter((x) => x != null && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  function sd(xs) {
    const v = xs.filter((x) => x != null && Number.isFinite(x));
    if (v.length < 2) return null;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  }

  /*
   * Pearson correlation over PAIRS that are complete in both series.
   *
   * Pairs dropped rather than filled: a missing label imputed to the mean is a
   * fabricated observation, and with sparse labels the imputed points would
   * dominate. `n` is returned so the caller knows how much was actually used, which
   * is usually far less than the input length.
   */
  function correlate(xs, ys) {
    const pairs = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      const a = xs[i], b = ys[i];
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      pairs.push([a, b]);
    }
    if (pairs.length < MIN_N) return { r: null, n: pairs.length, reason: 'too few complete pairs' };
    const ax = pairs.map((p) => p[0]), by = pairs.map((p) => p[1]);
    const mx = mean(ax), my = mean(by);
    let num = 0, dx = 0, dy = 0;
    for (const [a, b] of pairs) {
      num += (a - mx) * (b - my); dx += (a - mx) ** 2; dy += (b - my) ** 2;
    }
    // A constant series has no correlation with anything. Reporting 0 would imply
    // "no relationship measured", when the truth is "not measurable".
    if (!(dx > 1e-12 && dy > 1e-12)) {
      return { r: null, n: pairs.length, reason: 'one series does not vary' };
    }
    return { r: num / Math.sqrt(dx * dy), n: pairs.length, reason: null };
  }

  /*
   * Spearman: correlation of RANKS.
   *
   * The default for this data, because the labels are ordinal. "4" on the focus
   * scale is more focused than "3", but the gap between 3 and 4 is not claimed to
   * equal the gap between 4 and 5 — and Pearson assumes it does. Spearman is also
   * far less impressed by one extreme sit, which matters when a dataset is twenty
   * sits and one of them was unusual.
   */
  function rank(xs) {
    const idx = xs.map((v, i) => [v, i]).filter((p) => p[0] != null && Number.isFinite(p[0]));
    idx.sort((a, b) => a[0] - b[0]);
    const out = new Array(xs.length).fill(null);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      // Ties share the average rank; ignoring ties inflates rho, and a 1-5 scale is
      // nothing but ties.
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  }

  function spearman(xs, ys) {
    // Rank AFTER pairing, so a value dropped from one series does not shift the
    // other's ranks.
    const pairs = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      if (xs[i] == null || ys[i] == null) continue;
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
      pairs.push([xs[i], ys[i]]);
    }
    if (pairs.length < MIN_N) return { rho: null, n: pairs.length, reason: 'too few complete pairs' };
    const rx = rank(pairs.map((p) => p[0]));
    const ry = rank(pairs.map((p) => p[1]));
    const c = correlate(rx, ry);
    return { rho: c.r, n: pairs.length, reason: c.reason };
  }

  /*
   * A permutation p-value: how often does shuffled data do this well?
   *
   * Preferred over a table lookup because it makes no distributional assumption and
   * because it answers the question actually being asked — "could this have happened
   * by chance with data shaped like mine". `iterations` shuffles are performed with a
   * seeded generator so a reported p-value is reproducible; an unreproducible p-value
   * invites re-rolling until it looks good.
   */
  function seededRandom(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 0x100000000;
    };
  }

  function shuffle(xs, rnd) {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function permutationP(xs, ys, { iterations = 2000, seed = 12345 } = {}) {
    const observed = spearman(xs, ys);
    if (observed.rho == null) return { p: null, rho: null, n: observed.n, reason: observed.reason };
    const rnd = seededRandom(seed);
    let atLeastAsExtreme = 0;
    for (let i = 0; i < iterations; i++) {
      const s = spearman(xs, shuffle(ys, rnd));
      if (s.rho != null && Math.abs(s.rho) >= Math.abs(observed.rho)) atLeastAsExtreme++;
    }
    // (k+1)/(iterations+1), not k/iterations: with zero hits the second form reports
    // p = 0, which claims more certainty than a finite number of shuffles can give.
    return {
      p: (atLeastAsExtreme + 1) / (iterations + 1),
      rho: observed.rho, n: observed.n, iterations, reason: null,
    };
  }

  /*
   * Benjamini-Hochberg, on a whole family of tests at once.
   *
   * Bonferroni would also be defensible and is stricter, but with a few hundred
   * exploratory comparisons it rejects essentially everything, and a tool that never
   * reports anything gets ignored — which is its own failure. BH controls the
   * expected PROPORTION of false discoveries among those reported, which is the
   * right question for a search whose output is a shortlist to investigate.
   *
   * `q` is attached to every test, including the ones that fail. Reporting only the
   * survivors hides the size of the search, which is the number that determines how
   * much any survivor is worth.
   */
  function adjustForMultiplicity(tests, { fdr = 0.1 } = {}) {
    const valid = tests.filter((t) => t.p != null);
    const sorted = valid.slice().sort((a, b) => a.p - b.p);
    const m = sorted.length;
    let maxPassing = -1;
    sorted.forEach((t, i) => {
      const crit = ((i + 1) / m) * fdr;
      if (t.p <= crit) maxPassing = i;
    });
    const out = tests.map((t) => Object.assign({}, t));
    // Step-up: everything at or below the largest passing rank survives, even if its
    // own p exceeds its own critical value.
    sorted.forEach((t, i) => {
      const target = out.find((o) => o === t || (o.key === t.key && o.p === t.p));
      if (!target) return;
      target.q = Math.min(1, (t.p * m) / (i + 1));
      target.passes = i <= maxPassing;
    });
    for (const t of out) if (t.p == null) { t.q = null; t.passes = false; }
    return { tests: out, comparisons: m, fdr, survivors: out.filter((t) => t.passes).length };
  }

  /*
   * Split a set of sessions into train and test.
   *
   * BY SESSION, never by sample. Consecutive samples within one sit are heavily
   * autocorrelated — a one-second window looks almost exactly like its neighbour —
   * so a random sample-level split puts near-duplicates on both sides and the held-
   * out score measures memorisation rather than generalisation. Every method looks
   * excellent under that mistake, which is why it is such a common one.
   *
   * Deterministic given a seed, so a reported score can be re-derived rather than
   * re-rolled until it flatters.
   */
  function splitSessions(sessionIds, { holdOut = 0.3, seed = 7 } = {}) {
    const ids = Array.from(new Set(sessionIds));
    if (ids.length < 2) {
      return { train: ids, test: [], reason: 'need at least 2 sessions to hold any out' };
    }
    const shuffled = shuffle(ids, seededRandom(seed));
    // At least one on each side whenever there are two or more sessions.
    const nTest = Math.max(1, Math.min(ids.length - 1, Math.round(ids.length * holdOut)));
    return { test: shuffled.slice(0, nTest), train: shuffled.slice(nTest), reason: null };
  }

  /*
   * The search: every feature against every labelled dimension, then validated.
   *
   * `units` are rows of { sessionId, features: {...}, labels: {...} } — one per
   * labelled span or per marked moment, NOT one per sample. Aggregating to the unit
   * the label describes is what keeps n honest: a 20-minute span labelled once is one
   * observation, not 1200 of them, and treating it as 1200 would shrink every p-value
   * by a factor of thirty.
   */
  function search(units, { fdr = 0.1, holdOut = 0.3, seed = 7, iterations = 2000 } = {}) {
    const rows = (units || []).filter((u) => u && u.features && u.labels);
    const sessionIds = rows.map((u) => u.sessionId);
    const split = splitSessions(sessionIds, { holdOut, seed });

    const featureKeys = Array.from(rows.reduce((s, u) => {
      Object.keys(u.features).forEach((k) => s.add(k)); return s;
    }, new Set())).sort();
    const labelKeys = Array.from(rows.reduce((s, u) => {
      Object.keys(u.labels).forEach((k) => s.add(k)); return s;
    }, new Set())).sort();

    const trainRows = rows.filter((u) => split.train.includes(u.sessionId));
    const testRows = rows.filter((u) => split.test.includes(u.sessionId));

    const tests = [];
    for (const f of featureKeys) {
      for (const l of labelKeys) {
        const tr = permutationP(
          trainRows.map((u) => u.features[f]), trainRows.map((u) => u.labels[l]),
          { iterations, seed },
        );
        // The held-out score is computed even when training found nothing, so the
        // table cannot be read as "we only checked the promising ones".
        const te = spearman(testRows.map((u) => u.features[f]), testRows.map((u) => u.labels[l]));
        tests.push({
          key: `${f}~${l}`, feature: f, label: l,
          trainRho: tr.rho, p: tr.p, trainN: tr.n,
          testRho: te.rho, testN: te.n,
          // The only column that matters: did the direction survive on sits the
          // pattern had never seen? A sign flip is a refutation, not a weak result.
          heldUp: (tr.rho != null && te.rho != null)
            ? (Math.sign(tr.rho) === Math.sign(te.rho) && Math.abs(te.rho) >= 0.2)
            : null,
          reason: tr.reason || te.reason,
        });
      }
    }

    const adjusted = adjustForMultiplicity(tests, { fdr });
    const confirmed = adjusted.tests.filter((t) => t.passes && t.heldUp === true);
    return {
      tests: adjusted.tests.sort((a, b) => (a.p == null ? 1 : b.p == null ? -1 : a.p - b.p)),
      comparisons: adjusted.comparisons,
      survivors: adjusted.survivors,
      confirmed,
      split: { train: split.train, test: split.test, reason: split.reason },
      units: rows.length,
      /*
       * The honest headline, in words, so a null result reads as a null result. A
       * table of correlations invites reading the biggest number as the finding; this
       * says outright when there is nothing.
       */
      verdict: verdict({ rows, confirmed, adjusted, split }),
    };
  }

  function verdict({ rows, confirmed, adjusted, split }) {
    if (rows.length < MIN_N) {
      return `Not enough labelled observations (${rows.length}; need at least ${MIN_N}).`
        + ' Nothing here is worth interpreting yet — label more sits.';
    }
    if (!split.test.length) {
      return `Only one session, so nothing could be held out. Any pattern below is`
        + ' unvalidated and could be a property of this single sit.';
    }
    if (!confirmed.length) {
      return `No pattern survived. ${adjusted.comparisons} comparisons were made across`
        + ` ${rows.length} labelled observations, ${adjusted.survivors} passed correction,`
        + ' and none of those held their direction on the held-out sessions.'
        + ' That is a real result: with this much data, there is nothing to see yet.';
    }
    return `${confirmed.length} of ${adjusted.comparisons} comparisons survived`
      + ' correction AND held their direction on sessions they were not fitted on:'
      + ` ${confirmed.map((c) => c.key).join(', ')}. Treat as a shortlist to test`
      + ' deliberately, not as a result.';
  }

  /*
   * Aggregate per-second rows into one observation per labelled span.
   *
   * The step that keeps n honest. A 20-minute span carrying one label is ONE
   * observation about that stretch of time, however many samples it contains, and
   * feeding the samples in individually would shrink every p-value by the number of
   * seconds in the span while adding no independent information.
   */
  function unitsFromSpans(sessions) {
    const units = [];
    for (const s of sessions || []) {
      for (const span of s.spans || []) {
        if (!span.dims) continue;
        const inSpan = (s.metrics || []).filter((r) =>
          r && r.t != null && r.t >= span.fromSec && r.t < span.toSec);
        if (!inSpan.length) continue;
        const features = {};
        for (const key of Object.keys(inSpan[0])) {
          if (key === 't' || key === 'epochMs' || key === 'levels') continue;
          const m = mean(inSpan.map((r) => r[key]));
          if (m != null) features[key] = m;
        }
        if (!Object.keys(features).length) continue;
        units.push({
          sessionId: s.sessionId, features, labels: span.dims,
          fromSec: span.fromSec, toSec: span.toSec, samples: inSpan.length,
        });
      }
    }
    return units;
  }

  /*
   * EVENT-LOCKED AVERAGING: what does the signal do around a marked moment?
   *
   * This is the analysis that makes self-caught taps worth taking, and the reason is
   * arithmetic. A single instance of "coming back" is buried in noise — if returning
   * shifts a band power by a few percent, no one instance will show it. But align
   * forty instances on their marks and average, and anything CONSISTENTLY timed to the
   * event adds while the noise cancels as sqrt(n). That is how a small reliable effect
   * becomes visible, and it is the standard trick of event-related EEG analysis.
   *
   * Two things it needs to be honest:
   *
   *   A BASELINE, subtracted per event. Slow drift across a sit — settling, drying
   *   electrodes, posture — would otherwise dominate the average and produce a
   *   confident-looking shape that is really just "the sit went on".
   *
   *   A SURROGATE NULL. The average around 40 real events must be compared against the
   *   average around 40 RANDOM times in the same sessions. Averaging enough windows of
   *   anything produces a smooth curve that looks like a result, so the smooth curve is
   *   not the finding — the difference from the surrogate is.
   */
  function eventLocked(events, seriesBySession, {
    feature = 'calm', preSec = 20, postSec = 10, baselineSec = 10, stepSec = 1,
  } = {}) {
    const bins = [];
    for (let t = -preSec; t <= postSec; t += stepSec) bins.push(t);
    const stacks = bins.map(() => []);
    let used = 0, skipped = 0;

    for (const ev of events || []) {
      const rows = seriesBySession[ev.sessionId];
      if (!rows || ev.tSec == null) { skipped++; continue; }
      const at = (t) => {
        // Nearest sample within half a step. No interpolation: inventing a value at a
        // timestamp that has none is exactly what must not happen here.
        let best = null, bestD = stepSec / 2 + 1e-9;
        for (const r of rows) {
          if (r[feature] == null || !Number.isFinite(r[feature])) continue;
          const d = Math.abs(r.t - t);
          if (d <= bestD) { bestD = d; best = r[feature]; }
        }
        return best;
      };
      // Baseline from the EARLY part of the pre-window, before whatever the event is
      // could plausibly have begun.
      const baseVals = [];
      for (let t = -preSec; t < -preSec + baselineSec; t += stepSec) {
        const v = at(ev.tSec + t);
        if (v != null) baseVals.push(v);
      }
      if (!baseVals.length) { skipped++; continue; }
      const base = baseVals.reduce((a, b) => a + b, 0) / baseVals.length;
      /* DETREND, not merely baseline-subtract.
       *
       * Subtracting a level removes the offset but leaves the SLOPE, and real EEG
       * drifts — electrodes dry, posture settles, the sit goes on. A steady upward
       * drift then shows up in every window as a rise after the mark, which looks
       * exactly like a response and is not one. Fitting and removing a line through
       * each window kills that.
       */
      const pts = [];
      bins.forEach((t, i) => {
        const v = at(ev.tSec + t);
        if (v != null) pts.push([t, v]);
      });
      if (pts.length < 3) { skipped++; continue; }
      const mt = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const mv = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      let num = 0, den = 0;
      for (const [t, v] of pts) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
      const slope = den > 1e-12 ? num / den : 0;
      let any = false;
      bins.forEach((t, i) => {
        const v = at(ev.tSec + t);
        if (v == null) return;
        stacks[i].push((v - base) - slope * (t - (-preSec)));
        any = true;
      });
      if (any) used++; else skipped++;
    }

    return {
      feature, bins,
      mean: stacks.map((xs) => (xs.length ? mean(xs) : null)),
      // Standard error, so a bump can be judged against how much the events disagreed
      // rather than taken at face value.
      sem: stacks.map((xs) => {
        const s = sd(xs);
        return s == null || xs.length < 2 ? null : s / Math.sqrt(xs.length);
      }),
      n: stacks.map((xs) => xs.length),
      events: used, skipped,
    };
  }

  /*
   * The same average around random times, as the null.
   *
   * Surrogate times are drawn from the same sessions with the same count per session,
   * so the null inherits the real events' exposure to each sit's peculiarities. Drawing
   * them from a uniform pool across all sessions would make the comparison partly about
   * which sessions contributed.
   */
  function eventLockedNull(events, seriesBySession, opts = {}) {
    const { seed = 5 } = opts;
    const rnd = seededRandom(seed);
    const perSession = {};
    for (const ev of events || []) {
      perSession[ev.sessionId] = (perSession[ev.sessionId] || 0) + 1;
    }
    const surrogate = [];
    for (const [sid, count] of Object.entries(perSession)) {
      const rows = seriesBySession[sid];
      if (!rows || !rows.length) continue;
      const tMax = rows[rows.length - 1].t;
      const pre = opts.preSec == null ? 20 : opts.preSec;
      const post = opts.postSec == null ? 10 : opts.postSec;
      for (let i = 0; i < count; i++) {
        const span = tMax - pre - post;
        if (span <= 0) continue;
        surrogate.push({ sessionId: sid, tSec: pre + rnd() * span });
      }
    }
    return eventLocked(surrogate, seriesBySession, opts);
  }

  /*
   * Real events against a MAX-STATISTIC null.
   *
   * The obvious version of this test is wrong, and my first attempt at it was: find the
   * peak bin in the real average, then read the surrogate average at that same bin. The
   * peak was CHOSEN partly for its noise, so the real value carries a selection
   * advantage the surrogate never had — and a set of marks with no response at all
   * cleared the null on the first run because of it. That is circular analysis: the
   * same mistake as searching and confirming on one dataset, in miniature.
   *
   * The honest null has to include the selection step. So: build many surrogate event
   * sets, take EACH ONE'S OWN largest deviation, and ask how often that beats the real
   * one. The null distribution is then of maxima, exactly like the statistic being
   * tested, and drift or autocorrelation in the data affects both sides equally.
   */
  function eventLockedTest(events, seriesBySession, opts = {}) {
    const { surrogates = 200, seed = 5 } = opts;
    const real = eventLocked(events, seriesBySession, opts);
    const peakOf = (res) => {
      let bestI = null;
      res.mean.forEach((v, i) => {
        if (v == null) return;
        if (bestI == null || Math.abs(v) > Math.abs(res.mean[bestI])) bestI = i;
      });
      return bestI;
    };
    const bestI = peakOf(real);
    if (bestI == null || real.events < MIN_N) {
      return { real, peak: null, p: null, surrogates: 0,
        verdict: `Only ${real.events} usable events (need at least ${MIN_N}).`
          + ' Mark more before reading anything into this.' };
    }
    const realPeak = Math.abs(real.mean[bestI]);

    let atLeastAsExtreme = 0;
    let exampleNull = null;
    for (let k = 0; k < surrogates; k++) {
      const nul = eventLockedNull(events, seriesBySession,
        Object.assign({}, opts, { seed: seed + k * 7919 }));
      const i = peakOf(nul);
      if (i == null) continue;
      if (Math.abs(nul.mean[i]) >= realPeak) atLeastAsExtreme++;
      if (k === 0) exampleNull = nul;
    }
    // (k+1)/(n+1), so a finite number of surrogates never reports p = 0.
    const p = (atLeastAsExtreme + 1) / (surrogates + 1);
    const clear = p < 0.05;
    const peakT = real.bins[bestI];
    return {
      real, null: exampleNull, surrogates,
      peak: { atSec: peakT, real: real.mean[bestI], sem: real.sem[bestI], clear },
      p,
      verdict: clear
        ? `${real.events} events: ${opts.feature || 'calm'} deviates by`
          + ` ${real.mean[bestI].toFixed(3)} at ${peakT >= 0 ? '+' : ''}${peakT}s from the mark,`
          + ` which only ${atLeastAsExtreme} of ${surrogates} random-time sets matched`
          + ` (p = ${p.toFixed(3)}). Worth testing on sits recorded after today —`
          + ' this was found and measured on the same data.'
        : `${real.events} events: nothing rises clear of random times`
          + ` (p = ${p.toFixed(3)}). With this many marks, that is the expected result.`,
    };
  }

  return {
    MIN_N, mean, sd, correlate, rank, spearman, permutationP,
    adjustForMultiplicity, splitSessions, search, unitsFromSpans,
    eventLocked, eventLockedNull, eventLockedTest,
    seededRandom, shuffle,
  };
});
