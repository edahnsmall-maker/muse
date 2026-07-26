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

// 9) Breathing patterns: 'Follow me' has no fixed pattern; the others do.
{
  const byKey = Object.fromEntries(VizCore.BREATH_PATTERNS.map((p) => [p.key, p]));
  assert.strictEqual(VizCore.breathPattern(byKey.measured, 3), null,
    '"Follow me" should have no fixed pattern (it tracks the measured rate)');
  const box = byKey.box;
  assert.ok(box, 'a box-breathing pattern should exist');
  assert.strictEqual(box.phases.reduce((s, p) => s + p[1], 0), 16, 'box 4·4·4·4 should total 16s');
  console.log('✓ breathing patterns include Follow-me plus fixed classical patterns');
}

// 10) Box breathing: inhale rises, hold genuinely HOLDS (does not drift),
//     exhale falls, hold-out holds at empty. This is the property the user
//     asked for — "slow in and slow out", steady, with real pauses.
{
  const box = VizCore.BREATH_PATTERNS.find((p) => p.key === 'box');
  const at = (t) => VizCore.breathPattern(box, t);
  assert.ok(at(0.2).amount < at(2).amount && at(2).amount < at(3.8).amount, 'inhale should rise');
  assert.strictEqual(at(0).phase, 'in');
  // 4..8s is the hold — amount must be pinned at 1 the entire time
  for (let t = 4.05; t < 7.95; t += 0.2) {
    assert.strictEqual(at(t).amount, 1, `hold must stay full, no drift (t=${t.toFixed(2)})`);
    assert.strictEqual(at(t).label, 'Hold');
  }
  assert.ok(at(8.2).amount > at(10).amount && at(10).amount > at(11.8).amount, 'exhale should fall');
  // 12..16s is the hold-out — pinned at 0
  for (let t = 12.05; t < 15.95; t += 0.2) {
    assert.strictEqual(at(t).amount, 0, `hold-out must stay empty (t=${t.toFixed(2)})`);
  }
  console.log('✓ box breathing rises, truly holds, falls, and truly holds empty');
}

// 11) Patterns are continuous across the cycle boundary — no visible jump
//     when the cycle wraps, and bounded in [0,1] everywhere.
{
  for (const p of VizCore.BREATH_PATTERNS.filter((x) => x.phases)) {
    const total = p.phases.reduce((s, q) => s + q[1], 0);
    let prev = VizCore.breathPattern(p, 0).amount;
    let maxJump = 0;
    for (let t = 0; t < total * 3; t += 0.02) {
      const a = VizCore.breathPattern(p, t).amount;
      assert.ok(a >= 0 && a <= 1, `${p.key}: amount must stay in [0,1] (got ${a} at t=${t.toFixed(2)})`);
      maxJump = Math.max(maxJump, Math.abs(a - prev));
      prev = a;
    }
    // A jump only occurs at in->hold / out->holdOut joins, which are equal by
    // construction, so nothing should exceed a small per-step delta.
    assert.ok(maxJump < 0.05, `${p.key}: must be continuous, largest step was ${maxJump.toFixed(4)}`);
  }
  console.log('✓ every breathing pattern is continuous and bounded across cycle wrap');
}

// 12) Pattern cycling wraps like mode cycling.
{
  let i = 0;
  const seen = new Set();
  for (let n = 0; n < VizCore.BREATH_PATTERNS.length; n++) { seen.add(i); i = VizCore.nextPattern(i); }
  assert.strictEqual(seen.size, VizCore.BREATH_PATTERNS.length, 'should reach every pattern');
  assert.strictEqual(i, 0, 'should wrap back to the first');
  console.log('✓ breathing-pattern cycling wraps correctly');
}

