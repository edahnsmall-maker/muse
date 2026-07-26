# Handoff

You are picking up a meditation biofeedback app. This file is the orientation:
what it is, what the rules are, what to work on next, and — most usefully — the
mistakes already paid for, so you don't repeat them.

Read `ROADMAP.md` for the product intent and `README.md` for setup and per-feature
detail. This file is the map and the warnings.

---

## 1. What it is, in one paragraph

A browser page (`public/direct.html`) talks over Web Bluetooth to a **Muse S Gen 2**
EEG headband and, optionally, a **Polar H10** chest strap. It computes band powers
and HRV client-side, renders a full-screen reactive visual (17 modes), graphs
everything live, offers in-the-moment cues, lets the meditator mark moments, and
produces a downloadable markdown session report. There is no backend and no build
step — it is vanilla JS served as static files.

The owner runs a Zen center and intends to use this with groups. That matters for
every judgement call below.

---

## 2. THE ONE RULE THAT MATTERS MOST

**Never present a guess as a measurement.**

Every interpretive score here is unvalidated. They are built from real,
literature-backed signals, but the weights, band edges and thresholds were chosen by
hand and **nothing has been checked against ground truth**. The app is built to say
so out loud, and that is not decoration — a room of people at a Zen center trusting a
number that means nothing is worse than giving them no number.

Concretely, and all of these are enforced by tests:

- **`public/metrics.js` is the registry.** Every metric carries a `tier`
  (`solid` = measured / `moderate` = proxy / `speculative` = exploratory), a `source`
  saying what it is computed from, and a `caveat` saying what it cannot tell you. The
  UI shows the tier as a coloured light and the caveat on request.
- **A metric with no input returns `null`, never `0`.** "No reading" and "a reading
  of zero" are different claims. If you find yourself writing `|| 0`, stop.
- **Speculative metrics can be selected but are never a default.**
- **Reported numbers need a companion answer to "how much signal was this derived
  from",** and the UI must *act* on that answer, not merely disclose it.

Two real incidents that produced this rule, both worth reading before you touch the
report or add a metric:

1. A 9-minute session reported **"Sharp returns: 389 — that returning is the
   practice."** One every 1.4 seconds. The number was band-power volatility; the
   framing turned a meaningless figure into a spiritual accomplishment. Worse than a
   neutral wrong number, because it flatters. A test had been *asserting the old
   wording*, pinning the false claim in place — it was deleted.
2. A session with **3–11% usable forehead signal** printed an average calm, a range,
   a first/last-third comparison and a full sparkline with the same confidence as a
   clean sit. One "read it loosely" bullet does not undo four tables that look like
   measurements. There is now a banner *above* the numbers.

---

## 3. Architecture

No framework, no bundler. Load order matters (see the `<script>` tags in
`direct.html`). Everything is a UMD-ish module so Node can `require` it for tests.

| File | Lines | Role |
|---|---|---|
| `public/direct.html` | ~1640 | **The app.** All UI, BLE connection, the 250ms tick loop. Inline `<script>`. |
| `public/dsp.js` | 422 | Muse protocol + signal maths: FFT, band powers, artifact detection, PPG beats, breathing-rate estimation, adaptive normalisation. |
| `public/polar.js` | 343 | H10 protocol + HRV + breath phase. |
| `public/viz-core.js` | 407 | **Pure** visual logic: mode list, event detection, blooms, breath patterns, `SweepRing`, `expand`/`expandSoft`, `smoothSeries`. No canvas, no DOM. |
| `public/visual.js` | ~2140 | The renderer. 17 modes. Thin over `viz-core`. |
| `public/metrics.js` | 160 | The honesty registry (see §2). |
| `public/summary.js` | 355 | Session stats + the markdown report. |
| `public/markers.js` | 132 | Mid-sit marks and before/after context. |
| `public/cues.js` | 98 | Rate-limited in-the-moment cues. |
| `public/chart.js` | 44 | Live graph data/scaling. |
| `public/index.html`, `server.js`, `sim.js` | — | The older Mind Monitor path (Path A). Still works; not where the action is. |

