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

  /*
   * Clamp a position so the panel is ENTIRELY on screen.
   *
   * WHY THIS CHANGED. It used to guarantee only that 48px of a panel stayed in view. That is
   * enough to grab a panel with a mouse and nowhere near enough to READ one, and it produced exactly
   * the failure it was written to prevent: "the panel loaded off screen for me, i had to zoom out to
   * grab it and see it." A 274px-wide readout restored from a position saved in a wider window kept
   * its legal 48px and hid the other 226.
   *
   * The old bound is also wrong in principle for a RESTORED position. Leaving a panel half off the
   * edge is a reasonable thing to do deliberately, while you are looking at it. It is never a
   * reasonable thing to inherit on load in a window you have since resized, because the state you
   * would need in order to fix it is the state you cannot see. So the rule is now the same in both
   * cases — fully visible, always — because two rules would mean a drag that gets quietly undone on
   * the next load, and an app that appears to fight you is worse than one that is merely strict.
   *
   * A panel WIDER than the viewport cannot be fully visible, and both bounds handle that in one
   * expression rather than as a special case:
   *
   *   w <= vw:  min(0, vw-w) = 0,      max(0, vw-w) = vw-w   -> anywhere fully inside
   *   w >  vw:  min(0, vw-w) = vw-w,   max(0, vw-w) = 0      -> must span the viewport
   *
   * Vertically the lower bound stays at 0 rather than going negative: the drag grip is at the TOP of
   * a panel, so a tall panel pushed up loses the only handle that could bring it back.
   */
  /*
   * ROUNDED INWARD, and that is not a detail.
   *
   * This used to be Math.round(clamp(...)), which rounds a value pinned to a bound straight back
   * across it. Panel heights are fractional — text wraps, borders land on half pixels — so with
   * vh = 800 and h = 287.5 the maximum y is 512.5, Math.round makes it 513, and the panel's bottom
   * edge is at 800.5. One pixel outside the viewport, from the function whose entire job is keeping
   * panels inside it.
   *
   * Found because a one-line caption added to the live feed grew that panel by a pixel and turned a
   * silent off-by-one into a failing assertion. It had been wrong the whole time; nothing had been
   * exactly on the boundary before.
   *
   * So the bounds are floored/ceiled toward the inside BEFORE the value is rounded to them. Both
   * cases still fall out of the one expression, including a panel wider than the viewport, where minX
   * is negative and ceiling it moves toward zero.
   */
  function clampRound(v, lo, hi) {
    const inLo = Math.ceil(lo);
    const inHi = Math.floor(hi);
    // A gap narrower than a whole pixel: prefer the lower bound, which for y is the side carrying
    // the drag grip. Losing the grip is unrecoverable; losing a pixel at the bottom is not.
    if (inHi < inLo) return inLo;
    return Math.min(inHi, Math.max(inLo, Math.round(Math.min(hi, Math.max(lo, v)))));
  }

  function clampPosition({ x, y, w, h, vw, vh }) {
    const fitsX = vw - w;
    const minX = Math.min(0, fitsX);
    const maxX = Math.max(0, fitsX);
    const minY = 0;
    const maxY = Math.max(0, vh - h);
    return {
      x: clampRound(x, minX, maxX),
      y: clampRound(y, minY, maxY),
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

    /*
     * A PANEL THAT GROWS MUST NOT GROW OFF THE SCREEN.
     *
     * Clamping on restore and on resize covers a position that became invalid because the WINDOW
     * changed. It misses the other half: these panels change their own size constantly. #readout is a
     * three-line "no headband connected" note before you connect and a ten-row table after, and
     * #armedBar and #modeBar rebuild their contents outright. A position that was fully visible while
     * the panel was short puts its bottom rows past the edge once it is tall — with no resize event
     * anywhere, so nothing re-checked it.
     *
     * Re-clamping cannot loop: it changes the panel's POSITION, and position does not affect the size
     * a ResizeObserver reports. Guarded anyway for a browser without one, because a missing observer
     * must cost this refinement and not the drag.
     */
    let observer = null;
    if (typeof w.ResizeObserver === 'function') {
      observer = new w.ResizeObserver(() => {
        if (el.dataset.dragged !== '1' || drag) return;   // never fight a drag in progress
        const r = el.getBoundingClientRect();
        const at = currentPosition(el, w);
        const p = clampPosition({ x: at.x, y: at.y, w: r.width, h: r.height,
          vw: w.innerWidth, vh: w.innerHeight });
        if (p.x !== Math.round(at.x) || p.y !== Math.round(at.y)) place(el, p.x, p.y);
      });
      observer.observe(el);
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
      // So a caller (or a test) can stop observing without leaking the observer.
      destroy() { if (observer) { observer.disconnect(); observer = null; } },
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

  return { STORE_PREFIX, clampPosition, makeDraggable, reclampAll,
    currentPosition, place, unplace, load, save, clear };
});
