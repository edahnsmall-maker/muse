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

Knobs:
- `server.js` (Path A) / `DSP.CalmTracker` in `public/dsp.js` (Path B) — `adapt`/`aStat`
  (how fast it learns your baseline, lower = steadier), the logistic `slope` (higher =
  more dramatic swings), `smoothing` (lower = slower visual response).
- To use **theta** (absorption/focus) instead of/alongside alpha: Path A already
  receives `S.abs.theta` from Mind Monitor; Path B gets it free from `DSP.bandPowers()`.

Visual mapping is shared by both pages in `public/visual.js` (`u_calm` drives speed,
color warmth, contrast, and a breathing luminance pulse that slows as you settle).

## Test

```bash
node test.js       # Path A: OSC parsing + the calm math, no hardware needed
node test-dsp.js   # Path B: FFT (checked against brute-force DFT), band-power
                    # isolation on synthetic tones, 12-bit decode, calm math
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

## What's next (Phase 1+)

- Add a **second mode**: an explicit concentration meter (frontal theta) for
  focused-attention sits vs. this ambient, non-scoring "just sitting" field.
- A **post-session report** (your calm trace over time).
- Move from laptop+Mind Monitor to a real **phone app** (React Native / Flutter +
  BrainFlow) so each person at the center runs it on their own phone.
