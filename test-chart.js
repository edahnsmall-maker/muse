const assert = require('assert');
const Chart = require('./public/chart.js');

// 1) History caps at maxLen, keeping only the most recent values.
{
  const h = new Chart.History(5);
  for (let i = 1; i <= 8; i++) h.push(i);
  assert.deepStrictEqual(h.values, [4, 5, 6, 7, 8], `should keep only the last 5, got ${h.values}`);
  console.log('✓ History caps at maxLen and drops the oldest values');
}

// 2) valueToY: 0 -> bottom, 100 -> top, 50 -> middle; out-of-range clamps.
{
  const height = 200;
  assert.strictEqual(Chart.valueToY(0, height), 200, '0 should map to the bottom (y = height)');
  assert.strictEqual(Chart.valueToY(100, height), 0, '100 should map to the top (y = 0)');
  assert.strictEqual(Chart.valueToY(50, height), 100, '50 should map to the vertical middle');
  assert.strictEqual(Chart.valueToY(150, height), 0, 'above max should clamp to the top, not fly off-canvas');
  assert.strictEqual(Chart.valueToY(-20, height), 200, 'below min should clamp to the bottom');
  console.log('✓ valueToY maps and clamps correctly');
}

// 3) seriesToPoints: a FULL buffer spans the whole width, first point at x=0,
//    last point at x=width.
{
  const maxLen = 10, width = 300, height = 100;
  const full = Array.from({ length: maxLen }, (_, i) => i * 10); // 0..90
  const pts = Chart.seriesToPoints(full, width, height, maxLen);
  assert.strictEqual(pts.length, maxLen);
  assert.ok(Math.abs(pts[0][0] - 0) < 1e-9, `first point should be at x=0, got ${pts[0][0]}`);
  assert.ok(Math.abs(pts[pts.length - 1][0] - width) < 1e-9, `last point should be at x=width, got ${pts[pts.length-1][0]}`);
  console.log('✓ a full series spans the entire chart width');
}

// 4) seriesToPoints: a PARTIAL buffer is right-aligned — the most recent
//    point is still at x=width, empty space is on the left, not the right.
{
  const maxLen = 10, width = 300, height = 100;
  const partial = [10, 20, 30]; // only 3 of 10 slots filled
  const pts = Chart.seriesToPoints(partial, width, height, maxLen);
  assert.strictEqual(pts.length, 3);
  assert.ok(Math.abs(pts[pts.length - 1][0] - width) < 1e-9,
    `most recent point should still be at the right edge, got ${pts[pts.length-1][0]}`);
  assert.ok(pts[0][0] > 0, 'a partial series should NOT start at x=0 — it should be right-aligned with empty space on the left');
  console.log('✓ a partial series is right-aligned (scrolls in from empty on the left)');
}

/*
 * 5) A MISSING READING IS A GAP, NOT A VALUE.
 *
 * Reported as "any clues as to why TP10 looks dead?" — and it looked dead in the most
 * misleading way available: a perfectly flat line straight through the middle of the
 * chart. That line came from no data at all. sampleHistory used to push the previous
 * value when a channel had no valid reading, or 50 when there had never been one, so an
 * electrode that never touched the head was graphed as a rock-steady, perfectly
 * balanced channel — the most confident-looking line on the plot.
 */
{
  const maxLen = 10, width = 300, height = 100;

  // A channel that never reported: every value null.
  const dead = Array.from({ length: 6 }, () => null);
  const deadPts = Chart.seriesToPoints(dead, width, height, maxLen);
  assert.strictEqual(deadPts.length, 6, 'nulls still occupy their slots on the time axis');
  assert.ok(deadPts.every((p) => p === null), 'a null value must not become a point');
  assert.deepStrictEqual(Chart.segments(deadPts), [],
    'a channel that never reported must draw NOTHING — not a flat line at mid-range,'
    + ' which is what made a disconnected electrode look like a steady signal');

  // A dropout in the middle must break the line rather than bridge it: a bridge
  // asserts values nobody measured.
  const gappy = [10, 20, null, null, 60, 70, 80];
  const pts = Chart.seriesToPoints(gappy, width, height, maxLen);
  const runs = Chart.segments(pts);
  assert.strictEqual(runs.length, 2, `a dropout must split the line in two (got ${runs.length})`);
  assert.strictEqual(runs[0].length, 2);
  assert.strictEqual(runs[1].length, 3);
  // The sample after the gap must keep its own time position — the gap holds its place
  // rather than the later samples sliding left to fill it.
  const solid = [10, 20, 30, 40, 60, 70, 80];
  const solidPts = Chart.seriesToPoints(solid, width, height, maxLen);
  assert.ok(Math.abs(runs[1][0][0] - solidPts[4][0]) < 1e-9,
    'the sample after a gap must keep its own time position');

  // A single surviving reading is kept as a point, not swallowed: a channel that
  // worked for one second should leave a mark.
  const blip = [null, null, 42, null, null];
  const blipRuns = Chart.segments(Chart.seriesToPoints(blip, width, height, maxLen));
  assert.strictEqual(blipRuns.length, 1, 'one good reading is still a run');
  assert.strictEqual(blipRuns[0].length, 1);

  console.log('✓ a missing reading is a gap: a dead channel draws nothing, a dropout'
    + ' breaks the line, and gaps keep their place in time');
}

console.log('\nAll chart tests passed.');
