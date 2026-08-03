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

1. ~~Per-channel columns in `metrics.csv` (weakness 1)~~ — **done (2026-08-01)**, though not
   the way this line imagined. Rather than widening `metrics.csv`, the lab recomputes
   per-electrode spectra from the raw EEG in 4-second windows. That answers the electrode
   questions with better frequency resolution than `metrics.csv` could have carried, and it
   knocked out item 6 in the same work.
2. Per-session z-scoring before pooling (3) — largest power gain for the least work.
3. A power readout in the lab UI, not just in the verdict string: "at your current data
   you could detect ρ ≥ 0.37; you have N marks; M more would get you to 0.25." Turns the
   honest limit into a target.
4. Noise-controlled findings (4): re-test every survivor with `noise` partialled out, and
   report both. A finding that dies is a movement artefact.
5. Within-session permutation null (5).
6. ~~Recompute band powers from raw EEG in the lab (2)~~ — **done (2026-08-01)**. This was
   "the largest piece of work here" and it came in on the back of the individual alpha peak,
   because both need the same thing: 4-second windows over the raw samples. The lab now
   offers `alphaLog` / `alphaRel` / `alphaRatio` / `thetaLog` / `betaLog` per electrode, in
   this person's own alpha band, with a selector against the old 1-second rows.
7. Confidence intervals (7) and effective-comparison correction (6).

**A note on the statistics, since this changes the observations.** The 4-second analysis
windows do NOT overlap, deliberately: overlapping windows share samples and are therefore not
independent, so the effective *n* would be smaller than the row count and every *p*-value
optimistic by an unknown factor — which would quietly undo the multiplicity work above. The
averaged spectrum used to find the peak does overlap by half, where independence does not
matter because more windows only improve an average. Two different jobs, two different rules.

- [ ] Restrict the peak estimate to the eyes-closed control block when a session has one, and
      compare it against the whole-sit estimate. Whole-sit is used now because more windows is
      a better average, but eyes-closed is where alpha is largest and least contaminated, so
      the two disagreeing would itself be informative.
- [ ] Track the peak across sessions. It shifts with arousal, fatigue and time of day, so a
      per-sit figure is a candidate marker of state and not just a calibration constant.
- [ ] Consider using the individual band in the LIVE display. It cannot be done at 1-second
      windows (1Hz bins), so this means either a longer window for the alpha estimate alone —
      accepting the lag — or a narrowband filter rather than an FFT. Not attempted yet, and
      the live display staying on the fixed band is currently stated on screen rather than
      hidden.

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

## The one auto-ranging case still unhandled (2026-08-01)

Reported as "the sensor lines are jumping" in Flow, the same complaint as the earlier
composite jumping. Measured rather than guessed, and the measurements said the obvious
suspect was innocent:

- The **axis** is not the culprit. It moves 0.39% of the band per frame for the sensors
  (0.10% for the composites), and a 4-frame spike moved it **0.0%** — `autoRange` reads
  the 5th/95th percentiles, which a short spike cannot reach.
- The culprit is **noise amplified by rescaling**. The composites arrive already
  adaptively normalised; a per-channel value is a raw `alpha/(alpha+beta)` ratio with a
  genuinely narrow range, so auto-ranging magnifies its sample-to-sample noise. After
  rescaling, one noisy sample occupied **34% of the drawn band for the sensors** against
  5% for the composites.
- Fixed by smoothing the sensor series harder than the composites
  (`FLOW_SMOOTH_SENSORS = 21`, ~5.2s, vs `FLOW_SMOOTH = 9`). Drawn jitter fell from
  **1.8% to 0.8%** of the band. 5s is still shorter than any state worth seeing.
- A `noiseFloorMult` was written for `autoRange` to widen the band when the range is
  merely noise, then **removed**: across four regimes of drift and noise it never once
  changed the range. A safeguard that never fires is worse than none, because it reads
  as protection.

**Postscript, same day.** The smoothing was not enough and the diagnosis above was
incomplete: reported again as *"like a battery analog watch vs. automatic. tick tick"*.
Measuring the frames rather than the samples found two mechanisms that were **rewriting
already-drawn line**, both only on the frame a sample arrived — a centred smoothing window
(samples 0–8 back from the head moved 2.8–3.3% of the band per new sample) and the axis
widening instantly (6.14% in one frame). Fixed by smoothing causally and caching per
sample, and by easing the widening. And the *"esp when the sensor reads 0"* half turned out
to be a defect upstream of the drawing entirely: the amplitude test had no lower bound, so
a channel delivering a flat line passed as clean and reported a level of exactly zero. See
the README sections. A dropout now moves the recorded past 0.11% of the band instead of 43%.

