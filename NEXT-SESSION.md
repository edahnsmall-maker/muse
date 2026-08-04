# START HERE — the redesign, specified

Written at the end of a session whose context was exhausted. Everything below was asked for and
NOT delivered. The previous session degraded into one-small-thing-per-turn because it could no
longer hold enough of the codebase in view to restructure a page; do not repeat that. Read this,
then do the whole thing in one pass.

The practitioner's words, verbatim, because they are the spec: *"i'm getting disappointed with
your outputs. i wanted you to make something more enticing."*

## 0. The two mockups are the target

`visual-brainstorm-prompt.md` and the session history hold two ChatGPT mockups that were approved
outright: a Train screen and a Lab screen. They are better than what exists. Build them.

Two things in them must NOT be built, and this is not negotiable: **"Confidence 82%"** and
**"Personalized model"**. Nothing here is fitted and there is no basis for 82. Also **"Signal 94%"**
would have read ~94% on sits where two of four electrodes were dead.

## 1. MEDITATE AND TRAIN ARE THE SAME THING — collapse them

The last session added a Meditate/Train toggle in the app bar that just flips `trainingMode`.
Reported back: *"the meditate page and train is the same thing. i can leave it for now."*

Collapse to **two places: Meditate and Lab.** Marking is always available; the "training" concept
should disappear from the UI entirely (it survives internally as whether recording is armed).

## 2. THE METRICS PANEL — group it, dock it

- **MIND / BODY / SIGNAL section headers**, as in the mockup. Currently one flat list.
  - MIND: calm, thinking, focus, drowsy, equanimity
  - BODY: breath, heart, HRV, alpha share
  - SIGNAL: noise, jaw/muscle, blinks, per-channel contact
- **Docked vs floating.** The mockup's "Drag to move · double-click to dock" treatment. `panels.js`
  already does dragging, persistence and re-clamping; what is missing is a docked STATE that snaps
  to an edge and a visible affordance for it.

## 3. THE LAB — rebuild, do not patch

*"the entire page doesn't work right now. i dont think the current tabs even really make sense
anymore given how i'm seeing things."*

Current tabs (Explore/Sessions/Compare/Signals/Learn) were built one turn before the practitioner's
thinking moved on. The NEW shape follows their stated logical flow:

1. **Your sits** — every recording already on this device, listed, clickable, selectable. It ALREADY
   reads them without an upload (`loadFromApp()` in lab.html) — that part works and is worth keeping.
   Each row: the general note as its name, length, mark tally by kind, signal quality, × to exclude.
   **Crucially: show the general note prominently.** *"since i've been leaving notes that describe my
   general state of mind, it would be useful to see that to know what to add to the analysis."*
2. **Studies** — build named lists by dragging sits into them: `scattered`, `at rest`, `focusing`,
   `lots of thinking`. Arbitrary lists, user-named, persisted. This replaces the whole-session table,
   which was correctly called *"built for a researcher and that's a problem."*
3. **Compare** — two or more lists, compared on breath shape / frequency / depth / regularity, then
   on EEG. Hunches count: *"hunches will be valuable even if they don't rise to the level of
   p<whatever."* `explore.js` already reports session COUNTS rather than p-values for this reason —
   keep that and keep its tests.
4. **Export for AI** — a button that copies the feature table for pasting into Claude. The division
   agreed: CODE the feature extraction, SEND the table out for pattern-finding. Never let a model
   decide what counts as a finding.

## 4. SMALL, EXPLICIT, ALL ASKED FOR

- **Double-tap Thinking = "deep thinking".** Two T presses inside ~1.5s become one mark of a distinct
  category, not two Thinking marks. Add the category to `probes.js` TAP_CATEGORIES.
- **Move the arrow-key assignment to the MARK panel.** It is in the Notes panel and that is wrong:
  *"the arrow key assignment makes much more sense from the Mark panel than the notes panel."*
- **A permanent area to label the whole sit.** Not inside a panel that has to be opened — always on
  screen. The general note is how sits get named, so it must be as easy as marking.
- **Two accelerometers, assignable.** A belly sensor is being acquired: *"i might try to get a second
  sensor for the belly so that takes care of that. we'll just need to assign them."* So the UI needs
  to say which strap is chest and which is belly, and `breath.js` needs to take either. The belly is
  where the hypothesis lives — the Polar strap sits on the ribcage.

## 5. WHAT IS ALREADY SOLID — do not rebuild these

- `breath.js` — rate + shape (riseFrac, regularity CV, crest, depth), with a MANDATORY cross-check
  against heart-derived breathing. Refuses rather than guessing. 1 of 3 real sits answered, 2 refused,
  0 wrong. Its open problem is axis selection; see ROADMAP for the two rules already tried and failed.
- `explore.js` — session counts not p-values, marks-vs-marks comparison, four honesty badges.
- `simdevice.js` — `?sim=1`. Use it. It caught two real bugs in the last session within ten seconds
  each, including a temporal-dead-zone throw of exactly the kind that took the app down twice.
- Head accelerometer capture — verified against gravity (1003.8 mG against a true 1000).
- 29 test suites. Run them all. `test-visual-smoke.js` takes over five minutes; that is normal.

## 6. THE ONE THING THAT MATTERS MOST ABOUT THE DATA

Every EEG composite is normalised WITHIN the sit. Measured across seven real recordings, the displayed
calm score spanned 42-53 while the underlying physiology spanned more than twofold, and their rank
correlation was MINUS 0.32 — the best sit read 45.9 and the worst read 52.9. Only `calmAbs`,
`breathPerMin`, `hrBpm`, `hrvMs` and the per-channel alpha share can be compared between sits.
Anything comparing sits on the other scores is worse than useless.

Alpha has not been measurable in ANY of eight sits: prominence 0.77-0.84 against 1.5 needed, the
alpha region sitting BELOW the 1/f background. The practice is eyes-open and that is what eyes-open
alpha suppression looks like. Do not build on alpha; test against breath.
