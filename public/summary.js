/*
 * Session summary statistics — pure functions, no DOM, so the arithmetic is
 * unit-testable. Same discipline as dsp.js / chart.js / viz-core.js.
 *
 * Design constraint carried from ROADMAP.md: a summary compares a person only
 * to THEIR OWN session. There is no score, no grade, and nothing that would
 * let two people compare numbers. It reports the shape of the sit.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Summary = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  const SETTLED_THRESHOLD = 0.6; // calm at/above this counts as "settled"

  // samples: [{ t (seconds from session start), calm 0..1, noise 0..1,
  //             levels: [4 x 0..1 | null], spikes: number }]
  function summarize(samples, { settledThreshold = SETTLED_THRESHOLD, tracepoints = 60 } = {}) {
    const clean = (samples || []).filter((s) => s && typeof s.calm === 'number' && !Number.isNaN(s.calm));
    if (!clean.length) return null;

    const calms = clean.map((s) => s.calm);
    const durationSec = Math.max(0, clean[clean.length - 1].t - clean[0].t);

    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    // Time settled, as a fraction of the sit.
    const settledCount = calms.filter((c) => c >= settledThreshold).length;

    // Settling time: how long until the first sustained settle. Requires a few
    // consecutive samples above threshold so a single blip doesn't count.
    let settlingTimeSec = null;
    let run = 0;
    for (const s of clean) {
      if (s.calm >= settledThreshold) {
        run++;
        if (run >= 3) { settlingTimeSec = Math.max(0, s.t - clean[0].t); break; }
      } else run = 0;
    }

    // Per-channel: how much of the sit each electrode read alpha-dominant, and
    // how much of it was unusable. Reported separately because a channel that
    // was mostly noisy should not be read as a finding.
    const channelCount = 4;
    const perChannel = [];
    for (let ch = 0; ch < channelCount; ch++) {
      let alphaCount = 0, usable = 0, missing = 0;
      for (const s of clean) {
        const v = s.levels && s.levels[ch];
        if (v == null || Number.isNaN(v)) { missing++; continue; }
        usable++;
        if (v > 0.5) alphaCount++;
      }
      perChannel.push({
        alphaFraction: usable ? alphaCount / usable : null,
        usableFraction: clean.length ? usable / clean.length : 0,
        missingFraction: clean.length ? missing / clean.length : 0,
      });
    }

    // First vs last third — a plain, honest way to say "did this sit settle?"
    // without inventing a trend line the data can't support.
    const third = Math.max(1, Math.floor(clean.length / 3));
    const firstThird = avg(calms.slice(0, third));
    const lastThird = avg(calms.slice(-third));

    return {
      durationSec,
      sampleCount: clean.length,
      calmAvg: avg(calms),
      calmMin: Math.min(...calms),
      calmMax: Math.max(...calms),
      firstThirdCalm: firstThird,
      lastThirdCalm: lastThird,
      settledFraction: settledCount / clean.length,
      settlingTimeSec,
      noiseAvg: avg(clean.map((s) => (typeof s.noise === 'number' ? s.noise : 0))),
      spikeTotal: clean.reduce((sum, s) => sum + (s.spikes || 0), 0),
      perChannel,
      trace: downsample(calms, tracepoints),
    };
  }

  // Average into fixed-size buckets so a 5-minute and a 40-minute sit both
  // render as the same-width sparkline.
  function downsample(values, n) {
    if (!values.length) return [];
    if (values.length <= n) return values.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.floor((i * values.length) / n);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * values.length) / n));
      const slice = values.slice(lo, hi);
      out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return out;
  }

  // Plain-language description of the sit. Deliberately non-evaluative: it
  // describes what happened, it does not grade it. A choppy sit is a normal
  // sit — ROADMAP.md commits to normalising that rather than penalising it.
  function describe(s) {
    if (!s) return [];
    const lines = [];
    const mins = Math.floor(s.durationSec / 60), secs = Math.round(s.durationSec % 60);
    lines.push(`You sat for ${mins}m ${String(secs).padStart(2, '0')}s.`);

    if (s.settlingTimeSec != null) {
      lines.push(`You first settled about ${Math.round(s.settlingTimeSec / 60 * 10) / 10} minutes in.`);
    } else {
      lines.push('You didn’t hit a sustained settle this time — that’s a normal sit, not a failed one.');
    }

    const pct = Math.round(s.settledFraction * 100);
    lines.push(`About ${pct}% of the sit read as settled.`);

    const delta = s.lastThirdCalm - s.firstThirdCalm;
    if (Math.abs(delta) < 0.05) lines.push('You stayed roughly level from start to finish.');
    else if (delta > 0) lines.push('The second half was calmer than the first.');
    else lines.push('The first half was calmer than the second — sits often go that way.');

    if (s.spikeTotal > 0) {
      lines.push(`${s.spikeTotal} time${s.spikeTotal === 1 ? '' : 's'} your attention shifted sharply and came back. That returning is the practice.`);
    }

    if (s.noiseAvg > 0.35) {
      lines.push('A lot of this sit was electrically noisy (movement, jaw, or a loose headband), so read it loosely.');
    }
    return lines;
  }

  // A downloadable record of the sit. Deliberately markdown: readable as-is,
  // keeps its meaning without the app, and easy to paste into a journal.
  // Includes the honesty caveats inline, because a file outlives the session
  // and will eventually be read without any of this conversation's context.
  function toMarkdown(stats, { selfRating = null, cueLog = [], dateISO = null, visualMode = null, breathPattern = null } = {}) {
    if (!stats) return '# Meditation session\n\nNot enough signal was recorded to summarise this sit.\n';
    const mins = Math.floor(stats.durationSec / 60);
    const secs = Math.round(stats.durationSec % 60);
    const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
    const L = [];

    L.push('# Meditation session');
    L.push('');
    if (dateISO) L.push(`**When:** ${dateISO}`);
    L.push(`**Length:** ${mins}m ${String(secs).padStart(2, '0')}s`);
    if (visualMode) L.push(`**Visual:** ${visualMode}`);
    if (breathPattern) L.push(`**Breathing:** ${breathPattern}`);
    L.push('');

    L.push('## In plain language');
    L.push('');
    for (const line of describe(stats)) L.push(`- ${line}`);
    L.push('');

    if (selfRating) {
      L.push('## Your own sense of it');
      L.push('');
      L.push(`You rated the sit **${selfRating}/5** before seeing any numbers.`);
      L.push('');
      L.push('Over time, the interesting thing is not the score — it is how closely your');
      L.push('own read matches the trace. That calibration is the skill worth building,');
      L.push('and it is what eventually lets you put the device down.');
      L.push('');
    }

    L.push('## Numbers');
    L.push('');
    L.push('| Measure | Value |');
    L.push('| --- | --- |');
    L.push(`| Average calm | ${pct(stats.calmAvg)} |`);
    L.push(`| Range | ${pct(stats.calmMin)} – ${pct(stats.calmMax)} |`);
    L.push(`| First third → last third | ${pct(stats.firstThirdCalm)} → ${pct(stats.lastThirdCalm)} |`);
    L.push(`| Time settled | ${pct(stats.settledFraction)} |`);
    L.push(`| Time to first settle | ${stats.settlingTimeSec == null ? 'did not sustain one' : Math.round(stats.settlingTimeSec) + 's'} |`);
    L.push(`| Sharp returns | ${stats.spikeTotal} |`);
    L.push(`| Signal noise (movement) | ${pct(stats.noiseAvg)} |`);
    L.push('');

    L.push('## Per sensor');
    L.push('');
    L.push('| Sensor | Alpha-dominant | Usable signal |');
    L.push('| --- | --- | --- |');
    const names = ['TP9 (left ear)', 'AF7 (left forehead)', 'AF8 (right forehead)', 'TP10 (right ear)'];
    stats.perChannel.forEach((c, i) => {
      L.push(`| ${names[i]} | ${c.alphaFraction == null ? 'no usable signal' : pct(c.alphaFraction)} | ${pct(c.usableFraction)} |`);
    });
    L.push('');

    if (cueLog && cueLog.length) {
      L.push('## Cues you saw');
      L.push('');
      for (const c of cueLog) {
        const m = Math.floor(c.tSec / 60), s = Math.round(c.tSec % 60);
        L.push(`- \`${m}:${String(s).padStart(2, '0')}\` ${c.text}`);
      }
      L.push('');
    }

    L.push('## Calm over the sit');
    L.push('');
    L.push('Earliest on the left, latest on the right. Each character is one slice of the');
    L.push('sit; taller blocks are calmer.');
    L.push('');
    L.push('```');
    L.push(sparkline(stats.trace));
    L.push('```');
    L.push('');

    L.push('---');
    L.push('');
    L.push('### How to read this');
    L.push('');
    L.push('- These numbers are **relative to you, in this session only**. They are');
    L.push('  normalised against your own running baseline, so they cannot be compared');
    L.push('  with anyone else\'s, or meaningfully with your own from a different day.');
    L.push('- "Calm" is a composite of alpha-vs-beta balance at the two forehead');
    L.push('  sensors. It is a reasonable proxy for relaxed alertness, not a measure of');
    L.push('  meditation quality, depth, or attainment.');
    L.push('- Consumer 4-sensor EEG is noisy. Movement, jaw tension, and headband fit');
    L.push('  all affect it. Where "signal noise" is high, read everything loosely.');
    L.push('- A choppy sit is a normal sit. Nothing here is a grade.');
    L.push('');
    return L.join('\n');
  }

  // Tiny unicode bar chart — survives being pasted anywhere plain text goes.
  function sparkline(values) {
    if (!values || !values.length) return '';
    const blocks = '▁▂▃▄▅▆▇█';
    return values.map((v) => {
      const i = Math.max(0, Math.min(blocks.length - 1, Math.round(Math.max(0, Math.min(1, v)) * (blocks.length - 1))));
      return blocks[i];
    }).join('');
  }

  return { summarize, describe, downsample, toMarkdown, sparkline, SETTLED_THRESHOLD };
});
