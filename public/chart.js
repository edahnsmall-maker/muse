/*
 * Small, pure charting helpers — data/scaling math only, no canvas calls,
 * so the parts that are easy to get subtly wrong (buffer capping, coordinate
 * mapping) are unit-testable under Node, same discipline as dsp.js. The
 * actual canvas drawing (in direct.html) is thin and direct on top of this.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Chart = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Fixed-capacity history — oldest values drop off the front once full.
  class History {
    constructor(maxLen) {
      this.maxLen = maxLen;
      this.values = [];
    }
    push(v) {
      this.values.push(v);
      if (this.values.length > this.maxLen) this.values.shift();
    }
  }

  // Maps a value in [min,max] to a canvas Y coordinate (0 = top, height =
  // bottom — canvas Y grows downward, so high values need small Y). Clamps
  // out-of-range input rather than letting a line fly off the chart.
  function valueToY(value, height, min = 0, max = 100) {
    const clamped = Math.max(min, Math.min(max, value));
    return height - ((clamped - min) / (max - min)) * height;
  }

  /*
   * Right-aligns the series to the current time — the most recent value is
   * always at the right edge, so a buffer that isn't full yet leaves empty
   * space on the LEFT (scrolling in from empty), not the right.
   *
   * A NULL VALUE YIELDS A NULL POINT, and the caller must break the line there.
   * "No reading" has to look different from "a reading that happens to be
   * mid-range", and it did not: a channel whose electrode never made contact was
   * graphed as a confident flat line at exactly 50 — see the note in sampleHistory.
   * The index still advances across nulls, so a gap keeps its place on the time axis
   * instead of sliding the rest of the series sideways.
   */
  function seriesToPoints(values, width, height, maxLen, min = 0, max = 100) {
    return values.map((v, i) => {
      const idx = maxLen - values.length + i;
      const x = maxLen > 1 ? (idx / (maxLen - 1)) * width : width;
      return v == null ? null : [x, valueToY(v, height, min, max)];
    });
  }

  // Contiguous runs of real points, for a caller that draws one path per run.
  // Single points are kept rather than dropped: a channel that worked for one second
  // in the middle of a sit should leave a mark, not vanish.
  function segments(points) {
    const out = [];
    let run = [];
    for (const p of points) {
      if (p) { run.push(p); continue; }
      if (run.length) out.push(run);
      run = [];
    }
    if (run.length) out.push(run);
    return out;
  }

  return { History, valueToY, seriesToPoints, segments };
});
