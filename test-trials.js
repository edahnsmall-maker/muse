/*
 * Tests for the trial protocols.
 *
 * The properties that matter are methodological rather than arithmetic: blocks must
 * alternate, the settling period must be excluded, and blocks within one sit must not
 * be treated as independent sessions. Each of those, if wrong, produces a result that
 * looks fine and means nothing.
 */
const assert = require('assert');
const T = require('./public/trials.js');
const A = require('./public/analysis.js');

// 1) The positive control must exist and must come first, because a meditation
//    finding from an unverified apparatus is worthless.
{
  assert.strictEqual(T.PROTOCOLS[0].key, 'alpha-control',
    'the eyes-closed control must be the first protocol offered — it checks the'
    + ' equipment, and nothing else can be trusted before it passes');
  const p = T.BY_KEY['alpha-control'];
  assert.match(p.purpose, /control/i);
  assert.match(p.expectation, /HIGHER/,
    'a control must state the expected DIRECTION in advance, or it cannot fail');
  assert.deepStrictEqual(p.conditions.map((c) => c.key), ['closed', 'open']);
  // Every protocol must say what it expects, before any data exists.
  for (const proto of T.PROTOCOLS) {
    assert.ok(proto.expectation && proto.expectation.length > 30,
      `${proto.key} must state its expectation in advance`);
    assert.ok(proto.purpose, `${proto.key} must say what it is for`);
    for (const c of proto.conditions) {
      assert.ok(c.instruction && c.instruction.length > 8,
        `${proto.key}/${c.key} needs an instruction that can be followed eyes-closed`);
      // Instructions must be concrete. A jargon check, crude but useful.
      assert.ok(!/meta-aware|attentional set|phenomenolog/i.test(c.instruction),
        `${proto.key}/${c.key} instruction must be plain enough to obey mid-sit`);
    }
  }
  console.log(`✓ ${T.PROTOCOLS.length} protocols, control first, each stating its expectation`);
}

// 2) BLOCKS MUST ALTERNATE. All of A then all of B would confound the condition with
//    time-in-sit perfectly: people settle, get drowsy, electrodes dry out.
{
  const run = T.buildBlocks('think-breath');
  assert.strictEqual(run.blocks.length, 10, '5 repeats x 2 conditions');
  const seq = run.blocks.map((b) => b.condition);
  for (let i = 1; i < seq.length; i++) {
    assert.notStrictEqual(seq[i], seq[i - 1],
      `blocks must alternate, or condition is confounded with time (got ${seq.join(',')})`);
  }
  // Balanced: equal numbers of each condition, or the comparison is lopsided.
  const counts = seq.reduce((m, c) => { m[c] = (m[c] || 0) + 1; return m; }, {});
  assert.strictEqual(counts.thinking, counts.breath, 'conditions must be balanced');

  // Contiguous and non-overlapping in time.
  for (let i = 1; i < run.blocks.length; i++) {
    assert.strictEqual(run.blocks[i].fromSec, run.blocks[i - 1].toSec,
      'blocks must tile the sit with no gaps or overlaps');
  }
  assert.strictEqual(run.totalSec, 600, '10 blocks of 60s');
  assert.strictEqual(T.durationSec('think-breath'), 600,
    'the duration must be knowable BEFORE starting, not discovered afterwards');

  // The starting side must be switchable, so it can alternate between sessions —
  // otherwise order and condition are confounded across the whole dataset instead of
  // within one sit.
  const flipped = T.buildBlocks('think-breath', { startWith: 1 });
  assert.strictEqual(flipped.blocks[0].condition, 'breath');
  assert.notStrictEqual(run.blocks[0].condition, flipped.blocks[0].condition);
  console.log('✓ blocks alternate, balance, tile the sit, and can start on either side');
}

