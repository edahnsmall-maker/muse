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

const VW = 1280, VH = 800;

// 1) An ordinary drag inside the viewport is left alone.
{
  const p = Panels.clampPosition({ x: 300, y: 200, w: 400, h: 300, vw: VW, vh: VH });
  assert.deepStrictEqual(p, { x: 300, y: 200 }, 'a position already on screen must not move');
}

/* 2) Pushed past any edge, the WHOLE panel comes back — not a grabbable sliver of it.
 *
 *    This used to assert that only 48px remained on screen, and that weaker contract
 *    produced the bug it was supposed to prevent: "the panel loaded off screen for me, i had to zoom
 *    out to grab it and see it." 48px is enough to grab a panel and nowhere near enough to read one,
 *    and a restored position is precisely the case where the user cannot see what to fix.
 */
{
  const right = Panels.clampPosition({ x: 5000, y: 100, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(right.x, VW - 400,
    `pushed off the right, the panel's right edge must come back to the viewport edge (got x=${right.x})`);
  const below = Panels.clampPosition({ x: 100, y: 5000, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(below.y, VH - 300,
    `pushed off the bottom, its bottom edge must come back (got y=${below.y})`);
  const left = Panels.clampPosition({ x: -5000, y: 100, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(left.x, 0, 'a panel narrower than the viewport cannot go left of 0');
  const above = Panels.clampPosition({ x: 100, y: -5000, w: 400, h: 300, vw: VW, vh: VH });
  assert.strictEqual(above.y, 0,
    'never above the top — the grip would be off-screen and the panel unmovable');

  /* THE ACTUAL REPORTED CASE, asserted with the real numbers rather than round ones: the 274px
     readout, restored from a position saved in a wider window. Under the old clamp it kept 48px and
     hid 226 of them. */
  const readout = Panels.clampPosition({ x: 1800, y: 88, w: 274, h: 300, vw: VW, vh: VH });
  assert.strictEqual(readout.x, VW - 274,
    `the readout must be fully visible after restore, not ${VW - readout.x}px of it`);
  assert.ok(readout.x + 274 <= VW, 'its right edge must be inside the viewport');
  // And the guarantee stated as the property, over a spread of sizes, so no single case can pass by
  // luck while the rule is wrong.
  for (const w of [120, 274, 400, 920, 1280]) {
    for (const x of [-9999, -1, 0, 500, VW, 9999]) {
      const p = Panels.clampPosition({ x, y: 0, w, h: 100, vw: VW, vh: VH });
      if (w <= VW) {
        assert.ok(p.x >= 0 && p.x + w <= VW,
          `w=${w} x=${x} landed at ${p.x}, which is not fully on screen`);
      } else {
        assert.ok(p.x <= 0 && p.x + w >= VW,
          `w=${w} x=${x} landed at ${p.x}, which does not span the viewport`);
      }
    }
  }
}

// 3) A panel WIDER than the viewport must still be allowed to sit at x=0.
//    The visual picker is min(920px, 90vw) and a phone in portrait is ~390px wide.
//    Clamping its left edge to a fixed inset would shove a full-bleed panel sideways
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

/*
 * A CLAMPED PANEL MUST NOT LAND OUTSIDE THE VIEWPORT, EVER — including when its size is fractional.
 *
 * The bug: Math.round(clamp(...)) rounds a value pinned to a bound back across it. Panel heights are
 * fractional because text wraps and borders land on half pixels, so vh 800 with h 287.5 gave a maximum
 * y of 512.5, rounded to 513, putting the bottom edge at 800.5 — one pixel outside, from the function
 * whose only job is keeping panels inside.
 *
 * It had always been wrong; nothing had happened to sit exactly on the boundary. Adding a one-line
 * caption to the live feed grew that panel by a pixel and turned it into a failure.
 */
{
  const vw = 1280, vh = 800;
  // Every half-pixel height across a range, each asked to sit as low as it can.
  for (let h = 100; h < 400; h += 0.5) {
    const { y } = Panels.clampPosition({ x: 0, y: 99999, w: 300, h, vw, vh });
    assert.ok(Number.isInteger(y), `y must be a whole pixel, got ${y} for h ${h}`);
    assert.ok(y >= 0, `y must not go negative (h ${h})`);
    assert.ok(y + h <= vh,
      `a clamped panel must stay inside: y ${y} + h ${h} = ${y + h} exceeds vh ${vh}`);
  }
  // The same on the horizontal axis, both narrower and wider than the viewport.
  for (let w = 200; w < 1400; w += 0.5) {
    const { x } = Panels.clampPosition({ x: 99999, y: 0, w, h: 200, vw, vh });
    assert.ok(Number.isInteger(x), `x must be a whole pixel, got ${x} for w ${w}`);
    if (w <= vw) {
      assert.ok(x >= 0 && x + w <= vw,
        `a panel narrower than the viewport must fit: x ${x} + w ${w} vs vw ${vw}`);
    } else {
      // A panel wider than the viewport cannot fit; it must span it rather than leaving a gap.
      assert.ok(x <= 0 && x + w >= vw,
        `a panel wider than the viewport must span it: x ${x} + w ${w} vs vw ${vw}`);
    }
  }
  // Dragged the other way, a panel must not be rounded off the top or the left either.
  for (let h = 100.5; h < 300; h += 1) {
    assert.strictEqual(Panels.clampPosition({ x: 0, y: -99999, w: 300, h, vw, vh }).y, 0,
      'the top bound is exact — the drag grip is up there and losing it is unrecoverable');
  }
  // A panel taller than the viewport keeps its grip on screen rather than centring the overflow.
  assert.strictEqual(Panels.clampPosition({ x: 0, y: 500, w: 300, h: 900.5, vw, vh }).y, 0,
    'a panel taller than the viewport must stay pinned to the top');
  console.log('✓ clamping rounds INWARD: no fractional panel size can put a panel outside the viewport');
}

/*
 * DOCKING. A docked panel is defined by its EDGE, and that is the whole point of the state existing.
 *
 * A dragged panel keeps the absolute pixel position it was let go at, so it is wrong on the next screen
 * size and wrong again after a rotation. Restoring a right-docked panel by its stored x would put it in
 * the middle of a wider window and off the side of a narrower one — exactly the failure docking exists
 * to avoid — so what gets persisted is the side.
 */
{
  // A minimal element stand-in: enough of the DOM surface for place/dock to work under Node.
  function fakePanel({ left = 400, top = 200, width = 300, height = 180 } = {}) {
    const style = {};
    const el = {
      dataset: {}, style,
      getBoundingClientRect() {
        // Reflects an inline position once one has been written, as a real element would.
        const l = style.left ? parseFloat(style.left) : left;
        const t = style.top ? parseFloat(style.top) : top;
        return { left: l, top: t, width, height, right: l + width, bottom: t + height };
      },
      get offsetHeight() { return height; },
      offsetParent: null,
    };
    return el;
  }
  const win = { innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ position: 'fixed' }) };

  // Nearest edge is decided by the panel's CENTRE, not its left corner: a wide panel whose left edge
  // is just past the midline still belongs on the left.
  assert.strictEqual(Panels.nearestEdge(fakePanel({ left: 100 }), win), 'left');
  assert.strictEqual(Panels.nearestEdge(fakePanel({ left: 800 }), win), 'right');
  /* The discriminating case: a wide panel whose LEFT edge is left of the midline but whose centre is
     right of it. Going by the left corner would answer 'left'; going by the centre answers 'right',
     and the centre is the honest reading of which side the panel is on. */
  assert.strictEqual(Panels.nearestEdge(fakePanel({ left: 400, width: 500 }), win), 'right',
    'edge is decided by the panel’s centre, not its left corner');

  // Docking right puts the panel flush against the right edge, whatever its width.
  for (const width of [200, 300, 640]) {
    const el = fakePanel({ left: 50, width });
    Panels.dock(el, 'right', { win });
    const r = el.getBoundingClientRect();
    assert.strictEqual(Math.round(r.right), win.innerWidth,
      `a right-docked panel ${width}px wide must sit flush (right was ${r.right})`);
    assert.strictEqual(el.dataset.docked, 'right', 'and must record which edge it is on');
    assert.ok(Panels.isDocked(el), 'and report itself docked');
  }
  {
    const el = fakePanel({ left: 900 });
    Panels.dock(el, 'left', { win });
    assert.strictEqual(Math.round(el.getBoundingClientRect().left), 0, 'left-docked sits at x 0');
  }

  /* THE VERTICAL POSITION IS KEPT, not reset to the top. Docking says which side the panel lives on;
     yanking it upward as well would make one gesture do two things, and the panel the practitioner
     docked mid-sit would jump out from under their eyes. */
  {
    const el = fakePanel({ left: 500, top: 260 });
    Panels.dock(el, 'right', { win });
    assert.strictEqual(Math.round(el.getBoundingClientRect().top), 260,
      'docking must not move the panel vertically');
  }
  // Except where keeping it would put the panel outside — the clamp still applies.
  {
    const el = fakePanel({ left: 500, top: 700, height: 180 });
    Panels.dock(el, 'right', { win });
    const r = el.getBoundingClientRect();
    assert.ok(r.bottom <= win.innerHeight,
      `docking must still clamp into the viewport (bottom ${r.bottom} of ${win.innerHeight})`);
  }
  // A panel wider than the viewport cannot sit flush on the right without leaving the left; it spans.
  {
    const el = fakePanel({ left: 10, width: 1400 });
    Panels.dock(el, 'right', { win });
    assert.strictEqual(Math.round(el.getBoundingClientRect().left), 0,
      'a panel wider than the viewport docks to 0 rather than to a negative x');
  }
  // Releasing clears both the placement and the docked flag, so the stylesheet takes over again.
  {
    const el = fakePanel();
    Panels.dock(el, 'left', { win });
    Panels.unplace(el);
    assert.ok(!Panels.isDocked(el), 'unplace must clear the docked state');
    assert.strictEqual(el.dataset.docked, undefined, 'and remove the attribute the CSS keys off');
    assert.strictEqual(el.dataset.dragged, undefined, 'and stop claiming to be placed');
  }
  // An unrecognised edge is not honoured blindly — it falls back to the nearer side.
  {
    const el = fakePanel({ left: 900 });
    assert.strictEqual(Panels.dock(el, 'sideways', { win }), 'right',
      'a junk edge must fall back to the nearest, not position the panel nowhere');
  }
  console.log('✓ docking snaps to an edge by the panel’s centre, keeps its height and vertical place,'
    + ' still clamps, and releases cleanly');
}

console.log('✓ panel positions stay reachable, round-trip, and refuse junk');
console.log('\nAll panel tests passed.');
