const assert = require('assert');
const Summary = require('./public/summary.js');

const mk = (n, fn) => Array.from({ length: n }, (_, i) => Object.assign({ t: i, calm: 0.5, noise: 0, levels: [0.5, 0.5, 0.5, 0.5], spikes: 0 }, fn(i)));

// 1) Empty / garbage input returns null rather than throwing or inventing stats.
{
  assert.strictEqual(Summary.summarize([]), null, 'empty input should return null');
  assert.strictEqual(Summary.summarize(null), null, 'null input should return null');
  assert.strictEqual(Summary.summarize([{ t: 0 }, { calm: NaN }]), null, 'samples with no usable calm should return null');
  assert.deepStrictEqual(Summary.describe(null), [], 'describe(null) should be empty, not crash');
  console.log('✓ summarize handles empty/garbage input without inventing statistics');
}

// 2) Core statistics are correct on a known series.
{
  const s = Summary.summarize(mk(100, (i) => ({ calm: i / 99 })));
  assert.strictEqual(s.durationSec, 99);
  assert.strictEqual(s.sampleCount, 100);
  assert.ok(Math.abs(s.calmMin - 0) < 1e-9, 'min should be 0');
  assert.ok(Math.abs(s.calmMax - 1) < 1e-9, 'max should be 1');
  assert.ok(Math.abs(s.calmAvg - 0.5) < 0.01, `avg of a ramp should be ~0.5 (got ${s.calmAvg})`);
  assert.ok(s.lastThirdCalm > s.firstThirdCalm, 'a rising ramp should have a calmer last third');
  console.log('✓ duration, min/max/avg, and first-vs-last-third are correct');
}

// 3) Settling time needs a SUSTAINED settle — a single blip must not count.
{
  const blip = Summary.summarize(mk(60, (i) => ({ calm: i === 10 ? 0.95 : 0.2 })));
  assert.strictEqual(blip.settlingTimeSec, null, 'one isolated high sample must not count as settling');

  const real = Summary.summarize(mk(60, (i) => ({ calm: i >= 30 ? 0.8 : 0.2 })));
  assert.strictEqual(real.settlingTimeSec, 32, 'settle should be recorded once 3 consecutive samples clear the bar');
  console.log('✓ settling time requires a sustained settle, not a single blip');
}

// 4) settledFraction reflects time above threshold.
{
  const s = Summary.summarize(mk(100, (i) => ({ calm: i < 25 ? 0.9 : 0.1 })));
  assert.ok(Math.abs(s.settledFraction - 0.25) < 1e-9, `expected 0.25, got ${s.settledFraction}`);
  console.log('✓ settledFraction measures time above the settled threshold');
}

// 5) Per-channel stats separate "alpha-dominant" from "unusable". A channel
//    that was mostly noisy must not be reported as a finding.
{
  const s = Summary.summarize(mk(100, (i) => ({
    levels: [0.9, 0.1, i < 50 ? 0.9 : 0.1, null], // ch3 always missing
  })));
  assert.ok(Math.abs(s.perChannel[0].alphaFraction - 1) < 1e-9, 'ch0 always alpha-dominant');
  assert.ok(Math.abs(s.perChannel[1].alphaFraction - 0) < 1e-9, 'ch1 never alpha-dominant');
  assert.ok(Math.abs(s.perChannel[2].alphaFraction - 0.5) < 1e-9, 'ch2 half the time');
  assert.strictEqual(s.perChannel[3].alphaFraction, null, 'a fully-missing channel reports null, not 0');
  assert.ok(Math.abs(s.perChannel[3].missingFraction - 1) < 1e-9, 'and reports that it was entirely missing');
  assert.ok(Math.abs(s.perChannel[0].usableFraction - 1) < 1e-9);
  console.log('✓ per-channel stats distinguish alpha-dominance from unusable signal');
}

// 6) downsample: fixed output length, preserves shape and value range, and
//    never fabricates values outside the input range.
{
  assert.deepStrictEqual(Summary.downsample([], 10), [], 'empty input -> empty output');
  assert.deepStrictEqual(Summary.downsample([1, 2, 3], 10), [1, 2, 3], 'shorter than target is returned as-is');
  const ramp = Array.from({ length: 1000 }, (_, i) => i / 999);
  const d = Summary.downsample(ramp, 50);
  assert.strictEqual(d.length, 50, 'should hit the requested length exactly');
  assert.ok(d[0] < d[25] && d[25] < d[49], 'monotonic input should stay monotonic');
  assert.ok(Math.min(...d) >= 0 && Math.max(...d) <= 1, 'must not fabricate out-of-range values');
  const s = Summary.summarize(ramp.map((c, i) => ({ t: i, calm: c })), { tracepoints: 40 });
  assert.strictEqual(s.trace.length, 40, 'tracepoints option should be honoured');
  console.log('✓ downsample produces a fixed-length, shape-preserving, in-range trace');
}

