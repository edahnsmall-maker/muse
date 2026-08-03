/*
 * CAN THIS DISPLAY TELL YOUR BRAIN FROM NOISE?
 *
 * WHY THIS EXISTS. Every visual in this app is driven through an adaptive normaliser, which
 * rescales its input against that input's own recent range. That is the right thing for making a
 * narrow signal visible — and it has a consequence nobody had checked: a normaliser guarantees the
 * display uses its full range whether or not the input carries any information. So a beautiful,
 * responsive-looking visual driven by noise is indistinguishable from one driven by signal.
 *
 * Measured, on a real recorded sit against synthetic inputs, after the normaliser:
 *
 *   real recorded calm    sweeps  5% of the display range
 *   pure white noise      sweeps  5%
 *   a random walk         sweeps 12%
 *
 * Not "approximately alike" — identical, and the random walk (which contains no information about
 * anything) swept MORE than the real data. On that evidence the honest description of the visuals
 * is decorative, and the honest thing to do is say so on screen rather than in a comment.
 *
 * THE TEST. Take a real series and a SHUFFLED copy of it. Shuffling destroys all temporal
 * structure — the order, the trends, the excursions, everything a state could express itself as —
 * while preserving the distribution exactly: same values, same mean, same variance, same
 * histogram. So anything that survives shuffling is not information about time, and anything the
 * display shows for both equally is not being shown because of the signal.
 *
 * A SHUFFLE RATHER THAN FRESH NOISE, deliberately. Comparing against generated noise confounds two
 * questions: whether the display responds to structure, and whether the generated noise happened to
 * have a similar amplitude. A shuffle has the same amplitude by construction, so the only thing
 * that differs is order. It is the same surrogate logic the lab already uses for marks.
 *
 * WHAT THE ANSWER MEANS. `discrimination` is how much more the display moves on the real series
 * than on its own shuffle. 1.0 means it cannot tell them apart at all. Below about 1.2 the display
 * is decoration. This is a statement about the DISPLAY PIPELINE, not about the brain: a signal can
 * be real and still be flattened into invisibility by the transform in front of it, and that is
 * itself worth knowing, because it is fixable in a way that a missing signal is not.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SelfCheck = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * Below this, the display is not showing you the signal.
   *
   * Set from what the shuffle can produce by chance rather than chosen: with a few hundred samples,
   * a shuffled copy of a structureless series lands within a few percent of the original's spread,
   * so a ratio under about 1.2 is inside the noise of the comparison itself. A display that scores
   * 1.05 is not "slightly informative", it is indistinguishable, and rounding that up to a
   * reassuring number would be the exact failure this module exists to catch.
   */
  const DECORATIVE_BELOW = 1.2;
  // And a series shorter than this cannot support the comparison — the shuffle has too few
  // arrangements to be a fair surrogate.
  const MIN_SAMPLES = 60;

  function seededRandom(seed) {
    let s = (seed | 0) || 1;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  // Fisher-Yates, seeded, so a reported number can be re-derived rather than re-rolled until it
  // flatters.
  function shuffled(values, rnd) {
    const a = values.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /*
   * The spread of what actually reaches the screen.
   *
   * Percentiles rather than min-to-max: one artifact spike would otherwise set the range and make
   * every comparison a comparison of outliers. The same 5th-to-95th choice the visuals' own
   * auto-ranging uses, for the same reason.
   */
  function spread(values, { lo = 0.05, hi = 0.95 } = {}) {
    const a = values.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
    if (a.length < 4) return null;
    const at = (p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
    return at(hi) - at(lo);
  }

  /*
   * Run a series and its shuffle through the same transform and compare what comes out.
   *
   * `transform` is whatever the app puts between the raw metric and the geometry — in practice an
   * adaptive normaliser plus an expansion curve. It is passed in rather than imported so this
   * module makes no assumption about the pipeline, and so a test can check a KNOWN-good and a
   * KNOWN-bad transform and see the two answers differ.
   *
   * `repeats` shuffles more than once, because a single shuffle can be lucky. The median is taken:
   * a mean would be dragged by one unusual arrangement, which is the same reason the lab uses
   * medians for its surrogate bands.
   */
  function check(series, transform, { seed = 11, repeats = 5 } = {}) {
    const clean = (series || []).filter((v) => v != null && Number.isFinite(v));
    if (clean.length < MIN_SAMPLES) {
      return { known: false, discrimination: null, realSpread: null, shuffledSpread: null,
        samples: clean.length, decorative: false,
        reason: `only ${clean.length} samples; ${MIN_SAMPLES} are needed for the shuffle to be a`
          + ' fair comparison' };
    }
    const realSpread = spread(transform(clean.slice()));
    if (realSpread == null) {
      return { known: false, discrimination: null, realSpread: null, shuffledSpread: null,
        samples: clean.length, decorative: false,
        reason: 'the transform produced nothing measurable' };
    }
    const rnd = seededRandom(seed);
    const spreads = [];
    for (let i = 0; i < repeats; i++) {
      const s = spread(transform(shuffled(clean, rnd)));
      if (s != null) spreads.push(s);
    }
    if (!spreads.length) {
      return { known: false, discrimination: null, realSpread, shuffledSpread: null,
        samples: clean.length, decorative: false,
        reason: 'the transform produced nothing measurable on the shuffled series' };
    }
    spreads.sort((a, b) => a - b);
    const shuffledSpread = spreads[Math.floor(spreads.length / 2)];
    /* A ZERO SHUFFLED SPREAD IS NOT INFINITE DISCRIMINATION. It means the transform collapsed the
       surrogate entirely, which is a degenerate transform rather than a triumph — so it is reported
       as unknown instead of as the best possible score. */
    if (!(shuffledSpread > 0)) {
      return { known: false, discrimination: null, realSpread, shuffledSpread,
        samples: clean.length, decorative: false,
        reason: 'the shuffled series produced no spread at all, so the ratio is undefined' };
    }
    const discrimination = realSpread / shuffledSpread;
    return {
      known: true,
      discrimination,
      realSpread,
      shuffledSpread,
      samples: clean.length,
      decorative: discrimination < DECORATIVE_BELOW,
      reason: null,
    };
  }

  /*
   * The sentence to put on screen.
   *
   * Written to be readable by the person meditating, and written so the bad news is the plain
   * reading. "Cannot distinguish" rather than "low discrimination", because the second is the kind
   * of phrasing that lets a reader assume it is a minor calibration issue.
   */
  function describe(result, label = 'this display') {
    if (!result || !result.known) {
      return `Not enough data to check whether ${label} is showing signal or noise`
        + (result && result.reason ? ` — ${result.reason}.` : '.');
    }
    const d = result.discrimination;
    if (result.decorative) {
      return `${label} cannot distinguish your recorded signal from a shuffled copy of it`
        + ` (${d.toFixed(2)}× — 1.00 would be no difference at all). Whatever it is showing you,`
        + ' it is not this measurement. Treat it as decoration until this number rises.';
    }
    if (d < 2) {
      return `${label} responds about ${d.toFixed(1)}× more to your real signal than to a shuffled`
        + ' copy of it. That is real but weak — the shape you see is mostly the display, not you.';
    }
    return `${label} responds ${d.toFixed(1)}× more to your real signal than to a shuffled copy of`
      + ' it, so what it shows is genuinely about the recording.';
  }

  return { check, describe, spread, shuffled, seededRandom, DECORATIVE_BELOW, MIN_SAMPLES };
});
