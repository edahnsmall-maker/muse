# Muse Zen Spike

A weekend "aha" prototype: wear your **Muse S (Gen 2)**, and a full-screen field on
your laptop **warms and slows as you calm down** (rising alpha relative to beta).
This is Phase 0 — proving the biofeedback loop end to end before we build the real app.

```
Muse S Gen 2  ──BLE──▶  phone (Mind Monitor app)  ──OSC/WiFi──▶  laptop (this server)  ──▶  browser visuals
```

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

## Try it without a Muse first

In a second terminal (server still running):
```bash
node sim.js
```
This streams a fake "calming" session so you can see the visuals move. Ctrl+C to stop.

## How the "calm" value works (and how to tune it)

- Muse computes band powers on-device; Mind Monitor forwards them over OSC.
- We take **alpha − beta** (log-power difference ≈ `log(alpha/beta)`): more alpha /
  less beta ⇒ calmer, more relaxed-alert. This is the thematically-Zen signal —
  rising anterior alpha is the classic zazen finding.
- Because everyone's baseline differs, we **auto-normalize** against a slow running
  mean/variance and squash to a 0–1 `calm` value, then smooth it heavily so the
  visuals glide instead of jitter.
- Contact quality (`horseshoe`) and `touching_forehead` gate the display so a loose
  headband doesn't produce garbage.

Knobs, all in `server.js`:
- `aStat` (0.001) — how fast it adapts to your baseline. Lower = steadier.
- the logistic slope `0.9` — higher = more dramatic swings.
- display smoothing `0.05` — lower = calmer/slower visual response.
- To use **theta** (absorption/focus) instead of/alongside alpha, add `S.abs.theta`
  into the `ratio`. To use Muse's **relative** bands, they're already captured in `S.rel`.

Visual mapping lives in the fragment shader in `public/index.html` (`u_calm` drives
speed, color warmth, contrast, and a breathing luminance pulse that slows as you settle).

## Test

```bash
node test.js   # verifies OSC parsing + the calm math without any hardware
```

## Troubleshooting

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

## What's next (Phase 1+)

- Add a **second mode**: an explicit concentration meter (frontal theta) for
  focused-attention sits vs. this ambient, non-scoring "just sitting" field.
- A **post-session report** (your calm trace over time).
- Move from laptop+Mind Monitor to a real **phone app** (React Native / Flutter +
  BrainFlow) so each person at the center runs it on their own phone.
