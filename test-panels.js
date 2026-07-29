/*
 * Panel dragging — the part that can be got wrong invisibly.
 *
 * A clamp that is slightly wrong does not look like a bug. It looks like a panel that
 * vanished, with no way back except clearing browser storage, on a device the person is
 * holding in the dark halfway through a sit. So the arithmetic is tested directly, and
 * the DOM behaviour is tested in test-ui.js where a real browser can measure it.
 */
const assert = require('assert');
const Panels = require('./public/panels.js');

const VW = 1280, VH = 800, KEEP = Panels.KEEP_VISIBLE;

// 1) An ordinary drag inside the viewport is left alone.
{
  const p = Panels.clampPosition({ x: 300, y: 200, w: 400, h: 300, vw: VW, vh: VH });
  assert.deepStrictEqual(p, { x: 300, y: 200 }, 'a position already on screen must not move');
}

// 2) Dragged off each edge, enough stays behind to grab. This is the whole point: a
//    panel you cannot reach is a panel you cannot put back.
{
  const right = Panels.clampPosition({ x: 5000, y: 100, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(right.x, VW - KEEP,
    `dragged off the right, ${KEEP}px must remain on screen (got x=${right.x})`);
  const below = Panels.clampPosition({ x: 100, y: 5000, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(below.y, VH - KEEP,
    `dragged off the bottom, ${KEEP}px must remain (got y=${below.y})`);
  const left = Panels.clampPosition({ x: -5000, y: 100, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(left.x, 0, 'a panel narrower than the viewport cannot go left of 0');
  const above = Panels.clampPosition({ x: 100, y: -5000, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(above.y, 0,
    'never above the top — the grip would be off-screen and the panel unmovable');
}

// 3) A panel WIDER than the viewport must still be allowed to sit at x=0.
//    The visual picker is min(920px, 90vw) and a phone in portrait is ~390px wide.
//    Clamping its left edge to `vw - KEEP` would shove a full-bleed panel sideways
//    every time the page loaded, which is worse than not clamping at all.
{
  const phone = { vw: 390, vh: 844 };
  const p = Panels.clampPosition({ x: 0, y: 60, w: 920, h: 176, ...phone });
  assert.strictEqual(p.x, 0, `a panel wider than the screen must be allowed at x=0 (got ${p.x})`);
  const pushed = Panels.clampPosition({ x: -600, y: 60, w: 920, h: 176, ...phone });
  assert.strictEqual(pushed.x, phone.vw - 920,
    'and may be scrolled left only as far as its own right edge');
}

// 4) Degenerate viewports must not produce NaN or an inverted range. A zero-size
//    viewport happens for real: a hidden panel measures 0x0, and some mobile browsers
//    report 0 height for a frame or two during an orientation change.
{
  const p = Panels.clampPosition({ x: 10, y: 10, w: 0, h: 0, vw: 0, vh: 0 });
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y),
    `a zero viewport must still give numbers, got ${JSON.stringify(p)}`);
  assert.deepStrictEqual(p, { x: 0, y: 0 }, 'and must collapse to the origin, not go negative');
}

// 5) Integers out, always. Fractional pixels in a stored position accumulate across
//    save/restore cycles and make the panel creep.
{
  const p = Panels.clampPosition({ x: 100.4, y: 200.6, w: 300, h: 200, vw: VW, vh: VH });
  assert.strictEqual(p.x, 100);
  assert.strictEqual(p.y, 201);
}

// 6) Storage round-trips, refuses junk, and survives a storage that throws.
{
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  Panels.save('readout', { x: 12, y: 34 }, storage);
  assert.deepStrictEqual(Panels.load('readout', storage), { x: 12, y: 34 });
  assert.ok(store.has(Panels.STORE_PREFIX + 'readout'), 'keys must be namespaced');

  Panels.clear('readout', storage);
  assert.strictEqual(Panels.load('readout', storage), null, 'clear must forget the position');

  // A half-written or hand-edited value must be IGNORED, not applied. Restoring
  // `{x: null}` would place the panel at left:NaN, which renders nowhere at all.
  store.set(Panels.STORE_PREFIX + 'bad', '{"x":null,"y":3}');
  assert.strictEqual(Panels.load('bad', storage), null, 'a non-numeric position is not a position');
  store.set(Panels.STORE_PREFIX + 'worse', 'not json');
  assert.strictEqual(Panels.load('worse', storage), null, 'unparseable storage must not throw');

  // Private browsing throws on setItem. The position is a convenience; losing it must
  // not take the drag with it.
  const hostile = { getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => Panels.save('x', { x: 1, y: 1 }, hostile));
  assert.doesNotThrow(() => Panels.clear('x', hostile));
  assert.strictEqual(Panels.load('x', hostile), null);
}

console.log('✓ panel positions stay reachable, round-trip, and refuse junk');
console.log('\nAll panel tests passed.');
