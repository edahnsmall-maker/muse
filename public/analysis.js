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

  /* ==========================================================================
   * THE RESOLUTION FLOOR, and why an analytic p is needed as well
   * ==========================================================================
   *
   * A permutation p cannot go below 1/(iterations+1) — with zero shuffles beating the
   * observed value the estimate is (0+1)/(N+1), by construction, because a finite
   * number of shuffles cannot evidence a smaller number than that.
   *
   * Benjamini-Hochberg needs the strongest hit at p <= q/m. So at q = 0.1 and 1500
   * shuffles, the floor of 6.7e-4 means NOTHING CAN EVER BE CONFIRMED once the search
   * exceeds ~150 comparisons — not a weak effect, not a crushing one. Measured, not
   * reasoned about: a 0.87 correlation over 300 observations went undetected in a
   * 100-feature search at every sample size tried, because its p could not physically
   * be smaller than the threshold it had to beat.
   *
   * This is the worst class of failure in this file: the search reports "no pattern
   * survived", which reads as a finding about meditation, when it is a fact about the
   * arithmetic of the tool. And it arrived silently, as a consequence of widening the
   * feature set — the change that made the search able to ask better questions is the
   * change that made it unable to answer any.
   *
   * So screening now uses an ANALYTIC p, which has no floor, and permutation is kept
   * for what it is uniquely good at: checking that the analytic assumption holds. The
   * survivors are few, so they can afford enough shuffles to be worth trusting.
   */

  // Continued fraction for the incomplete beta function (Lentz's method). Needed for
  // the t-distribution tail; there is no Math.* for this.
  function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-16, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function logGamma(z) {
    // Lanczos approximation. Accurate to ~15 digits over the range used here.
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    let x = z - 1, a = 0.99999999999980993, t = x + 7.5;
    for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b)
      + a * Math.log(x) + b * Math.log(1 - x);
    const bt = Math.exp(lbeta);
    return x < (a + 1) / (a + b + 2)
      ? (bt * betacf(a, b, x)) / a
      : 1 - (bt * betacf(b, a, 1 - x)) / b;
  }

  /*
   * Two-sided p for a Spearman rho, from the t approximation.
   *
   * t = rho * sqrt((n-2)/(1-rho^2)) on n-2 degrees of freedom. Approximate — it treats
   * the rank correlation as if it were a Pearson r on normal data, and with a binary
   * label (heavy ties, which is exactly the marked-vs-unmarked case) the approximation
   * is looser than for a continuous one. That is precisely why the permutation test is
   * kept: this value SCREENS, and permutation CONFIRMS.
   */
  function spearmanP(rho, n) {
    if (rho == null || !Number.isFinite(rho) || n == null || n < 4) return null;
    const r = Math.min(1 - 1e-12, Math.max(-1 + 1e-12, rho));
    const df = n - 2;
    const t = Math.abs(r) * Math.sqrt(df / (1 - r * r));
    return Math.min(1, betai(df / 2, 0.5, df / (df + t * t)));
  }

  /*
   * THE SMALLEST EFFECT THIS SEARCH COULD POSSIBLY REPORT.
   *
   * The most useful number in the whole file, and the one that was missing. Before
   * reading any correlation it answers the question that actually matters: given how
   * many observations there are and how many comparisons were made, is this dataset
   * capable of showing anything? A "no pattern found" from an underpowered search and
   * one from a well-powered search are completely different statements, and until this
   * existed they were reported identically.
   *
   * Solved numerically rather than inverted analytically — a bisection over a
   * monotone function is a dozen lines nobody has to re-derive.
   */
  function detectableRho(n, comparisons, { fdr = 0.1, heldOutFloor = 0.2 } = {}) {
    if (!n || n < 6 || !comparisons) return null;
    const target = fdr / comparisons;          // what the STRONGEST hit must beat
    let lo = 0, hi = 0.999;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (spearmanP(mid, n) > target) lo = mid; else hi = mid;
    }
    // The held-out check is a second, independent hurdle: a pattern must also keep
    // |rho| >= heldOutFloor on sits it was never fitted on, so the true bar is the
    // larger of the two.
    return Math.max(hi, heldOutFloor);
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
      /* The BH threshold this test had to clear, kept for the permutation re-check.
         `q` is the adjusted p-value and is NOT the right thing to re-test against: for
         a strong effect q is astronomically small (1e-14 and below), and no finite
         number of shuffles can produce a p that small, so comparing a permutation p to
         q rejects every strong finding. The critical value is the actual bar. */
      target.critical = ((i + 1) / m) * fdr;
      target.rank = i + 1;
      target.passes = i <= maxPassing;
    });
    for (const t of out) if (t.p == null) { t.q = null; t.critical = null; t.passes = false; }
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
  /*
   * THE SPLIT IS BY SESSION AND BALANCED BY OBSERVATION COUNT, and the second half of that is
   * a bug fix with a reproduction behind it.
   *
   * It used to shuffle the session ids and take 30% of the IDS. Sessions are wildly unequal —
   * a 15-minute sit with no taps contributes nothing, a 1-minute sit contributes two windows,
   * a 5-minute sit with 13 taps contributes twenty — so counting ids is not counting data.
   * Reported as an analysis saying "0 comparisons across 26 windows... that is a real answer
   * rather than a failure", and reproduced exactly from the three session names involved: the
   * shuffle put the twenty-unit session in TEST and left the two-unit session to train on.
   * Two observations cannot support any correlation, so every p came back null, the count of
   * comparisons was therefore zero, and the verdict announced a real null result. Nothing had
   * been tested at all. 91% of the data sat in the held-out half.
   *
   * So sessions are now held out SMALLEST FIRST, until the held-out share of observations
   * reaches holdOut, and never past the point where the training side drops below
   * minTrainUnits. The largest session stays in training by construction.
   *
   * This is deliberately not random, and the trade is worth stating. A size-ordered split
   * makes the held-out check weaker — it is confirmed on the smaller sits — but a random one
   * can leave nothing to fit on, which is not a weaker check, it is no analysis. The sizes of
   * both sides are returned so the weakness is visible rather than implied. Ties are broken by
   * the seeded shuffle, so the result stays reproducible.
   */
  function splitSessions(sessionIds, { holdOut = 0.3, seed = 7, minTrainUnits = 8 } = {}) {
    const counts = new Map();
    for (const id of sessionIds || []) counts.set(id, (counts.get(id) || 0) + 1);
    const ids = Array.from(counts.keys());
    const summary = { counts, trainUnits: sessionIds ? sessionIds.length : 0, testUnits: 0 };
    if (ids.length < 2) {
      return Object.assign({ train: ids, test: [],
        reason: 'need at least 2 sessions to hold any out' }, summary);
    }
    const total = sessionIds.length;
    // Shuffle first so equal-sized sessions are ordered reproducibly but not alphabetically,
    // then a stable sort by size puts the smallest candidates for holding out first.
    const order = shuffle(ids, seededRandom(seed));
    const bySize = order.slice().sort((a, b) => counts.get(a) - counts.get(b));
    const test = [];
    let held = 0;
    const target = total * holdOut;
    for (const id of bySize) {
      if (ids.length - test.length <= 1) break;         // never empty the training side
      if (held >= target) break;                        // enough held out already
      const n = counts.get(id);
      if (total - held - n < minTrainUnits) break;      // training side must stay testable
      /* Do not overshoot the target by more than staying put would undershoot it. Without
         this the greedy loop happily holds out 5 of 8 observations when asked for 30%,
         because each individual session still looked like it fitted. The exception is an
         empty test set: something held out beats nothing, whatever the arithmetic says. */
      if (test.length && held + n > target && (held + n - target) > (target - held)) break;
      test.push(id);
      held += n;
    }
    const train = ids.filter((id) => test.indexOf(id) < 0);
    return {
      train, test,
      trainUnits: total - held,
      testUnits: held,
      counts,
      /* Said out loud when there was no way to hold anything out without gutting the fit.
         Previously this situation produced a confident null result instead of an explanation. */
      reason: test.length ? null
        : `every session had to stay in training to keep ${minTrainUnits} observations to fit on`,
    };
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

    /*
     * SCREEN ANALYTICALLY, CONFIRM BY PERMUTATION.
     *
     * Every pair gets an analytic p, which has no resolution floor — see the note
     * above spearmanP for the failure this replaces, where a large search could not
     * confirm a crushing effect because the permutation p physically could not be
     * smaller than the threshold it had to beat.
     */
    const tests = [];
    for (const f of featureKeys) {
      for (const l of labelKeys) {
        const tr = spearman(trainRows.map((u) => u.features[f]), trainRows.map((u) => u.labels[l]));
        // The held-out score is computed even when training found nothing, so the
        // table cannot be read as "we only checked the promising ones".
        const te = spearman(testRows.map((u) => u.features[f]), testRows.map((u) => u.labels[l]));
        tests.push({
          key: `${f}~${l}`, feature: f, label: l,
          trainRho: tr.rho, p: spearmanP(tr.rho, tr.n), trainN: tr.n,
          testRho: te.rho, testN: te.n,
          pPermutation: null, permutationChecked: false,
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
    const shortlist = adjusted.tests.filter((t) => t.passes && t.heldUp === true);

    /*
     * Now the expensive, assumption-free check, on the shortlist only.
     *
     * The analytic p treats a rank correlation as a Pearson r on normal data, and the
     * marked-versus-unmarked label is binary — heavy ties, where that approximation is
     * at its loosest. Measured agreement on this shape of data is within ~20%, which is
     * fine for ordering a search and not fine for a claim. So anything that survives
     * screening is re-tested by shuffling, with enough shuffles that the floor sits an
     * order of magnitude below the threshold it must beat.
     *
     * A candidate that fails here is DROPPED, and that is the point: it means the
     * approximation flattered it.
     */
    const critical = fdr / Math.max(1, adjusted.comparisons);
    const permIterations = Math.max(iterations, Math.ceil(20 / critical));
    const CONFIRM_CAP = 40;
    let permutationsSkipped = 0;
    shortlist.forEach((t, i) => {
      if (i >= CONFIRM_CAP) { permutationsSkipped++; return; }
      const pp = permutationP(
        trainRows.map((u) => u.features[t.feature]),
        trainRows.map((u) => u.labels[t.label]),
        { iterations: permIterations, seed },
      );
      t.pPermutation = pp.p;
      t.permutationChecked = true;
      t.permutationIterations = permIterations;
    });
    const confirmed = shortlist.filter((t) => !t.permutationChecked
      || (t.pPermutation != null && t.pPermutation <= t.critical));

    return {
      tests: adjusted.tests.sort((a, b) => (a.p == null ? 1 : b.p == null ? -1 : a.p - b.p)),
      comparisons: adjusted.comparisons,
      survivors: adjusted.survivors,
      confirmed,
      shortlist: shortlist.length,
      permutationsSkipped,
      permutationIterations: permIterations,
      /*
       * What this dataset could have shown, whether or not it showed anything. A "no
       * pattern found" from an underpowered search and one from a well-powered search
       * are entirely different statements and used to be reported identically.
       */
      detectableRho: detectableRho(trainRows.length, adjusted.comparisons, { fdr }),
      /* HOW MUCH DATA WAS ON EACH SIDE OF THE SPLIT. Reported because a split that leaves
         almost everything held out is indistinguishable, from the outside, from a genuine null
         — which is exactly what happened when 20 of 22 observations landed in the test half. */
      trainUnits: trainRows.length,
      testUnits: rows.length - trainRows.length,
      split: { train: split.train, test: split.test, reason: split.reason },
      units: rows.length,
      /*
       * The honest headline, in words, so a null result reads as a null result. A
       * table of correlations invites reading the biggest number as the finding; this
       * says outright when there is nothing.
       */
      verdict: verdict({ rows, confirmed, adjusted, split, fdr }),
    };
  }

  // How many observations were on the fitting side, worded for a sentence.
  function trainNote(split) {
    if (split && split.trainUnits != null) {
      return `only ${split.trainUnits} of them were on the fitting side of the`
        + ' train/test split';
    }
    return 'the fitting side of the train/test split was left almost empty';
  }

  function verdict({ rows, confirmed, adjusted, split, fdr = 0.1 }) {
    if (rows.length < MIN_N) {
      return `Not enough labelled observations (${rows.length}; need at least ${MIN_N}).`
        + ' Nothing here is worth interpreting yet — label more sits.';
    }
    if (!split.test.length) {
      return `Only one session, so nothing could be held out. Any pattern below is`
        + ' unvalidated and could be a property of this single sit.'
        + (split.reason ? ` (${split.reason})` : '');
    }
    /*
     * NOTHING WAS TESTED IS NOT A NULL RESULT, and conflating the two is the worst thing this
     * function can do.
     *
     * Reported from a real analysis: "0 comparisons across 26 windows; none survived correction
     * and also held its direction — with this much data that is the expected outcome, and it is
     * a real answer rather than a failure." Every word of that was wrong. Zero comparisons means
     * every test returned a null p, which means no test could be computed at all — here because
     * the training half had been left with two observations. Saying "expected outcome" of that
     * invites someone to conclude their practice has no signature when the analysis never
     * looked.
     */
    if (!adjusted.comparisons) {
      return `Nothing could be tested. ${rows.length} labelled observations were built, but`
        + ` ${trainNote(split)} — too few to compute a single correlation, so no comparison was`
        + ' made and this says nothing at all about whether a pattern exists.'
        + ' This is a data-shape problem, not a result: label more moments in the sits that'
        + ' already have signal, or record more sits of similar length.';
    }
    if (!confirmed.length) {
      /* THE FLOOR ON WHAT COULD HAVE BEEN SEEN, in the same breath as the null result.
         Without it, "nothing survived" reads as a fact about meditation when it may be
         a fact about how much data there is: at 96 observations and 400 comparisons
         nothing below a 0.37 correlation can survive, and most real effects are
         smaller than that. */
      const floor = detectableRho(rows.length, adjusted.comparisons, { fdr });
      return `No pattern survived. ${adjusted.comparisons} comparisons were made across`
        + ` ${rows.length} labelled observations, ${adjusted.survivors} passed correction,`
        + ' and none of those held their direction on the held-out sessions.'
        + (floor ? ` With this many observations and this many comparisons, the weakest`
          + ` relationship that could possibly have been reported is about ${floor.toFixed(2)}`
          + ` — so this rules out strong effects, not subtle ones.` : '')
        + ' That is a real result, and the way to change it is more labelled moments.';
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

  /* ==========================================================================
   * SIGNATURES: what a "pattern" is allowed to look like
   * ==========================================================================
   *
   * The first version of this search could only ask one question — "is the MEAN of
   * this score higher when that label is higher" — and that is a small fraction of
   * the ways a state could show up in four electrodes and a handful of composites.
   * Asked for directly, and the list is the right one:
   *
   *   "it could be how two things are moving together. It could be how two things are
   *    moving opposite. It could be how three things are moving together or opposite.
   *    It could also be little patterns and how an individual line is moving
   *    independent of the other lines."
   *
   * So each window yields several KINDS of feature:
   *
   *   level      the mean. What the old search had.
   *   trend      least-squares slope per second. "It was rising" is a different
   *              claim from "it was high", and for a transition — coming back,
   *              settling — the rising is the more plausible signature.
   *   swing      standard deviation within the window: how unsettled the line was,
   *              independent of where it sat.
   *   range      peak-to-trough. Catches a single excursion that an sd dilutes.
   *   pair       within-window Pearson r between two series. POSITIVE means they
   *              moved together, NEGATIVE means opposite — one number covering both
   *              of the asked-for cases, and the sign is the answer.
   *   trio       the mean of the three pairwise r's among three series: how much
   *              the three moved as one thing. Signed, same reading as `pair`.
   *
   * A WARNING THAT IS PART OF THE FEATURE. Every kind added multiplies the number of
   * comparisons, and multiplicity correction spends real power on each one: a search
   * over 200 features needs a stronger effect to survive than a search over 20. This
   * is the correct trade — a signature you never test is a signature you never find —
   * but it means `search()`'s reported comparison count matters more than ever, and
   * with a handful of sits the honest answer will usually still be "nothing yet".
   * Breadth here buys the ABILITY to find these shapes; it does not buy evidence.
   */

  // Columns that are timestamps or bookkeeping, never signals to correlate.
  const NOT_A_SIGNAL = new Set(['t', 'epochMs', 'clock', 'absoluteTime', 'levels', 'spikes']);

  /*
   * Which columns are usable series. A column counts only if it is numeric in most
   * rows: metrics.csv carries whatever the app happened to be computing, so a score
   * that was off for the whole sit appears as a column of blanks, and treating that
   * as a series would generate features from nothing.
   */
  function seriesKeys(rows, { minCoverage = 0.6 } = {}) {
    const counts = new Map();
    for (const r of rows || []) {
      for (const k of Object.keys(r || {})) {
        if (NOT_A_SIGNAL.has(k)) continue;
        const v = Number(r[k]);
        if (r[k] === '' || r[k] == null || !Number.isFinite(v)) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    const n = (rows || []).length || 1;
    return Array.from(counts.entries())
      .filter(([, c]) => c / n >= minCoverage)
      .map(([k]) => k)
      .sort();
  }

  // Least-squares slope of ys against xs, per unit of x. Returns null rather than 0
  // when x does not vary — a flat window has no trend, which is not the same as a
  // trend of zero.
  function slope(xs, ys) {
    const pts = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      const x = Number(xs[i]), y = Number(ys[i]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
    if (pts.length < 3) return null;
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let num = 0, den = 0;
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
    return den < 1e-12 ? null : num / den;
  }

  /*
   * Correlation WITHIN one window, which is a different job from `correlate`.
   *
   * `correlate` refuses below MIN_N (8) complete pairs, and that refusal is right for
   * its purpose: it is asked whether a feature tracks a label ACROSS observations, and
   * an r from six sits is an artefact of one sit. But a within-window co-movement is
   * not a claim — it is a FEATURE VALUE, one number describing one window, and the
   * claim is made later by comparing that number across many windows. The protection
   * lives at the search level (permutation null, multiplicity correction, held-out
   * sessions), not here.
   *
   * The threshold mattered rather than being theoretical. The default window is
   * leadSec 10 minus tailSec 2 = 8 seconds, which at 1Hz is exactly 8 samples — sitting
   * precisely on MIN_N, so every pair and trio feature worked only as long as no row
   * was missing, and vanished silently the moment one was. A dropped sample should cost
   * precision, not the entire feature.
   */
  const MIN_WINDOW_PAIRS = 5;
  function windowCorr(xs, ys) {
    const a = [], b = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      const x = xs[i], y = ys[i];
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      a.push(x); b.push(y);
    }
    if (a.length < MIN_WINDOW_PAIRS) return null;
    const ma = a.reduce((p, q) => p + q, 0) / a.length;
    const mb = b.reduce((p, q) => p + q, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const dx = a[i] - ma, dy = b[i] - mb;
      num += dx * dy; da += dx * dx; db += dy * dy;
    }
    const den = Math.sqrt(da * db);
    return den < 1e-12 ? null : num / den;
  }

  /*
   * Every feature for one window of rows.
   *
   * `trioKeys` is deliberately a SHORT list rather than every series: three-way
   * combinations grow as n-choose-3, so ten series would add 120 features and spend
   * most of the search's power on combinations nobody had a reason to suspect. The
   * default is the interpretive composites, which are the ones a claim would be made
   * about. Pairs are cheap enough (n-choose-2) to take all of them.
   */
  function windowFeatures(rows, {
    keys = null, pairs = true, trios = true,
    trioKeys = ['calm', 'focus', 'thinking', 'drowsy', 'noise'],
  } = {}) {
    const list = (rows || []).filter(Boolean);
    if (list.length < 3) return null;
    const ks = keys || seriesKeys(list);
    if (!ks.length) return null;
    const num = (r, k) => {
      const v = Number(r[k]);
      return Number.isFinite(v) ? v : null;
    };
    const ts = list.map((r) => {
      const v = Number(r.t);
      return Number.isFinite(v) ? v : null;
    });
    const cols = {};
    for (const k of ks) cols[k] = list.map((r) => num(r, k));

    const out = {};
    for (const k of ks) {
      const v = cols[k].filter((x) => x != null);
      if (v.length < 3) continue;
      out[`${k}.level`] = mean(v);
      const sl = slope(ts, cols[k]);
      if (sl != null) out[`${k}.trend`] = sl;
      const s = sd(v);
      if (s != null) out[`${k}.swing`] = s;
      out[`${k}.range`] = Math.max(...v) - Math.min(...v);
    }

    // Pairs and trios use windowCorr, NOT correlate — see the note on windowCorr for
    // why the threshold differs. It still drops incomplete pairs rather than imputing,
    // and still returns null when a series does not vary: a constant line has no
    // co-movement, and reporting 0 would claim it moved independently.
    if (pairs) {
      for (let i = 0; i < ks.length; i++) {
        for (let j = i + 1; j < ks.length; j++) {
          const r = windowCorr(cols[ks[i]], cols[ks[j]]);
          if (r != null) out[`${ks[i]}+${ks[j]}.pair`] = r;
        }
      }
    }

    if (trios) {
      const avail = trioKeys.filter((k) => ks.includes(k));
      for (let i = 0; i < avail.length; i++) {
        for (let j = i + 1; j < avail.length; j++) {
          for (let k = j + 1; k < avail.length; k++) {
            const rs = [
              windowCorr(cols[avail[i]], cols[avail[j]]),
              windowCorr(cols[avail[i]], cols[avail[k]]),
              windowCorr(cols[avail[j]], cols[avail[k]]),
            ].filter((x) => x != null);
            // All three pairs, or none. Averaging two of three would answer a
            // different question than "did these three move as one".
            if (rs.length === 3) {
              out[`${avail[i]}+${avail[j]}+${avail[k]}.trio`] = mean(rs);
            }
          }
        }
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /*
   * Turn each MARK into an observation, using the window just BEFORE it.
   *
   * WHY THIS EXISTS. The lab could only analyse hand-labelled spans, and nobody has
   * been labelling spans — the taps came later than the lab did. Three sits loaded
   * with plenty of marks produced "no labelled spans, nothing to correlate", which is
   * a tooling dead end rather than a finding.
   *
   * The assumption, and it is the practitioner's own: a mark says something about the
   * stretch immediately before it. You press "returned" *after* noticing you had come
   * back, so if returning has a signature it is in the seconds leading up to the
   * press, not after it.
   *
   * `tailSec` DROPS THE LAST FEW SECONDS BEFORE THE MARK, and this is not fussiness.
   * Two things live in that gap. Pressing a key moves a hand, an arm and usually the
   * jaw, and EMG from that lands in the same frequencies the "thinking" score is
   * built from — so the seconds touching the keypress would reliably show "activity"
   * for every category, which is an artefact of the button and not of the mind.
   * Second, the noticing itself is the event; including it mixes the state being
   * reported with the act of reporting it.
   *
   * CONTROL WINDOWS. With one category of mark there is nothing to contrast against,
   * and a one-class label has no variance so every correlation is null. So random
   * windows from the same sessions, kept clear of every mark, are added as the
   * comparison class. That also makes single-category datasets analysable, which is
   * what most early sits will be.
   */
  function unitsFromMarks(sessions, {
    leadSec = 10, tailSec = 2, minSamples = 4, seed = 11,
    controlsPerMark = 1, controlClearanceSec = 30, features = {},
  } = {}) {
    const units = [];
    const rnd = seededRandom(seed);
    const kindsSeen = new Set();

    for (const s of sessions || []) {
      const rows = (s.metrics || []).filter((r) => r && Number.isFinite(Number(r.t)));
      if (!rows.length) continue;
      const ks = seriesKeys(rows);
      if (!ks.length) continue;
      const opts = Object.assign({ keys: ks }, features);

      // A mark is any note that names a moment. `transition`/`tapCategory` are the
      // one-key taps; `markKind` is the older Mark-this-moment prompt. Probe answers
      // are excluded: a probe is a moment chosen by a clock, so the window before it
      // is a sample of the sit rather than of a state the person had just noticed.
      const marks = (s.notes || [])
        .filter((n) => n && n.anchored !== false && Number.isFinite(Number(n.offsetSec)))
        .map((n) => ({
          at: Number(n.offsetSec),
          kind: n.transition || n.tapCategory || n.markKind || null,
          grade: n.grade != null && n.grade !== '' ? Number(n.grade) : null,
        }))
        .filter((m) => m.kind && m.at >= leadSec)
        .sort((a, b) => a.at - b.at);
      if (!marks.length) continue;

      const windowFor = (endSec) => rows.filter((r) => {
        const t = Number(r.t);
        return t >= endSec - (leadSec - tailSec) && t < endSec;
      });

      for (const m of marks) {
        const end = m.at - tailSec;
        const win = windowFor(end);
        if (win.length < minSamples) continue;
        const f = windowFeatures(win, opts);
        if (!f) continue;
        kindsSeen.add(m.kind);
        units.push({
          sessionId: s.sessionId, features: f,
          markKind: m.kind, grade: m.grade, isControl: false,
          fromSec: end - (leadSec - tailSec), toSec: end,
          markAtSec: m.at, samples: win.length, labels: {},
        });
      }

      /*
       * Controls: random window ends, at least controlClearanceSec from every mark.
       * Drawn from the same session so anything that differs between sessions —
       * electrode fit, time of day, how the sit went — cannot masquerade as a
       * difference between marked and unmarked time.
       */
      const wanted = Math.round(marks.length * controlsPerMark);
      const tMin = Number(rows[0].t) + leadSec;
      const tMax = Number(rows[rows.length - 1].t);
      let attempts = 0;
      let made = 0;
      while (made < wanted && attempts < wanted * 40) {
        attempts++;
        const end = tMin + rnd() * Math.max(0, tMax - tMin);
        if (marks.some((m) => Math.abs(m.at - end) < controlClearanceSec)) continue;
        const win = windowFor(end);
        if (win.length < minSamples) continue;
        const f = windowFeatures(win, opts);
        if (!f) continue;
        units.push({
          sessionId: s.sessionId, features: f,
          markKind: null, grade: null, isControl: true,
          fromSec: end - (leadSec - tailSec), toSec: end,
          markAtSec: null, samples: win.length, labels: {},
        });
        made++;
      }
    }

    /*
     * ONE-VS-REST LABELS. A tap category is not an ordinal quantity, so it cannot be
     * correlated directly; each category becomes its own 1/0 question instead —
     * "windows before a `returned` tap versus every other window". Spearman on a
     * binary variable is a rank-biserial correlation, which is exactly the right
     * test, so the whole existing pipeline (permutation null, FDR, held-out sessions)
     * applies unchanged rather than needing a second, less careful one.
     */
    const kinds = Array.from(kindsSeen).sort();
    for (const u of units) {
      for (const k of kinds) u.labels[`is:${k}`] = u.markKind === k ? 1 : 0;
      /*
       * And the coarsest question of all, which is also the one most likely to have
       * enough n to answer: was this a moment the person noticed anything at all?
       *
       * ONLY when more than one category is present. With a single category that
       * question is character-for-character the same as `is:<that category>`, and
       * asking it twice doubles the comparison count for no new information — which
       * costs real power, because multiplicity correction makes every test harder in
       * proportion to how many were run.
       */
      if (kinds.length > 1) u.labels['is:any-mark'] = u.isControl ? 0 : 1;
    }
    return units;
  }

  /* ==========================================================================
   * THE CLIP LIBRARY: every marked moment, side by side
   * ==========================================================================
   *
   * Asked for as "a library of all of the times I said I was thinking, and compare them
   * all" — which is epoching, the standard move in event-related EEG, and the right
   * instinct. `eventLocked` above already averages across events; this returns the
   * INDIVIDUAL clips as well, because an average of twelve windows hides whether it came
   * from twelve similar shapes or from one enormous outlier, and that distinction is the
   * whole question when n is this small.
   *
   * THE BASELINE DECISION IS THE IMPORTANT ONE, and it came from the practitioner:
   *
   *   "Since the mark is when I NOTICE I was thinking, don't use the immediately
   *    preceding period as the only baseline — that may erase the effect we're looking
   *    for."
   *
   * Exactly right, and it is a real trap. Standard practice baselines against the
   * seconds just before the event, which assumes those seconds are neutral. Here they
   * are the opposite: a self-caught mark is pressed BECAUSE something was happening just
   * before it, so subtracting that period subtracts the signal. `eventLocked`'s
   * per-window linear detrending has the same problem for a slow pre-mark ramp — it fits
   * the ramp and removes it.
   *
   * So three modes, and 'none' is the default:
   *
   *   none      the within-session z-scored trace, untouched. Comparable across sits
   *             because each session is normalised against itself — electrode fit
   *             changes day to day — while nothing event-locked is removed.
   *   far       subtract the mean of the EARLIEST part of the window (the default is the
   *             first third, ~15s to ~10s before the mark), deliberately not the seconds
   *             adjacent to it. Removes between-clip offset without touching the run-up.
   *   detrend   remove a per-clip straight line. The most aggressive, and the one that
   *             will erase a slow ramp — kept because if an effect survives it, that
   *             effect is not slow drift.
   *
   * Every mode is applied identically to the surrogate clips, or the comparison is rigged.
   */

  // Z-score a series against its own session. The unit of normalisation is the session
  // because that is the unit over which electrode fit, posture and time of day are
  // constant. Returns null where the session does not vary at all.
  function zBySession(values) {
    const v = (values || []).map((x) => (x == null ? null : Number(x)))
      .map((x) => (Number.isFinite(x) ? x : null));
    const m = mean(v);
    const s = sd(v);
    if (m == null || s == null || s < 1e-12) return v.map(() => null);
    return v.map((x) => (x == null ? null : (x - m) / s));
  }

  // One clip, sampled onto a fixed grid of offsets relative to the event. Nearest sample
  // within half a step; null where there is no data, so a gap stays a gap.
  function clipAt(rows, key, atSec, bins, { stepSec = 1 } = {}) {
    const out = new Array(bins.length).fill(null);
    let hits = 0;
    for (let b = 0; b < bins.length; b++) {
      const want = atSec + bins[b];
      let best = null, bestD = stepSec / 2 + 1e-9;
      for (const r of rows) {
        const d = Math.abs(r.t - want);
        if (d <= bestD) { bestD = d; best = r; }
      }
      if (best && best[key] != null) { out[b] = best[key]; hits++; }
    }
    return hits >= bins.length * 0.6 ? out : null;   // too sparse to be a clip
  }

  function applyBaseline(clip, bins, mode) {
    if (mode === 'none' || !mode) return clip.slice();
    if (mode === 'far') {
      // The EARLIEST third of the pre-event window, never the seconds next to the mark.
      const preBins = bins.filter((b) => b < 0);
      if (!preBins.length) return clip.slice();
      const cut = preBins[Math.max(0, Math.floor(preBins.length / 3) - 1)];
      const vals = clip.filter((v, i) => v != null && bins[i] <= cut);
      const base = mean(vals);
      return base == null ? clip.slice() : clip.map((v) => (v == null ? null : v - base));
    }
    if (mode === 'detrend') {
      const xs = [], ys = [];
      bins.forEach((b, i) => { if (clip[i] != null) { xs.push(b); ys.push(clip[i]); } });
      const sl = slope(xs, ys);
      const my = mean(ys), mx = mean(xs);
      if (sl == null || my == null) return clip.slice();
      return clip.map((v, i) => (v == null ? null : v - (my + sl * (bins[i] - mx))));
    }
    return clip.slice();
  }

  // Mean and standard error across clips, bin by bin, ignoring gaps.
  function stackClips(clips, bins) {
    const meanAt = [], seAt = [], nAt = [];
    for (let b = 0; b < bins.length; b++) {
      const col = clips.map((c) => c[b]).filter((v) => v != null);
      nAt.push(col.length);
      meanAt.push(col.length ? mean(col) : null);
      const s = col.length > 1 ? sd(col) : null;
      seAt.push(s == null ? null : s / Math.sqrt(col.length));
    }
    return { mean: meanAt, se: seAt, n: nAt };
  }

  /*
   * The library for one feature and one mark category.
   *
   * The surrogate band is what makes the average readable. Averaging ANY forty windows
   * produces a smooth curve, so a smooth curve is not the finding — the finding is the
   * real average leaving the band that random moments produce. Surrogate times are drawn
   * from the same sessions, kept clear of every mark of any kind, and pushed through the
   * identical normalisation, clipping and baseline steps.
   */
  function epochLibrary(sessions, {
    feature = 'calm', category = null, preSec = 15, postSec = 15, stepSec = 1,
    baseline = 'none', surrogatesPerClip = 8, clearanceSec = 30, seed = 17,
  } = {}) {
    const bins = [];
    for (let t = -preSec; t <= postSec; t += stepSec) bins.push(t);
    const rnd = seededRandom(seed);
    const clips = [];
    const surrogates = [];

    for (const s of sessions || []) {
      const raw = (s.metrics || [])
        .map((r) => ({ t: Number(r.t), v: r[feature] == null ? null : Number(r[feature]) }))
        .filter((r) => Number.isFinite(r.t));
      if (raw.length < 10) continue;
      // Normalised per session BEFORE clipping, so every clip from every sit is on one
      // scale without any event-locked structure being removed.
      const z = zBySession(raw.map((r) => r.v));
      const rows = raw.map((r, i) => ({ t: r.t, v: z[i] }));

      const marks = (s.notes || [])
        .filter((n) => n && n.anchored !== false && Number.isFinite(Number(n.offsetSec)))
        .map((n) => ({ at: Number(n.offsetSec),
          kind: n.transition || n.tapCategory || n.markKind || null }))
        .filter((m) => m.kind);
      const wanted = marks.filter((m) => !category || m.kind === category);
      const tMin = rows[0].t, tMax = rows[rows.length - 1].t;

      for (const m of wanted) {
        if (m.at - preSec < tMin || m.at + postSec > tMax) continue;   // clipped by the edge
        const c = clipAt(rows, 'v', m.at, bins, { stepSec });
        if (c) clips.push({ sessionId: s.sessionId, atSec: m.at, kind: m.kind,
          values: applyBaseline(c, bins, baseline) });
      }

      // Surrogates: clear of EVERY mark, not only the ones in this category — a window
      // next to a different kind of tap is not an unmarked moment.
      const want = Math.round(wanted.length * surrogatesPerClip);
      let tries = 0, made = 0;
      while (made < want && tries < want * 40) {
        tries++;
        const at = tMin + preSec + rnd() * Math.max(0, (tMax - postSec) - (tMin + preSec));
        if (marks.some((m) => Math.abs(m.at - at) < clearanceSec)) continue;
        const c = clipAt(rows, 'v', at, bins, { stepSec });
        if (!c) continue;
        surrogates.push({ sessionId: s.sessionId, atSec: at,
          values: applyBaseline(c, bins, baseline) });
        made++;
      }
    }

    const real = stackClips(clips.map((c) => c.values), bins);
    const surr = stackClips(surrogates.map((c) => c.values), bins);
    /* The band is the surrogate mean plus/minus twice its standard error, scaled to the
     * number of REAL clips: the question is whether this many random windows would have
     * produced this average, so the band has to represent the spread of an average of n,
     * not the spread of hundreds. */
    const scale = clips.length ? Math.sqrt(surrogates.length / clips.length) : 1;
    const band = bins.map((_, b) => {
      if (surr.mean[b] == null || surr.se[b] == null) return null;
      const half = 2 * surr.se[b] * (Number.isFinite(scale) && scale > 0 ? scale : 1);
      return { lo: surr.mean[b] - half, hi: surr.mean[b] + half, mid: surr.mean[b] };
    });
    // How far outside the band the real average goes, and where. Reported rather than
    // interpreted: with a handful of clips this is a thing to look at, not a test.
    let peak = null;
    bins.forEach((t, b) => {
      if (real.mean[b] == null || !band[b]) return;
      const out = real.mean[b] > band[b].hi ? real.mean[b] - band[b].hi
        : real.mean[b] < band[b].lo ? band[b].lo - real.mean[b] : 0;
      if (out > 0 && (!peak || out > peak.excess)) peak = { atSec: t, excess: out };
    });

    return { bins, feature, category, baseline, clips, surrogates,
      average: real.mean, se: real.se, nAt: real.n, band,
      n: clips.length, surrogateN: surrogates.length, peak };
  }

  return {
    zBySession, clipAt, applyBaseline, stackClips, epochLibrary,
    MIN_N, mean, sd, correlate, rank, spearman, permutationP,
    adjustForMultiplicity, splitSessions, search, unitsFromSpans,
    eventLocked, eventLockedNull, eventLockedTest,
    seededRandom, shuffle,
    NOT_A_SIGNAL, seriesKeys, slope, windowFeatures, unitsFromMarks,
    MIN_WINDOW_PAIRS, windowCorr, spearmanP, detectableRho, betai,
  };
});
