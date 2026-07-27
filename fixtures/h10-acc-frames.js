/*
 * Six real ACC data frames from a Polar H10, captured 2026-07-27 while the strap
 * was worn and still, at 50Hz / +/-2G / 16-bit.
 *
 * WHY THIS FILE EXISTS. Every other test of this protocol built its fixture from
 * the same notes as the code, so it checked the notes against themselves and
 * passed while the decode was wrong by four orders of magnitude. These are bytes
 * the device actually sent, and the assertion made about them is GRAVITY — a body
 * at rest experiences ~1000 mG, which is not a fact this codebase gets to define.
 * That combination is the only non-circular test available here.
 *
 * They also settle a question the spec's prose could not: content is 216 bytes per
 * frame, exactly 36 samples x 3 channels x 2 bytes, with no delta width or sample
 * count header anywhere in it. The H10 does not compress ACC frames.
 *
 * Do not regenerate or "tidy" these. They are evidence.
 */
const frames = [
 "02 a2 19 d9 7e 9b 43 52 08 01 be 03 0e 00 b6 fe cd 03 11 00 b6 fe d8 03 12 00 b6 fe dd 03 0e 00 b9 fe db 03 05 00 b9 fe d4 03 f4 ff bd fe cc 03 e1 ff c4 fe c5 03 d7 ff c7 fe c0 03 d8 ff d8 fe c3 03 e0 ff e1 fe ce 03 e6 ff e8 fe d7 03 f0 ff f0 fe d7 03 f8 ff ef fe d4 03 00 00 f4 fe d5 03 06 00 f2 fe da 03 08 00 f1 fe d9 03 07 00 f1 fe d9 03 03 00 f4 fe d4 03 f8 ff f7 fe d6 03 ec ff f9 fe d7 03 e3 ff f9 fe d8 03 e0 ff fd fe da 03 e6 ff fd fe dd 03 ed ff ff fe de 03 f2 ff 01 ff dd 03 f2 ff 04 ff dd 03 f3 ff 05 ff dd 03 f5 ff 07 ff dd 03 f8 ff 08 ff de 03 f9 ff 06 ff dd 03 f8 ff 07 ff df 03 f5 ff 02 ff e1 03 fd ff 0b ff e2 03 01 00 0e ff e1 03 00 00 03 ff dd 03 fb ff 01 ff",
 "02 06 4b fc a8 9b 43 52 08 01 d7 03 ff ff 10 ff d8 03 fc ff 10 ff db 03 f4 ff 0e ff df 03 f3 ff 03 ff dc 03 f9 ff 06 ff de 03 ff ff 0c ff e2 03 04 00 0f ff e3 03 04 00 14 ff e3 03 01 00 12 ff e3 03 fc ff 13 ff e4 03 fc ff 12 ff e5 03 fa ff 14 ff e5 03 fd ff 19 ff e5 03 ff ff 1b ff e5 03 ff ff 16 ff e5 03 02 00 22 ff e4 03 0b 00 26 ff e4 03 0f 00 21 ff e3 03 16 00 21 ff e2 03 1f 00 1e ff e2 03 24 00 23 ff e3 03 22 00 1f ff e3 03 21 00 1f ff e3 03 18 00 1d ff e1 03 13 00 22 ff e1 03 0d 00 2a ff e1 03 0a 00 2a ff e1 03 0d 00 2c ff e1 03 11 00 32 ff e2 03 10 00 37 ff e3 03 11 00 44 ff e4 03 11 00 45 ff e5 03 11 00 45 ff e5 03 0f 00 46 ff e5 03 10 00 48 ff e5 03 15 00 57 ff",
 "02 a4 f3 1f d3 9b 43 52 08 01 e5 03 1d 00 64 ff e6 03 22 00 40 ff e5 03 2a 00 3e ff e5 03 38 00 74 ff e4 03 29 00 68 ff e4 03 1b 00 63 ff e3 03 16 00 47 ff e3 03 18 00 5d ff e4 03 1d 00 67 ff e5 03 22 00 71 ff e5 03 22 00 6d ff e5 03 1e 00 65 ff e3 03 1f 00 64 ff e0 03 23 00 6b ff df 03 2b 00 71 ff e2 03 2e 00 74 ff e4 03 2f 00 76 ff e5 03 28 00 73 ff e4 03 25 00 79 ff e5 03 1c 00 70 ff e5 03 17 00 71 ff e5 03 14 00 72 ff e5 03 12 00 75 ff e5 03 0f 00 78 ff e6 03 0d 00 7b ff e6 03 0b 00 7b ff e6 03 0d 00 7b ff e6 03 0d 00 79 ff e6 03 0d 00 7a ff e6 03 0b 00 7c ff e6 03 09 00 7e ff e5 03 0b 00 7f ff e0 03 10 00 7d ff e3 03 15 00 7f ff e5 03 19 00 84 ff e5 03 17 00 87 ff",
 "02 54 13 44 fd 9b 43 52 08 01 e6 03 12 00 80 ff e5 03 12 00 75 ff e3 03 17 00 88 ff e4 03 19 00 97 ff e5 03 15 00 90 ff e5 03 19 00 93 ff e4 03 21 00 83 ff e3 03 29 00 94 ff e4 03 21 00 9c ff e6 03 14 00 99 ff e6 03 09 00 8b ff e6 03 ff ff 8b ff e6 03 f6 ff 87 ff e5 03 e8 ff 8b ff e5 03 e2 ff 88 ff e5 03 db ff 8c ff e4 03 de ff 8b ff e4 03 e2 ff 8e ff e5 03 ea ff 93 ff e4 03 ef ff 85 ff e3 03 f5 ff 94 ff e2 03 f0 ff 92 ff e1 03 f2 ff 93 ff e3 03 fb ff 94 ff e4 03 02 00 8a ff e4 03 09 00 83 ff e4 03 0a 00 82 ff e4 03 09 00 85 ff e5 03 07 00 8b ff e5 03 07 00 8a ff e7 03 03 00 88 ff e9 03 fc ff 88 ff e7 03 f8 ff 8b ff e7 03 f9 ff 8b ff e6 03 ff ff 86 ff e6 03 07 00 88 ff",
 "02 9e 21 69 27 9c 43 52 08 01 e5 03 08 00 83 ff e5 03 06 00 80 ff e5 03 03 00 7d ff e5 03 03 00 82 ff e5 03 03 00 84 ff e5 03 01 00 79 ff e4 03 00 00 75 ff e4 03 08 00 81 ff e4 03 08 00 80 ff e5 03 08 00 81 ff e5 03 0a 00 76 ff e5 03 0d 00 78 ff e5 03 10 00 7b ff e5 03 12 00 80 ff e5 03 14 00 80 ff e5 03 14 00 7d ff e5 03 12 00 7c ff e6 03 11 00 7a ff e6 03 0f 00 7b ff e6 03 0f 00 79 ff e5 03 0f 00 79 ff e6 03 0e 00 78 ff e6 03 0f 00 7d ff e5 03 11 00 75 ff e6 03 12 00 76 ff e5 03 14 00 70 ff e5 03 13 00 6f ff e5 03 14 00 6f ff e4 03 14 00 6d ff e5 03 15 00 6e ff e5 03 17 00 72 ff e5 03 18 00 71 ff e5 03 17 00 6c ff e5 03 15 00 68 ff e5 03 14 00 64 ff e4 03 16 00 61 ff",
 "02 cc 83 90 51 9c 43 52 08 01 e4 03 16 00 64 ff e5 03 18 00 6a ff e5 03 13 00 67 ff e6 03 12 00 44 ff e4 03 17 00 4f ff e3 03 1d 00 63 ff e5 03 18 00 60 ff e5 03 1a 00 5d ff e4 03 1b 00 48 ff e4 03 1c 00 4d ff e4 03 1c 00 50 ff e5 03 1c 00 52 ff e4 03 1a 00 4d ff e3 03 1d 00 44 ff e3 03 1d 00 3d ff e4 03 1b 00 3c ff e4 03 17 00 47 ff e4 03 12 00 47 ff e4 03 0f 00 3f ff e2 03 0c 00 44 ff e1 03 0d 00 45 ff e3 03 0e 00 3e ff e4 03 10 00 37 ff e4 03 12 00 38 ff e5 03 13 00 38 ff e5 03 17 00 3b ff e5 03 18 00 47 ff e5 03 15 00 42 ff e5 03 12 00 3c ff e5 03 13 00 39 ff e5 03 14 00 38 ff e5 03 18 00 39 ff e4 03 1b 00 3f ff e4 03 1b 00 46 ff e4 03 17 00 40 ff e4 03 14 00 46 ff",
];
// The device's answers to GET SETTINGS, same session. The ACC response is the one
// that explained error 5: three settings, and no `channels`.
const accSettingsRaw = 'f0 01 02 00 00 00 04 19 00 32 00 64 00 c8 00 01 01 10 00 02 03 02 00 04 00 08 00';
const ecgSettingsRaw = 'f0 01 00 00 00 00 01 82 00 01 01 0e 00';
// The control point's read value: mask 0x05 = bits 0 and 2 = ECG and ACC.
const featuresRaw = '0f 05 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00';
// The accepted START, and the STOP that was refused because nothing was running.
const startAcceptedRaw = 'f0 02 02 00 00 01';
const stopNothingRunningRaw = 'f0 03 02 06 00';

const toBytes = (hex) => new Uint8Array(hex.split(' ').map((x) => parseInt(x, 16)));
const toView = (hex) => { const b = toBytes(hex); return new DataView(b.buffer, 0, b.length); };

module.exports = {
  frames, accSettingsRaw, ecgSettingsRaw, featuresRaw,
  startAcceptedRaw, stopNothingRunningRaw, toBytes, toView,
};
