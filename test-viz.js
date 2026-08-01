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

// 2) Mode cycling wraps around, never leaves the valid range, and SKIPS hidden
//    modes — otherwise the keyboard walks through visuals the picker doesn't offer.
{
  const visible = VizCore.visibleModes();
  assert.ok(visible.length >= 4, 'should offer at least 4 visuals to cycle');
  assert.ok(VizCore.MODES.length > visible.length,
    'this test is only meaningful while some modes are hidden');
  // Hidden modes keep their index: renumbering would silently repoint a stored
  // preference at a different visual.
  const visibleIdx = VizCore.MODES.map((m, i) => (m.hidden ? -1 : i)).filter((i) => i >= 0);
  let idx = visibleIdx[0];
  const seen = new Set();
  for (let i = 0; i < visible.length; i++) {
    seen.add(idx);
    assert.ok(!VizCore.MODES[idx].hidden,
      `cycling must never land on a hidden mode (landed on ${VizCore.MODES[idx].key})`);
    idx = VizCore.nextMode(idx);
    assert.ok(idx >= 0 && idx < VizCore.MODES.length, `mode index must stay in range (got ${idx})`);
  }
  assert.strictEqual(seen.size, visible.length, 'cycling must reach every visible mode');
  assert.strictEqual(idx, visibleIdx[0],
    'a full cycle of the VISIBLE modes should return to the start');
  // And cycling from a hidden index must escape rather than stick.
  const hiddenIdx = VizCore.MODES.findIndex((m) => m.hidden);
  if (hiddenIdx >= 0) {
    assert.ok(!VizCore.MODES[VizCore.nextMode(hiddenIdx)].hidden,
      'cycling from a hidden mode must land on a visible one');
  }
  let idx2 = visibleIdx[0];
  const visited = [];
  for (let i = 0; i < VizCore.MODES.length * 2; i++) { visited.push(idx2); idx2 = VizCore.nextMode(idx2); }
  assert.strictEqual(new Set(visited).size, visible.length,
    'cycling should visit every VISIBLE mode and no others');
  console.log(`✓ mode cycling wraps correctly and visits all ${visible.length} visible modes`
    + ` (${VizCore.MODES.length - visible.length} hidden but kept)`);
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

/* smoothSeries IS GONE — see the note where it used to live in viz-core.js. Its test
 * asserted, correctly, that a centred window "does not lag". That property was the reason
 * it was chosen and the reason it had to go: a centred window revises the smoothed value
 * of every sample near the head as later samples arrive, which redraws half a window of
 * already-drawn line four times a second. The replacement is causal and cached per sample
 * in visual.js, and the property that now matters — the recorded past never moves — is
 * measured in test-visual-smoke.js instead. */

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

/*
 * EVERY VISIBLE MODE MUST HAVE A KEY, and its colours must come from the array the
 * renderer actually indexes.
 *
 * Reported twice: "I don't know what these colors actually mean. Thinking and
 * drowsy." Only Flow had a legend, because the legend was drawn from inside
 * renderFlow and no other renderer called it.
 *
 * The sharper reason this test exists: the first Iris legend keyed TP9/AF7/AF8/TP10.
 * It was written by reading `renderIris` \u2014 but the `iris` mode dispatches to
 * `renderIrisSediment`, which colours the disc by MIND STATE and never touches a
 * channel hue. The legend would have named four electrodes for a picture that draws
 * none, and it would have been believed. So colours are checked against the shared
 * constants rather than eyeballed.
 */
{
  const visible = VizCore.visibleModes();
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const palettes = [
    VizCore.CHANNEL_COLORS,
    VizCore.CORONA_COLORS,
    VizCore.PULSE_METRICS.map((m) => m.color),
    Object.values(VizCore.IRIS_MOOD),
    // Silk's two swatches name the ends of a focus-driven warm/cool mix
    // (renderSilk), and white is Flow's breath trace.
    [[255, 150, 110], [80, 190, 250], [255, 255, 255]],
  ];
  const known = [].concat(...palettes);

  for (const m of visible) {
    const entries = VizCore.legendFor(m.key, { composites: false, breath: true });
    assert.ok(entries.length > 0,
      `"${m.label}" has no legend. Every visible mode needs one \u2014 a visual that reacts`
      + ' to your physiology without saying what it is reacting to cannot be used to'
      + ' notice anything, because a real change and a flourish look the same.'
      + ' Add an entry to VizCore.LEGENDS.');

    for (const e of entries) {
      assert.ok((e.color && e.label) || e.text,
        `"${m.label}" has an entry that is neither a swatch nor a note:`
        + ` ${JSON.stringify(e)}`);
      if (e.color) {
        assert.ok(known.some((c) => eq(c, e.color)),
          `"${m.label}" keys ${e.label} to ${JSON.stringify(e.color)}, which is not a`
          + ' colour any renderer draws. A legend colour must come from the same'
          + ' constant the renderer indexes, or the key and the picture disagree.');
      }
    }
  }

  // Iris specifically: it must NOT claim to be a channel key. The exact mistake that
  // was caught, written down so it cannot come back quietly.
  const iris = VizCore.legendFor('iris', {});
  assert.ok(!iris.some((e) => VizCore.CHANNEL_LABELS.includes(e.label)),
    'the Iris key must not name electrodes \u2014 renderIrisSediment colours the disc by'
    + ' mind state (VizCore.IRIS_MOOD) and never draws a per-channel hue');
  assert.ok(iris.some((e) => eq(e.color, VizCore.IRIS_MOOD.thinkingHi))
    && iris.some((e) => eq(e.color, VizCore.IRIS_MOOD.calmHi)),
    'and it must name the warm/cool ends that irisMindColor actually mixes');

  // Flow still follows the Sensors/Composites switch: its key has to change with it,
  // or flipping the switch silently relabels four lines.
  const flowSensors = VizCore.legendFor('flow', { composites: false });
  const flowComps = VizCore.legendFor('flow', { composites: true });
  assert.notDeepStrictEqual(flowSensors.map((e) => e.label), flowComps.map((e) => e.label),
    'Flow is the one mode that switches series, so its key must switch too');

  // A mode with no colour key still gets its words. Breath draws one form and is
  // explicitly "nothing to read" \u2014 but which direction is the in-breath is not
  // self-evident, and that is worth a line.
  const breath = VizCore.legendFor('breath', {});
  assert.ok(breath.length && breath.every((e) => e.text),
    'Breath has no colour key but must still say which way is in');

  console.log(`\u2713 all ${visible.length} visible modes have a key, and every colour`
    + ' in it comes from the renderer\u2019s own palette');
}

/*
 * AND EVERY LEGEND'S OWN SWATCHES MUST BE TELLABLE APART.
 *
 * test-ui.js already enforces a 60-unit RGB minimum on the chart series, for a reason it
 * records: colours that collide have twice made a correctly-drawn line look like a dead
 * metric. Putting the same palettes into on-canvas legends extends that exposure — and
 * Eclipse shipped a key whose TP9 and TP10 swatches were 51 apart, so two of the four
 * sensors read as one colour sitting right next to each other. Two swatches you cannot
 * distinguish are worse than none: you conclude a sensor is duplicated or dead.
 */
{
  const MIN = 60;
  const dist = (a, b) => Math.round(Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0)));
  let closest = { d: Infinity };
  for (const m of VizCore.visibleModes()) {
    const sw = VizCore.legendFor(m.key, { composites: false }).filter((e) => e.color);
    for (let i = 0; i < sw.length; i++) {
      for (let j = i + 1; j < sw.length; j++) {
        const d = dist(sw[i].color, sw[j].color);
        if (d < closest.d) closest = { d, mode: m.label, a: sw[i].label, b: sw[j].label };
        assert.ok(d >= MIN,
          `${m.label}: "${sw[i].label}" and "${sw[j].label}" are only ${d} apart in RGB`
          + ` (min ${MIN}). Side by side in the key they read as the same colour, so a`
          + ' sensor looks duplicated or dead.');
      }
    }
  }
  console.log(`\u2713 every legend's swatches are distinguishable (closest: ${closest.mode}`
    + ` ${closest.a}/${closest.b} at ${closest.d})`);
}

