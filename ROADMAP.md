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
- **Never present a guess as a measurement.** Added after building the
  composite scores and asking the obvious question: are they actually valid?
  They are not — they're literature-informed but hand-tuned and unvalidated.
  So every metric carries an explicit evidence tier (measured / proxy /
  exploratory) and a caveat, in code (`public/metrics.js`) and visibly in the
  UI; a metric with no data reads as "no data", never as zero; and no
  speculative score is ever a default. Writing more code cannot make a metric
  valid — only labelled ground truth can, which is what markers exist to
  collect. This is a non-negotiable, not a nice-to-have: a room full of people
  at a zen center trusting a number that means nothing would be worse than
  giving them no number at all.

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
  12-bit sample decode round-trip, microvolt scaling, calm-score math.

**First real-headset connection (live-tested, same day):** connected on the first
try. Live testing surfaced three real bugs, each caught and fixed with the same
test-first discipline as the rest of the DSP core:
- Frontal-channel EEG picked up eye/jaw/talking artifact far more strongly than
  real brainwave activity (confirmed live: talking visibly dominated the signal).
  Fixed with a peak-to-peak amplitude check (`isArtifact`) that discards
  noise-flagged windows instead of feeding them into the calm score.
  Consequence for the roadmap: **the "known gap" above is now handled for the
  noise case** (loose/bad contact still isn't detected, but gross artifact is).
- The visual developed a blocky, tiled look after running a while — traced to
  the noise `hash()` function losing precision on large intermediate values on
  this GPU, not to elapsed time as first suspected (bounding time didn't fix it;
  rewriting the hash to stay near [0,1) at every step did). A reminder that a
  live, physical test environment finds bugs a synthetic test suite can't.
- High-calm states weren't settling toward real stillness, just "slower."

**Real breathing, from the Muse's PPG (heart) sensor — built ahead of the Phase 2
placeholder below, once the spike was already in the user's hands and requested
live:** `detectBeats` + `estimateBreathingPeriod` recover actual breathing rate
from heart-rate variability (respiratory sinus arrhythmia — heart rate speeds up
on the inhale, slows on the exhale) — no separate breath sensor needed. Verified
on a synthetic PPG signal with a known, embedded breathing rate before touching
real hardware: recovered a true 5.00s period as 4.92s. A real bug was caught this
way too — an FFT sample-rate mismatch that would have silently skewed every
estimate — exactly why the synthetic-signal test existed. Needs ~40s of steady
heartbeat data before it trusts an estimate; the visual runs on the calm-linked
guess until then and hands off smoothly once real data is available. PPG failure
degrades gracefully to EEG-only rather than breaking the core experience.

Files: `server.js`, `public/index.html` (Path A), `public/direct.html` (Path B),
`public/dsp.js` (shared DSP core, environment-agnostic), `public/visual.js` +
`public/viz-core.js` (the renderer and its testable pure core), `public/chart.js`,
`public/metrics.js`, `public/markers.js`, `public/cues.js`, `public/summary.js`,
`sim.js`, nine test suites, `README.md` (setup + troubleshooting for both paths).

## Phase 1 — mostly built: the mechanics that answer "I might be failing"

**Goal:** make the prototype's core message, from minute one, "thoughts are
okay, coming back is the point" — and give people undeniable proof they're
moving.

- [~] **Scatter→recover detection.** Partly there: return-counting feeds the
      cue engine (`recentReturns` → the "you keep coming back" cue, the one
      that names returning as the practice). **Not yet surfaced as a visible
      rep counter in the report**, which is where it earns its keep.
- [x] **End-of-session reflection: predict, then reveal.** The summary asks
      "how settled did that feel, 1–5?" *before* showing any numbers, and the
      report records the felt rating alongside the data.
- [ ] **Self-relative progress.** Blocked on storage — nothing persists
      between sessions yet, so "last month 8 minutes to settle, today 3"
      isn't computable. This is the single highest-value missing piece for
      the core promise, and the cheapest: it's local storage, not new signal
      processing.
- [x] **Session shape report.** A downloadable markdown report with the trace
      as a sparkline, deliberately non-evaluative phrasing (`summary.describe`
      never grades), the cue log, and per-marker before/after tables.
- [x] **Scoreboard mode v1**: `Focus` (frontal theta steadiness) is selectable
      as a composite, and the visual retunes to whichever composite is
      selected — so scoreboard and mirror are the same screen pointed at
      different scores, rather than two separate apps. Honest caveat carried
      in the UI: true Fz sits *between* our two sensors, so this is a proxy
      of a proxy, and theta also rises with drowsiness.

**Also built in this phase, unplanned, because live use asked for it:**

- [x] **Six visual modes** (Eclipse, Iris, Flow, Bloom, Field, Breath), each
      driven by real per-channel data with anatomically-placed sensors, plus
      four guided breathing patterns. Not scope creep: "which visual actually
      helps someone settle" is an open question that can only be answered by
      having several to compare, which is why the instruction was to *add*
      modes rather than replace them.
- [x] **In-the-moment cues** — Phase 2's guidance item, pulled forward. Rate
      limited to one per five minutes, silent for the first minute, never
      repeating, never scolding.
- [x] **Markers + training mode** — the labelled-ground-truth capture that
      validation depends on. Notes are taken at the moment, not deferred,
      because holding a list of things to remember damages a sit more than
      briefly typing does.
- [x] **The honesty layer** — evidence tiers, null-not-zero, and visible
      caveats on every score (see the new non-negotiable above).

- [x] **Polar H10 integrated.** Two Bluetooth devices at once works — Web
      Bluetooth connects them independently, one user gesture per
      `requestDevice()`. Reads the standard Heart Rate Service rather than
      Polar's proprietary PMD, so it is firmware-stable and strap-agnostic.
      `Equanimity` finally computes, from HRV *steadiness* rather than level,
      and breathing now comes from ECG-grade RSA in preference to temple PPG.

**Next up, concretely:** session storage (unblocks self-relative progress),
scatter→recover in the report, and the calibration trials below.

## Where the lab is weak, and whether this is possible at all (2026-07-29)

Written in answer to a direct question: *"do you think we've really covered
everything... the patterns might be really subtle and might just have a lot of noise
around them... do we need more processing power or do we need more sensors or more
accuracy?"*

The four signature kinds asked for (together, opposite, three-way, one line on its own)
are built. They were examples, and the honest answer is no — the coverage is not
complete, and two of the gaps are more serious than the missing feature kinds.

### The short answer to "do we need more X"

- **Processing power: no.** This is 1 Hz data and a few hundred windows. Even
  recomputing 256 Hz band powers for a 40-minute sit is a few million floating-point
  operations — trivial in a browser tab. Compute has never been the constraint and is
  not close to being one.
- **More sensors: eventually, not yet.** Four dry electrodes limit *spatial* questions
  badly (there is no left/right asymmetry worth the name from AF7/AF8 alone), and TP9
  and TP10 are frequently unusable — both read "Noisy" in the screenshot that prompted
  the dead-line investigation. Fixing the *fit* of the four we have is worth more today
  than adding more.
- **The binding constraint is labelled moments.** Everything else is downstream of it.
  See the arithmetic below: at ~50 marks nothing subtle can be detected by any method,
  on any hardware, with any amount of compute. This is a practice-and-logging problem,
  not a technology problem, which is genuinely good news — it is fixable by sitting.

### The arithmetic, measured rather than argued

Detection rate for a planted effect, over repeated runs of the real pipeline
(`tools/power.js`; "effect" is the separation between marked and control windows in
standard deviations):

| observations | search size | effect 0.3 | 0.5 | 0.8 |
|---|---|---|---|---|
| 96 (6 sits × 8 marks) | 20 features | 0.50 | 0.75 | 1.00 |
| 96 | 100 features | 0.00 | 0.50 | 1.00 |
| 192 (12 sits) | 100 features | 0.63 | 1.00 | 1.00 |
| 480 (30 sits) | 100 features | 1.00 | 1.00 | 1.00 |

`Analysis.detectableRho(n, comparisons)` reports the same thing as a threshold, and it
now travels with every null result: **at 96 observations and 400 comparisons, nothing
below a correlation of about 0.37 can be reported at all.** Most real psychophysiological
effects are smaller than that. So the current honest reading of a null result from three
sits is "this rules out strong effects", not "there is nothing there" — and that sentence
is now in the verdict rather than left to be inferred.

Rough targets, if a subtle effect (ρ ≈ 0.2) is the goal: **several hundred marked
windows, from thirty or more sits.** At 8 marks a sit that is about a month of daily
practice with training mode on. Nothing about the tooling shortens that.

### A bug this question uncovered

Widening the feature set silently broke the lab's ability to confirm anything.

A permutation *p* cannot go below `1/(iterations+1)`. Benjamini–Hochberg needs the
strongest hit at `p ≤ q/m`. At 1500 shuffles and q = 0.1 that caps the search at ~150
comparisons — beyond it **nothing can ever be confirmed, however large the effect.**
Measured: a 0.87 correlation over 300 observations went undetected in a 100-feature
search at every sample size tried, because its *p* physically could not be smaller than
the threshold it had to beat. The lab reported "no pattern survived", which reads as a
fact about meditation and was a fact about arithmetic.

Fixed by screening with an analytic Spearman *p* (no floor) and using permutation for
what it is uniquely good at — checking the analytic assumption on the few candidates
that survive, with enough shuffles that its floor sits an order of magnitude below the
threshold. Agreement between the two was measured at within ~20% on this shape of data
(binary labels, heavy ties). `test-analysis.js` now fails if a 2-SD effect cannot survive
a 200-comparison search.

This is the failure mode to watch for in this whole area: **not a wrong answer, a
plausible null.** Every widening of the search needs its power re-measured, or the tool
quietly turns into one that always says no.

### Known weaknesses, roughly in order of how much they cost

1. **The four electrodes are not in the lab's feature set at all.** `metrics.csv` writes
   per-channel levels as one space-joined text column (`"0.1 0.2 0.3 0.4"`), so
   `seriesKeys` correctly refuses it as non-numeric — and the most natural reading of
   "how two things move together" (two electrodes) cannot even be *asked*. Small fix:
   emit `tp9,af7,af8,tp10` as four columns. Highest value per line of code in the whole
   list.
2. **The lab audits the app's scores; it cannot discover better ones.** Archives contain
   raw EEG at 256 Hz (`eeg-ch*.f32`), but the lab reads only the 1 Hz derived rows. So
   every "signature" is a shape in an unvalidated hand-tuned summary. If the real marker
   of returning is 8–12 Hz power at one electrode with a 300 ms latency, no amount of
   correlating `calm.trend` will find it. Recomputing band powers from raw in the lab is
   the difference between auditing and discovering.
3. **No per-session normalisation.** Features are pooled raw across sits, but electrode
   fit changes day to day, so `calm.level` in one sit is not comparable to another.
   Between-session variance is currently competing with the within-session effect and
   will usually win. Z-scoring within session before pooling is a few lines and probably
   the largest power gain available without more data.
4. **The movement confound is only half handled.** Dropping the 2 s before a keypress
   removes the press itself, but marks are *self-selected* moments — you press when
   something notable happens, and notable moments plausibly involve posture shifts. The
   controls are random windows, so "moved at all" differs systematically between the two
   classes. `noise` is in the feature set so the confound is visible, but nothing yet
   *tests* whether a finding survives with noise partialled out, or uses noise-matched
   controls. A real, replicable, and completely meaningless finding is reachable here.
5. **The permutation null ignores session structure.** Labels are shuffled across all
   training rows, which assumes exchangeability; windows within one sit share drift and
   electrode state. Shuffling *within* session, or circularly shifting mark times within
   a sit, is a stricter and more appropriate null.
6. **The features are heavily redundant.** `level`, `range` and `swing` overlap; so do
   pair and trio terms built from the same lines. BH treats 400 comparisons as 400
   independent questions when the effective number is far smaller, which spends power for
   nothing. Clustering correlated features, or correcting on the effective number, would
   buy back some of the cost of breadth.
7. **No effect-size intervals.** Only ρ and *p*. At n = 96 a reported ρ of 0.4 has a
   confidence interval roughly ±0.2 wide, and showing that interval is the most direct
   way to make "this is a candidate, not a result" land.
8. **Self-caught marks have unknown latency.** You press some seconds after the thing
   you are reporting, and the delay varies. Every window is therefore smeared by an
   unknown amount, which attenuates any real effect. Probes bound the interval and
   self-caught taps do not — one more reason the two are analysed separately, and a
   reason to keep collecting both.

### What to build next, in order

1. Per-channel columns in `metrics.csv` (weakness 1) — unblocks the electrode questions.
2. Per-session z-scoring before pooling (3) — largest power gain for the least work.
3. A power readout in the lab UI, not just in the verdict string: "at your current data
   you could detect ρ ≥ 0.37; you have N marks; M more would get you to 0.25." Turns the
   honest limit into a target.
4. Noise-controlled findings (4): re-test every survivor with `noise` partialled out, and
   report both. A finding that dies is a movement artefact.
5. Within-session permutation null (5).
6. Recompute band powers from raw EEG in the lab (2) — the step from auditing to
   discovering, and the largest piece of work here.
7. Confidence intervals (7) and effective-comparison correction (6).

## Validation: calibration trials (the actual next priority)

Recorded from the person using this, and it is a better design than what was
built first. Markers currently ask you to *type*, which costs a sentence's worth
of attention. **Single-task trials** cost almost nothing and produce cleaner data,
because each trial isolates one variable instead of asking the data to explain
everything at once.

The shape: pick one thing, sit for 10–30 minutes, and press one button whenever
that one thing happens. Nothing else.

- **Return trial.** Press every time you notice you'd drifted and came back.
  Tests whether anything in the signal marks the moment of noticing.
- **Quiet trial.** Press when a stretch of quiet begins, press again when it
  ends. Tests `calm` and `openness` against felt stillness — and gives *durations*,
  not just instants.
- **Thinking trial.** Press when you catch yourself in active discursive
  thought. This is the direct test of the metric there is most reason to doubt.
- **Focus trial.** Press when attention locks in, again when it slips. Tests
  `focus` (frontal theta steadiness) against felt absorption.

**"Isn't focus just thinking inverted?"** Probably not, and it matters. A return
is a discrete *event* — a transition from distracted to engaged. Focus is a
continuous *state*. They can move independently: someone can be intensely focused
*on* a train of thought, and a skilled meditator might press rarely because they
seldom leave, or often because they notice more finely. So return-rate is not
monotonic with skill, which means it cannot be treated as a score. Collect them
separately and let the data say whether they collapse into one axis.

**What makes a trial worth anything** is a per-label confusion table, pooled
across sits: for each press, what every metric was doing in the seconds before
and after, versus a random baseline from the same session. If Focus does not
separate focus-presses from random moments, Focus measures nothing — and that is
a finding, not a failure. This is a table, not a model.

- [ ] Trial mode: pick a trial, one big button, no typing, no other UI.
- [ ] Per-label before/after comparison against a within-session random baseline.
- [ ] Pool trials across sessions (needs the storage above).

## Two things a real session exposed (2026-07-25)

Both were the honesty commitment failing *in practice* while the code looked fine.
Recorded because they are the kind of thing that will recur.

1. **"Sharp returns: 389"** in a 9-minute sit — one every 1.4 seconds. The number
   was band-power volatility, and the report described it as "your attention
   shifted sharply and came back. That returning is the practice." A meaningless
   number presented as a spiritual accomplishment. Worse than a neutral wrong
   number, because it flatters. Now named for what it measures, reported as a
   rate so an implausible value is obvious, and explicitly labelled as *not* a
   count of returns. A test that had been asserting the old wording was deleted —
   it was pinning the false claim in place.
2. **A session with 3–11% usable signal** still printed an average calm, a range,
   a first-third/last-third comparison and a full sparkline, all with the same
   confidence as a clean sit. One "read it loosely" bullet does not undo four
   tables that look like measurements. There is now a banner *above* the numbers,
   and it fires on the forehead pair specifically, since that is where every
   composite comes from.

**The general rule this suggests:** every reported number needs a companion
answer to "how much signal was this actually derived from," and the UI has to act
on that answer rather than merely disclose it.

## Phase 2 — the real phone app

**Goal:** each person at the center runs this on their own phone, no laptop
+ Mind Monitor relay needed.

- [ ] Cross-platform app (React Native or Flutter) with direct BLE via
      **BrainFlow** (drop Mind Monitor once this works — it was a Phase 0
      shortcut).
- [x] ~~In-the-moment guidance: short, state-triggered cues~~ — **built early
      in Phase 1** (`public/cues.js`), because live use surfaced the opposite
      problem first: a constant "keep steady" nag. The rules and rate limiting
      are pure logic and unit-tested, so they port to the app unchanged.
- [ ] Breath-paced audio/haptic: tone or pulse on inhale/exhale, with tone
      quality itself reflecting physiological state (not just timing). Real
      breath-rate detection (PPG-based, via respiratory sinus arrhythmia)
      already exists in the Phase 0 spike (`public/dsp.js`) — this is about
      bringing it to audio/haptic feedback in the real app, not building the
      detection itself again.
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
| HRV, cheap + very reliable | Polar H10 (~$90) | **Owned and integrated (2026-07-26).** Speaks standard BLE (Heart Rate Service `0x180D` for RR intervals, plus Polar's PMD for raw ECG), so Path B can add it as a second `requestDevice()` and feed the same state object — genuinely a small job. Unlocks real HRV, which is what `Equanimity` needs to stop returning `null`, and it is far more robust than EEG in a crowded room (Phase 3). |
| Breathing, real phase not just rate | Respiration belt (chest/abdomen strain) | Wanted, harder to source than expected. Muse S has no strain sensor — breathing is inferred from PPG via RSA, which gives **rate but not phase**, and phase is what a breath-paced visual actually wants. Off-the-shelf BLE options are either expensive (Hexoskin, ~$400+) or research kit; the cheap route is a piezo/stretch belt into an ESP32 speaking BLE, where the *hardware* is the work and the software side is easy. Worth it only if breath phase proves to matter for the experience. |
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
5. **Does this present a guess as a measurement?** If a number goes on screen,
   can we say exactly what it's computed from and what it cannot tell us — and
   does the UI say so too?
