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
      // How much of the sit produced usable signal AT THE FOREHEAD PAIR, which
      // is where every composite actually comes from. The ear channels sit near
      // the jaw and are routinely unusable, so averaging all four understates
      // how bad a genuinely bad session was and overstates a good one.
      //
      // This exists because a real session came back with 3-11% usable signal on
      // every channel and the report still printed an average calm, a range, a
      // first-third/last-third comparison and a full sparkline, all with the same
      // confidence as a clean sit. One "read it loosely" bullet does not undo
      // four tables that look like measurements.
      usableAvg: (perChannel[1].usableFraction + perChannel[2].usableFraction) / 2,
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

    // This used to read "N times your attention shifted sharply and came back.
    // That returning is the practice." It was removed, because it was not true.
    //
    // The count is band-power volatility: how often a channel's alpha/beta
    // balance moved more than a threshold away from its own 3-second baseline.
    // In a real 9-minute sit it came out at 389 — roughly one every 1.4 seconds —
    // which no one's attention does. The number was measuring EEG restlessness
    // and being reported as a spiritual accomplishment, which is worse than a
    // neutral wrong number because it flatters. Now it is named for what it
    // measures, and only mentioned at all as a rate, so an implausible value is
    // obvious rather than encouraging.
    if (s.spikeTotal > 0 && s.durationSec > 0) {
      const perMin = s.spikeTotal / (s.durationSec / 60);
      lines.push(`The signal shifted sharply about ${perMin.toFixed(1)} times a minute. `
        + `This is electrical restlessness, not a count of times you came back — `
        + `we don't yet have a validated way to detect that.`);
    }

    if (s.noiseAvg > 0.35) {
      lines.push('A lot of this sit was electrically noisy (movement, jaw, or a loose headband), so read it loosely.');
    }
    if (s.usableAvg != null && s.usableAvg < 0.25) {
      lines.push(`Only about ${Math.round(s.usableAvg * 100)}% of the signal was usable, so the numbers `
        + `below are not measurements of anything. Check the headband fit and sit again.`);
    }
    return lines;
  }

  // A downloadable record of the sit. Deliberately markdown: readable as-is,
  // keeps its meaning without the app, and easy to paste into a journal.
  // Includes the honesty caveats inline, because a file outlives the session
  // and will eventually be read without any of this conversation's context.
  function toMarkdown(stats, { selfRating = null, cueLog = [], dateISO = null, visualMode = null, breathPattern = null, markers = [], samples = [], markerContext = null, practice = null, heart = null } = {}) {
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
    if (practice) L.push(`**Practice:** ${practice}`);
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
    // A banner, not a footnote. When the forehead pair was mostly unusable there
    // is no signal for any of this to be derived from, and a table that looks
    // identical to a clean session's is a false claim regardless of what a
    // caveat further down says.
    if (stats.usableAvg != null && stats.usableAvg < 0.25) {
      L.push(`> **Not usable.** Only ${pct(stats.usableAvg)} of the forehead signal was readable this`);
      L.push('> session, so the figures below describe noise, not your mind. They are kept only');
      L.push('> so the session is not silently missing from your records.');
      L.push('');
    }
    L.push('| Measure | Value |');
    L.push('| --- | --- |');
    L.push(`| Average calm | ${pct(stats.calmAvg)} |`);
    L.push(`| Range | ${pct(stats.calmMin)} – ${pct(stats.calmMax)} |`);
    L.push(`| First third → last third | ${pct(stats.firstThirdCalm)} → ${pct(stats.lastThirdCalm)} |`);
    L.push(`| Time settled | ${pct(stats.settledFraction)} |`);
    L.push(`| Time to first settle | ${stats.settlingTimeSec == null ? 'did not sustain one' : Math.round(stats.settlingTimeSec) + 's'} |`);
    L.push(`| Signal shifts (per min) | ${(stats.spikeTotal / Math.max(1, stats.durationSec / 60)).toFixed(1)} |`);
    L.push(`| Signal noise (movement) | ${pct(stats.noiseAvg)} |`);
    L.push(`| Usable forehead signal | ${pct(stats.usableAvg)} |`);
    L.push('');

    // Heart section, only when a strap was actually connected. Absent rather
    // than zeroed when there was none — the report should never imply it
    // measured something it had no sensor for.
    if (heart) {
      L.push('## Heart (chest strap)');
      L.push('');
      L.push('| Measure | Value |');
      L.push('| --- | --- |');
      L.push(`| Heart rate | ${heart.hrBpm == null ? '—' : heart.hrBpm + ' bpm'} |`);
      L.push(`| HRV (RMSSD) | ${heart.rmssdMs == null ? '—' : Math.round(heart.rmssdMs) + ' ms'} |`);
      L.push(`| HRV steadiness | ${heart.steadiness == null ? '—' : Math.round(heart.steadiness * 100) + '%'} |`);
      L.push(`| Breathing (from RSA) | ${heart.breathSec == null ? '—' : (60 / heart.breathSec).toFixed(1) + '/min'} |`);
      L.push(`| Beats used | ${heart.beats == null ? '—' : heart.beats} |`);
      L.push(`| Beats rejected | ${heart.rejectRate == null ? '—' : Math.round(heart.rejectRate * 100) + '%'} |`);
      L.push('');
      if (heart.rejectRate != null && heart.rejectRate > 0.3) {
        L.push(`> **Strap data unreliable.** ${Math.round(heart.rejectRate * 100)}% of beats were rejected as`);
        L.push('> implausible, so the HRV figures above describe artefact rather than physiology.');
        L.push('> Wet the electrode strip and make sure it is snug below the chest muscles.');
        L.push('');
      } else if (heart.contact === false) {
        L.push('> **Skin contact was lost** during this session, so read the heart figures loosely.');
        L.push('');
      }
      L.push('RMSSD is a standard measurement and the strap is ECG-grade, so the numbers');
      L.push('themselves are solid. What they *mean* is the interpretive part: higher RMSSD');
      L.push('indicates parasympathetic (rest) activation, which correlates with calm — but it');
      L.push('also rises with slow breathing regardless of mental state, so it can be moved');
      L.push('deliberately without settling at all. Steadiness, not level, is what feeds');
      L.push('"equanimity", and that remains an exploratory guess rather than a measurement.');
      L.push('');
    }

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

    if (markers && markers.length) {
      L.push('## Marked moments');
      L.push('');
      L.push('Moments flagged during the sit, with what the metrics were doing in the');
      L.push('window before versus after each mark. Note that people mark a beat LATE —');
      L.push('you notice, then you press — so the interesting signal is often in the');
      L.push('"before" column. No causal claim is made either way.');
      L.push('');
      for (const m of markers) {
        const mm = Math.floor(m.tSec / 60), ss = Math.round(m.tSec % 60);
        const stamp = `${mm}:${String(ss).padStart(2, '0')}`;
        const kind = m.kind && m.kind !== 'note' ? ` _(${m.kind})_` : '';
        const dur = m.durationSec ? ` — lasted ~${Math.round(m.durationSec)}s` : '';
        L.push(`### \`${stamp}\`${kind} ${m.note ? m.note : '_no note_'}${dur}`);
        L.push('');
        const ctx = markerContext ? markerContext(m) : null;
        if (!ctx) {
          L.push('_No surrounding data captured for this mark._');
          L.push('');
          continue;
        }
        L.push(`| Metric | ${ctx.windowSec}s before | ${ctx.windowSec}s after | change |`);
        L.push('| --- | --- | --- | --- |');
        for (const [k, f] of Object.entries(ctx.fields)) {
          const fmt = (v) => (v == null ? '—' : Math.round(v * 100));
          const d = f.delta == null ? '—' : (f.delta >= 0 ? '+' : '') + Math.round(f.delta * 100);
          L.push(`| ${k} | ${fmt(f.before)} | ${fmt(f.after)} | ${d} |`);
        }
        L.push('');
      }
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
    if (markers && markers.length) {
      L.push('### Why the marked moments matter');
      L.push('');
      L.push('The interpretive scores in this app (calm, thinking, focus) are hand-built');
      L.push('proxies that have never been validated against ground truth. Marked moments');
      L.push('are the raw material for fixing that: a human saying what actually happened,');
      L.push('lined up against what the algorithm claimed at that same moment. Enough of');
      L.push('these, across enough sits, is what would let the scores be checked, corrected,');
      L.push('or thrown out — which is not something more code can do on its own.');
      L.push('');
    }
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