**What is still not handled:** a channel whose *genuine* range is smaller than its own
noise. There the smoothing helps but cannot win — measured residual jitter 7.6% of the
band at 9 samples of smoothing, 3.5% at 21. The honest fix is not more smoothing but
refusing to auto-range at all below some measured signal-to-noise ratio, and drawing the
channel against a fixed 0–1 axis with a note saying why. Not built, because I could not
reproduce the user's picture with synthetic data and do not yet know whether this case
is what they were seeing.

- [ ] Decide the SNR threshold below which a channel is drawn on a fixed axis, from
      recorded sits rather than synthetic noise.

## Spoken keywords as markers: where the translation should happen (2026-08-01)

Asked: *"If I leave a voice note and the voice note has words like thinking, which basically
act as kinda markers, how does that... where does that translation from text into marker
happen?"* Deferred deliberately, on the grounds that the data is being saved and can be
correlated later. Mostly true — one gap was closed immediately, see below.

### There are four clocks, not one

This is the crux, and it is why the answer is not "grep the transcript".

1. **The state** — when the mind was actually wandering. Unobservable.
2. **The noticing** — when you became aware of it.
3. **The press** — space going down. This is what `offsetSec` records.
4. **The word** — when "thinking" was actually spoken, somewhere inside the utterance.

A keyed tap collapses 2 and 3 into one event with one latency, which is the whole reason the
clip library can align on it: *the mark is the noticing*. A voice note adds a longer and more
variable gap between 3 and 4 — you press, you compose a sentence, and the keyword arrives one
to five seconds later. Mixing voice-derived marks and tap-derived marks into the same epoch
average without accounting for that would blur the alignment the clip library exists to
resolve, and it would blur it *invisibly*, because both would look like marks.

### The one thing that could not wait

The audio is saved and the note's start is timestamped, but the transcript was collapsed to a
single flat string — so there was **no record of where in the utterance a word fell**. That is
only observable live: recovering it later means re-transcribing the audio with a tool that
emits word timings.

So the recogniser's output is now stamped on arrival and exported as `transcripts.csv`, one row
per revision, carrying both clocks (into the note, and into the sit). Snapshots rather than
diffs, because interim results get *revised* — the recogniser changes its mind about earlier
words, so a running transcript is not append-only and a diff computed live would be wrong in
exactly the cases that matter. Precision is about one recogniser event, not one word, and the
README says so.

### Where the translation should happen: the lab, not the app

- **Not live in the app.** A keyword firing a mark mid-sit means the app acting on a guess
  about speech while you are sitting, and a false positive would be indistinguishable from a
  deliberate tap forever after.
- **Not at save time either**, for the same reason: it bakes an inference into the record.
- **At ingest in the lab, as a derived and clearly-labelled artefact.** The lab already
  re-derives spans, blocks and clips from notes.csv; voice-derived marks belong in the same
  layer, where they can be recomputed when the rules improve. `notes.csv` has carried a
  `transcript` column for a while and nothing reads it yet, so the seam already exists.

### Keyword spotting is a proposal engine, not a marker source

Naive matching fails in both directions, and the failures are not rare:

- *"I wasn't really thinking about anything"* — negation.
- *"thinking about how nice it is to not be thinking"* — two mentions, one event, and the
  second is about the first.
- *"I'd been gone for a while"* / *"came back from somewhere"* — clearly a Thinking mark, no
  keyword at all.
- *"I should press T more often"* — meta-commentary about the protocol, not an event in it.

So the output should be **proposals you confirm**, not marks. A review screen listing each
candidate with its timestamp, the sentence around it, and accept/reject — which also generates
exactly the labelled data needed to find out how good the matching is.

### Provenance is non-negotiable

A voice-derived mark must be distinguishable from a keyed tap **everywhere downstream**, with
its own `source` field, and every analysis must be runnable three ways: taps only, voice only,
both. The reason is the four clocks above — if voice marks have a systematically larger and
noisier latency, pooling them attenuates any real effect, and if they are pooled invisibly
there is no way to discover that is what happened.

### Build order, when it comes

- [ ] Read `transcripts.csv` in the lab and render each voice note's transcript on the
      timeline at the word level.
- [ ] A keyword/phrase table per tap category, including negation handling — most cheaply as
      "no `not`/`wasn't`/`didn't` within N words before the keyword", which is crude and
      testable.
- [ ] A review screen that proposes marks and records accept/reject. The accept/reject log is
      the actual deliverable of this step, not the marks.
- [ ] `source: 'voice' | 'tap' | 'probe'` on every mark, and a filter in the clip library and
      the search.