// 13) expand(): stretches the band an adaptively-normalised score actually
//     occupies to a full 0..1. Without this, calm/activity sit near 0.5 and a
//     visual property driven by them barely moves — the real cause of "the
//     void didn't change" and "the corona is busy even when I'm focusing".
{
  assert.strictEqual(VizCore.expand(0.35), 0, 'the bottom of the band maps to 0');
  assert.strictEqual(VizCore.expand(0.75), 1, 'the top of the band maps to 1');
  assert.ok(Math.abs(VizCore.expand(0.55) - 0.5) < 1e-9, 'the middle maps to the middle');
  assert.strictEqual(VizCore.expand(0.1), 0, 'below the band clamps to 0');
  assert.strictEqual(VizCore.expand(0.99), 1, 'above the band clamps to 1');
  assert.strictEqual(VizCore.expand(null), 0.5, 'missing input falls back to neutral, not NaN');
  assert.strictEqual(VizCore.expand(NaN), 0.5, 'NaN falls back to neutral');
  assert.strictEqual(VizCore.expand(0.5, 0.5, 0.5), 0.5, 'a degenerate band must not divide by zero');
  // The whole point: a realistic swing must produce a large output swing.
  const swing = VizCore.expand(0.70) - VizCore.expand(0.45);
  assert.ok(swing > 0.5, `a realistic 0.45->0.70 swing should move the output a lot (got ${swing.toFixed(2)})`);
  console.log('✓ expand() turns a realistic score swing into a large visual swing');
}

// ---- Pulse: the clock-sweep ring ------------------------------------------
{
  // 12 bins over a 12-second revolution => one bin per second, which makes the
  // clock positions checkable by hand.
  const ring = new VizCore.SweepRing({ bins: 12, revSec: 12 });
  assert.strictEqual(ring.binAt(0), 0, 'twelve o\'clock is bin 0');
  assert.strictEqual(ring.binAt(3), 3, 'three o\'clock is a quarter of the way round');
  assert.strictEqual(ring.binAt(12), 0, 'a full revolution resets to twelve');
  assert.strictEqual(ring.binAt(13.5), 1, 'the second revolution keeps going round');
  assert.strictEqual(ring.binAt(-1), 11, 'negative time must not produce a negative bin');
  console.log('✓ SweepRing maps time onto clock positions and wraps at twelve');
}

{
  // A gap in frames must not leave stale values from the previous revolution
  // sitting in the bins the hand skipped over.
  const ring = new VizCore.SweepRing({ bins: 12, revSec: 12 });
  ring.write(0, 0.1);
  ring.write(5, 0.9);            // jumps five bins in one call
  for (let b = 1; b <= 5; b++) {
    assert.strictEqual(ring.values[b], 0.9, `bin ${b} should have been filled in on the way past`);
  }
  console.log('✓ SweepRing fills every bin the hand crossed, not just the one it landed on');
}

{
  // The described behaviour: a bulge laid down at three o'clock is still there,
  // smaller, when the hand reaches nine — and gone by the time it comes back.
  // leadIn disabled here so this test measures the tail alone; the lead-in
  // taper gets its own test below.
  const ring = new VizCore.SweepRing({ bins: 12, revSec: 12 });
  const fade = (b) => ring.faded(b, 1.15, 0);
  ring.write(3, 1);
  const atThree = fade(3);
  ring.write(6, 0);
  const atSix = fade(3);
  ring.write(9, 0);
  const atNine = fade(3);
  assert.ok(atThree > 0.9, `fresh bulge should be near full (got ${atThree.toFixed(2)})`);
  assert.ok(atSix < atThree && atSix > 0.4, `should have faded but still be visible (got ${atSix.toFixed(2)})`);
  assert.ok(atNine < atSix && atNine > 0.05, `should be nearly gone (got ${atNine.toFixed(2)})`);
  // Nearly all the way round again: the bulge has faded to a few percent and is
  // about to be overwritten, so the trail dies out rather than meeting itself.
  ring.write(14.5, 0);
  const almostRound = fade(3);
  assert.ok(almostRound < 0.08, `a revolution later the bulge should be a few percent (got ${almostRound.toFixed(3)})`);
  ring.write(15.1, 0);           // the hand now reaches bin 3 and overwrites it
  assert.strictEqual(ring.values[3], 0, 'passing over a bin replaces its value outright');
  console.log('✓ SweepRing bulges persist and fade over one revolution, then vanish');
}

