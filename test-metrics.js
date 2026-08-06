const assert = require('assert');
const Metrics = require('./public/metrics.js');
const DSP = require('./public/dsp.js');

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
  /* Focus should fall when the signal is unstable, even with the same theta.
     `shares` rather than `thetaLevel`: every composite is built from absolute band shares now, and a
     normalised level is exactly what they stopped taking — see the note above DSP.bandShares. */
  const someTheta = DSP.bandShares({ theta: 4, alpha: 3, beta: 3 });
  const steady = Metrics.compute('focus', { shares: someTheta, variability: 0.1 });
  const churny = Metrics.compute('focus', { shares: someTheta, variability: 0.9 });
  assert.ok(steady > churny, 'focus should reward steadiness, not just theta presence');

  /*
   * DROWSY MUST SEPARATE ABSORPTION FROM SLEEP ONSET, which is the defect it was reported for.
   *
   * "the drowsiness is all off" — on a sit the practitioner described as "attentive, calm, slow
   * breathing", with the head accelerometer showing 90% stillness and no forward pitch drift, the old
   * formula read 0.59. It was theta against alpha, and frontal theta in absorbed meditation really is
   * about twice alpha, so it could not have done anything else.
   *
   * These two profiles are the whole problem in two lines: they have almost the same theta, and one is
   * someone meditating while the other is someone falling asleep. What differs is alpha — sustained in
   * absorption, attenuating at sleep onset — so ONLY a formula that reads alpha can tell them apart,
   * and a theta-vs-alpha ratio reads it in the wrong direction.
   *
   * The numbers are the measured shares from the 2026-08-06 retreat sit and a textbook N1 profile.
   */
  const absorbed = DSP.bandShares({ theta: 0.52, alpha: 0.21, beta: 0.27 });
  const sleepOnset = DSP.bandShares({ theta: 0.65, alpha: 0.10, beta: 0.25 });
  const alert = DSP.bandShares({ theta: 0.20, alpha: 0.20, beta: 0.60 });
  const dAbsorbed = Metrics.compute('drowsy', { shares: absorbed });
  const dSleep = Metrics.compute('drowsy', { shares: sleepOnset });
  const dAlert = Metrics.compute('drowsy', { shares: alert });
  assert.ok(dSleep > dAlert, 'drowsy should distinguish a sleepy profile from an alert one');
  assert.ok(dSleep > dAbsorbed * 1.4,
    `sleep onset must read clearly higher than absorbed meditation, whose theta is nearly as large`
    + ` (absorbed ${dAbsorbed.toFixed(2)} vs sleep ${dSleep.toFixed(2)})`);
  assert.ok(dAbsorbed < 0.4,
    `an absorbed sit must not read as half asleep (got ${dAbsorbed.toFixed(2)})`);
  /* AND THE OLD FORMULA MUST FAIL THIS, so the test is known to be measuring the fix and not passing
     for an unrelated reason. theta/(theta+alpha) puts absorption ABOVE sleep onset on this pair. */
  const oldWay = (sh) => sh.theta / (sh.theta + sh.alpha);
  assert.ok(oldWay(absorbed) > 0.6 && oldWay(sleepOnset) > 0.6,
    'the old theta-vs-alpha formula read both of these as drowsy — which is why it changed');
  console.log(`✓ focus rewards steadiness; drowsy separates absorbed meditation (${Math.round(100 * dAbsorbed)})`
    + ` from sleep onset (${Math.round(100 * dSleep)}) where theta-vs-alpha could not`
    + ` (${Math.round(100 * oldWay(absorbed))} vs ${Math.round(100 * oldWay(sleepOnset))})`);
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

  /*
   * THE GUARD FOLLOWS THE FORMULAS. This is the important half of this test now.
   *
   * The composites moved out of compute() and into dsp.js, and a guard that only reads compute() would
   * have congratulated itself on a clean file while every coefficient sat one module away. That is
   * exactly the failure mode this test was written to catch, arrived at by refactor rather than by a
   * weighted sum, so the scan follows them.
   *
   * The band-share formulas must stay parameter-free. `calmFromShares` is the ONE exception in the
   * project and is checked separately below, because its two numbers are a fitted display window with
   * six described sits behind them — the point is that it has to be declared here to exist, not that
   * fitting is forbidden.
   */
  const strip = (fn) => fn.toString().replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const name of ['bandShares', 'thinkingFromShares', 'drowsyFromShares', 'focusFromShares']) {
    const body = strip(DSP[name]);
    const found = Array.from(new Set((body.match(/(?<![\w.$])\d+(?:\.\d+)?(?:e-?\d+)?/g) || [])
      .map(Number).filter((n) => !ALLOWED.has(n))));
    assert.deepStrictEqual(found, [],
      `DSP.${name} must be parameter-free — found ${JSON.stringify(found)}. The composites moved here`
      + ' from Metrics.compute(); the rule moved with them.');
    assert.ok(!/tanh|Math\.pow/.test(body), `DSP.${name} must not shape a curve with a chosen gain`);
  }

  /*
   * CALM'S WINDOW IS DECLARED, NOT HIDDEN. Two fitted numbers, and the test's job is to make sure they
   * stay declared, stay monotone, and stay a display transform rather than becoming a second axis.
   */
  assert.ok(DSP.CALM_WINDOW && DSP.CALM_WINDOW.hi > DSP.CALM_WINDOW.lo,
    'the one fitted pair in the project must be a named, ordered constant');
  assert.ok(Object.isFrozen(DSP.CALM_WINDOW), 'and frozen, so nothing can adapt it per sit');
  {
    // MONOTONE, which is what makes it unable to reorder two sits — the failure it replaced.
    let prev = -1;
    for (let share = 0; share <= 1.0001; share += 0.01) {
      const v = DSP.calmFromShares({ alphaOfFast: share });
      assert.ok(v > prev, `calmFromShares must be strictly increasing (share ${share.toFixed(2)})`);
      assert.ok(v >= 0 && v <= 1, `and bounded (got ${v} at ${share.toFixed(2)})`);
      prev = v;
    }
    // SATURATING, never clamped: a share past the window must still read as further past it.
    const a = DSP.calmFromShares({ alphaOfFast: 0.60 });
    const b = DSP.calmFromShares({ alphaOfFast: 0.90 });
    assert.ok(b > a && b < 1,
      `beyond the window must saturate rather than clamp flat (${a.toFixed(4)} then ${b.toFixed(4)})`);
    /* THE SIX SITS. Each has an independent written description, and the ordering of the descriptions
       is the only ground truth this project has for Calm. If a change to the window breaks the
       ordering, or moves the calmest sit out of the 80s, this is where it shows. */
    const sits = [
      ['thinking pulling me a lot', 0.288 / 1.288],
      ['working, not meditating', 0.367 / 1.367],
      ['Zen mind, sneezed, sensors out', 0.356],
      ['very calm, not a lot of effort', 0.537 / 1.537],
      /* THE CONTRAST SESSION: 26 minutes at 11:46pm, "just a test, i'm trying to figure this out and
         it's noisy", with notes reading "noisy from TV" and "moving the mouse and listening to music".
         It exists in this list to hold the window honest. The first window shipped for this scored it 72,
         because the window had been fitted to four descriptions and never tested against a session that
         was deliberately NOT meditative. */
      ['NON-ZEN: TV, mouse, music', 0.373],
      ['relaxed, mind settling naturally', 0.654 / 1.654],
      ['85% Zen mind, attentive, calm', 0.445],
    ];
    const by = {};
    for (const [label, share] of sits) by[label] = Math.round(100 * DSP.calmFromShares({ alphaOfFast: share }));
    /* NOT A STRICT ORDERING OVER ALL SIX. Two of them differ by 0.005 of a share — "very calm, not a
       lot of effort" at 0.349 and the sneezed retreat sit at 0.354 — and asserting which of those comes
       first would be asserting noise. Order preservation in general is already proved by the
       monotonicity loop above, which holds for every pair; what is worth pinning here is that the
       described extremes land where their descriptions say, because that is the part a change to the
       window could break without breaking monotonicity. */
    assert.ok(by['thinking pulling me a lot'] < 25,
      `the worst sit must read low, not near 50 as the normalised score did`
      + ` (got ${by['thinking pulling me a lot']}, was 52.9)`);
    assert.ok(by['working, not meditating'] < 40,
      `and a working session must read clearly below the meditative ones (got ${by['working, not meditating']})`);
    assert.ok(by['85% Zen mind, attentive, calm'] >= 60,
      `the sit the practitioner called 85% Zen mind must read high`
      + ` (got ${by['85% Zen mind, attentive, calm']}, was 47)`);
    /*
     * AND MUST NOT PIN. Reported after the first widening: "the calm line is flatlining and hitting a
     * ceiling." That sit's share runs to p90 0.519 and max 0.539, and the window's top was 0.50 — so its
     * whole upper half sat in the tanh's saturating tail, where a large change in share moves the score
     * barely at all. 6% of the sit read 95 or higher.
     *
     * The window must therefore span the observed RANGE, not its middle 90%: the sits at the top of the
     * distribution are exactly the ones worth resolving. Asserted at the observed extremes rather than as
     * a mean, because a mean can look healthy while the top of every good sit is flat.
     */
    const atMax = Math.round(100 * DSP.calmFromShares({ alphaOfFast: 0.539 }));
    const atP90 = Math.round(100 * DSP.calmFromShares({ alphaOfFast: 0.519 }));
    assert.ok(atMax <= 92,
      `the highest share yet recorded (0.539) must leave headroom, not sit against the ceiling`
      + ` (got ${atMax}); a pinned score cannot show a better sit as better`);
    assert.ok(atMax - atP90 >= 2,
      `and the top of a good sit must still RESOLVE: p90 (0.519) and max (0.539) must differ by more`
      + ` than rounding (${atP90} vs ${atMax})`);
    // The all-time observed maximum across every recording must still be inside the scale.
    assert.ok(Math.round(100 * DSP.calmFromShares({ alphaOfFast: 0.676 })) < 100,
      'and the largest share ever recorded must not read as a literal 100');
    assert.ok(by['85% Zen mind, attentive, calm'] > by['Zen mind, sneezed, sensors out'],
      'and above the sit that was interrupted and lost its sensors');
    assert.ok(by['relaxed, mind settling naturally'] > by['working, not meditating'] + 25,
      'the gap between meditating and working must be large, not the 4 points the old score gave');
    /*
     * THE NON-ZEN SESSION MUST NOT SCORE AS A GOOD SIT. This is the assertion the first version of this
     * window would have failed, and it is here so the next attempt to widen the scale has to face it.
     * It is deliberately NOT "must score low": the honest finding is that this score cannot tell a
     * late-night TV session from a calm sit — their frontal alpha power was within 3% — so what is
     * pinned is the margin below the peak sit, not an absolute band.
     */
    assert.ok(by['NON-ZEN: TV, mouse, music'] < by['85% Zen mind, attentive, calm'] - 20,
      `a 26-minute session with the TV on and a mouse in hand must fall well below a peak sit`
      + ` (non-Zen ${by['NON-ZEN: TV, mouse, music']}, peak ${by['85% Zen mind, attentive, calm']}).`
      + ' The first window shipped scored it 72 against the peak sit\'s 91.');
    assert.ok(by['NON-ZEN: TV, mouse, music'] < 60,
      `and must not read as a good sit (got ${by['NON-ZEN: TV, mouse, music']})`);
  }

  /* THE FORMS MUST STILL BEHAVE, or parameter-free would just mean broken. Each of these is the
     property the old weighted version was trying to buy, checked on the new form. */
  // A geometric mean makes both conditions necessary: absent theta is zero focus, however steady.
  const noTheta = DSP.bandShares({ theta: 0, alpha: 1, beta: 1 });
  const someTh = DSP.bandShares({ theta: 4, alpha: 3, beta: 3 });
  assert.strictEqual(Metrics.compute('focus', { shares: noTheta, variability: 0 }), 0,
    'no theta must mean no focus — the weighted form returned 0.45 of nothing');
  assert.ok(Metrics.compute('focus', { shares: someTh, variability: 0.1 })
    > Metrics.compute('focus', { shares: someTh, variability: 0.9 }),
    'and steadiness must still matter');
  /* Drowsy is bounded without an intercept and orders the extremes correctly. The extremes are now
     spectra rather than normalised levels: all-theta-no-alpha against all-alpha-no-theta. */
  /* Realistic extremes, not arithmetic ones: alpha and beta are never both zero on a live electrode,
     and `bandShares` correctly returns null when they are (there is no alpha-versus-fast contest to
     report). So "sleepy" is theta dominant with alpha gone, and "awake" is alpha dominant. */
  const dSleepy = Metrics.compute('drowsy', { shares: DSP.bandShares({ theta: 1, alpha: 0.02, beta: 0.2 }) });
  const dAwake = Metrics.compute('drowsy', { shares: DSP.bandShares({ theta: 0.02, alpha: 1, beta: 0.5 }) });
  assert.ok(dSleepy >= 0.7 && dAwake <= 0.05,
    `a conjunction of shares must separate the extremes cleanly (sleepy ${dSleepy}, awake ${dAwake})`);
  assert.strictEqual(DSP.bandShares({ theta: 1, alpha: 0, beta: 0 }), null,
    'no fast power at all means there is no alpha-versus-beta contest to report — null, not a guess');

  /* DELTA MUST NOT REACH DROWSY AT ALL.
   *
   * Reported as "i dont know what the drowsy metric is based on, but it's not reading me right", and
   * this was why. Delta on a forehead electrode is mostly eye movement and drift — and this app's OWN
   * blink detector fires on delta-band energy shared across the two frontal sensors. So while delta
   * was in this formula, a blink and a doze produced the same reading, and two parts of one app
   * disagreed about what delta meant.
   *
   * Asserted as independence rather than as a threshold: swinging delta from nothing to everything
   * must not move the number by a hair. A tolerance would let a small weight survive.
   */
  const dNoDelta = Metrics.compute('drowsy', { shares: DSP.bandShares({ delta: 0, theta: 4, alpha: 3, beta: 3 }) });
  const dAllDelta = Metrics.compute('drowsy', { shares: DSP.bandShares({ delta: 99, theta: 4, alpha: 3, beta: 3 }) });
  assert.strictEqual(dNoDelta, dAllDelta,
    `delta must not influence drowsy at all (${dNoDelta} vs ${dAllDelta}) — it is the band this app`
    + ' already treats as a blink');
  /* AND IT MUST BE EXCLUDED AT THE SOURCE, not just unused downstream: the shares themselves must not
     change when delta swings, or a later composite could pick it up by accident. */
  assert.deepStrictEqual(DSP.bandShares({ delta: 0, theta: 4, alpha: 3, beta: 3 }),
    DSP.bandShares({ delta: 500, theta: 4, alpha: 3, beta: 3 }),
    'DSP.bandShares must ignore delta entirely — 1-4Hz at a forehead electrode is eye movement');
  // And it must still answer when delta is missing entirely, since it no longer needs it.
  assert.ok(Metrics.compute('drowsy', { shares: DSP.bandShares({ theta: 7, alpha: 3, beta: 0 }) }) != null,
    'drowsy must not require a band it does not use');
  // Openness must NOT let high alpha buy its way past a churning signal — the weighted sum did.
  const oChurny = Metrics.compute('openness', { shares: DSP.bandShares({ theta: 0, alpha: 1, beta: 0 }), variability: 1 });
  const oSteady = Metrics.compute('openness', { shares: DSP.bandShares({ theta: 0, alpha: 0.6, beta: 0.4 }), variability: 0 });
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
    assert.ok(Metrics.compute(key, { shares: DSP.bandShares({ theta: 1, alpha: 0.6, beta: 0.3 }),
      variability: 0.2, alphaLeft: 0.6, alphaRight: 0.4 }) != null,
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