- [ ] MEASURE the latency difference: for sits with both, compare the epoch average locked to
      taps against the one locked to voice keywords. If the voice-locked average is flatter
      and broader, that is the latency showing up, and it quantifies the cost of pooling.
- [ ] Only then consider re-transcribing the saved audio offline with a word-timing model, if
      the browser recogniser's one-event precision turns out to be the limit.

## Is EEG even the right instrument? (2026-08-02)

Asked directly, and it is the most important question anyone has put to this project:

> *"i'm slightly wondering if the brain signals are really good indicators of meditation quality.
> i noticed myself that when i'm very calm, some other indicators appear more obviously (and maybe
> measurable) such as: less fidgeting, eye gaze less erratic, movements are more deliberate, but
> also more smooth in tempo... showing a diff velocity curve than when i'm riled up (in which case
> it's more quick at the start and stop would be my guess)... it's making me wonder if a brain
> device is the right device to capture meditation quality at all. or if it's necessary, or even
> the best."*

**The honest answer is that the doubt is well-founded, and the app was already collecting the data
to test it.** `acc.csv` — 50Hz three-axis accelerometer from the headband — has been in every
archive since the beginning and nothing had ever analysed it.

Three reasons to take the doubt seriously rather than defend the EEG:

1. **Stillness is nearly a direct measurement.** A body that is not moving produces a flat
   accelerometer trace. No band decomposition, no adaptive normaliser, no interpretation. Every
   EEG composite in this app is an inference from four dry electrodes reading through hair and
   skin, and most of them are labelled "speculative" in `metrics.js` for good reason.
2. **The measured contact record backs it up.** On a real sit the ear channels were artifact-
   flagged 32% of the time and only 35 of 229 four-second windows were clean enough to estimate
   an alpha peak from. The accelerometer had 100% coverage over the same sit.
3. **The practitioner's own report is the ground truth here**, and their report is that movement
   quality tracks their state more obviously than anything on the screen does.

### What is now measured

`movement.js`, with `test-movement.js` alongside it:

- **stillness** — share of the sit with per-sample change below 8mG. Set from real data: on a
  genuine sit the change was median 3.5mG, p90 13.2mG, p99 37.8mG.
- **movements per minute**, at a 50mG peak threshold. Also set from data, via a sweep: below
  ~40mG the median "movement" lasts under half a second, which is a pulse beat rather than an
  adjustment. Threshold deliberately ABSOLUTE, not relative to each sit's own noise floor — a
  relative one would drop on a calm sit, catch more small motion, and report the calm sit as
  having *more* movements.
- **crest** — peak over mean rate of change within a movement.
- **peak position** (`riseFrac`) — where the peak falls in the movement, 0.5 being symmetric.
  **This is the direct test of "quick at the start"**, and measured against synthetic shapes it
  separates smooth from abrupt about three times more strongly than crest does. Read it first.
- **postural drift** — slow orientation change per minute, kept separate because slumping over
  ten minutes and twitching every ten seconds are different behaviours.

### What the first real sit says

7.7 minutes, 78.4% still, 3.8 movements/min, median crest 5.3, median peak position 0.24,
postural drift 403mG/min. One sit is one observation, so none of that means anything yet — but
the numbers are in a sensible range and the machinery discriminates on synthetic shapes.

### Still not measured, and worth being clear about

- **Eye gaze.** Not available. The Muse has no eye tracker; EOG from the frontal electrodes can
  detect blinks and gross saccades but not "erratic gaze", and nothing here should pretend
  otherwise.
- **Whole-body movement.** The head accelerometer sees head motion. A hand scratching a knee may
  or may not show up. The Polar H10 has its own accelerometer at the chest, which is the obvious
  second axis and is already recorded.
- **Movement during walking or standing.** The hypothesis was partly about movement *in general* —
  "walking, scratching, adjusting your position, leaving a room, grabbing a cup" — which is a much
  larger and more interesting claim than anything a seated sit can test.

### The build order this implies

- [ ] Chest accelerometer as a second movement axis, from the strap that is already worn.
- [ ] Movement metrics computed per-window, not just per-session, so movement can enter the mark
      search on the same footing as the EEG features — the direct comparison of the two
      instruments on the same question.
- [ ] Correlate movement against the self-reports across many sits. If stillness or peak position
      predicts the felt sense better than `calm` or `equanimity` do, **say so on the summary
      screen** and demote the brainwave scores accordingly. The instrument that cost more does not
      get to win by default.
- [ ] A deliberate trial: sit calm for 5 minutes, then agitated for 5, with movement and EEG both
      recorded. That is the cheapest strong test of the whole hypothesis and it needs no new
      hardware.

## The coefficients were invented, and the prose said so while the arithmetic did not (2026-08-03)