{
  // The seam. Without a lead-in the freshest bin sits at full height right next
  // to the oldest bin at zero — adjacent in space, a revolution apart in time —
  // and that draws as a hard step. With it, the trail tapers at both ends and
  // closes on itself. This was clearly visible in a headless screenshot before
  // the fix, which is how it was found.
  const ring = new VizCore.SweepRing({ bins: 144, revSec: 5 });
  for (let i = 0; i <= 200; i++) ring.write(i * 0.02, 1);   // 4s of a constant 1
  const cur = ring.cursor;
  const newest = ring.faded(cur);
  const oldest = ring.faded((cur + 1) % 144);
  assert.ok(Math.abs(newest - oldest) < 0.1,
    `bins either side of the wrap must not differ much or the seam shows (newest ${newest.toFixed(3)}, oldest ${oldest.toFixed(3)})`);
  // ...and somewhere in between the trail must actually reach full height, or
  // the taper has flattened the whole thing.
  let maxV = 0;
  for (let b = 0; b < 144; b++) maxV = Math.max(maxV, ring.faded(b));
  assert.ok(maxV > 0.85, `the trail must still peak near full height (got ${maxV.toFixed(2)})`);
  console.log('✓ SweepRing tapers at both ends, so the wrap seam is invisible');
}

{
  // Angular smoothing. Physiological scores jitter second to second, and one
  // bin per sample renders that as a seismograph outline — sharp spikes that
  // read as a broken shape rather than a bleeding gradient. Found in a headless
  // screenshot; this pins the fix.
  const ring = new VizCore.SweepRing({ bins: 144, revSec: 24 });
  for (let i = 0; i <= 1200; i++) {
    // A smooth underlying rise with alternating jitter on top.
    const t = i * 0.02;
    ring.write(t, 0.5 + 0.3 * Math.sin(t / 6) + (i % 2 ? 0.18 : -0.18));
  }
  const rough = ring.profile({ smoothBins: 1 });
  const smooth = ring.profile({ smoothBins: 9 });
  const roughness = (a) => {
    let sum = 0;
    for (let b = 0; b < a.length; b++) sum += Math.abs(a[b] - a[(b + 1) % a.length]);
    return sum;
  };
  assert.ok(roughness(smooth) < roughness(rough) * 0.4,
    `smoothing must remove most of the bin-to-bin jitter (${roughness(rough).toFixed(2)} -> ${roughness(smooth).toFixed(2)})`);
  // But it must not flatten the real signal away.
  const span = Math.max(...smooth) - Math.min(...smooth);
  assert.ok(span > 0.3, `the underlying rise and fall must survive smoothing (span ${span.toFixed(2)})`);
  // And it must WRAP, or the smoothing reintroduces the seam it exists to avoid.
  const wrapJump = Math.abs(smooth[0] - smooth[smooth.length - 1]);
  const typical = roughness(smooth) / smooth.length;
  assert.ok(wrapJump < typical * 6,
    `smoothing must wrap around twelve o'clock (jump ${wrapJump.toFixed(4)} vs typical ${typical.toFixed(4)})`);
  console.log('✓ SweepRing.profile smooths bin jitter, keeps the real signal, and wraps');
}

{
  const ring = new VizCore.SweepRing({ bins: 12, revSec: 12 });
  ring.write(0, null);
  ring.write(1, NaN);
  ring.write(2, 5);
  ring.write(3, -4);
  ring.values.forEach((v, b) => {
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `bin ${b} must stay a clean 0..1 (got ${v})`);
  });
  console.log('✓ SweepRing clamps nulls, NaN and out-of-range input to a usable 0..1');
}

