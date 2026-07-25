/* In-process test: OSC encode -> parseOSC -> handle -> step. No sockets/ports. */
const assert = require('assert');
const { parseOSC, handle, step } = require('./server.js');

function oscString(s) {
  const b = Buffer.from(s + '\0');
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
}
function oscMessage(addr, floats) {
  const args = Buffer.alloc(floats.length * 4);
  floats.forEach((f, i) => args.writeFloatBE(f, i * 4));
  return Buffer.concat([oscString(addr), oscString(',' + floats.map(() => 'f').join('')), args]);
}

// 1) Parser round-trips address + 4 float args
const parsed = parseOSC(oscMessage('/muse/elements/alpha_absolute', [0.1, 0.2, 0.3, 0.4]));
assert.strictEqual(parsed[0].address, '/muse/elements/alpha_absolute');
assert.strictEqual(parsed[0].args.length, 4);
assert.ok(Math.abs(parsed[0].args[0] - 0.1) < 1e-6, 'float decode');
console.log('✓ OSC message parse');

// 2) Bundle parse (Mind Monitor sometimes bundles messages)
function oscBundle(msgs) {
  const parts = [oscString('#bundle'), Buffer.alloc(8)]; // tag + timetag
  for (const m of msgs) { const sz = Buffer.alloc(4); sz.writeInt32BE(m.length, 0); parts.push(sz, m); }
  return Buffer.concat(parts);
}
const b = parseOSC(oscBundle([
  oscMessage('/muse/elements/alpha_absolute', [0.5, 0.5, 0.5, 0.5]),
  oscMessage('/muse/elements/beta_absolute', [0.1, 0.1, 0.1, 0.1]),
]));
assert.strictEqual(b.length, 2, 'bundle yields 2 messages');
console.log('✓ OSC bundle parse');

// 3) Calm rises across a simulated calming session (alpha up, beta down)
function feed(prog) {
  const q = (v) => [v, v, v, v];
  for (const m of [
    oscMessage('/muse/elements/alpha_absolute', q(-0.2 + 0.9 * prog)),
    oscMessage('/muse/elements/beta_absolute', q(0.4 - 0.5 * prog)),
    oscMessage('/muse/elements/horseshoe', q(1)),
    oscMessage('/muse/elements/touching_forehead', [1]),
  ]) for (const p of parseOSC(m)) handle(p);
}

let first = null, lastCalm = null, sawContactOk = false;
for (let i = 0; i <= 400; i++) {           // ~400 steps = a session's worth
  feed(Math.min(1, i / 300));
  const out = step();
  if (i === 20) first = out.calm;           // after warm-up
  lastCalm = out.calm;
  if (out.contactOk) sawContactOk = true;
}
console.log(`  calm start≈${first.toFixed(2)}  end≈${lastCalm.toFixed(2)}`);
assert.ok(sawContactOk, 'contact reported OK with good horseshoe + touching');
assert.ok(lastCalm > first + 0.15, `calm should climb meaningfully (got ${first.toFixed(2)} -> ${lastCalm.toFixed(2)})`);
assert.ok(lastCalm > 0.7, `calm should be high by session end (got ${lastCalm.toFixed(2)})`);
console.log('✓ calm score tracks a calming session');

console.log('\nAll tests passed.');
