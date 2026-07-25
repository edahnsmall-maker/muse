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

  // Right-aligns the series to the current time — the most recent value is
  // always at the right edge, so a buffer that isn't full yet leaves empty
  // space on the LEFT (scrolling in from empty), not the right.
  function seriesToPoints(values, width, height, maxLen, min = 0, max = 100) {
    return values.map((v, i) => {
      const idx = maxLen - values.length + i;
      const x = maxLen > 1 ? (idx / (maxLen - 1)) * width : width;
      return [x, valueToY(v, height, min, max)];
    });
  }

  return { History, valueToY, seriesToPoints };
});
