/*
 * Draggable panels.
 *
 * WHY THIS EXISTS. The readouts, the live feed, the visual picker and the training
 * shortcut list are all floating panels at fixed corners, and they overlap each other
 * and the controls that open them. Two cases were reported from real use:
 *
 *   * Live feed opens over the bottom-left of the screen — which is where its own
 *     "Live feed" pill is — so it could be opened and then not closed.
 *   * The training clock landed under the Record button with the metrics panel across
 *     its right-hand side.
 *
 * Both are the same problem: a fixed layout cannot be right for every combination of
 * panels that happen to be open, and there are now enough panels that the combinations
 * outnumber anything worth hand-tuning. So the panels move. The person sitting there
 * knows what is in the way better than the stylesheet does.
 *
 * WHAT IS DELIBERATELY NOT HERE. No resizing, no docking, no snapping, no z-order
 * shuffling. A meditation app should not grow a window manager. Drag and reset, and
 * the position is remembered.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SUBTLE PART: taking over positioning without moving the panel.
 *
 * Every panel is positioned by the stylesheet in its own way — `right`+`top`,
 * `left`+`bottom`, `left: 50%` with a centring `translateX(-50%)`. Dragging cannot
 * append to that; it has to replace it, and it must replace it with coordinates that
 * put the panel exactly where it already is, or the first pixel of drag teleports it.
 *
 * So on the first drag we measure where the panel actually is, convert that to the
 * coordinate space its `position` implies, and write `left`/`top` inline while
 * neutralising `right`/`bottom`/`transform`. Inline styles beat the author sheet, so no
 * per-panel CSS overrides are needed and no `!important` is involved.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Panels = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // How much of a panel must remain on screen. Not zero: a panel dragged fully off is
  // unreachable, and the only recovery would be clearing storage — so the clamp is a
  // correctness requirement, not a nicety.
  const KEEP_VISIBLE = 48;

  /*
   * Clamp a position so the panel stays reachable.
   *
   * Pure, and separated out because it is the part that can be got wrong invisibly:
   * an off-by-one here does not look like a bug, it looks like a panel that vanished.
   *
   * A panel WIDER than the viewport (the visual picker is `min(920px, 90vw)`, and a
   * phone in portrait is narrower than some panels) must still be allowed to sit at
   * x=0. Clamping its left edge to `vw - KEEP_VISIBLE` would shove it off to the right.
   * So the upper bound is never less than the lower one.
   */
  function clampPosition({ x, y, w, h, vw, vh, keep = KEEP_VISIBLE }) {
    const minX = Math.min(0, vw - w);          // allow full-bleed panels to start at 0
    const maxX = Math.max(minX, vw - keep);
    const minY = 0;                            // never above the top: the drag handle
    const maxY = Math.max(minY, vh - keep);    // would be off-screen and unclickable
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, x))),
      y: Math.round(Math.min(maxY, Math.max(minY, y))),
    };
  }

  const STORE_PREFIX = 'zenbio.panel.';

  function load(key, storage) {
    try {
      const raw = (storage || localStorage).getItem(STORE_PREFIX + key);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
      return v;
    } catch { return null; }
  }

  function save(key, pos, storage) {
    try { (storage || localStorage).setItem(STORE_PREFIX + key, JSON.stringify(pos)); }
    catch { /* private mode: the position is a convenience, not data */ }
  }

  function clear(key, storage) {
    try { (storage || localStorage).removeItem(STORE_PREFIX + key); } catch {}
  }

  /*
   * Where is this element right now, in the coordinate space its `position` uses?
   *
   * `fixed` is viewport-relative, so the bounding rect is already the answer.
   * `absolute` is relative to the offsetParent's padding box, so the parent's own
   * position has to come out. Getting this wrong is what makes a panel jump on the
   * first drag, which is exactly the failure mode this function exists to avoid.
   */
  function currentPosition(el, win) {
    const w = win || window;
    const r = el.getBoundingClientRect();
    if (w.getComputedStyle(el).position === 'fixed') return { x: r.left, y: r.top, rect: r };
    const parent = el.offsetParent;
    if (!parent) return { x: r.left + (w.scrollX || 0), y: r.top + (w.scrollY || 0), rect: r };
    const pr = parent.getBoundingClientRect();
    const ps = w.getComputedStyle(parent);
    return {
      x: r.left - pr.left - parseFloat(ps.borderLeftWidth || 0) + parent.scrollLeft,
      y: r.top - pr.top - parseFloat(ps.borderTopWidth || 0) + parent.scrollTop,
      rect: r,
    };
  }

  /*
   * Write a position, taking positioning away from the stylesheet in the process.
   * `right`/`bottom`/`transform` must all be neutralised together: leaving any one of
   * them in place means the panel is anchored from two sides at once and either
   * stretches or refuses to move.
   *
   * THE TRANSITION HAS TO BE STOOD DOWN FOR THE FIRST WRITE, and this is not cosmetic.
   * Every panel here animates `transform` for its show/hide slide — #dataPanel's closed
   * state is `translateY(10px)`, #modeBar's centring is `translate(-50%, 0)`. Setting
   * `transform: none` therefore does not apply it, it STARTS A 350ms ANIMATION toward
   * it, so the panel reads as 10px out of place for a third of a second and every
   * measurement taken in that window is wrong. It is also visibly wrong: the panel
   * slides diagonally away from the pointer on the first movement of a drag.
   * Suppressing the transition and forcing a layout read commits the change outright;
   * the transition is then restored so the fade still works.
   *
   * Only the first write needs this. After that `transform` is already `none` and the
   * per-move updates are `left`/`top`, which no panel transitions — so an ordinary drag
   * does not pay for a forced layout on every pointer event.
   */
  function place(el, x, y) {
    const first = el.dataset.dragged !== '1';
    const prevTransition = first ? el.style.transition : null;
    if (first) el.style.transition = 'none';
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    if (first) {
      void el.offsetHeight;                    // flush, with transitions still off
      el.style.transition = prevTransition;
    }
    el.dataset.dragged = '1';
  }

  // The same transition problem in reverse: handing `transform` back to the stylesheet
  // animates the panel toward its home position over 350ms. A reset should snap.
  function unplace(el) {
    const prevTransition = el.style.transition;
    el.style.transition = 'none';
    for (const p of ['left', 'top', 'right', 'bottom', 'transform']) el.style[p] = '';
    void el.offsetHeight;
    el.style.transition = prevTransition;
    delete el.dataset.dragged;
  }

  /*
   * Make one panel draggable.
   *
   * `from` is a selector for the grab area, matched against the pointerdown target's
   * ancestors. The whole panel would make every pill inside it a drag target and
   * swallow clicks, so each panel gets a grip strip instead.
   *
   * The LISTENERS GO ON THE PANEL, not on the grip, and that is the point of matching
   * a selector rather than taking a grip element. #armedBar and #modeBar rebuild their
   * innerHTML on every render, which destroys any child the wiring code had bound —
   * so a grip held as an element reference silently stops working the first time the
   * panel redraws. Bound to the panel, the grip can be recreated as often as it likes.
   */
  function makeDraggable(el, { key, from, handle, storage, win } = {}) {
    const w = win || window;
    const grip = handle || el;
    let drag = null;

    // Restore first, so a panel opens where it was left rather than jumping there
    // the moment it is touched.
    const stored = key && load(key, storage);
    if (stored) {
      const r = el.getBoundingClientRect();
      const p = clampPosition({ x: stored.x, y: stored.y, w: r.width, h: r.height,
        vw: w.innerWidth, vh: w.innerHeight });
      place(el, p.x, p.y);
    }

    grip.addEventListener('pointerdown', (e) => {
      // Only the primary button, and never from something that is itself interactive.
      if (e.button != null && e.button !== 0) return;
      if (from && !(e.target.closest && e.target.closest(from))) return;
      if (e.target.closest('button, input, textarea, select, a, .pill, .legendItem')) return;
      const start = currentPosition(el, w);
      drag = { id: e.pointerId, px: e.clientX, py: e.clientY, ox: start.x, oy: start.y,
        w: start.rect.width, h: start.rect.height, moved: false };
      try { grip.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.px;
      const dy = e.clientY - drag.py;
      // A 3px threshold so a press that wobbles is still a press. Without it, a click
      // on the handle would set an inline position identical to the computed one —
      // harmless but it would permanently override the stylesheet for that panel.
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      drag.moved = true;
      el.classList.add('dragging');
      const p = clampPosition({ x: drag.ox + dx, y: drag.oy + dy, w: drag.w, h: drag.h,
        vw: w.innerWidth, vh: w.innerHeight });
      place(el, p.x, p.y);
    });

    function end(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      drag = null;
      el.classList.remove('dragging');
      if (moved && key) {
        const p = currentPosition(el, w);
        save(key, { x: Math.round(p.x), y: Math.round(p.y) }, storage);
      }
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);

    // Double-click the handle to put the panel back. The alternative — a reset button
    // per panel — is four more things on screen for something used once.
    grip.addEventListener('dblclick', (e) => {
      if (from && !(e.target.closest && e.target.closest(from))) return;
      unplace(el);
      if (key) clear(key, storage);
    });

    return {
      reset() { unplace(el); if (key) clear(key, storage); },
      isDragged() { return el.dataset.dragged === '1'; },
    };
  }

  /*
   * Re-clamp everything after a resize or an orientation change.
   *
   * A position saved on a laptop is off-screen on a phone, and a panel that is
   * off-screen cannot be dragged back. This is the recovery path, and it runs on
   * resize rather than only at load because rotating the phone is the common case.
   */
  function reclampAll(elements, { win } = {}) {
    const w = win || window;
    for (const el of elements) {
      if (!el || el.dataset.dragged !== '1') continue;
      const r = el.getBoundingClientRect();
      const p = clampPosition({ x: currentPosition(el, w).x, y: currentPosition(el, w).y,
        w: r.width, h: r.height, vw: w.innerWidth, vh: w.innerHeight });
      place(el, p.x, p.y);
    }
  }

  return { KEEP_VISIBLE, STORE_PREFIX, clampPosition, makeDraggable, reclampAll,
    currentPosition, place, unplace, load, save, clear };
});
