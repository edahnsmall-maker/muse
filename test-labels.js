/*
 * Tests for the labelling schema.
 *
 * Most of this is about REFUSING to invent a label. A self-report is the only
 * unguessed thing in this project, and the failure mode to guard is not a crash —
 * it is a missing rating quietly becoming a 3, or a closing reflection being treated
 * as though it described one instant. Both would look like data.
 */
const assert = require('assert');
const Labels = require('./public/labels.js');

// 1) The schema itself. Every point on every scale must be named, because an
//    unnamed middle means whatever the rater felt that day and drifts between sits.
{
  assert.strictEqual(Labels.DIMENSIONS.length, 4);
  const keys = Labels.DIMENSIONS.map((d) => d.key);
  assert.deepStrictEqual(keys, ['focus', 'effort', 'pull', 'tone']);
  for (const d of Labels.DIMENSIONS) {
    assert.strictEqual(d.anchors.length, 5, `${d.key} must name all five points, not just the ends`);
    for (const [i, a] of d.anchors.entries()) {
      assert.ok(a && a.length > 4, `${d.key} anchor ${i + 1} must actually say something`);
    }
    assert.ok(d.question, `${d.key} needs a question a person can answer`);
  }
  // The far end of focus is qualitatively different, not just "more scattered".
  assert.match(Labels.DIMENSIONS[0].anchors[0], /waterfall/,
    'focus 1 is the waterfall — being hit by thoughts, not drifting between them');
  // Pull must be about being taken, not about volume.
  assert.match(Labels.BY_KEY.pull.question, /grab/i);
  console.log('✓ four dimensions, every point on every scale named');
}

// 2) The 2x2. This is the whole reason effort is recorded separately from focus:
//    "focused" covers two different experiences and one score cannot separate them.
{
  assert.strictEqual(Labels.quadrant({ focus: 5, effort: 1 }), 'absorbed');
  assert.strictEqual(Labels.quadrant({ focus: 5, effort: 5 }), 'concentrating');
  assert.strictEqual(Labels.quadrant({ focus: 1, effort: 1 }), 'drifting');
  assert.strictEqual(Labels.quadrant({ focus: 1, effort: 5 }), 'struggling');
  // The pair that a single "focus score" would call identical.
  assert.notStrictEqual(
    Labels.quadrant({ focus: 5, effort: 1 }), Labels.quadrant({ focus: 5, effort: 5 }),
    'absorbed and concentrating are both focused and must not collapse together');

  // The midpoint is genuinely in between. Forcing it into a quadrant would invent a
  // distinction the rater declined to make.
  assert.strictEqual(Labels.quadrant({ focus: 3, effort: 5 }), null);
  assert.strictEqual(Labels.quadrant({ focus: 5, effort: 3 }), null);
  // And a missing half cannot produce a quadrant at all.
  assert.strictEqual(Labels.quadrant({ focus: 5 }), null);
  assert.strictEqual(Labels.quadrant({}), null);
  assert.strictEqual(Labels.quadrant(), null);
  for (const q of Object.keys(Labels.QUADRANTS)) {
    assert.ok(Labels.QUADRANTS[q].length > 10, `${q} needs a description in words`);
  }
  console.log('✓ focus x effort resolves to four named states, and refuses when it cannot');
}

// 3) Ratings are refused rather than coerced. A label that was not given must never
//    become a number.
{
  for (const bad of [0, 6, 2.5, -1, '4', null, undefined, NaN, Infinity, true, [], {}]) {
    assert.strictEqual(Labels.validRating(bad), false, `${JSON.stringify(bad)} is not a rating`);
  }
  for (const good of [1, 2, 3, 4, 5]) assert.strictEqual(Labels.validRating(good), true);

  // normalise keeps what is valid and drops the rest — it does NOT fill gaps.
  assert.deepStrictEqual(Labels.normalise({ focus: 4, effort: 2, pull: 9, tone: null }),
    { focus: 4, effort: 2 }, 'invalid and absent values must be dropped, not defaulted');
  assert.strictEqual(Labels.normalise({ focus: 0 }), null, 'nothing valid means no label at all');
  assert.strictEqual(Labels.normalise(null), null);
  assert.strictEqual(Labels.normalise('4'), null);
  // A partial report is a legitimate report.
  assert.deepStrictEqual(Labels.normalise({ tone: 5 }), { tone: 5 },
    'someone sure about one dimension and unsure about the rest must be able to say so');
  // And unknown keys must not survive into the record.
  assert.deepStrictEqual(Labels.normalise({ focus: 3, vibes: 5 }), { focus: 3 });
  console.log('✓ ratings outside 1..5 are refused, and gaps are never filled in');
}

