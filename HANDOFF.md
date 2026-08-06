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
| `public/breath.js` | 454 | Chest-wall breath rate + shape, with a MANDATORY cross-check against heart-derived breathing. **Loaded by `lab.html` only** — it needs minutes of accelerometer history and the RSA rate to check against, so it is a whole-sit measurement rather than a live one. It was loaded by nothing at all until recently, which is worth knowing if you go looking for its numbers in old exports: they are not there. |
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

## 3a. Two places, and they are different screens

`trainingMode` used to be a flag that armed recording and showed the mark bar while every panel and
number stayed put — two names for one screen, and it was reported as such. It now switches the chrome:

- **Meditate** is the visual and as close to nothing else as is safe. `body.meditating` hides the metrics
  panel, the live feed, the mark bar and the pattern bar, and `visual.setLegend(false)` takes the key off
  the canvas — that last one cannot be done with CSS because it is painted into the canvas.
- **Train** is the instrument.

**The trap, and it caught me twice.** The metrics panel is also where a fresh page says "No headband
connected — press Connect", and the control bar contains the Connect button. Hiding either
unconditionally recreates a defect that was already reported ("i dont see any panels. do i need to
connect in order to see the metrics?"). `body.preflight` keeps both visible until something is streaming,
and it is maintained ABOVE the tick's early return, because the transition it exists to catch is the
moment `result` is still null.

Anything in `test-ui.js` that measures a panel must therefore be in Train. The suite's main page clicks
`#placeTrain` on load for exactly this reason; a hidden element's rect is all zeros, which reads as a
layout bug rather than an absent panel.

## 4. Tests — 26 suites, all must pass

```bash
for t in test.js test-dsp.js test-viz.js test-visual-smoke.js test-chart.js \
         test-summary.js test-cues.js test-metrics.js test-markers.js \
         test-export.js test-import.js test-labels.js test-trials.js \
         test-probes.js test-analysis.js test-lab.js test-findings.js \
         test-panels.js test-polar.js test-clockcheck.js test-selfcheck.js \
         test-movement.js test-simdevice.js test-explore.js test-breath.js \
         test-ui.js; do node $t || break; done
```

`test-ui.js` now serves `public/` over **HTTP on an ephemeral port** rather than loading
`file://`. That was not cosmetic. A `file://` document treats every `<script src>` as
cross-origin, so an error thrown inside a module reaches `window.onerror` redacted to
`"Script error."` with no file and no line — which gutted the boot banner the moment the
logic moved out of `direct.html` into `app.js`, in exactly the direction that has already
cost two outages. It is also the only faithful test: Web Bluetooth requires a secure
context, so the real page is never opened as a file.

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

### `?sim=1` — you can run the whole app with no headband

`public/simdevice.js` replaces `navigator.bluetooth` with a fake Muse that emits real
packet layouts carrying a scripted signal: a 90-second arc from a beta-dominant "restless"
state to an alpha-dominant "settled" one and back. `direct.html?sim=1` installs it and
auto-connects.

Two things it bought, both of which had cost real time:

- **A diagnosis.** Every panel is hidden until a Bluetooth connection succeeds, so a broken
  build and a headband that is paired but not streaming produce the identical screen. Three
  separate rounds of "none of the panels open" were spent establishing which one it was.
  Now it is one reload.
- **Test reach.** Headless Chromium has no Bluetooth, so until this existed the suite could
  not touch a single line downstream of `connect()` — packet decoding, the metrics table,
  the visuals, all of it. That is precisely where the escaped bugs were. `test-ui.js` now
  drives a full simulated sit and asserts the panels open, Calm is in range, and Calm
  *climbs* as the arc settles (a frozen display and a working one are indistinguishable
  from a single reading).

Two things about it are non-negotiable and pinned by tests. It runs **only** for an
explicit `sim=1` — never as a fallback, never from stored state — and anything recorded
while it runs is marked in three independent places (filename prefix, a banner at the top
of `session.md`, and `SIMULATED.txt` in the archive; the lab prints **SIMULATED** in the
session list from the last of these). Simulated rows have the same shape as real ones, so
one pooled with real sits could never be separated again.

The alpha is a **band, not a sine**, and that is the one design note worth reading. The
first version used a single 10.2 Hz sine; `DSP.individualAlphaPeak` refused to find a peak
in it, correctly — the IAF gates require a hump at least 1.0 Hz wide, and that gate exists
to reject narrow spectral lines, which is what mains hum and bad electrodes produce. A
simulator built from pure tones cannot exercise the alpha path at all. There is also a real
1/f background, because `spectralBackground` fits a line through `log10(power)` and has
nothing to fit without one.

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
`Ribbon`, `Pulse`, `Corona` and `Silk` therefore bypass it and draw at full canvas
resolution (`DIRECT_MODES` in `visual.js`). They achieve softness in *geometry* —
stacked strokes of increasing width and decreasing alpha, or stacked translucent fills —
which also costs zero blur passes. `Ribbon` splits the difference: its soft fills go
through their own **half-resolution** layer (`RIBBON_SCALE`), because it is the most
per-pixel-expensive mode here, and only its hairline crest and head dots are drawn at
full resolution. Softness can be downsampled; a hairline cannot.

**Additive colour at low alpha over near-black desaturates toward grey.** This is why
several visuals "had no colour". Either draw genuinely bright, or use a light ground
(`Eclipse` does).

**A NORMALISED SCORE CANNOT SAY WHAT A SIT WAS, and a ratio of two normalised numbers
says almost nothing at all.** Every composite used to be built from `AdaptiveNormalizer`
outputs — within-sit z-scores. Two measured consequences: Calm spanned 42-53 across seven
sits whose physiology spanned twofold, rank correlation MINUS 0.32; and `drowsy` was
normTheta/(normTheta+normAlpha), where both inputs hover at 0.5 so the ratio did too — it
moved between 0.55 and 0.66 across a whole retreat sit. A band ratio is ALREADY scale-free;
normalising each side first removes the only information it carried. The composites are
absolute band shares now (`DSP.bandShares` and the four functions beside it).

**Fitting a display window to labels you like will produce a window that flatters.**
Calm's window was first set to [0.20, 0.42] by fitting four sits with written descriptions,
and it scored the peak retreat sit 91 — which looked like success until a deliberately
non-meditative session arrived (26 minutes, 11:46pm, "noisy from TV", "moving the mouse and
listening to music") and scored **72**. The window now comes from the pooled DISTRIBUTION of
every recording, which is a property of the signal rather than of anyone's opinion. Read the
long note on `DSP.CALM_WINDOW`: it carries the seven-sit table and the AUC.

**Alpha does not separate calm from not-calm on this hardware. Beta and gamma do.**
Measured: the non-meditative session had the same frontal alpha power as peak zazen to within
3% (72,833 vs 74,867), but 1.4x the beta and 1.7x the gamma. Alpha's share of alpha+beta
separates them at AUC 0.78, beta's share at 0.74, and `alpha/(alpha+beta+gamma)` at 0.787.
Anyone improving these scores should start from the fast bands, not from alpha.

**A frozen buffer classifies as clean forever.** A sit lost its EEG stream 115s in and the app
kept computing from `buffers[]` for 67 more seconds — `calmAbs` pinned at 0.10, Calm decaying
to 1, and `chanState` recording "ok ok ok ok" for every one of those rows. Every honesty rule
here was obeyed and defeated because the input LOOKED present. `eegStale()` is the gate;
freshness has to be checked before contents, always.

**An axis derived from the data is an axis that moves.** This cost three rounds of
"the lines still drift and i think it's bc the range is recent". `Flow`'s per-channel
traces now use a **constant** 0–0.75 window (alpha's share of alpha+beta is a bounded
ratio and needs no derived scale); its composites learn a range and then **freeze** it
(`settleRange`, `RANGE_HOLD_SEC`); and `Ribbon` uses a constant transform with no state
at all, which is why `test-visual-smoke.js` asserts it never calls `autoRange`,
`settleRange` or `inRange` rather than measuring how far its past moved. Prefer a fixed
axis whenever the quantity has a natural scale — it also makes two sits comparable by
eye, which an auto-ranged trace never is.

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

**A test that measures by POSITION breaks when the layout changes, and it breaks silently in the
worst case.** Three tests read readout rows with `slice(0, 4)` on the assumption that sensor rows led the
panel; grouping the panel into MIND / BODY / SIGNAL moved the electrodes under Signal and the assertions
started failing in places that had nothing to do with the change. Two lab tests read table cells by hard
index and a new checkbox column shifted every one of them. Find rows by their label and columns by their
header. Related and worse: a test that grows a panel by writing into `#readoutRows` is racing the 250ms
tick, which rebuilds that element — it passed for a while by having its own fixture wiped before the
check, which made it a test of nothing.

**A panel drag measured in exact pixels is measuring the animation.** A panel's start position comes from
the stylesheet and is routinely fractional (412.5 in one case) while `Panels.place` writes whole pixels, so
an 80px drag legitimately lands 79.5px away. Asserting `=== -80` passed by luck and then failed when a
one-line caption changed a panel's height by a pixel. Assert the property with a pixel of tolerance; a
broken drag misses by tens.

**Clamping must round INWARD.** `Math.round(clamp(...))` rounds a value pinned to a bound back across it:
vh 800 with a panel 287.5 tall gives a maximum y of 512.5, rounded to 513, bottom edge one pixel outside.
It had been wrong the whole time and nothing had landed exactly on the boundary until a caption grew a
panel by a pixel.

**Rendering every pane on every tab switch became a second of dead page**, and the note that said "if it
ever does become slow, the fix is a measurement first" was right to ask for one. With 8 analysed sits of
25 minutes a full render was 981ms, of which `renderClips` was 814ms — drawing an epoch canvas per mark
into a pane nobody was looking at. Data changes still render every pane (that is what stops a dropped
archive vanishing until you click the right tab); a tab switch renders only the pane it shows, and
`renderClips` returns early when its pane is hidden. A canvas drawn into a hidden zero-width box was
measured wrong anyway, so drawing it on the way in is strictly better than drawing it twice.

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

## 7. DONE: chest-wall breathing from the H10 accelerometer

Both stages are built and stage 1 is verified on hardware. Read
[`docs/polar-pmd.md`](docs/polar-pmd.md) before touching any of it — the protocol,
the four things that turned out to be wrong, and what the gravity check can and
cannot catch are all recorded there.

**Where breath comes from now:** precedence is **chest → RSA → PPG**, in
`Polar.AccelBreath` (`public/polar.js`) and the strap tick in `direct.html`. The row
shows its source, because chest motion and an inference from beat timing are not the
same quality of number.

**Four mistakes this cost, all of the same kind** — reasoning about a protocol instead
of listening to the device, with a test that agreed with the reasoning:

1. **The PMD service was not in `optionalServices`,** so ACC could never start. Web
   Bluetooth grants access per service at pairing time.
2. **Error 5 on every start request.** Five encodings were tried; all refused. The
   device's own settings response said why — it advertises `sampleRate`, `resolution`
   and `range`, and **no `channels`** — and every attempt had either sent `channels`
   or dropped `range`. The ladder was searching the encoding axis while the wrong
   thing was the *set of settings*. Send exactly what the device advertises.
3. **The ACC frames are not delta-compressed**, whatever the spec's delta section
   implies. The delta decoder returned one sample per frame instead of 36, and on some
   frames invented values — a strap lying still read **16,122,280 mG**. Content is a
   flat array of `int16` triplets.
4. **`isResponse` (the 0xF0 marker) was computed and never checked,** so any
   notification could be read as a control response and its byte 3 reported as the
   device's error code.

**Every unit test involved passed throughout all four.** Each was built from the same
notes as the code, so it checked the notes against themselves. The replacements are
`fixtures/h10-acc-frames.js` — real bytes from the device, with **gravity** as the
assertion, which is ground truth this codebase does not define.

**Two things gravity cannot establish, and must never be assumed:**

- **Which axis faces the chest.** Magnitude is invariant under permuting axes. The
  axis is chosen at runtime by respiratory-band power.
- **Which direction is inhale.** The strap can be worn either way up. RSA settles it,
  because heart rate rises on inhalation — so the lagging sensor orients the fast one.
  Until it has, `signKnown` is false and the UI falls back to RSA rather than guess.

**The payoff, and the thing to check first if you change this:** a breath hold is now
a *state*. Held at the top of an inhale the chest stays expanded, so the bar stays
right of centre, drains its colour, and reads `hold`. RSA could never express that —
a held breath has no respiratory modulation, so "holding at full inhale" and "sensor
dead" were the same picture.

**Tuning that is still a first guess:** `ACC_BREATH_DEFAULTS.holdFraction` (0.35) and
`minMilliG` (3). The hold test is relative rather than absolute for good reason, but
the numbers themselves want a session of deliberate holds to confirm.

---

## 8. THE VALIDATION PATH (built)

Every score here is unvalidated, and the bottleneck was never analysis — it was labels.
Four pieces now close that loop. Read them in this order.

**`public/labels.js`** — the phenomenological schema, in the practitioner's own words.
Four dimensions (focus, effort, pull, tone), each 1-5 with every point named, because an
unnamed middle drifts between sits. Focus and effort are recorded SEPARATELY, and that
is the whole point: "focused because nothing needed holding" and "focused because I was
holding it by force" are different experiences that a single score cannot tell apart.
`quadrant()` names all four states. Nothing in the app may generate or default these.

**`public/probes.js`** — two kinds of label, with different biases, and both are needed.
Self-caught taps are precise in time but can only sample what you NOTICED, so they are
blind to being gone without knowing it. Probe-caught answers are decided by a clock, so
they sample the unnoticed states and give a proportion rather than a count. Together
they yield `metaAwarenessGap()`, which is a measure of awareness rather than of
concentration. Probe intervals are random (a fixed interval becomes one you wait for),
the question asks about the moment BEFORE the cue, and the seconds after are excluded.

**`public/trials.js`** — protocols where the instruction IS the label, decided in
advance so it cannot be coloured by what the screen shows. **Run `alpha-control`
first.** It is eyes-closed versus eyes-open, six minutes, and it is not a meditation
trial at all: alpha rises when the eyes close, textbook since the 1920s. If this
pipeline cannot recover that, the electrodes or filtering or export is broken and every
subtle finding from the same pipeline is worthless. Same principle as gravity for the
accelerometer — find the ground truth you do not control.

**`public/analysis.js`** — exists to be SUSPICIOUS. Held-out validation split by
SESSION (splitting by sample leaks the answer, because consecutive seconds are
near-duplicates), FDR correction with the comparison count reported, seeded permutation
nulls. `eventLocked()` averages the signal around marks; its null is a MAX-STATISTIC,
because reading a surrogate at the real data's peak bin is circular — the peak was
chosen partly for its noise. 160 comparisons on pure noise confirm zero.

**`public/findings.js` + `public/lab.html`** — the lab reads session zips offline and
reports in sentences, with the numbers behind a toggle. "Copy findings for an AI"
produces ~4kB of prose that LEADS with what the data cannot support, because handing
over a table produces confident confabulation in any reader.

### The rule that holds all of it together

A finding is a CANDIDATE. It becomes a result by being predicted in advance and then
observed in sits recorded afterwards — which means a trial, not more searching on the
same data. Nothing gets wired into the live app's scores or visuals before that.

### Mistakes already made here, so they are not made again

- A test built from the same notes as the code passes while the code is wrong. Four
  separate times. Use ground truth you do not control: gravity, the system `unzip`, the
  Berger effect, a planted frequency the implementation is never told.
- FDR controls the expected PROPORTION of false discoveries, not their absence. A test
  demanding zero spurious survivors asserts a guarantee the statistics do not give.
- Anything driven by a wall clock must sit ABOVE the tick's `if (!result) return`.
  Three bugs so far from that one: a stuck status message, a timer that never fired
  when the headband dropped, and a trial that would have stalled mid-run.

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
4. **Legends on the other per-channel modes.** Flow has one; `drawLegend(c, W, H,
   entries)` in `visual.js` is deliberately reusable and takes W/H so it works for
   both the full-resolution modes and the small-buffer ones. Field, Silk and Iris
   have the same ambiguity. Entries come from `VizCore.legendEntries()` so a key can
   never drift from what is actually drawn. The owner asked for Flow first.
5. **Bloom's animation.** The owner said the gradients are "pretty perfect" but the
   animation/action needs work. Do not touch the gradients.
6. Iris/Corona/Pulse tuning as the owner reports back.

---

## 9. Do not

- **Do not remove a visual mode to replace it.** The standing instruction is to *add*
  alongside, so they can be compared. That is why there are 17.
- **Do not add a BLE service without declaring it in `requestDevice`.** Web
  Bluetooth grants access per service at pairing time; anything not in `filters` or
  `optionalServices` fails with "Origin is not allowed to access the service", even
  on an already-connected device. This silently blocked the H10 accelerometer for a
  whole round trip — the decode was correct, the permission was never asked for.
- **Do not add a fourth child to a `.rRow`.** It is a three-column grid (label /
  bar / value); a fourth element pushes the value onto its own grid row. Tier
  confidence lives in the info overlay, not the live table. `test-ui.js` measures
  row height, because this reached the user twice — once from a missing
  `white-space: nowrap` and once from exactly this extra child.
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
