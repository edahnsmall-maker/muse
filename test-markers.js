const assert = require('assert');
const Markers = require('./public/markers.js');

const log = (n, fn) => Array.from({ length: n }, (_, i) => Object.assign({ t: i }, fn(i)));

// 1) Basic lifecycle: add, annotate, retag, remove — and always time-ordered.
{
  const m = new Markers.MarkerLog();
  const b = m.add(120, { kind: 'sound' });
  const a = m.add(30, { kind: 'thought' });
  assert.strictEqual(m.length, 2);
  assert.deepStrictEqual(m.list().map((x) => x.tSec), [30, 120], 'markers must stay sorted by time');
  assert.notStrictEqual(a.id, b.id, 'ids must be unique');

  m.annotate(b.id, 'a door slammed');
  assert.strictEqual(m.list().find((x) => x.id === b.id).note, 'a door slammed');
  m.setKind(a.id, 'emotion');
  assert.strictEqual(m.list().find((x) => x.id === a.id).kind, 'emotion');

  assert.strictEqual(m.remove(a.id), true);
  assert.strictEqual(m.remove(9999), false, 'removing an unknown id reports false');
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m.annotate(9999, 'x'), null, 'annotating an unknown id returns null');
  console.log('✓ markers add/annotate/retag/remove and stay time-ordered');
}

// 2) A marker with no note is still valid — unlabelled marks are useful, and
//    forcing text mid-sit was the thing we deliberately avoided.
{
  const m = new Markers.MarkerLog();
  const x = m.add(45);
  assert.strictEqual(x.note, null, 'a marker may have no note');
  assert.strictEqual(x.kind, 'note', 'and gets a sane default kind');
  assert.ok(x.tSec === 45);
  console.log('✓ an unannotated one-keypress marker is a valid marker');
}

// 3) Negative or missing timestamps are clamped rather than stored as garbage.
{
  const m = new Markers.MarkerLog();
  assert.strictEqual(m.add(-10).tSec, 0);
  assert.strictEqual(m.add(undefined).tSec, 0);
  assert.strictEqual(m.add(NaN).tSec, 0);
  console.log('✓ bad timestamps clamp to 0 instead of corrupting the log');
}

// 4) contextAround: the actual point of the feature. It must report what the
//    metrics were doing before vs after the mark, and the change between them.
{
  // calm sits at 0.7, then collapses to 0.3 at t=100 — as if startled.
  const samples = log(200, (i) => ({ calm: i < 100 ? 0.7 : 0.3, noise: 0.1 }));
  const marker = { id: 1, tSec: 100, kind: 'sound', note: 'loud bang' };
  const ctx = Markers.contextAround(marker, samples, { windowSec: 20 });
  assert.ok(ctx, 'should produce a context');
  assert.strictEqual(ctx.beforeCount, 20);
  assert.ok(Math.abs(ctx.fields.calm.before - 0.7) < 1e-9, 'before-window mean should be the pre-event level');
  assert.ok(Math.abs(ctx.fields.calm.after - 0.3) < 1e-9, 'after-window mean should be the post-event level');
  assert.ok(Math.abs(ctx.fields.calm.delta + 0.4) < 1e-9, 'delta should capture the drop');
  assert.ok(Math.abs(ctx.fields.noise.delta) < 1e-9, 'an unchanged field should show ~0 change');
  console.log('✓ contextAround reports before/after/delta around a marked moment');
}

// 5) Fields are discovered from the data, so a newly added metric appears in
//    marker context automatically rather than being silently dropped.
{
  const samples = log(60, (i) => ({ calm: 0.5, focus: 0.4, somethingNew: i / 60 }));
  const ctx = Markers.contextAround({ tSec: 30 }, samples, { windowSec: 10 });
  assert.ok('somethingNew' in ctx.fields, 'unknown numeric fields must be summarised too');
  assert.ok(!('t' in ctx.fields), 'the timestamp itself is not a metric');
  console.log('✓ marker context picks up new metrics without being told about them');
}

// 6) Edge cases: a marker at t=0 has no "before", one past the end has no
//    "after", and neither may throw or fabricate values.
{
  const samples = log(60, () => ({ calm: 0.5 }));
  const atStart = Markers.contextAround({ tSec: 0 }, samples, { windowSec: 15 });
  assert.strictEqual(atStart.beforeCount, 0, 'no samples exist before t=0');
  assert.strictEqual(atStart.fields.calm.before, null, 'and the before mean is null, not 0');
  assert.strictEqual(atStart.fields.calm.delta, null, 'delta is null when one side is missing');

  const beyond = Markers.contextAround({ tSec: 5000 }, samples, { windowSec: 15 });
  assert.strictEqual(beyond, null, 'a marker with no surrounding data returns null');

  assert.strictEqual(Markers.contextAround(null, samples), null);
  assert.strictEqual(Markers.contextAround({ tSec: 5 }, []), null);
  console.log('✓ markers at the edges of a session degrade cleanly');
}

// 7) rankByMovement surfaces the marks where something actually changed,
//    without asserting any cause.
{
  const samples = log(300, (i) => ({ calm: i >= 200 && i < 240 ? 0.2 : 0.7 }));
  const quiet = { id: 1, tSec: 60 };    // nothing happening here
  const eventful = { id: 2, tSec: 200 }; // the collapse
  const ranked = Markers.rankByMovement([quiet, eventful], samples, { windowSec: 20 });
  assert.strictEqual(ranked[0].marker.id, 2, 'the eventful marker should rank first');
  assert.ok(ranked[0].movement > ranked[1].movement, 'and by a real margin');
  console.log('✓ rankByMovement surfaces the marks worth looking at');
}

// 8) Kinds are a short, fixed, typing-free vocabulary.
{
  assert.ok(Markers.KINDS.length >= 4 && Markers.KINDS.length <= 8, 'keep the menu short — it is a distraction mid-sit');
  for (const k of Markers.KINDS) {
    assert.ok(k.key && k.label && k.hint, `kind "${k.key}" needs a label and a hint`);
  }
  assert.strictEqual(Markers.kindLabel('sound'), 'Sound');
  assert.strictEqual(Markers.kindLabel('bogus'), 'Note', 'unknown kinds fall back rather than showing undefined');
  console.log('✓ marker kinds are a short, typing-free vocabulary');
}

console.log('\nAll marker tests passed.');