/*
 * AUTO-RANGING: the fix for "it looks like it's compressed on the bottom third".
 *
 * Flow maps every series onto one vertical band, and the expansion curve it used assumed
 * the values were already adaptively normalised into roughly 0.35..0.75. True of the
 * composites; FALSE of the per-channel series, which is a raw alpha/(alpha+beta) ratio.
 * A beta-dominant sit — eyes open, thinking, i.e. most of them — sits near 0.2 on every
 * electrode, so every trace pinned to the floor of the band.
 */
{
  // A low, narrow, moving series must be spread across the band, not pinned to an end.
  const low = [];
  for (let i = 0; i < 60; i++) low.push(0.18 + 0.05 * Math.sin(i / 6));
  const r = VizCore.autoRange(low);
  const ys = low.map((v) => VizCore.inRange(v, r));
  assert.ok(Math.min(...ys) < 0.15 && Math.max(...ys) > 0.85,
    `a series living around 0.2 must still use the full band (got ${Math.min(...ys).toFixed(2)}`
    + `..${Math.max(...ys).toFixed(2)}) — pinning it to the floor is the reported bug`);

  // ROBUST TO A SPIKE. One artifact must not set the top of the range and flatten
  // everything else, which is what min/max would do.
  const spiky = low.slice();
  spiky[30] = 0.95;
  const rs = VizCore.autoRange(spiky);
  const spread = low.map((v) => VizCore.inRange(v, rs));
  assert.ok(Math.max(...spread) - Math.min(...spread) > 0.5,
    'a single spike must not squash the rest of the trace — percentiles, not min/max');
  assert.strictEqual(VizCore.inRange(0.95, rs), 1,
    'and the spike itself is pinned to the edge, not allowed off the band');

  /* minSpan IS THE HONESTY GUARD. A channel that genuinely did not move must not have
     its own noise stretched to fill the frame and read as violent activity — that
     invents a signal, which is worse than the squashing this fixes. */
  const flat = [];
  for (let i = 0; i < 60; i++) flat.push(0.5 + 0.001 * Math.sin(i));
  const rf = VizCore.autoRange(flat);
  const fys = flat.map((v) => VizCore.inRange(v, rf));
  assert.ok(Math.max(...fys) - Math.min(...fys) < 0.1,
    `a genuinely steady series must stay steady on screen (got a spread of`
    + ` ${(Math.max(...fys) - Math.min(...fys)).toFixed(3)})`);
  assert.ok(Math.abs((Math.max(...fys) + Math.min(...fys)) / 2 - 0.5) < 0.1,
    'and sit in the MIDDLE of the band, not pushed against an edge');

  assert.strictEqual(VizCore.autoRange([0.5, 0.5]), null,
    'too little history to know a range must refuse rather than invent one');
  assert.strictEqual(VizCore.inRange(0.5, null), null, 'and a null range yields no position');
  console.log('✓ traces scale to their own recent range, survive a spike, and a steady'
    + ' line stays steady rather than being amplified into noise');
}

