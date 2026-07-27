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
assumption. So the details below are quoted, not remembered.

**Both points this file once flagged as UNVERIFIED have now been settled against a
real H10, and both turned out to be wrong** — the delta framing does not apply to ACC
at all. See "Delta compression" below. The lesson generalises: the parts of a protocol
you reason your way to are exactly the parts to distrust until hardware speaks.

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

## Delta compression — NOT used for ACC on the H10

The spec has a delta-compression section. **It does not describe the H10's ACC
frames.** Six real frames settle it:

```
02 a2 19 d9 7e 9b 43 52 08 01  be 03 0e 00 b6 fe  cd 03 11 00 b6 fe  ...
^  ^------- timestamp -------^ ^^ ^-- sample 0 --^ ^-- sample 1 --^
type                       frameType=1
```

Content is **216 bytes per frame — exactly 36 samples x 3 channels x 2 bytes**, with
no delta-width byte and no sample-count byte anywhere in it. Sample 0 is
`(958, 14, -330)`, magnitude 1013 mG. Sample 1 is `(973, 17, -330)`, magnitude 1027.
Both are gravity. A delta reading would have to treat `cd` as a bit width of 205.

So ACC frames are a **flat array of signed little-endian samples**, sample width from
the frame type (0/1/2 -> 1/2/3 bytes), and `decodeAccFrame` refuses any frame whose
content is not a whole number of samples rather than decoding as far as it goes.

**What the delta implementation actually did.** It read the seed sample correctly, hit
`0xcd` as a bit width, failed its own sanity guard, and returned one sample per frame
— silently dropping 35 of 36 and taking the effective rate from 50Hz to about 1.4Hz.
On frames where that byte happened to be <= 32 the delta path ran and invented values,
which is how a strap lying still reported **16,122,280 mG**. The unit test covering
this passed throughout, because it encoded 6-bit deltas exactly the way the decoder
decoded them and then asserted it got them back.

That test is deleted. In its place, `fixtures/h10-acc-frames.js` holds the real bytes
and the assertion is gravity: 216 samples averaging **1011.8 +/- 7.6 mG**.

### What gravity catches, and the one thing it cannot

Established by deliberately breaking the decode and watching the test:

| Injected bug | Caught? | How it showed up |
|---|---|---|
| sample width 16 -> 8 bit | yes | 72 samples instead of 36 |
| byte order LE -> BE | yes | 23,374 mG |
| content offset off by one | yes | 35 samples instead of 36 |
| **axis order permuted** | **no** | **impossible** |

Magnitude is `sqrt(x^2 + y^2 + z^2)`, invariant under permuting the axes. **Nothing
verified here establishes which axis is which.** Do not write breath code that assumes
a named axis is normal to the chest wall — select the axis at runtime by
respiratory-band power, which needs no such assumption.

### The original delta text, kept for the record

Quoted, condensed, in case a future device does use it:

> Each value in data is used to calculate the next value as a sum of the two adjacent
> values (previous + next). The first value is the reference value. Delta frame has a
> size (bits) determined by the device... Initially the delta frame size is at index
> `(channels * ceil(resolution / 8.0)) + 1` and sample count at index
> `(channels * ceil(resolution / 8.0)) + 2`.

No implementation of this ships. A speculative decoder that no available hardware
exercises is how the 16-million-mG reading happened; if a device turns up that needs
one, write it then, against its bytes.

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
`parseControlResponse`, `parseSettings`, `buildAccStartCommand`,
`accStartSettingIds`, `parseFeatures`, `decodeAccFrame`,
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
| `refused N` | the device REFUSED every attempt, and N is the last code. Hover the row for the whole list, and press **copy strap log** — that is the thing to send |
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

### START refusal: solved — send only the settings the device advertises

A real H10 refused with **error code 5**, and kept refusing across five different
request encodings. Identical codes across five encodings was the clue: the encoding
was not what it objected to.

The answer was in its own settings response, which we were already reading and not
listening to:

```
{"sampleRate":[25,50,100,200],"resolution":[16],"range":[2,4,8]}
```

Three settings. **No `channels`.** Every attempt had either sent setting id 4
(channels), which this device never offers, or dropped id 2 (range), which it
requires. Not one of the five sent exactly the three it named — so "invalid
parameter" was literal and correct, and the ladder could never have found it,
because the ladder only varied the *encoding* of a set that was always wrong.

So the rule, and it generalises past this one device:

> **Send exactly the setting ids the device advertised, in ascending order, and no
> others.** `Polar.accStartSettingIds(settings)` derives them from the response;
> `buildAccStartCommand({include})` emits them. Never hardcode the set.

The corrected request for an H10 is 14 bytes:

```
02 02              start, ACC
00 01 32 00        id 0  sample rate  50 Hz     (uint16)
01 01 10 00        id 1  resolution   16 bits   (uint16)
02 01 02 00        id 2  range        ±2 G      (uint16)
```

The conversion factor (id 5) is reported *by* the device and never sent *to* it.

**What this cost, and the cheaper path.** Four hardware round trips, each needing a
physical reconnect and a hand-typed report, and the useful part — the settings
response — arrived only when a screenshot happened to include it. The fix is a
**"copy strap log"** button, hidden unless the negotiation actually fails, which
copies the features read, both settings responses, every attempted request as hex
with the code it got back, and the first frames. One paste replaces the
transcription. If you are debugging PMD, press it first.

### Two assumptions that were being computed and then ignored