// 7) describe(): non-evaluative language, and explicitly normalises a sit that
//    never settled rather than framing it as a failure (a ROADMAP commitment).
{
  const never = Summary.describe(Summary.summarize(mk(60, () => ({ calm: 0.15 }))));
  const joined = never.join(' ');
  assert.ok(/normal sit/i.test(joined), `a sit that never settled should be normalised, got: ${joined}`);
  assert.ok(!/fail|bad|poor|worse|score/i.test(joined.replace(/failed/i, 'x')), 'must not grade or judge the sit');

  const noisy = Summary.describe(Summary.summarize(mk(60, () => ({ calm: 0.5, noise: 0.8 }))));
  assert.ok(/nois/i.test(noisy.join(' ')), 'a very noisy sit should say so, so the numbers are read loosely');

  // This assertion used to require the text to say "returning is the practice".
  // That claim was false, so the test was pinning a lie in place. The spike count
  // is band-power volatility — a real 9-minute session produced 389 of them,
  // about one every 1.4 seconds, which no one's attention does. It must NOT be
  // described as a count of times the person came back.
  const spiky = Summary.describe(Summary.summarize(mk(60, (i) => ({ calm: 0.5, spikes: i < 5 ? 1 : 0 }))));
  const spikyText = spiky.join(' ');
  assert.ok(/signal shifted/i.test(spikyText), `must name what it measures, got: ${spikyText}`);
  assert.ok(!/returning is the practice/i.test(spikyText),
    'must not claim electrical restlessness is a count of returns');
  assert.ok(/not a count of times you came back/i.test(spikyText),
    'must say explicitly what it is not');
  console.log('✓ describe() stays non-evaluative and normalises difficult sits');
}

// 7b) A session whose forehead signal was mostly unusable must be labelled as
//     such, prominently. A real session came back with 3-11% usable signal and
//     the report still printed an average, a range, a first/last-third
//     comparison and a sparkline, all with the confidence of a clean sit.
{
  const unusable = Summary.summarize(mk(120, (i) => ({
    calm: 0.5, noise: 0.9,
    // Forehead pair (indices 1 and 2) almost entirely missing.
    levels: [0.5, i % 20 === 0 ? 0.5 : null, i % 20 === 0 ? 0.5 : null, 0.5],
  })));
  assert.ok(unusable.usableAvg < 0.15, `usableAvg should reflect the forehead pair (got ${unusable.usableAvg})`);
  const text = Summary.describe(unusable).join(' ');
  assert.ok(/not measurements of anything/i.test(text), `must refuse to present it as data, got: ${text}`);

  const md = Summary.toMarkdown(unusable, { dateISO: '2026-01-01T00:00:00Z' });
  assert.ok(/Not usable/.test(md), 'the markdown report needs a banner, not just a footnote');
  // The banner must come BEFORE the numbers table, or it is a footnote again.
  assert.ok(md.indexOf('Not usable') < md.indexOf('| Measure | Value |'),
    'the warning must precede the table it applies to');

  // And a clean session must NOT get the banner — a warning that always fires
  // is a warning nobody reads.
  const clean = Summary.summarize(mk(120, () => ({ calm: 0.5, levels: [0.5, 0.5, 0.5, 0.5] })));
  assert.ok(clean.usableAvg > 0.9, 'a clean session should report high usable signal');
  assert.ok(!/Not usable/.test(Summary.toMarkdown(clean, { dateISO: '2026-01-01T00:00:00Z' })),
    'a clean session must not be labelled unusable');
  console.log('✓ an unusable-signal session is labelled as such, before its own numbers');
}