**The discipline that makes this testable:** anything that can be a pure function
lives in a requireable module with a test. Canvas drawing and DOM live in
`visual.js` / `direct.html` and are covered by the two browser-based suites below.

### The tick loop

`direct.html` has a `setInterval(..., 250)` that is the heartbeat of the app. Order
inside it matters and there is a **trap**:

```
renderDevices()            // unconditional
status expiry              // unconditional
const result = computeCalm()
if (!result) { ...strap-only render...; return; }   // <-- EARLY RETURN
...everything EEG-dependent...
```

Anything that must work **without the headband** has to go *above* that early
return. A previous version had the status-clearing and every strap readout row below
it, so a strap-only session showed a permanently frozen message and no heart data.

---

## 4. Tests — 11 suites, all must pass

```bash
for t in test.js test-dsp.js test-chart.js test-viz.js test-visual-smoke.js \
         test-metrics.js test-markers.js test-cues.js test-summary.js \
         test-polar.js test-ui.js; do node $t; done
```

Zero dependencies for the logic suites. `test-ui.js` uses Playwright, installed
**globally** at `/opt/node22/lib/node_modules` (deliberately not in `package.json` —
the shipped app must not depend on a browser automation stack).

Two suites are worth understanding because they cover what unit tests cannot:

- **`test-visual-smoke.js`** — stubs a Canvas2D context and runs *every* mode for 60
  frames with adversarial state (nulls, NaN, out-of-range, malformed/empty arrays).
  Fails on any thrown error, any NaN/Infinity/negative geometry reaching a draw call,
  or **more than 2.2 blurred draw ops per frame** (see §6).
- **`test-ui.js`** — loads `direct.html` in real Chromium and asserts DOM lifecycle.
  This exists because a bug reached the user's hands that no amount of unit-testing
  the maths could have caught: `setStatus()` assigns `innerHTML`, and the device
  buttons were *inside* that element, so the first status message deleted them.

### `tools/shoot.js` — you can SEE the visuals

This is the single most valuable tool in the repo. It renders any mode headless
against a **deterministic clock**, driven by scripted physiology, and writes PNGs.

```bash
node tools/shoot.js --mode corona --scenario bursty --at 20,70
node tools/shoot.js --all --scenario realistic --at 45
```

Scenarios: `flat` (nothing moves — anything still alive is animating on time, not
data), `realistic` (values near 0.5, the regime where under-scaled visuals look
dead), `settling`, `agitated`, `bursty` (real second-to-second structure — the one
that distinguishes "working" from "drawing a circle"), `breathing`, `swing`.

**It has found six bugs that were invisible in the code**, including a trace using
18% of the screen height, a string of beads along every line, a hard seam where a
ring buffer wrapped, and rings bulging through the centre and out the other side.
**Use it before and after every visual change.** What it cannot verify: how it feels
in motion, how it looks at full size in a dark room, or GPU-specific behaviour
(headless GL is software-backed).

---

## 5. Where things stand

### Working
Muse EEG over Web Bluetooth; band powers and a normalised `calm`; artifact rejection
with blink/jaw discrimination; 17 visual modes; live graphs with a
Sensors/Composites switch that retunes the visual; evidence tiers in the UI;
rate-limited cues; mid-sit markers with before/after context; downloadable markdown
reports; Polar H10 with HR, RMSSD, HRV normalised to the wearer, `equanimity` from
HRV steadiness, and breath phase.

### Two devices at once
Works. Web Bluetooth connects them independently; each `requestDevice()` needs **its
own user gesture**, which is why the strap has its own button and cannot be chained
off the Muse connection. Device controls live in a persistent `#devices` bar that
stays on screen all session, so either device can be connected in either order and
reconnected mid-sit.

---

## 6. Hard-won lessons — read this section

These are all real, all cost time, and all will recur.

