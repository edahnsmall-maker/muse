# Muse Zen Spike

A working prototype: wear your **Muse S (Gen 2)**, and a full-screen visual
**responds to your own physiology in real time** — six visual modes, live graphs of
every sensor and composite score, in-the-moment cues, markers you can drop mid-sit,
and a downloadable session report. This is Phase 0/1 — proving the biofeedback loop
end to end before building the real app.

**The one thing to read first:** every interpretive score here (Calm, Thinking,
Focus…) is *unvalidated*. They're built from real, literature-backed signals, but the
weights and thresholds were chosen by hand, and nothing has been checked against
ground truth. The app says so out loud — every score carries an evidence tier in the
UI. See "Are the composite scores actually valid?" below.

There are **two ways to get the Muse's data in**, in `public/`:

- **`index.html`** — via the **Mind Monitor** phone app, which relays data over your
  WiFi to a small local server (`server.js`). Needs Node.js and a phone with Mind
  Monitor installed. This is the original path and works well on an unrestricted
  laptop.
- **`direct.html`** — **no phone, no app, no local server.** The page talks straight
  to the Muse over Bluetooth using the [Web Bluetooth API](https://developer.chrome.com/docs/capabilities/bluetooth),
  built into Chrome/Edge on Windows, macOS, Linux, **ChromeOS**, and Android. This is
  the one to use on a **Chromebook**, or any machine where you can't install Node.js
  or get a firewall exception approved (see "Hosting `direct.html`" below).

```
Path A:  Muse S Gen 2 ──BLE──▶ phone (Mind Monitor) ──OSC/WiFi──▶ laptop (server.js) ──▶ browser (index.html)
Path B:  Muse S Gen 2 ──────────────────────BLE (Web Bluetooth)──────────────────────▶ browser (direct.html)
```

## Path B: direct Bluetooth (Chromebook, or no admin rights) — no downloads at all

If you're on a Chromebook, or any machine where you can't install Node.js or get a
firewall exception approved, use **`direct.html`** instead — it needs nothing but
**Chrome** (already installed on ChromeOS) and this page loaded over `https://` (Web
Bluetooth refuses to run over a plain `file://` page, for browser security reasons —
`https://` or `http://localhost` only).

**Once this repo has GitHub Pages enabled** (see below), just open:

```
https://edahnsmall-maker.github.io/muse/public/direct.html
```

in Chrome, put your Muse on, click **Connect to Muse**, and pick it from the Bluetooth
chooser that pops up. That's the entire setup — no phone, no app, no server, no admin
password, ever.

### Enabling GitHub Pages (one-time, ~1 minute, only you can do this)

I don't have a tool that can flip this setting — it's an account-level toggle only the
repo owner can set. On [github.com/edahnsmall-maker/muse](https://github.com/edahnsmall-maker/muse):

1. **Settings** tab → **Pages** (left sidebar, under "Code and automation")
2. Under "Build and deployment" → **Source: Deploy from a branch**
3. **Branch: `main`**, folder **`/ (root)`** → **Save**
4. Wait ~1 minute, then the URL above will be live (GitHub shows a green checkmark
   with the live URL once it's ready)

## Path A: Mind Monitor + laptop (Windows/Mac/Linux with Node.js and no firewall restrictions)

## What you need

- Your **Muse S (Gen 2)**
- The **[Mind Monitor](https://mind-monitor.com/)** app (~$15, iOS/Android) on your phone
- **Node.js 18+** on your laptop (`node --version`) — no `npm install` needed, zero dependencies
- Phone and laptop on the **same WiFi network**

## Run it

1. **Start the server** on your laptop:
   ```bash
   node server.js
   ```
   It prints your local address, e.g. `http://localhost:8080`. Open that in a browser.

2. **Find your laptop's LAN IP** (the one the phone will send to):
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
   - Windows: `ipconfig` → IPv4 Address
   (Looks like `192.168.x.x`.)

3. **Configure Mind Monitor** on your phone → Settings:
   - **OSC Stream Target IP** = your laptop's LAN IP from step 2
   - **OSC Stream Port** = `5000`
   Put the Muse on, wait for good contact, then tap the **OSC stream** button (the
   little chart/stream icon on the main screen).

4. Look at the browser. Sit. Breathe slow. The field should warm and settle as your
   alpha rises. Press **`F`** for fullscreen, **`D`** to toggle the numeric readout.

   If Windows/macOS asks to let Node accept network connections and you don't have
   the admin password to approve it, you're blocked on this path — use **Path B** above
   instead, which needs no such permission.

## Try it without a Muse first

In a second terminal (server still running):
```bash
node sim.js
```
This streams a fake "calming" session so you can see the visuals move. Ctrl+C to stop.

## How the "calm" value works (and how to tune it)

**Path A (Mind Monitor):** Muse computes band powers on-device; Mind Monitor forwards
them over OSC to `server.js`, which takes **alpha − beta** (log-power difference ≈
`log(alpha/beta)`). Contact quality (`horseshoe`) and `touching_forehead` gate the
display so a loose headband doesn't produce garbage.

**Path B (direct.html):** there's no on-device band-power computation available over
raw Bluetooth, so the page does its own DSP, entirely in `public/dsp.js`: a 1-second
sliding window (256 samples at Muse's 256Hz) of the two frontal channels (AF7, AF8),
Hann-windowed FFT, band powers summed from the spectrum, same alpha−beta log-ratio.
This path has **no built-in contact-quality signal** (Muse's own impedance check isn't
exposed over raw BLE) — sit still and make sure the fit feels snug; a slightly damp
forehead/temple contact helps.

Both paths feed the ratio into the same **adaptive normalization**: a slow running
mean/variance tracks your own baseline (individual variability is too large for a fixed
threshold), squashed to 0–1 and heavily smoothed so the visuals glide instead of jitter.

## Real breathing (Path B only, from the Muse's PPG/heart sensor)

The visual's breathing pulse can follow your **actual breathing**, not just a
calm-linked guess. The Muse S Gen 2 has a PPG (optical heart) sensor. Heart rate
subtly speeds up on the inhale and slows on the exhale — respiratory sinus
arrhythmia — so your real breathing rate is recoverable from beat-to-beat heart
timing alone, with no separate breath sensor needed.

Pipeline (`public/dsp.js`): a simple peak detector finds heartbeats in the raw PPG
waveform (`detectBeats`), then `estimateBreathingPeriod` resamples the beat-to-beat
intervals onto a uniform grid and finds the dominant frequency in the normal
breathing band (6–30 breaths/min) via the same FFT used for EEG bands. Verified on a
synthetic PPG signal with a known, embedded breathing rate before ever touching real
hardware (`test-dsp.js`): recovers a 5.00s true period as 4.92s.

**This needs ~40 seconds of steady heartbeat data before it produces an estimate**
(fewer than a handful of breath cycles isn't trustworthy), so the visual runs on the
calm-linked guess at first and smoothly hands off to your real measured rate once
there's enough data. The readout just says "Reading…" until then, then shows
breaths/min once estimated — deliberately not a live-ticking counter, since a number
that just climbs while you wait isn't meaningful information.

This is a best-effort estimate, not a clinical measurement — motion, poor sensor
contact, or an irregular pulse waveform can all degrade it. If PPG doesn't work on
your unit/firmware for any reason, the app falls back automatically to EEG-only
(`p21` preset) and breathing just stays on the calm-linked guess — it should never
take down the core EEG/calm experience.

**Important honesty note: this measures your breathing *rate*, not the exact moment
you're inhaling vs. exhaling.** The visual's pulse tends toward your real tempo, but
it is not phase-locked to your actual breath — don't expect it to feel like it's
"synced" from moment to moment. Getting genuine real-time phase-lock would need much
more precise processing, and Muse's PPG sensor (temple/forehead) is a noisier
location for this than a fingertip, where real pulse oximeters go. We judged that
not worth chasing — rate-matching is the honest ceiling here for now.

## The readout (Path B) — Sensors or Composites, with a level bar on every row

There is a single overlay (bottom-right), always visible once connected. No hidden
technical mode, no separate debug view — just this. Every row is the same shape:

```
label   ●   ▓▓▓▓▓░░░░░   62
        │        │        └─ the value (0–100), or — when there's no data
        │        └────────── a level bar, so you can read it at a glance
        └─────────────────── the evidence tier light (see below)
```

A **Sensors / Composites** switch at the top of the data panel changes *both* the
readout and the graph, and the **visual retunes to whichever composite you've
selected** — so if you pick Focus, the Eclipse void is tracking focus, not calm.

- **Sensors view** — the 4 raw electrodes individually (`TP9`/`AF7`/`AF8`/`TP10`),
  each showing whichever band currently dominates at that specific electrode
  (`Alpha` / `Beta`), or `Noisy` if that channel's own signal is artifact-flagged
  right now. TP9/TP10 sit near the jaw/ear and will say `Noisy` more often than the
  frontal pair — that's expected, not a bug.
- **Composites view** — the interpretive scores (see the table below), each with its
  tier light, plus `Breath` (breaths/min once ~40s of PPG data exists, otherwise
  "Reading…" — deliberately not a live-ticking counter, since a number that just
  climbs while you wait isn't meaningful information), `Noise` (Low/Some/High, from
  the artifact rate), and `Timer` if one's running.

### The tier lights — a legend, because "hard to know what you're looking at"

| Light | Tier | Means |
|---|---|---|
| 🟢 solid green | **measured** | A direct, well-characterised signature in the raw signal. Not an interpretation. |
| 🟡 amber | **proxy** | Literature-backed, computed against your own baseline. Directional only: "more than before", not "how much". |
| ⚪ hollow ring | **exploratory** | No validated real-time marker for this exists on 4-channel consumer EEG. Interesting to watch. Do not draw conclusions. |

The legend sits next to the metrics in Composites view, with a clickable **"what?"**
that opens the full list — every metric's exact source *and* what it cannot tell you.

## Are the composite scores actually valid?

Short answer: **no, not yet — and the app is built to say so rather than hide it.**

`public/metrics.js` is the registry, and its header is the honest account: "calm" is
alpha minus beta (log power) at the two forehead sensors, normalised against your own
session baseline. The alpha/beta ratio is a common relaxation index in the EEG
literature, so it isn't arbitrary — but the band edges, weights, smoothing and
thresholds were all chosen by hand here, and none of it has been checked against
ground truth.

Three structural commitments follow from that, all unit-tested:

1. **Every metric carries its tier and caveat in code**, and the UI shows them. A
   speculative score is fine to look at; a speculative score dressed up as an
   instrument is not.
2. **A metric with no data returns `null`, never `0`.** "No reading" and "a reading of
   zero" are completely different claims. `equanimity` currently returns `null` on
   purpose — HRV steadiness isn't computed from the PPG beats yet, so it has nothing
   to say.
3. **Speculative metrics can be selected but are never a default** — nothing silently
   drives the whole screen off a score with no validated basis.

| Metric | Tier | Built from |
|---|---|---|
| **Calm** | proxy | alpha − beta log-power at AF7/AF8, vs. your session baseline |
| **Thinking** | proxy | beta level + band-balance churn + rate of abrupt shifts |
| **Focus** | proxy | steadiness of frontal theta (4–8Hz) |
| **Drowsy** | proxy | theta and delta rising while alpha declines |
| **Blinks** | measured | large slow deflections appearing on *both* forehead sensors |
| **Jaw / muscle** | measured | high-frequency broadband power (muscle EMG) |
| **L / R balance** | exploratory | alpha difference between AF7 (left) and AF8 (right) |
| **Equanimity** | exploratory | HRV steadiness — *not computed yet, reads as no data* |
| **Open awareness** | exploratory | sustained anterior alpha, low beta, low variability |

Two of those deserve calling out. **Drowsy exists mainly as a confound check, not a
goal** — alpha rises in relaxed wakefulness *and* in drowsiness, so if Drowsy is high,
treat Calm and Focus with suspicion. And **Blinks/Jaw are the only "measured" tier
entries** — they're eye and muscle movement, not brain states, and they're worth
watching precisely because they explain sudden jumps in everything else.

**What would actually make these valid** isn't more code — it's labelled data. That's
what the marker system below exists to collect.

## The visuals — six modes, click a pill at the top or press `V` to cycle

**Why there was "still no color", definitively:** every WebGL version computed a
*single* highlight colour and added that same colour for all four bands. The image
was structurally monochrome — dark navy plus one blue-white — so no amount of
tuning could make it colourful. Each electrode now has its own genuinely distinct,
saturated hue (`VizCore.CHANNEL_COLORS`, kept in sync with the data-graph legend so
a ribbon in the visual and its line on the graph are recognisably the same channel).
`test-viz.js` asserts all four hues differ and are actually saturated, so this can't
silently regress.

**Why Canvas 2D instead of a WebGL shader:** three shader iterations failed to
produce colour or legible data-correspondence. Shader colour grading had to be
written blind (nothing here can compile or view GLSL), and it twice hit GPU
float-precision bugs that only showed up on real hardware. Canvas 2D uses explicit
rgba colours, real blur, and eliminates that entire bug class. It also made the
renderer testable — see "Testing the untestable" below.

The six modes, in cycle order:

| Mode | What it is | What drives it |
|---|---|---|
| **Eclipse** | A black void on a warm light ground, ringed by a solar corona. Stillness *is* the void: it grows as you settle. Thinking flares at its edge. | Void radius = the selected composite (12%→74% of max radius). Corona churn, speed and brightness = the Thinking score. Its own hot palette (magenta/orange/gold/rose), on light — saturated colour added onto near-black just goes pale grey, which was the real reason earlier versions looked colourless. |
| **Iris** | Your whole session laid down as a rose window — a persistent record that accumulates rather than scrolling away. | Angular position = time; radial position and hue = per-channel activity. Nothing is erased, so at the end you're looking at the shape of the entire sit. |
| **Flow** | Chronological watercolour. "Now" sits just right of centre, history trailing left, one coloured ribbon per electrode. | Ribbon height = that electrode's alpha share; spikes = bright bursts. **Age-graded sharpness**: the newest zone is genuinely crisp (`blur: 0`), the middle softens, the oldest dissolves into a blurred wash — paint blurring as memory fades. |
| **Bloom** | No lines at all. Soft colour gradients emerge, expand, and fade — but only when something significant actually happens. | A per-channel spike (bloom in that channel's colour), or a calm-zone transition: settling (warm) / stirring (cool). |
| **Field** | One soft wavy band of colour per sensor — the "reference image" look, with real per-channel hue. | Band brightness/thickness = that electrode's alpha share; blur and width grow with calm ("dissolving"). |
| **Breath** | Austere. One slow gradient breathing in and out. Nothing per-channel, nothing to read or chase. | Your *measured* breathing rate, or one of the guided patterns below. This is the "mirror mode" of the roadmap's Zen framing. |

**Sensor positions are anatomical, not decorative.** In Eclipse and Iris the screen is
a plan view of your head from above, nose toward the top, so the left forehead sensor
appears upper-left (`VizCore.CHANNEL_ANGLES`). When the left side of the image reacts,
that *is* your left forehead. It converts an arbitrary pattern into a readable map.

### Breathing patterns (Breath mode) — a second pill row appears

| Pattern | Timing |
|---|---|
| **Follow me** | your own measured breathing rate from PPG |
| **Coherent 5·5** | 5s in, 5s out |
| **Box 4·4·4·4** | 4s in, hold 4, 4s out, hold 4 |
| **Relaxing 4·7·8** | 4s in, hold 7, 8s out |

Holds genuinely stop the motion rather than drifting, and every transition is eased
(`3t²−2t³`) so the turn-around at each end is gentle — a raw linear ramp reads as
mechanical, not as breath.

Two real bugs are worth recording here, because both produced "it flickers" reports
rather than obvious errors. Breath phase was originally `elapsedTime × omega`; since
`breathPeriod` is continuously re-smoothed and elapsed time is large, any tiny change
in period jumped the phase enormously. Fixed by **integrating phase per frame**. And
Flow appeared "stuck in the corner" because a per-frame fade of `0.994` compounds to
~0.70/second — it destroyed paint in ~10s while a full crossing took ~37s — plus
sub-pixel self-blits re-interpolating into mush. Fixed by drawing from an explicit
history buffer instead of feeding the canvas back into itself.

**Significant-event detection** (Bloom) uses hysteresis on purpose: you must cross
*above* 0.62 or *below* 0.42 to change zone, so ordinary wobble around a single
threshold can't fire events forever — the same bug class as the spike detector
firing every tick. Spike blooms fire on a fresh trigger only, never on the decay
tail. Both behaviours are unit-tested.

A real bug found by those tests: starting at a mid-range calm never established a
zone, so `zone` stayed `null` and the **first genuine transition was swallowed** by
the don't-fire-on-startup guard. Fixed by classifying the opening value into a
`mid` zone.

### Testing the untestable

`visual.js` draws to a canvas, which can't run here — but the thing most likely to
break it isn't the pixels, it's a plain runtime error in a render path that would
otherwise surface only as a blank screen on your machine. `test-visual-smoke.js`
stubs a minimal Canvas2D context and runs **every mode for 60 frames** with
adversarial state (nulls, out-of-range values, malformed/empty band arrays),
failing on any thrown error or any NaN/Infinity/negative geometry reaching a draw
call.

That test initially had a blind spot worth recording: it only validated *method
arguments*, so an injected `Infinity` reaching `ctx.lineWidth` — a **property
assignment** — sailed straight through and the suite still passed. Found by
deliberately injecting the bug to check the test wasn't vacuous. It now validates
property assignments too, and has been re-verified to fail on that injected bug and
pass on clean code.

It also enforces a **performance invariant**: `ctx.filter` blurs every draw operation
*separately*, so N fills under an active filter cost N full-buffer blur passes. Earlier
versions issued 4 (Eclipse), ~12 (Field) and ~12 (Flow) per frame. The fix in each case
is to draw unblurred into a scratch layer and blit it **once** with the filter applied;
the test now fails any mode averaging more than 2.2 blurred draws per frame, so this
can't quietly regress. Current: Eclipse 1.00, Iris 1.00, Flow 2.00, Bloom 0.00, Field
1.00, Breath 0.00.

Knobs, in `public/visual.js` / `public/viz-core.js`:
- `CHANNEL_COLORS` / `CORONA_COLORS` — the per-electrode hues (channel palette, and
  Eclipse's hot palette).
- `MODES` — order of the cycle; add one here and it's automatically reachable.
- `EventDetector({hi, lo})` — how far calm must move to count as settling/stirring.
- `BloomField({max, life})` — how many blooms coexist and how long each lasts.
- `BUF_MAX_W` — render-buffer width; smaller is softer and faster.
- `SPIKE_THRESHOLD` / `SPIKE_DECAY` via `DSP.SpikeDetector` in `direct.html`.
- **`expand(v, lo, hi)`** — the one to reach for if a visual over- or under-reacts.
  Adaptive normalization deliberately keeps scores clustered near 0.5, so feeding a
  raw score straight into a radius produced only ~12% of movement (that was the real
  "the void barely moved" bug). `expand` stretches the band the scores actually occupy
  (currently 0.35–0.75) out to a full 0–1. **That band is a fitted guess from
  screenshots, not a measurement** — if a visual now overshoots, widen it; if it's
  sluggish, narrow it. One line.

Knobs shared with the calm score itself:
- `server.js` (Path A) / `DSP.AdaptiveNormalizer` in `public/dsp.js` (Path B) —
  `adapt` (how fast it learns your baseline, lower = steadier), the logistic
  `slope` (higher = more dramatic swings), `smoothing` (lower = slower response).

## Data visualization (Path B)

A collapsible panel (bottom-left, "▾ Data") graphs everything over time — ~3 minutes
of history at 1 sample/sec, all on a shared 0–100 scale. The **Sensors / Composites**
switch at its top changes what's graphed, what the readout shows, *and* what the visual
is tuned to. Click a legend item to toggle that series on/off; click "Data" to hide the
whole panel. The data/scaling math (`public/chart.js`) is unit-tested independent of the
canvas drawing itself (`test-chart.js`) — ring-buffer capping and the right-aligned
"scrolls in from empty" coordinate mapping are both verified before ever touching a
canvas.

## Controls — clickable, not keyboard-only

A pill bar appears at the bottom on connect. Keyboard shortcuts still work and are
shown as small hints on the pills, but nothing requires remembering them.

| Control | Key | What it does |
|---|---|---|
| **Mark this moment** | `M` | freeze the timestamp and open the marker prompt |
| **training: on/off** | `T` | show a live timestamp so you can note times mentally |
| **cues: on/off** | — | enable/disable in-the-moment cues |
| **Session summary** | — | generate the report on demand, mid-sit or after |
| **Fullscreen** | `F` | — |

Plus the visual-mode pills at the top, the breathing-pattern pills (Breath mode), and
the timer buttons. `Esc` closes the summary.

One bug worth recording: global hotkeys fired **while typing a marker note**, so a note
containing "m", "t", "v" or "f" would drop extra marks or switch the visual mid-sit. All
global handlers now bail out through an `isTyping()` guard, and the number keys 1–6 pick
a marker category only while the note field is still empty.

## Cues — silence is the default

Toggleable, and deliberately rare: **at most one cue every 5 minutes**, nothing at all
for the first 60 seconds (let someone actually arrive before saying anything to them),
and never the same cue twice in a row. This replaced a constant "keep steady" nag, which
is the failure mode of every meditation app.

The rules are ordered by priority, first match wins (`public/cues.js`):

| Cue | Fires when | Says |
|---|---|---|
| **noisy** | noise > 0.5 | "Let your jaw and face soften — the signal is picking up tension more than anything else." |
| **returns** | ≥3 returns since the last cue | "You keep coming back. That returning is the practice — not the staying." |
| **thinking** | activity > 0.66 | "Thinking is fine. Come back to the breath, and keep it simple." |
| **settled** | calm > 0.66 for 45s+ | "Settling in now. Nothing to add, nothing to fix." |
| **stirred** | calm < 0.36 | "Wandering is normal. Begin again, gently." |
| **justthis** | settled 5+ minutes | "Just this." |

Two roadmap commitments are load-bearing here. **`noisy` outranks everything** because
every other metric is unreliable while it's true — and it's phrased as being about the
*measurement*, not about your mind. And **`justthis` only reaches someone already
settled a long while**: the scaffolding should thin out as a sit deepens, not thicken.
Nothing scolds; wandering is described as normal, because it is.

## Markers and training mode — the labelled data the scores actually need

Press `M` (or click **Mark this moment**) and a small prompt opens: a text note, an
optional duration, and one-tap categories — Note / Caught thinking / Sound / Body /
Emotion / Settled. **The timestamp freezes at the keypress**, so however long you take
to type, the mark still points at the moment you noticed. **Training mode** (`T`) shows
a live clock, so you can make mental notes of when things happened.

Notes are written **at the moment, not afterwards.** That was a considered decision by
the person actually using this, and it overrode my suggestion to defer annotation until
after the sit: when you intend to leave many marks in one sit, deferring the words means
spending the sit rehearsing a list of things to remember, which damages the sit far more
than a few seconds of typing does.

`public/markers.js` pairs each marker with **what the data was doing around it** —
`contextAround` reports the mean of every numeric field for the 30 seconds *before* and
30 seconds *after*, plus the change. Before/after rather than "at" for a specific reason:
a person marks a moment a beat or two late — you notice you were thinking, *then* you
press — so the interesting signal usually sits in the window leading up to the mark.
Reporting both sides lets a reader judge that themselves instead of trusting an
alignment assumption. `rankByMovement` surfaces the marks where something actually moved,
without claiming any causal story about them.

This is the path to validating the composite scores: moments where a human said what was
really happening, lined up against what the algorithms claimed at that same moment.

## Session summary and downloadable report

Fires when the timer ends, or on demand from **Session summary**.

**Predict, then reveal:** before showing any numbers, it asks how settled that felt,
1–5. Your own guess is recorded alongside the data. The point is to calibrate your
interoception, not to replace it — long-term success is needing the device *less*.

The summary describes rather than grades (`public/summary.js` — `describe` is
deliberately non-evaluative; a choppy sit is a normal sit), and **downloads as
self-contained markdown**: the trace as a sparkline, a downsampled data series, the cue
log, your self-rating, visual mode and breath pattern, and a **Marked moments** section
with before/after/change tables per marker — followed by a "How to read this" caveat
block, so a report read six months later still carries its own uncertainty with it.

That format is also designed to be pasted straight into a conversation with an AI to
look for patterns across sits — which is exactly how the marker notes become useful
("this was a sit where I was practising X, then a big fear thing happened around here").

## Session timer (Path B)

Pick a duration (5/10/20/30 min) once connected, or skip it. A plain "session
complete" message shows at the end — no alarm, no sound — and the countdown lives
in the same readout as everything else.

## Test

```bash
node test.js        # Path A: OSC parsing + the calm math, no hardware needed
node test-dsp.js    # Path B: FFT (checked against brute-force DFT), band-power
                     # isolation on synthetic tones, 12-bit decode, calm math,
                     # artifact detection, and breathing-rate recovery from a
                     # synthetic PPG signal with a known, embedded breath rate
node test-chart.js  # data-viz panel: ring-buffer capping, coordinate scaling,
                     # right-aligned partial-series layout
node test-viz.js    # visual logic: distinct per-channel hues, mode cycling,
                     # event hysteresis, bloom lifecycle, bounded wobble,
                     # breath patterns (holds actually hold), expand() range
node test-visual-smoke.js
                    # runs every visual mode for 60 frames against a stubbed
                    # canvas with adversarial state; fails on any thrown error,
                    # NaN/Infinity/negative geometry reaching a draw call, or
                    # more than 2.2 blurred draw ops per frame
node test-metrics.js # the evidence registry: every metric has a tier, source
                     # and caveat; missing inputs return null (never 0);
                     # out-of-range inputs are clamped, not passed through;
                     # speculative metrics are excluded from defaults
node test-markers.js # marker log ordering, annotation, before/after context
                     # windows, and movement ranking
node test-cues.js    # rate limiting, the 60s startup silence, no-repeat rule,
                     # and rule priority order
node test-summary.js # session stats, non-evaluative phrasing, downsampling,
                     # sparklines, and markdown report generation
```

All nine suites are expected to pass. Several of the bugs documented in this README were
found by these tests rather than by looking at the screen — including an `EventDetector`
that swallowed the very first real transition (a mid-range opening value never
established a zone, so the don't-fire-on-startup guard ate the crossing) and an FFT
sample-rate mismatch that skewed every breathing estimate (a synthetic 5.00s period came
back as 7.11s; after the fix, 4.92s).

One test was itself wrong and worth recording: the original `ActivityTracker` test
compared two separate trackers, which adaptive normalization makes meaningless — any
constant signal becomes its own baseline, so both read the same. Rewritten as a
*within-session* transition test: settled 0.40 → churning 0.75 → back down.

## Troubleshooting

**Path A (Mind Monitor):**
- **Browser says "waiting for Muse data"** → Mind Monitor isn't reaching the laptop.
  Recheck the target IP, confirm same WiFi, and allow Node through the laptop firewall
  (macOS will prompt the first time; Windows Defender may need an inbound UDP allow).
- **"adjust the headband — poor contact"** → wet the sensors slightly, sit still, make
  sure it's snug behind the ears and on the forehead.
- **Guest/public WiFi blocks device-to-device traffic** → use a phone hotspot or a home
  network. (Worth knowing now for the zen-center event: you'll want a network you control.)
- **Muse S Gen 2 not discoverable in Mind Monitor** → a known hiccup for this model on
  some phones. Toggle Bluetooth off/on, force-quit and reopen Mind Monitor, and make sure
  no other app (Muse's own app, BrainFlow, etc.) is already holding the BLE connection —
  only one app can be connected to the headband at a time.

**Path B (direct.html):**
- **"Web Bluetooth isn't available in this browser"** → use Chrome or Edge. Safari and
  Firefox don't implement Web Bluetooth at all (this is why this path can't help an
  iPhone — it's an OS/browser limitation, not something this app can work around).
- **The Bluetooth chooser shows no devices** → make sure the Muse is powered on and not
  already connected to another app (Mind Monitor, the Muse app, BrainFlow — only one
  app can hold the BLE connection at a time). Toggle the laptop/Chromebook's Bluetooth
  off and on if it doesn't appear after a few seconds.
- **"connection failed: GATT operation already in progress"** → a transient Bluetooth
  hiccup, not a real conflict — click "try again". If it persists, forget the device in
  your OS's Bluetooth settings and reconnect from scratch.
- **Page loaded but Connect button does nothing / errors immediately** → check the
  address bar starts with `https://` (or `http://localhost`) — Web Bluetooth refuses to
  run from a plain `file://` page.
- **This path has no headband-fit indicator like Path A's "poor contact" message** —
  it isn't available over raw Bluetooth. If the calm value looks stuck or erratic,
  check the physical fit yourself before assuming the app is wrong.
- **A visual looks static / nothing seems to happen** → check which mode you're in
  (the mode pills at the top, or press `V`). **Bloom** is *meant* to be mostly still —
  it only shows something when a genuinely significant event occurs, which can be a
  while apart. **Breath** is deliberately austere and has no per-channel response at
  all. **Eclipse**, **Flow** and **Field** react continuously, and **Iris** accumulates
  slowly by design.
- **Eclipse's void barely moves, or swings wildly** → that's the `expand()` band, and
  it's a fitted guess. See the `expand` knob above; widening or narrowing 0.35–0.75 is
  a one-line change.
- **A metric reads "—" and never fills in** → it has no data, which is deliberate
  rather than a failure. `Equanimity` always reads this way for now (HRV steadiness
  isn't computed yet); `Breath` reads "Reading…" until ~40s of PPG data exists.
- **No cue has appeared in a long time** → expected. Silence is the default: nothing
  for the first minute, at most one cue every five, and only when a rule genuinely
  matches.

## What's next

Built since this README first described "Phase 0": six visuals, the composite/sensor
toggle with evidence tiers, cues, markers + training mode, and the downloadable report.
Still open:

- **Ensō** — a seventh visual, fully specced from the design exploration but unbuilt: an
  ink stain spreading on wet paper, with granulation and a hard drying edge. Needs four
  buffers and a granulation tile, so it's a bigger lift than the others.
- **Validate the composites.** Not a code change — it needs sits with markers, then
  looking for what the algorithms got right and wrong. The machinery to collect that
  data now exists.
- **Equanimity for real**: compute HRV steadiness (RMSSD-style) from the PPG beats so
  the metric stops returning `null`.
- **Scatter→recover as a first-class thing.** `recentReturns` already feeds the cue
  engine; it should be counted and shown in the report as the rep counter it is.
- **Session-to-session history** — the roadmap's "compare only to your own past"
  commitment needs storage, which nothing here has yet.
- Move from a browser page to a real **phone app** (React Native / Flutter + BrainFlow)
  so each person at the center runs it on their own phone.

**A standing caveat about the visuals specifically:** nothing in the environment these
were written in can render or view a canvas. Every aesthetic change is a best-faith
translation of a description into code, verified only for correctness (no crashes, no
NaN geometry, bounded blur passes) — never for how it actually looks. If a visual is
wrong, the report of it is the only signal available.
