#!/usr/bin/env node
/*
 * Muse Zen Spike — local server
 * -----------------------------
 * Receives Muse band-power data from the Mind Monitor app over OSC/UDP,
 * turns it into a smoothed 0..1 "calm" value, and pushes that to the
 * browser over a WebSocket so the visuals can react in real time.
 *
 * Zero dependencies — Node built-ins only (dgram, http, crypto, fs).
 * Run:  node server.js       (add DEBUG=1 to print the calm value)
 */

const dgram = require('dgram');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OSC_PORT = Number(process.env.OSC_PORT || 5000);   // Mind Monitor sends here
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);  // open this in your browser

// ---------------------------------------------------------------------------
// Minimal OSC parser (enough for Mind Monitor's messages + bundles)
// ---------------------------------------------------------------------------
function readOSCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('ascii', offset, end);
  let next = (end + 1 + 3) & ~3; // skip null, pad to 4-byte boundary
  return [str, next];
}

function parsePacket(buf, start, end, out) {
  if (end - start >= 8 && buf.toString('ascii', start, start + 7) === '#bundle') {
    let pos = start + 16; // '#bundle\0' (8) + timetag (8)
    while (pos + 4 <= end) {
      const size = buf.readInt32BE(pos); pos += 4;
      if (size < 0 || pos + size > end) break;
      parsePacket(buf, pos, pos + size, out);
      pos += size;
    }
    return;
  }
  let pos = start;
  let address; [address, pos] = readOSCString(buf, pos);
  if (pos >= end) { out.push({ address, args: [] }); return; }
  let types; [types, pos] = readOSCString(buf, pos);
  const args = [];
  if (types.startsWith(',')) {
    for (let i = 1; i < types.length; i++) {
      const t = types[i];
      try {
        if (t === 'f') { args.push(buf.readFloatBE(pos)); pos += 4; }
        else if (t === 'i') { args.push(buf.readInt32BE(pos)); pos += 4; }
        else if (t === 'd') { args.push(buf.readDoubleBE(pos)); pos += 8; }
        else if (t === 's') { let s; [s, pos] = readOSCString(buf, pos); args.push(s); }
        else if (t === 'T') args.push(true);
        else if (t === 'F') args.push(false);
        else if (t === 'N') args.push(null);
        else break; // unknown type tag — stop rather than misread
      } catch (e) { break; }
    }
  }
  out.push({ address, args });
}

function parseOSC(buf) {
  const out = [];
  try { parsePacket(buf, 0, buf.length, out); } catch (e) { /* ignore malformed */ }
  return out;
}

// ---------------------------------------------------------------------------
// Muse state + calm computation
// ---------------------------------------------------------------------------
const S = {
  abs: {}, rel: {},        // band powers, averaged across channels
  horseshoe: [],           // per-channel contact quality (1 good .. 4 bad)
  touching: 1,             // touching_forehead
  blink: 0, jaw: 0,
  last: 0,                 // timestamp of last band-power message
};

const avg = (arr) => {
  const v = arr.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function handle({ address, args }) {
  const m = address.match(/^\/muse\/elements\/(delta|theta|alpha|beta|gamma)_(absolute|relative)$/);
  if (m) {
    const val = avg(args);
    if (val !== null) {
      (m[2] === 'absolute' ? S.abs : S.rel)[m[1]] = val;
      S.last = Date.now();
    }
    return;
  }
  if (address === '/muse/elements/horseshoe') S.horseshoe = args;
  else if (address === '/muse/elements/touching_forehead') S.touching = args[0];
  else if (address === '/muse/elements/blink' && args[0]) S.blink = Date.now();
  else if (address === '/muse/elements/jaw_clench' && args[0]) S.jaw = Date.now();
}

// Adaptive normalization: we don't know a person's baseline, so track a slow
// running mean/variance of the alpha/beta log-ratio and score against it.
let mu = null, varr = 0.25, calmDisp = 0.5;
const startedAt = Date.now();

// One update step. Returns the payload we broadcast to the browser.
function step() {
  const a = S.abs.alpha != null ? S.abs.alpha : S.rel.alpha;
  const b = S.abs.beta != null ? S.abs.beta : S.rel.beta;
  let ratio = null;
  if (a != null && b != null) ratio = a - b;   // log-power difference ~ log(alpha/beta)
  else if (a != null) ratio = a;                // alpha-only fallback

  const haveData = ratio != null && (Date.now() - S.last < 2000);
  let target = calmDisp;
  if (ratio != null) {
    if (mu === null) mu = ratio;
    const aStat = 0.001;                         // ~ tens of seconds of adaptation
    mu += aStat * (ratio - mu);
    varr += aStat * ((ratio - mu) * (ratio - mu) - varr);
    const z = (ratio - mu) / Math.sqrt(varr + 1e-6);
    target = 1 / (1 + Math.exp(-z * 0.9));       // logistic squash to 0..1
  }

  const front = [S.horseshoe[1], S.horseshoe[2]].filter((x) => typeof x === 'number' && !Number.isNaN(x));
  const contactOk = (S.touching !== 0) && (front.length ? Math.min(...front) <= 2 : true) && haveData;

  calmDisp += 0.05 * (target - calmDisp);        // display smoothing (~1s)

  return {
    t: Date.now(), calm: calmDisp, ratio, haveData, contactOk,
    blink: Date.now() - S.blink < 400, jaw: Date.now() - S.jaw < 400,
    horseshoe: S.horseshoe, uptime: (Date.now() - startedAt) / 1000,
  };
}

function tick() {
  const payload = step();
  broadcast(payload);
  if (process.env.DEBUG && Math.floor(Date.now() / 1000) !== tick._sec) {
    tick._sec = Math.floor(Date.now() / 1000);
    console.error(`calm=${payload.calm.toFixed(2)}  ratio=${payload.ratio == null ? '—' : payload.ratio.toFixed(3)}  contact=${payload.contactOk ? 'ok' : 'poor'}  data=${payload.haveData}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP + hand-rolled WebSocket (server -> client push only)
// ---------------------------------------------------------------------------
const clients = new Set();

const server = http.createServer((req, res) => {
  const file = req.url === '/' || req.url === '/index.html' ? 'index.html' : req.url.replace(/^\//, '');
  const full = path.join(__dirname, 'public', path.basename(file));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = full.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clients.add(socket);
  socket.on('data', () => {});                 // drain client frames (ignored)
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

function encodeFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, payload]);
}

function broadcast(obj) {
  if (!clients.size) return;
  const frame = encodeFrame(JSON.stringify(obj));
  for (const s of clients) { try { s.write(frame); } catch (e) { clients.delete(s); } }
}

function start() {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg) => { for (const m of parseOSC(msg)) handle(m); });
  udp.on('error', (e) => console.error('UDP error:', e.message));
  udp.bind(OSC_PORT, () => console.log(`OSC:  listening on udp://0.0.0.0:${OSC_PORT}  (point Mind Monitor here)`));

  setInterval(tick, 50); // 20 Hz

  server.listen(HTTP_PORT, () => {
    console.log(`HTTP: open  http://localhost:${HTTP_PORT}  in your browser`);
    console.log('Waiting for Muse data… (start Mind Monitor and point OSC at this machine)');
  });
}

if (require.main === module) start();

module.exports = { parseOSC, handle, step, S };
