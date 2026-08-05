# START HERE

The previous NEXT-SESSION.md specified a redesign that had been asked for and not delivered. Most of it
is now built. This file records what was done, what changed course, and what is left — read it with
`HANDOFF.md` beside it.

## 1. WHAT CHANGED COURSE, and why the old §1 is wrong

The old file said: **collapse Meditate and Train into one place** and make the training concept disappear.
A later instruction said the opposite — *"differentiate the meditate page a little from the training
area"* — and the later instruction won.

So they are two genuinely different screens now, differentiated on the axis ROADMAP already argues for
(feedback *"is closer to a mirror than a meter"*):

- **Meditate** — the visual, and as close to nothing else as is safe. No metrics panel, no live feed, no
  mark bar, no on-canvas legend. A number on screen is a thing to check, and checking is the opposite of
  sitting.
- **Train** — the instrument: marks, live feed, grouped metrics, recording armed.

**The one subtlety worth keeping in mind if you touch this.** Austerity applies to a working sit, not to
an unconfigured app. The metrics panel is also where a fresh page says "No headband connected — press
Connect", and the control bar holds the Connect button. Stripping either unconditionally recreates a
defect that was already reported once. The `preflight` body class is what keeps them visible until
something is actually streaming, and it is maintained above the tick's early return.

## 2. DONE

**The lab no longer freezes.** It was analysing the twelve most recent sits before painting anything —
9.3s for 8 sits of 30 minutes, 19.9s for 14 of 40, identical on every reload because none of it was
cached. Boot is now ~300ms regardless of how much EEG is stored, and a sit is analysed once, ever.
See the long note on `listAppSits` in `lab.html`; the short version is that listing and analysing are
now separate jobs, and `recorderId` is what makes "already analysed?" a lookup instead of a parse.

**The lab's shape follows the stated flow**: Your sits · Studies · Compare · Export for AI, then
Explore · Signals · Learn. Your sits is what you land on.

**Studies** are arbitrary named lists, persisted in localStorage, built by dragging sits in or by ticking
and adding. **Compare** takes two or more and reports breath first, then EEG, with no p-values and every
sit's own value printed. **Export for AI** copies a feature table with its limits first and no
within-sit-normalised column.

**The lines stopped drifting.** `AdaptiveNormalizer`'s baseline chased the signal it measured, so any
level the signal held was subtracted back out — a real rise to 0.8 displayed 69 at two minutes, 62 at
five and 56 at ten while nothing changed. The baseline now learns from the first two minutes of usable
signal and then holds. Counted in usable updates, not ticks, so a badly seated headband cannot fix the
scale on windows that produced no reading.

**Metrics panel grouped into MIND / BODY / SIGNAL**, with a docked panel state and the mockup's
"drag to move · double-click to dock" affordance. Blinks and jaw are SIGNAL, not BODY as the mockup had
them — they are artifact measures, and grouping them with mind states is how a fit problem gets read as
something you are doing with your attention.

**breath.js now runs.** It was loaded by no page at all: 450 lines with a passing test suite, wired into
nothing, so rate, depth, regularity and the rise fraction had never been computed for a real sit. It runs
at lab ingest, cross-checked against the heart-derived rate from the same strap, and refuses rather than
guessing.

**Five columns added to metrics.csv** that the app knew and never wrote: `breathPhase` (the only column
that can express a held breath), `breathRising`, `breathSource`, `beatsRejected`, `chanState`.

**Double-tap Thinking = deep thinking**, the arrow-key editor moved to the mark panel, and a permanent
place to name the sit in the app bar.

## 3. WHAT IS LEFT

1. **The two-accelerometer work**, deferred on purpose until the belly strap is in hand. The UI needs to
   say which strap is chest and which is belly, and `breath.js` needs to take either. The belly is where
   the hypothesis lives — the Polar strap sits on the ribcage.
2. **Breath.js has never seen a real sit through this path.** It is wired in and verified against a
   planted signal (recovers 12.006/min from a planted 12, 0.05% from the reference), but the first real
   recording through it is the actual test. Expect refusals; they are the feature.
3. **Explore and Signals could fold into Compare and Your sits.** Seven tabs is more than the four the
   flow calls for. They were left standing because each has tested content behind it — the mark-locked
   search, the clip library, the alpha peak — and folding them is a layout job, not a functional one.
4. **The old per-sit A/B table** is folded away inside Compare rather than deleted: Studies replaced it as
   the way sits get grouped, but the movement and stillness numbers in it are a real measurement nothing
   else reports.

## 4. THE TWO THINGS THAT MATTER MOST ABOUT THE DATA

Unchanged, and still the most important paragraphs in this repo.

Every EEG composite is normalised WITHIN the sit. The baseline holds after two minutes now, which makes
the numbers readable over time inside one sit — it does **not** make them comparable between sits, and
nothing will: two sits that started differently have different zeroes. Measured across seven real
recordings the displayed calm score spanned 42–53 while the underlying physiology spanned more than
twofold, with a rank correlation of MINUS 0.32. Only `calmAbs`, `breathPerMin`, `hrBpm`, `hrvMs` and the
per-channel alpha share can be compared between sits. The Compare tab and the exported table both refuse
to offer the others.

Alpha has not been measurable in ANY of eight sits: prominence 0.77–0.84 against 1.5 needed, the alpha
region sitting BELOW the 1/f background. The practice is eyes-open and that is what eyes-open alpha
suppression looks like. Do not build on alpha; test against breath.
