const assert = require('assert');
const VizCore = require('./public/viz-core.js');

// 1) Every electrode has a DISTINCT hue. This is the regression test for the
//    "still no color" bug — the old shader computed one highlight colour and
//    reused it for all four bands, making the image structurally monochrome.
{
  assert.strictEqual(VizCore.CHANNEL_COLORS.length, 4, 'need one colour per electrode');
  const seen = new Set(VizCore.CHANNEL_COLORS.map((c) => c.join(',')));
  assert.strictEqual(seen.size, 4, 'all four channel colours must be different from each other');
  for (const [r, g, b] of VizCore.CHANNEL_COLORS) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    assert.ok(max - min > 40, `each colour needs real saturation, not grey (got ${r},${g},${b})`);
  }
  console.log('✓ each electrode has a distinct, saturated hue');
}

// 2) Mode cycling wraps around and never leaves the valid range.
{
  assert.ok(VizCore.MODES.length >= 4, 'should offer at least 4 visuals to cycle');
  let idx = 0;
  const visited = [];
  for (let i = 0; i < VizCore.MODES.length * 2; i++) {
    visited.push(idx);
    idx = VizCore.nextMode(idx);
    assert.ok(idx >= 0 && idx < VizCore.MODES.length, `mode index must stay in range (got ${idx})`);
  }
  assert.strictEqual(idx, 0, 'cycling a full number of times should return to the start');
  assert.strictEqual(new Set(visited).size, VizCore.MODES.length, 'cycling should visit every mode');
  console.log('✓ mode cycling wraps correctly and visits every mode');
}

// 3) EventDetector: hysteresis means ordinary wobble in the middle produces
//    NO events. (Without hysteresis, a value oscillating across a single
//    threshold would fire endlessly — the same class of bug as the spike
//    detector firing every tick.)
{
  const det = new VizCore.EventDetector({ hi: 0.62, lo: 0.42 });
  det.update({ calm: 0.5 }); // establish starting zone (no event expected)
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const calm = 0.52 + 0.06 * Math.sin(i * 1.1); // 0.46..0.58 — inside the dead band
    total += det.update({ calm }).length;
  }
  assert.strictEqual(total, 0, `wobble inside the hysteresis band must produce no events (got ${total})`);
  console.log('✓ EventDetector ignores wobble inside the hysteresis band');
}

// 4) EventDetector: a real settle and a real stir each fire exactly once.
{
  const det = new VizCore.EventDetector({ hi: 0.62, lo: 0.42 });
  det.update({ calm: 0.5 });                       // starting zone, no event
  const up = det.update({ calm: 0.8 });            // crossed above hi
  assert.deepStrictEqual(up.map((e) => e.type), ['settled'], 'crossing above hi should fire "settled" once');
  const stay = det.update({ calm: 0.85 });         // still high
  assert.strictEqual(stay.length, 0, 'staying high should not re-fire');
  const down = det.update({ calm: 0.2 });          // crossed below lo
  assert.deepStrictEqual(down.map((e) => e.type), ['stirred'], 'crossing below lo should fire "stirred" once');
  console.log('✓ EventDetector fires settle/stir transitions exactly once each');
}

// 5) EventDetector: fresh spikes fire; a decaying tail does not.
{
  const det = new VizCore.EventDetector();
  const fresh = det.update({ calm: 0.5, spikes: [1.0, 0.0, 0.0, 0.0] });
  assert.strictEqual(fresh.filter((e) => e.type === 'spike').length, 1, 'a fresh spike should fire one event');
  assert.strictEqual(fresh[0].channel, 0, 'the event should name the channel that spiked');
  const tail = det.update({ calm: 0.5, spikes: [0.7, 0.0, 0.0, 0.0] });
  assert.strictEqual(tail.filter((e) => e.type === 'spike').length, 0, 'a decaying spike tail must not re-fire');
  console.log('✓ EventDetector fires on fresh spikes only, not the decay tail');
}

// 6) BloomField: lifecycle — emerges (alpha rises), fades, then is pruned.
{
  const field = new VizCore.BloomField({ max: 20, life: 1000 });
  field.spawn({ x: 0.5, y: 0.5, color: [255, 0, 0], strength: 1, at: 0 });
  const early = field.update(100);
  const mid = field.update(500);
  const late = field.update(900);
  assert.strictEqual(early.length, 1, 'bloom should exist early on');
  assert.ok(mid[0].alpha > early[0].alpha, 'alpha should rise as the bloom emerges');
  assert.ok(mid[0].alpha > late[0].alpha, 'alpha should fall again as it fades');
  assert.ok(late[0].radius > early[0].radius, 'radius should grow over the bloom lifetime');
  assert.strictEqual(field.update(1100).length, 0, 'an expired bloom must be pruned');
  console.log('✓ BloomField blooms emerge, expand, fade, and get pruned');
}

// 7) BloomField: bounded — a long session cannot grow the list without limit.
{
  const field = new VizCore.BloomField({ max: 5, life: 100000 });
  for (let i = 0; i < 50; i++) field.spawn({ x: 0, y: 0, color: [1, 2, 3], at: i });
  assert.strictEqual(field.blooms.length, 5, `bloom list must stay bounded (got ${field.blooms.length})`);
  assert.strictEqual(field.blooms[0].born, 45, 'the oldest blooms should be the ones dropped');
  console.log('✓ BloomField stays bounded under sustained events');
}

// 8) wobble(): bounded and smooth — it must not drift or blow up over a long
//    session, and consecutive samples must stay close together.
{
  let min = Infinity, max = -Infinity, maxJump = 0, prev = VizCore.wobble(0, 1);
  for (let t = 0; t < 20000; t += 0.05) {
    const v = VizCore.wobble(t, 1);
    min = Math.min(min, v); max = Math.max(max, v);
    maxJump = Math.max(maxJump, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(min > -1.01 && max < 1.01, `wobble must stay bounded in ~[-1,1] (got ${min.toFixed(3)}..${max.toFixed(3)})`);
  assert.ok(maxJump < 0.1, `wobble must be smooth, no sudden jumps (largest step ${maxJump.toFixed(4)})`);
  console.log('✓ wobble stays bounded and smooth even after a very long session');
}

console.log('\nAll viz-core tests passed.');