/*
 * AND THE AXIS MUST HOLD STILL.
 *
 * Reported immediately after auto-ranging shipped: "the entire line seemed to sort of sink
 * and raise a little bit almost arbitrarily... it feels like the axes are unstable."
 * Correct, and it is the direct cost of recomputing the range every frame — the same range
 * is applied to the whole visible history, so any change to it moves every past sample.
 * A history plot whose recorded past appears to move is worse than one with a poor scale.
 */
{
  const dt = 1 / 60;
  const r = (min, max) => ({ min, max, span: max - min });

  // First frame adopts the target outright: there is nothing to be stable relative to.
  assert.deepStrictEqual(VizCore.settleRange(null, r(0.2, 0.5), dt), r(0.2, 0.5));
  assert.strictEqual(VizCore.settleRange(null, null, dt), null);

  /* WIDENING IS FAST BUT NOT INSTANT — a reversal, and the old assertion here read
   * "a range must widen at once, never clip". The argument was that flattening a real
   * excursion against the edge of the band is worse than nudging the axis. What that
   * missed is that the axis applies to the WHOLE visible history, so widening it in one
   * frame moves every recorded sample in that frame. Measured on a channel reading zero
   * for a few seconds: 6.14% of the band in a single frame, settling 36% away.
   * A clipped excursion is local and obviously transient. A sliding past is neither. */
  let w = r(0.2, 0.5);
  const wideOne = VizCore.settleRange(w, r(0.1, 0.9), dt);
  assert.ok(wideOne.min < w.min && wideOne.max > w.max, 'it must widen in the right direction');
  assert.ok(w.min - wideOne.min < 0.01 && wideOne.max - w.max < 0.01,
    `a single frame must not widen the axis visibly (moved ${(w.min - wideOne.min).toFixed(4)})`);
  // The per-frame cap, stated as the requirement it is: for the largest plausible jump,
  // one frame must move a recorded sample less than 1% of the band.
  const jump = VizCore.settleRange(r(0.3, 0.7), r(0.0, 1.0), dt);
  assert.ok(jump.min - 0.3 > -0.01 && jump.max - 0.7 < 0.01,
    `one frame of a 60%-of-band widening must move under 1% (moved ${(0.3 - jump.min).toFixed(4)})`);

  // But it must get there quickly — a genuine excursion clipped for more than a few
  // seconds stops reading as transient and starts reading as a wrong scale.
  for (let i = 0; i < 60 * 4; i++) w = VizCore.settleRange(w, r(0.1, 0.9), dt);
  assert.ok(Math.abs(w.min - 0.1) < 0.02 && Math.abs(w.max - 0.9) < 0.02,
    `four seconds must be enough to take on a real excursion (got ${w.min.toFixed(3)}..${w.max.toFixed(3)})`);
  // And widening must still be much faster than narrowing, or a spike sets the scale for
  // the rest of the sit.
  assert.ok((w.min - VizCore.settleRange(w, r(0.1, 0.9), dt).min) >= 0
    && Math.abs(VizCore.settleRange(r(0.2, 0.5), r(0.1, 0.9), dt).min - 0.2)
       > Math.abs(VizCore.settleRange(r(0.1, 0.9), r(0.2, 0.5), dt).min - 0.1),
    'widening must be faster than narrowing');

  // NARROWING IS SLOW. One frame must barely move it.
  let cur = r(0.1, 0.9);
  const oneFrame = VizCore.settleRange(cur, r(0.4, 0.6), dt);
  assert.ok(oneFrame.min - cur.min < 0.01 && cur.max - oneFrame.max < 0.01,
    `a single frame must barely narrow the range (moved ${(oneFrame.min - cur.min).toFixed(4)})`);

  /* But it MUST converge eventually, or one spike would widen the axis for the rest of
     the sit. The release time constant is 1/rate ≈ 17s by design, so 90 seconds is the
     window that demonstrates convergence — a shorter check would be asserting a faster
     release than the stability this exists for can afford. */
  for (let i = 0; i < 60 * 90; i++) cur = VizCore.settleRange(cur, r(0.4, 0.6), dt);
  assert.ok(Math.abs(cur.min - 0.4) < 0.02 && Math.abs(cur.max - 0.6) < 0.02,
    `it must still converge given time (got ${cur.min.toFixed(3)}..${cur.max.toFixed(3)})`);

  /* THE MEASUREMENT THAT MATTERS: how far a drawn point moves between frames when the
     underlying data is steady but its percentiles jitter, as real sampled data does.
     This is what "the line sinks and raises" actually is. */
  let held = null, worst = 0, prevY = null;
  let seed = 21;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let f = 0; f < 600; f++) {
    const jitter = 0.02 * (rnd() - 0.5);
    held = VizCore.settleRange(held, r(0.30 + jitter, 0.50 + jitter), dt);
    const y = VizCore.inRange(0.40, held);       // a fixed value, i.e. a recorded sample
    if (prevY != null) worst = Math.max(worst, Math.abs(y - prevY));
    prevY = y;
  }
  assert.ok(worst < 0.02,
    `a recorded sample must not jump between frames while the data is steady —`
    + ` worst frame-to-frame move was ${(worst * 100).toFixed(1)}% of the band`);
  console.log(`✓ the axis holds still: widens fast but not instantly, narrows slowly, and a recorded`
    + ` sample moves at most ${(worst * 100).toFixed(2)}% of the band between frames`);
}

