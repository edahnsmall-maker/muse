/* How big must an effect be before this pipeline can see it?
   Plant a known correlation between one feature and the label, vary effect size,
   number of sits, and number of competing features. Report detection rate. */
const A = require(require('path').join(__dirname, '..', 'public', 'analysis.js'));

function rng(seed){let x=seed;return()=>{x=(x*1103515245+12345)&0x7fffffff;return x/0x7fffffff;};}
function gauss(r){return Math.sqrt(-2*Math.log(r()+1e-12))*Math.cos(2*Math.PI*r());}

// units: `sits` sessions x `marksPer` marks, half marked / half control.
// One feature carries the effect; `nFeat`-1 are pure noise.
function trial({sits, marksPer, effect, nFeat, seed}) {
  const r = rng(seed);
  const units = [];
  for (let s = 0; s < sits; s++) {
    for (let i = 0; i < marksPer * 2; i++) {
      const isMark = i % 2 === 0;
      const features = { signal: effect * (isMark ? 1 : -1) + gauss(r) };
      for (let f = 1; f < nFeat; f++) features['n' + f] = gauss(r);
      units.push({ sessionId: 'S' + s, features, labels: { 'is:x': isMark ? 1 : 0 } });
    }
  }
  const res = A.search(units, { iterations: 400, seed: seed + 1 });
  return {
    found: res.confirmed.some((c) => c.feature === 'signal'),
    falsePos: res.confirmed.filter((c) => c.feature !== 'signal').length,
    comparisons: res.comparisons,
    n: units.length,
  };
}

const REPS = 8;
console.log('effect = mean shift in SD units between marked and control windows');
console.log('detected = survived FDR AND held direction on held-out sits\n');
for (const nFeat of [20, 100]) {
  console.log(`--- ${nFeat} features in the search ---`);
  console.log('sits x marks   n    effect 0.3  0.5  0.8  1.0   (detection rate over ' + REPS + ' runs)');
  for (const [sits, marksPer] of [[6, 8], [12, 8], [30, 8]]) {
    const cells = [];
    let nn = 0, cmp = 0;
    for (const effect of [0.3, 0.5, 0.8, 1.0]) {
      let hits = 0;
      for (let k = 0; k < REPS; k++) {
        const t = trial({ sits, marksPer, effect, nFeat, seed: 1000 + k * 97 + effect * 13 });
        if (t.found) hits++;
        nn = t.n; cmp = t.comparisons;
      }
      cells.push((hits / REPS).toFixed(2));
    }
    console.log(`${String(sits).padStart(2)} x ${marksPer}      ${String(nn).padStart(4)}  ${cells.map(c=>c.padStart(9)).join('')}   (${cmp} comparisons)`);
  }
  console.log('');
}