Asked for a careful look at the project goals, the UI, the product, the code and "the formulas we're
using to create visuals": what makes sense, what doesn't, what is the biggest weakness.

The biggest weakness was in this repository's own arithmetic, and non-negotiable #5 had been
honoured in English and broken in JavaScript. `metrics.js` carried scrupulous caveats — "a proxy of a
proxy", "no established marker for equanimity", "do not read mood from this" — beside formulas
containing nine hand-picked numbers:

```
focus     = thetaLevel * (1 - 0.55 * variability)
drowsy    = 0.5*theta + 0.5*delta - 0.35*alpha + 0.17
openness  = 0.55*alpha + 0.25*(1-beta) + 0.20*(1-variability)
asymmetry = 0.5 + 0.5*tanh((L-R) * 2)
```

None of them measured. Several to two decimal places. One (`+0.17`) existing only to drag a
subtraction back into range. Weights like that are worse than no weights, because they manufacture
the appearance of calibration and a reader cannot tell an invented 0.55 from a fitted one.

**Every composite is now a ratio or a geometric mean** — bounded by construction, nothing to tune:

- `focus` = √(theta × steadiness). A conjunction, so absent theta is zero focus however steady;
  the weighted form returned 0.45 of nothing.
- `drowsy` = (theta + delta) / (theta + delta + alpha). A share, so no intercept is needed.
- `openness` = √(alpha/(alpha+beta) × steadiness). The old weighted sum let high alpha buy its way
  past a churning signal and still report open awareness — the opposite of the finding it cites.
- `asymmetry` = the standard laterality index, difference over sum, with no gain deciding how much
  difference counts as a lot.

`test-metrics.js` strips comments from `compute()` and fails on any numeric literal outside
{0, 1, 0.5, 2}, so the next weighted sum has to argue for itself there.

### Eleven metrics was too many to put on a screen

Of eleven, two were "solid" and both are artifacts: a blink and a clenched jaw are the most
trustworthy things this headband measures. Breadth also costs power, measurably — a 469-comparison
search over 71 observations can only report ρ ≥ 0.43, while 20 comparisons brings that to 0.33, so
each extra displayed metric is roughly a tenth of an effect size that can no longer be found.

`openness` and `asymmetry` are retired from the live display on the strength of their own caveats.
Retired is **not** deleted: the lab still computes them, the raw EEG is still kept, and the honesty
panel marks them rather than implying everything listed is on screen. `equanimity` stays at the
practitioner's explicit request — "go for it all, but keep equanimity" — and keeps its exploratory
tier and its caveat, because being asked for is not evidence.

`activeComposites` in direct.html was a second hand-written list of the same thing and now derives
from the registry, because that duplication has already caused drift bugs here twice.

### A retraction: the visuals are NOT decoration

I told the practitioner that "the visuals cannot distinguish your brain from white noise", from a
measurement showing the real `calm` series and white noise both sweeping 5% of the normaliser's
output range. **That comparison was confounded and the conclusion was wrong.** Comparing a real
series against a *different* series conflates two questions: whether the display responds to
temporal structure, and whether the two happened to have similar amplitude.

The correct test is a series against a **shuffled copy of itself** — which destroys order, trends and
excursions while preserving the distribution exactly, so the only thing that differs is structure.
On the practitioner's real recorded sit:

| metric | display vs its own shuffle |
|---|---|
| calm | 3.38× |
| equanimity | 3.91× |
| focus | 3.35× |
| thinking | 5.01× |
| drowsy | 4.14× |
| HRV | 5.65× |

All far above the 1.2× that chance produces. The pipeline does respond to real structure. The
adaptive normaliser scores 4.24× on a wandering series and 0.80× on white noise, so it is not the
blind amplifier I claimed.

`selfcheck.js` makes this a permanent instrument rather than a one-off: the summary screen now
reports it every sit, because the answer depends on the sit — a session with poor contact scores
well below one with signal, and that is precisely when a confident-looking visual misleads most.
`test-selfcheck.js` asserts it can deliver bad news, since a self-check that only ever reports good
news converts an unexamined problem into a certified one.

### Still outstanding from that review

- [ ] The label hierarchy is backwards. The whole-sit rating needs no reaction time and is the best
      label the system collects; it is optional and skippable. Marks depend on noticing and they are
      the spine of the analysis.
- [ ] The session-level search: one sit = one observation, the end-of-sit rating as the label.
- [ ] The lab needs an honest headline before its tables.
- [ ] `direct.html` is 4,500 lines and the source of all three page-blanking bugs. Splitting it is
      the highest-risk item here and the lowest user-visible value, which is why it is last.

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