**Adaptive normalisation keeps every score near 0.5.** A realistic session occupies
roughly 0.35–0.75. Feed that straight into a radius or a y-coordinate and you get
~12% of the available movement, which looks broken. Use `VizCore.expand()` (hard
clamp, fine for radii) or `expandSoft()` (saturating, for traces — a hard clamp draws
excursions as flat lines pressed against the frame edge).

**But expansion multiplies noise by exactly the factor it multiplies signal.** Fixing
"the line is flat" produced "the line is too jumpy". The answer is smoothing in
*time* — `VizCore.smoothSeries()`, centred so it does not lag. An EMA lags, and a
lagging trace beside a non-lagging live head looks wrong.

**`ctx.filter` blurs every draw op separately.** N fills under an active filter cost
N full-buffer blur passes. Earlier versions issued 4–12 per frame. Draw unblurred
into the scratch layer and blit **once** with the filter. The smoke test enforces
≤2.2/frame.

**Everything renders into a ≤560px buffer that is upscaled ~4×.** Great for soft
washes, fatal for thin sharp lines — a 1px stroke lands as a 4px smear. `Flow`,
`Pulse` and `Corona` therefore bypass it and draw at full canvas resolution
(`DIRECT_MODES` in `visual.js`). They achieve softness in *geometry* — stacked
strokes of increasing width and decreasing alpha — which also costs zero blur passes.

**Additive colour at low alpha over near-black desaturates toward grey.** This is why
several visuals "had no colour". Either draw genuinely bright, or use a light ground
(`Eclipse` does).

**Hard clamps peg and stop moving.** A bar frozen at 100 reads as a confident
detection, not as "this signal is outside the expected range". Saturate with `tanh`.

**Timescale mismatches make things look dead.** `Pulse` swept once every 5s while its
metrics move over tens of seconds, so every revolution saw a near-constant value and
drew a perfect circle — a loading spinner carrying no information. It sweeps every
24s now.

**Chart colours must be tellable apart, and this has bitten three times.** TP9's
hue was identical to Focus's, so an electrode read as a dead composite; `breath`
shipped 17 RGB units from Focus, so a correctly-drawn line was invisible on top of
another; `equanimity`/`blink` were 31 apart and `hrv`/`jaw` 51. A line you cannot
distinguish is worse than an absent one, because you conclude the metric is broken.
`test-ui.js` now enforces a minimum separation within each series group, and the
electrode colours are **derived** from `VizCore.CHANNEL_COLORS` rather than
hand-copied — they had drifted, so a ribbon in the visual and its own line on the
graph were different colours.

**A test that asserts the wrong thing is worse than no test.** One was pinning a false
claim about "sharp returns"; another compared two `AdaptiveNormalizer`s, which is
meaningless because any constant signal becomes its own baseline. When a test fails
after a behaviour change, decide which one is wrong before "fixing" either.

**Verify tests are not vacuous.** Inject the bug and watch it fail. This caught a
smoke test that only validated method *arguments*, so an `Infinity` assigned to
`ctx.lineWidth` sailed straight through.

**Poll, don't sleep, in `test-ui.js`.** The page ticks every 250ms; a fixed sleep that
is "obviously long enough" is how the suite becomes flaky, and a flaky suite trains
you to ignore failures.

---

## 7. NEXT TASK: chest-wall breathing from the H10 accelerometer

**Why.** Breath phase currently comes from RSA — the respiratory modulation of heart
timing. It works, but with two limits that are proven, not suspected:

- **It lags ~1.0s in a 5s cycle** (measured by cross-correlation in `test-polar.js`,
  correlation 0.43). The heart *responds* to breathing; it cannot predict it.
- **RSA shrinks as heart rate rises**, so it gates out exactly when the wearer is a
  bit activated. Real use at 89bpm produced no usable reading.

The H10 sits on the ribcage. Its accelerometer measures chest-wall movement, which is
breathing **directly** — no inference, no physiological lag, and it works at any
heart rate.

**The catch.** This needs Polar's proprietary **PMD** (Polar Measurement Data)
service rather than the standard Heart Rate Service. Approximate UUIDs — *verify
these against the device, do not trust them*:

