const assert = require('assert');
const Metrics = require('./public/metrics.js');

// 1) Every metric declares a valid tier, what it is computed from, and what it
//    cannot tell you. This is the whole point of the registry: no metric may
//    exist without its own honesty label attached.
{
  assert.ok(Metrics.METRICS.length >= 6, 'expected a real set of metrics');
  for (const m of Metrics.METRICS) {
    assert.ok(Metrics.TIERS[m.tier], `metric "${m.key}" has an unknown tier: ${m.tier}`);
    assert.ok(m.source && m.source.length > 15, `metric "${m.key}" must say what it is computed from`);
    assert.ok(m.caveat && m.caveat.length > 25, `metric "${m.key}" must carry a caveat`);
    assert.ok(m.label && m.label.length, `metric "${m.key}" needs a display label`);
  }
  const keys = Metrics.METRICS.map((m) => m.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'metric keys must be unique');
  console.log('✓ every metric declares a tier, a source, and a caveat');
}

// 2) REGRESSION GUARD against overclaiming. These three have no validated
//    real-time marker on 4-channel consumer EEG. If anyone later promotes them
//    to a confident tier, this test should stop it.
{
  for (const key of ['equanimity', 'openness', 'asymmetry']) {
    assert.strictEqual(Metrics.tierOf(key), 'speculative',
      `"${key}" must stay speculative — there is no validated marker for it on this hardware`);
  }
  // And the ones that ARE direct signal signatures should say so.
  for (const key of ['blink', 'jaw']) {
    assert.strictEqual(Metrics.tierOf(key), 'solid', `"${key}" is a real signal signature`);
  }
  // Calm is a hand-built proxy, not a measurement — it must never claim 'solid'.
  assert.strictEqual(Metrics.tierOf('calm'), 'moderate', 'calm is a proxy, not a measurement');
  console.log('✓ speculative metrics cannot be silently promoted to measurements');
}

// 3) Speculative metrics are never offered as defaults — selectable on purpose,
//    but nothing unvalidated should silently drive the whole screen.
{
  const defaults = Metrics.defaultSelectable();
  for (const key of ['equanimity', 'openness', 'asymmetry']) {
    assert.ok(!defaults.includes(key), `"${key}" must not be a default selection`);
  }
  assert.ok(defaults.includes('calm') && defaults.includes('thinking'), 'proxies may be defaults');
  console.log('✓ speculative metrics are opt-in only, never defaults');
}

// 4) Missing inputs must yield null, NOT zero. A metric with no data reading as
//    0 would be indistinguishable from a real measurement of "none".
{
  for (const m of Metrics.METRICS) {
    assert.strictEqual(Metrics.compute(m.key, {}), null,
      `"${m.key}" must return null with no inputs, not a fabricated number`);
  }
  assert.strictEqual(Metrics.compute('nonexistent', { calm: 0.5 }), null, 'unknown keys return null');
  console.log('✓ metrics with no data return null rather than a fabricated zero');
}

// 5) Every computation stays within 0..1 across adversarial inputs.
{
  const extremes = [0, 1, -5, 5, 0.5];
  for (const m of Metrics.METRICS) {
    for (const v of extremes) {
      const f = {
        calm: v, activity: v, thetaLevel: v, deltaLevel: v, alphaLevel: v, betaLevel: v,
        variability: v, blink: v, jaw: v, alphaLeft: v, alphaRight: -v, hrvSteadiness: v,
      };
      const out = Metrics.compute(m.key, f);
      if (out === null) continue;
      assert.ok(Number.isFinite(out), `"${m.key}" produced a non-finite value for input ${v}`);
      assert.ok(out >= 0 && out <= 1, `"${m.key}" left 0..1 (got ${out}) for input ${v}`);
    }
  }
  console.log('✓ all metric computations stay finite and within 0..1');
}

// 6) Directional sanity on the two that carry a confound warning.
{
  // Focus should fall when the signal is unstable, even with the same theta.
  const steady = Metrics.compute('focus', { thetaLevel: 0.8, variability: 0.1 });
  const churny = Metrics.compute('focus', { thetaLevel: 0.8, variability: 0.9 });
  assert.ok(steady > churny, 'focus should reward steadiness, not just theta presence');

  // Drowsy should rise with theta+delta and fall as alpha returns.
  const sleepy = Metrics.compute('drowsy', { thetaLevel: 0.9, deltaLevel: 0.9, alphaLevel: 0.1 });
  const awake = Metrics.compute('drowsy', { thetaLevel: 0.2, deltaLevel: 0.2, alphaLevel: 0.9 });
  assert.ok(sleepy > awake, 'drowsy should distinguish a sleepy profile from an alert one');
  console.log('✓ focus rewards steadiness; drowsy separates sleepy from alert');
}

// 7) Caveats must actually state a limitation, not just describe the metric.
//    The drowsiness confound in particular MUST be disclosed on calm and focus,
//    because the same band changes look like settling and like falling asleep.
{
  assert.ok(/drowsi|sleep/i.test(Metrics.get('calm').caveat),
    'calm must disclose that it cannot distinguish settled from sleepy');
  assert.ok(/drowsi|sleep/i.test(Metrics.get('focus').caveat),
    'focus must disclose the drowsiness confound');
  assert.ok(/not|cannot|no /i.test(Metrics.get('thinking').caveat),
    'thinking must state what it cannot read');
  assert.ok(/no established|no validated/i.test(Metrics.get('equanimity').caveat),
    'equanimity must state plainly that no established marker exists');
  console.log('✓ caveats disclose real limitations, including the drowsiness confound');
}

console.log('\nAll metric tests passed.');