// 3) THE SETTLING PERIOD must be excluded. A boundary is not instantaneous — it takes
//    seconds to actually start thinking on purpose — and including that transition
//    blurs both conditions.
{
  const run = T.buildBlocks('think-breath');
  for (const b of run.blocks) {
    assert.strictEqual(b.analyseFromSec, b.fromSec + 6, 'settle time must be skipped');
    assert.ok(b.analyseFromSec < b.toSec, 'and must not consume the whole block');
  }
  // And the runner must report which phase it is in, so the meditator is told when
  // the block actually starts counting.
  const settling = T.blockAt(run, 2);
  assert.strictEqual(settling.phase, 'settling');
  const recording = T.blockAt(run, 30);
  assert.strictEqual(recording.phase, 'recording');
  assert.strictEqual(recording.block.condition, run.blocks[0].condition);
  assert.strictEqual(Math.round(recording.remainingSec), 30);
  // Outside the run entirely.
  assert.strictEqual(T.blockAt(run, 10000), null);
  assert.strictEqual(T.blockAt(run, -1), null);

  // Boundary crossing fires ONCE, not on every tick.
  assert.strictEqual(T.crossedBoundary(run, 59, 61).index, 1, 'crossing into block 1');
  assert.strictEqual(T.crossedBoundary(run, 61, 62), null, 'and not again mid-block');
  /* STARTING THE RUN IS A CROSSING into block 0.
   *
   * The first version returned null here, so the opening block got no cue and no
   * record: the tone that begins the protocol never sounded, and the first block's
   * label was missing from the data. Every later block worked, which is how a bug like
   * this survives a glance at the output.
   */
  const opening = T.crossedBoundary(run, null, 0);
  assert.ok(opening, 'starting a run must count as entering the first block');
  assert.strictEqual(opening.index, 0);
  assert.strictEqual(T.crossedBoundary(run, null, 5).index, 0,
    'joining a few seconds in still means we are in block 0');
  assert.strictEqual(T.crossedBoundary(run, null, 99999), null,
    'but starting past the end of the run is not a crossing');
  console.log('✓ the settling period is excluded, phases are reported, cues fire once');
}

// 4) unitsFromRun: one observation per block, settle excluded, and NOT one session
//    per block — a trial run in a single sit cannot validate itself.
{
  const run = T.buildBlocks('think-breath');
  const metrics = [];
  for (let t = 0; t < run.totalSec; t++) {
    const at = T.blockAt(run, t);
    const thinking = at && at.block.condition === 'thinking';
    metrics.push({
      t, epochMs: t * 1000,
      // A planted difference, so the aggregation can be checked for direction.
      thinking: thinking ? 0.8 : 0.2,
      // And something that only differs during the settle window, which must be
      // excluded — if it leaks through, the exclusion is not working.
      settleOnly: (at && at.phase === 'settling') ? 1 : 0,
    });
  }
  const units = T.unitsFromRun(run, metrics, { sessionId: 'sit-1' });
  assert.strictEqual(units.length, 10, 'ten blocks, ten observations — not 600');
  assert.ok(units.every((u) => u.sessionId === 'sit-1'),
    'every block must carry the SAME session id: blocks in one sit are not independent'
    + ' sessions, and pretending otherwise leaks the answer into the held-out split');
  assert.strictEqual(new Set(units.map((u) => u.sessionId)).size, 1);

  const think = units.filter((u) => u.conditionKey === 'thinking');
  const breath = units.filter((u) => u.conditionKey === 'breath');
  assert.ok(think.every((u) => u.features.thinking > 0.7));
  assert.ok(breath.every((u) => u.features.thinking < 0.3));
  // THE EXCLUSION, checked by the feature that only exists during settling.
  assert.ok(units.every((u) => u.features.settleOnly === 0),
    'the settling window must be excluded from the averages, and it is not');
  assert.ok(units.every((u) => u.samples === 54), `60s block minus 6s settle (got ${units[0].samples})`);

  // Condition is emitted as an ordinal so it drops straight into a rank correlation.
  assert.deepStrictEqual(new Set(units.map((u) => u.labels.condition)), new Set([0, 1]));
  const s = A.spearman(units.map((u) => u.features.thinking), units.map((u) => u.labels.condition));
  assert.ok(Math.abs(s.rho) > 0.9, 'a planted block difference must correlate with condition');
  console.log('✓ one observation per block, settle excluded, blocks share one session id');
}