```
service        FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8
control point  FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8   (write + notify)
data           FB005C82-02E7-F387-1CAD-8ACD2D8DF0C8   (notify)
```

Shape of the work: read the control point to discover supported measurement types,
write a start-stream request for ACC with a sample rate / range / resolution setting,
then decode a packed binary frame (type byte, timestamp, frame-type, then deltas —
Polar uses delta compression, which is the part most likely to be got wrong).

**Build it defensively, in this order:**

1. **Log raw frames first.** Do not write a decoder from assumption. Dump bytes,
   look at them, confirm the frame layout before parsing.
2. **Decode into a pure, tested function** in `polar.js`, exactly like
   `parseHeartRateMeasurement`. Hand-build frames in `test-polar.js`.
3. **Sanity-check against physics.** At rest the magnitude should sit near 1g, and
   breathing should appear as a slow oscillation of a few tens of milli-g. If your
   decode gives numbers that aren't accelerations, it's wrong.
4. **Extract breathing:** band-pass the axis with the most respiratory variance (or
   the projection onto the principal axis) over roughly 0.1–0.5 Hz, then take the
   phase. Gate on amplitude the way `RSA_MIN_BPM` does — no signal must read as *no
   reading*, never as a midpoint.
5. **Keep RSA as the fallback.** Precedence should be accelerometer → RSA → Muse PPG
   → the calm-linked guess. A wrong guess about the protocol must degrade, not break.
6. Feed it through the existing seams: `breathAmount` in `setState`,
   `features.breathPhase`, and the single `breathRow()`. Do not add new breath rows —
   see the warning below.

**Success test:** hold your breath. The bar should go flat and the row should say it
has no signal, promptly. Then breathe deliberately fast and slow; it should track
without the ~1s lag.

---

## 8. Backlog, in priority order

1. **Calibration trials.** The single most valuable thing left, and the only route to
   validating any score. Spec is in `ROADMAP.md` — single-task trials, one big button,
   no typing: press every time you notice you returned; press at the start and end of
   a quiet stretch; etc. Then a per-label table of what each metric did before/after
   each press, against a within-session random baseline. **If Focus cannot separate
   focus-presses from random moments, Focus measures nothing — and that is a finding,
   not a failure.** This is a table, not a model.
2. **Session storage.** Nothing persists between sessions, so the roadmap's
   "compare only to your own past" promise is uncomputable. Cheap (localStorage), high
   value.
3. **Scatter→recover in the report**, honestly framed this time. `recentReturns`
   already feeds the cue engine.
4. **Bloom's animation.** The owner said the gradients are "pretty perfect" but the
   animation/action needs work. Do not touch the gradients.
5. Iris/Corona/Pulse tuning as the owner reports back.

---

## 9. Do not

- **Do not remove a visual mode to replace it.** The standing instruction is to *add*
  alongside, so they can be compared. That is why there are 17.
- **Do not add a second row for the same quantity.** Breath once rendered three times
  (composite bar + rate row + phase bar), all labelled "Breath", saying different
  things.
- **Do not put anything inside the `#status` element.** `setStatus()` assigns
  `innerHTML` and will delete it.
- **Do not bind a connect handler with `{ once: true }`.** A failed connection must be
  retryable; that made the button dead forever after one click.
- **Do not use `{ hide: false }`-style truthiness on a metric.** `0` is a real
  reading; `null` is not.
- **Do not make a report number look like a measurement** without also surfacing how
  much usable signal it came from.
- **Do not claim the visuals look good** because the tests pass. Tests prove no
  crashes and no NaN geometry. Use `tools/shoot.js`, and then ask the owner.

---

## 10. Working style that has served this project

Write the pure logic as a requireable module with a test *before* wiring it into the
DOM or the canvas. When something looks wrong on screen, screenshot it with
`tools/shoot.js` rather than reasoning about the code — six bugs were invisible in the
source and obvious in a PNG. When you change a number that affects what a person is
told about their own mind, say plainly what changed and why, and prefer saying "no
reading" to saying something confident and wrong.