// 7c) The heart section appears only when a strap was actually connected, and
//     labels itself unreliable when the beats were mostly rejected.
{
  const st = Summary.summarize(mk(120, () => ({ calm: 0.5 })));
  const none = Summary.toMarkdown(st, { dateISO: 'x' });
  assert.ok(!/Heart \(chest strap\)/.test(none),
    'with no strap the section must be ABSENT, not zeroed — the report must never imply it measured something it had no sensor for');

  const good = Summary.toMarkdown(st, { dateISO: 'x', heart: {
    hrBpm: 58, rmssdMs: 42.3, steadiness: 0.81, breathSec: 5.2, rejectRate: 0.02, contact: true, beats: 118 } });
  assert.ok(/Heart \(chest strap\)/.test(good), 'a connected strap should get a section');
  assert.ok(/58 bpm/.test(good) && /42 ms/.test(good), 'the figures should be there');
  assert.ok(!/unreliable/i.test(good), 'clean strap data must not be flagged');
  assert.ok(/also rises with slow breathing/.test(good),
    'the caveat that RMSSD can be moved deliberately must travel with the numbers');

  const bad = Summary.toMarkdown(st, { dateISO: 'x', heart: {
    hrBpm: 58, rmssdMs: 180, steadiness: 0.2, breathSec: null, rejectRate: 0.62, contact: true, beats: 40 } });
  assert.ok(/Strap data unreliable/.test(bad), 'a high reject rate must be called out');

  const lost = Summary.toMarkdown(st, { dateISO: 'x', heart: {
    hrBpm: 58, rmssdMs: 40, steadiness: 0.6, breathSec: 5, rejectRate: 0.05, contact: false, beats: 100 } });
  assert.ok(/Skin contact was lost/.test(lost), 'lost skin contact must be called out');
  console.log('\u2713 the heart section is absent without a strap and self-flags when unreliable');
}

// 8) sparkline: fixed alphabet, one char per value, monotonic, range-safe.
{
  assert.strictEqual(Summary.sparkline([]), '');
  const s = Summary.sparkline([0, 0.5, 1]);
  assert.strictEqual(s.length, 3, 'one character per value');
  assert.strictEqual(s[0], '▁', 'lowest value should be the shortest block');
  assert.strictEqual(s[2], '█', 'highest value should be the tallest block');
  // Out-of-range input must clamp, not index off the end of the alphabet.
  assert.strictEqual(Summary.sparkline([-9, 42]), '▁█', 'out-of-range values must clamp');
  console.log('✓ sparkline renders in-range, one character per sample');
}

// 9) toMarkdown: valid markdown, includes the honesty caveats, and never
//    fabricates content when there is nothing to report.
{
  const empty = Summary.toMarkdown(null);
  assert.ok(/^# /.test(empty), 'should still be a markdown document');
  assert.ok(/not enough signal/i.test(empty), 'should say plainly that there is nothing to report');

  const stats = Summary.summarize(mk(300, (i) => ({
    calm: i < 100 ? 0.25 : 0.72, noise: 0.1, levels: [0.8, 0.6, 0.4, null], spikes: i === 150 ? 1 : 0,
  })));
  const md = Summary.toMarkdown(stats, {
    selfRating: 4,
    cueLog: [{ tSec: 130, text: 'Settling in now.' }],
    dateISO: '2026-07-25',
    visualMode: 'Eclipse',
    breathPattern: 'Box 4·4·4·4',
  });

  assert.ok(md.includes('# Meditation session'), 'needs a title');
  assert.ok(md.includes('2026-07-25') && md.includes('Eclipse') && md.includes('Box 4·4·4·4'), 'should record the session context');
  assert.ok(md.includes('| Measure | Value |'), 'should contain the numbers table');
  assert.ok(md.includes('4/5'), 'should record the self-rating');
  assert.ok(md.includes('Settling in now.'), 'should include cues that were shown');
  assert.ok(/relative to you/i.test(md), 'MUST carry the within-person caveat — the file outlives its context');
  assert.ok(/not a measure of/i.test(md), 'MUST state what calm is not');
  assert.ok(/choppy sit is a normal sit/i.test(md), 'MUST normalise a difficult sit');
  assert.ok(md.includes('no usable signal'), 'a dead channel should be reported as such, not as 0%');

  // Balanced markdown table rows: every table line has consistent pipe counts.
  const tableLines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  assert.ok(tableLines.length >= 8, 'expected at least two tables worth of rows');
  const widths = new Set(tableLines.map((l) => l.split('|').length));
  assert.ok(widths.size <= 2, `table rows should be consistently shaped (got widths ${[...widths]})`);
  console.log('✓ toMarkdown produces a valid, self-contained report with its caveats intact');
}

console.log('\nAll summary tests passed.');