{
  // Deviation, not level, is what should flare. A metric parked at a constant
  // value settles toward its own baseline and stops shouting; a metric that
  // MOVES flares regardless of which direction it moved.
  const dev = new VizCore.DeviationTracker();
  let steady = 0;
  for (let i = 0; i < 400; i++) steady = dev.update(0.6);
  const jumpUp = dev.update(0.95);
  const dev2 = new VizCore.DeviationTracker();
  for (let i = 0; i < 400; i++) dev2.update(0.6);
  const jumpDown = dev2.update(0.2);
  assert.ok(jumpUp > steady + 0.2, `a jump up should flare well above steady (${steady.toFixed(2)} -> ${jumpUp.toFixed(2)})`);
  assert.ok(jumpDown > steady + 0.2, `a jump DOWN should flare too (${steady.toFixed(2)} -> ${jumpDown.toFixed(2)})`);
  // ...but a steadily-high metric must still register something, or the ring
  // would claim nothing is happening during sustained calm.
  const high = new VizCore.DeviationTracker();
  let settledHigh = 0;
  for (let i = 0; i < 400; i++) settledHigh = high.update(0.95);
  const low = new VizCore.DeviationTracker();
  let settledLow = 0;
  for (let i = 0; i < 400; i++) settledLow = low.update(0.05);
  assert.ok(settledHigh > settledLow, 'a sustained high metric should still have more presence than a sustained low one');
  assert.ok(settledHigh <= 1 && settledLow >= 0, 'output stays in range');
  console.log('✓ DeviationTracker flares on change in either direction, keeps some level presence');
}

{
  const dev = new VizCore.DeviationTracker();
  assert.strictEqual(dev.update(null), 0, 'no data must read as no activity, not NaN');
  assert.strictEqual(dev.update(NaN), 0, 'NaN must read as no activity');
  const v = dev.update(4);
  assert.ok(v >= 0 && v <= 1, `out-of-range input must clamp (got ${v})`);
  console.log('✓ DeviationTracker handles missing and out-of-range input');
}

{
  const keys = VizCore.PULSE_METRICS.map((m) => m.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate metrics on the dial');
  VizCore.PULSE_METRICS.forEach((m) => {
    assert.ok(m.label && Array.isArray(m.color) && m.color.length === 3,
      `${m.key} needs a label and an [r,g,b] colour`);
    m.color.forEach((c) => assert.ok(c >= 0 && c <= 255, `${m.key} colour channel out of range`));
  });
  const hues = new Set(VizCore.PULSE_METRICS.map((m) => m.color.join(',')));
  assert.strictEqual(hues.size, VizCore.PULSE_METRICS.length, 'each metric needs its own distinct colour');
  console.log('✓ PULSE_METRICS are distinct, labelled, and have valid colours');
}

{
  // expandSoft saturates instead of clamping: a hard clamp draws every big
  // excursion as a flat line pressed against the edge of the frame, which shows
  // up in screenshots as flat-topped peaks.
  const f = VizCore.expandSoft;
  assert.ok(f(0.55) > 0.49 && f(0.55) < 0.51, 'mid-band maps to mid-range');
  assert.ok(f(0.75) < 1 && f(0.75) > 0.8, 'top of band is high but not pinned');
  assert.ok(f(0.35) > 0 && f(0.35) < 0.2, 'bottom of band is low but not pinned');
  // The property that matters: beyond the band it must still be monotonic.
  assert.ok(f(1.2) > f(0.95) && f(0.95) > f(0.75), 'excursions above the band stay distinguishable');
  assert.ok(f(-0.4) < f(0.1) && f(0.1) < f(0.35), 'excursions below the band stay distinguishable');
  // Over the real domain — every metric is clamped to 0..1 upstream — it must
  // never actually touch the limits, because touching them is what draws as a
  // flat line pressed against the edge of the frame. (Far outside that domain
  // tanh saturates to exactly 1 in float64, which is fine and unreachable here.)
  assert.ok(f(1) < 1 && f(1) > 0.99, `top of the real domain is high but not pinned (got ${f(1)})`);
  assert.ok(f(0) > 0 && f(0) < 0.01, `bottom of the real domain is low but not pinned (got ${f(0)})`);
  assert.strictEqual(f(null), 0.5, 'missing input is neutral');
  assert.strictEqual(f(NaN), 0.5, 'NaN is neutral');
  assert.strictEqual(f(0.5, 0.5, 0.5), 0.5, 'degenerate band must not divide by zero');
  console.log('\u2713 expandSoft saturates smoothly instead of clipping flat');
}

{
  // smoothSeries: expandSoft multiplies jitter by the same factor it multiplies
  // signal, so "the line is flat" was fixed straight into "the line is too
  // jumpy". Smoothing in TIME is the answer, and it must not lag.
  const f = VizCore.smoothSeries;
  assert.deepStrictEqual(f([], 5), [], 'empty input is empty output');
  assert.deepStrictEqual(f([1, 2, 3], 1), [1, 2, 3], 'a window of 1 is a no-op');

  // Alternating jitter on a constant signal must flatten out.
  const jitter = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.8 : 0.2));
  const sm = f(jitter, 9);
  const mid = sm.slice(10, 50);
  assert.ok(Math.max(...mid) - Math.min(...mid) < 0.1,
    `alternating jitter should flatten (span ${(Math.max(...mid) - Math.min(...mid)).toFixed(3)})`);

  // A real ramp must survive, and must NOT be shifted — a centred window has no
  // phase error, which matters because a lagging trace beside a non-lagging live
  // head looks wrong.
  const ramp = Array.from({ length: 100 }, (_, i) => i / 99);
  const sr = f(ramp, 9);
  assert.ok(Math.abs(sr[50] - ramp[50]) < 0.01, `a centred window must not shift a ramp (${sr[50]} vs ${ramp[50]})`);
  assert.ok(sr[80] > sr[50] && sr[50] > sr[20], 'the ramp must still be monotonic');

  // Nulls: neighbours are used where they exist, and a value with no usable
  // neighbours at all stays null rather than becoming a fabricated number.
  const withNulls = [null, null, 0.5, null, 0.5, null, null];
  const sn = f(withNulls, 3);
  assert.strictEqual(sn[0], null, 'a null with no usable neighbours stays null');
  assert.ok(sn[3] != null && Math.abs(sn[3] - 0.5) < 1e-9, 'a null between two readings is filled from them');
  assert.ok(f([null, null, null], 5).every((v) => v === null), 'all-null input stays all-null');
  console.log('\u2713 smoothSeries removes jitter, keeps the signal, does not lag, and respects nulls');
}

