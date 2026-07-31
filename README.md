# Muse Zen Spike

A working prototype: wear your **Muse S (Gen 2)**, and a full-screen visual
**responds to your own physiology in real time** — eight visual modes, live graphs of
every sensor and composite score, in-the-moment cues, markers you can drop mid-sit,
and a downloadable session report. This is Phase 0/1 — proving the biofeedback loop
end to end before building the real app.

> **Picking this project up cold, or handing it to another agent? Read
> [`HANDOFF.md`](HANDOFF.md) first.** It is the map: architecture, the honesty rules
> that are load-bearing, the bugs already paid for, the next task specified in detail,
> and a "do not" list. `ROADMAP.md` is the product intent; this README is the
> per-feature detail.

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

## The visuals — eight modes, click a pill at the top or press `V` to cycle

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

The eight modes, in cycle order:

| Mode | What it is | What drives it |
|---|---|---|
| **Eclipse** | A black void on a warm light ground, ringed by a solar corona. Stillness *is* the void: it grows as you settle. Thinking flares at its edge. | Void radius = the selected composite (12%→74% of max radius). Corona churn, speed and brightness = the Thinking score. Its own hot palette (magenta/orange/gold/rose), on light — saturated colour added onto near-black just goes pale grey, which was the real reason earlier versions looked colourless. |
| **Iris** | Your whole session laid down as a rose window — a persistent record that accumulates rather than scrolling away. | Twelve petals, each sensor owning its own quadrant at its real anatomical angle. A live crown scallops with current activity; every 6s that crown is *fossilised* onto a record layer and the radius steps outward, like a growth ring. Nothing is erased, so at the end you're looking at the shape of the entire sit — which minutes were whole and which were broken stay visible. |
| **Pulse** | A clock hand sweeps a dial once every 24 seconds, resetting at twelve. Each composite metric owns a ring; wherever the hand is now, that ring **bulges** by how much the metric is doing, and the bulge stays and fades as the hand travels on. | So a rising metric reads as a spiral of growth — small at three o'clock, bigger at six, biggest at nine — and a subsiding one reads as the reverse, the whole last revolution legible at a glance. Bulge is mostly *change* against each metric's own slow baseline (flaring is what the eye reads), with a little absolute level mixed back in so sustained calm doesn't look like nothing happening. Calm and Focus grow **inward**, inside the void; Thinking and Drowsy grow **outward** past the rim — so settling reads as the centre filling with light and thinking reads as flaring at the edges. |
| **Corona** | The same clock sweep as Pulse, but all four metrics packed into the same radius band so they overlap directly, added together, with no crisp edge anywhere. | One corona whose colour and shape vary around the dial rather than four separate readouts. Pulse's dark gaps between rings read as lanes on a track; this has none. Much higher sensitivity, since with no outline to read there is nothing to see unless the shape genuinely moves. Kept **alongside** Pulse: the lanes are more legible, the corona is more beautiful, and which one actually helps someone settle is an open question only comparison answers. |
| **Flow** | A live trace with a **legend**, thin and sharp where it's being written, dissolving as it ages. "Now" sits at ~74% across, history trailing left. | Follows the **Sensors/Composites switch** — four electrodes or four composites, in the matching colours. A bright point marks the live head; spikes leave marks that fade with the trace. |
| **Bloom** | No lines at all. Soft colour gradients emerge, expand, and fade — but only when something significant actually happens. | A per-channel spike (bloom in that channel's colour), or a calm-zone transition: settling (warm) / stirring (cool). |
| **Field** | One soft wavy band of colour per sensor — the "reference image" look, with real per-channel hue. | Band brightness/thickness = that electrode's alpha share; blur and width grow with calm ("dissolving"). |
| **Breath** | Austere. One slow gradient breathing in and out. Nothing per-channel, nothing to read or chase. | Your *measured* breathing rate, or one of the guided patterns below. This is the "mirror mode" of the roadmap's Zen framing. |

### Seeing the visuals: `tools/shoot.js`

Every visual here was written blind for most of this project's life — the renderer
draws to a canvas, nothing in the authoring environment could display one, so
aesthetics could only be checked by the person wearing the headband. That loop is slow,
and it is the real reason three earlier shader attempts never converged.

`tools/shoot.js` closes it. Chromium is already present via Playwright, so the renderer
runs for real against a **deterministic clock** (`tools/harness.html` replaces
`performance.now` and `requestAnimationFrame` before `visual.js` loads, so a given
simulated second always produces the same frame), driven by scripted physiology, and is
photographed at chosen moments.

```bash
node tools/shoot.js --mode pulse --scenario bursty --at 20,70
node tools/shoot.js --all --scenario realistic --at 45
```

Scenarios: `flat` (nothing moves — anything that still looks alive is animating on time
alone), `realistic` (values near 0.5, the regime where under-scaled visuals look dead),
`settling`, `agitated`, `bursty` (real second-to-second structure, the one that
distinguishes "working" from "drawing a circle"), `swing`.

**It found six real bugs across two sittings**, none of which were visible in the code: Flow
mapping values straight to y so a real session used 18% of the screen height; a string of
beads along every line (adjacent age groups share an endpoint, and a round cap there gets
drawn twice under additive blending); Pulse's trail stepping at twelve o'clock where the
ring buffer wraps; Pulse's inward-growing rings bulging through the centre and out the
other side as a spray of spikes; and Flow's peaks flattening against the frame edge
because `expand()` hard-clamps; and Flow's trace being legible as noise rather than
signal, because `expandSoft` multiplies jitter by exactly the factor it multiplies
signal — so fixing "the line is flat" produced "the line is too jumpy," and the real
answer was a centred (non-lagging) moving average in time.

**What it does not verify:** how it feels in motion, how it looks at full size in a dark
room, or GPU-specific behaviour — headless GL is software-backed, so colour and precision
can differ from real hardware. It informs judgement; it does not replace the person
sitting in front of it.

### Two modes render at full resolution, and that's load-bearing

Every mode draws into a shared buffer capped at 560px wide, which is then upscaled to
the window — cheap, and ideal for soft washes, because a blur pass over a small buffer
costs almost nothing. It is also **fatal to a thin sharp line**: at a ~4× upscale, a 1px
stroke arrives on screen as a 4px smear regardless of what filter is or isn't applied.

**Flow** and **Pulse** therefore bypass the buffer and draw straight to the canvas at
full resolution (`DIRECT_MODES` in `visual.js`). Neither uses a blur filter, so neither
needs the small buffer in the first place.

Flow's first version was reported as messy: fuzzy at the live edge, too thick, too
bright, and with "sharp dividers on the blur effect." All four were the same root
cause. It blitted the layer through **three clipped x-zones** at different blur radii to
fake age-graded sharpness — which produces exactly the hard vertical seams described,
overlapping alpha couldn't hide them, and the "crisp" zone was still soft because it was
being drawn 11.5% of screen height thick and then magnified. Four channels composited
additively on top of that is what blew it out to white.

It now draws at full resolution with **softening done in geometry, not with a filter**:
each age band is stroked three times — a wide faint halo, a mid, and a narrow bright
core — with width and alpha varying continuously band to band. Adjacent bands differ only
slightly, so the ramp reads as a gradient instead of a boundary. Blur passes went from 2
per frame to **zero**.

Iris was initially reported as "boring and small," and both halves turned out to be
bugs rather than taste. **Small:** it took 200 rings × 5s ≈ **17 minutes** to reach the
rim, starting at 13% of the radius — so for the entire window in which someone decides
whether it's worth watching, it was a small blob. Now 84 rings × 6s ≈ 8.4 minutes,
starting at 34%. **Boring:** the petal amplitude was scaled by the *current* ring
radius, so early on the scalloping was sub-pixel and four soft quadrant gradients
collapsed into a fuzzy ball. Tracery is now sized from the disc (constant), there's real
angular repetition (12 lobes), and the petal edges are **stroked sharp directly onto the
destination** while only the coloured body goes through the blur — a rose window is
stone lines as much as glass, and blurring everything was what erased the structure.

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

### Breath phase — the thing that was missing until now

Every earlier version had breathing **rate** only. RSA tells you the *frequency* of
the respiratory modulation in heart timing; it says nothing about where in the cycle
you are. So nothing could swell on the inhale and contract on the exhale, and
"Follow me" was running a synthetic sine at roughly the right rate — which drifts out
of step with the actual breath within a cycle or two.

The mechanism, now implemented: heart rate genuinely **accelerates on the inhale and
decelerates on the exhale**. So instantaneous heart rate, with its slow drift removed
and its amplitude normalised, *is* the breath waveform. Positive means inhaling. No
extra sensor needed — the chest strap's beat timing is clean enough.

Four things use it:

- **A centred bar in the metrics panel.** Midpoint is the turnaround; it fills upward
  on the in-breath and downward on the out-breath. Deliberately not a 0–100
  left-to-right fill, which would render an exhale as a low score. **Exactly one
  row**, carrying the rate and direction with it — a first version rendered breath as
  a composite bar, a rate row *and* a phase bar, three rows all labelled "Breath"
  saying different things.
- **A `breath` series in the live graph**, oscillating about the centre line.
- **"Follow me" genuinely follows** now, driven by measured phase rather than a
  generated rhythm.
- **A breath wave in Flow** about the vertical midpoint, drawn from the same history
  buffer as the traces — so it's the real recorded breath and you can see where the
  rhythm changed. Drawn *first* and kept dim: it's context, not a competing line. A
  first attempt drew it last at 30% amplitude and it swamped the sensor data
  completely, which a screenshot caught immediately.

**Two honest limits, both unavoidable, and one of them measured rather than guessed:**

1. **RSA lags the breath** — the heart responds to breathing, it doesn't predict it.
2. Detrending with a centred window makes the most recent sample the least reliable.

There is also a **third limit found in real use**: the first version normalised by RMS
and hard-clamped to ±1, so a weak or noisy signal spent long stretches pegged at the
rail — the bar sat at 100 and stopped moving, which reads as a confidently-detected
held inhale. It now saturates smoothly (`tanh`) and, more importantly, **refuses to
report at all below `RSA_MIN_BPM`** of respiratory swing in heart rate. Real RSA at
rest is several bpm; below that threshold there is no breath in the signal, only noise
being amplified. RSA also shrinks as heart rate rises, so a fast heart legitimately
yields no reading — and that now shows as *no reading* rather than a pegged bar.

`test-polar.js` cross-correlates the recovered waveform against a known synthetic
breath and reports the total lag: **1.0 second in a 5-second cycle**, correlation
0.43. Good enough to watch and follow loosely; **not** a metronome to breathe
against. The bar is labelled "est" and the metric carries this caveat in its registry
entry.

**If that lag proves too much,** the real fix is the strap's **accelerometer** via
Polar's PMD service: the H10 sits on your ribcage, so chest-wall movement is direct
breath measurement with no physiological lag at all. Bigger protocol job, and worth
doing only if the RSA estimate isn't good enough in practice.

**Not the Muse's gyroscope.** It does have one (and an accelerometer), and they are
reachable over BLE — but the head barely moves with breathing, and head-mounted
accelerometry mostly reports postural sway. It would be a lot of work for a weak
signal when the strap is already on your chest.

## Connecting devices: a persistent bar, not a one-shot screen

Both device buttons live in a bar that stays on screen for the whole session, and
either device can be connected at any time in either order. That is a fix, not a
preference — two bugs made the previous version unusable:

1. **`setStatus()` assigns `statusEl.innerHTML`, and the buttons were inside
   `statusEl`.** So the very first status message — `"choose your Muse in the
   browser picker…"` — deleted both buttons from the DOM. "Connect to Muse" became
   unpressable, and after connecting the headband the strap button was
   unreachable. The buttons now live in their own `#devices` container that
   `setStatus` never touches.
2. **Everything that clears the status sat behind `if (!result) return;`**, which
   requires Muse data. With only the strap connected, the "HRV needs about 20s of
   beats" message never cleared and the page looked frozen. The status expiry and
   the device bar now render unconditionally, before that early return.

Also fixed while in there: `connectBtn` was bound with `{ once: true }`, so a
*failed* connection could never be retried — one click and the button was dead
forever. Both buttons are now retryable, guarded by connecting/connected state
rather than by consuming the listener.

**A strap-only session is a legitimate state** and now renders properly: the strap
alone gives heart rate, HRV and a real breathing rate, none of which need EEG. The
readout says "Headband — not connected" rather than implying EEG data exists.

`test-ui.js` covers all of this in a real browser, and was verified non-vacuous by
re-injecting the original bug and watching it fail.

## The Polar H10 chest strap (optional second device)

**Yes, two Bluetooth devices at once works.** Web Bluetooth connects them
independently — each `requestDevice()` needs its own user gesture, which is why the
strap has its own **+ heart strap** button and can't be chained off the Muse
connection, and each gets its own GATT connection. They don't contend for anything.
The strap is optional in both directions: without one the EEG side is unchanged, and
a strap that drops out mid-session disturbs nothing.

It reads the **standard** Bluetooth Heart Rate Service (`0x180D`), not Polar's
proprietary PMD service. The standard characteristic already carries RR intervals —
the beat-to-beat timings, which is exactly and only what HRV is computed from — so
this is stable across firmware and works with any HR strap, not just this one.

What it adds (`public/polar.js`, tested in `test-polar.js`):

| | |
|---|---|
| **Heart rate** | direct, measured |
| **HRV (RMSSD)** | standard short-term HRV over a rolling 60s window |
| **`hrv` metric** | RMSSD normalised to your own baseline. Tier: **proxy** |
| **`equanimity`** | finally computes — from HRV *steadiness*, not level. Still **exploratory** |
| **Breath phase** | *where you are in the breath*, not just the rate — see below |
| **Breathing rate** | recovered from RSA and it **takes precedence over the Muse's PPG** — ECG-grade beat timing at the chest beats an optical pulse read through a temple. Verified at 4.92s for a true 5.00s |

**Steadiness, not level, feeds equanimity.** That's deliberate: a person can have
high HRV and still be reacting to everything. `SteadinessTracker` reports the
inverted coefficient of variation of RMSSD, which is *relative*, so someone with high
resting HRV isn't scored differently for the level.

**The artifact rejection is the load-bearing part.** A strap occasionally misses a
beat, producing one interval about twice as long as its neighbours. RMSSD squares
successive differences, so a single such interval contributes two enormous terms.
`test-polar.js` measures it: an unrejected missed beat took RMSSD from **30.0ms to
182.2ms** — a six-fold inflation that would appear as a sudden flood of
parasympathetic calm at the exact moment the strap slipped. Intervals outside
300–2000ms, or more than 25% away from the previous one, are discarded, and the
reject rate is reported. Above 30% rejected (or on lost skin contact) the readout
says so and the report prints a banner instead of presenting the figures as
physiology.

**Honest limit on what HRV means:** RMSSD is a real measurement and the strap is
ECG-grade, so the *number* is solid — that's why HR and RMSSD carry the green
"measured" light. What it *means* is the proxy part. Higher RMSSD indicates
parasympathetic (rest) activation, which correlates with calm, but **it also rises
with slow breathing regardless of mental state** — so you can move it deliberately
without settling at all. That caveat travels with the numbers in the report.

## Testing the untestable

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
can't quietly regress. Current: Eclipse 1.00, Iris 1.00, Pulse 0.00, Corona 0.00,
Flow 0.00, Bloom 0.00, Field 1.00, Breath 0.00.

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

The bar is three labelled groups — **View**, **Practice**, **Session** — in the order the
practice uses them: what you are looking at, what you are doing, and what happens to the
sit afterwards.

| Control | Key | What it does |
|---|---|---|
| **Training: on/off** | `⇧T` | the tap panel, and starts recording |
| **Notes** | `N` | text notes, timestamped or not, with a deletable history |
| **Hold to speak** | hold `V` or `space` | a voice note, transcribed if the browser can |
| **Mark** | `M` | freeze the timestamp and open the marker prompt |
| **Summarize session** | — | generate the report on demand, mid-sit or after |
| next / previous visual | `]` `[` | step through the seven visuals |
| — | `F` | fullscreen (no pill — it is a one-off at the start of a sit) |
| — | `Esc` | close the summary |

Plus the tap-category keys while Training is on (`C A J T R E U K S` — see `probes.js`),
`1`/`2` to grade a tap that offers grades, and `1`–`5` to answer a probe.

**The four arrows are the four common taps**, so they can be reached without finding a
letter with your eyes shut:

```
              ↑  focusing (concentrating)
   ← returned              thinking →
              ↓  just sitting
```

They are aliases, not separate categories — same key, same record, so nothing downstream
knows which finger produced a mark. The rarer ones (kenshō, satori, restless) stay letters:
a rare mark is worth a deliberate keystroke.

`T` is **Thinking**, because it is the most-pressed category by a distance and the letter
should match the word you say to yourself. That took `T` away from Training, which moved to
`⇧T` — a once-per-sit action can afford a modifier; a tap you make every few minutes with
your eyes shut cannot. Both `test-probes.js` and `test-labels.js` assert that the tap keys
don't collide with the app's own, and both caught this collision when `T` was reassigned.

**Cues and probes are both off by default.** An unrequested interruption during a sit is
something to opt into, not out of. Probes used to be implied by Training mode, which made
one switch mean two things — turning on the tap panel also signed you up for a question
every few minutes. They now have their own toggle, in the training panel where it is
relevant, and they are still worth turning on sometimes: a self-caught tap can only sample
what you *noticed*, so it is structurally blind to being gone without knowing it.

Two collisions worth recording, because both came out of real sits and both are the same
mistake in different forms:

* Global hotkeys fired **while typing a note**, so a note containing "m" or "t" dropped
  extra marks mid-sit. All global handlers bail out through an `isTyping()` guard.
* `V` was bound **twice in one handler** — to cycling the visual and to starting a voice
  note. Both ran, and only the voice branch checked `e.repeat`, so holding `V` to speak
  also walked through every visualisation, one per key-repeat, while recording. Cycling
  moved to `]`/`[`. A letter shared between a hold gesture and an action cannot be made
  safe by reordering the branches; the collision itself has to go.

### The clip library

Every marked moment from **−15s to +15s**, each clip drawn thin, their average bright, and
behind them the band that random windows from the same sits produce. Selectable by mark
category, by signal, and by baseline mode.

The individual clips are drawn, not just the average, because an average of twelve windows
hides whether it came from twelve similar shapes or one enormous outlier — and at this
sample size that is the whole question. The surrogate band is what makes the average
readable at all: averaging *any* set of windows produces a smooth curve, so a smooth
average is never the finding. The finding is the average leaving the band, and the view
says so in those words plus where and by how much.

**The baseline decision came from the practitioner and it matters:**

> *"Since the mark is when I notice I was thinking, don't use the immediately preceding
> period as the only baseline — that may erase the effect we're looking for."*

Correct, and it is a real trap. Standard practice baselines against the seconds just before
the event, assuming they are neutral. On a self-caught mark they are the opposite: you
pressed *because* something was happening just then, so subtracting that period subtracts
the signal. Three modes, default first:

| mode | what it does |
|---|---|
| **none** (default) | the within-session z-scored trace, untouched — nothing event-locked removed |
| **far** | subtracts the earliest third of the window, deliberately *not* the adjacent seconds |
| **detrend** | removes a straight line per clip — kills drift spanning the window |

Vertical units are standard deviations *within each sit*, so clips from different days are
comparable without any event-locked structure being removed. Every mode is applied
identically to the surrogate clips, or the comparison would be rigged.

`test-analysis.js` plants a ramp confined to the ten seconds before each mark and checks
all of it. Two of my own expectations were wrong there and the tests record both: detrending
does **not** flatten a localised run-up (a line fit across 31s can't absorb a 10s ramp — it
measured 6.52 against 6.11, very slightly *more*), and near-baselining destroys the
**elevation** rather than the shape, which a within-window difference cannot detect at all
because a constant offset cancels in a subtraction.

### Straight from a sit into the lab

The summary offers **Open in analysis lab** next to the two downloads. Downloading a zip
and dragging it back in is a step that gets skipped, and a sit that never reaches the lab
never gets analysed.

The app and the lab share one IndexedDB — same origin, verified including over `file://`,
where both report an origin of `"file://"` — so the app writes the finished archive to an
inbox and the lab drains it when it opens. It hands over **archive bytes**, not a
pre-parsed record, so a handed-over sit and a dropped file travel exactly the same parse
path; a second ingest path would be a second thing to keep correct, and drift between two
paths meant to agree is the bug this project keeps paying for. Delivery is read-and-delete
in one transaction, so a sit arrives exactly once however often the lab is reopened, and
the Loaded list says which sits came from the app rather than from a file.

### The lab remembers

Two things persist in the lab's own IndexedDB (`public/labstore.js`), separate from the
app's recordings so a lab bug can never touch the only copy of a sit:

- **The loaded sits.** Reopen the lab and your archives are still there, re-analysed from
  restored data. Removing one really removes it, rather than having it reappear on the
  next reload.
- **Dated analysis snapshots.** *Save this analysis* writes the report prose, the
  structured findings, and **which sits it rested on** — append-only, never overwritten.
  Reopening one shows what it said *then*, not a fresh run; re-deriving would print
  today's answer under yesterday's date, which is the one thing a record must not do.

The snapshots are the point, and not for convenience. A finding here is only ever a
candidate; the only thing that turns one into a result is showing up **again** in sits
recorded after it was found. That comparison is impossible if the earlier answer was never
written down — and recording the input set is what lets a stronger later result be told
apart from simply having more data.

**Raw EEG is deliberately not stored.** A 40-minute sit is ~2.4M float samples per
channel against ~2400 derived rows, so keeping it would multiply the stored size roughly
a thousandfold for data no current view reads, and fill a browser's quota after a handful
of sits — at which point storing *anything* fails, including the small things. The cost is
real: the planned recompute-from-raw work needs the archives dropped in again.

Storage is additive throughout. If it refuses (private mode, full quota) the lab still
works completely and **says** it is not saving — a page that silently is not saving looks
identical to one that is.

### The lab analyses marks, not just spans

A mark is a moment; the analysis needs a stretch of time. So **each tap contributes the
8 seconds ending 2 seconds before you pressed the key.** The window is *before* the mark
because you press "returned" after noticing you came back — if returning has a signature
it is in the run-up, not the aftermath.

The 2-second tail is dropped deliberately. Pressing a key moves a hand, an arm and
usually the jaw, and that muscle activity lands in the same frequencies the Thinking
score is built from — so the seconds touching the keypress would show "activity" for
every category alike, an artefact of the button rather than of the mind. It also
separates the state being reported from the act of reporting it.

Marked windows are compared against **random windows from the same sits**, kept clear of
every mark. Same session, so electrode fit, time of day and how the sit went cannot
masquerade as a difference between marked and unmarked time. Controls are also what make
a *single* tap category analysable at all: a one-class label has no variance, so without
a comparison class every correlation is null.

Each category becomes its own 1/0 question — "windows before a `returned` tap versus
everything else". Spearman on a binary variable is a rank-biserial correlation, so the
existing pipeline (permutation null, FDR, held-out sessions) applies unchanged rather
than needing a second, less careful one.

This exists because the taps arrived after the lab did: three sits loaded with plenty of
marks produced *"no labelled spans, nothing to correlate"* — a tooling dead end dressed
up as a null result.

### What counts as a pattern

The search used to ask one question: is the **mean** of this score higher when that label
is higher. That is a small fraction of how a state could show up in four electrodes and a
handful of composites. Each window now yields six kinds of feature:

| kind | question |
|---|---|
| `level` | how high the line sat |
| `trend` | whether it was rising or falling |
| `swing` | how much it moved about |
| `range` | how far it swung, top to bottom |
| `pair` | whether two lines moved **together or opposite** — the sign is the answer |
| `trio` | whether three lines moved as one |

Findings are still sentences: *"the Calm score was rising in the seconds before 'Returned
to the object', more than in windows you did not mark"*, or *"the Calm score and the Focus
score moved more opposite…"*. A key like `calm+focus.pair` reaching the prose would be a
bug, and `test-findings.js` fails if one does — a claim you cannot decode is a claim you
cannot judge, and one that cannot be judged gets believed.

**Breadth costs power, and that is the honest trade.** Every kind added multiplies the
comparison count, and multiplicity correction makes each test harder in proportion. A
search over 200 features needs a stronger effect to survive than one over 20. This buys
the *ability* to find these shapes; it does not buy evidence, and with a handful of sits
the answer will usually still be "nothing yet". Verified both ways: a signature planted
only in the shape — calm rising while focus falls, means held equal by construction — is
found by `trend` and `pair` and *not* by `level`, while three seeds of pure noise confirm
nothing at all.

### Voice notes are transcribed

Holding `V` or `space` records audio *and* runs the browser's speech recogniser, and the
transcript lands in `notes.csv`'s `transcript` column — which has been there, deliberately
empty, since the beginning as the seam for exactly this.

**The audio is still the record.** A transcript is a guess about what was said, and the
recogniser is unreliable on a whisper, on a Japanese term, or in a room with a fan —
"kenshō" is in nobody's language model. So the transcript is additive: if recognition is
unavailable, refused, or wrong, the note saves with its audio and an empty transcript
exactly as before, and it never blocks or delays the save. What it heard is shown in the
status line on release, so a bad transcript is visible immediately rather than discovered
in a spreadsheet weeks later.

### Saved sessions have names and mark counts

Every row takes a short name — saved on blur or Enter, one write per edit — and shows **how
many marks the sit contains**, calling out the ones with none in amber rather than showing a
quiet `0`.

The count is the load-bearing half. *"Some will be useless"* is exactly right: a sit with no
marks cannot contribute to any event-locked analysis, and a date plus a duration does not
say which those are. The whole-sit closing reflection deliberately does **not** count — it
describes the sit rather than a moment in it, and counting it would make a sit with no
usable epochs look usable. Names reach the export title too, so a folder of archives is
readable without opening them.

### Training mode

Turning Training on does two things: shows the tap-category panel and **starts
recording**. It no longer starts the probe schedule — see the note on interruptions above. The recording is the point — every label it collects
is worthless if nothing is saving them, and a whole sit was once tapped through with
nothing armed, producing marks that looked identical to saved ones.

Turning Training *off* deliberately does not stop the recording. Stopping is what
packages the sit and opens the summary, and having that happen as a side effect of tidying
the screen mid-sit would be worse than the problem it solves. The Record pill stays the
one thing that ends a recording.

The elapsed-time clock is gone. Its only other content was the "press M to mark" hint,
which now heads the tap panel alongside the mark tally, with the keys it describes. A
running clock is a thing to watch, which is the opposite of what a sit needs, and the
Record pill already shows elapsed time.

One race worth knowing about, found because Training now arms a recording by itself:
`ensureRecording` checked `recArmed` once and then awaited `Recorder.open()` and
`startSession()`. Stopping during those awaits — two keystrokes apart in practice — left
the guard already passed, so it published a session nothing would ever `end()`: the button
reads "Record" while a live session writes to IndexedDB for the rest of the page's life.
A generation counter now invalidates an in-flight open, and the in-flight attempt is held
as a promise rather than a boolean so a start immediately after a stop waits and retries
instead of being dropped.

### "Noisy" says how noisy

A channel reads **Noisy** when its 1-second window swings past 150µV peak-to-peak, and
that covers two situations with completely different fixes — so the amplitude is now
reported alongside:

- **150–600µV — "Noisy".** The electrode *is* on skin, picking up muscle, jaw,
  swallowing or movement. Fixable by sitting differently. A temporal channel parked just
  above 150µV all sit is also a question about whether the threshold is too tight there.
- **Above 600µV — "No contact".** A floating input rails toward the ends of its ±1000µV
  range (Muse is 12-bit at 0.488µV/LSB). This is not noise in any useful sense, and no
  amount of sitting still will fix it: wet the spot behind the ear and reseat the band.

The figure only shows on a channel that is faulty. Four numbers to ignore for a whole
sit is how a diagnostic becomes invisible.

### A dead electrode draws nothing

If a channel reads **Noisy**, its 1-second window swung more than `ARTIFACT_PTP_UV`
(150µV peak-to-peak). A behind-the-ear electrode with no skin contact floats and rails,
which produces exactly that — so `TP9`/`TP10` saying Noisy for a whole sit is almost
always a contact problem, not a code one. The band has to sit low enough that the ear
pieces touch bare skin behind the earlobe, and those two are the flakiest sensors on the
Muse by a distance.

What *was* a code problem: a channel with no valid reading used to be graphed at its
**previous value, or 50 if there had never been one**. So an electrode that never touched
the head was drawn as a perfectly flat line through the middle of the chart —
indistinguishable from a rock-steady, perfectly balanced channel, and the most
confident-looking line on the plot. It came from no data at all.

Missing readings are now `null`, and `Chart.segments` splits the line at them, so a dead
channel draws nothing and a dropout leaves a gap that keeps its place on the time axis.
The same rule applies to composites: no inputs means a gap, not a fabricated zero and not
a held-over previous value. Bridging a gap asserts values nobody measured, and on the
temporal channels the bridges were long.

### The summary offers both downloads

**Download report (.md)** is prose — what happened, for reading. **Download data (.zip)**
is the numbers: raw EEG per channel, per-second metrics, `notes.csv` with every tap,
probe answer and label, plus any voice notes. That is what the analysis lab and any
handoff to an AI actually need, and only the report was reachable from the summary before.

The data button appears only when a session was really recorded, so it can never imply an
unrecorded sit was captured — and it appears on the **"Nothing to summarise yet"** screen
too, which was the one dead end in the app. That message means too little live signal for
a sparkline; it does *not* mean nothing was saved. A sit whose headband dropped early
still has its raw chunks, notes and taps in the database, and that screen used to offer
only Close.

### Every visual says what it means

Each of the seven visuals draws its own key, top-left: a colour swatch per series where
the colours *are* series, and plain word-lines where they are not. Eclipse's expanding
void and Iris's outward growth are not colours, and no swatch can explain them.

Only Flow had a legend before, because the legend was drawn from inside `renderFlow`. It
is now drawn once for every mode after the render dispatch, so a new mode either has an
entry in `VizCore.LEGENDS` or gets no key — and `test-viz.js` fails if a *visible* mode
has none.

One near-miss worth recording, because it is the failure mode this whole area invites:
the first Iris legend keyed `TP9 / AF7 / AF8 / TP10`. It was written by reading
`renderIris` — but the `iris` mode dispatches to `renderIrisSediment`, which colours the
disc by **mind state** (warm = thinking, cool = calm, gold = focus, grey = poor signal)
and never touches a channel hue. The legend would have named four electrodes for a
picture that draws none, and it would have been believed — sending someone looking for a
per-sensor difference the picture never showed. A legend that is plausible but wrong is
worse than no legend. `test-viz.js` now checks every legend colour against the constants
the renderers actually index, which catches the palette half of that drift; the prose
half is still on whoever edits a renderer.

### Traces are scaled to their own range, not to an absolute level

Flow maps every series onto one vertical band. The expansion curve it used was written
on the assumption that *"every value here is adaptively normalised against the wearer's
own baseline, so a real session occupies roughly 0.35..0.75"* — true of the composite
scores, and **false of the per-channel series**, which is a raw `alpha/(alpha+beta)`
ratio (deliberately: a bounded ratio needs no normaliser to be meaningful).

So on a beta-dominant sit — eyes open, thinking, which is most of them — that ratio sits
near 0.2 on every electrode, every trace pinned to the floor of the band, and the whole
picture compressed into the bottom third of the space it had. Reported exactly that way.

Each series is now rescaled to its own recent 5th–95th percentile range. Percentiles
rather than min/max, because one artifact spike would otherwise set the top and flatten
everything else. And a **minimum span** is enforced: without it, a channel that genuinely
did not move gets its own noise stretched to fill the frame and reads as violent
activity — inventing a signal, which is worse than the squashing this fixes. A steady
line stays steady, and sits in the middle of the band.

The cost is that vertical position now shows *change*, not level, so the Flow key says
so. Two lines crossing is not two values becoming equal.

**And the range is held across frames, not recomputed each one.** Reported straight after
the rescaling shipped: *"the entire line seemed to sort of sink and raise a little bit
almost arbitrarily… it feels like the axes are unstable."* Exactly right — the same range
applies to the whole visible history, so recomputing it every frame moves every past
sample, and a history plot whose recorded past appears to move is worse than one with a
poor scale. Fast attack, slow release, borrowed from audio gain control: the range
**widens instantly** (never clip a real excursion) and **narrows at ~6%/s**, a ~17-second
time constant. `test-viz.js` measures the thing that was actually complained about — how
far a fixed recorded sample moves between frames while the data is steady but its
percentiles jitter — and holds it under 2% of the band.

### Which way is the in-breath

The strap's accelerometer **cannot know**, and `polar.js` says so outright: the strap can
be worn either way up, magnitude is blind to sign, so which direction is inhale is
*inferred* by correlating against RSA (heart rate rises on inhalation). A wrong inference
draws a perfectly good signal upside down — and nothing in the data looks wrong, which is
why it could be neither noticed nor corrected. Reported as exactly that question: *"is it
possible that the graph is inverted even if the data is good?"* Yes.

Two fixes:

- **You are the reference.** When the breath reading comes from the chest, the Breath row
  carries a small `in?` control. Press it **while breathing in** and the orientation is
  set from you, latched so the per-tick inference cannot overwrite it, and remembered —
  it describes how the strap is worn, which does not change between sits. It refuses if
  pressed near the turnaround, where the signal is close to zero and its sign is noise; a
  mistimed press would otherwise latch a coin flip and then be trusted. (The guard is a
  third of the typical excursion, set by measurement rather than taste: the band-pass and
  1s smoothing shift the phase ~70° on a 5s breath, so at the raw zero crossing the
  filtered value is still 0.57 of amplitude.)
- **Hysteresis on the inference.** `resolveSign` runs every tick against a weak, lagging,
  noisy reference. At the bare threshold the inferred sign could flip between ticks — a
  trace inverting every few seconds, which is worse than a consistently wrong one,
  because a consistent one can at least be read backwards. Establishing a sign now takes
  the ordinary threshold; overturning an established one takes clearly stronger evidence.

No control is offered for the RSA reading: its direction is known from physiology, so
there is nothing to flip and a button suggesting otherwise would invite breaking a
correct signal.

### Iris records the sit, not the viewing

Iris lays down one ring per interval, growing outward, so the finished disc is the whole
sit at a glance: middle is the start, rim is the end, warm is thinking and cool is calm.

Three things about it were wrong, and all three came from the deposit living inside the
renderer:

* **It only recorded while you were watching it.** Ten minutes on Eclipse and Iris had
  recorded nothing — the disc was a record of *watching*, not of sitting. Deposits now
  run from the frame loop, on the session clock, whatever mode is on screen.
* **A long sit wiped it.** 120 rings at 5s is a ten-minute disc, and the old code cleared
  the record layer and restarted from the middle when it filled. A forty-minute sit meant
  three silent erasures and a final disc showing the last ten minutes, presented as the
  sit. It now freezes at the rim instead — freezing loses the tail, wiping loses
  everything already earned. And when the session timer is set, `visual.setSessionLength`
  spaces the rings so the whole intended sit spans the full radius.
* **The white background.** Whenever signal quality dropped past a threshold, Iris filled
  a hard-edged `rgba(170,170,180)` circle over the entire disc. It meant "unreliable" and
  looked like a light grey plate appearing behind the picture. The frame loop already
  veils every mode by noise, which is where that message belongs — this was a second,
  louder, mode-specific copy of it.

### Panels move

Every floating panel — Metrics, Live feed, the visual picker, the armed-tap list, the
training clock — has a faint grip strip along its top edge. **Drag it anywhere;
double-click the grip to put it back.** Each position persists.

Fixed corners cannot suit every combination of panels that happens to be open, and there
are now enough panels that the combinations outnumber anything worth hand-tuning in CSS:
Live feed opened directly over its own "Live feed" pill, so it could be opened and then
not closed. Positions are clamped so at least 48px of a panel always stays on screen, and
re-clamped on resize — a panel dragged fully off, or a position saved on a laptop and
reloaded on a phone, would otherwise be unrecoverable without clearing browser storage.
The clamp arithmetic is unit-tested (`test-panels.js`), because getting it wrong does not
look like a bug, it looks like a panel that vanished.

One trap inside `Panels.place` worth knowing about before touching it: these panels
animate `transform` for their show/hide slide, so writing `transform: none` to take over
positioning does not apply it — it starts a 350ms animation *toward* it. The panel slides
diagonally away from the pointer on the first movement of a drag, and every measurement
taken in that window is off by the slide distance. The first write suppresses transitions
and forces a layout read; later writes only touch `left`/`top`, which nothing animates.

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

## Breath phase — the thing that was missing until now

Every earlier version had breathing **rate** only. RSA tells you the *frequency* of
the respiratory modulation in heart timing; it says nothing about where in the cycle
you are. So nothing could swell on the inhale and contract on the exhale, and
"Follow me" was running a synthetic sine at roughly the right rate — which drifts out
of step with the actual breath within a cycle or two.

The mechanism, now implemented: heart rate genuinely **accelerates on the inhale and
decelerates on the exhale**. So instantaneous heart rate, with its slow drift removed
and its amplitude normalised, *is* the breath waveform. Positive means inhaling. No
extra sensor needed — the chest strap's beat timing is clean enough.

Four things use it:

- **A centred bar in the metrics panel.** Midpoint is the turnaround; it fills upward
  on the in-breath and downward on the out-breath. Deliberately not a 0–100
  left-to-right fill, which would render an exhale as a low score. **Exactly one
  row**, carrying the rate and direction with it — a first version rendered breath as
  a composite bar, a rate row *and* a phase bar, three rows all labelled "Breath"
  saying different things.
- **A `breath` series in the live graph**, oscillating about the centre line.
- **"Follow me" genuinely follows** now, driven by measured phase rather than a
  generated rhythm.
- **A breath wave in Flow** about the vertical midpoint, drawn from the same history
  buffer as the traces — so it's the real recorded breath and you can see where the
  rhythm changed. Drawn *first* and kept dim: it's context, not a competing line. A
  first attempt drew it last at 30% amplitude and it swamped the sensor data
  completely, which a screenshot caught immediately.

**Two honest limits, both unavoidable, and one of them measured rather than guessed:**

1. **RSA lags the breath** — the heart responds to breathing, it doesn't predict it.
2. Detrending with a centred window makes the most recent sample the least reliable.

There is also a **third limit found in real use**: the first version normalised by RMS
and hard-clamped to ±1, so a weak or noisy signal spent long stretches pegged at the
rail — the bar sat at 100 and stopped moving, which reads as a confidently-detected
held inhale. It now saturates smoothly (`tanh`) and, more importantly, **refuses to
report at all below `RSA_MIN_BPM`** of respiratory swing in heart rate. Real RSA at
rest is several bpm; below that threshold there is no breath in the signal, only noise
being amplified. RSA also shrinks as heart rate rises, so a fast heart legitimately
yields no reading — and that now shows as *no reading* rather than a pegged bar.

`test-polar.js` cross-correlates the recovered waveform against a known synthetic
breath and reports the total lag: **1.0 second in a 5-second cycle**, correlation
0.43. Good enough to watch and follow loosely; **not** a metronome to breathe
against. The bar is labelled "est" and the metric carries this caveat in its registry
entry.

**If that lag proves too much,** the real fix is the strap's **accelerometer** via
Polar's PMD service: the H10 sits on your ribcage, so chest-wall movement is direct
breath measurement with no physiological lag at all. Bigger protocol job, and worth
doing only if the RSA estimate isn't good enough in practice.

**Not the Muse's gyroscope.** It does have one (and an accelerometer), and they are
reachable over BLE — but the head barely moves with breathing, and head-mounted
accelerometry mostly reports postural sway. It would be a lot of work for a weak
signal when the strap is already on your chest.

## Connecting devices: a persistent bar, not a one-shot screen

Both device buttons live in a bar that stays on screen for the whole session, and
either device can be connected at any time in either order. That is a fix, not a
preference — two bugs made the previous version unusable:

1. **`setStatus()` assigns `statusEl.innerHTML`, and the buttons were inside
   `statusEl`.** So the very first status message — `"choose your Muse in the
   browser picker…"` — deleted both buttons from the DOM. "Connect to Muse" became
   unpressable, and after connecting the headband the strap button was
   unreachable. The buttons now live in their own `#devices` container that
   `setStatus` never touches.
2. **Everything that clears the status sat behind `if (!result) return;`**, which
   requires Muse data. With only the strap connected, the "HRV needs about 20s of
   beats" message never cleared and the page looked frozen. The status expiry and
   the device bar now render unconditionally, before that early return.

Also fixed while in there: `connectBtn` was bound with `{ once: true }`, so a
*failed* connection could never be retried — one click and the button was dead
forever. Both buttons are now retryable, guarded by connecting/connected state
rather than by consuming the listener.

**A strap-only session is a legitimate state** and now renders properly: the strap
alone gives heart rate, HRV and a real breathing rate, none of which need EEG. The
readout says "Headband — not connected" rather than implying EEG data exists.

`test-ui.js` covers all of this in a real browser, and was verified non-vacuous by
re-injecting the original bug and watching it fail.

## The Polar H10 chest strap (optional second device)

**Yes, two Bluetooth devices at once works.** Web Bluetooth connects them
independently — each `requestDevice()` needs its own user gesture, which is why the
strap has its own **+ heart strap** button and can't be chained off the Muse
connection, and each gets its own GATT connection. They don't contend for anything.
The strap is optional in both directions: without one the EEG side is unchanged, and
a strap that drops out mid-session disturbs nothing.

It reads the **standard** Bluetooth Heart Rate Service (`0x180D`), not Polar's
proprietary PMD service. The standard characteristic already carries RR intervals —
the beat-to-beat timings, which is exactly and only what HRV is computed from — so
this is stable across firmware and works with any HR strap, not just this one.

What it adds (`public/polar.js`, tested in `test-polar.js`):

| | |
|---|---|
| **Heart rate** | direct, measured |
| **HRV (RMSSD)** | standard short-term HRV over a rolling 60s window |
| **`hrv` metric** | RMSSD normalised to your own baseline. Tier: **proxy** |
| **`equanimity`** | finally computes — from HRV *steadiness*, not level. Still **exploratory** |
| **Breath phase** | *where you are in the breath*, not just the rate — see below |
| **Breathing rate** | recovered from RSA and it **takes precedence over the Muse's PPG** — ECG-grade beat timing at the chest beats an optical pulse read through a temple. Verified at 4.92s for a true 5.00s |

**Steadiness, not level, feeds equanimity.** That's deliberate: a person can have
high HRV and still be reacting to everything. `SteadinessTracker` reports the
inverted coefficient of variation of RMSSD, which is *relative*, so someone with high
resting HRV isn't scored differently for the level.

**The artifact rejection is the load-bearing part.** A strap occasionally misses a
beat, producing one interval about twice as long as its neighbours. RMSSD squares
successive differences, so a single such interval contributes two enormous terms.
`test-polar.js` measures it: an unrejected missed beat took RMSSD from **30.0ms to
182.2ms** — a six-fold inflation that would appear as a sudden flood of
parasympathetic calm at the exact moment the strap slipped. Intervals outside
300–2000ms, or more than 25% away from the previous one, are discarded, and the
reject rate is reported. Above 30% rejected (or on lost skin contact) the readout
says so and the report prints a banner instead of presenting the figures as
physiology.

**Honest limit on what HRV means:** RMSSD is a real measurement and the strap is
ECG-grade, so the *number* is solid — that's why HR and RMSSD carry the green
"measured" light. What it *means* is the proxy part. Higher RMSSD indicates
parasympathetic (rest) activation, which correlates with calm, but **it also rises
with slow breathing regardless of mental state** — so you can move it deliberately
without settling at all. That caveat travels with the numbers in the report.

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
                     # breath patterns (holds actually hold), expand() range,
                     # and Pulse's clock ring — wrap-around at twelve, filling
                     # every bin the hand crossed (not just the one it landed
                     # on), bulges fading over exactly one revolution, and
                     # deviation flaring on change in EITHER direction
node test-visual-smoke.js
                    # runs every visual mode for 60 frames against a stubbed
                    # canvas with adversarial state; fails on any thrown error,
                    # NaN/Infinity/negative geometry reaching a draw call, or
                    # more than 2.2 blurred draw ops per frame. Plus a long
                    # Iris run (~20 simulated seconds), because its every-6s
                    # deposit path never fired in a 1-second test at all
node test-ui.js       # loads direct.html in real Chromium and asserts DOM
                     # LIFECYCLE: that the device buttons survive a status
                     # message, that a transient message expires with no device
                     # connected, that the device bar re-renders off its own
                     # timer rather than off EEG data, and that a strap-only
                     # session renders. Added because a bug reached the user
                     # that no amount of unit-testing the signal maths could
                     # have caught — see below
node test-polar.js   # Polar H10: the variable-length Heart Rate Measurement
                     # packet (flag-driven offsets, the energy-expended field
                     # that must be SKIPPED, truncated buffers), RMSSD against
                     # hand-computed values, missed-beat rejection measured
                     # against what it prevents, time-bounded windowing, and
                     # breathing recovered from RR intervals via RSA
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
  all. **Eclipse**, **Pulse**, **Flow** and **Field** react continuously, and **Iris**
  accumulates slowly by design.
- **Pulse's rings sit almost flat** → the bulge is mostly *change* against each metric's
  own slow baseline, so a genuinely steady mind produces a genuinely quiet dial. Rings
  for metrics the page can't compute (anything reading "—") never move at all.
- **A line in Flow looks dead** → check the **Sensors/Composites** switch first. Flow
  graphs whichever series the panel is showing; TP9's hue is deliberately the same as
  Focus's, so an electrode in Sensors view can easily be mistaken for a flat composite.
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
