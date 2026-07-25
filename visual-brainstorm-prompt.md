I'm building a meditation biofeedback app. A Muse EEG/PPG headband streams live
data to a phone/laptop browser, which drives a full-screen, real-time reactive
visual — the idea is that as you calm down, the visual reflects it back to you.

**What I have right now, technically:**
- A single continuous value, `calm` (0 to 1), updated a few times per second,
  smoothed so it doesn't jitter.
- (New, in progress) a real measured `breathPeriod` in seconds — your actual
  breathing rate, detected from heart-rate variability, once ~40s of good data
  has accumulated. Before that, it's just a guess.
- It's rendered as a single WebGL fragment shader (GLSL, WebGL1) covering the
  whole screen, running every frame, no external images/textures/libraries —
  everything is generated procedurally from math. Needs to run smoothly (60fps)
  on modest laptop/Chromebook GPUs.

**What it looks like today:** a domain-warped fractal noise field (layered
Perlin-ish noise, warped through itself) that shifts from cool/dark and busier
motion toward warm/light and slower motion as `calm` rises. It works, but it
reads as "trippy marbled clouds" — visually busy, more psychedelic than serene.

**What I want to explore instead:** something much more serene and minimal —
think soft gradients rather than swirling clouds. Two specific behaviors I want
the motion itself to express:
1. **Real stillness at rest.** When calm is high, I don't just want "slower" —
   I want it to feel like it has actually settled, close to motionless, the way
   a lake goes still. Motion should be the first thing to go, not the last.
2. **Breathing.** I'd like the visual to have some relationship to actual
   breath — either a real measured breathing rate (see above) or, as a
   fallback, just an implied, gentle inhale/exhale rhythm. Open to either a
   literal expansion/contraction, a soft pulse, or something more abstract.

**Context that matters for tone:** this comes from a Zen/Soto tradition, and one
design principle I care about is that feedback shouldn't feel like a game or a
score to chase — it's closer to a mirror than a meter. So: calm, contemplative,
a little austere is more "right" than dazzling or maximalist. Think closer to
James Turrell light installations, slow Rothko color fields, or the stillness
of water, rather than generative-art / VJ-style visuals.

**What would help me most:**
- 3–5 concrete, distinct visual directions (not just color palette ideas —
  actual different approaches to what's rendered and how it moves/settles).
- For each: how `calm` (0–1) and `breathPeriod` (seconds) would map onto it.
- Specifically address: what does "near-total stillness" look like without
  the screen just looking frozen/broken? And what's an elegant way to express
  a breathing rhythm without it feeling gimmicky (like a literal "breathing
  circle" app cliché)?
- Keep suggestions implementable as a single real-time GLSL shader with no
  external assets — I'll be the one translating whatever direction we like
  into actual shader code.

I'm not attached to keeping any part of the current noise-field approach —
happy to hear "throw it out and do X instead" if X serves the brief better.
