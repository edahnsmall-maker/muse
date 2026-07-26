#!/usr/bin/env node
/*
 * Render a visual mode headless and write PNGs.
 *
 * WHY THIS EXISTS
 * Every visual in this project has been written blind. The renderer draws to a
 * canvas, nothing in the authoring environment could display one, so aesthetics
 * could only be checked by the person wearing the headband: build, run,
 * screenshot, describe, guess again. That loop is slow and it is the actual
 * reason three earlier shader attempts never converged — not difficulty.
 *
 * This closes the loop. Chromium is already present (Playwright), so the
 * renderer can run for real, against a deterministic clock, driven by scripted
 * physiology, and be photographed at chosen moments.
 *
 * What it does verify: composition, colour, line density, whether a shape reads
 * as the shape it is meant to be, and whether a mode changes over time or sits
 * dead. That is most of what has been going wrong.
 *
 * What it does NOT verify: how it feels in motion, how it looks at full size in
 * a dark room, or GPU-specific behaviour — headless GL is software-backed here,
 * so colour and precision can differ from real hardware. Screenshots inform
 * judgement; they don't replace the person sitting in front of it.
 *
 *   node tools/shoot.js --mode flow --scenario settling --at 5,30,90
 *   node tools/shoot.js --all --scenario agitated --at 45
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Playwright is installed globally in this environment, not in the project.
// Keeping it out of package.json is deliberate: this is a development tool, and
// nothing the Muse app itself ships should depend on a browser automation stack.
const GLOBAL_MODULES = '/opt/node22/lib/node_modules';
if (!Module.globalPaths.includes(GLOBAL_MODULES)) Module.globalPaths.push(GLOBAL_MODULES);
process.env.NODE_PATH = [process.env.NODE_PATH, GLOBAL_MODULES].filter(Boolean).join(':');
Module._initPaths();
const { chromium } = require(path.join(GLOBAL_MODULES, 'playwright'));

// ---- scripted physiology ---------------------------------------------------
// Each scenario is a pure function of simulated seconds returning what the page
// would have passed to setState. Deliberately synthetic and repeatable: the
// point is comparability, not realism.
const wobble = (t, seed) => 0.5 + 0.5 * (
  0.55 * Math.sin(t * 0.31 + seed * 1.7) +
  0.30 * Math.sin(t * 0.53 + seed * 3.1) +
  0.15 * Math.sin(t * 0.87 + seed * 5.3)
);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const SCENARIOS = {
  // Everything parked mid-range. Anything that looks alive here is animating on
  // time alone, not on data — worth knowing which is which.
  flat: () => ({
    calm: 0.5, activity: 0.5, noise: 0,
    metrics: { calm: 0.5, thinking: 0.5, focus: 0.5, drowsy: 0.5 },
    bands: [0, 1, 2, 3].map(() => ({ level: 0.5, spike: 0 })),
  }),
  // A realistic sit: adaptive normalisation keeps everything near 0.5, which is
  // exactly the regime where under-scaled visuals look dead. This is the
  // scenario that catches "the line never moves".
  realistic: (t) => {
    const calm = clamp01(0.42 + 0.16 * Math.sin(t / 55) + 0.05 * (wobble(t, 1) - 0.5));
    const think = clamp01(0.60 - 0.14 * Math.sin(t / 55) + 0.06 * (wobble(t, 2) - 0.5));
    return {
      calm, activity: think, noise: 0.05,
      metrics: {
        calm, thinking: think,
        focus: clamp01(0.45 + 0.10 * Math.sin(t / 41 + 1)),
        drowsy: clamp01(0.40 + 0.08 * Math.sin(t / 73 + 2)),
      },
      bands: [0, 1, 2, 3].map((i) => ({
        level: clamp01(0.45 + 0.10 * (wobble(t * 0.5, i + 1) - 0.5) * 2 + 0.05 * Math.sin(t / 30 + i)),
        spike: 0,
      })),
    };
  },
  // Settling across the capture window: thinking falls, calm rises.
  settling: (t) => {
    const p = clamp01(t / 120);
    const calm = clamp01(0.35 + 0.45 * p + 0.04 * (wobble(t, 1) - 0.5));
    const think = clamp01(0.75 - 0.45 * p + 0.05 * (wobble(t, 2) - 0.5));
    return {
      calm, activity: think, noise: 0.03,
      metrics: { calm, thinking: think, focus: clamp01(0.3 + 0.4 * p), drowsy: clamp01(0.3 + 0.2 * p) },
      bands: [0, 1, 2, 3].map((i) => ({
        level: clamp01(0.35 + 0.35 * p + 0.12 * (wobble(t * 0.6, i + 1) - 0.5)),
        spike: 0,
      })),
    };
  },
  // Busy and spiky — the stress case for brightness and blow-out.
  agitated: (t) => ({
    calm: clamp01(0.28 + 0.10 * (wobble(t, 3) - 0.5)),
    activity: clamp01(0.82 + 0.12 * (wobble(t, 4) - 0.5)),
    noise: 0.35,
    metrics: {
      calm: clamp01(0.28 + 0.10 * (wobble(t, 3) - 0.5)),
      thinking: clamp01(0.85 + 0.12 * (wobble(t, 4) - 0.5)),
      focus: clamp01(0.25 + 0.15 * (wobble(t, 5) - 0.5)),
      drowsy: 0.2,
    },
    bands: [0, 1, 2, 3].map((i) => ({
      level: clamp01(0.5 + 0.4 * (wobble(t * 1.3, i + 2) - 0.5) * 2),
      spike: (Math.floor(t * 2) % 11 === i) ? 1 : 0,
    })),
  }),
  // Fast structure: a slow drift with real second-to-second movement and
  // occasional bursts on top. This is the scenario that tells you whether a
  // mode can render SHAPE rather than just a slowly-changing level — the others
  // all vary too smoothly to distinguish "working" from "drawing a circle".
  bursty: (t) => {
    const burst = Math.max(0,
      Math.sin(t * 0.9) ** 8 + 0.8 * Math.sin(t * 0.31 + 2) ** 12);
    const think = clamp01(0.45 + 0.30 * burst + 0.14 * (wobble(t * 2.2, 4) - 0.5) * 2);
    const calm = clamp01(0.55 - 0.22 * burst + 0.10 * (wobble(t * 1.7, 1) - 0.5) * 2);
    return {
      calm, activity: think, noise: 0.06,
      metrics: {
        calm, thinking: think,
        focus: clamp01(0.48 + 0.18 * (wobble(t * 1.4, 5) - 0.5) * 2 - 0.15 * burst),
        drowsy: clamp01(0.42 + 0.14 * (wobble(t * 0.9, 6) - 0.5) * 2),
      },
      bands: [0, 1, 2, 3].map((i) => ({
        level: clamp01(0.48 + 0.22 * (wobble(t * 1.9, i + 1) - 0.5) * 2),
        spike: burst > 0.7 && i === (Math.floor(t) % 4) ? 1 : 0,
      })),
    };
  },
  // A hard swing, to check that a mode responds at all and how far it travels.
  swing: (t) => {
    const s = 0.5 + 0.5 * Math.sin(t / 8);
    return {
      calm: s, activity: 1 - s, noise: 0,
      metrics: { calm: s, thinking: 1 - s, focus: s, drowsy: 1 - s },
      bands: [0, 1, 2, 3].map((i) => ({
        level: clamp01(0.5 + 0.5 * Math.sin(t / 8 + i * 1.4)),
        spike: 0,
      })),
    };
  },
};

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const out = { mode: null, all: false, scenario: 'realistic', at: [30], w: 1280, h: 720, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--at') out.at = argv[++i].split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    else if (a === '--size') { const [w, h] = argv[++i].split('x').map(Number); out.w = w; out.h = h; }
    else if (a === '--out') out.outDir = argv[++i];
  }
  if (!out.at.length) out.at = [30];
  return out;
}

const FPS = 30;             // simulated frames per second
const DATA_HZ = 4;          // setState calls per simulated second, as the app does

async function main() {
  const args = parseArgs(process.argv);
  if (!SCENARIOS[args.scenario]) {
    console.error(`unknown scenario "${args.scenario}". known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const outDir = args.outDir || path.join(process.env.TMPDIR || '/tmp', 'viz-shots');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  const modes = args.all ? await page.evaluate(() => window.__modes) : [args.mode];
  if (!modes.length || modes.some((m) => !m)) {
    console.error('pass --mode <key> or --all');
    process.exit(1);
  }

  const scenarioFn = SCENARIOS[args.scenario];
  const written = [];

  for (const mode of modes) {
    // A fresh page per mode, so one mode's accumulated state (Iris's record
    // layer especially) can never leak into another's screenshot.
    const p = await browser.newPage({ viewport: { width: args.w, height: args.h }, deviceScaleFactor: 2 });
    p.on('pageerror', (e) => { console.error(`PAGE ERROR [${mode}]:`, e.message); process.exitCode = 1; });
    await p.goto('file://' + path.join(__dirname, 'harness.html'));
    await p.evaluate((m) => window.__setMode(m), mode);

    let simSec = 0;
    for (const target of [...args.at].sort((a, b) => a - b)) {
      // Walk time forward in data ticks, feeding state and rendering frames,
      // exactly the order the real page does it in.
      while (simSec < target) {
        const step = Math.min(1 / DATA_HZ, target - simSec);
        await p.evaluate(({ st, ms, frames }) => {
          window.__visual.setState(st);
          window.__advanceMs(ms, frames);
        }, {
          st: scenarioFn(simSec),
          ms: step * 1000,
          frames: Math.max(1, Math.round(step * FPS)),
        });
        simSec += step;
      }
      const file = path.join(outDir, `${mode}-${args.scenario}-${String(Math.round(target)).padStart(4, '0')}s.png`);
      await p.locator('#gl').screenshot({ path: file });
      written.push(file);
      console.log(`${file}`);
    }
    await p.close();
  }

  await browser.close();
  if (!written.length) { console.error('nothing captured'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
