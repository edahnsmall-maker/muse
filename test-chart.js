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

console.log('\nAll chart tests passed.');
