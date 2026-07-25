# Roadmap

A meditation biofeedback system: live physiological/EEG data drives reactive
visuals, timely guidance, and honest reports — built to help people get past
the things that make them quit (not knowing what to do, not knowing if
they're "doing it right," frustration with their own thoughts) rather than
to gamify or score the practice itself.

Started from a Zen background (shikantaza / open awareness / no-mind as the
ideal), designed to also serve other styles (focused attention, loving-
kindness) which likely have different physiological signatures.

## The core design commitment

**The product's job is to remove the uncertainty that makes beginners quit —
not to grade their meditation.** Concretely, that means:

- **Reward the return, not the stillness.** Noticing you drifted and coming
  back *is* the rep — like a bicep curl for attention. Detect scatter→recover
  and honor that moment specifically, instead of only rewarding calm.
- **Predict, then reveal.** After a sit, ask "how settled did you feel?"
  *before* showing any data. The number calibrates their own felt sense
  (interoception) instead of replacing it — the point is to eventually need
  the device less, not more.
- **Compare only to your own past, never to others or to an ideal.**
  "Last month, 8 minutes to settle. Today, 3." Undeniable, personal,
  non-competitive proof of movement — the "progress bar" instinct, pointed
  the right way.
- **Show the shape of a sit, not a grade.** A stormy sit and a still-lake sit
  are both normal; seeing the variety normalizes it instead of making every
  sit feel like it should look the same.
- **Two feedback modes, matched to practice style:**
  - *Scoreboard mode* (focused attention / concentration): an explicit
    meter is appropriate — these practices are effortful and goal-directed.
  - *Mirror mode* (shikantaza / open awareness): ambient, non-scoring. The
    room / screen breathes with you; there is nothing to chase. Resolves the
    paradox of putting a number on goallessness.
- **Feedback fades as skill grows.** Beginners get more visible signal;
  as someone matures the app gives less, dimmer, quieter — eventually just
  presence, no numbers — until they graduate off it. Success = needing it
  less. (The raft left at the shore.)
- **Guidance meets the moment, including staying silent.** Cue when
  scattered, go quiet when settled — the opposite of a generic recording
  that talks the whole time.
- **Collective, not competitive, in groups.** No individual scores shown in
  a shared room. Instead: the *room* is the unit — a collective field that
  deepens as the group settles together (a real, honest metaphor: fireflies
  or coupled heart cells synchronizing with no conductor).
- **Data always points back to felt experience, never replaces it.** The
  failure mode of every meditation app is making people better at the app
  instead of at meditating.

## Phase 0 — done: the spike

**Goal:** prove the loop end to end before building anything real.

Two independent paths to the same visual, added because real-world access to a
laptop varies a lot (locked-down/managed machines, Chromebooks with no Node.js):

- **Path A — Mind Monitor.** Muse S Gen 2 → Mind Monitor app (OSC/WiFi) → local
  Node server → browser. Requires Node.js and a firewall exception for the local
  server to receive LAN traffic (can be a hard blocker on managed/school/work
  machines without admin rights).
- **Path B — direct Bluetooth.** Muse S Gen 2 → browser directly, via the Web
  Bluetooth API (Chrome/Edge on Windows/Mac/Linux/**ChromeOS**/Android). No phone,
  no app, no local server, no admin permission of any kind — the page does its
  own DSP (FFT, band powers) client-side in `public/dsp.js` since there's no
  Mind Monitor to precompute band powers for it. Needs the page served over
  `https://` (or `http://localhost`) — GitHub Pages works well for this and is
  free once the repo is public.

Both computes a smoothed 0–1 "calm" score from alpha/beta band power, adaptively
normalized to the wearer's own baseline (individual variability is too large for
absolute thresholds), and drive the same full-screen WebGL field (`public/visual.js`)
that warms, slows, and softens as calm rises — first working instance of "mirror mode."

- `sim.js` fakes a calming session so Path A's loop can be seen without hardware.
- Verified (Path A): OSC message + bundle parsing, calm-score math (climbs across
  a simulated session), contact-quality gating, server boot, page serving.
- Verified (Path B): FFT checked against a brute-force DFT, band-power isolation
  on synthetic tones (a 10Hz test tone lands correctly in alpha, 20Hz in beta),
  12-bit sample decode round-trip, microvolt scaling, calm-score math. The actual
  Bluetooth GATT wiring (pairing, characteristic subscriptions, command sequence)
  follows the documented Muse protocol exactly but is inherently untestable
  without real hardware — first real-headset run is the remaining check.
- Known gap in Path B: no equivalent of Muse's own contact-quality signal (not
  exposed over raw BLE) — headband fit has to be judged by feel, not by the app.

Files: `server.js`, `public/index.html` (Path A), `public/direct.html` (Path B),
`public/dsp.js` (shared DSP core, environment-agnostic), `public/visual.js`
(shared visual, used by both pages), `sim.js`, `test.js`, `test-dsp.js`,
`README.md` (setup + troubleshooting for both paths).

## Phase 1 — next: the two mechanics that answer "I might be failing"

**Goal:** make the prototype's core message, from minute one, "thoughts are
okay, coming back is the point" — and give people undeniable proof they're
moving.

- [ ] **Scatter→recover detection.** Identify the down-then-up pattern in the
      calm signal (attention broke, then returned) and mark/count it — this
      is the "rep counter" for coming back, not for staying still.
- [ ] **End-of-session reflection: predict, then reveal.** Ask "how settled
      did that feel, 1–5?" before showing the trace. Store both.
- [ ] **Self-relative progress.** Track settling time (how long to first
      real dip toward calm) and session-to-session trend, compared only to
      the person's own history.