// 4) describe / summarise report the words, and say nothing when there is nothing.
{
  assert.match(Labels.describe('focus', 1), /waterfall/);
  assert.match(Labels.describe('effort', 1), /effortless/);
  assert.strictEqual(Labels.describe('focus', 0), null);
  assert.strictEqual(Labels.describe('nope', 3), null);

  const line = Labels.summarise({ focus: 5, effort: 1 });
  assert.match(line, /Focus 5\/5/);
  assert.match(line, /one-pointed/);
  assert.match(line, /absorbed/, 'the quadrant belongs in the summary — it is the finding');
  // Partial summarises partially, without inventing the rest.
  const partial = Labels.summarise({ tone: 2 });
  /* Reads "Pleasant", not "Tone". The key stays `tone` so recorded labels and export
     columns keep working; only the word a person reads changed, because "Tone 2/5" does
     not say which end 2 is near and "Pleasant 2/5" does. */
  assert.match(partial, /Pleasant 2\/5/);
  assert.ok(!/Focus/.test(partial), 'an unreported dimension must not appear');
  assert.ok(!/absorbed|drifting|struggling|concentrating/.test(partial),
    'and no quadrant without both of its axes');
  assert.strictEqual(Labels.summarise({}), null);
  assert.strictEqual(Labels.summarise(null), null);
  /* EVERY DIMENSION MUST CARRY ITS POLES, since the closing screen shows digits and the
     anchor for a digit is otherwise a hover away — no use at all on a phone. Checked
     against the anchors rather than as free text, so the short form cannot drift away from
     the scale it is labelling. */
  for (const d of Labels.DIMENSIONS) {
    assert.ok(Array.isArray(d.poles) && d.poles.length === 2,
      `${d.key} must name its 1-end and its 5-end for display`);
    assert.strictEqual(d.poles[0], d.anchors[0].split(' \u2014')[0],
      `${d.key}'s low pole must come from its own anchor for 1 (got "${d.poles[0]}")`);
    assert.strictEqual(d.poles[1], d.anchors[4].split(' \u2014')[0],
      `${d.key}'s high pole must come from its own anchor for 5 (got "${d.poles[1]}")`);
  }
  console.log('✓ summaries report only what was actually reported, and every scale names'
    + ' both of its ends');
}