// 5) The control check: reports direction and effect size, and refuses when it cannot.
{
  const run = T.buildBlocks('alpha-control');
  // `jitter` exercises the normal path (real data always varies). jitter = 0
  // exercises the degenerate case: perfectly separated conditions, where the effect
  // size is formally infinite and must read as the STRONGEST result rather than as
  // unmeasurable — which is what the first version of controlCheck got wrong.
  const mk = (closedCalm, openCalm, jitter = 0.04) => {
    const metrics = [];
    let seed = 99;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let t = 0; t < run.totalSec; t++) {
      const at = T.blockAt(run, t);
      const closed = at && at.block.condition === 'closed';
      metrics.push({ t, calm: (closed ? closedCalm : openCalm) + rnd() * jitter });
    }
    return T.unitsFromRun(run, metrics, { sessionId: 's' });
  };

  // The expected result: calm clearly higher with eyes closed.
  const good = T.controlCheck(mk(0.7, 0.3), { feature: 'calm', expectHigherIn: 'closed' });
  assert.strictEqual(good.ok, true);
  assert.ok(good.difference > 0.3);

  // REVERSED — the interesting failure. Something in the signal chain is wrong.
  const reversed = T.controlCheck(mk(0.3, 0.7), { feature: 'calm', expectHigherIn: 'closed' });
  assert.strictEqual(reversed.ok, false,
    'a reversed control must FAIL — that is the whole point of running it');
  assert.ok(reversed.difference < 0);

  // No difference at all also fails: with a large known effect, absence is a fault.
  const flat = T.controlCheck(mk(0.5, 0.5), { feature: 'calm', expectHigherIn: 'closed' });
  assert.ok(flat.ok !== true, 'no difference must not pass a control for a large effect');

  // Perfect separation, zero within-condition variance. This is the BEST possible
  // outcome and must pass, not be reported as untestable.
  const perfect = T.controlCheck(mk(0.7, 0.3, 0), { feature: 'calm', expectHigherIn: 'closed' });
  assert.strictEqual(perfect.ok, true,
    'perfectly separated conditions are the strongest result, not an unmeasurable one');
  assert.strictEqual(perfect.effectSize, Infinity);
  // A truly constant feature is the genuinely unmeasurable case, and must fail with a
  // reason rather than pass or return null.
  const constant = T.controlCheck(mk(0.5, 0.5, 0), { feature: 'calm', expectHigherIn: 'closed' });
  assert.strictEqual(constant.ok, false);
  assert.match(constant.reason, /constant/);

  // And it must refuse rather than guess when the feature is absent.
  const missing = T.controlCheck(mk(0.7, 0.3), { feature: 'nonexistent', expectHigherIn: 'closed' });
  assert.strictEqual(missing.ok, null);
  assert.match(missing.reason, /not enough blocks/);
  assert.strictEqual(T.controlCheck([], {}).ok, null);
  console.log('✓ the control check passes the expected direction, fails a reversal, refuses on absence');
}

// 6) The control protocol must be short enough that somebody actually runs it. A
//    twenty-minute equipment check gets skipped, and then nothing is verified.
{
  const secs = T.durationSec('alpha-control');
  assert.ok(secs <= 420, `the control must take under 7 minutes (takes ${secs}s)`);
  assert.ok(secs >= 120, 'but long enough for several blocks per condition');
  const run = T.buildBlocks('alpha-control');
  const perCondition = run.blocks.filter((b) => b.condition === 'closed').length;
  assert.ok(perCondition >= 3,
    `at least 3 blocks per condition, or one odd block dominates (got ${perCondition})`);
  console.log(`✓ the control runs in ${Math.round(secs / 60)} minutes with`
    + ` ${perCondition} blocks per condition`);
}

console.log('\nAll trial tests passed.');