- [ ] **Session shape report.** A simple visual trace of the sit (not a
      grade) — a little landscape/weather-line — with plain-language
      framing ("a choppy sit is a normal sit").
- [ ] **Scoreboard mode v1**: an explicit concentration meter (frontal theta)
      for focused-attention sits, alongside the existing ambient mirror mode
      for open awareness.

## Phase 2 — the real phone app

**Goal:** each person at the center runs this on their own phone, no laptop
+ Mind Monitor relay needed.

- [ ] Cross-platform app (React Native or Flutter) with direct BLE via
      **BrainFlow** (drop Mind Monitor once this works — it was a Phase 0
      shortcut).
- [ ] In-the-moment guidance: short, state-triggered cues ("you don't have
      to control your thinking — just keep returning to the breath"),
      silent when already settled.
- [ ] Breath-paced audio/haptic: tone or pulse on inhale/exhale, with tone
      quality itself reflecting physiological state (not just timing).
- [ ] On-device only — no backend yet. Session storage + reports live on
      the phone.

## Phase 3 — the tech day / center

**Goal:** a room of people, each wearing a device, one shared experience.

- [ ] Multi-track sessions running concurrently, like a studio schedule
      (guided / open awareness / silent sit at different times or rooms).
- [ ] **Collective room mode:** no individual scores shown; the room's
      lights/screens shift together as the *group* settles (sync metaphor:
      fireflies / coupled oscillators, not a leaderboard).
- [ ] Practice-matching: quietly surface which session style has tended to
      settle a given person fastest, across their own history.
- [ ] Facilitator view (opt-in, for the teacher only): who might need a
      hand, without turning it into monitoring/surveillance of participants.

## Phase 4 — beyond the center: daily life

**Goal:** the mindfulness tool follows someone into their day.

- [ ] **Hardware fork, faced honestly:** Muse-class EEG is a formal-sit
      instrument, not an all-day wearable. Daily-life tracking needs a
      different, less precise but truly wearable sensor — ring/watch-class
      HRV (Oura, Apple Watch, Whoop) — or new hardware suited to all-day
      wear. Two device generations for two use cases, not one device
      doing both.
- [ ] Early, gentle nudges before dysregulation, delivered as an invitation
      ("a friend touching your arm"), never as an alarm — false positives
      are inevitable and must not erode trust.
- [ ] End-of-day report as a short narrative, not a dashboard: pattern in
      plain language ("your settling time dropped this week, but Wednesday
      was rough, and it followed a short night's sleep").
- [ ] Personalization layer: learn what actually helps a given person (a
      walk, a specific practice style, a time of day) — and what doesn't —
      from their own data, not population averages.

## North star — further out, designed toward now

Not fantasy — genuinely intended, just further out, and worth keeping in
view so today's architecture doesn't foreclose it:

- **AR clarity-vision:** the visual world itself reflects mental clutter —
  static/fog/noise that thins as the mind settles, rather than a literal
  color filter. This isn't a gimmick; it stages a real contemplative claim
  (a busy, grasping mind makes the world *look* more cluttered — closer to
  papañca/proliferation than a UI trick) — and should be treated with that
  seriousness when eventually built.
- **All-day forecasting AI**, not just reactive nudging: learn a person's
  own patterns well enough to offer a short practice *before* a predictable
  rough patch (e.g. a known 3pm dip), instead of waiting for a crisis.
- **Full personalization engine**: an ongoing model of "what settles this
  particular nervous system," feeding session-style recommendations,
  timing, and reports.

## Devices

| Use | Device | Status |
|---|---|---|
| Formal EEG sits (now) | Muse S Gen 2 (owned) | In use — via Mind Monitor (Phase 0), moving to BrainFlow direct BLE (Phase 2). Same 4-channel layout as Muse 2 (AF7/AF8 frontal, TP9/TP10 temporal, 256Hz) plus PPG/HR, accelerometer, and a breath sensor — a superset, fully compatible with this pipeline. |
| Formal EEG sits (future option) | Neurosity Crown | Not yet needed |
| HRV, cheap + very reliable | Polar H10 (~$90) | Not yet purchased — strong option to add for group events (Phase 3), more robust than EEG in a crowded room |
| All-day tracking (Phase 4) | Apple Watch / Oura / Whoop-class wrist HRV | Correlations to be established later — different precision tradeoff than EEG, chosen for wearability |

## Signals — what's defensible to claim

- **Concentration:** frontal-midline theta rises with sustained focused
  attention — well-replicated, buildable from Muse's frontal channels.
- **Equanimity:** best measured from HRV (RMSSD / HF power rising = calm,
  parasympathetic activation) rather than EEG gamma, which is contaminated
  by muscle artifact on consumer frontal electrodes.
- **Shikantaza / open awareness:** classic finding (Kasamatsu & Hirai, 1966,
  replicated since) — alpha appears within ~50s, grows, spreads from
  occipital to frontal, slows from ~11Hz toward ~8Hz; in very experienced
  practitioners, persists with eyes open. Treat as *descriptive and
  renderable*, not as a score to optimize.
- **Universal caveat:** all of this is within-person and session-relative.
  Never compare one person's number to another's. Consumer EEG cannot do
  source localization or clinical-grade claims — band powers and their
  trends are the honest ceiling.

## Non-negotiables (revisit before every feature)

1. Would this make someone better at meditating, or just better at the app?
2. Does this compare a person to anyone but their own past?
3. If this is for shikantaza/open awareness, does it score, or does it mirror?
4. Does the scaffolding get quieter as the person improves, or louder?
