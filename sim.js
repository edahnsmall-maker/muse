#!/usr/bin/env node
/*
 * Muse simulator — sends fake Mind Monitor OSC so you can test the visuals
 * without a headset. Simulates a session that starts busy and gradually calms.
 * Run the server first, then:  node sim.js
 */
const dgram = require('dgram');
const sock = dgram.createSocket('udp4');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.OSC_PORT || 5000);

function oscString(s) {
  const b = Buffer.from(s + '\0');
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([b, Buffer.alloc(pad)]);
}
function oscMessage(addr, floats) {
  const a = oscString(addr);
  const types = oscString(',' + floats.map(() => 'f').join(''));
  const args = Buffer.alloc(floats.length * 4);
  floats.forEach((f, i) => args.writeFloatBE(f, i * 4));
  return Buffer.concat([a, types, args]);
}
function send(addr, floats) {
  const buf = oscMessage(addr, floats);
  sock.send(buf, 0, buf.length, PORT, HOST);
}

let t = 0;
console.log(`Simulating a calming session -> udp://${HOST}:${PORT}  (Ctrl+C to stop)`);
setInterval(() => {
  t += 0.1;
  // slow ramp from "busy" to "calm" over ~40s, with a little jitter
  const prog = Math.min(1, t / 40);
  const jitter = () => (Math.random() - 0.5) * 0.08;
  const alpha = -0.2 + 0.9 * prog + jitter();   // alpha climbs
  const beta = 0.4 - 0.5 * prog + jitter();     // beta falls
  const theta = -0.1 + 0.4 * prog + jitter();
  const q = (v) => [v, v, v, v];
  send('/muse/elements/alpha_absolute', q(alpha));
  send('/muse/elements/beta_absolute', q(beta));
  send('/muse/elements/theta_absolute', q(theta));
  send('/muse/elements/horseshoe', [1, 1, 1, 1]);
  send('/muse/elements/touching_forehead', [1]);
}, 100);