/*
 * A LINE THAT IS NOT DRAWN MUST NOT BE IN THE KEY.
 *
 * Reported as "the two flat lines": TP9 and TP10 artifact-flagged for a whole sit and
 * drawn as dead-straight horizontals across the middle. They are omitted from the
 * picture now, and a key still naming them would send the reader looking for a line
 * that was never there and concluding it was flat.
 */
{
  const all = VizCore.legendFor('flow', { composites: false });
  assert.ok(all.some((e) => e.label === 'TP9') && all.some((e) => e.label === 'TP10'),
    'precondition: all four electrodes are keyed when all four are reading');
  const some = VizCore.legendFor('flow', { composites: false, omitSeries: ['TP9', 'TP10'] });
  assert.deepStrictEqual(some.filter((e) => e.label).map((e) => e.label), ['AF7', 'AF8'],
    'an electrode with no contact must be absent from the key, not merely dimmed');
  // The relative-scale caption has to be there, because vertical position no longer
  // means a level: two lines crossing is not two values becoming equal.
  assert.ok(some.some((e) => e.text && /own recent range/.test(e.text)),
    'and the key must say the height is relative');
  const none = VizCore.legendFor('flow',
    { composites: false, omitSeries: ['TP9', 'AF7', 'AF8', 'TP10'] });
  assert.deepStrictEqual(none, [],
    'with nothing drawn there is no key at all — not a lone caption describing nothing');
  console.log('✓ the key names only what is on screen, and says the height is relative');
}

console.log('\nAll viz-core tests passed.');
