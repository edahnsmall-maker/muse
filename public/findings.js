/*
 * Turning statistics into sentences — and into a handoff file that cannot be
 * over-read.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The person who will read this output is a meditation teacher, not a statistician,
 * and a table of rank correlations is useless to them. Worse than useless: it invites
 * reading the largest number as the answer, which is precisely the mistake the
 * analysis layer was built to prevent. So the finding has to arrive as a sentence.
 *
 * THE DANGER IN DOING THIS. Plain language makes a weak result sound strong. "Your
 * HRV rises when you are absorbed" reads as a fact; "rho = 0.31, q = 0.08, n = 34, held
 * out on 3 sessions" reads as what it is. Generating the first from the second is
 * therefore a translation with a thumb on the scale unless the caveats travel with it,
 * every time, in the same sentence rather than in a footnote.
 *
 * So two rules here, and they are not negotiable:
 *
 *   1. NO FINDING WITHOUT ITS EXPOSURE. Every sentence carries the number of
 *      observations, the number of comparisons the search made, and whether it held on
 *      data it was not fitted on. A finding stripped of those is not a finding.
 *   2. THE HANDOFF FILE CARRIES ITS OWN GUARDRAILS. Handing a table to an AI and
 *      asking what it means produces confident over-interpretation, for the same
 *      reason it does in a human. The file states what the numbers cannot support and
 *      names the conclusions that would be wrong — so the reader has to work to
 *      over-claim rather than being led into it.
 *
 * A finding here is never a result. It is a candidate, and the only thing that turns a
 * candidate into a result is showing up again in sits recorded after it was found.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Findings = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /*
   * What each metric and label is, in words.
   *
   * Kept here rather than derived from the keys, because "hrv~focus" means nothing to
   * a reader and "heart-rate variability against how one-pointed you said you were"
   * means something. Where a metric's own validity is doubtful that is said here too —
   * a correlation with an unvalidated score is a correlation with an unvalidated
   * score, however good its p-value.
   */
  const TERMS = {
    calm: { name: 'the Calm score', caveat: 'itself unvalidated, and built mostly on alpha power' },
    thinking: { name: 'the Thinking score', caveat: 'unvalidated, and may track band-power volatility rather than thought' },
    focus: { name: 'the Focus score', caveat: 'unvalidated' },
    drowsy: { name: 'the Drowsy score', caveat: 'unvalidated' },
    equanimity: { name: 'the Equanimity score', caveat: 'unvalidated, and speculative even by this project’s standards' },
    hrv: { name: 'heart-rate variability (RMSSD)', caveat: 'a real physiological measure, well established' },
    breath: { name: 'breathing', caveat: 'from chest motion when the strap is worn, else inferred from beat timing' },
    noise: { name: 'the artifact rate', caveat: 'a signal-quality measure — a correlation here may mean movement, not mind' },
    probeLatency: { name: 'how long you took to answer the probe', caveat: 'behaviour, not self-report' },
  };

  const LABELS = {
    focus: { name: 'how one-pointed you said you were', high: 'one-pointed', low: 'scattered' },
    effort: { name: 'how much effort you reported', high: 'straining', low: 'effortless' },
    pull: { name: 'how much thoughts grabbed you', high: 'swept along', low: 'thoughts passed through' },
    tone: { name: 'the emotional tone you reported', high: 'pleasant', low: 'difficult' },
    condition: { name: 'which trial block you were in', high: 'the second condition', low: 'the first' },
    onTask: { name: 'whether attention was on the object at the probe', high: 'on the object', low: 'off it' },
    aware: { name: 'whether you knew where attention was', high: 'you knew', low: 'you did not' },
  };

  /*
   * SIGNATURE KINDS, in words.
   *
   * The search no longer only compares averages — see analysis.js windowFeatures. A
   * feature key is now `<series>.<kind>`, `<a>+<b>.pair` or `<a>+<b>+<c>.trio`, and
   * without translation the sentence would read "`calm+focus.pair` was higher when…",
   * which is exactly the failure this file exists to prevent. A reader who cannot
   * decode the key cannot judge the claim, and a claim that cannot be judged gets
   * believed.
   */
  const KINDS = {
    level: (names) => `how high ${names[0]} was`,
    trend: (names) => `whether ${names[0]} was rising or falling`,
    swing: (names) => `how much ${names[0]} moved about`,
    range: (names) => `how far ${names[0]} swung, top to bottom`,
    pair: (names) => `whether ${names[0]} and ${names[1]} moved together or opposite`,
    trio: (names) => `whether ${names[0]}, ${names[1]} and ${names[2]} moved as one`,
  };

  // A bare series name, for use inside the phrases above. TERMS carries "the Calm
  // score" style names; anything unknown is quoted rather than guessed at.
  const seriesName = (k) => (TERMS[k] ? TERMS[k].name : `\`${k}\``);

  function parseFeature(key) {
    const dot = String(key).lastIndexOf('.');
    if (dot < 0) return { series: [String(key)], kind: null };
    const kind = key.slice(dot + 1);
    return { series: key.slice(0, dot).split('+'), kind: KINDS[kind] ? kind : null };
  }

  function term(k) {
    const { series, kind } = parseFeature(k);
    if (!kind) return TERMS[k] ? TERMS[k].name : `\`${k}\``;
    return KINDS[kind](series.map(seriesName));
  }

  /*
   * The caveat is the union of every series involved, because a pair feature inherits
   * the doubt attached to BOTH of its lines — and a co-movement between two
   * unvalidated scores is a co-movement between two unvalidated scores.
   */
  function caveatOf(k) {
    const { series, kind } = parseFeature(k);
    if (!kind) return TERMS[k] ? TERMS[k].caveat : null;
    return TERMS[series[0]] ? TERMS[series[0]].caveat : null;
  }

  /*
   * The whole "Note:" sentence, one clause per series involved.
   *
   * Per series rather than a merged list, because each TERMS caveat is written as a
   * singular predicate ("is unvalidated", "is a real physiological measure") and
   * joining them behind one plural subject produced "the Calm score and the Focus
   * score are itself unvalidated…; unvalidated" — broken grammar in the one sentence
   * whose entire job is to be readable.
   */
  function caveatSentence(key) {
    const { series } = parseFeature(key);
    const clauses = series
      .filter((x) => TERMS[x] && TERMS[x].caveat)
      .map((x) => `${TERMS[x].name} is ${TERMS[x].caveat}`);
    if (!clauses.length) return null;
    // Semicolons, not full stops: each clause starts lowercase ("the Calm score is…"),
    // so joining with '. ' produced sentences beginning in lower case.
    return `Note: ${clauses.join('; ')}.`;
  }

  /*
   * A binary "was this the window before a <category> mark" label, in words.
   *
   * The human name comes from Labels.TRANSITION_BY_KEY where it is available, so the
   * lab and the app cannot end up calling the same tap two different things — two
   * vocabularies for one event already went wrong once here. When Labels is not loaded
   * the raw key is quoted rather than prettified into something that might be wrong.
   */
  const Names = (typeof module !== 'undefined' && module.exports)
    ? (() => { try { return require('./labels.js'); } catch { return null; } })()
    : (typeof window !== 'undefined' ? window.Labels : null);

  function markLabelName(kind) {
    if (kind === 'any-mark') return 'any moment you marked at all';
    const t = Names && Names.TRANSITION_BY_KEY && Names.TRANSITION_BY_KEY[kind];
    return t ? `"${t.label}"` : `"${kind}"`;
  }

  function labelName(k) {
    if (LABELS[k]) return LABELS[k].name;
    const m = /^is:(.+)$/.exec(String(k));
    if (m) return `the seconds before ${markLabelName(m[1])}`;
    return `\`${k}\``;
  }

  // Is this label a marked-moment contrast rather than an ordinal rating? The sentence
  // has to be built differently: there is no "closer to one-pointed" end of a 1/0.
  const isMarkLabel = (k) => /^is:/.test(String(k));

  /*
   * Strength in words, from the held-out correlation.
   *
   * Deliberately coarse. Reporting "rho = 0.34" as "moderate" loses nothing a reader
   * of this can use, and three bands stop a 0.31 and a 0.29 being discussed as though
   * the difference meant something.
   */
  function strengthWord(rho) {
    const a = Math.abs(rho == null ? 0 : rho);
    if (a >= 0.5) return 'strong';
    if (a >= 0.3) return 'moderate';
    return 'weak';
  }

  /*
   * One finding, as prose.
   *
   * The direction is stated in the reader's terms — "higher when you reported being
   * one-pointed" — rather than as the sign of a coefficient, because a sign is a thing
   * to be decoded and a sentence is not.
   */
  function describe(test, { units, comparisons, trainSessions, testSessions }) {
    const dir = (test.testRho || test.trainRho) > 0 ? 'higher' : 'lower';
    const lab = LABELS[test.label];
    const end = lab ? (dir === 'higher' ? lab.high : lab.low) : 'that label';
    const strength = strengthWord(test.testRho);
    const caveat = caveatOf(test.feature);

    /*
     * A MARKED-MOMENT CONTRAST IS A DIFFERENT SENTENCE. Its label is 1/0, so there is
     * no "closer to one-pointed" end to move toward — the claim is that the windows
     * before a particular kind of mark differ from the windows that were not. Reusing
     * the ordinal phrasing would have produced "higher when you were closer to
     * 'that label'", which says nothing and looks like it says something.
     *
     * `pair` and `trio` also need the direction read as a relationship rather than as
     * a magnitude: a positive rho on a co-movement feature means the two lines moved
     * together MORE in those windows, not that some quantity was larger.
     */
    const { kind, series } = parseFeature(test.feature);
    const relational = kind === 'pair' || kind === 'trio';
    const moved = relational
      ? (dir === 'higher' ? 'more together' : 'more opposite')
      : (dir === 'higher' ? 'higher' : 'lower');
    /* A TREND IS A DIRECTION, so it reads as one. "whether the Calm score was rising
       or falling was higher" is grammatical and unreadable; the claim is that the line
       was rising, or falling, in those windows. */
    const claim = kind === 'trend'
      ? (isMarkLabel(test.label)
        ? `${seriesName(series[0])} was ${dir === 'higher' ? 'rising' : 'falling'}`
          + ` in ${labelName(test.label)}, more than in windows you did not mark.`
        : `${seriesName(series[0])} was ${dir === 'higher' ? 'rising' : 'falling'}`
          + ` when you were closer to "${end}" (${labelName(test.label)}).`)
      : isMarkLabel(test.label)
        ? (relational
          ? `${term(test.feature)}: they moved ${moved} in ${labelName(test.label)}`
            + ' than in windows you did not mark.'
          : `${term(test.feature)} was ${dir} in ${labelName(test.label)}`
            + ' than in windows you did not mark.')
        : `${term(test.feature)} was ${moved} when you were closer to "${end}"`
          + ` (${labelName(test.label)}).`;

    return {
      key: test.key,
      feature: test.feature,
      label: test.label,
      strength,
      heldUp: test.heldUp === true,
      // The headline, with its exposure attached rather than footnoted.
      sentence: `${claim}`
        + ` A ${strength} relationship, from ${units} labelled observations,`
        + ` and it held its direction on ${testSessions} session(s) it was not fitted on.`,
      // Everything needed to judge it, in one place.
      evidence: `rho ${test.trainRho == null ? '—' : test.trainRho.toFixed(2)} while fitting,`
        + ` ${test.testRho == null ? '—' : test.testRho.toFixed(2)} on held-out sits;`
        + ` p ${test.p == null ? '—' : test.p.toFixed(4)},`
        + ` corrected q ${test.q == null ? '—' : test.q.toFixed(3)};`
        + ` one of ${comparisons} comparisons; fitted on ${trainSessions} session(s).`,
      /* Names the SERIES, not the decoded phrase: "Note: whether the Calm score and the
         Focus score moved together or opposite is itself unvalidated…" restates the
         whole claim in order to say something about its ingredients. */
      caveat: caveatSentence(test.feature),
      // The actionable part. A candidate becomes a result by being predicted in
      // advance and then observed, which means a trial rather than more of the same.
      nextStep: nextStepFor(test),
    };
  }

  function nextStepFor(test) {
    if (test.label === 'condition') {
      return 'This came from a trial, where the condition was set in advance — the'
        + ' strongest kind of evidence available here. Repeat the same trial on a'
        + ' different day; if it reproduces, it is worth building on.';
    }
    if (test.feature === 'noise') {
      return 'Treat with suspicion: the artifact rate is a signal-quality measure, so'
        + ' this may be about movement rather than about mind. Check whether the'
        + ' labelled stretches were also the fidgety ones.';
    }
    const map = {
      focus: 'think-breath', effort: 'effort-contrast',
      onTask: 'think-breath', aware: 'think-breath',
    };
    const proto = map[test.label];
    return proto
      ? `Test it deliberately: run the "${proto}" trial, where the condition is decided`
        + ' in advance so the label cannot be influenced by what the screen shows. Predict'
        + ' the direction BEFORE looking at the result.'
      : 'Predict the direction in writing, then collect three or four more labelled'
        + ' sits and check whether the prediction holds.';
  }

  /*
   * The whole report: a headline, the findings in prose, and the nulls.
   *
   * NULLS ARE INCLUDED ON PURPOSE. A report listing only what was found reads as
   * though everything checked worked, which is the opposite of true and makes the
   * survivors look inevitable rather than lucky.
   */
  function report(searchResult, { label = 'labelled spans' } = {}) {
    const r = searchResult || {};
    const units = r.units || 0;
    const comparisons = r.comparisons || 0;
    const trainSessions = (r.split && r.split.train.length) || 0;
    const testSessions = (r.split && r.split.test.length) || 0;
    const confirmed = (r.confirmed || [])
      .map((t) => describe(t, { units, comparisons, trainSessions, testSessions }));

    // Things that looked promising while fitting and then failed on held-out data.
    // Worth showing, because they are what the held-out check is FOR — and because
    // seeing them fail is what makes the survivors credible.
    const collapsed = (r.tests || [])
      .filter((t) => t.passes && t.heldUp === false)
      .map((t) => ({
        key: t.key,
        sentence: `${term(t.feature)} against ${labelName(t.label)} looked promising`
          + ` while fitting (rho ${t.trainRho == null ? '—' : t.trainRho.toFixed(2)})`
          + ' and then reversed or vanished on the held-out sits. This is the check'
          + ' working, not a near miss.',
      }));

    let headline;
    if (units < 8) {
      headline = { status: 'not-enough', text: `Not enough data yet — ${units} ${label}.`
        + ` Nothing here can mean anything until there are at least a couple of`
        + ' dozen, across several different sits.' };
    } else if (!testSessions) {
      headline = { status: 'unvalidatable', text: 'Only one session, so nothing could be'
        + ' held back to check against. Record a few more sits before reading anything'
        + ' into this.' };
    } else if (!confirmed.length) {
      headline = { status: 'nothing', text: `No pattern found. ${comparisons} comparisons`
        + ` across ${units} ${label}; none survived correction and also held its`
        + ' direction on the sits it was not fitted on. With this much data that is the'
        + ' expected outcome, and it is a real answer rather than a failure.' };
    } else {
      headline = { status: 'found', text: `${confirmed.length} pattern${confirmed.length > 1 ? 's' : ''}`
        + ` worth following up, out of ${comparisons} comparisons across ${units}`
        + ` ${label}. Each survived correction for the size of the search AND kept its`
        + ' direction on sessions it was not fitted on. That makes them candidates, not'
        + ' conclusions.' };
    }

    return { headline, confirmed, collapsed, units, comparisons, trainSessions, testSessions };
  }

  /*
   * The handoff file.
   *
   * Written for a capable reader who was not present for any of this — most likely a
   * language model being asked "what does this mean". It therefore leads with what the
   * data CANNOT support, because a reader handed a table of correlations will
   * confabulate a mechanism for every one of them, and that costs more than a missed
   * insight would.
   *
   * Small on purpose: a few kilobytes of findings, never the raw signal. Two million
   * floats would be meaningless as tokens and would fill any context many times over.
   */
  function handoff(reports, { sessions = [], generatedFor = 'analysis' } = {}) {
    const L = [];
    L.push('# Meditation biofeedback — findings handoff');
    L.push('');
    L.push('## Read this first');
    L.push('');
    L.push('This file summarises an attempt to validate the scores in a hobby'
      + ' meditation-biofeedback app against a practitioner’s own moment-by-moment'
      + ' reports. It contains findings and sample sizes only — no raw signal.');
    L.push('');
    L.push('**What this data cannot support, whatever the numbers look like:**');
    L.push('');
    L.push('- **Causal claims.** Every relationship here is correlational. "Alpha rose'
      + ' because attention settled" is not something these data can distinguish from'
      + ' the reverse, or from both following something else.');
    L.push('- **Claims about people in general.** One practitioner, one headband, one'
      + ' set of electrode positions. Nothing here generalises past this person, and'
      + ' several of the scores involved are not validated measures of anything.');
    L.push('- **Clinical or diagnostic meaning.** None. A consumer dry-electrode EEG'
      + ' band over the forehead is not a clinical instrument.');
    L.push('- **Anything from a single session.** Where the report says only one session'
      + ' was available, no held-out check was possible and the "finding" may be a'
      + ' property of that one sit.');
    L.push('');
    L.push('**What would be genuinely useful from a reader:** mechanisms worth testing,'
      + ' confounds that were missed, and which of the listed candidates is most worth'
      + ' spending a deliberate trial on. Please state plainly when a finding is too'
      + ' weak to be worth interpreting — that is a useful answer, not an unhelpful one.');
    L.push('');
    L.push('**Method, briefly.** Labels are the practitioner’s own reports, either'
      + ' self-caught (marked in the moment), probe-caught (an unpredictable cue asks'
      + ' what was happening just before it), or trial conditions set in advance. Each'
      + ' labelled stretch becomes ONE observation, not one per second. Candidate'
      + ' relationships are ranked by a permutation test, corrected for the number of'
      + ' comparisons (Benjamini-Hochberg, FDR 0.1), then re-checked on sessions'
      + ' excluded from the fitting. Splits are by session, never by sample, because'
      + ' consecutive seconds within a sit are near-duplicates.');
    L.push('');

    if (sessions.length) {
      L.push('## Sessions included');
      L.push('');
      L.push('| Session | Length | Labelled spans | Transitions | Trial blocks |');
      L.push('|---|---|---|---|---|');
      for (const s of sessions) {
        L.push(`| ${s.name || s.sessionId} | ${s.minutes == null ? '—' : `${s.minutes} min`}`
          + ` | ${s.spans == null ? '—' : s.spans} | ${s.transitions == null ? '—' : s.transitions}`
          + ` | ${s.blocks == null ? '—' : s.blocks} |`);
      }
      L.push('');
    }

    for (const rep of reports) {
      L.push(`## ${rep.title || generatedFor}`);
      L.push('');
      L.push(`**${rep.report.headline.text}**`);
      L.push('');
      if (rep.report.confirmed.length) {
        L.push('### Candidates');
        L.push('');
        for (const f of rep.report.confirmed) {
          L.push(`#### ${f.feature} ~ ${f.label} (${f.strength})`);
          L.push('');
          L.push(f.sentence);
          L.push('');
          L.push(`- Evidence: ${f.evidence}`);
          if (f.caveat) L.push(`- ${f.caveat}`);
          L.push(`- Suggested next step: ${f.nextStep}`);
          L.push('');
        }
      }
      if (rep.report.collapsed.length) {
        L.push('### Failed the held-out check');
        L.push('');
        L.push('Included deliberately. A report listing only successes would make the'
          + ' survivors look inevitable rather than lucky.');
        L.push('');
        for (const c of rep.report.collapsed) L.push(`- ${c.sentence}`);
        L.push('');
      }
      if (rep.controls && rep.controls.length) {
        L.push('### Equipment control');
        L.push('');
        for (const c of rep.controls) {
          L.push(`- **${c.ok === true ? 'PASSED' : c.ok === false ? 'FAILED' : 'INCONCLUSIVE'}**`
            + ` — ${c.feature}: ${c.text}`);
        }
        L.push('');
        if (rep.controls.some((c) => c.ok === false)) {
          L.push('> **The equipment control FAILED.** Eyes-closed alpha is one of the'
            + ' most reliable findings in EEG, and this pipeline did not recover it.'
            + ' Everything else in this file should be treated as void until that is'
            + ' fixed. Please say so rather than interpreting the findings above.');
          L.push('');
        }
      }
    }

    L.push('## What happens to your answer');
    L.push('');
    L.push('Anything identified as worth pursuing gets tested with a trial where the'
      + ' condition is set in advance, and only then wired into the live app’s scores'
      + ' or visuals. So a wrong suggestion here costs a wasted trial rather than a'
      + ' false number shown to somebody as a fact about their mind.');
    L.push('');
    return L.join('\n');
  }

  return { TERMS, LABELS, strengthWord, describe, nextStepFor, report, handoff, term, labelName };
});