1. **The `0xF0` response marker.** `parseControlResponse` returned `isResponse` and
   nothing checked it. Any control-point notification was read as a response, which
   means byte 3 of something else could be reported as an error code — a number
   that looks like the device speaking when it is us misreading. Non-responses are
   now counted (`accNonResponses`) and never parsed.
2. **The control point's READ value** advertises which measurement types the device
   supports. Reading it answers "does this device do ACC at all" *before* any
   negotiation, and if ACC is absent the search is skipped entirely rather than
   producing a long list of meaningless refusals. `parseFeatures` decodes it, and
   reports `raw` plus `looksValid` because its layout is inferred, not transcribed.

A GET SETTINGS for ECG (type 0) is also issued as a **control condition**: if ECG
answers cleanly and ACC does not, the fault is ACC's availability rather than our
request format — a distinction no amount of retrying ACC can make.

### Error codes

From the enum in Polar's SDK source, **not** from the transcribed spec — the PDF's
table is an image. Treat as unverified; the app always shows the raw number and only
ever appends a parenthesised guess with a question mark.

| Code | Name |
|---|---|
| 0 | success |
| 1 | invalid op code |
| 2 | invalid measurement type |
| 3 | not supported |
| 4 | invalid length |
| **5** | **invalid parameter** — what a wrong setting *set* produces |
| 6 | already in state — a stream a previous page load left running |
| 7 | invalid resolution |
| 8 | invalid sample rate |
| 9 | invalid range |
| 10 | invalid MTU |
| 11 | invalid number of channels |
| 12 | invalid state |
| 13 | device in charger |

Code 6 is worth knowing: the H10 keeps streaming after the browser tab that started
it goes away, and cannot START a measurement that is already active. The app sends
an unconditional STOP before negotiating, and ignores the expected error when
nothing was running.

**Stage 1 VERIFIED on hardware (2026-07-27).** A real H10 accepted the corrected
start request on the first attempt, sent 52 frames, and all 52 decoded to gravity.
The bytes are in `fixtures/h10-acc-frames.js`; the readout showed the wrong number
first, which is exactly what that row is for.

**Stage 2 (built):** breathing from chest-wall motion — `Polar.AccelBreath` in
`public/polar.js`, wired in `direct.html` with precedence **chest → RSA → PPG**.

The pipeline, at 5Hz after block-averaging the 50Hz stream (10x Nyquist for a 0.5Hz
signal, and the averaging is the anti-aliasing filter):

1. **High-pass** by subtracting a 12s centred moving average. This is what removes
   gravity — 1000 mG of it, against a respiratory excursion of tens of mG.
2. **Low-pass** with a 1s centred moving average: sway, footsteps, the heartbeat's
   own knock against the strap.
3. **Choose the axis** with the most band-passed power. Never hardcoded — see the
   gravity table above for why that would be unfounded.
4. **Rate** by autocorrelation over 2–20s lags, taking the FIRST strong peak rather
   than the tallest. A periodic signal correlates at every multiple of its period,
   so the tallest peak reported 3.0/min for a 12/min input on the first attempt.
5. **Hold detection** by comparing recent amplitude against the window's, not
   against an absolute mG threshold. How far a chest visibly moves depends on the
   person, the strap tension and where it sits; an absolute number would be wrong
   for everyone but whoever it was tuned on. An absolute floor remains as a backstop
   for a strap lying on a table.

Both moving averages are **centred**, not trailing. A trailing filter shifts the
waveform in time, and not lagging is the entire reason to prefer this over RSA.

### Which direction is inhale: the accelerometer cannot know, RSA can

The strap can be worn either way up, and nothing about the decode establishes the
sign of chest expansion — magnitude is blind to it, exactly as it is blind to axis
order. Physiology settles it: **heart rate rises on inhalation**, so the RSA signal,
lagging but directionally certain, orients the accelerometer, which is fast but
sign-ambiguous. Each sensor covers the other's blind spot.

`resolveSign(reference)` cross-correlates the two and reports `signKnown`. Until it
is true the UI falls back to RSA rather than guess, because a coin flip on which side
of the bar means "in" is worse than a lagging but correct reading.

**The shift budget must scale with the breath period.** A fixed 2.5s search window
inverted the answer at 12 breaths/min, where 2.5s is exactly antiphase and scores
|r| ~ 1 just like the correct alignment. RSA's lag was measured at ~1.0s in a 5s
cycle — a fifth of a period — so the cap is a quarter period, which covers the real
lag and makes antiphase unreachable by construction.

### A hold is a state, not an absence

This is what the whole accelerometer effort was for. Held at the top of an inhale the
chest stays expanded, so the bar stays right of centre, drains its colour, and reads
`hold`. RSA cannot express this: it sees respiratory modulation of beat timing, and a
held breath has none, so "holding at full inhale" and "sensor dead" are the same
picture. The earlier plateau at +50% was heart rate decaying toward its own average,
inflated by normalisation — the right sign for the wrong reason.

## Sources

- [polarofficial/polar-ble-sdk](https://github.com/polarofficial/polar-ble-sdk) —
  `technical_documentation/online_measurement.pdf`, the authoritative spec
- [Polar H10 product documentation](https://github.com/polarofficial/polar-ble-sdk/blob/master/documentation/products/PolarH10.md) —
  sample rates, ranges, mG units
- [Guide to Extracting Data w/ APIs from Polar H10 — wearipedia](https://wearipedia.readthedocs.io/en/latest/notebooks/polar_h10.html)
- [bleakheart](https://github.com/fsmeraldi/bleakheart) — a working third-party
  implementation, useful for cross-checking