// 5) Transitions: one keystroke each, distinct keys, and `returned` separate from
//    `lost` because they are different moments.
{
  assert.ok(Labels.TRANSITIONS.length >= 4);
  const kbds = Labels.TRANSITIONS.map((t) => t.kbd);
  assert.strictEqual(new Set(kbds).size, kbds.length, 'no two transitions may share a key');
  for (const t of Labels.TRANSITIONS) {
    assert.match(t.kbd, /^[A-Z]$/, `${t.key} must be a single letter to be usable eyes-closed`);
    assert.ok(t.hint && t.hint.length > 10, `${t.key} needs a hint saying exactly what it marks`);
    assert.strictEqual(Labels.TRANSITION_BY_KBD[t.kbd], t);
    assert.strictEqual(Labels.TRANSITION_BY_KEY[t.key], t);
  }
  assert.ok(Labels.TRANSITION_BY_KEY.returned && Labels.TRANSITION_BY_KEY.lost,
    'noticing you were gone and re-establishing attention are different events');
  /* Keys must not collide with the app's existing shortcuts. T is no longer reserved:
     it is now "Thinking", the most-pressed category, and Training moved to Shift+T. */
  for (const taken of ['M', 'N', 'V', 'F']) {
    assert.ok(!kbds.includes(taken), `${taken} is already bound elsewhere in the app`);
  }
  /* THE TWO MODULES MUST AGREE.
   *
   * probes.js TAP_CATEGORIES is the authority on what each key does; labels.js
   * TRANSITIONS exists only to name an event in words for the export. An earlier
   * version had them disagreeing about R, D and K — two names for one event, so the
   * analysis had to guess whether they were the same thing. Asserted here so they
   * cannot drift apart again.
   */
  const Probes = require('./public/probes.js');
  for (const t of Labels.TRANSITIONS) {
    const tap = Probes.TAP_BY_KEY[t.key];
    assert.ok(tap, `labels.js knows "${t.key}" but probes.js does not — they must agree`);
    assert.strictEqual(tap.kbd, t.kbd,
      `"${t.key}" is ${t.kbd} in labels.js and ${tap.kbd} in probes.js`);
  }
  for (const tap of Probes.TAP_CATEGORIES) {
    assert.ok(Labels.TRANSITION_BY_KEY[tap.key],
      `probes.js offers "${tap.key}" but labels.js cannot name it for the export`);
  }
  console.log(`✓ ${Labels.TRANSITIONS.length} one-key transitions, no collisions,`
    + ` and probes.js agrees: ${kbds.join(' ')}`);
}

// 6) SPANS. A dimensional label describes the stretch just sat through, backwards to
//    the previous label — not the instant the button was pressed.
{
  const notes = [
    { offsetSec: 300, dims: { focus: 2, effort: 4 } },
    { offsetSec: 900, dims: { focus: 5, effort: 1 } },
    { offsetSec: 600, dims: { focus: 3 } },              // out of order on purpose
    { offsetSec: 450, dims: { focus: 9 } },              // invalid: not a label
    { offsetSec: 500, text: 'no dims here' },            // a plain note
    { offsetSec: 120, dims: { tone: 4 }, anchored: false }, // whole-sit reflection
  ];
  const { spans, wholeSit } = Labels.spans(notes, { durationSec: 1200 });

  // Ordered, contiguous, and each running BACK to the previous label.
  assert.deepStrictEqual(spans.map((s) => [s.fromSec, s.toSec]),
    [[0, 300], [300, 600], [600, 900], [900, 1200]]);
  assert.deepStrictEqual(spans[0].dims, { focus: 2, effort: 4 },
    'the first label describes the sit up to that point');
  assert.deepStrictEqual(spans[1].dims, { focus: 3 });
  assert.deepStrictEqual(spans[2].dims, { focus: 5, effort: 1 });

  // THE TAIL IS UNLABELLED. Extending the last label forward would invent a report
  // about time the rater never described.
  assert.strictEqual(spans[3].dims, null,
    'time after the last label is unlabelled, not covered by the last label');

  // A whole-sit reflection is not a span. Treating it as one would be a fabrication.
  assert.strictEqual(wholeSit.length, 1);
  assert.deepStrictEqual(wholeSit[0].dims, { tone: 4 });
  assert.ok(wholeSit[0].wholeSit);
  assert.ok(!spans.some((s) => s.dims && s.dims.tone === 4),
    'a closing reflection must not be placed at one moment in the sit');

  // No labels at all means no spans — not one big span covering everything.
  const empty = Labels.spans([{ offsetSec: 10, text: 'just words' }], { durationSec: 600 });
  assert.strictEqual(empty.spans.length, 0, 'notes without ratings produce no labelled spans');
  assert.strictEqual(Labels.spans(null).spans.length, 0);

  // A label at t=0 describes nothing yet and must not emit a zero-length span, which
  // later averaging would happily divide by.
  const atZero = Labels.spans([{ offsetSec: 0, dims: { focus: 4 } }], { durationSec: 60 });
  assert.ok(atZero.spans.every((s) => s.toSec > s.fromSec),
    'no zero-length spans');
  console.log('✓ label spans run backwards to the previous label, and the tail stays unlabelled');
}

console.log('\nAll label tests passed.');
