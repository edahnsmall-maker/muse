# Muse Zen Spike

A weekend "aha" prototype: wear your **Muse S (Gen 2)**, and a full-screen field on
your screen **warms and slows as you calm down** (rising alpha relative to beta).
This is Phase 0 — proving the biofeedback loop end to end before we build the real app.

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

## The readout (Path B) — one interface, plain English, two tiers

There is a single overlay (bottom-right), always visible once connected. No hidden
technical mode, no separate debug view — just this. It's deliberately understated:
small translucent text, no card/pill chrome.

Two tiers, both visible at once:
- **Sensors** — the 4 raw electrodes individually (`TP9`/`AF7`/`AF8`/`TP10`), each
  showing whichever band currently dominates at that specific electrode (`Alpha` /
  `Beta`), or `Noisy` if that channel's own signal is artifact-flagged right now.
  TP9/TP10 sit near the jaw/ear and will say `Noisy` more often than the frontal
  pair — that's expected, not a bug.
- **Composite** — the rolled-up metrics actually built from those sensors: `Calm`
  (0–100, from the frontal pair, adaptively normalized), `Brainwaves` (the frontal
  pair's dominant band, in plain language), `Breath` (breaths/min once ~40s of PPG
  data exists, otherwise "Reading…" — deliberately not a live-ticking counter, since
  a number that just climbs while you wait isn't meaningful information), `Noise`
  (Low/Some/High, from the artifact rate), and `Timer` if one's running.

## The visuals — four modes, press `V` to cycle

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

The four modes:

| Mode | What it is | What drives it |
|---|---|---|
| **Flow** | Chronological watercolour. Your history scrolls right→left, one coloured ribbon per electrode, paint accumulating and softly bleeding. | Ribbon height = that electrode's alpha share. Spikes = bright bursts. Data-correspondence is literal: the picture *is* the history. |
| **Bloom** | No lines at all. Soft colour gradients emerge, expand, and fade — but only when something significant actually happens. | A per-channel spike (bloom in that channel's colour), or a calm-zone transition: settling (warm) / stirring (cool). |
| **Field** | One soft wavy band of colour per sensor — the "reference image" look, now with real per-channel hue. | Band brightness/thickness = that electrode's alpha share; blur and width grow with calm ("dissolving"). |
| **Breath** | Austere. One slow gradient breathing in and out. Nothing per-channel, nothing to read or chase. | Your *measured* breathing rate (or a calm-linked estimate before one exists). This is the "mirror mode" of the roadmap's Zen framing. |

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

Knobs, in `public/visual.js` / `public/viz-core.js`:
- `CHANNEL_COLORS` — the per-electrode hues.
- `MODES` — order of the cycle; add one here and it's automatically reachable.
- `EventDetector({hi, lo})` — how far calm must move to count as settling/stirring.
- `BloomField({max, life})` — how many blooms coexist and how long each lasts.
- `BUF_MAX_W` — render-buffer width; smaller is softer and faster.
- `SPIKE_THRESHOLD` / `SPIKE_DECAY` via `DSP.SpikeDetector` in `direct.html`.

Knobs shared with the calm score itself:
- `server.js` (Path A) / `DSP.AdaptiveNormalizer` in `public/dsp.js` (Path B) —
  `adapt` (how fast it learns your baseline, lower = steadier), the logistic
  `slope` (higher = more dramatic swings), `smoothing` (lower = slower response).

## Data visualization (Path B)

A collapsible panel (bottom-left, "▾ Data") graphs everything over time: Calm,
Noise, and each of the 4 electrodes' alpha-share individually — ~3 minutes of
history at 1 sample/sec, all on a shared 0–100 scale. Click a legend item to
toggle that series on/off; click "Data" to hide the whole panel. The data/scaling
math (`public/chart.js`) is unit-tested independent of the canvas drawing itself
(`test-chart.js`) — ring-buffer capping and the right-aligned "scrolls in from
empty" coordinate mapping are both verified before ever touching a canvas.

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
                     # event hysteresis, bloom lifecycle, bounded wobble
node test-visual-smoke.js
                    # runs every visual mode for 60 frames against a stubbed
                    # canvas with adversarial state; fails on any thrown error
                    # or NaN/Infinity/negative geometry reaching a draw call
```

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
  (the readout's `Visual` line; press `V` to cycle). **Bloom** is *meant* to be
  mostly still — it only shows something when a genuinely significant event occurs,
  which can be a while apart. **Breath** is deliberately austere and has no
  per-channel response at all. **Flow** and **Field** react continuously.

## What's next (Phase 1+)

- Add a **second mode**: an explicit concentration meter (frontal theta) for
  focused-attention sits vs. this ambient, non-scoring "just sitting" field.
- A **post-session report** (your calm trace over time).
- Move from laptop+Mind Monitor to a real **phone app** (React Native / Flutter +
  BrainFlow) so each person at the center runs it on their own phone.
