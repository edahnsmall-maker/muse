# Polar Measurement Data (PMD) — protocol reference

Transcribed from Polar's official specification, `technical_documentation/online_measurement.pdf`
in [polarofficial/polar-ble-sdk](https://github.com/polarofficial/polar-ble-sdk)
(Version 1.0, August 2024). Written down here because the PDF is not text-extractable
without work, and because the next person to touch this should not be guessing.

**Why this file exists.** The Heart Rate Service we already use is a published Bluetooth
standard, so `parseHeartRateMeasurement` could be written from the spec and tested by
constructing packets. PMD is Polar's own protocol, delta-compressed, and its failure mode
is silent: a wrong decode yields plausible numbers rather than an error, and a test written
against a wrong assumption passes because it builds its fixture from the same wrong
assumption. So the details below are quoted, not remembered — and even so, the two marked
**UNVERIFIED** need confirming against real bytes.

---

## UUIDs

| | |
|---|---|
| PMD Service | `FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8` |
| PMD Control Point | `FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8` (read + write, and notifies) |
| PMD Data | `FB005C82-02E7-F387-1CAD-8ACD2D8DF0C8` (notify) |

## Measurement types

| Type | Value |
|---|---|
| ECG | 0 |
| PPG | 1 | 
| **ACC** | **2** |
| PPI | 3 |
| GYRO | 5 |
| MAGNETOMETER | 6 |
| SDK MODE | 9 |
| LOCATION | 10 |
| PRESSURE | 11 |
| TEMPERATURE | 12 |

(4, 7 and 8 are absent from the table.)

## Control point commands

| Command | Value |
|---|---|
| Get measurement settings | 1 |
| Request measurement start | 2 |
| Request measurement stop | 3 |

Stop is documented as `stopMeasurementCommand(3, measurementType as ByteArray)`.

## Measurement settings

These arrive as the response to a *Get measurement settings* request, and are also
supplied when requesting a start.

| Setting | Name | Size | Type | Notes |
|---|---|---|---|---|
| 0 | Sample rate (Hz) | 2 | uint16 | |
| 1 | Resolution (bits) | 2 | uint16 | **Needed for delta decoding** |
| 2 | Range (±unit) | 2 | uint16 | |
| 3 | — | — | — | not used |
| 4 | Number of channels | 1 | uint8 | **Needed for delta decoding** |
| 5 | Conversion factor | 4 | IEEE754 single float | see below |

> **The conversion factor is mandatory to use when parsing measurement data, otherwise
> the sample values are not correct.**

That sentence is the whole reason to read settings at runtime rather than hardcoding
anything. Ignoring it produces numbers that look fine and are wrong — precisely the
failure this project keeps getting bitten by. (Float layout: fraction bits 0–22,
exponent 23–30, sign 31 — i.e. plain little-endian `getFloat32`.)

## Data frame structure

| Field | Bytes |
|---|---|
| Measurement type | `data[0]` |
| Timestamp | `data[1]` … `data[8]` (8 bytes) |
| Frame type | `data[9]` |
| Frame data content (delta frames) | `data[10]` … `data[size-1]` |

## Acceleration frame types

| Frame type | Layout |
|---|---|
| TYPE 0 | X, Y, Z as **8-bit signed** — mG on the H10 (G on Verity Sense) |
| TYPE 1 | X, Y, Z as **16-bit signed**, mG |
| TYPE 2 | X, Y, Z as **24-bit signed**, mG |

**H10 accelerometer capability:** sample rates 25 / 50 / 100 / 200 Hz, ranges ±2 / 4 / 8 G,
values in mG.

## Delta compression

Quoted, condensed:

> Each value in data is used to calculate the next value as a sum of the two adjacent
> values (previous + next). The first value is the reference value. Delta frame has a size
> (bits) determined by the device. The Delta frame size may differ. Also the number of
> samples in the delta frame may differ. You will find both the delta frame size and the
> sample count in front of the delta frame.

> Initially the delta frame size is at index `(channels * ceil(resolution / 8.0)) + 1` and
> sample count at index `(channels * ceil(resolution / 8.0)) + 2`. Where resolution is
> always in full Bytes.

> Reference sample is the first ("seed") sample and it is being used in calculation of the
> subsequent delta samples. So the current delta sample will be summed up with the previous
> sample, and so on.

So, per frame:

```
[ reference sample: channels × bytesPerSample ][ deltaBitWidth ][ sampleCount ][ bit-packed deltas... ]
```

…and a frame can contain **several** such delta blocks back to back, since "the delta
frame size may differ" between them. Each block re-seeds from the running value.

Sign extension, for the reference sample: build the integer by OR-ing each byte shifted
left by `index * 8`; then if `sample & bitmask` is negative, OR in `0xFFFFFFFF << (chunkSize * 8)`.
For the packed deltas: accumulate bits, and if the result is non-zero, OR in
`INT_MAX << (bitWidth - 1)` to extend the sign.

### The two UNVERIFIED points

1. **The `+1` / `+2` index base.** The formula reads as though it is relative to the frame
   *type* byte (`data[9]`), not to the start of the content (`data[10]`) — with the
   reference sample occupying the bytes immediately after the frame type. That is the
   reading that makes the arithmetic work, but it is an inference, and an off-by-one here
   yields a decode that runs and produces garbage.
2. **The sign-extension wording** in the PDF is genuinely awkward (`bitmask = -0x1 shl
   resolution - 1`, with "resolution" used to mean bytes in one place and bits in
   another). Implement it, then check against physics rather than against the prose.

## How to verify a decode is right

Not with a unit test built from these notes — that only checks the notes against
themselves. Use gravity:

- At rest, total magnitude `sqrt(x² + y² + z²)` must sit steadily near **1000 mG**.
- Turn the strap over: one axis should invert while the magnitude stays ~1000 mG.
- Breathing should appear as a slow oscillation of a few tens of mG on the axis normal to
  the chest wall.

If the magnitude is 30, or 400000, or thrashing, the decode is wrong no matter how smooth
the numbers look.

## Implementation status

**Stage 1 (done):** protocol decoding in `public/polar.js` —
`parseControlResponse`, `parseSettings`, `buildAccStartCommand`, `decodeAccFrame`,
`accelMagnitude`, `looksLikeGravity`. Wired into `direct.html`: on strap connect it
asks the device for its ACC settings, starts a stream at 50Hz / smallest range, logs
the first 6 raw frames and the control response to the console as hex, and shows a
**`Chest (decode)`** row in the readout with the live magnitude and a ✓/✗.

Settings are read from the device rather than hardcoded, specifically because the
conversion factor is mandatory.

**How to verify on hardware:** connect the strap, sit still, and look at the
`Chest (decode)` row.

| Reading | Meaning |
|---|---|
| ~1000 mG with a ✓ | the decode is right; proceed to stage 2 |
| a steady but wrong number (e.g. 25, or 256000) | scale error — wrong resolution or byte width |
| thrashing wildly | structural error — wrong offsets or bit order |
| `no frames` | START accepted but the device is sending nothing |
| `start err N` | the device REFUSED the START command with error code N — the request bytes are wrong (most likely the setting count field, see below) |
| `12f t2/1` | frames are arriving but none decode. The two numbers are `data[0]` (measurement type — must be 2 for ACC) and `data[9]` (frame type — 0/1/2 for 8/16/24-bit). If the first is not 2, the frame offsets are wrong; if the second is unexpected, the sample width is |
| `decoding…` | decoded but not yet enough samples for a gravity verdict |
| `not permitted — reconnect` | the PMD service was not declared in `requestDevice`'s `optionalServices` — see below |
| row absent | PMD didn't start and no error was captured |

### Web Bluetooth will refuse a service you did not declare

This cost a full round trip. Web Bluetooth grants access **per service, at pairing
time**. Any service not named in `filters` or `optionalServices` fails with
`Origin is not allowed to access the service` — *even on a device you are already
connected to over a different service*. The strap request filters on the Heart Rate
Service, so PMD has to be listed explicitly:

```js
navigator.bluetooth.requestDevice({
  filters: [{ services: [Polar.HR_SERVICE] }],
  optionalServices: [Polar.PMD_SERVICE],     // <- without this, ACC can never start
});
```

Changing this means the user must click connect again, since the grant is made when
the device is picked. `test-ui.js` captures the real `requestDevice` options and
asserts PMD is among them.

If it is wrong, the console holds the first six frames as hex plus the settings the
device reported. That is enough to fix the offsets without further guessing. The
first thing to try is flipping the delta bit order from LSB-first to MSB-first,
which is the assumption most likely to be wrong.

### If START is refused

The most likely culprit is the **setting count field** in the start request. This
implementation writes one byte (`01`) for "one value follows"; the settings *response*
table describes counts differently, and the spec section that would settle it was not
transcribable. If `start err N` appears, try a `uint16` count (`01 00`) instead — that
is a two-character change in `buildAccStartCommand`.

**Stage 2 (not built):** extract breathing. Band-pass the axis with the most
respiratory variance (or the projection onto the principal axis) over roughly
0.1–0.5 Hz, take the phase, gate on amplitude the way `RSA_MIN_BPM` does, and feed
it through the existing seams (`breathAmount` in `setState`, `features.breathPhase`,
the single `breathRow()`). Precedence should be **accelerometer → RSA → Muse PPG →
calm-linked guess**, so a wrong guess degrades rather than breaks. Do not add a new
breath row.

## Sources

- [polarofficial/polar-ble-sdk](https://github.com/polarofficial/polar-ble-sdk) —
  `technical_documentation/online_measurement.pdf`, the authoritative spec
- [Polar H10 product documentation](https://github.com/polarofficial/polar-ble-sdk/blob/master/documentation/products/PolarH10.md) —
  sample rates, ranges, mG units
- [Guide to Extracting Data w/ APIs from Polar H10 — wearipedia](https://wearipedia.readthedocs.io/en/latest/notebooks/polar_h10.html)
- [bleakheart](https://github.com/fsmeraldi/bleakheart) — a working third-party
  implementation, useful for cross-checking
