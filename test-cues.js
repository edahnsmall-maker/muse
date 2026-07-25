const assert = require('assert');
const Cues = require('./public/cues.js');

const S = (over = {}) => Object.assign(
  { tSec: 600, calm: 0.5, activity: 0.5, noise: 0, recentReturns: 0, settledStreakSec: 0 },
  over
);

// 1) Silence is the default — a middling state says nothing at all.
{
  const e = new Cues.CueEngine();
  assert.strictEqual(e.update(S()), null, 'an unremarkable state should produce no cue');
  console.log('✓ says nothing when there is nothing worth saying');
}

// 2) Nothing at all in the opening minute — let someone arrive first.
{
  const e = new Cues.CueEngine();
  assert.strictEqual(e.update(S({ tSec: 5, noise: 0.9 })), null, 'must stay quiet in the first minute');
  assert.strictEqual(e.update(S({ tSec: 59, noise: 0.9 })), null, 'still quiet at 59s');
  assert.ok(e.update(S({ tSec: 61, noise: 0.9 })), 'may speak after the first minute');
  console.log('✓ stays silent during the first minute of a sit');
}

// 3) Rate limiting: at most one cue per interval, however loud the state is.
{
  const e = new Cues.CueEngine({ minIntervalSec: 300 });
  const first = e.update(S({ tSec: 100, noise: 0.9 }));
  assert.ok(first, 'first qualifying cue should fire');
  let extra = 0;
  for (let t = 101; t < 399; t++) if (e.update(S({ tSec: t, noise: 0.9, activity: 0.9, calm: 0.1 }))) extra++;
  assert.strictEqual(extra, 0, `nothing more should fire inside the interval (got ${extra})`);
  assert.ok(e.update(S({ tSec: 401, activity: 0.9 })), 'a cue may fire once the interval has passed');
  console.log('✓ rate limits to one cue per interval no matter how eventful the state is');
}

// 4) Priority: measurement problems outrank everything, because nothing else
//    is trustworthy while the signal is swamped.
{
  const e = new Cues.CueEngine();
  const cue = e.update(S({ noise: 0.9, activity: 0.9, calm: 0.1, recentReturns: 9 }));
  assert.strictEqual(cue.key, 'noisy', `noise should win when everything is firing (got ${cue.key})`);
  console.log('✓ signal-quality cue takes priority over interpretive ones');
}

// 5) Returns are framed as the practice, and outrank the "you are thinking" cue.
{
  const e = new Cues.CueEngine();
  const cue = e.update(S({ recentReturns: 4, activity: 0.9 }));
  assert.strictEqual(cue.key, 'returns');
  assert.ok(/practice/i.test(cue.text), 'returning should be framed as the practice');
  console.log('✓ coming back is celebrated ahead of flagging the thinking');
}

// 6) No cue text scolds, evaluates, or implies failure.
{
  const banned = /\b(fail|failed|failing|bad|poor|wrong|worse|should have|distracted|lost focus|try harder)\b/i;
  for (const r of Cues.RULES) {
    assert.ok(!banned.test(r.text), `cue "${r.key}" uses discouraging language: ${r.text}`);
    assert.ok(r.text.length < 120, `cue "${r.key}" is too long to read mid-sit`);
  }
  console.log('✓ no cue scolds, grades, or implies the person is doing it wrong');
}

// 7) The same cue never repeats back-to-back; the engine goes quiet instead.
{
  const e = new Cues.CueEngine({ minIntervalSec: 10 });
  const a = e.update(S({ tSec: 100, activity: 0.9 }));
  assert.strictEqual(a.key, 'thinking');
  assert.strictEqual(e.update(S({ tSec: 200, activity: 0.9 })), null,
    'if the only applicable cue is the one just given, stay quiet rather than repeat');
  const b = e.update(S({ tSec: 300, calm: 0.2 }));
  assert.strictEqual(b.key, 'stirred', 'a different cue may still fire');
  console.log('✓ never repeats the same cue twice in a row');
}

// 8) Disabling silences it entirely, and it can be re-enabled.
{
  const e = new Cues.CueEngine({ enabled: false });
  assert.strictEqual(e.update(S({ noise: 0.99 })), null, 'disabled means completely silent');
  e.setEnabled(true);
  assert.ok(e.update(S({ noise: 0.99 })), 're-enabling should restore cues');
  console.log('✓ cues can be toggled fully off and back on');
}

// 9) Everything said is logged, for the session report.
{
  const e = new Cues.CueEngine({ minIntervalSec: 1 });
  e.update(S({ tSec: 100, noise: 0.9 }));
  e.update(S({ tSec: 200, activity: 0.9 }));
  assert.strictEqual(e.log.length, 2, 'each delivered cue should be logged once');
  assert.deepStrictEqual(e.log.map((c) => c.key), ['noisy', 'thinking']);
  assert.ok(e.log.every((c) => typeof c.tSec === 'number' && c.text), 'log entries need a time and the text');
  console.log('✓ delivered cues are logged for the session report');
}

console.log('\nAll cue tests passed.');