{
  // legendEntries must name what the renderer is actually drawing, in the same
  // order and the same colours. Generated from one source so it cannot drift —
  // the chart's electrode colours HAD drifted from the visual's, so a ribbon and
  // its own line on the graph were different colours.
  const sensors = VizCore.legendEntries({ composites: false });
  assert.strictEqual(sensors.length, 4, 'four electrodes');
  assert.deepStrictEqual(sensors.map((e) => e.label), VizCore.CHANNEL_LABELS,
    'labels must be the electrode names in order');
  sensors.forEach((e, i) => assert.deepStrictEqual(e.color, VizCore.CHANNEL_COLORS[i],
    `${e.label} must carry the colour the renderer draws it in`));

  const comps = VizCore.legendEntries({ composites: true });
  assert.strictEqual(comps.length, 4, 'four composites');
  assert.deepStrictEqual(comps.map((e) => e.label), VizCore.PULSE_METRICS.map((m) => m.label));
  comps.forEach((e, i) => assert.deepStrictEqual(e.color, VizCore.PULSE_METRICS[i].color));

  // The two sets must be genuinely different, or the switch tells you nothing.
  assert.notDeepStrictEqual(sensors.map((e) => e.label), comps.map((e) => e.label));

  const withBreath = VizCore.legendEntries({ composites: true, breath: true });
  assert.strictEqual(withBreath.length, 5, 'breath adds one entry');
  assert.strictEqual(withBreath[4].label, 'Breath', 'and comes last');
  assert.deepStrictEqual(withBreath[4].color, [255, 255, 255], 'drawn white, as the renderer draws it');
  // No breath data means no breath entry — a legend must not name something that
  // is not on screen.
  assert.ok(!VizCore.legendEntries({ breath: false }).some((e) => e.label === 'Breath'),
    'no breath signal means no breath entry');
  console.log('\u2713 legendEntries names exactly what is drawn, in matching colours');
}

console.log('\nAll viz-core tests passed.');
