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

/* ---- NO INVENTED COEFFICIENTS -----------------------------------------------------
 *
 * This is the invariant the whole file rests on, and it was violated for a long time while the
 * prose beside it was scrupulous. The caveats said "a proxy of a proxy" and "no established marker
 * for equanimity"; the arithmetic said:
 *
 *   focus     = thetaLevel * (1 - 0.55 * variability)
 *   drowsy    = 0.5*theta + 0.5*delta - 0.35*alpha + 0.17
 *   openness  = 0.55*alpha + 0.25*(1-beta) + 0.20*(1-variability)
 *   asymmetry = 0.5 + 0.5*tanh((L-R) * 2)
 *
 * Nine numbers, none of them measured, several to two decimal places, and one (+0.17) existing
 * only to drag a subtraction back into range. Weights like that are worse than no weights: they
 * create the appearance of calibration where there is none, and a reader has no way to tell an
 * invented 0.55 from a fitted one. The project's fifth non-negotiable asks "does this present a
 * guess as a measurement?" — and it was being honoured in English and broken in JavaScript.
 *
 * Every composite is now a RATIO or a GEOMETRIC MEAN: bounded by construction, and with nothing to
 * tune. This test reads the source of compute() and fails if a number outside a tiny justified set
 * reappears, so the next weighted sum has to argue for itself here.
 */
{
  const raw = Metrics.compute.toString();
  /* COMMENTS STRIPPED FIRST. The invariant is about the arithmetic, not the prose — and the
     comments deliberately quote every coefficient that was removed, so scanning the raw source
     reported 0.55, 0.45, 0.35, 0.17, 0.25 and 0.2 as offenders when all six appear only inside an
     explanation of why they are gone. A guard that cannot tell code from a comment about code
     would force the history to be deleted to satisfy it, which is the wrong direction. */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  // Numeric literals, ignoring property access and array indices.
  const nums = (src.match(/(?<![\w.$])\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
  /* THE JUSTIFIED SET, each with a reason:
   *   0, 1   the bounds of every metric, and the identity for a "1 minus" complement.
   *   0.5    the centre of a two-sided index (balanced laterality), and the only defensible
   *          stand-in for an unknown 0..1 input — the midpoint asserts nothing.
   *   2      dividing by two where a mean is taken. Not a tuning knob. */
  const ALLOWED = new Set([0, 1, 0.5, 2]);
  const offenders = Array.from(new Set(nums.filter((n) => !ALLOWED.has(n))));
  assert.deepStrictEqual(offenders, [],
    'compute() must contain no invented coefficients — found ' + JSON.stringify(offenders)
    + '. A weighted sum with hand-picked weights presents a guess as a calibration. Use a ratio or'
    + ' a geometric mean, or fit the weights against labelled data in the lab.');

  // And no tanh/pow with a chosen gain, which is the other way a knob hides.
  assert.ok(!/tanh|Math\.pow/.test(src),
    'compute() must not shape a curve with a chosen gain: ' + (src.match(/.{0,40}tanh.{0,40}/) || [''])[0]);

  /* THE FORMS MUST STILL BEHAVE, or parameter-free would just mean broken. Each of these is the
     property the old weighted version was trying to buy, checked on the new form. */
  // A geometric mean makes both conditions necessary: absent theta is zero focus, however steady.
  assert.strictEqual(Metrics.compute('focus', { thetaLevel: 0, variability: 0 }), 0,
    'no theta must mean no focus — the weighted form returned 0.45 of nothing');
  assert.ok(Metrics.compute('focus', { thetaLevel: 0.8, variability: 0.1 })
    > Metrics.compute('focus', { thetaLevel: 0.8, variability: 0.9 }),
    'and steadiness must still matter');
  // Drowsy is a share, so it is bounded without an intercept and orders the profiles correctly.
  const dSleepy = Metrics.compute('drowsy', { thetaLevel: 0.9, deltaLevel: 0.9, alphaLevel: 0.1 });
  const dAwake = Metrics.compute('drowsy', { thetaLevel: 0.1, deltaLevel: 0.1, alphaLevel: 0.9 });
  assert.ok(dSleepy > 0.9 && dAwake < 0.25,
    `a share must separate the extremes cleanly (sleepy ${dSleepy}, awake ${dAwake})`);
  // Openness must NOT let high alpha buy its way past a churning signal — the weighted sum did.
  const oChurny = Metrics.compute('openness', { alphaLevel: 1, betaLevel: 0, variability: 1 });
  const oSteady = Metrics.compute('openness', { alphaLevel: 0.6, betaLevel: 0.4, variability: 0 });
  assert.strictEqual(oChurny, 0,
    'a fully churning signal cannot be open awareness whatever alpha does');
  assert.ok(oSteady > 0.5, 'while a steadier, weaker one can be');
  // Laterality is centred and symmetric, with no gain deciding how much is "a lot".
  assert.strictEqual(Metrics.compute('asymmetry', { alphaLeft: 0.5, alphaRight: 0.5 }), 0.5,
    'equal alpha must read exactly balanced');
  const left = Metrics.compute('asymmetry', { alphaLeft: 0.8, alphaRight: 0.2 });
  const right = Metrics.compute('asymmetry', { alphaLeft: 0.2, alphaRight: 0.8 });
  assert.ok(Math.abs((left - 0.5) + (right - 0.5)) < 1e-9,
    `the index must be symmetric about 0.5 (${left} / ${right})`);
  console.log('✓ no invented coefficients remain in compute(), and every parameter-free form keeps'
    + ' the property its weighted version was for');
}

/* ---- ELEVEN METRICS WAS TOO MANY TO PUT ON A SCREEN -------------------------------
 *
 * Of eleven, two were "solid" and both are artifacts — a blink and a clenched jaw are the most
 * trustworthy things this headband measures. The numbers a practitioner reads are all
 * moderate-to-speculative. Breadth also costs power: the lab's correction spends it per comparison,
 * so each extra displayed metric is roughly a tenth of an effect size that can no longer be found.
 */
{
  const shown = Metrics.displayed().map((m) => m.key);
  const all = Metrics.METRICS.map((m) => m.key);
  assert.ok(shown.length < all.length, 'something must have been retired from the display');

  // Retired on the strength of their own caveats, not on taste.
  for (const key of ['openness', 'asymmetry']) {
    assert.ok(!shown.includes(key), `${key} must not be on the live display`);
    const m = Metrics.get(key);
    assert.ok(m, `${key} must still EXIST — the lab computes it and the raw EEG is still kept`);
    assert.strictEqual(m.tier, 'speculative', `${key} is retired because it is exploratory`);
    assert.ok(Metrics.compute(key, { alphaLevel: 0.6, betaLevel: 0.3, variability: 0.2,
      alphaLeft: 0.6, alphaRight: 0.4 }) != null,
      `${key} must remain computable — retiring is not deleting`);
  }

  /* KEPT AT THE PRACTITIONER'S EXPLICIT REQUEST — "go for it all, but keep equanimity" — and
     therefore kept WITH its exploratory tier and its caveat intact, not quietly promoted. */
  assert.ok(shown.includes('equanimity'),
    'equanimity stays on the display: the practitioner asked for it directly');
  assert.strictEqual(Metrics.tierOf('equanimity'), 'speculative',
    'and it must keep its tier — being asked for is not evidence');
  assert.match(Metrics.get('equanimity').caveat, /NO established marker/i,
    'and its caveat must still say there is no established marker');
  console.log(`✓ the display is ${shown.length} of ${all.length} metrics`
    + ` (${shown.join(', ')}); the rest remain computable for the lab`);
}

console.log('\nAll metric tests passed.');
