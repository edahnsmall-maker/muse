/*
 * The live app.
 *
 * WHY THIS IS A FILE NOW. This was 3,909 lines of <script> inside direct.html, which was itself
 * 4,630 lines of markup, styles and logic in one place. Three times in this project the whole app
 * went dead — twice from a const referenced before its declaration, once from a cross-module call
 * against a cached module — and every time the symptom was identical and uninformative: "none of the
 * panels open". A single top-level throw anywhere in a 3,900-line script stops everything after it,
 * and there is nothing on screen to say which line did it.
 *
 * The extraction is deliberately MECHANICAL. A classic <script> and a classic <script src> share one
 * global lexical scope and evaluate in the same order, so moving the text out of the page changes
 * nothing about bindings, hoisting, or the order in which anything runs. That was the point: a
 * refactor that also reorganises is a refactor whose bugs cannot be told apart from its intent, and
 * this file has taken the app down enough times already. Splitting it further along real seams —
 * devices, recording, visuals, summary, analysis — is worth doing next, from here, one seam at a
 * time, with the suite green in between.
 *
 * What the move buys immediately: the logic can be diffed and reviewed on its own, it is
 * cache-busted independently of the markup, and the boot self-check in direct.html can now tell
 * whether this file evaluated at all rather than leaving a blank screen to be interpreted.
 */
/*
 * SIMULATED HEADBAND, FIRST OF ALL.
 *
 * Installed before anything else in this file, for one reason: everything below is what has broken,
 * and the simulator's whole purpose is to be able to tell a broken build from an unconnected
 * headband. If it were installed at the bottom, the failures it diagnoses would happen first and
 * take it with them.
 *
 * It runs only when the URL asks (`direct.html?sim=1`), never as a fallback and never by default.
 * See simdevice.js for why that has to be absolute: fabricated data that reached the analysis lab
 * would be indistinguishable from a real sit.
 */
const SIM_ACTIVE = (function () {
  try {
    if (typeof SimDevice === 'undefined' || !SimDevice.requested(location.search)) return false;
    SimDevice.install();
    /* SAY SO, LOUDLY AND PERMANENTLY. Not a pill that can be dismissed and not a line in the
       console: the one unacceptable outcome for this feature is someone watching invented numbers
       and believing them. The banner is the price of having a simulator at all. */
    const banner = document.createElement('div');
    banner.id = 'simBanner';
    banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99997;background:#4a3a10;'
      + 'color:#ffe9b0;font:12px/1.5 system-ui,sans-serif;padding:6px 14px;text-align:center;'
      + 'border-bottom:1px solid #8a6a20;pointer-events:none';
    banner.textContent = 'SIMULATED DATA — no headband is connected. Nothing on this screen is a'
      + ' measurement of anyone. Remove ?sim=1 from the address to use the real device.';
    document.body.appendChild(banner);
    return true;
  } catch (err) {
    // A simulator that takes the app down would be worse than no simulator, and this file is the
    // one that has taken the app down before.
    console.log('[sim] could not install the simulated headband:', err && err.message);
    return false;
  }
}());

const visual = createZenVisual(document.getElementById('gl'));
const statusEl = document.getElementById('status');
const readoutEl = document.getElementById('readout');
const readoutRowsEl = document.getElementById('readoutRows');
const readoutSpanEl = document.getElementById('readoutSpan');
const viewSwitchEl = document.getElementById('viewSwitch');

// Only the `active` class changes on tick. Rewriting the markup would replace the
// nodes and take their listeners with it.
function renderViewSwitch() {
  viewSwitchEl.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === viewMode);
  });
}

// Bound once, at startup, to nodes that live for the life of the page. Delegated
// from the container so it holds even if the pills are ever re-templated.
viewSwitchEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-view]');
  if (!el) return;
  viewMode = el.dataset.view;
  visual.setSeries(viewMode);
  renderViewSwitch();
  renderLegend(); renderChart();
});
const timerPickerEl = document.getElementById('timerPicker');
const connectBtn = document.getElementById('connect');
const strapBtn = document.getElementById('connectStrap');
const copyLogBtn = document.getElementById('copyStrapLog');
const devicesEl = document.getElementById('devices');
const devToggleEl = document.getElementById('devToggle');
// Declared up here with the other element lookups, not next to its render function:
// renderDevices() runs on the startup paint, and a `const` further down the file
// would still be in its temporal dead zone at that point.
let devicesOpen = false;

// When a transient message is showing (e.g. the visual-mode name), the
// 250ms status loop must not immediately overwrite it.
let statusLockUntil = 0;

const modeBarEl = document.getElementById('modeBar');
const patternBarEl = document.getElementById('patternBar');
const breathCueEl = document.getElementById('breathCue');

function renderModeBar() {
  const cur = visual.currentMode().key;
  const modes = visual.modes();
  const row = (family, label) => {
    const pills = modes
      // Hidden modes keep their code and their index, and are simply not offered.
      // Narrowing the list to the ones actually in use beats deleting work that
      // may be wanted again.
      .filter((m) => !m.hidden && (m.family || 'core') === family)
      .map((m) => `<span class="pill${m.key === cur ? ' active' : ''}" data-mode="${m.key}" title="${m.blurb}">${m.label}</span>`)
      .join('');
    if (!pills) return '';
    return `<div class="modeRow"><span class="modeRowTitle">${label}</span>${pills}</div>`;
  };
  modeBarEl.innerHTML = row('core', 'Visuals') + row('glass', 'Glass Studies');
  ensureGrip(modeBarEl);   // innerHTML above just destroyed the previous one
  modeBarEl.querySelectorAll('.pill').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = visual.modes().findIndex((m) => m.key === el.dataset.mode);
      selectMode(idx);
    });
  });
  // The breathing-pattern row only makes sense while Breath is showing.
  patternBarEl.classList.toggle('show', visualsOpen && cur === 'breath');
  breathCueEl.classList.toggle('show', cur === 'breath');
}

function renderPatternBar() {
  const cur = visual.currentPattern().key;
  patternBarEl.innerHTML = VizCore.BREATH_PATTERNS
    .map((p) => `<span class="pill${p.key === cur ? ' active' : ''}" data-pattern="${p.key}">${p.label}</span>`)
    .join('');
  patternBarEl.querySelectorAll('.pill').forEach((el) => {
    el.addEventListener('click', () => {
      // cyclePattern() steps by one, so step until the clicked one is current.
      let guard = 0;
      while (visual.currentPattern().key !== el.dataset.pattern && guard++ < VizCore.BREATH_PATTERNS.length) {
        visual.cyclePattern();
      }
      renderPatternBar();
    });
  });
}

function selectMode(index) {
  const mode = visual.setMode(index);
  setStatus(`${mode.label} — ${mode.blurb}`);
  statusLockUntil = Date.now() + 2200;
  renderModeBar();
}

// Releasing SPACE ends a voice note. A separate listener because keydown/keyup are
// the hold gesture, and it is NOT gated on isTyping(): if a field somehow takes
// focus mid-recording, the microphone must still be released.
addEventListener('keyup', (e) => {
  if (e.key === ' ') stopVoiceNote();
});

addEventListener('keydown', (e) => {
  // While a text field has focus, the global shortcuts must stay out of the
  // way entirely — otherwise typing a note fires them.
  if (isTyping()) return;
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  /* NEXT VISUAL is V again, with `]`/`[` kept as next/previous.
   * V used to be bound twice in this one handler — cycleMode AND startVoiceNote — so
   * holding V to speak also walked through every visualisation, one per key-repeat.
   * The fix then was to give the visuals `]` and leave V to the microphone. V is now
   * the visual key alone and the hold-to-speak gesture is SPACE only, so the collision
   * cannot come back: nothing else listens for V, and V's keyup does nothing.
   * A letter shared between a hold gesture and an action cannot be made safe by
   * ordering the branches, which is why the two are kept on separate keys. */
  if (e.key === 'v' || e.key === 'V' || e.key === ']' || e.key === '[') {
    visual.cycleMode(e.key === '[' ? -1 : 1);
    const mode = visual.currentMode();
    setStatus(`${mode.label} — ${mode.blurb}`);
    statusLockUntil = Date.now() + 2200;
    renderModeBar();
    return;
  }
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); openMarkPrompt(); }
  /* SHIFT+T IS TRAINING, because plain T is now "Thinking".
   * Checked before the tap table, since that table is case-insensitive and would
   * otherwise swallow it. A once-per-sit action can afford a modifier; a tap you make
   * every few minutes with your eyes shut cannot. */
  if (e.shiftKey && (e.key === 'T' || e.key === 't')) {
    e.preventDefault();
    setTrainingMode(!trainingMode);
    return;
  }
  /* ARROWS for the four most-used categories: up focusing, down just sitting,
   * left returned, right thinking. Aliases for the same taps, so nothing downstream
   * knows which finger produced the mark. preventDefault because arrows scroll. */
  /* Through tapForArrow, not TAP_BY_ARROW: the arrows are re-assignable now, and reading the constant
     here would leave the keyboard bound to the defaults while the pills showed the override. */
  if (!e.repeat && Probes.tapForArrow && Probes.tapForArrow(e.key)) {
    e.preventDefault();
    markTap(Probes.tapForArrow(e.key));
    return;
  }
  /* SPACE holds to speak. It is the obvious hold key, needs no aim with eyes shut, and
   * is the only key bound to the microphone now that V cycles the visuals.
   * preventDefault or the page scrolls and the button gets re-triggered. */
  if (e.key === ' ' && !e.repeat) {
    e.preventDefault();
    startVoiceNote();
    return;
  }
  if (e.key === 'n' || e.key === 'N') { openNotes(); return; }
  /* A PENDING PROBE OWNS THE KEYBOARD. Digits answer it, and nothing else may run —
   * otherwise a stray key both answers the probe and triggers a shortcut. */
  if (probePending) {
    const r = Probes.RESPONSE_BY_KBD[e.key];
    if (r) { answerProbe(r.key); return; }
  }
  /* A GRADE, if one was just offered. Pressing 1 or 2 within a few seconds of a graded
   * tap adds the detail. The tap itself is ALREADY recorded — the grade is an
   * amendment, never a condition of the mark being kept, because a mark lost to an
   * unfinished two-key sequence is the worst outcome here. */
  if (pendingGrade && /^[12]$/.test(e.key)) { applyGrade(Number(e.key)); return; }

  // Armed taps and transitions. Checked before the other single-letter shortcuts so a
  // labelling key can never be shadowed by a later branch.
  const tap = Probes.TAP_BY_KBD[e.key.toUpperCase()];
  if (tap && !e.repeat) { markTap(tap); return; }
  // No second lookup: Probes.TAP_BY_KBD above is the only key table for labelling.
  // T is a TAP now; training is Shift+T, handled above.
  if (e.key === 'Escape') closeSummary();
});

// Session timer — optional, understated. Pick a duration once connected;
// a plain "session complete" message shows at the end, nothing jarring.
const TIMER_OPTIONS_MIN = [5, 10, 20, 30];
let timerEndAt = null, timerDone = false;

/*
 * The timer choices used to sit permanently under the status area. They are now a
 * popover from the Timer pill, which also carries the countdown so the remaining
 * time is readable without opening anything.
 */
function renderTimerPill() {
  if (!timerLinkEl.isConnected) return;
  timerLinkEl.classList.toggle('active', !timerPickerEl.hidden);
  if (!timerEndAt) { timerLinkEl.textContent = 'Timer'; return; }
  if (timerDone) { timerLinkEl.textContent = 'Timer: done'; return; }
  const left = Math.max(0, timerEndAt - Date.now());
  timerLinkEl.textContent = `Timer ${Math.floor(left / 60000)}:`
    + `${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}
setInterval(renderTimerPill, 1000);

function renderTimerPicker() {
  timerPickerEl.innerHTML = TIMER_OPTIONS_MIN
    .map((min) => `<button data-min="${min}">${min} min</button>`).join('')
    + (timerEndAt ? '<button data-min="0">Clear</button>' : '');
  timerPickerEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const min = Number(btn.dataset.min);
      // 0 clears rather than setting a zero-length timer that fires immediately.
      timerEndAt = min > 0 ? Date.now() + min * 60000 : null;
      timerDone = false;
      /* Tell the visual how long the sit is meant to be, so Iris spaces its rings
         across the whole of it. Without this a 30-minute sit fills Iris's disc in
         ten and the last twenty minutes are not recorded at all. */
      visual.setSessionLength(min > 0 ? min * 60 : null);
      setPopover(null);
    });
  });
}

const timerLinkEl = document.getElementById('timerLink');
timerLinkEl.addEventListener('click', () => setPopover('timer'));

function setStatus(html, opts = {}) {
  statusEl.innerHTML = html;
  // Hide when empty as well as when asked, so an empty bubble doesn't linger.
  statusEl.classList.toggle('hidden', !!opts.hide || !html);
}

// Both devices' state, always on screen. Rendered on a timer independent of EEG
// data so it stays correct when only the strap is connected, or neither is.
let museConnecting = false, strapConnecting = false;
function museConnected() {
  return !!(device && device.gatt && device.gatt.connected);
}
function renderDevices() {
  /* The PILL is maintained first, above the early return below. It lives in the control bar and is
     never removed, so it must keep rendering even in a browser where the device buttons were taken
     out — otherwise its state freezes at whatever it was when the page loaded. */
  renderDevToggle();
  // The no-Web-Bluetooth path removes both buttons entirely.
  if (!connectBtn.isConnected || !strapBtn.isConnected) return;
  const muse = museConnected();
  connectBtn.textContent = muse ? 'headband \u00b7 linked'
    : (museConnecting ? 'connecting\u2026' : 'Connect headband');
  connectBtn.classList.toggle('linked', muse);
  connectBtn.classList.toggle('secondary', muse);
  connectBtn.disabled = muse || museConnecting;

  const strap = strapConnected();
  let strapText = '+ heart strap';
  if (strapConnecting) strapText = 'connecting\u2026';
  else if (strap && strapUnreliable()) {
    strapText = strapContact === false ? 'heart \u00b7 no contact' : 'heart \u00b7 noisy';
  } else if (strap) {
    strapText = hrBpm != null ? `heart \u00b7 ${hrBpm} bpm` : 'heart \u00b7 linked';
  }
  strapBtn.textContent = strapText;
  strapBtn.classList.toggle('linked', strap);
  strapBtn.classList.toggle('warn', strap && strapUnreliable());
  strapBtn.disabled = strap || strapConnecting;

  // Only offered when there is actually something wrong to report.
  if (copyLogBtn.isConnected) copyLogBtn.hidden = !pmdLogWorthSending();
}

// The log is worth sending when the accelerometer negotiation produced a failure
// a human can't be expected to transcribe: a refusal, frames that won't decode, or
// control-point traffic we could not interpret.
function pmdLogWorthSending() {
  if (!strapConnected()) return false;
  if (accStartError && !accVariant) return true;
  if (accNonResponses > 0) return true;
  if (accFrames > 0 && accDecoded === 0) return true;
  return accVariant != null && accMag != null && !(accVerdict && accVerdict.ok);
}

// ---- Session log + summary -------------------------------------------------
// One sample per second for the whole sit (a 40-minute sit is only 2400 rows).
// The chart's own buffer is capped at ~3 minutes, so the summary needs its own.
const sessionLog = [];
let sessionStartedAt = null;

/* IS THE DEVICE CLOCK TELLING THE TRUTH? See clockcheck.js.
 *
 * Created at load and sampled from the 250ms tick. Every timestamp in this app is Date.now(), and
 * after three separate reports of wrong dates the app needed something better to offer than an
 * explanation of where timestamps come from. This cannot know the true time, but it can prove
 * whether the wall clock is MOVING correctly by comparing it against the monotonic clock — and a
 * clock that drifts or freezes is exactly the failure that produces an error growing by days. */
/*
 * GUARDED, BECAUSE A DIAGNOSTIC MUST NEVER BE ABLE TO KILL THE APP.
 *
 * Reported, urgently: "none of the panels open, and my eeg says nothing was read but it's def
 * connected." That was this line. `clockcheck.js` briefly went missing from the served directory
 * while direct.html still had its <script> tag, so `ClockCheck` was undefined, this threw at load,
 * and everything after it in the inline script never ran — every panel, every keyboard binding, and
 * the whole EEG path. The app looked connected because the Bluetooth handshake happens before any
 * of that.
 *
 * The lesson is not "keep the file there". It is that a clock cross-check is a NICE-TO-HAVE
 * diagnostic and it was wired in as though it were load-critical. Anything optional now degrades to
 * a no-op with the same shape, so a missing or broken auxiliary module costs its own feature and
 * nothing else. This project has been blanked by a top-level throw three times now; the pattern is
 * always the same and the fix is always this.
 */
const clockCheck = (typeof ClockCheck !== 'undefined' && ClockCheck.create)
  ? ClockCheck.create()
  : { available: false, sample: () => null, reset: () => {},
      report: () => ({ available: false, usable: true, elapsedSec: 0, driftMs: 0, ratePpt: 0,
        steps: [], stepMs: 0, verdict: null, reason: 'clock check unavailable' }) };
// A correction the user states once, applied to what is DISPLAYED and never to what is recorded.
let clockOffsetMs = (typeof ClockCheck !== 'undefined' && ClockCheck.readOffset)
  ? ClockCheck.readOffset() : 0;
/* Every displayed time goes through this. Recorded values never do: epochMs in the export stays
   what the device believed, so a correction can be revised later and two archives with different
   corrections are still comparable. */
function displayTime(ms) { return new Date(Number(ms) + clockOffsetMs); }

/* --- Durable recording (see record.js) ------------------------------------
 * Opened lazily on the first sample, so merely loading the page does not create
 * an empty session, and so a browser without IndexedDB degrades to exactly the
 * old behaviour rather than failing to start.
 */
/*
 * THE SESSION CLOCK. One origin, set once, used by everything that records a time.
 *
 * There were three origins before this, and they did not agree: `metrics.csv`
 * counted from the first successful FFT, notes counted from the first raw sample,
 * and voice notes used a third expression. Raw samples arrive before the first
 * window has filled, so the CSV and the notes were offset from each other by an
 * amount nobody had measured — which would have quietly corrupted every attempt to
 * line a note up against what the signal was doing.
 *
 * Every exported row also carries ABSOLUTE epoch milliseconds, so alignment never
 * depends on two files agreeing about an origin. If the offsets ever disagree
 * again, the absolute times still align, and the disagreement is visible.
 */
function sessionClock() {
  if (sessionStartedAt == null) sessionStartedAt = Date.now();
  return sessionStartedAt;
}
function sessionTSec(at) { return ((at || Date.now()) - sessionClock()) / 1000; }

let recDb = null;
let recSession = null;
let recStarting = false;
let recError = null;

/*
 * RECORDING IS EXPLICIT. It used to start on the first sample and never stop, so
 * leaving the tab open recorded the rest of the day into one session. Now it starts
 * and stops when asked, and STOPPING is what closes the sit: it flushes, marks the
 * session ended, and offers the summary. That makes "stop" the moment the sit
 * becomes a thing with a beginning, an end, and its notes attached.
 */
let recArmed = false;
// The session that just ended. stopRecording() clears recSession before opening the
// summary, so without this the closing note would have nothing to attach to.
// addNote() still works on an ended session — it writes straight to the note store.
let lastRecSession = null;
/*
 * Bumped by every arm and every disarm, so an in-flight ensureRecording can tell
 * whether the recording it is opening is still the one that was asked for.
 *
 * WITHOUT THIS, STOPPING COULD BE OVERTAKEN BY STARTING. ensureRecording checks
 * recArmed once, at the top, and then awaits Recorder.open() and startSession(). Stop
 * the recording during those awaits — which is a couple of keystrokes, and now happens
 * by itself since turning Training on arms one — and the guard has already passed: the
 * function goes on to publish a fresh recSession that nothing will ever end(). The UI
 * says "Record", and a live session writes to IndexedDB for the rest of the page's life.
 */
let recGeneration = 0;

/*
 * The attempt currently in flight, if any. A BOOLEAN WAS NOT ENOUGH.
 *
 * The old `if (recStarting) return` swallowed a start that arrived while a previous
 * attempt was still opening the database: the caller got null, nothing retried, and the
 * button sat on "Waiting for data…" for the rest of the sit with nothing recording.
 * That is a couple of keystrokes apart in practice — stop, then start again — and it is
 * now reachable by itself, since turning Training on arms a recording. Holding the
 * promise lets a later caller wait for the earlier attempt to settle and then try again
 * for its own generation.
 */
let recStartPromise = null;

async function openRecordingSession(generation) {
  recDb = await Recorder.open();
  // Ask not to be evicted before a multi-day retreat, not after.
  await Recorder.persist();
  const session = await Recorder.startSession(recDb, {
    startedAt: sessionClock(),
    userAgent: navigator.userAgent,
    /* Which IMU characteristic answered, and the scale used to decode it — written into the archive so
       a future re-decode of the raw bytes knows what the stored numbers assumed, and so a sit with no
       head motion can be told apart from a device that has none. */
    headAccChar: headAccChar || undefined,
    headAccScaleMg: headAccChar ? DSP.MUSE_IMU_SCALE_MG : undefined,
    headAccHz: headAccChar ? DSP.MUSE_IMU_FREQUENCY : undefined,
    /* THE STAMP TRAVELS WITH THE DATA. A simulated sit that reached the analysis lab unmarked would
       be pooled with real ones and could not be separated afterwards — the rows look identical. So
       the flag is written at the moment the session is created, into the same record the exporter
       reads, rather than being inferred later from anything about the numbers. */
    simulated: SIM_ACTIVE || undefined,
  });
  // Disarmed while we were opening. End the session we just created rather than
  // publishing it — an orphan left open is worse than no recording, because it keeps
  // writing and never gets flushed or closed.
  if (generation !== recGeneration || !recArmed) {
    await session.end();
    return null;
  }
  return session;
}

async function ensureRecording() {
  // Two passes at most: one to let an in-flight attempt settle, one to make our own.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!recArmed) return null;           // nothing records unless armed
    if (recSession || recError) return recSession;
    if (recStartPromise) {
      // Someone else is already opening one. Wait, then loop: if their session
      // belongs to this generation it is ours too, and if it was invalidated by a
      // stop/start in between, the second pass opens a fresh one.
      await recStartPromise.catch(() => {});
      continue;
    }
    const generation = recGeneration;
    /* A NEW SIT IS A NEW ESTIMATE. Alpha frequency shifts with arousal, fatigue and time of
       day, so folding yesterday evening's windows into this morning's average would blur
       exactly the thing being measured. */
    for (const a of alphaAccum) a.reset();
    recStarting = true;
    recStartPromise = openRecordingSession(generation);
    try {
      const session = await recStartPromise;
      if (session) recSession = session;
    } catch (err) {
      // Recording is additive. A browser in private mode, or one that refuses the
      // database, must still be able to run a sit — it just cannot keep it.
      recError = (err && err.message) || 'unavailable';
      console.log('[rec] recording unavailable:', recError);
    } finally {
      recStartPromise = null;
      recStarting = false;
    }
    return recSession;
  }
  return recSession;
}
let selfRating = null;      // the person's own guess, asked BEFORE any numbers
const summaryEl = document.getElementById('summary');
const summaryBodyEl = document.getElementById('summaryBody');
const summaryTitleEl = document.getElementById('summaryTitle');

function logSessionSample(result, channels) {
  const now = Date.now();
  const row = {
    t: (now - sessionClock()) / 1000,
    // Absolute time on every row, so notes and metrics can be aligned by wall
    // clock rather than by trusting two files to share an origin.
    epochMs: now,
    calm: result.calm,
    /* THE ABSOLUTE SCORE, in the file. `calm` above is normalised within the sit and therefore cannot
       be compared between sits — measured across seven real recordings it spanned 42.3 to 52.9 while
       the underlying physiology spanned more than twofold. This column is alpha's share of alpha+beta
       and means the same thing in every recording, which makes it the first EEG number here that a
       whole-session comparison can honestly use. */
    calmAbs: result.calmAbs,
    noise: result.artifactRate,
    levels: channels.map((c) => (c.pct == null ? null : c.pct)),
    spikes: bandState.filter((s) => s.spike > 0.9).length,
    /*
     * THE MEASUREMENTS IN REAL UNITS, ONE ROW PER SECOND. Absent until now, and their absence made a
     * reasonable question unanswerable: "did the breathing rate give us anything valuable? diff during
     * calm sessions? any markers?"
     *
     * It could not have. The breathing rate was written exactly ONCE per sit, as a single number in
     * prose in the report markdown. It never reached metrics.csv, so the analysis lab has never seen a
     * breathing rate at all — not across sessions, not at a marked moment, not anywhere. There was
     * nothing to find because nothing was kept.
     *
     * WHY THESE THREE MATTER MORE THAN THE COMPOSITES, which is the part worth understanding: every
     * EEG composite in this app is normalised WITHIN the sit. AdaptiveNormalizer learns a baseline
     * from this sit's first two minutes of usable signal and then holds it, so "Calm 32" means "low
     * compared with how this sit started", not "low compared with your other sits". Pooling those
     * numbers across sessions compares each sit to its own opening and calls the result a difference
     * between sits.
     *
     * The hold is what makes the number stable enough to read at all — before it, the baseline chased
     * the signal on a ~250-second time constant, so the score slid back to 50 on its own. It does not
     * make the number comparable between sits, and nothing will: two sits with different openings have
     * different zeroes.
     *
     * Breaths per minute, beats per minute and RMSSD in milliseconds have none of that problem. They
     * are physical quantities on fixed scales, identical in meaning on Tuesday and Thursday. Together
     * with each channel's alpha SHARE above — also a bounded ratio rather than a normalised score —
     * they are the only columns in this file that can honestly be compared between one sit and
     * another, which is exactly the comparison the whole-session analysis was asked for.
     */
    breathPerMin: (() => {
      const sec = strapBreathSec != null ? strapBreathSec : breathPeriod;
      // Null rather than a number when the strap is unreliable: a rate derived from rejected beats is
      // a guess, and a guess in a column of measurements cannot be told apart later.
      return sec != null && sec > 0 && !strapUnreliable() ? 60 / sec : null;
    })(),
    hrBpm: strapUnreliable() ? null : hrBpm,
    hrvMs: strapUnreliable() ? null : hrvRmssd,
    /*
     * FOUR MORE THINGS THE APP KNEW AND NEVER WROTE DOWN.
     *
     * Found by walking every live signal against metrics.csv, and all four are the same failure as the
     * breathing rate above: computed continuously, shown on screen, and absent from the only file the
     * analysis reads. A measurement that exists on screen and nowhere in the data cannot be asked a
     * single question afterwards.
     */
    /* BREATH PHASE, -1 exhaled to +1 inhaled. This is the one that matters most, because a breath HOLD
       is a state that only phase can express: held at the top of an inhale the chest stays expanded, so
       the bar stays right of centre — while the RATE looks identical to a dead sensor, since a held
       breath has no respiratory modulation at all. Without this column "holding at full inhale" and
       "the strap fell off" are the same row. */
    breathPhase: strapUnreliable() ? null : breathAmount,
    // Which way it is going, so an inhale and an exhale at the same amplitude are distinguishable.
    breathRising: breathRising == null ? null : (breathRising ? 1 : 0),
    /* WHERE THE BREATH NUMBER CAME FROM. Chest motion, RSA from beat timing, and temple PPG are three
       different qualities of measurement — the row on screen says which, because "chest motion and an
       inference from beat timing are not the same quality of number", and then the file did not. Pooling
       them across sits silently mixes a measurement with an inference. */
    breathSource: breathSource,
    /* HOW MUCH OF THE STRAP'S DATA WAS THROWN AWAY. `hrBpm` and `hrvMs` above go null when the strap is
       unreliable, which is right — but null then means both "no strap" and "a strap whose beats were
       being rejected", and those want different treatment in an analysis. This says which. */
    beatsRejected: strapConnected() ? rrBuffer.rejectRate() : null,
    /* WHY a channel has no level, not merely that it has none. `levels` above is null for a channel
       that read nothing, and a floating electrode, a flat dead input and a jaw clench are three
       different facts with three different fixes. The live panel distinguishes them and says what to do
       about each; the file could not tell them apart at all. */
    chanState: channels.map((c) => (c.flat ? 'flat' : c.floating ? 'floating'
      : c.artifact ? 'noisy' : 'ok')),
  };
  // Composites too, so a marked moment can be compared against every score
  // that was on screen at the time — that comparison is the whole point.
  for (const k of activeComposites) {
    if (k === 'calm') continue;
    const v = Metrics.compute(k, features);
    if (v != null) row[k] = v;
  }
  sessionLog.push(row);
  // Kept alongside the raw signal even though it is recomputable, because it
  // records what the app BELIEVED at the time — the thing to compare against
  // when a formula later changes.
  if (recSession) recSession.pushRow(row);
}

function closeSummary() { summaryEl.classList.remove('show'); }

// "Predict, then reveal" — a ROADMAP commitment. Asking how settled the sit
// FELT before showing any number keeps the person's own felt sense primary and
// trains interoception, rather than letting the score define the experience.
function openSummary() {
  const stats = Summary.summarize(sessionLog);
  if (!stats) {
    summaryTitleEl.textContent = 'Nothing to summarise yet';
    /* SAY WHICH THING WAS MISSING, because there are two and they have different fixes.
     *
     * Reported: "I sat for a minute or two and recorded and it said there was nothing to
     * summarise but I could still download the data. Is that right?" It is right, and the
     * message was not. This screen appears when sessionLog has no scored rows, and
     * sessionLog is only written when computeCalm() returns something — i.e. when the
     * HEADBAND is delivering EEG. So the usual cause is no headband signal, not a short
     * sit, and "sit for a little while first" pointed at the wrong thing entirely.
     *
     * The data is still offered because the archive is not empty: marks, notes, and any
     * strap data were all recorded. That was the one dead end from which none of it was
     * reachable, so the two facts belong on screen together. */
    const haveData = summarySessionId() != null;
    const noEeg = !sessionLog.length;
    const why = noEeg
      ? (museConnected()
        ? 'The headband is connected but has not produced a usable second of EEG —'
          + ' every window was artifact-flagged. Check that it is sitting snugly and that'
          + ' the contacts are on skin.'
        : 'The headband was not sending data during this sit, so there are no scores to'
          + ' summarise. The summary is built from EEG; nothing else here needs it.')
      : 'There is signal but not enough of it yet — a few more seconds and this will fill in.';
    summaryBodyEl.innerHTML = `<div class="subtle">${why}`
      + (haveData ? '<br><br>Everything else <b>was</b> saved — your marks, your notes, and'
        + ' the heart strap if it was on. It is all in the download.' : '')
      + '</div><div style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">'
      + (haveData ? '<span class="pill" id="sumData">Download data (.zip)</span>'
        + '<span class="pill" id="sumLab">Open in analysis lab</span>' : '')
      + '<span class="pill" id="sumClose">Close</span></div>'
      // Filled in only if the browser blocks the new tab — see openInLab.
      + '<div id="labFallback" style="margin-top:10px;font-size:13px"></div>';
    summaryEl.classList.add('show');
    document.getElementById('sumClose').addEventListener('click', closeSummary);
    const dataEl = document.getElementById('sumData');
    if (dataEl) dataEl.addEventListener('click', () => downloadSummaryData(dataEl));
    const labEl = document.getElementById('sumLab');
    if (labEl) labEl.addEventListener('click', () => openInLab(labEl));
    return;
  }
  if (selfRating == null) {
    summaryTitleEl.textContent = 'Before the numbers';
    /* A number AND words. A 1-5 rating is comparable across sits, which is what
     * makes it useful for validation; but "scattered but in a new way" is the part
     * that actually explains a sit, and it cannot be a digit. Both are captured
     * before any score is shown, so neither is coloured by the numbers.
     */
    summaryBodyEl.innerHTML =
      '<div class="subtle">How settled did that feel to you?<br>Your own sense first — the data comes after.</div>'
      + '<div id="ratingRow" style="margin-top:20px">'
      + [1, 2, 3, 4, 5].map((n) => `<span class="pill" data-rate="${n}">${n}</span>`).join('')
      + '</div>'
      + '<div class="subtle" style="margin-top:14px;font-size:11px">1 = scattered · 5 = deeply settled</div>'
      /* And the four dimensions, which are the labels the analysis actually needs.
       * All optional: a partial report is a report, and requiring four answers
       * would produce four guesses instead of one observation. */
      /* THE POLES ARE ON SCREEN, not in a tooltip. Reported of the last row: "tone with
       * the numbers isn't really clear what the numbers indicate to me" — and it was true
       * of all four. Every point is named in labels.js, but only the digits were visible
       * and the names were a hover away, which is no use on a phone and no use with your
       * eyes half shut at the end of a sit. So each row now reads
       * "<low> 1 2 3 4 5 <high>", and the chosen anchor still appears in words after. */
      + '<div id="dimGrid">' + Labels.DIMENSIONS.map((d) =>
        `<div class="dimRow"><span class="dimLabel" title="${escapeHtml(d.question)}">${d.label}</span>`
        + `<span class="dimPole lo">${escapeHtml(d.poles[0])}</span>`
        + [1, 2, 3, 4, 5].map((n) =>
          `<span class="pill dimDot" data-dim="${d.key}" data-val="${n}"`
          + ` title="${escapeHtml(d.anchors[n - 1])}">${n}</span>`).join('')
        + `<span class="dimPole">${escapeHtml(d.poles[1])}</span>`
        + '<span class="dimWord" data-word="' + d.key + '"></span></div>').join('') + '</div>'
      + '<textarea id="sumNote" style="margin-top:16px" placeholder="What was it like? (optional)"></textarea>'
      + '<div style="margin-top:16px"><span class="pill" id="sumDone">Save and show me</span>'
      + '<span class="pill" id="sumSkip" style="margin-left:8px">Skip</span></div>';
    summaryEl.classList.add('show');
    // Ratings collected here, not read back off the DOM at submit time — the words
    // shown beside each row have to update as they are chosen anyway.
    const dims = {};
    summaryBodyEl.querySelectorAll('.dimDot').forEach((el) => {
      el.addEventListener('click', () => {
        const k = el.dataset.dim, v = Number(el.dataset.val);
        // Clicking the same value again clears it. Otherwise a mis-click becomes a
        // permanent rating, and there is no way to say "actually I don't know".
        if (dims[k] === v) delete dims[k]; else dims[k] = v;
        summaryBodyEl.querySelectorAll(`.dimDot[data-dim="${k}"]`).forEach((o) => {
          o.classList.toggle('active', Number(o.dataset.val) === dims[k]);
        });
        const word = summaryBodyEl.querySelector(`[data-word="${k}"]`);
        if (word) word.textContent = dims[k] ? Labels.describe(k, dims[k]) : '';
      });
    });
    const finish = async (rating) => {
      selfRating = rating;
      const box = document.getElementById('sumNote');
      const text = box ? box.value.trim() : '';
      const labelled = Labels.normalise(dims);
      // Filed against the session that just ended, as a note about the whole sit
      // rather than a moment in it. Written even with no text, if there are ratings.
      if ((text || labelled) && lastRecSession) {
        await lastRecSession.addNote({
          kind: 'text', text: text || null, dims: labelled,
          anchored: false, closing: true,
        });
      }
      showSummaryStats(stats);
    };
    summaryBodyEl.querySelectorAll('[data-rate]').forEach((el) => {
      el.addEventListener('click', () => {
        selfRating = Number(el.dataset.rate);
        // Selecting a number no longer leaves the screen: the note comes next.
        summaryBodyEl.querySelectorAll('[data-rate]').forEach((o) => {
          o.classList.toggle('active', o === el);
        });
      });
    });
    document.getElementById('sumDone').addEventListener('click', () => finish(selfRating || 0));
    document.getElementById('sumSkip').addEventListener('click', () => finish(0));
    return;
  }
  showSummaryStats(stats);
}

function showSummaryStats(stats) {
  summaryTitleEl.textContent = 'The shape of your sit';
  const lines = Summary.describe(stats).map((l) => `<div>${l}</div>`).join('');
  const chan = stats.perChannel.map((c, i) => {
    const col = VizCore.CHANNEL_COLORS[i];
    const pct = c.alphaFraction == null ? null : Math.round(c.alphaFraction * 100);
    const h = c.alphaFraction == null ? 0 : Math.round(c.alphaFraction * 54);
    return `<div class="chStat"><div class="chBarOuter">`
      + `<div class="chBarFill" style="height:${h}px;background:rgb(${col[0]},${col[1]},${col[2]})"></div></div>`
      + `<div>${DSP.CHANNEL_NAMES[i]}</div>`
      + `<div style="color:rgba(255,255,255,.4)">${pct == null ? 'no signal' : pct + '% alpha'}</div></div>`;
  }).join('');

  /* THE INDIVIDUAL ALPHA PEAK, stated with its own limits attached.
   *
   * This is a different KIND of number from everything else on this screen: the rest are
   * interpretations of a fixed 8-13Hz band, and this is a measurement of where that band
   * should have been for this person. Two things therefore have to be said in the same
   * breath — what was measured, and that the live numbers above did not use it. A frequency
   * printed on its own would read as though the app had been tracking it all along.
   *
   * The refusal is written out in as much detail as the finding, because "not measurable"
   * with a reason is a usable fact (bad contact, too short, no alpha today) and
   * "not measurable" on its own looks like a broken feature. */
  const iaf = measuredAlphaPeak();
  const iafBlock = iaf.fallback
    ? `<div class="subtle" style="margin-top:14px"><b>Alpha peak:</b> not measurable this sit —
       ${escapeHtml(iaf.reason || 'no peak found')}. The numbers above use the fixed
       ${DSP.BANDS.alpha[0]}–${DSP.BANDS.alpha[1]}Hz band, which is a population average
       rather than yours.</div>`
    : `<div class="subtle" style="margin-top:14px"><b>Your alpha peak: ${iaf.freqHz.toFixed(2)} Hz</b>
       — measured at ${escapeHtml(iaf.bestName)}, ${iaf.prominence.toFixed(1)}× above the 1/f
       background, from ${iaf.windows} four-second windows. Your individual alpha band is
       ${iaf.band[0].toFixed(2)}–${iaf.band[1].toFixed(2)}Hz. The live numbers above still use the
       fixed ${DSP.BANDS.alpha[0]}–${DSP.BANDS.alpha[1]}Hz band: one-second windows give 1Hz
       frequency bins and cannot resolve a peak. The lab recomputes with your band.</div>`;

  /* CAN THIS DISPLAY TELL YOUR SIGNAL FROM NOISE? See selfcheck.js.
   *
   * Every visual is driven through an adaptive normaliser, which rescales its input against that
   * input's own recent range — so it uses its full output range whether or not the input carries
   * information. That property was never checked, and it means a responsive-looking visual proves
   * nothing on its own.
   *
   * The test is the series against a SHUFFLED copy of itself: shuffling destroys order, trends and
   * excursions while preserving the distribution exactly, so anything the display shows equally for
   * both is not being shown because of the signal. Reported every sit, because the answer depends
   * on the sit — a session with poor contact or a flat trace can score well below one with signal,
   * and that is exactly when a confident-looking visual is most misleading.
   *
   * Guarded like every other auxiliary module: a diagnostic must not be able to blank the app. */
  let selfLine = '';
  if (typeof SelfCheck !== 'undefined' && sessionLog.length >= SelfCheck.MIN_SAMPLES) {
    const key = viewMode === 'composites' ? primaryMetric : 'calm';
    const label = (Metrics.get(key) || {}).label || key;
    const series = sessionLog.map((r) => (r && Number.isFinite(r[key]) ? r[key] : null));
    /* The SAME transform the display used, hold included. A self-check that re-normalised
       with a chasing baseline would be grading a trace the meditator never saw. */
    const through = (xs) => {
      const norm = new DSP.AdaptiveNormalizer(HOLD);
      return xs.map((v) => norm.update(v)).filter((v) => v != null);
    };
    const sc = SelfCheck.check(series, through, { seed: 11, repeats: 9 });
    const bad = sc.known && sc.decorative;
    selfLine = `<div class="subtle" style="margin-top:14px${bad ? ';color:#ffc98a' : ''}">`
      + `<b>Signal check:</b> ${escapeHtml(SelfCheck.describe(sc, `The ${label} display`))}</div>`;
  }

  const yours = selfRating > 0
    ? `<div class="subtle" style="margin-top:4px">You felt it as a <b>${selfRating}</b> out of 5. `
      + `Over time, noticing how your guess lines up with the trace is the skill worth building — `
      + `more than the number itself.</div>`
    : '';

  summaryBodyEl.innerHTML =
    `<canvas id="summaryTrace" width="560" height="90"></canvas>`
    + `<div id="summaryLines" style="margin-top:6px">${lines}</div>`
    + yours
    + `<div id="summaryChannels" style="margin-top:16px">${chan}</div>`
    + iafBlock
    + selfLine
    + renderMarkerEditor()
    /* TWO DOWNLOADS, because they are two different things and only one of them was
       reachable from here. The report is prose — what happened, for reading. The
       archive is the numbers — raw EEG, per-second metrics, notes.csv — which is what
       the analysis lab and any handoff to an AI actually need.
       Offered only when there IS a recorded session: a button that produces an empty
       archive after an unrecorded sit would suggest the sit was captured. */
    + `<div style="margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">`
    + `<span class="pill" id="sumDownload">Download report (.md)</span>`
    + (summarySessionId() != null
      ? '<span class="pill" id="sumData">Download data (.zip)</span>'
        + '<span class="pill" id="sumLab">Open in analysis lab</span>'
      /* NOT RECORDED, AND STILL RECOVERABLE. See saveUnrecordedSit(): every per-second row and every
         mark is in memory at this point, so this is the last moment they exist. Offered as the
         PRIMARY action, because the alternative is that a ten-minute sit and eleven marks are
         discarded by closing a screen. */
      : (sessionLog.length
        ? '<span class="pill active" id="sumRescue">Save this sit</span>' : ''))
    + `<span class="pill" id="sumClose">Close</span></div>`
    + (summarySessionId() == null && sessionLog.length
      ? '<div style="margin-top:12px;font-size:12.5px;color:#ffc98a;max-width:520px;'
        + 'margin-left:auto;margin-right:auto;line-height:1.5">'
        + '<b>This sit was not recorded.</b> Record was never armed, so nothing here has been'
        + ` saved — including your ${markerLog.markers.length} mark`
        + `${markerLog.markers.length === 1 ? '' : 's'}. The per-second scores and the marks are`
        + ' still in memory and can be saved now; the raw EEG was never captured and cannot be.'
        + ' Closing this screen loses all of it.</div>'
      : '')
    + '<div id="labFallback" style="margin-top:10px;font-size:13px"></div>';
  summaryEl.classList.add('show');
  document.getElementById('sumClose').addEventListener('click', closeSummary);
  document.getElementById('sumDownload').addEventListener('click', () => downloadReport(stats));
  const sumDataEl = document.getElementById('sumData');
  if (sumDataEl) sumDataEl.addEventListener('click', () => downloadSummaryData(sumDataEl));
  const sumLabEl = document.getElementById('sumLab');
  if (sumLabEl) sumLabEl.addEventListener('click', () => openInLab(sumLabEl));
  const sumRescueEl = document.getElementById('sumRescue');
  if (sumRescueEl) sumRescueEl.addEventListener('click', () => saveUnrecordedSit(sumRescueEl));
  wireMarkerEditor();

  // Sparkline of the whole sit — the "shape", not a grade.
  const c = document.getElementById('summaryTrace');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,.10)';
  g.beginPath(); g.moveTo(0, c.height / 2); g.lineTo(c.width, c.height / 2); g.stroke();
  if (stats.trace.length > 1) {
    const grad = g.createLinearGradient(0, 0, c.width, 0);
    grad.addColorStop(0, 'rgba(125,211,252,.9)');
    grad.addColorStop(1, 'rgba(242,200,121,.95)');
    g.strokeStyle = grad;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    stats.trace.forEach((v, i) => {
      const x = (i / (stats.trace.length - 1)) * c.width;
      const y = c.height - Math.max(0, Math.min(1, v)) * c.height;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    });
    g.stroke();
  }
}

// Annotate marks AFTER the sit. This is the half of the marker feature that
// deliberately does not happen during meditation: the timestamp had to be
// captured live, the words did not.
/*
 * A GENERAL NOTE ABOUT THE WHOLE SIT, offered here as well as on the rating screen.
 *
 * Asked for directly: "i need a way to leave a general comment about a recording, bc there
 * might be overall patterns to that recording, not just for the markers... that would also be
 * a good time to put a general note." The rating screen has always had a box, but it appears
 * BEFORE the numbers and is gone by the time you are reading the marks — which is exactly
 * when a pattern across the whole sit becomes obvious.
 *
 * Stored UNANCHORED, which the export already understands: a note about the sit has no moment,
 * and `offsetSec` is written blank rather than 0, because 0 would place a reflection about the
 * whole sit at its opening second and that is a claim nobody made.
 *
 * One note per sit, amended in place rather than appended, so re-opening the summary and
 * adding a sentence does not leave two half-notes to reconcile later.
 */
let sitNoteId = null;
let sitNoteText = '';
let sitNoteTimer = null;

function renderSitNote() {
  return `<div style="margin-top:22px;width:100%;max-width:560px">`
    + `<div class="subtle" style="margin-bottom:6px">About the whole sit — patterns, conditions,`
    + ` anything that was true of all of it rather than of one moment.</div>`
    + `<textarea id="sitNote" rows="3" placeholder="e.g. restless throughout, warmer room than usual,`
    + ` third sit today">${escapeHtml(sitNoteText)}</textarea>`
    + `<div class="subtle" id="sitNoteState" style="font-size:11px;margin-top:4px;opacity:.6"></div>`
    + `</div>`;
}

/*
 * ONE WHOLE-SIT NOTE, WRITTEN FROM TWO PLACES.
 *
 * "A permanent area to label the whole sit. Not inside a panel that has to be opened — always on
 * screen. The general note is how sits get named, so it must be as easy as marking."
 *
 * It was only on the end-of-sit summary, which is the wrong moment for two reasons: the sentence you
 * would write is clearest while the sit is still happening, and the lab names every sit by this note
 * (see listAppSits) — so a sit that ended without one is a row in a list called by its date.
 *
 * There are now two inputs for it: a one-line field always on screen, and the textarea on the summary
 * for the longer reflection. ONE NOTE behind both, sharing sitNoteId. Two notes would mean two
 * candidate names for the same sit and the lab picking whichever it saw first.
 */
function saveSitNoteFrom(el, say) {
  const text = el.value.trim();
  sitNoteText = text;
  // Keep the other field in step, so the summary does not show a stale copy of what is on screen.
  for (const other of [document.getElementById('sitNote'), document.getElementById('sitLabel')]) {
    if (other && other !== el && other.value !== text) other.value = text;
  }
  const sess = recSession || lastRecSession;
  if (!sess) {
    /* SAID, NOT SWALLOWED. Typing a name with nothing recording used to look identical to typing one
       that was saved, and this is the field the lab names sits by — so losing it silently costs the
       name of the sit. */
    say('not recording — press Record and this will be saved');
    return Promise.resolve();
  }
  return (async () => {
    try {
      if (sitNoteId == null) {
        if (!text) return;                 // nothing typed yet; do not create an empty note
        sitNoteId = await sess.addNote({ kind: 'text', anchored: false, text });
      } else if (recDb) {
        await Recorder.updateNote(recDb, sitNoteId, { text });
      }
      say(text ? 'saved' : 'saved (empty)');
    } catch (err) {
      say(`could not save: ${(err && err.message) || 'unknown'}`);
    }
  })();
}

// Debounced, because saving on every keystroke means a transaction per character. Two seconds is
// short enough that closing the screen mid-thought does not lose the sentence, and `blur` catches
// the case where it does.
function wireSitNoteField(box, state) {
  if (!box || box.dataset.wired) return;
  box.dataset.wired = '1';
  const say = (t) => { if (state) state.textContent = t; };
  let timer = null;
  const save = () => saveSitNoteFrom(box, say);
  box.addEventListener('input', () => {
    say('…');
    clearTimeout(timer);
    timer = setTimeout(save, 2000);
  });
  box.addEventListener('blur', () => { clearTimeout(timer); save(); });
  // Off the global shortcuts, or typing "t" in the name of a sit would mark Thinking.
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && box.tagName === 'INPUT') { e.preventDefault(); box.blur(); }
  });
}

function wireSitNote() {
  wireSitNoteField(document.getElementById('sitNote'), document.getElementById('sitNoteState'));
}

/* The always-on-screen one. Wired once at boot to a node that lives for the life of the page, and
   kept in step with sitNoteText so it shows the name after a reload mid-sit. */
function wireSitLabel() {
  const box = document.getElementById('sitLabel');
  if (!box) return;
  wireSitNoteField(box, document.getElementById('sitLabelState'));
  if (box.value !== sitNoteText) box.value = sitNoteText;
}

function renderMarkerEditor() {
  const marks = markerLog.list();
  if (!marks.length) {
    return `<div class="subtle" style="margin-top:18px">`
      + `No marked moments this sit. Tap an <b>arrow</b> or a letter key during a sit to record `
      + `what just happened — thinking, returned, just sitting — or press <b>M</b> to flag and `
      + `describe anything worth remembering. Each one goes into the report next to what the `
      + `data was doing at that moment.`
      + `</div>` + renderSitNote();
  }
  const kinds = Markers.KINDS.map((k) => `<option value="${k.key}">${k.label}</option>`).join('');
  const rows = marks.map((m) => {
    const mm = Math.floor(m.tSec / 60), ss = Math.round(m.tSec % 60);
    /* SAY WHAT THE MARK WAS. Reported as "when i get to the area when i give context around
     * the markers, it would be good to know what the marker was" — and it was worse than
     * missing. Every tap IS in this list, but its kind is a tap category ('lost',
     * 'returned', ...) while the dropdown offered only the M-mark vocabulary (Note, Sound,
     * Body, ...). Setting a select to a value it has no option for silently leaves it on the
     * first entry, so a Thinking tap and a Just-sitting tap both displayed as "Note" — and
     * touching the dropdown would have overwritten the real category with that lie.
     *
     * So a tap shows its own label as TEXT and has no dropdown at all: you pressed a specific
     * thing, and reclassifying it into a different vocabulary is not an edit, it is a
     * corruption. Only an M-mark, which genuinely is an uncategorised "something happened",
     * gets the picker. */
    const tap = Probes.TAP_BY_KEY[m.kind];
    const what = tap
      ? `<span class="markWhat" title="${escapeHtml(tap.hint || '')}">`
        + `${arrowGlyphFor(tap) ? escapeHtml(arrowGlyphFor(tap)) + ' ' : ''}`
        + `${escapeHtml(tap.label)}</span>`
      : `<select data-role="kind">${kinds}</select>`;
    return `<div class="markRow" data-id="${m.id}">`
      + `<span class="stamp">${mm}:${String(ss).padStart(2, '0')}</span>`
      + what
      + `<input data-role="note" placeholder="what was happening?" value="${escapeHtml(m.note || '')}">`
      + `<input data-role="dur" placeholder="secs" style="width:70px" value="${m.durationSec || ''}">`
      + `<span class="pill" data-role="del" title="remove this mark">×</span>`
      + `</div>`;
  }).join('');
  return `<div style="margin-top:20px;width:100%;display:flex;flex-direction:column;align-items:center">`
    + `<div class="subtle" style="margin-bottom:10px">Your marked moments — what each one was,`
    + ` and anything worth adding.</div>`
    + rows + renderSitNote() + `</div>`;
}

function wireMarkerEditor() {
  wireSitNote();
  summaryBodyEl.querySelectorAll('.markRow').forEach((row) => {
    const id = Number(row.dataset.id);
    const m = markerLog.list().find((x) => x.id === id);
    const kindSel = row.querySelector('[data-role="kind"]');
    // Absent for a tap, deliberately — see renderMarkerEditor. Guarded rather than assumed:
    // the previous version called addEventListener on it unconditionally.
    if (kindSel) {
      if (m) kindSel.value = m.kind;
      kindSel.addEventListener('change', () => markerLog.setKind(id, kindSel.value));
    }
    const note = row.querySelector('[data-role="note"]');
    const dur = row.querySelector('[data-role="dur"]');
    const save = () => {
      const d = parseFloat(dur.value);
      const text = note.value.trim() || null;
      markerLog.annotate(id, text, Number.isFinite(d) ? d : null);
      /* AND WRITE IT THROUGH TO STORAGE. The marker list feeds the on-screen summary and the
       * markdown report; `notes.csv` is what the lab reads. Annotating only the former is how
       * context typed at the end of a sit would have gone missing from the one file that
       * matters for analysis. Debounced, since this fires per keystroke. */
      const mk = markerLog.list().find((x) => x.id === id);
      if (!mk || mk.noteId == null || !recDb) return;
      clearTimeout(row.__saveTimer);
      row.__saveTimer = setTimeout(() => {
        /* THE COMMENT GOES IN ITS OWN FIELD, and `text` is not touched for a tap.
         *
         * A first version wrote the comment into `text`, which overwrote the tap's own label —
         * "Thinking" became "same thought as yesterday". Caught by the test, and it is exactly
         * the distinction worth keeping: `text` is what you pressed, written the instant the
         * key went down; `comment` is what you said about it minutes later at the summary.
         * Collapsing them loses which is which, and the tap category is the label the whole
         * analysis keys off.
         *
         * An M-mark is different — its `text` IS the note you typed at the time, and editing
         * that note here is editing the same field. */
        const patch = Probes.TAP_BY_KEY[mk.kind]
          ? { comment: text, durationSec: mk.durationSec }
          : { text, comment: text, durationSec: mk.durationSec };
        Recorder.updateNote(recDb, mk.noteId, patch)
          .catch(() => { /* the on-screen mark and the report still have it */ });
      }, 800);
    };
    note.addEventListener('input', save);
    dur.addEventListener('input', save);
    row.querySelector('[data-role="del"]').addEventListener('click', async () => {
      /* THROUGH deleteMark, which removes the stored note too. This used to call markerLog.remove
         alone, so a mark deleted here left its note in notes.csv — the file the lab reads — and the
         analysis would have counted a mark the practitioner had explicitly removed. */
      await deleteMark(id);
      const stats = Summary.summarize(sessionLog);
      showSummaryStats(stats);
    });
  });
}

/*
 * Which session the summary is about.
 *
 * The still-running one if the summary was opened mid-sit, otherwise the one that was
 * just stopped. `lastRecSession` is why stopRecording keeps a reference at all: it
 * nulls recSession before the summary opens, so without it the summary screen for a
 * sit that had just been recorded would have had no way to reach that sit's data.
 */
function summarySessionId() {
  if (recSession) return recSession.id;
  if (lastRecSession) return lastRecSession.id;
  return null;
}

/*
 * SAVE A SIT THAT WAS NEVER RECORDED, from what is still in memory.
 *
 * Reported as "i just did a session for 10 m and i dont see it at all in the saved sessions." The sit
 * was real, the summary was real, the eleven marks were real — and none of it was written, because
 * Record was never armed.
 *
 * The app did warn, once per mark, in the transient status line: "not recording, this won't be saved".
 * Eleven times, in small text, on a dark screen, to somebody sitting with their eyes half closed. A
 * warning nobody can read at the moment it matters is not a safeguard, it is a record of having
 * technically mentioned it.
 *
 * What makes this recoverable is that nothing was lost yet at the summary screen: sessionLog holds
 * every per-second row and markerLog holds every mark, both in memory. So the honest fix is not
 * another warning — it is a button.
 *
 * WHAT CANNOT BE RECOVERED is the raw EEG. The sample buffers hold a few seconds, not ten minutes, so
 * a rescued sit has metrics.csv and notes.csv and no eeg-ch*.f32. That is most of what the marker
 * analysis needs and none of what recomputing a formula later needs, and the saved session says so
 * rather than looking like a complete one.
 */
async function saveUnrecordedSit(btn) {
  if (!sessionLog.length) {
    setStatus('there is nothing in memory to save');
    statusLockUntil = Date.now() + 4000;
    return;
  }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const db = recDb || await Recorder.open();
    recDb = db;
    const session = await Recorder.startSession(db, {
      startedAt: sessionClock(),
      userAgent: navigator.userAgent,
      simulated: SIM_ACTIVE || undefined,
      /* Marked as recovered, and WHY, so a sit with no raw EEG is never mistaken for one whose
         electrodes failed. Those look identical in the archive and have opposite explanations. */
      recovered: true,
      recoveredNote: 'Saved after the fact from the summary screen. Recording was not armed during'
        + ' this sit, so the per-second scores and the marks were rescued from memory and the RAW EEG'
        + ' was never captured — it cannot be recomputed from this archive.',
    });
    for (const row of sessionLog) session.pushRow(row);
    /* Marks written with their ORIGINAL instants.
       addNote() normally derives `at` and `offsetSec` itself, and its comment is right that callers
       must not pass their own — two fields for one live instant, computed in two places, drift. A
       recovery is the exception that proves the rule: these instants are in the past, and letting the
       default fire would stamp all eleven marks at the same moment, which is the one thing that would
       make them useless. Both fields are passed together so they cannot disagree. */
    const started = sessionClock();
    for (const m of markerLog.markers) {
      await session.addNote({
        kind: 'transition', transition: m.kind, tapCategory: m.kind,
        text: Markers.kindLabel ? Markers.kindLabel(m.kind) : m.kind,
        note: m.note || null, durationSec: m.durationSec || null,
        anchored: true,
        at: started + m.tSec * 1000,
        offsetSec: m.tSec,
      });
    }
    if (sitNoteText) {
      await session.addNote({ kind: 'text', anchored: false, text: sitNoteText });
    }
    await session.end();
    lastRecSession = session;
    setStatus(`saved — ${sessionLog.length} rows and ${markerLog.markers.length} marks.`
      + ' The raw EEG was never captured, so this sit has scores and marks only.');
    statusLockUntil = Date.now() + 9000;
    btn.textContent = 'Saved';
  } catch (err) {
    btn.textContent = label;
    btn.disabled = false;
    setStatus(`could not save it: ${escapeHtml((err && err.message) || 'unknown')}`);
    statusLockUntil = Date.now() + 8000;
  }
}

/*
 * Hand this sit straight to the analysis lab.
 *
 * Asked for: "at the end of a recording session, open the data directly in the analysis
 * lab." Downloading a zip and dragging it back in is a step that will be skipped, and a
 * sit that never reaches the lab is a sit that never gets analysed.
 *
 * The app and the lab share one IndexedDB — same origin, verified including over
 * file://, where both report an origin of "file://" — so the archive is written to the
 * lab's inbox and the lab picks it up when it opens. ARCHIVE BYTES, not a pre-parsed
 * record: the lab already knows how to read an archive, so a handed-over sit and a
 * dropped file go through exactly the same parse. A second ingest path would be a second
 * thing to keep correct.
 *
 * The write happens BEFORE the tab opens. Doing it after would race the lab's own
 * startup, which drains the inbox once — and losing that race looks like the button
 * doing nothing.
 */
/*
 * Hand ANY saved sit to the lab, not only the one that just finished.
 *
 * Asked for: "maybe from the saved sessions i can ... open it in another page and view it? or add it
 * directly to the analysis tab with a click?" It was already possible for exactly one sit — the one on
 * the summary screen — and unreachable for every sit before it, which meant re-recording or hunting
 * for a downloaded .zip. The whole body was already generic apart from where it got the id.
 */
async function openInLab(btn, sessionId) {
  const id = sessionId != null ? sessionId : summarySessionId();
  /* NEVER RETURN SILENTLY. Reported as "open in lab button doesn't work after i stop
   * recording and fill out the form" — and a bare `return` here is indistinguishable from a
   * dead button. There are two ways to get here with nothing to hand over, and they have
   * different fixes, so they say different things. */
  if (id == null || !recDb) {
    setStatus(id == null
      ? 'nothing to hand over — this sit was not recorded, so there is no session to open'
      : 'storage is not open, so the sit cannot be packaged — reload and try Download data');
    statusLockUntil = Date.now() + 7000;
    return;
  }
  const label = btn.textContent;
  btn.textContent = 'Packaging…';
  btn.classList.add('active');
  try {
    const bytes = await buildSessionArchive(recDb, id);
    const labDb = await LabStore.open();
    await LabStore.putIncoming(labDb,
      { name: Exporter.archiveName(bytes.archiveMeta), bytes });
    /* VERIFY THE DELIVERY, do not assume it.
     *
     * The handoff works because the app and the lab share an origin. On the only origin
     * that can produce a recording that is guaranteed — Web Bluetooth refuses to run
     * outside a secure context, so a recorded sit never comes from a file:// page, and
     * on https/localhost same-origin storage is spec. But `file://` origins are opaque
     * per spec and browsers differ on whether they share storage at all, so on that path
     * this could silently write into a store the lab will never read.
     *
     * Reading the count back costs nothing and turns a silent failure into a sentence
     * that names the fallback — which already exists, and is Download data plus dropping
     * the file into the lab.
     */
    const waiting = await LabStore.countIncoming(labDb);
    labDb.close();
    if (!waiting) {
      throw new Error('this browser did not keep the handoff'
        + (location.protocol === 'file:'
          ? ' — file:// pages do not reliably share storage. Use Download data and drop'
            + ' the file into the lab, or serve the page over http://localhost.'
          : ' — use Download data and drop the file into the lab instead.'));
    }
    /* A NEW TAB, so a sit that is still recording is not torn down by navigating away —
     * and a LINK when the browser refuses to open one.
     *
     * This is the other half of "the button doesn't work". Everything above is awaited:
     * reading every raw chunk back out of IndexedDB, CRC-32ing it, zipping it, writing it
     * to the lab's store. By the time window.open is reached, the click that started it is
     * long over, so the call is no longer inside a user gesture and popup blockers stop it.
     * Silently — window.open returns null and nothing happens, which from the outside is
     * exactly a broken button.
     *
     * A blocked popup cannot be un-blocked from script, so the answer is to put a real link
     * on screen and let the next click be the gesture. Offered either way: if the tab did
     * open, the link is harmless; if it did not, it is the whole fix. */
    let opened = null;
    try { opened = window.open('lab.html', '_blank', 'noopener'); } catch (err) { opened = null; }
    const link = document.getElementById('labFallback');
    if (link) {
      link.innerHTML = '<a href="lab.html" target="_blank" rel="noopener"'
        + ' style="color:#7dd3fc">Open the analysis lab \u2192</a>';
    }
    setStatus(opened
      ? 'handed to the analysis lab'
      : 'packaged and waiting in the lab \u2014 your browser blocked the new tab, so use the'
        + ' "Open the analysis lab" link');
    statusLockUntil = Date.now() + (opened ? 2500 : 9000);
  } catch (err) {
    setStatus(`could not hand it over: ${escapeHtml((err && err.message) || 'unknown')}`);
    statusLockUntil = Date.now() + 8000;
  } finally {
    btn.textContent = label;
    btn.classList.remove('active');
  }
}

async function downloadSummaryData(btn) {
  const id = summarySessionId();
  if (id == null || !recDb) return;
  const label = btn.textContent;
  // Building the archive reads every raw chunk back out of IndexedDB and CRC-32s it,
  // which takes long enough on a 40-minute sit to look like a dead button. Say so.
  btn.textContent = 'Packaging…';
  btn.classList.add('active');
  try {
    await downloadSession(recDb, id);
    setStatus('data archive downloaded');
    statusLockUntil = Date.now() + 2500;
  } catch (err) {
    // Never silent: this is the button someone presses when they want the numbers off
    // the machine, and a failure that says nothing looks like a completed download.
    setStatus(`could not build the archive: ${escapeHtml((err && err.message) || 'unknown')}`);
    statusLockUntil = Date.now() + 6000;
  } finally {
    btn.textContent = label;
    btn.classList.remove('active');
  }
}

function downloadReport(stats) {
  const md = Summary.toMarkdown(stats, {
    selfRating: selfRating || null,
    heart: strapConnected() || hrvRmssd != null ? {
      hrBpm, rmssdMs: hrvRmssd,
      steadiness: hrvSteady,
      breathSec: strapBreathSec,
      rejectRate: rrBuffer.rejectRate(),
      contact: strapContact,
      beats: rrBuffer.accepted,
    } : null,
    cueLog: cueEngine.log,
    dateISO: new Date().toISOString().slice(0, 16).replace('T', ' '),
    visualMode: visual.currentMode().label,
    breathPattern: visual.currentPattern().label,
    markers: markerLog.list(),
    samples: sessionLog,
    markerContext: markerContextFor,
    alphaPeak: measuredAlphaPeak(),
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meditation-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('summaryLink').addEventListener('click', openSummary);
document.getElementById('trainToggle').addEventListener('click', () => setTrainingMode(!trainingMode));

/*
 * MEDITATE / TRAIN, in the app bar.
 *
 * The same screen with training off and on, rather than two pages. Presenting them as two places is
 * honest about what actually differs — Train arms recording and shows the mark bar, Meditate is the
 * visual alone — and keeping them as one screen means there is no second copy to keep in step.
 *
 * The bar's highlight is driven from `trainingMode` rather than from which button was last pressed, so
 * the Training pill, Shift+T and these two buttons can never disagree about which place you are in.
 */
/*
 * THE BAR: which visual, whether it is recording, how fast it follows.
 *
 * From the mockup, which puts the seven visual modes in the bar with the current one lit, a "Live
 * session" dot beside the wordmark, and Response beside them. All three were reachable before — the
 * modes behind a Visuals toggle, Response inside the metrics panel — and all three are decisions made
 * about the sit rather than readings from it, which is what the bar is for.
 */
function renderBarModes() {
  const host = document.getElementById('barModeList');
  if (!host) return;
  const cur = visual.currentMode();
  const modes = VizCore.visibleModes();
  const want = modes.map((m) => m.key).join(',');
  // Rebuilt only when the SET changes, not on every tick: these are hoverable targets, and destroying
  // them four times a second is what made the two view pills unclickable once before.
  if (host.dataset.modes !== want) {
    host.dataset.modes = want;
    host.innerHTML = modes.map((m) =>
      `<button class="barMode" data-mode="${m.key}">${escapeHtml(m.label)}</button>`).join('');
    host.querySelectorAll('[data-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        visual.setModeByKey(b.dataset.mode);
        renderBarModes();
        renderModeBar();
      });
    });
  }
  host.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('on', !!cur && b.dataset.mode === cur.key);
  });
}

function renderLiveDot() {
  const el = document.getElementById('liveDot');
  if (!el) return;
  const on = !!recArmed;
  el.classList.toggle('on', on);
  const label = el.querySelector('span');
  if (label) label.textContent = on ? 'Live session' : 'Not recording';
}

function renderPlaces() {
  const med = document.getElementById('placeMeditate');
  const tr = document.getElementById('placeTrain');
  if (med) med.classList.toggle('here', !trainingMode);
  if (tr) tr.classList.toggle('here', trainingMode);
  const bar = document.getElementById('barStatus');
  if (bar) {
    /* Says what the SCREEN is, not only what recording is doing. "nothing is being recorded" was also
       wrong whenever a recording was still running: turning Training off deliberately does not stop
       one, so the bar was contradicting the Record button. */
    bar.textContent = trainingMode
      ? 'Training — marks, metrics and recording'
      : (recArmed ? 'Meditating — still recording, no numbers on screen'
        : 'Meditating — just the visual');
  }
}
{
  const med = document.getElementById('placeMeditate');
  const tr = document.getElementById('placeTrain');
  if (med) med.addEventListener('click', () => setTrainingMode(false));
  if (tr) tr.addEventListener('click', () => setTrainingMode(true));
  /* NOT PAINTED HERE. `trainingMode` is declared with `let` further down this file, so calling
     renderPlaces() at this point reads it inside its temporal dead zone and throws — which is precisely
     the failure that took this whole app down twice before, and it threw on the first run. The initial
     paint happens at the END of the file, where everything exists. */
}
// The "Mark this moment" and "Fullscreen" pills are gone: training mode already
// prompts for M, and F needs no pill. Both keys still work — see the keydown
// handler — so nothing was removed except two pills from a crowded bar.
const cueToggleEl = document.getElementById('cueToggle');
/* RESPONSE LIVES IN THE APP BAR NOW, as in the mockup. Guarded rather than assumed: the old pill inside
   the metrics panel is gone from the markup, and a hard reference to a removed node is how one line takes
   the whole app down — twice, historically. */
const responseToggleEl = document.getElementById('barResponse')
  || document.getElementById('responseToggle');
function renderResponseToggle() {
  if (responseToggleEl) responseToggleEl.textContent = `Response: ${visual.currentResponsiveness().label}`;
}
if (responseToggleEl) {
  responseToggleEl.addEventListener('click', () => {
    const mode = visual.cycleResponsiveness();
    renderResponseToggle();
    setStatus(`visual response: ${mode.label}`);
    statusLockUntil = Date.now() + 1600;
  });
}
renderResponseToggle();
cueToggleEl.addEventListener('click', () => {
  const on = cueEngine.setEnabled(!cueEngine.enabled);
  cueToggleEl.textContent = `Cues: ${on ? 'on' : 'off'}`;
  cueToggleEl.classList.toggle('active', on);
});
/* The pill starts matching the engine's own default, which is off — see the CueEngine
   construction below. Set at construction rather than switched off here, because `const
   cueEngine` is declared further down and `const` does not hoist: calling setEnabled here
   threw "Cannot access 'cueEngine' before initialization" and blanked the page. */
cueToggleEl.textContent = 'Cues: off';
cueToggleEl.classList.remove('active');
summaryEl.addEventListener('click', (e) => { if (e.target === summaryEl) closeSummary(); });

if (!navigator.bluetooth) {
  setStatus('Web Bluetooth isn’t available in this browser.<br>Use Chrome or Edge (desktop, Android, or ChromeOS).');
  /* Say WHY inside the panel rather than emptying it.
     Removing both buttons left #devices as a 10px-padded, dark, 12px-radius box with
     nothing in it — a small black blob above the Connect pill, with no explanation of
     where the buttons went. This is the browser a phone hits (Safari has no Web
     Bluetooth), so it is a real path, not a test artefact. */
  connectBtn.remove();
  strapBtn.remove();
  const why = document.createElement('div');
  why.className = 'popoverNote';
  why.textContent = 'This browser can’t reach Bluetooth devices. Open the page in Chrome or Edge.';
  devicesEl.appendChild(why);
}

// Two frontal channels only (AF7, AF8) drive the calm score — the same
// "anterior alpha" signal used throughout this project, and the pair
// least affected by neck/jaw movement compared to the temporal (TP9/TP10)
// channels. Channel order matches DSP.CHANNEL_NAMES: [TP9, AF7, AF8, TP10].
const FRONTAL = [1, 2];
const WINDOW = 256; // 1s of samples at 256Hz — exactly 1Hz per FFT bin

const buffers = DSP.CHANNEL_NAMES.map(() => []);

/* INDIVIDUAL ALPHA PEAK, accumulated across the whole sit.
 *
 * The live display's 1-second windows give 1Hz frequency bins — five bins across the whole
 * of alpha, which cannot tell 9.5Hz from 10.5Hz — so nothing here can be measured from the
 * numbers on screen. These accumulate 4-second spectra (0.25Hz bins) in parallel, which is
 * the resolution the question needs, without changing anything the live display does.
 *
 * One accumulator per electrode, fixed at about 12KB each regardless of how long the sit
 * runs: an average does not need its inputs kept. See DSP.SpectrumAccumulator. */
const alphaAccum = DSP.CHANNEL_NAMES.map(() => DSP.SpectrumAccumulator(DSP.EEG_FREQUENCY));
function measuredAlphaPeak() {
  return DSP.pickAlphaPeak(alphaAccum.map((a, i) => {
    const sp = a.spectrum();
    return Object.assign({ name: DSP.CHANNEL_NAMES[i], channel: i,
      windows: sp.windows, skipped: sp.skipped, binHz: sp.binHz }, DSP.individualAlphaPeak(sp));
  }));
}
/*
 * THE BASELINE HOLDS AFTER TWO MINUTES, and every normaliser on this screen holds
 * together. See the long note on DSP.AdaptiveNormalizer for the measurement that forced
 * it; the short version is that a chasing baseline draws changes the meditator did not
 * make, and it was reported twice — once as "jumpy lines" and once as lines that drift.
 *
 * ONE SETTING, SHARED. Calm drives the visual and is also a line on the chart, and
 * Thinking sits next to it. A normaliser that held beside one that chased would put two
 * lines with different reference points in one picture, which is the same class of mistake
 * as the three chart colours that collided.
 */
const HOLD = { holdAfter: DSP.BASELINE_HOLD_UPDATES, minSd: DSP.BASELINE_MIN_SD };
const tracker = new DSP.AdaptiveNormalizer(HOLD);
// "Thinking" is a separate signal from movement noise: activation (beta level),
// how much the band balance churns, and how often it shifts abruptly. Computed
// only from artifact-free windows, so a jaw clench is never read as a thought.
const activityTracker = new DSP.ActivityTracker(HOLD);
/* OFF BY DEFAULT, as asked. An unrequested interruption during a sit is something to opt
   into, not out of; the Cues pill turns them on when they are wanted. */
const cueEngine = new Cues.CueEngine({ minIntervalSec: 300, enabled: false });
// Per-band normalisers, so each composite is expressed relative to this
// person's own session rather than an invented absolute scale.
const bandNorms = {
  delta: new DSP.AdaptiveNormalizer(HOLD), theta: new DSP.AdaptiveNormalizer(HOLD),
  alpha: new DSP.AdaptiveNormalizer(HOLD), beta: new DSP.AdaptiveNormalizer(HOLD),
};
let features = {};

// Which view the graph / readout / visual are all keyed to, and which
// composite drives the visual when in composite view.
let viewMode = 'sensors';          // 'sensors' | 'composites'
let primaryMetric = 'calm';
// HRV and equanimity are listed even with no strap connected: Metrics.compute
// returns null for them, the readout shows an em dash, and that is the honest
// state — "we have no heart data" rather than silently omitting the row so you
// can't tell whether it's missing or zero.
// Graphed over time and legend-able, but deliberately NOT a row in the composite
// readout: a 0-100 bar is the wrong shape for breath (an exhale is not a low
// score), and it gets exactly one row of its own — the centred bar below.
const CHART_ONLY_COMPOSITES = ['breath'];
/*
 * DERIVED FROM metrics.js, NOT LISTED AGAIN HERE.
 *
 * This used to be a hand-written array, and metrics.js now carries a `display` flag saying which
 * metrics belong on the live screen. Two lists of the same thing is the duplication that has
 * already caused real bugs in this project — a palette drifted between a visual and its chart, and
 * a vocabulary drifted between two files — so retiring a metric in metrics.js has to retire it
 * here, without anyone remembering to.
 *
 * The order comes from METRICS, so the readout follows the same order as the honesty panel that
 * explains it. `breath` is removed because it has its own centred row, for the reason above.
 */
/* GUARDED, because a NEW cross-module function is exactly what version skew breaks.
 *
 * `Metrics.displayed()` was added in the same change that started calling it here, and a browser
 * holding a cached metrics.js has direct.html asking for a function that does not exist yet. That
 * threw at the top level and killed the entire inline script — the second outage of the day with the
 * same shape. Reproduced in a headless browser by deleting the method before load.
 *
 * The fallback reads the flag directly, which every version of METRICS can answer, so a stale module
 * costs the retirement of two metrics rather than the whole app. */
const activeComposites = (Metrics.displayed
  ? Metrics.displayed()
  : Metrics.METRICS.filter((m) => m.display !== false))
  .map((m) => m.key)
  .filter((k) => !CHART_ONLY_COMPOSITES.includes(k));

/*
 * MIND / BODY / SIGNAL — which group each reading belongs in.
 *
 * Asked for, and the reason is that the panel was one flat list of a dozen rows in no order, so
 * reading it meant scanning all of it every time. The three groups are not decoration: they separate
 * three genuinely different kinds of claim, and the third one is the important one.
 *
 *   MIND    interpreted scores. Every one of these is unvalidated, normalised within the sit, and
 *           not comparable with another sit.
 *   BODY    physical quantities on fixed scales — breaths per minute, beats per minute, milliseconds,
 *           a bounded ratio. These mean the same thing on Tuesday and Thursday.
 *   SIGNAL  how good the measurement is. Not a thing you are doing with your mind, and grouping it
 *           with things that are is how a floating electrode gets read as a state of mind.
 *
 * ONE TABLE, keyed by metric key, so a metric added to metrics.js cannot quietly land nowhere. The
 * assignment is asserted against Metrics.METRICS in test-metrics.js — this project has already paid
 * twice for a vocabulary kept in two places and allowed to drift.
 *
 * Blinks and jaw are SIGNAL rather than BODY, which is where the mockup had them. They are artifact
 * measures — the same reason their chart colours are deliberately desaturated: "this is interference"
 * rather than "another thing you are doing with your mind". A blink rate is a fact about the
 * electrodes before it is a fact about the meditator.
 */
const METRIC_GROUP = {
  calm: 'mind', thinking: 'mind', focus: 'mind', drowsy: 'mind', equanimity: 'mind',
  asymmetry: 'mind', openness: 'mind',
  breath: 'body', hrv: 'body',
  blink: 'signal', jaw: 'signal',
};
const GROUPS = [
  { key: 'mind', label: 'Mind' },
  { key: 'body', label: 'Body' },
  { key: 'signal', label: 'Signal' },
];

/*
 * SIXTEEN SECONDS OF SIGNAL BEHIND EVERY DISPLAYED NUMBER.
 *
 * See DSP.BAND_AVERAGE_SEC for the measurement that set the span. The short version: on a stationary
 * signal, where nothing about the person changes, a 1-second estimate of log(alpha/beta) has a 2-98%
 * noise span of 1.89, and a DOUBLING of alpha is 0.69. The app used the 1-second estimate, so the
 * numbers moved by more than any real change could account for — which is exactly the report, "the
 * scores are so volatile they seem to contradict real life."
 *
 * Fed once per second rather than on every 250ms tick. Four estimates a second from a one-second
 * window share 75% of their samples, so averaging sixteen of them is worth about four seconds of
 * independent signal, not sixteen.
 */
const bandAverager = new DSP.BandPowerAverager();
let lastBandPushSec = null;
/* Enough seconds to be worth showing. Below this the average is not yet what it claims to be, and the
   readout says "settling" rather than printing a number with a quarter of its window behind it. */
const BAND_AVERAGE_MIN_SEC = 4;

// True once there is a real average behind the numbers — read by the readout so the panel can say
// which of the two it is showing rather than presenting them identically.
function bandAverageSeconds() {
  return bandAverager.filled(Date.now() / 1000);
}

function computeFeatures(result) {
  const wins = FRONTAL.map((ch) => buffers[ch].slice(-WINDOW)).filter((w) => w.length >= WINDOW);
  if (wins.length < 2) return features;
  const clean = !wins.some((w) => DSP.isArtifact(w));
  const bp = wins.map((w) => DSP.bandPowers(w, DSP.EEG_FREQUENCY));
  const instant = (k) => bp.reduce((sum, pw) => sum + pw[k], 0) / bp.length;

  /* One clean second in, at most once a second. Artifact-flagged seconds are skipped entirely rather
     than pushed as zeros — a blink is missing data, not quiet brain. */
  const nowSec = Date.now() / 1000;
  if (clean && (lastBandPushSec == null || nowSec - lastBandPushSec >= 1)) {
    bandAverager.push({ delta: instant('delta'), theta: instant('theta'),
      alpha: instant('alpha'), beta: instant('beta') }, nowSec);
    lastBandPushSec = nowSec;
  }
  /* The average when there is one, the instant estimate while it fills. Falling back rather than
     showing nothing for the first sixteen seconds, because a blank panel at the start of a sit reads
     as broken — but the readout is told which it is, so the difference is stated and not hidden. */
  const mean = bandAverager.mean(nowSec);
  const useAverage = !!mean && mean.seconds >= BAND_AVERAGE_MIN_SEC;
  const avg = useAverage ? (k) => mean[k] : instant;
  // wins[0] is AF7 (left forehead), wins[1] is AF8 (right).
  const art = DSP.classifyArtifact(wins[0], wins[1], DSP.EEG_FREQUENCY);

  const f = {
    calm: result.calm, activity: result.activity,
    blink: art.blink, jaw: art.jaw,
    variability: activityTracker.varNorm ? activityTracker.varNorm.value : 0.5,
    // No longer deliberately absent: with a chest strap connected these are
    // real. Still null when there's no strap, or when it's unreliable —
    // a metric with no trustworthy input must read as no data, not as zero.
    hrvSteadiness: strapUnreliable() ? null : hrvSteady,
    hrvLevel: strapUnreliable() ? null : hrvLevel,
    breathPhase: strapUnreliable() ? null : breathAmount,
  };
  if (clean) {
    f.deltaLevel = bandNorms.delta.update(Math.log(avg('delta') + 1e-6));
    f.thetaLevel = bandNorms.theta.update(Math.log(avg('theta') + 1e-6));
    f.alphaLevel = bandNorms.alpha.update(Math.log(avg('alpha') + 1e-6));
    f.betaLevel = bandNorms.beta.update(Math.log(avg('beta') + 1e-6));
    f.alphaLeft = Math.log(bp[0].alpha + 1e-6);
    f.alphaRight = Math.log(bp[1].alpha + 1e-6);
  } else {
    // Hold the last known levels rather than learning from unusable data.
    for (const k of ['deltaLevel', 'thetaLevel', 'alphaLevel', 'betaLevel', 'alphaLeft', 'alphaRight']) {
      f[k] = features[k];
    }
  }
  features = f;
  return f;
}

// Marked moments — the raw material for ever validating any of the
// interpretive scores. One keypress, no typing: the timestamp is the
// perishable part, the words are not.
const markerLog = new Markers.MarkerLog();
let trainingMode = false;
const markFlashEl = document.getElementById('markFlash');

function sessionSeconds() {
  return sessionStartedAt == null ? 0 : (Date.now() - sessionStartedAt) / 1000;
}

const markPromptEl = document.getElementById('markPrompt');
const markStampEl = document.getElementById('markStamp');
const markKindsEl = document.getElementById('markKinds');
const markNoteEl = document.getElementById('markNote');
const markDurEl = document.getElementById('markDur');
let pendingMark = null;   // { tSec, kind } — timestamp frozen at keypress

// True while a text field owns the keyboard. Without this, typing a note
// containing "m", "t", "v" or "f" would fire the global hotkeys and drop
// extra marks or switch the visual mid-sentence.
function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function renderMarkKinds() {
  markKindsEl.innerHTML = Markers.KINDS.map((k, i) =>
    `<span class="pill${pendingMark && pendingMark.kind === k.key ? ' active' : ''}" ` +
    `data-kind="${k.key}" title="${k.hint}">${i + 1}. ${k.label}</span>`).join('');
  markKindsEl.querySelectorAll('[data-kind]').forEach((el) => {
    el.addEventListener('click', () => {
      if (pendingMark) pendingMark.kind = el.dataset.kind;
      renderMarkKinds();
      markNoteEl.focus();
    });
  });
}

// Opens the prompt. The timestamp is frozen NOW, at the keypress, so however
// long the note takes to type the mark still points at the right moment.
function openMarkPrompt() {
  if (sessionStartedAt == null) return null;
  if (pendingMark) { markNoteEl.focus(); return pendingMark; }
  const tSec = sessionSeconds();
  pendingMark = { tSec, kind: 'note' };
  markStampEl.textContent = `${Math.floor(tSec / 60)}:${String(Math.floor(tSec % 60)).padStart(2, '0')}`;
  markNoteEl.value = '';
  markDurEl.value = '';
  renderMarkKinds();
  markPromptEl.classList.add('show');
  markFlashEl.classList.add('on');
  setTimeout(() => markFlashEl.classList.remove('on'), 60);
  markNoteEl.focus();
  return pendingMark;
}

function commitMark() {
  if (!pendingMark) return;
  const note = markNoteEl.value.trim() || null;
  const durRaw = parseFloat(markDurEl.value);
  const m = markerLog.add(pendingMark.tSec, {
    kind: pendingMark.kind,
    note,
    durationSec: Number.isFinite(durRaw) ? durRaw : null,
  });
  // A label is the scarcest thing in this system — a few dozen per retreat
  // against millions of samples — so it is written immediately, not at the end.
  if (recSession) {
    recSession.addNote({ kind: 'mark', markKind: m.kind, text: note,
      durationSec: m.durationSec }).then((noteId) => {
      if (noteId != null) markerLog.setNoteId(m.id, noteId);
    });
  }
  pendingMark = null;
  markPromptEl.classList.remove('show');
  markNoteEl.blur();
  renderMarkCount();
  const mm = Math.floor(m.tSec / 60), ss = Math.round(m.tSec % 60);
  setStatus(`marked ${mm}:${String(ss).padStart(2, '0')}${note ? '' : ' (no note)'}`);
  statusLockUntil = Date.now() + 1800;
}

function cancelMarkPrompt() {
  // Escape still SAVES — the timestamp is the valuable part, and someone
  // hitting escape mid-sit wants out of the box, not the mark discarded.
  commitMark();
}

markNoteEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitMark(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelMarkPrompt(); }
  else if (/^[1-6]$/.test(e.key) && markNoteEl.value === '') {
    // Number keys pick a kind, but only while the note is still empty so they
    // never swallow a digit someone is actually trying to type.
    e.preventDefault();
    const k = Markers.KINDS[Number(e.key) - 1];
    if (k && pendingMark) { pendingMark.kind = k.key; renderMarkKinds(); }
  }
  e.stopPropagation();
});
markDurEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitMark(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelMarkPrompt(); }
  e.stopPropagation();
});

/*
 * The mark tally lives in the armed panel's hint line, not in its own corner element.
 *
 * It used to sit at top-left under the training clock. With the clock gone it moved up
 * to top-left proper — which is exactly where every visual now draws its legend, so the
 * two would have overlapped. It belongs next to "press M to mark" anyway: the hint and
 * the count are one sentence about the same thing.
 */
/*
 * DELETE A MARK — from the screen AND from the file, in one place.
 *
 * There were two delete paths and only one of them was right. The Notes panel deletes the stored note
 * and then calls markerLog.removeByNoteId, with the reason recorded: "a deleted mark vanished from the
 * archive while the readout still counted it, which is two records of one sit disagreeing." The summary's
 * marker editor called markerLog.remove alone — so a mark deleted there disappeared from the screen and
 * stayed in notes.csv, which is the file the lab actually reads. The count the analysis is built on would
 * have been wrong, and nothing on screen would have said so.
 *
 * So there is one function now and both callers use it. Order matters: the note goes first, because if
 * that fails the mark must stay on screen rather than the two records parting company the other way.
 */
async function deleteMark(id) {
  const mk = markerLog.list().find((x) => x.id === id);
  if (!mk) return false;
  if (mk.noteId != null && recDb) {
    try {
      await Recorder.deleteNote(recDb, mk.noteId);
    } catch (err) {
      setStatus(`could not delete that mark: ${(err && err.message) || 'unknown'}`);
      statusLockUntil = Date.now() + 2600;
      return false;
    }
  }
  markerLog.remove(id);
  renderMarkCount();      // refreshes the history when it is showing
  renderChart();
  return true;
}

/* The old per-mark list lived here. It read markerLog and showed only taps; the History tab shows taps,
   typed notes and voice notes together from the notes store, which is where all three already went — see
   renderNoteList. Two lists of overlapping things was the split the consolidation removed. */

function renderMarkCount() {
  /* THE LIST IS REFRESHED HERE TOO. Every place that changes the marks already calls this — a tap, a
     saved M-mark, a delete from either editor — and none of them is on the 250ms tick, so this is the one
     hook that cannot go stale. Adding a second call at six sites is how one gets missed, which is
     exactly what happened first: the count updated after a tap and the list did not. */
  /* THE HISTORY IS THE LIST NOW, and it is refreshed here for the same reason the old one was: every place
     that changes the marks already calls this, and none of them is on the tick. Only when it is on screen —
     it reads the notes store, and doing that on every tap while looking at the Marks tab is work for
     nobody. */
  if (railTab === 'history') renderNoteList();
  const el = armedBarEl.querySelector('.armedHint');
  if (!el) return;
  const n = markerLog.length;
  el.innerHTML = 'press <b>M</b> to mark'
    + (n ? ` \u00b7 ${n} mark${n === 1 ? '' : 's'}` : '')
    // The probe switch sits here rather than in the bar: it only means anything while
    // training is on, and this is the training panel.
    + `<span class="rFix" data-probe-toggle title="Probes interrupt with a question every`
    + ` few minutes and ask what was happening JUST BEFORE the cue. They catch being gone`
    + ` without noticing, which a self-caught tap cannot. Off by default.">`
    + `probes ${probesEnabled ? 'on' : 'off'}</span>`;
}

/* Delegated from the document, not bound to #armedBar. Two reasons: the panel rebuilds
   its innerHTML on every render, and binding here would run before `const armedBarEl` is
   declared — which threw "Cannot access 'armedBarEl' before initialization" and blanked
   the whole page. `const` does not hoist. */
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('[data-probe-toggle]')) return;
  probesEnabled = !probesEnabled;
  if (!probesEnabled) {
    probePending = null;
    const hud = document.getElementById('probeHud');
    if (hud) hud.hidden = true;
  }
  renderMarkCount();
  setStatus(probesEnabled
    ? 'probes on \u2014 a question every few minutes, about the moment before the cue'
    : 'probes off \u2014 no interruptions');
  statusLockUntil = Date.now() + 2600;
});

/*
 * MEDITATE AND TRAIN ARE GENUINELY DIFFERENT SCREENS NOW.
 *
 * Reported as "the meditate page and train is the same thing", and it was — the flag armed recording
 * and showed the mark bar, while every panel, every number and the whole control bar stayed exactly
 * where they were. Two names for one screen.
 *
 * The instruction was to "differentiate the meditate page a little from the training area", so the
 * difference is now the one the practice actually asks for. From ROADMAP: feedback "shouldn't feel like
 * a game or a score to chase — it's closer to a mirror than a meter."
 *
 *   MEDITATE  the mirror. The visual, and as close to nothing else as is safe. No scores, no graph,
 *             no mark bar, no metrics — a number on screen is a thing to check, and checking is the
 *             opposite of sitting.
 *   TRAIN     the instrument. Everything: marks, the live feed, the grouped metrics, recording armed.
 *
 * WHAT IS DELIBERATELY STILL THERE IN MEDITATE: the app bar (so there is a way out), Record, the
 * status line, and the control bar — faded almost to nothing and legible again on hover. Hiding the
 * controls outright would mean a screen with no way back, which is a worse failure than an austere one.
 *
 * The panels' open/closed state is REMEMBERED across the switch rather than reset, so going to
 * Meditate and back does not cost the arrangement someone set up for a sit.
 */
let panelsBeforeMeditate = null;
/* Whether the last applyPlaceChrome ran in Train, so entering it can be told from being in it. */
let wasTraining = null;

/*
 * AUSTERITY APPLIES TO A WORKING SIT, NOT TO AN UNCONFIGURED APP.
 *
 * Meditate hides the metrics panel, and that panel is also where a fresh page says "No headband
 * connected — press Connect". Stripping it unconditionally would have recreated the exact defect that
 * message was written for: "i dont see any panels. do i need to connect in order to see the metrics?",
 * asked of a perfectly healthy app that said nothing anywhere on screen.
 *
 * So the mirror is only bare once there is something to mirror. With nothing connected, Meditate keeps
 * the panel and its explanation; the moment a headband is streaming, the numbers go away.
 */
function meditateIsBare() { return museConnected() || strapConnected(); }

/*
 * HOW TALL THE CONTROL BAR IS, as a CSS variable.
 *
 * The docked columns in Train have to stop above it, and its height is not a constant: it holds three
 * labelled groups of pills that wrap onto a second row on a narrow window, and docking the columns makes
 * the middle narrower, which makes it wrap sooner. A hard-coded `bottom` was wrong at one width or the
 * other — the columns ran under the bar at 1440 and left a gap at 1920.
 *
 * Measured and published as --controlsH, so the CSS can subtract the real number.
 */
function publishControlsHeight() {
  const el = document.getElementById('controls');
  if (!el) return;
  const h = Math.round(el.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--controlsH', `${h}px`);
}
/* Re-measured when the bar itself changes shape, not on a timer. A ResizeObserver fires on wrap, on a
   pill appearing, and on a window resize — all three of which change the number. */
if (typeof ResizeObserver === 'function') {
  const ctrl = document.getElementById('controls');
  if (ctrl) new ResizeObserver(publishControlsHeight).observe(ctrl);
}

function applyPlaceChrome() {
  document.body.classList.toggle('meditating', !trainingMode);
  document.body.classList.toggle('training', trainingMode);
  // Drives the CSS that keeps the explanation visible in Meditate before a connection.
  document.body.classList.toggle('preflight', !meditateIsBare());
  /*
   * THE KEY COMES OFF THE MIRROR IN MEDITATE.
   *
   * The visual draws its own legend onto the canvas — the four channel names, and a line or two saying
   * what the shapes mean ("void grows — settling", "corona reaches out — thinking"). Hiding the panels
   * and leaving that behind misses the point entirely: it is a running commentary telling you how to
   * read your own state, printed over the thing that is supposed to be a mirror. It also cannot be
   * hidden with CSS, because it is painted into the canvas.
   *
   * In Train it stays. Naming what is drawn is exactly right when the screen is an instrument, and
   * VizCore.legendFor exists so a mode can never draw a key that disagrees with what it plotted.
   */
  /*
   * TRAIN OPENS ON FLOW. Asked for: "for the training the visual should open on flow."
   *
   * It is the right default for the place: Flow is the only visual that plots the four electrodes and the
   * composites AS LINES OVER TIME, which is what an instrumented screen is for. The others are washes that
   * say how it is going now, which is what Meditate is for. Done once per entry into Train rather than on
   * every render, so choosing a different visual while in Train sticks.
   */
  if (trainingMode && !wasTraining && typeof visual !== 'undefined' && visual.setModeByKey) {
    visual.setModeByKey('flow');
    /* AND ON THE COMPOSITES, which is what the mockup's centre chart plots — its key reads Calm, Focus,
       Thinking, Drowsy, Breath. The per-sensor traces are what the live feed below is for, so the two
       charts show different things instead of the same thing twice. */
    viewMode = 'composites';
    visual.setSeries(viewMode);
    renderViewSwitch();
    renderLegend();
    renderChart();
    renderBarModes();
  }
  /*
   * AND MEDITATE OPENS ON RIBBON, the same way and for the opposite reason.
   *
   * Asked for: "make a new visual and make it the default for meditate". Ribbon is what a fresh page
   * already opens on — it is first in VizCore.MODES — but coming BACK from Train would otherwise leave
   * Flow on screen, and Flow is an instrument: a plotted grid of four lines is the wrong thing to sit in
   * front of with your eyes closing.
   *
   * `wasTraining === true` rather than `!wasTraining`, so this fires only on the way OUT of Train and not
   * on the first render of the page — which would fight the boot default and, worse, would re-assert
   * itself on every later render and undo choosing a different visual while meditating.
   */
  if (!trainingMode && wasTraining === true && typeof visual !== 'undefined' && visual.setModeByKey) {
    visual.setModeByKey('ribbon');
    renderBarModes();
  }
  wasTraining = trainingMode;
  if (typeof visual !== 'undefined' && visual.setLegend) {
    visual.setLegend(trainingMode);
    /* And keep it clear of the mark rail, which occupies the left edge in Train. Measured from the
       element rather than hard-coded, so the two cannot disagree after a CSS change. */
    /* NO INSET ANY MORE, and this is a consequence of the layout change worth stating. The inset existed
       because the canvas covered the whole viewport, so the legend it painted at its own top-left landed
       on top of the mark rail. The canvas now BEGINS where the rail ends, so its top-left is already
       clear — and keeping the inset counted the rail twice, pushing the key a rail's width into the
       middle of the visual. */
    if (visual.setLegendInset) visual.setLegendInset(0);
  }
  if (!trainingMode && meditateIsBare()) {
    // Remember once, on the way in — not on every render, or the remembered state becomes the
    // closed-for-meditation state and the arrangement is lost anyway.
    if (!panelsBeforeMeditate) {
      panelsBeforeMeditate = { metrics: metricsOpen, feed: feedOpen, visuals: visualsOpen };
    }
    metricsOpen = false; feedOpen = false; visualsOpen = false;
  } else if (trainingMode && panelsBeforeMeditate) {
    metricsOpen = panelsBeforeMeditate.metrics;
    feedOpen = panelsBeforeMeditate.feed;
    visualsOpen = panelsBeforeMeditate.visuals;
    panelsBeforeMeditate = null;
  }
  updatePanelVisibility();
  publishControlsHeight();
}

function setTrainingMode(on) {
  const wasOn = trainingMode;
  trainingMode = !!on;
  renderPlaces();
  renderArmedBar();
  renderMarkCount();
  /* AFTER renderArmedBar, not before. applyPlaceChrome measures the mark rail to keep the visual's
     legend clear of it, and renderArmedBar is what unhides the rail — so measuring first read a hidden
     element as zero-width and the legend landed back on top of it. */
  applyPlaceChrome();
  /* TURNING TRAINING ON STARTS RECORDING.
   * Training mode exists to gather data, and every label it collects is worthless if
   * nothing is saving them. This is the exact failure that already happened once: a
   * whole sit was tapped through with training on and nothing armed, and the marks
   * looked identical to saved ones because markerLog.add always succeeds.
   *
   * Turning it OFF deliberately does not stop recording. Stopping is what packages the
   * sit and opens the summary, and having that happen as a side effect of tidying the
   * screen mid-sit would be worse than the problem it solves. The Record pill remains
   * the one thing that ends a recording.
   */
  if (trainingMode && !wasOn && !recArmed && !recError) {
    /* Awaited via then, and the message only claims success if recording actually
       started. startRecording refuses the first press when no device is connected, so
       announcing "recording started" unconditionally would have been a lie in exactly the
       situation the refusal exists to catch — and it would have overwritten the refusal's
       own message, which is the one worth reading. */
    startRecording().then(() => {
      if (!recArmed) return;      // refused: its own message and tone stand
      setStatus('training on · recording started');
      statusLockUntil = Date.now() + 2600;
    });
  }
  const el = document.getElementById('trainToggle');
  if (el) {
    el.innerHTML = `Training: ${trainingMode ? 'on' : 'off'}<kbd>\u21e7T</kbd>`;
    // The word changed but the pill did not light up, so at a glance — which is the
    // only kind of glance available mid-sit — the bar looked the same either way.
    // Every other stateful pill here carries `.active`; this one was simply missed.
    el.classList.toggle('active', trainingMode);
  }
}

function markerContextFor(m) {
  return Markers.contextAround(m, sessionLog, { windowSec: 30 });
}

let settledStreakFrom = 0;  // when the current settled stretch began
let recentReturns = 0;      // spikes since the last cue — "coming back" count
let lastDataAt = 0;

// Breathing, from the Muse's PPG (heart) sensor rather than EEG — heart
// rate subtly speeds up on the inhale and slows on the exhale (respiratory
// sinus arrhythmia), which is a real, physical signature of your actual
// breath, not a guess. 'infrared' is the PPG channel typically carrying
// the clearest pulse waveform; red/ambient are available if it's worth
// trying as an alternative later.
const PPG_CHANNEL_INDEX = DSP.PPG_CHANNEL_NAMES.indexOf('infrared');
const PPG_WINDOW_SEC = 90;   // how much history the breathing estimate looks at
const PPG_MIN_SEC = 40;      // don't attempt an estimate on less than this much data
let ppgBuffer = [];
let ppgAvailable = false;
let breathPeriod = null;     // seconds per breath, or null until confidently estimated

function pushPPGSamples(raw) {
  ppgBuffer.push(...raw);
  const cap = PPG_WINDOW_SEC * DSP.PPG_FREQUENCY;
  if (ppgBuffer.length > cap) ppgBuffer.splice(0, ppgBuffer.length - cap);
}

function updateBreathing() {
  if (ppgBuffer.length < PPG_MIN_SEC * DSP.PPG_FREQUENCY) return;
  const beats = DSP.detectBeats(ppgBuffer, DSP.PPG_FREQUENCY);
  const period = DSP.estimateBreathingPeriod(beats);
  if (period != null) {
    breathPeriod = period;
    visual.setBreathPeriod(period);
  }
}

// Tracks what fraction of recent windows were artifact-flagged, so a single
// blink doesn't flash a warning but sustained talking/jaw tension does.
let artifactRate = 0;

function pushSamples(channelIndex, microvolts) {
  // THE RAW SIGNAL, saved before anything derives anything from it. Every
  // composite in metrics.js will change; raw EEG is the only thing that stays
  // comparable across those changes, and it is ~10MB for a 40-minute sit.
  if (recSession) recSession.pushEeg(channelIndex, microvolts);
  else ensureRecording();
  alphaAccum[channelIndex].push(microvolts);
  const buf = buffers[channelIndex];
  buf.push(...microvolts);
  if (buf.length > WINDOW * 2) buf.splice(0, buf.length - WINDOW * 2); // bound memory
  lastDataAt = Date.now();
}

function computeCalm() {
  const ready = FRONTAL.every((ch) => buffers[ch].length >= WINDOW);
  if (!ready) return null;

  const windows = FRONTAL.map((ch) => buffers[ch].slice(-WINDOW));
  const artifact = windows.some((w) => DSP.isArtifact(w));
  artifactRate += 0.2 * ((artifact ? 1 : 0) - artifactRate);

  if (artifact) {
    return {
      calm: tracker.update(null), ratio: null, artifact, artifactRate,
      activity: activityTracker.update({ artifact: true }),
    };
  }

  let alphaSum = 0, betaSum = 0;
  for (const window of windows) {
    const powers = DSP.bandPowers(window, DSP.EEG_FREQUENCY);
    alphaSum += powers.alpha; betaSum += powers.beta;
  }
  /* THE RATIO COMES FROM THE 16-SECOND AVERAGE, not from this one window.
     Calm is the headline number and the thing that drives the visual, so it is the number the
     volatility report was about. A one-second estimate of this ratio carries 1.89 log units of noise
     against 0.69 for a doubling of alpha — see DSP.BAND_AVERAGE_SEC. The instantaneous windows above
     are still computed, because artifact detection and the per-channel labels genuinely want to react
     within a second; only the SCORE is slow.
     One tick stale, because the averager is fed from computeFeatures() which runs just after this. At
     4Hz against a 16-second window that is 1.5% of the span and not worth restructuring the tick for. */
  const averaged = bandAverager.mean(Date.now() / 1000);
  const useAveraged = averaged && averaged.seconds >= BAND_AVERAGE_MIN_SEC;
  const ratio = useAveraged
    ? Math.log(averaged.alpha + 1e-6) - Math.log(averaged.beta + 1e-6)
    : Math.log(alphaSum / FRONTAL.length + 1e-6) - Math.log(betaSum / FRONTAL.length + 1e-6);

  /*
   * AN ABSOLUTE SCORE, ALONGSIDE THE NORMALISED ONE.
   *
   * Asked, and correctly: "i'm not convinced that we should be normalizing everything. maybe that's
   * what accounts for all the jumpy lines. if it wasn't normalized it would be a better indicator when
   * i'm generally calm thruout a sit, right?" Yes. Measured across seven real sits:
   *
   *   what the sit was                       displayed Calm    raw AF7/AF8 alpha/beta
   *   "relaxed, mind settling naturally"          45.9               0.654
   *   "very calm, not a lot of effort"            42.3               0.537
   *   "working, not meditating"                   46.4               0.367
   *   "thinking pulling me a lot"                 52.9               0.288
   *
   * The displayed score spanned 42.3 to 52.9 across ALL SEVEN sits while the raw ratio spanned 0.288
   * to 0.654 — and their rank correlation was MINUS 0.32. The best sit showed 45.9 and the worst
   * showed 52.9. The normaliser subtracts the sit's own running mean, so a uniformly calm sit and a
   * uniformly agitated one both land near 50 by construction, and whatever ordering survives is noise.
   *
   * This is alpha's SHARE of alpha plus beta, as a percentage. It needs no calibration and has no free
   * parameter: 50 means equal alpha and beta power, in every sit, for every person. It is the quantity
   * that ordered those four sits perfectly, and it is bounded without anything being clipped.
   *
   * Its practical range is NARROW — 24% to 38% across these sits — and that is the honest fact rather
   * than a defect to be stretched out. A display that uses a third of its range because the signal uses
   * a third of its range is telling the truth; one that fills the range regardless is what produced
   * the numbers above.
   *
   * Both are kept, for now, because the normalised one has a real use the absolute one does not: it is
   * sensitive to change WITHIN a sit, which is what makes a live visual respond at all. The
   * unambiguous mistake was presenting the relative number as if it were absolute.
   */
  const absAlpha = useAveraged ? averaged.alpha : alphaSum / FRONTAL.length;
  const absBeta = useAveraged ? averaged.beta : betaSum / FRONTAL.length;
  const calmAbs = (absAlpha + absBeta) > 0 ? absAlpha / (absAlpha + absBeta) : null;
  const activity = activityTracker.update({
    betaLog: Math.log(betaSum / FRONTAL.length + 1e-6),
    ratio,
    artifact: false,
    spiked: bandState.some((b) => b.spike > 0.9),
  });
  return { calm: tracker.update(ratio), calmAbs, ratio, artifact, artifactRate,
    alphaSum, betaSum, activity };
}

// Raw per-sensor readout — all 4 electrodes individually (TP9/TP10 behind
// the ears, AF7/AF8 frontal), not just the frontal pair the composite Calm
// score is built from. Purely informational: which band currently
// dominates at each electrode, or "Noisy" if that channel's own window is
// artifact-flagged. TP9/TP10 sit near the jaw/ear and are more artifact
// prone than the frontal pair — expect them to say "Noisy" more often.
// `pct` is alpha's share of alpha+beta power (0-1) — already a bounded
// ratio, so it doubles as this channel's "band level" for the visual
// without needing a separate adaptive normalizer.
function computeChannelLabels() {
  return DSP.CHANNEL_NAMES.map((name, ch) => {
    const buf = buffers[ch];
    if (buf.length < WINDOW) return { name, label: '…', pct: null, artifact: false };
    const window = buf.slice(-WINDOW);
    /* SAY HOW BAD, not just that it is bad.
     *
     * Asked directly, of two channels reading "Noisy" for a whole sit: "but why's it
     * dead at all?" — and the app could not answer, because "Noisy" covers two
     * completely different situations with completely different fixes:
     *
     *   ~150-600µV   the electrode IS touching skin and picking up muscle, jaw,
     *                swallowing, or movement. Fixable by sitting differently, and a
     *                sign the threshold might be too tight for a temporal channel.
     *   >600µV       the electrode is floating. A disconnected input on the Muse rails
     *                toward the ends of its ±1000µV range, so this is not "noise" in
     *                any useful sense — it is no contact, and no amount of sitting
     *                still will fix it. Wet the spot behind the ear and reseat the band.
     *
     * The number is reported too, because a channel sitting at 160µV all sit is a
     * question about the 150µV threshold, and one sitting at 900µV is not.
     */
    const ptp = DSP.peakToPeak(window);
    /* SILENT IS ALSO BROKEN — see DSP.isFlat. A channel delivering flat zeros used to be
     * labelled "Beta" with a level of 0, because the only amplitude test was an upper
     * bound. Reported through its consequence: the Flow axis being dragged down by a
     * fabricated floor. `artifact: true` so everything downstream that already knows to
     * exclude an untrustworthy channel keeps working; the label says which fault it is. */
    if (DSP.isFlat(window)) {
      return { name, label: 'No signal', pct: null, artifact: true, ptp,
        floating: false, flat: true };
    }
    if (DSP.isArtifact(window)) {
      const floating = ptp > DSP.ARTIFACT_PTP_UV * 4;
      return { name, label: floating ? 'No contact' : 'Noisy', pct: null,
        artifact: true, ptp, floating, flat: false };
    }
    const powers = DSP.bandPowers(window, DSP.EEG_FREQUENCY);
    const pct = powers.alpha / (powers.alpha + powers.beta + 1e-9);
    return { name, label: powers.alpha > powers.beta ? 'Alpha' : 'Beta', pct,
      artifact: false, ptp, floating: false, flat: false };
  });
}

// Per-channel "band" state for the visual: a smoothed level (0-1, how
// alpha-heavy that electrode currently reads) and a decaying spike value —
// triggered by a sudden, large shift in that channel's own alpha/beta
// balance. This is what "a spike that reflects thinking" maps onto: a real,
// fast change in that electrode's brainwave balance, not a guess. Artifact-
// flagged ticks are excluded from spike detection on purpose — a blink or
// jaw clench isn't a thought, and treating it like one would be dishonest.
// DSP.SpikeDetector (tested — see test-dsp.js) compares against a slow
// baseline rather than the raw previous tick, which is what fixed a real
// bug: at 250ms sampling, ordinary tick-to-tick EEG jitter alone cleared a
// naive previous-tick threshold almost every tick (a wall of white/black
// static on real hardware, not the occasional flash it was meant to be).
const bandLevel = DSP.CHANNEL_NAMES.map(() => 0.5);
const bandFresh = DSP.CHANNEL_NAMES.map(() => false);
const bandSpikeDetector = DSP.CHANNEL_NAMES.map(() => new DSP.SpikeDetector());
const bandState = DSP.CHANNEL_NAMES.map((_, i) => ({
  get level() { return bandLevel[i]; },
  get fresh() { return bandFresh[i]; },
  get spike() { return bandSpikeDetector[i].spike; },
}));

function updateBandState(channels) {
  channels.forEach((ch, i) => {
    if (ch.pct != null && !ch.artifact) {
      bandLevel[i] = ch.pct;
      bandFresh[i] = true;
      bandSpikeDetector[i].update(ch.pct);
    } else {
      bandFresh[i] = false;
      bandSpikeDetector[i].update(null); // still decays the spike, just doesn't move the baseline
    }
  });
}

// Data visualization: every metric, over time, with everything toggleable
// and the whole module collapsible. Sampled at ~1/sec (not every 250ms
// tick) so a few minutes of history fits legibly on one small chart.
// Two series sets. Sensors = what the hardware actually reports. Composites =
// interpreted scores, each carrying its evidence tier (see metrics.js).
const rgbHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const SENSOR_SERIES = [
  { key: 'calm', label: 'Calm', color: '#f2c879' },
  { key: 'noise', label: 'Noise', color: '#e0697a' },
  // DERIVED from VizCore.CHANNEL_COLORS, never hand-copied. These had drifted:
  // AF8 was coral in the visual and green on the graph, TP10 mint in the visual
  // and blue on the graph — so a ribbon and its own line were different colours,
  // breaking the invariant viz-core explicitly documents. Deriving also fixed
  // TP9 and TP10 both being blue and only 54 apart in RGB.
  ...DSP.CHANNEL_NAMES.map((name, i) => ({
    key: name, label: name, color: rgbHex(VizCore.CHANNEL_COLORS[i]),
  })),
];
const COMPOSITE_COLORS = {
  // Every pair must be TELLABLE APART — test-ui.js enforces a minimum RGB
  // separation. This palette had three collisions that all shipped: breath was
  // 17 from focus (so a correctly-drawn line was invisible on top of another
  // one), equanimity 31 from blink, and hrv 51 from jaw. A line you cannot
  // distinguish is worse than an absent one, because you conclude the metric is
  // broken. Closest pair is now 77.
  calm: '#f2c879',        // gold
  thinking: '#ff7dab',    // pink
  focus: '#7dd3fc',       // light blue
  drowsy: '#9b8cff',      // violet
  hrv: '#c2410c',         // burnt orange — moved off calm's gold
  equanimity: '#8fe3a8',  // mint
  asymmetry: '#c0b3ff',
  openness: '#ffd9a0',
  // Blinks and jaw are ARTIFACTS, not mind states. Desaturated on purpose so
  // they read as "this is interference" rather than as another thing you are
  // doing with your mind.
  blink: '#696464',       // neutral grey
  jaw: '#7396a0',         // slate
  // White, and deliberately the most visible line on the chart: breath is a
  // PHASE oscillating about a midpoint rather than a level, so it is a different
  // kind of thing from the others and should read that way.
  breath: '#ffffff',
};
const COMPOSITE_SERIES = activeComposites.concat(CHART_ONLY_COMPOSITES).map((k) => ({
  key: k, label: Metrics.get(k).label, color: COMPOSITE_COLORS[k] || '#cccccc',
}));
const CHART_SERIES = [...SENSOR_SERIES, ...COMPOSITE_SERIES.filter(
  (c) => !SENSOR_SERIES.some((s) => s.key === c.key))];
function visibleSeries() {
  return viewMode === 'sensors' ? SENSOR_SERIES : COMPOSITE_SERIES;
}
const HISTORY_LEN = 180; // ~3 minutes at 1 sample/sec
const histories = {};
CHART_SERIES.forEach((s) => { histories[s.key] = new Chart.History(HISTORY_LEN); });
const seriesEnabled = {};
CHART_SERIES.forEach((s) => { seriesEnabled[s.key] = true; });

const chartCanvas = document.getElementById('chartCanvas');
const chartCtx = chartCanvas.getContext('2d');
const legendEl = document.getElementById('legend');
const dataToggleEl = document.getElementById('dataToggle');
const dataPanelEl = document.getElementById('dataPanel');
const btnMetricsEl = document.getElementById('btnMetrics');
const btnFeedEl = document.getElementById('btnFeed');
const btnVisualsEl = document.getElementById('btnVisuals');
let metricsOpen = true;
let feedOpen = false;
let visualsOpen = false;

function updatePanelVisibility() {
  readoutEl.classList.toggle('panelClosed', !metricsOpen);
  dataPanelEl.classList.toggle('panelClosed', !feedOpen);
  /* ON THE BODY TOO, so the layout can react. In Train the timeline is a band at the foot of the centre
     cell rather than a panel floating over it, which means the visual above it has to give up exactly
     that much height — and CSS can only know to do that from a class it can select on. */
  document.body.classList.toggle('feedOpen', feedOpen);
  document.body.classList.toggle('metricsOpen', metricsOpen);
  modeBarEl.classList.toggle('open', visualsOpen);
  btnMetricsEl.classList.toggle('active', metricsOpen);
  btnFeedEl.classList.toggle('active', feedOpen);
  btnVisualsEl.classList.toggle('active', visualsOpen);
  dataToggleEl.textContent = 'Live feed';
  renderModeBar();
}

/*
 * WHAT THE VERTICAL AXIS MEANS, said on the chart rather than in a source comment.
 *
 * The mockup carries the line "Each line shows change within its own recent range", which was the
 * honest description of a chasing baseline. Now that the baseline holds, the sentence has to change
 * with it — and it has to say WHICH state it is in, because "still learning the scale" and "scale
 * fixed" support different readings of the same line. During the first two minutes a rise can be the
 * baseline moving; after it, a rise is the signal.
 */
function chartScaleNote() {
  if (!tracker.held) {
    const left = Math.max(0, DSP.BASELINE_HOLD_UPDATES - tracker.clean);
    return `Finding the scale for this sit — about ${Math.ceil(left / 4)}s of clean signal to go. `
      + `Until then a line can move because the scale is still settling.`;
  }
  return 'Each line is scaled to this sit’s first two minutes, and that scale is now fixed — '
    + 'a line moves only if the signal moved. Not comparable with another sit.';
}

function renderLegend() {
  legendEl.innerHTML =
    visibleSeries().map((s) =>
      `<span class="legendItem${seriesEnabled[s.key] ? '' : ' off'}" data-key="${s.key}">` +
      `<span class="swatch" style="background:${s.color};color:${s.color}"></span>${s.label}</span>`
    ).join('')
    + `<div id="chartScale">${escapeHtml(chartScaleNote())}</div>`;

  legendEl.querySelectorAll('.legendItem').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      if (viewMode === 'composites') {
        // In composite view, clicking picks which one drives the visual.
        primaryMetric = key;
        seriesEnabled[key] = true;
      } else {
        seriesEnabled[key] = !seriesEnabled[key];
      }
      renderLegend(); renderChart();
    });
  });
}

// The honesty panel: what each score is computed from, and what it cannot tell
// you. Reachable from the legend so it is never more than one click away from
// the number itself.
function showMetricInfo() {
  summaryTitleEl.textContent = 'What these scores are — and are not';
  const rows = Metrics.METRICS.map((m) => {
    const t = Metrics.tierInfo(m.tier);
    const mark = m.tier === 'solid' ? '●' : m.tier === 'moderate' ? '◐' : '○';
    /* SAY WHICH ARE NOT ON SCREEN. This panel lists every metric, so without a note it implies all
       of them are being shown — and two have been retired from the display on the strength of their
       own caveats. Retired is not deleted: the lab still computes them from the raw EEG. */
    const retired = m.display === false
      ? ' <span style="opacity:.5">(not on the live display — still computed in the lab)</span>' : '';
    return `<div style="text-align:left;margin-bottom:16px;max-width:620px">`
      + `<div><b>${mark} ${m.label}</b> <span style="opacity:.55">— ${t.label}</span>`
      + `${m.key === primaryMetric ? ' <span style="opacity:.5">(driving the visual)</span>' : ''}`
      + retired + `</div>`
      + `<div class="subtle" style="max-width:620px">From: ${m.source}</div>`
      + `<div class="subtle" style="max-width:620px">Caveat: ${m.caveat}</div></div>`;
  }).join('');
  summaryBodyEl.innerHTML =
    `<div class="subtle" style="max-width:620px;margin-bottom:18px">`
    + `Nothing here is a validated instrument. "Calm" is alpha minus beta at the two `
    + `forehead sensors, scaled to this sit's first two minutes — a common relaxation index, `
    + `but the weights and thresholds were chosen by hand and have never been checked `
    + `against ground truth. Only the blink and jaw signatures are direct measurements. `
    + `<b>Every score here is relative to how this sit started</b>, and that scale is fixed `
    + `once two minutes of clean signal have gone by, so a number that moves afterwards `
    + `moved because the signal did. It still cannot be compared with another sit: two sits `
    + `that started differently have different zeroes. Alpha share, breaths per minute, `
    + `heart rate and HRV are the only readings on this screen that mean the same thing `
    + `on Tuesday and Thursday. `
    + `Establishing real validity would need labelled sessions to compare against, `
    + `which is a project rather than a code change.</div>`
    + rows
    + `<div style="margin-top:10px"><span class="pill" id="sumClose">Close</span></div>`;
  summaryEl.classList.add('show');
  document.getElementById('sumClose').addEventListener('click', closeSummary);
}

function renderChart() {
  /* Refreshed HERE, not in renderLegend. The legend is rebuilt only on a click, so a note
     written there would still say "finding the scale" an hour into the sit. This runs once
     a second with the samples. */
  const noteEl = document.getElementById('chartScale');
  if (noteEl) noteEl.textContent = chartScaleNote();
  const w = chartCanvas.width, h = chartCanvas.height;
  chartCtx.clearRect(0, 0, w, h);
  chartCtx.strokeStyle = 'rgba(255,255,255,.08)';
  chartCtx.lineWidth = 1;
  [0, 0.5, 1].forEach((f) => {
    const y = h * f;
    chartCtx.beginPath(); chartCtx.moveTo(0, y); chartCtx.lineTo(w, y); chartCtx.stroke();
  });
  /*
   * MARKS ON THE TIMELINE, drawn before the traces so a line crosses a tick rather than being hidden by
   * it. Asked for: "What about the marks showing up in the timeline?"
   *
   * Placed by AGE, in the same units the series are: the chart holds HISTORY_LEN samples at about one a
   * second, right-aligned to now, so a mark made `age` seconds ago sits `age` samples left of the head.
   * That is the same mapping Chart.seriesToPoints uses, which is why a tick lands under the moment it
   * describes instead of near it.
   *
   * A mark older than the window is simply not drawn. It is still in the rail's list and still in the
   * file — the chart is three minutes of history, not the record.
   */
  {
    const nowSec = sessionTSec();
    for (const m of markerLog.list()) {
      const age = nowSec - m.tSec;
      if (!Number.isFinite(age) || age < 0 || age > HISTORY_LEN - 1) continue;
      const x = ((HISTORY_LEN - 1 - age) / (HISTORY_LEN - 1)) * w;
      /* Coloured by kind where the kind has a colour on this chart already, so a Thinking tick and the
         Thinking line agree — the invariant the electrode colours are derived rather than copied for. */
      const col = COMPOSITE_COLORS[m.kind === 'lost' ? 'thinking' : m.kind] || 'rgba(255,255,255,.5)';
      chartCtx.strokeStyle = col;
      chartCtx.globalAlpha = 0.5;
      chartCtx.lineWidth = 1;
      chartCtx.beginPath();
      chartCtx.moveTo(Math.round(x) + 0.5, 0);
      chartCtx.lineTo(Math.round(x) + 0.5, h);
      chartCtx.stroke();
      // A cap at the top, so a tick is findable against four traces without being a solid bar.
      chartCtx.globalAlpha = 0.95;
      chartCtx.fillStyle = col;
      chartCtx.fillRect(Math.round(x) - 1.5, 0, 4, 3);
      chartCtx.globalAlpha = 1;
    }
  }

  for (const s of visibleSeries()) {
    if (!seriesEnabled[s.key]) continue;
    const pts = Chart.seriesToPoints(histories[s.key].values, w, h, HISTORY_LEN);
    // One path per contiguous run, so a gap is a GAP. Drawing straight through the
    // nulls would join either side with a line that asserts values nobody measured.
    chartCtx.strokeStyle = s.color;
    chartCtx.lineWidth = 1.5;
    for (const run of Chart.segments(pts)) {
      if (run.length < 2) continue;
      chartCtx.beginPath();
      run.forEach(([x, y], i) => (i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y)));
      chartCtx.stroke();
    }
  }
}

function sampleHistory(result, channels) {
  histories.calm.push(Math.round(result.calm * 100));
  histories.noise.push(Math.round(result.artifactRate * 100));
  /* NO READING PUSHES NULL, AND THE LINE BREAKS. It used to hold the previous value,
   * or 50 if there had never been one — which is how "TP10's electrode is not touching
   * my head" was drawn as a perfectly flat line through the middle of the chart,
   * indistinguishable from a rock-steady, perfectly balanced channel. That is the most
   * confident-looking line on the graph and it came from no data at all.
   *
   * Holding across a brief dropout is not much better: a bridged gap asserts values
   * nobody measured, and on the temporal channels — which are artifact-flagged much of
   * the time — the bridges are long. A break is true, and a one-second gap in a 1Hz
   * series is barely visible anyway. */
  for (const ch of channels) {
    histories[ch.name].push(ch.pct != null ? Math.round(ch.pct * 100) : null);
  }
  // Composites: same rule. A metric with no inputs yields null and graphs as a gap
  // rather than as a fabricated zero OR a held-over previous value.
  for (const c of COMPOSITE_SERIES) {
    if (c.key === 'calm' || c.key === 'noise') continue;
    const h = histories[c.key];
    if (!h) continue;
    const v = Metrics.compute(c.key, features);
    h.push(v == null ? null : Math.round(v * 100));
  }
  renderChart();
}

dataToggleEl.addEventListener('click', () => {
  feedOpen = !feedOpen;
  updatePanelVisibility();
});
btnMetricsEl.addEventListener('click', () => {
  metricsOpen = !metricsOpen;
  updatePanelVisibility();
});
btnFeedEl.addEventListener('click', () => {
  feedOpen = !feedOpen;
  updatePanelVisibility();
});
btnVisualsEl.addEventListener('click', () => {
  visualsOpen = !visualsOpen;
  updatePanelVisibility();
});
updatePanelVisibility();
renderLegend();

let device = null;

/* ---- Polar H10 chest strap -------------------------------------------------
 * A SECOND, INDEPENDENT Bluetooth device. Web Bluetooth allows this: each
 * requestDevice() needs its own user gesture, which is why this has its own
 * button and cannot be chained off the Muse connection, and each returns its own
 * GATT connection. The two devices do not contend for anything.
 *
 * Deliberately optional in both directions: no strap and the EEG side behaves
 * exactly as before; a strap that drops out mid-session disturbs nothing.
 */
const rrBuffer = new Polar.RrBuffer({ windowSec: 60 });
const steadiness = new Polar.SteadinessTracker();
// RMSSD in ms varies enormously between people (roughly 10ms to 100ms+ at rest),
// so an absolute number cannot drive a 0..1 visual. Normalised against the
// wearer's own baseline, same discipline as every EEG-derived score.
// Holds with the rest, but keeps its own faster adapt and steeper slope: RMSSD spans
// roughly 10ms to 100ms+ between people, so its baseline has further to travel before the
// scale is usable at all.
const hrvNorm = new DSP.AdaptiveNormalizer(
  Object.assign({ adapt: 0.004, slope: 1.6, smoothing: 0.08 }, HOLD));
let strapDevice = null;
let hrBpm = null;          // the strap's own HR field
let hrvRmssd = null;       // ms, over the rolling window
let hrvLevel = null;       // 0..1, normalised to this wearer
let hrvSteady = null;      // 0..1, how steady the HRV is
let strapBreathSec = null; // breathing from RSA — cleaner than temple PPG
let strapContact = null;
let strapLastAt = 0;
let breathAmount = null;   // -1 exhaled .. 0 mid .. +1 inhaled, or null
let breathRising = null;

/* --- Chest-wall motion from the strap's accelerometer (PMD) ----------------
 * Optional and additive: if any of this fails the RSA breath path is untouched.
 * See docs/polar-pmd.md. The decode CANNOT be trusted from code review — a wrong
 * delta decode yields smooth plausible numbers — so accMag below is surfaced in
 * the readout and must read ~1000 mG at rest. That is the actual test.
 */
let accAvailable = false;
/* WHICH characteristic answered, or null. Written into the archive, because a file with no head
   motion in it must be distinguishable from a device that has none. */
let headAccChar = null;
let headAccSamples = [];   // recent {x,y,z} in mG from the HEADBAND (not the chest strap)
let headAccCount = 0;

/*
 * Head motion in, straight through to storage.
 *
 * Nothing live is derived from it yet, on purpose. The measurement it is for — whether stillness and
 * movement smoothness separate a settled sit from a busy one — is an analysis question with no
 * validated answer, and inventing a live "stillness score" before testing one would be exactly the
 * habit that produced the coefficients this project spent a day removing. Captured now so the question
 * becomes answerable; displayed only once something is known.
 */
function pushHeadAcc(samples, rawBytes) {
  if (!samples || !samples.length) return;
  headAccCount += samples.length;
  headAccSamples.push(...samples);
  if (headAccSamples.length > 512) headAccSamples.splice(0, headAccSamples.length - 512);
  if (recSession) recSession.pushHeadAcc(samples, rawBytes);
}

let accSamples = [];        // recent {x,y,z} in mG from the CHEST STRAP (breathing)
let accMag = null;          // mean magnitude, the gravity check
let accVerdict = null;      // { meanMilliG, ok } from Polar.looksLikeGravity
let accSettings = null;
// Why PMD didn't start, shown ON SCREEN. Asking someone to open DevTools during a
// meditation session is not a diagnostic strategy.
let accError = null;
// Diagnostics that distinguish the failure modes from each other. "reading…" was
// ambiguous: it meant "no frames yet" and "frames arriving that will not decode"
// and "the device rejected our start request" all at once.
let accFrames = 0;        // notifications received
let accDecoded = 0;       // notifications that produced samples
let accStartError = null; // error code the device returned for the START command
let accFirstHead = null;  // [measurementType, frameType] of the first frame
let accVariant = null;    // which start-request shape the device accepted
let accTried = [];        // ['50hz/r2/b16/count8:5', …] — the search, for reporting
let accFeatures = null;   // the control point's advertised measurement types
let accSettingsError = null;
// Notifications on the control point that did NOT carry the 0xF0 response marker.
// Counted rather than parsed, because reading byte 3 of a non-response and calling
// it an error code invents a number and attributes it to the device.
let accNonResponses = 0;
let pendingStartResolve = null;
const accFrameLog = [];     // first few raw frames, hex, for diagnosis
const ACC_LOG_FRAMES = 6;
const ACC_KEEP = 600;       // ~12s at 50Hz

/*
 * Everything the strap said, in one copyable object.
 *
 * This exists because each round of protocol guesswork costs a physical reconnect
 * and a report typed out by hand, and the part that matters keeps getting lost in
 * the retelling — "refused 5" instead of the twenty bytes that explain why. One
 * button, one paste, no transcription.
 */
/*
 * Breathing from chest-wall motion. Fed from onAccData, consulted in the strap
 * tick. Takes precedence over RSA when it has a signal, because it does not lag
 * and because it can see a breath hold, which RSA cannot see at all.
 */
const accelBreath = Polar.AccelBreath();

/*
 * A saved breath orientation, applied once the accelerometer is actually running.
 *
 * Applied lazily rather than at construction because the sign only means something once
 * an axis has been chosen, and the axis is picked at runtime from whichever one carries
 * the respiratory power. Setting it before there is any data would latch an orientation
 * for an axis that has not been selected yet.
 */
let breathSignRestored = false;
function restoreBreathSign() {
  if (breathSignRestored) return;
  breathSignRestored = true;
  let saved = null;
  try { saved = localStorage.getItem('zenbio.breathSign'); } catch (err) { return; }
  const v = Number(saved);
  if (v === 1 || v === -1) accelBreath.setSign(v, { manual: true });
}
let accBreathEst = null;
let breathSource = null;    // 'chest' | 'rsa' | 'ppg' | null — shown, never guessed
let breathHolding = false;

const pmdLog = {
  featuresRaw: null, features: null,
  accSettings: null, accSettingsRaw: null,
  ecgSettings: null, ecgSettingsRaw: null,
  attempts: [], responses: [], frames: accFrameLog,
};

// The one-line verdict shown in the Chest row. A named function rather than an
// inline chain so test-ui.js can call the REAL branch order — a test that mirrors
// the branches passes happily while the app on screen says something else.
// Each branch names a DIFFERENT failure, because each has a different fix.
function accStatusText() {
  // Report the whole search, not just the last failure: which shapes were
  // refused and with what code is the information needed to fix it. The full
  // list is in the row's tooltip and the status bubble.
  if (accStartError && !accVariant) return `refused ${accStartError}`;
  if (accFrames === 0) return 'no frames';                     // accepted, silent
  if (accDecoded === 0) {                                      // arriving, undecodable
    return accFirstHead ? `${accFrames}f t${accFirstHead[0]}/${accFirstHead[1]}`
      : `${accFrames}f no decode`;
  }
  if (accMag == null) return 'decoding…';
  return `${Math.round(accMag)}mG ${accVerdict && accVerdict.ok ? '✓' : '✗ want 1000'}`;
}

function onAccData(ev) {
  const view = ev.target.value;
  accFrames++;
  if (accFirstHead == null && view.byteLength > 9) {
    accFirstHead = [view.getUint8(0), view.getUint8(9)];
  }
  if (accFrameLog.length < ACC_LOG_FRAMES) {
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    accFrameLog.push(Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' '));
    if (accFrameLog.length === ACC_LOG_FRAMES) {
      // Printed, not shown: this is for diagnosing a wrong decode, and it is not
      // something a meditator should ever see.
      console.log('[PMD] first ACC frames (hex):\n' + accFrameLog.join('\n'));
      console.log('[PMD] settings:', JSON.stringify(accSettings));
    }
  }
  const decoded = Polar.decodeAccFrame(view, {
    channels: accSettings && accSettings.channels ? accSettings.channels[0] : 3,
  });
  if (!decoded) return;
  accDecoded++;
  accSamples.push(...decoded.samples);
  if (accSamples.length > ACC_KEEP) accSamples.splice(0, accSamples.length - ACC_KEEP);
  const v = Polar.looksLikeGravity(accSamples.slice(-40));
  if (v) { accVerdict = v; accMag = v.meanMilliG; }
  // Only feed the breath estimator once the decode has been vouched for. Garbage
  // accelerations would still produce a confident-looking oscillation, and the
  // 16-million-mG episode is the reason that is not a hypothetical.
  if (accVerdict && accVerdict.ok) accelBreath.push(decoded.samples);
  if (recSession) recSession.pushAcc(decoded.samples);
}

// Optional PMD stream. Every step is allowed to fail: an older firmware, a
// refused control point, an unexpected response — none of it may disturb the
// HR/HRV path that already works.
async function tryStartAccelerometer(gatt) {
  try {
    const svc = await gatt.getPrimaryService(Polar.PMD_SERVICE);
    const ctl = await svc.getCharacteristic(Polar.PMD_CONTROL);
    const data = await svc.getCharacteristic(Polar.PMD_DATA);

    // 1) READ the control point before negotiating anything. Its value advertises
    //    which measurement types the device offers, which answers "does this H10
    //    do ACC at all" without a START — and if the answer is no, no request
    //    shape and no parameter value will ever work, so the search must not run.
    try {
      const fv = await ctl.readValue();
      accFeatures = Polar.parseFeatures(fv);
      pmdLog.featuresRaw = accFeatures && accFeatures.raw;
      pmdLog.features = accFeatures && accFeatures.types;
      console.log('[PMD] features:', accFeatures && accFeatures.raw, accFeatures && accFeatures.types);
    } catch (e) {
      pmdLog.featuresRaw = `read failed: ${(e && e.message) || 'unknown'}`;
      console.log('[PMD] feature read failed:', e && e.message);
    }

    // Ask the device what it supports rather than hardcoding. The spec is
    // explicit that the conversion factor is mandatory for correct values, so
    // guessing settings is not an option.
    await ctl.startNotifications();
    // A successful GATT write does NOT mean the command was accepted — the device
    // answers on the control point with an error code. Watch every response, not
    // just the settings one, or a rejected START looks identical to silence.
    let settingsResolve = null;
    let settingsWanted = Polar.PMD_TYPE_ACC;
    ctl.addEventListener('characteristicvaluechanged', (e) => {
      const r = Polar.parseControlResponse(e.target.value);
      console.log('[PMD] control response:', r && r.raw);
      if (!r) return;
      pmdLog.responses.push(r.raw);
      // The 0xF0 marker was being computed and then ignored. Without this check a
      // notification that is NOT a control response gets read as one, and its
      // byte 3 gets reported as an error code — a number that looks like the
      // device speaking when it is us misreading. Count them instead.
      if (!r.isResponse) { accNonResponses++; return; }
      if (r.command === Polar.PMD_CMD_GET_SETTINGS && r.measurementType === settingsWanted
          && settingsResolve) { const f = settingsResolve; settingsResolve = null; f(r); }
      if (r.command === Polar.PMD_CMD_START) {
        accStartError = r.errorCode || null;
        if (r.errorCode) console.log('[PMD] START rejected, error code', r.errorCode);
        if (pendingStartResolve) { const f = pendingStartResolve; pendingStartResolve = null; f(r); }
      }
    });

    // 2) Ask for ACC's settings, and for ECG's as a CONTROL. If ECG answers
    //    cleanly and ACC does not, the fault is ACC's availability rather than
    //    our request format — a distinction no amount of retrying ACC can make.
    const askSettings = async (type) => {
      settingsWanted = type;
      const seen = new Promise((resolve) => {
        settingsResolve = resolve;
        setTimeout(() => { if (settingsResolve === resolve) settingsResolve = null; resolve(null); }, 2500);
      });
      await ctl.writeValue(Polar.buildGetSettingsCommand(type));
      return seen;
    };
    const accResp = await askSettings(Polar.PMD_TYPE_ACC);
    accSettings = accResp ? accResp.settings : null;
    accSettingsError = accResp ? (accResp.errorCode || null) : 'timeout';
    pmdLog.accSettings = accSettings;
    pmdLog.accSettingsRaw = accResp ? accResp.raw : 'timeout';
    const ecgResp = await askSettings(0);
    pmdLog.ecgSettings = ecgResp ? ecgResp.settings : null;
    pmdLog.ecgSettingsRaw = ecgResp ? ecgResp.raw : 'timeout';

    // If the device advertises its types and ACC is absent, stop. Sweeping
    // parameters against a measurement the device does not have would produce a
    // long list of refusals that says nothing.
    if (accFeatures && accFeatures.looksValid && !accFeatures.types.includes('ACC')) {
      accAvailable = false;
      accError = 'no ACC on device';
      setStatus('this strap does not advertise an accelerometer over PMD — '
        + `it offers ${escapeHtml(accFeatures.types.join(', ') || 'nothing')}. Breath stays on RSA.`);
      statusLockUntil = Date.now() + 600000;
      console.log('[PMD] device does not advertise ACC; not attempting a start');
      return;
    }

    await data.startNotifications();
    data.addEventListener('characteristicvaluechanged', onAccData);

    // Stop any stream a previous page load left running. The device keeps
    // streaming after a browser tab goes away, and a measurement that is already
    // active cannot be started again. Errors here are expected and meaningless.
    try {
      await ctl.writeValue(Polar.buildStopCommand());
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) { /* nothing was running */ }

    /* 3) Send exactly the settings the device advertised.
     *
     * A real H10 answered GET SETTINGS with
     *   {sampleRate:[25,50,100,200], resolution:[16], range:[2,4,8]}
     * — three settings, no `channels`. Every earlier attempt had either included
     * `channels`, which the device never offered, or dropped `range`, which it
     * requires; none sent exactly those three. That is what the repeated refusal
     * was saying, and it took the settings response to hear it.
     *
     * So `include` comes from the response now, not from a guess. The shape ladder
     * stays as a fallback in case a different device advertises a different set,
     * and the value sweep behind it stays for the case where a *value* is refused.
     * The device answers every attempt, so this terminates either way.
     */
    const include = Polar.accStartSettingIds(accSettings);
    const params = Polar.accParamCandidates(accSettings);
    const channels = accSettings && accSettings.channels && accSettings.channels.length
      ? accSettings.channels[0] : 3;

    /* Two BOUNDED phases, not a cross product. Every combination of 5 shapes and
     * 12 value sets would be 60 writes and the better part of a minute with a
     * meditator sitting there waiting.
     *
     * Phase A: the device's own preferred values, against each request shape.
     * Phase B: only if all of A is refused, sweep values using the advertised
     *          shape — because at that point the shape is not the variable.
     */
    const plan = [];
    const best = params[0] || { sampleRate: 50, resolution: 16, range: 2 };
    for (const v of Polar.ACC_START_VARIANTS) {
      // The first variant means "exactly what this device advertised".
      const opts = v === Polar.ACC_START_VARIANTS[0] ? { include } : v.opts;
      const label = v === Polar.ACC_START_VARIANTS[0] ? `ids ${include.join('+')}` : v.label;
      plan.push({ pset: best, opts, label });
    }
    for (const pset of params.slice(1)) plan.push({ pset, opts: { include }, label: 'advertised' });

    accTried = [];
    for (const step of plan) {
      const cfg = Object.assign({ channels }, step.pset, step.opts);
      const answer = new Promise((resolve) => {
        pendingStartResolve = resolve;
        setTimeout(() => { pendingStartResolve = null; resolve(null); }, 900);
      });
      const bytes = Polar.buildAccStartCommand(cfg);
      await ctl.writeValue(bytes);
      const r = await answer;
      const code = r ? r.errorCode : 'timeout';
      const tag = `${step.pset.sampleRate}hz/r${step.pset.range}/b${step.pset.resolution}/${step.label}`;
      accTried.push(`${tag}:${code}`);
      pmdLog.attempts.push({
        tag,
        sent: Array.from(bytes).map((x) => x.toString(16).padStart(2, '0')).join(' '),
        code, raw: r ? r.raw : null,
      });
      console.log(`[PMD] start ${tag} -> ${code}`);
      if (r && !r.errorCode) { accVariant = tag; accStartError = null; break; }
      accStartError = code;
      try { await ctl.writeValue(Polar.buildStopCommand()); } catch (e) { /* expected */ }
    }
    accAvailable = true;
    accError = null;                 // clear a stale failure from an earlier attempt
    console.log('[PMD] tried:', accTried.join(', '), '| accepted:', accVariant || 'none');
    // A long diagnostic belongs in the wide status bubble, not a 128px table cell.
    if (!accVariant) {
      // The codes are what matter, and identical codes across the whole sweep is
      // itself the finding — so lead with the distinct set rather than 20 lines.
      const codes = Array.from(new Set(accTried.map((t) => t.split(':').pop())));
      setStatus(`chest sensor refused all ${accTried.length} attempts — code`
        + `${codes.length > 1 ? 's' : ''} ${escapeHtml(codes.map((c) => Polar.describeError(c)).join(', '))}`
        + ` | features: ${escapeHtml((accFeatures && accFeatures.raw) || 'unread')}`
        + ` | ACC settings: ${escapeHtml(pmdLog.accSettingsRaw || 'none')}`
        + ` | ECG settings: ${escapeHtml(pmdLog.ecgSettingsRaw || 'none')}`
        + ' — press "copy strap log" and send it');
      // Ten minutes: this is the one string needed to fix the protocol, and a
      // bubble that vanishes in 30 seconds is a bubble that gets missed.
      statusLockUntil = Date.now() + 600000;
    } else {
      setStatus(`chest sensor accepted ${escapeHtml(accVariant)} — make it the default`);
      statusLockUntil = Date.now() + 20000;
    }
  } catch (err) {
    accAvailable = false;
    // Trim to something that fits a narrow panel while still naming the cause.
    const m = (err && err.message) || 'unknown';
    accError = /Origin is not allowed/i.test(m) ? 'not permitted — reconnect'
      : /not found|No Services|no such/i.test(m) ? 'not supported'
      : /blocklist|SecurityError/i.test(m) ? 'blocked by browser'
      : /GATT/i.test(m) ? 'GATT busy — retry'
      : m.slice(0, 18);
    console.log('[PMD] accelerometer unavailable:', m);
  }
}

function onStrapData(ev) {
  const p = Polar.parseHeartRateMeasurement(ev.target.value);
  strapLastAt = Date.now();
  if (p.hr != null) hrBpm = p.hr;
  if (p.contact != null) strapContact = p.contact;
  let gotNew = false;
  for (const rr of p.rr) { if (rrBuffer.push(rr)) gotNew = true; }
  if (recSession && p.rr.length) recSession.pushRr(p.rr);
  if (!gotNew) return;

  // RMSSD needs a real window before it means anything. ~20 accepted intervals
  // is roughly 20 seconds; below that this stays null rather than reporting a
  // number derived from a handful of beats.
  if (rrBuffer.length >= 20) {
    hrvRmssd = Polar.rmssd(rrBuffer.values());
    if (hrvRmssd != null) {
      hrvLevel = hrvNorm.update(Math.log(hrvRmssd + 1e-6));
      hrvSteady = steadiness.update(hrvRmssd);
    }
    // Breathing from RSA on ECG-grade beat timing: the same computation as the
    // PPG path but much cleaner input, so this takes precedence when available.
    if (rrBuffer.length >= 40) {
      const est = DSP.estimateBreathingPeriod(rrBuffer.beatTimes());
      if (est != null) strapBreathSec = est;
      // WHERE in the breath, not just how fast. -1 fully exhaled .. +1 fully
      // inhaled. Null when there is no detectable respiratory modulation, which
      // is a real state (breath-holding, or a strap reading badly) and must not
      // be rendered as "at the midpoint".
      const ph = Polar.breathPhaseNow(rrBuffer.values());

      /* Chest motion first, heart timing second.
       *
       * The accelerometer is on the chest wall, so it sees the breath itself
       * rather than its effect on beat timing: no ~1s lag, and a breath HOLD is
       * visible because the chest actually stops. RSA cannot distinguish a hold
       * from no signal, which is why holding used to show nothing.
       *
       * But the accelerometer cannot know which direction is inhale — the strap
       * can be worn either way up, and magnitude is blind to sign. RSA can: heart
       * rate rises on inhalation. So RSA orients the accelerometer, and then the
       * accelerometer takes over. Each covers the other's blind spot.
       */
      if (accVerdict && accVerdict.ok) {
        restoreBreathSign();
        const rsaSeries = Polar.breathSignal(rrBuffer.values(), { hz: 5 });
        if (rsaSeries) accelBreath.resolveSign(rsaSeries);
        accBreathEst = accelBreath.estimate();
      } else {
        accBreathEst = null;
      }

      // `signKnown` matters: without it the bar would be a coin flip on which
      // side means inhale, so fall back to RSA rather than guess.
      if (accBreathEst && accBreathEst.signKnown
          && (accBreathEst.amount != null || accBreathEst.holding)) {
        breathAmount = accBreathEst.amount;
        breathRising = accBreathEst.rising;
        breathHolding = accBreathEst.holding;
        breathSource = 'chest';
        if (accBreathEst.bpm != null) strapBreathSec = 60 / accBreathEst.bpm;
      } else {
        breathAmount = ph ? ph.amount : null;
        breathRising = ph ? ph.rising : null;
        breathHolding = false;
        breathSource = ph ? 'rsa' : null;
      }
    }
  }
}

function strapConnected() {
  return !!(strapDevice && strapDevice.gatt && strapDevice.gatt.connected);
}
// Connected but not to be trusted: too many rejected intervals, or skin contact
// explicitly lost. Same rule as the EEG side — say so rather than quietly
// reporting numbers derived from bad input.
function strapUnreliable() {
  return strapConnected() && (rrBuffer.rejectRate() > 0.3 || strapContact === false);
}

async function connectStrap() {
  if (!navigator.bluetooth) { setStatus('Web Bluetooth is not available in this browser'); return; }
  if (strapConnecting || strapConnected()) return;
  strapConnecting = true;
  renderDevices();
  try {
    setStatus('choose your heart strap in the browser picker…');
    strapDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [Polar.HR_SERVICE] }],
      // MUST declare every service we intend to touch. Web Bluetooth grants access
      // per-service at pairing time, and anything not listed here — even on a
      // device you are already connected to — fails with "Origin is not allowed to
      // access the service". That was the entire reason the accelerometer never
      // started: the decode was fine, the permission was never asked for.
      optionalServices: [Polar.PMD_SERVICE],
    });
    strapDevice.addEventListener('gattserverdisconnected', () => {
      setStatus('heart strap disconnected');
      statusLockUntil = Date.now() + 2500;
      strapConnecting = false;
      renderDevices();
    });
    const gatt = await strapDevice.gatt.connect();
    const svc = await gatt.getPrimaryService(Polar.HR_SERVICE);
    const ch = await svc.getCharacteristic(Polar.HR_MEASUREMENT);
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', onStrapData);
    // Additive, and awaited so its console output lands in order. Failure here is
    // logged and ignored — HR and HRV keep working.
    // BEFORE the accelerometer attempt, not after: tryStartAccelerometer may set a
    // long-lived diagnostic of its own, and setting this afterwards wiped it — the
    // Chest row said "see msg" while the msg had already been overwritten.
    setStatus('heart strap linked — HRV needs about 20s of beats');
    statusLockUntil = Date.now() + 4000;
    await tryStartAccelerometer(gatt);
  } catch (err) {
    // A failed strap must never take down the EEG session.
    setStatus(`heart strap: ${err && err.message ? err.message : 'could not connect'}`);
    statusLockUntil = Date.now() + 4000;
  } finally {
    strapConnecting = false;
    renderDevices();
  }
}

async function connect() {
  if (museConnecting || museConnected()) return;
  museConnecting = true;
  renderDevices();
  try {
    setStatus('choose your Muse in the browser picker…');
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [DSP.MUSE_SERVICE] }] });
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setStatus('connecting…');
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(DSP.MUSE_SERVICE);

    // All GATT operations on one device must be serialized (awaited one at
    // a time) — issuing them concurrently reliably fails with "GATT
    // operation already in progress" on most platforms.
    const controlChar = await service.getCharacteristic(DSP.CONTROL_CHARACTERISTIC);
    await controlChar.startNotifications();

    const eegChars = [];
    for (let i = 0; i < DSP.EEG_CHARACTERISTICS.length; i++) {
      const ch = await service.getCharacteristic(DSP.EEG_CHARACTERISTICS[i]);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (ev) => {
        const value = ev.target.value; // DataView
        const raw = new Uint8Array(value.buffer, value.byteOffset + 2); // skip 2-byte packet index
        pushSamples(i, DSP.samplesToMicrovolts(DSP.decode12Bit(raw)));
      });
      eegChars.push(ch);
    }

    // PPG is optional — if this fails for any reason (older firmware, a
    // characteristic that isn't there), the core EEG/calm path should keep
    // working without it; breathing just stays on the calm-linked guess.
    try {
      const ppgChar = await service.getCharacteristic(DSP.PPG_CHARACTERISTICS[PPG_CHANNEL_INDEX]);
      await ppgChar.startNotifications();
      ppgChar.addEventListener('characteristicvaluechanged', (ev) => {
        const value = ev.target.value;
        const raw = new Uint8Array(value.buffer, value.byteOffset + 2);
        pushPPGSamples(DSP.decode24Bit(raw));
      });
      ppgAvailable = true;
    } catch (err) {
      ppgAvailable = false;
    }

    /*
     * THE HEADBAND'S MOTION SENSOR — optional, exactly like PPG above.
     *
     * Asked for: "we should capture the head accl from muse too if it's avail. it coul dbe important
     * (fidgeting)". It is the direct measurement of the stillness hypothesis, and nothing in seven
     * recorded sits contains it, because this subscription did not exist.
     *
     * Two candidate UUIDs because the Muse characteristic map is not published by the manufacturer and
     * I cannot verify the community mapping against a real Muse S Gen 2 from here. Whichever answers is
     * used; if neither does, the feature is simply absent and every other stream is untouched — the
     * same contract PPG has, for the same reason.
     */
    headAccChar = null;
    for (const uuid of DSP.MUSE_IMU_CANDIDATES) {
      try {
        const ch = await service.getCharacteristic(uuid);
        await ch.startNotifications();
        ch.addEventListener('characteristicvaluechanged', (ev) => {
          const value = ev.target.value;
          const raw = new Uint8Array(value.buffer, value.byteOffset + 2);
          pushHeadAcc(DSP.decodeMuseImu(raw), raw);
        });
        headAccChar = uuid;
        break;
      } catch (err) { /* not this one; try the next, then give up quietly */ }
    }
    console.log('[imu] head accelerometer:', headAccChar || 'not available on this device');

    setStatus('starting stream…');
    // 'p50' enables PPG alongside EEG (vs. 'p21' for EEG-only) — required
    // for the Muse to actually stream PPG data even once subscribed. If
    // this preset misbehaves on some firmware, fall back to the
    // known-working EEG-only preset rather than losing the whole
    // connection over an optional feature.
    async function sendStartSequence(preset) {
      for (const cmd of ['h', preset, 's', 'd']) await controlChar.writeValue(DSP.encodeCommand(cmd));
    }
    if (ppgAvailable) {
      try {
        await sendStartSequence('p50');
      } catch (err) {
        ppgAvailable = false;
        await sendStartSequence('p21');
      }
    } else {
      await sendStartSequence('p21');
    }

    setStatus('gathering signal— sit still for a moment…');
    readoutEl.classList.add('show');
    dataPanelEl.classList.add('show');
    modeBarEl.classList.add('show');
    document.getElementById('controls').classList.add('show');
    updatePanelVisibility();
    renderModeBar();
    renderPatternBar();
  } catch (err) {
    if (err.name === 'NotFoundError') setStatus('no device selected — use the button below to try again');
    else setStatus(`connection failed: ${escapeHtml(err.message)}`);
    statusLockUntil = Date.now() + 5000;
  } finally {
    museConnecting = false;
    renderDevices();
  }
}

function onDisconnected() {
  setStatus('headband disconnected — reconnect below');
  statusLockUntil = Date.now() + 5000;
  /* The panel STAYS, with its contents replaced. Hiding it was the old behaviour and it produced the
     same ambiguity as a fresh load: the screen goes quiet and nothing says why. Leaving the last
     numbers up would be worse still — they would read as live. */
  renderNotConnectedReadout();
  /* Drop the averaged band powers. Sixteen seconds from before a dropout, shown as current after
     reconnecting, would be a number about a different moment — and the maxAge inside the averager only
     catches gaps longer than its own window. */
  bandAverager.reset();
  lastBandPushSec = null;
  dataPanelEl.classList.remove('show');
  timerPickerEl.hidden = true;
  timerEndAt = null; timerDone = false;
  renderTimerPill();
  museConnecting = false;
  renderDevices();
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* --- Collapsible device controls -------------------------------------------
 * Two buttons in the centre of the screen, needed for ten seconds and covering the
 * visualisation for the remaining forty minutes. Collapsed behind one control that
 * reports how many devices are linked, so the state is still visible at a glance.
 */
/*
 * Just "Connect". The device buttons themselves already say what is linked
 * ("headband · linked", "+ heart strap"), so counting them on the pill as well was
 * saying the same thing twice in less detail.
 */
function renderDevToggle() {
  if (!devToggleEl.isConnected) return;
  const n = (museConnected() ? 1 : 0) + (strapConnected() ? 1 : 0);
  devToggleEl.classList.toggle('linked', n > 0);
  devToggleEl.classList.toggle('active', devicesOpen);
  /* OUTLINED IN RED UNTIL THE HEADBAND IS ON, as asked — "i wouldn't mind if the connect button was
     always outlined in red so it stood out a bit."
     Conditioned on the headband rather than literally always, and that is a deliberate reading of the
     request: the reason to want it is that Connect is the one thing you must find on a fresh page,
     among fourteen identically-styled pills. Once the headband IS linked, a red ring around a control
     with nothing wrong with it is the boy who cried wolf — and this app now leans on red meaning
     "something needs you" for the boot banner. The strap does not count: it is optional, so a sit with
     only a headband is complete and must not look unfinished. */
  /* Not in a browser that cannot reach Bluetooth at all. Urging someone to press a button that
     cannot work is worse than saying nothing — the popover already explains that case, and a red ring
     would send them clicking instead of reading. */
  devToggleEl.classList.toggle('needed',
    !!navigator.bluetooth && !museConnected() && !museConnecting);
  devToggleEl.textContent = (museConnecting || strapConnecting) ? 'Connecting\u2026' : 'Connect';
}

devToggleEl.addEventListener('click', () => setPopover('devices'));

// Not `once`: a failed connection must be retryable, and either device can drop
// out mid-session and need reconnecting. renderDevices() disables each button
// while its device is connected or connecting, which is the real guard.
connectBtn.addEventListener('click', connect);
// Its own listener, and NOT `once`: a strap connection can legitimately be
// retried after a failure, and it must be a separate user gesture because
// Web Bluetooth requires one per requestDevice() call.
strapBtn.addEventListener('click', connectStrap);

// Copy the whole PMD conversation, so a protocol problem costs one paste rather
// than a hand-typed summary that loses the bytes that mattered.
copyLogBtn.addEventListener('click', async () => {
  const text = JSON.stringify(Object.assign({}, pmdLog, {
    accepted: accVariant, lastError: accStartError, nonResponses: accNonResponses,
    frameCount: accFrames, decodedCount: accDecoded, firstHead: accFirstHead,
    magnitudeMilliG: accMag, gravityOk: accVerdict ? accVerdict.ok : null,
    tried: accTried,
  }), null, 1);
  try {
    await navigator.clipboard.writeText(text);
    copyLogBtn.textContent = 'copied';
  } catch (e) {
    // The clipboard can be refused without a secure context or a fresh gesture.
    // Falling back to the console beats silently doing nothing.
    console.log('[PMD] strap log:\n' + text);
    copyLogBtn.textContent = 'in console';
  }
  setTimeout(() => { copyLogBtn.textContent = 'copy strap log'; }, 3000);
});

/* --- Voice notes -----------------------------------------------------------
 * A held button that records what you say and files it against the moment.
 *
 * WHY VOICE and not typing: this is meant to be used mid-sit with your eyes shut.
 * Typing a note on a phone means opening your eyes, finding a text field and
 * breaking the thing you were trying to describe. Talking does not.
 *
 * It also works with NO BLUETOOTH AT ALL, which on iOS is a real possibility —
 * no iOS browser implements Web Bluetooth. Notes carry absolute wall-clock time
 * as well as a session offset, so they can be aligned afterwards against a
 * recording made by a different app on the same phone.
 *
 * Audio is stored as a Blob, not transcribed here. Transcribing on-device would
 * be a guess about what you said; the recording is what you actually said.
 */
const voiceBtn = document.getElementById('voiceNote');
let mediaRecorder = null;
let voiceChunks = [];
let voiceStartedAt = null;
/* IS THE BUTTON (or the key) STILL DOWN?
 * startVoiceNote awaits getUserMedia, which takes long enough that a short press
 * finishes first. stopVoiceNote would then find `mediaRecorder === null`, do nothing,
 * and the recorder would start a moment later with nobody left to stop it — the mic
 * stays open for the rest of the sit. The release has to be remembered, not just acted
 * on, so the start path can check whether it is still wanted. */
let voiceHeld = false;
/*
 * LIVE TRANSCRIPTION, alongside the recording rather than instead of it.
 *
 * Asked for: "I would really love to add the feature where I can transcribe a note, not
 * just record it." notes.csv has carried an empty `transcript` column from the start,
 * deliberately, as the seam for exactly this — so this fills a designed gap rather than
 * adding a field.
 *
 * THE AUDIO IS STILL THE RECORD. A transcript is a guess about what was said, and the
 * browser's recogniser is not reliable on a whisper, a Japanese term, or a room with a
 * fan in it — "kenshō" is not in anyone's language model. So the transcript is additive:
 * if recognition is unavailable, refused, or wrong, the note is saved with the audio and
 * an empty transcript, exactly as before. It never blocks or delays the save.
 */
const SpeechRec = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
let recogniser = null;
let voiceTranscript = '';

/*
 * WHEN EACH WORD ARRIVED, not just what the words were.
 *
 * Asked about spoken keywords acting as markers — saying "thinking" in a note and having it
 * count the way pressing T does — with the reasonable assumption that the data for it is
 * already being kept. Nearly: the audio is saved and the note's START is timestamped, but
 * the transcript was collapsed to one flat string, so there was nothing to say WHERE in the
 * utterance a word fell. On a five-second note that is a five-second error bar on the very
 * alignment the clip library exists to resolve, and the marker translation itself has to
 * wait for design work that has not been done.
 *
 * This is the part that could not wait, because it is only observable live. The recogniser
 * emits results as it goes; stamping each one on arrival costs nothing and gives a bound on
 * when a word was spoken — "the recogniser had not reported this word before t, and had by
 * t" — accurate to about one event interval.
 *
 * SNAPSHOTS, not diffs. Interim results get REVISED: the recogniser changes its mind about
 * earlier words, so a running text is not append-only and a diff computed live would be
 * wrong in exactly the cases that matter. Storing what it believed at each moment leaves the
 * interpretation to the analysis, which can afford to be careful about it.
 *
 * Bounded, because a stuck recogniser firing continuously must not grow a note without
 * limit. The cap is far above any real note — a few seconds of speech produces tens of
 * events, not hundreds — and it is recorded rather than silently applied.
 */
const TRANSCRIPT_SNAPSHOT_CAP = 200;
let voiceTimeline = [];

function startTranscribing() {
  if (!SpeechRec) return;
  voiceTranscript = '';
  voiceTimeline = [];
  try {
    recogniser = new SpeechRec();
    recogniser.continuous = true;
    // Interim results are kept because a short note often ends before the recogniser
    // commits a final one, and a partial transcript beats none.
    recogniser.interimResults = true;
    recogniser.lang = navigator.language || 'en-US';
    recogniser.addEventListener('result', (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += `${e.results[i][0].transcript} `;
      voiceTranscript = text.trim();
      // Stamped against the note's own clock, so it needs no reconciliation with the
      // session clock later — the note already carries its offset into the sit.
      if (voiceTimeline.length < TRANSCRIPT_SNAPSHOT_CAP && voiceTranscript) {
        const atSec = voiceStartedAt ? (Date.now() - voiceStartedAt) / 1000 : 0;
        const last = voiceTimeline[voiceTimeline.length - 1];
        // Only when the belief actually changed. The recogniser re-fires with identical
        // text often enough that keeping every event would triple the size for nothing.
        if (!last || last.text !== voiceTranscript) {
          voiceTimeline.push({ atSec: Number(atSec.toFixed(2)), text: voiceTranscript });
        }
      }
    });
    // Failures are logged, not surfaced: the note is being saved either way, and an error
    // banner would suggest the note was lost.
    recogniser.addEventListener('error', (e) => console.log('[voice] transcription:', e.error));
    recogniser.start();
  } catch (err) {
    console.log('[voice] transcription unavailable:', (err && err.message) || err);
    recogniser = null;
  }
}

function stopTranscribing() {
  if (!recogniser) return;
  try { recogniser.stop(); } catch (err) { /* already stopped */ }
  recogniser = null;
}

async function startVoiceNote() {
  if (mediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  voiceHeld = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Let the browser pick the container. Safari and Chrome disagree about what
    // they will produce, and naming one means failing on the other.
    mediaRecorder = new MediaRecorder(stream);
    voiceChunks = [];
    voiceStartedAt = Date.now();
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size) voiceChunks.push(e.data);
    });
    mediaRecorder.addEventListener('stop', async () => {
      // Stop the mic itself, not just the recorder: a live track leaves the
      // recording indicator on and drains the battery for the rest of the sit.
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const secs = (Date.now() - voiceStartedAt) / 1000;
      mediaRecorder = null;
      voiceChunks = [];
      voiceBtn.classList.remove('rec');
      voiceBtn.innerHTML = 'Hold to speak<kbd>space</kbd>';
      // Under a second is a fumbled press, not a note.
      if (secs < 0.8) { setStatus('too short — hold the button while you speak'); statusLockUntil = Date.now() + 1600; return; }
      await ensureRecording();
      if (!recSession) {
        setStatus(`recording unavailable — the note was not saved (${escapeHtml(recError || 'no session')})`);
        statusLockUntil = Date.now() + 6000;
        return;
      }
      const transcript = voiceTranscript;
      const timeline = voiceTimeline;
      voiceTranscript = '';
      voiceTimeline = [];
      await recSession.addNote({ kind: 'voice', audio: blob,
        mimeType: blob.type, seconds: secs, transcript, text: transcript || null,
        // See startTranscribing: when the recogniser first reported each state of the
        // transcript, which is the only record of WHERE in the note a word fell.
        transcriptTimeline: timeline,
        transcriptTruncated: timeline.length >= TRANSCRIPT_SNAPSHOT_CAP });
      // Show what it heard, so a bad transcript is visible immediately rather than
      // discovered in a spreadsheet weeks later.
      setStatus(transcript
        ? `voice note saved (${secs.toFixed(0)}s) \u2014 \u201c${escapeHtml(transcript)}\u201d`
        : `voice note saved (${secs.toFixed(0)}s)`);
      statusLockUntil = Date.now() + 1800;
    });
    mediaRecorder.start();
    startTranscribing();
    voiceBtn.classList.add('rec');
    voiceBtn.innerHTML = 'Listening\u2026 release to save';
    // Released while the microphone was still opening. Honour it now rather than
    // leaving a recorder running that nothing holds a reason to stop.
    if (!voiceHeld) stopVoiceNote();
  } catch (err) {
    // A refused microphone is a permission problem, not a bug. Say which.
    setStatus(`microphone unavailable: ${escapeHtml((err && err.message) || 'refused')}`);
    statusLockUntil = Date.now() + 5000;
  }
}

function stopVoiceNote() {
  voiceHeld = false;
  stopTranscribing();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

/* Pointer events rather than mouse/touch pairs: one code path for finger and
 * mouse, and `pointercancel` covers the phone taking the gesture away mid-press.
 *
 * POINTER CAPTURE, and there was no `pointerleave` before it for a reason.
 * The label changes from "Hold to speak" to "Listening… release to save" the instant
 * recording starts, so the pill grows by about 40px and re-flows the bar. The pointer,
 * which has not moved, is now outside the element it pressed — `pointerleave` fired and
 * stopped the recording immediately. That is the "it flashes and disappears".
 * Capturing the pointer routes every subsequent event for this gesture to this element
 * regardless of what moves underneath it, which is also the correct behaviour for a
 * press-and-hold in general: sliding a finger a few pixels must not cancel it. */
voiceBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { voiceBtn.setPointerCapture(e.pointerId); } catch { /* older engines: no capture */ }
  startVoiceNote();
});
voiceBtn.addEventListener('pointerup', stopVoiceNote);
voiceBtn.addEventListener('pointercancel', stopVoiceNote);

/* --- Saved sessions --------------------------------------------------------- */
let recQuota = null;
// Checked rarely: it is a real async call, and free space does not change fast.
setInterval(async () => { recQuota = await Recorder.quota(); }, 60000);
Recorder.quota().then((q) => { recQuota = q; });

const recBtnEl = document.getElementById('recBtn');

/*
 * REFUSE TO RECORD NOTHING.
 *
 * Asked for after losing a sit to exactly this: "if I hit record and there's no
 * connection, let's have an error pop up and say 'please connect, nothing to record' so I
 * don't make that mistake again."
 *
 * With no device attached, arming looks identical to a real recording — the button counts
 * up, marks flash, the tally rises — and produces an archive with no signal in it. The
 * only thing that distinguishes the two is knowing whether you connected, which is the
 * thing you have just forgotten.
 *
 * A SECOND PRESS RECORDS ANYWAY, and that matters: a notes-only sit is a legitimate thing
 * to want, and a hard refusal would make the app argue with someone who meant it. The
 * escape hatch is stated in the same message, so it is a warning rather than a wall.
 */
let recRefusedAt = 0;
const RECORD_OVERRIDE_SEC = 8;

function nothingToRecord() {
  return !museConnected() && !strapConnected();
}

async function startRecording() {
  if (recArmed) return;
  if (nothingToRecord()) {
    const insisting = Date.now() - recRefusedAt < RECORD_OVERRIDE_SEC * 1000;
    if (!insisting) {
      recRefusedAt = Date.now();
      setStatus('Please connect — there is nothing to record.<br>'
        + '<span style="opacity:.7;font-size:12px">Press Connect, or press Record again to'
        + ' keep notes only.</span>');
      statusLockUntil = Date.now() + 7000;
      // Two low notes, distinct from every other cue in the app, so a refusal is audible
      // with your eyes already shut.
      tone(330, 130);
      setTimeout(() => tone(247, 220), 150);
      renderRecBtn();
      return;
    }
    recRefusedAt = 0;
    setStatus('recording notes only — no device is connected');
    statusLockUntil = Date.now() + 4000;
  }
  recArmed = true;
  recGeneration++;
  recError = null;
  // A fresh clock per recording. Without this, a second sit in the same page load
  // would be stamped against the first one's start and every offset would be wrong.
  sessionStartedAt = Date.now();
  sessionLog.length = 0;
  /* A new recording is a NEW SIT, so everything scoped to a sit resets here.
   *
   * selfRating in particular: it was set once and never cleared, so the second time
   * a summary opened in one page load the "before the numbers" screen was skipped
   * entirely — which is why the rating screen appeared to vanish. Same for
   * timerDone, which would otherwise report a previous sit's timer as complete.
   */
  selfRating = null;
  timerDone = false;
  // A new sit gets a new general note, or the previous sit's comment would be amended.
  sitNoteId = null;
  sitNoteText = '';
  // A correction the operating system made during yesterday's sit is not a fault in today's.
  clockCheck.reset();
  markerLog.clear();
  resetProbes(timerEndAt ? (timerEndAt - Date.now()) / 1000 : 1800);
  await ensureRecording();
  renderRecBtn();
  if (recSession) { setStatus('recording'); statusLockUntil = Date.now() + 1500; }
}

/*
 * A RECORDING THAT NOBODY IS SITTING FOR MUST STOP ITSELF.
 *
 * Reported as two symptoms with one cause: "open in lab button doesn't work after i stop
 * recording and fill out the form. also the dates/times don't look right. i just recorded
 * this right now, 8/1 957 am EST" — against a session stamped 7/31, 1:59 PM.
 *
 * The date was not wrong. Turning Training on starts recording and turning it off
 * deliberately does not stop it, so a recording armed yesterday afternoon was still armed
 * this morning: one session spanning twenty hours, whose start time is honestly yesterday
 * and which contains two sits with a night in between. Two consequences, both bad:
 *
 *   - The session boundary is the unit every analysis is built on. A sit that begins when
 *     you first opened the app and ends whenever you next remember to press stop is not a
 *     sit, and no amount of care downstream recovers the boundary.
 *   - It is enormous. Raw EEG is about 3.7MB per minute, so twenty hours is over 4GB. The
 *     handoff reads every chunk back, CRC-32s it and zips it, which is why "open in lab"
 *     did nothing: it was never going to finish, and the archive would not fit in the
 *     lab's storage if it had.
 *
 * So: no data for a while means nobody is wearing it. Stop, package, keep the sit. Ten
 * minutes rather than one, because a BLE dropout, an adjusted headband, or a stretch of
 * genuinely awful contact are all normal and none of them should end a sit. Silent —
 * `summary: false` — because by definition you are not at the screen, and a summary
 * demanding attention on your return is not the point; the sit is saved and listed.
 *
 * The hard cap is separate and much longer. A sit really can run three hours, and someone
 * who sits that long should not have it truncated; but nothing in this practice runs six,
 * and past that the likeliest explanation is a forgotten recording.
 */
const RECORD_IDLE_STOP_SEC = 600;      // no data at all for ten minutes
const RECORD_MAX_SEC = 6 * 3600;       // and an outer limit regardless
let runawayHandled = false;

function checkRunawayRecording() {
  if (!recArmed || !recSession) { runawayHandled = false; return; }
  if (runawayHandled) return;
  const idleSec = lastDataAt ? (Date.now() - lastDataAt) / 1000 : 0;
  const ranSec = (Date.now() - (recSession.meta.startedAt || Date.now())) / 1000;
  let why = null;
  // lastDataAt of 0 means nothing ever arrived; the notes-only mode is a deliberate choice
  // and must not be stopped for being quiet.
  if (lastDataAt && idleSec > RECORD_IDLE_STOP_SEC) {
    why = `no signal for ${Math.round(idleSec / 60)} minutes`;
  } else if (ranSec > RECORD_MAX_SEC) {
    why = `it has been running for ${(ranSec / 3600).toFixed(1)} hours`;
  }
  if (!why) return;
  runawayHandled = true;
  stopRecording({ summary: false }).then(() => {
    setStatus(`Recording stopped on its own \u2014 ${escapeHtml(why)}.<br>`
      + '<span style="opacity:.7;font-size:12px">The sit is saved. Press Record to start a'
      + ' new one.</span>');
    statusLockUntil = Date.now() + 12000;
  });
}

async function stopRecording({ summary = true } = {}) {
  if (!recArmed) return;
  recArmed = false;
  recGeneration++;    // invalidates any ensureRecording still opening a session
  const sess = recSession;
  recSession = null;
  lastRecSession = sess;
  renderRecBtn();
  if (!sess) return;
  // end() flushes what is still in memory before marking the session complete, so
  // the last few seconds of the sit are not the ones that go missing.
  await sess.end();
  /* AUDIBLE END. You may well have your eyes shut when the timer runs out, and a sit
   * that has silently stopped recording is indistinguishable from one still running.
   * Three descending notes — the inverse of the trial's rising completion chime, so
   * "finished" and "started" cannot be confused. */
  tone(587, 160);
  setTimeout(() => tone(494, 160), 180);
  setTimeout(() => tone(392, 320), 380);
  setStatus(`session saved \u00b7 ${(sess.bytes / 1e6).toFixed(1)}MB`);
  statusLockUntil = Date.now() + 4000;
  // Stopping is when the sit gets summarised — that is the point at which it has an
  // end, and the notes have something to be attached to.
  if (summary) openSummary();
}

/* --- One-key transition marks ----------------------------------------------
 * "I press a key every time I notice I have come back" is a complete experimental
 * protocol, and it is the only kind of label that can be given without damaging the
 * sit: one keystroke, no menu, nothing to compose, eyes shut. R G D K.
 *
 * These are written straight through with no prompt. Asking for confirmation would
 * cost more attention than the mark is worth, and a mark you decide against can be
 * deleted from the Notes panel afterwards.
 */
// Kept as a named entry point for tests and for any programmatic marking, delegating
// to markTap so there is exactly one implementation.
async function markTransition(key) {
  const t = Probes.TAP_BY_KEY[key];
  if (!t) return;
  return markTap(t);
}


/* --- Armed taps, with an optional grade -------------------------------------
 * The mark is written IMMEDIATELY. A grade can be added by pressing 1 or 2 within a few
 * seconds, which amends the note that already exists — so an interrupted two-key
 * sequence costs the detail, never the mark.
 */
let pendingGrade = null;   // { noteId, category, until }

/*
 * THE PREVIOUS TAP, so a second press of the same key within the window can upgrade it.
 *
 * "Double-tap Thinking = deep thinking." The second press REPLACES the first rather than adding to
 * it, which is the part that has to be right: two marks 400ms apart recorded as two separate returns
 * to thinking is a count this dataset cannot afford to get wrong, because the marks-versus-marks
 * comparison in explore.js is built entirely on counts.
 *
 * The decision itself is in Probes.doubleTap, pure and tested. This holds only the state it needs.
 */
let lastTap = null;        // { key, at, markId, noteId, strong }

/* How a mark reads when it was double-tapped. "Thinking" becomes "Thinking, strongly" rather than
   becoming a different word, because it is the same state reported harder. */
function strongly(tap, strong) {
  const label = (tap && tap.label) || 'mark';
  return strong ? `${label}, strongly` : label;
}
/*
 * TAPS WHOSE NOTE MUST BE DELETED THE MOMENT IT LANDS.
 *
 * An upgrade can happen while the first tap's note is still being written, which is the whole point of
 * recording the tap before the await. When that happens there is no id to delete yet — and doing nothing
 * leaves the write to land afterwards, so the screen shows one deep-thinking mark while notes.csv holds
 * both a "lost" and a "deep-thinking". Measured: with a 600ms write the stored notes were
 * ["lost","deep-thinking"] for one gesture.
 *
 * That is the exact failure the double-tap exists to prevent, and it is worse in the file than on screen:
 * explore.js compares mark kinds BY COUNTING them, so one event recorded as two inflates the number the
 * comparison rests on — and nothing downstream could ever tell it was one press.
 *
 * So the mark id is remembered here, and the write path deletes its own note on arrival.
 */
const orphanedTaps = new Set();

async function markTap(tap, { strong = false } = {}) {
  const tSec = sessionTSec();
  const now = Date.now();

  /* WHAT THIS PRESS MEANS, given the one before it. */
  const decided = Probes.doubleTap(tap.key, {
    lastKey: lastTap && lastTap.key, lastAt: lastTap && lastTap.at,
    lastId: lastTap && lastTap.markId, lastStrong: !!(lastTap && lastTap.strong), at: now,
  });
  /* A THIRD press on an already-strong mark says nothing new. Swallowed here rather than recorded,
     because the alternatives are both wrong: a fresh mark would double-count one event, and toggling
     the strength off would let a held key flicker it. */
  if (decided.already) {
    setStatus(`${tap.label} · already marked strong`);
    statusLockUntil = Date.now() + 1600;
    return;
  }
  if (decided.upgraded) {
    const upgraded = Probes.TAP_BY_KEY[decided.category];
    /* UNDO THE FIRST PRESS, in both places it landed. The on-screen mark and the stored note are
       separate records of one event, and leaving either behind would mean the tally on screen and
       notes.csv disagreed about how many times thinking was marked. */
    if (decided.replaces != null) markerLog.remove(decided.replaces);
    /* The first note may not have been written yet — that is the whole race this ordering fixes. If it
       has not, its id is unknown, so the write path is told to delete it on arrival instead. */
    if (lastTap && lastTap.noteId == null) orphanedTaps.add(lastTap.markId);
    if (lastTap && lastTap.noteId != null && recDb) {
      /* Best effort, through recDb — the same handle the Notes panel deletes with. A failed delete
         must not cost the upgraded mark: a duplicate note is recoverable from the timestamps, a
         missing mark is not. Said out loud in the console if it happens. */
      try {
        await Recorder.deleteNote(recDb, lastTap.noteId);
      } catch (err) {
        console.log('[mark] could not remove the upgraded tap’s first note:', err && err.message);
      }
    }
    lastTap = null;
    /* Re-enter with the SAME category, flagged strong — not a different category. See the note on
       Probes.doubleTap: a separate category per intensity would split one state's marks across two
       buckets, and explore.js compares kinds by counting them. One implementation of writing a mark. */
    if (upgraded) return markTap(upgraded, { strong: true });
  }

  const mark = markerLog.add(tSec, { kind: tap.key, note: null });
  // On the in-memory mark too, so the rail's list and the on-screen tally can show it without a lookup.
  mark.strong = strong;
  /*
   * RECORDED FOR THE DOUBLE-TAP WINDOW *HERE*, BEFORE ANY await.
   *
   * This used to be set at the end of the function, after `await ensureRecording()` and
   * `await recSession.addNote(...)`. Both touch IndexedDB, and until they resolve `lastTap` was still
   * whatever it had been — so a second press arriving during the write saw no previous tap and made a
   * second Thinking mark instead of one deep-thinking mark.
   *
   * It passed every test and every try on a fast machine, because there the writes resolve in a few
   * milliseconds and a 400ms gap never overlaps them. Reproduced by delaying addNote by 600ms, which is
   * an ordinary phone: two ArrowRight presses 400ms apart produced ["lost","lost"] instead of
   * ["deep-thinking"]. Reported as "double tapping thinking (right arrow) doesn't create a deep thinking
   * marker", and the report was right.
   *
   * The noteId is filled in below when the write lands. It is only needed to DELETE the first note on an
   * upgrade, and that path checks for null — so a second press that beats the write still collapses the
   * marks correctly, it just has no note to remove yet, which is the right outcome because there is not
   * one.
   */
  lastTap = { key: tap.key, at: now, markId: mark.id, noteId: null, strong };
  renderMarkCount();
  markFlashEl.classList.add('on');
  setTimeout(() => markFlashEl.classList.remove('on'), 60);
  await ensureRecording();
  let noteId = null;
  if (recSession) {
    // `transition` as well as `tapCategory`: one event, one name downstream. The
    // export, the markdown and the analysis all key off `transition`, and duplicating
    // the value here is cheaper than two vocabularies that can disagree.
    noteId = await recSession.addNote({ kind: 'transition', transition: tap.key,
      tapCategory: tap.key, text: tap.label, anchored: true,
      /* THE STRENGTH IS A FIELD, not a different category. A strong Thinking is still a Thinking when
         anything counts kinds, and the strength is there for anything that wants to filter on it. */
      strong: strong ? 1 : undefined });
    // So context typed at the summary reaches notes.csv and not just the report.
    if (noteId != null) markerLog.setNoteId(mark.id, noteId);
  }
  if (orphanedTaps.has(mark.id)) {
    /* THIS TAP WAS UPGRADED WHILE ITS OWN NOTE WAS IN FLIGHT. The note has just landed and describes an
       event that no longer exists as a separate mark, so it goes now. */
    orphanedTaps.delete(mark.id);
    if (noteId != null && recDb) {
      try { await Recorder.deleteNote(recDb, noteId); }
      catch (err) { console.log('[mark] could not remove an upgraded tap’s note:', err && err.message); }
    }
  } else if (lastTap && lastTap.markId === mark.id) {
    /* Fill in the note id on the record made before the awaits — but ONLY if it is still the same tap.
       A second press during the write replaces `lastTap`, and writing this tap's id onto that one would
       make a later upgrade delete the wrong note. */
    lastTap.noteId = noteId;
  }
  if (tap.grades && noteId != null) {
    pendingGrade = { noteId, category: tap.key, until: Date.now() + 4000 };
    setStatus(`${strongly(tap, strong)} \u00b7 ${tap.grades.map((g) => `${g.value}=${g.label}`).join(' ')}`);
  } else if (!recSession) {
    /* SAY SO when the mark is not being kept.
       markerLog.add above always succeeds, so the flash fires, the count goes up and
       the mark appears in the on-screen tally whether or not anything is recording.
       A whole sit was tapped through under the impression it was saved. The mark is
       still worth having in the session's own display, but the confirmation must not
       be indistinguishable from the confirmation of a saved one. */
    setStatus(`${strongly(tap, strong)} \u00b7 ${Exporter.clock(tSec)}`
      + ` \u2014 not recording, this won\u2019t be saved`);
  } else {
    setStatus(`${strongly(tap, strong)} \u00b7 ${Exporter.clock(tSec)}`);
  }
  statusLockUntil = Date.now() + 3200;
}

async function applyGrade(value) {
  if (!pendingGrade || Date.now() > pendingGrade.until) { pendingGrade = null; return; }
  const g = pendingGrade;
  pendingGrade = null;
  const cat = Probes.TAP_BY_KEY[g.category];
  const grade = cat && cat.grades.find((x) => x.value === value);
  if (!grade || !recSession) return;
  // A second note carrying the grade, rather than rewriting the first: the original
  // mark's timestamp is the datum, and an update path that could fail would put that
  // at risk for the sake of an annotation.
  await recSession.addNote({ kind: 'tap-grade', tapCategory: g.category,
    grade: value, amends: g.noteId, text: grade.label, anchored: true });
  setStatus(`\u2192 ${grade.label}`);
  statusLockUntil = Date.now() + 1600;
}

// The timer running out ends the sit: stopRecording() flushes, closes the session
// and opens the summary itself, so this must not also call openSummary or two stack.
function checkTimerDone() {
  if (!timerEndAt || timerDone || Date.now() < timerEndAt) return;
  timerDone = true;
  setStatus('session complete');
  // A LOCK, not a permanent state. This message used to sit on screen for the rest
  // of the page's life, because the only line that cleared the status was guarded by
  // `!timerDone` — so once the timer fired nothing could ever clear it again.
  statusLockUntil = Date.now() + 5000;
  if (recArmed) stopRecording();
  else openSummary();
}

function renderRecBtn() {
  if (!recBtnEl.isConnected) return;
  const live = recArmed && recSession;
  recBtnEl.classList.toggle('on', !!live);
  recBtnEl.classList.toggle('warn', !!(recError || (recSession && recSession.error)));
  if (recError) { recBtnEl.textContent = 'Recording unavailable'; return; }
  if (recArmed && !recSession) { recBtnEl.textContent = 'Waiting for data\u2026'; return; }
  if (!live) { recBtnEl.textContent = 'Record'; return; }
  const secs = Math.max(0, (Date.now() - recSession.meta.startedAt) / 1000);
  recBtnEl.textContent = `Stop \u00b7 ${Math.floor(secs / 60)}:`
    + `${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}
setInterval(renderRecBtn, 1000);
recBtnEl.addEventListener('click', () => (recArmed ? stopRecording() : startRecording()));

// Leaving with a recording running would lose whatever has not flushed. This cannot
// reliably await an async end(), so it flushes synchronously-ish and warns.
addEventListener('beforeunload', (e) => {
  if (!recArmed || !recSession) return;
  recSession.flush();
  e.preventDefault();
  return (e.returnValue = 'A recording is still running. Stop it first to close the session cleanly.');
});

/* --- Calibration trials ----------------------------------------------------
 * A guided protocol where the instruction IS the label. See trials.js for why this
 * is the only path to validating anything the app claims.
 *
 * AUDIBLE CUES ARE NOT A NICETY. Two of these protocols are done with the eyes
 * closed, so a block boundary that is only announced on screen cannot be noticed —
 * and a meditator who misses a boundary contributes a block labelled as one thing
 * and spent doing another, which is worse than no data. Each condition gets its own
 * pitch, so you know which block you are in without looking.
 */
/* --- Popovers: exactly one, and it closes on an outside click -----------------
 * There were three independent toggles, each trying to close the other two, and the
 * result was two open at once with one hidden behind the other — and a Connect panel
 * that could not be dismissed because its own pill was underneath the timer's.
 *
 * One owner, one open name, one place that hides the rest.
 */
let openPopover = null;   // 'devices' | 'timer' | 'trials' | null

function setPopover(name) {
  openPopover = openPopover === name ? null : name;
  devicesOpen = openPopover === 'devices';
  devicesEl.hidden = !devicesOpen;
  timerPickerEl.hidden = openPopover !== 'timer';
  trialPickerEl.hidden = openPopover !== 'trials';
  if (openPopover === 'timer') renderTimerPicker();
  if (openPopover === 'trials') renderTrialPicker();
  renderDevToggle();
  renderTimerPill();
  renderTrialsLink();
}

// An outside click dismisses. Checked against the pills too, or the pill's own click
// would close and immediately reopen.
document.addEventListener('pointerdown', (e) => {
  if (!openPopover) return;
  const inside = e.target.closest('#devices, #timerPicker, #trialPicker,'
    + ' #devToggle, #timerLink, #trialsLink');
  if (!inside) setPopover(null);
}, true);

const trialHudEl = document.getElementById('trialHud');
const trialCondEl = document.getElementById('trialCond');
const trialInstrEl = document.getElementById('trialInstr');
const trialMetaEl = document.getElementById('trialMeta');
const trialPickerEl = document.getElementById('trialPicker');
const trialsLinkEl = document.getElementById('trialsLink');

let trialRun = null;        // the built block sequence
let trialStartedAt = null;  // session-clock seconds at which block 0 begins
let trialPrevSec = null;
let audioCtx = null;

// Which side each protocol started on last time, so runs alternate rather than
// repeating one order and confounding condition with order across the dataset.
function nextStartWith(key) {
  const stored = Number(localStorage.getItem(`zenbio.trialStart.${key}`) || 0);
  localStorage.setItem(`zenbio.trialStart.${key}`, String((stored + 1) % 2));
  return stored % 2;
}

function tone(hz, ms = 180) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = hz;
    // Ramped, not switched: an abrupt gate clicks, and a click in the middle of a sit
    // is a startle rather than a cue.
    g.gain.setValueAtTime(0, audioCtx.currentTime);
    g.gain.linearRampToValueAtTime(0.16, audioCtx.currentTime + 0.02);
    g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + ms / 1000);
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + ms / 1000 + 0.02);
  } catch (e) { /* no audio available; the screen still shows the instruction */ }
}

function renderTrialPicker() {
  trialPickerEl.innerHTML = '<div style="width:100%;display:flex;flex-direction:column;gap:8px">'
    + Trials.PROTOCOLS.map((p) => {
      const mins = Math.round(Trials.durationSec(p.key) / 60);
      return `<button data-trial="${p.key}" style="text-align:left;padding:9px 12px">`
        + `<div style="font-size:13px">${escapeHtml(p.label)} <span style="opacity:.5">`
        + `· ${mins} min</span></div>`
        + `<div style="font-size:11px;opacity:.55;margin-top:2px">${escapeHtml(p.purpose)}</div>`
        + `</button>`;
    }).join('')
    + (trialRun ? '<button data-trial="" style="opacity:.7">Stop the trial</button>' : '')
    + '</div>';
  trialPickerEl.querySelectorAll('[data-trial]').forEach((b) => {
    b.addEventListener('click', () => {
      setPopover(null);
      if (!b.dataset.trial) stopTrial();
      else startTrial(b.dataset.trial);
    });
  });
}

async function startTrial(key) {
  const proto = Trials.BY_KEY[key];
  if (!proto) return;
  // A trial that is not recorded is a trial wasted, so recording is started for you
  // rather than left as a thing to remember.
  if (!recArmed) await startRecording();
  trialRun = Trials.buildBlocks(key, { startWith: nextStartWith(key) });
  trialStartedAt = sessionTSec();
  trialPrevSec = null;
  renderTrialsLink();
  setStatus(`${proto.label} \u00b7 ${Math.round(Trials.durationSec(key) / 60)} min`
    + ` \u00b7 ${proto.expectation}`);
  statusLockUntil = Date.now() + 9000;
  if (recSession) {
    await recSession.addNote({ kind: 'trial-start', trialKey: key,
      startWith: trialRun.startWith, text: proto.label, anchored: true });
  }
  // Show the first instruction NOW rather than on the next tick. A quarter-second of
  // blank screen after pressing start reads as "did that work?", and the first block's
  // settling period is already running.
  updateTrial();
  updateProbes();
}

async function stopTrial({ completed = false } = {}) {
  if (!trialRun) return;
  const key = trialRun.protocol.key;
  trialRun = null; trialStartedAt = null; trialPrevSec = null;
  trialHudEl.hidden = true;
  renderTrialsLink();
  if (recSession) {
    await recSession.addNote({ kind: 'trial-end', trialKey: key, completed, anchored: true });
  }
  setStatus(completed ? 'trial complete' : 'trial stopped');
  statusLockUntil = Date.now() + 3000;
  // A completed trial ends the sit, since the protocol defines its length.
  if (completed && recArmed) stopRecording();
}

/*
 * Advance the trial. Called from the tick, and — importantly — from ABOVE the tick's
 * early return, because a block boundary is a wall-clock event: a headband dropout
 * must not silently stall a protocol mid-run.
 */
function updateTrial() {
  if (!trialRun) return;
  const t = sessionTSec() - trialStartedAt;
  const crossed = Trials.crossedBoundary(trialRun, trialPrevSec, t);
  const at = Trials.blockAt(trialRun, t);
  trialPrevSec = t;

  if (crossed) {
    // A distinct pitch per condition, so the block is identifiable with eyes shut.
    const idx = trialRun.protocol.conditions.findIndex((c) => c.key === crossed.condition);
    tone(idx === 0 ? 660 : 440);
    if (recSession) {
      recSession.addNote({
        kind: 'block', trialKey: trialRun.protocol.key, condition: crossed.condition,
        blockIndex: crossed.index, text: crossed.label, anchored: true,
      });
    }
  }

  if (!at) {
    // Past the end: three notes to say so, then wrap up.
    /* DISTINCT PITCHES PER EVENT. These cues are meant to be told apart by ear with the
     * eyes shut, so no two events may share a note: block boundaries are 660 and 440,
     * a probe is 520 then 780, this completion is 880-740-620 rising-then-settling, and
     * a stopped recording is 587-494-392 descending. Sharing 660 between "next block"
     * and "protocol finished" defeated the entire purpose. */
    tone(880, 120); setTimeout(() => tone(740, 120), 160); setTimeout(() => tone(620, 240), 320);
    stopTrial({ completed: true });
    return;
  }
  trialHudEl.hidden = false;
  trialHudEl.classList.toggle('settling', at.phase === 'settling');
  trialCondEl.textContent = at.block.label;
  trialInstrEl.textContent = at.block.instruction;
  trialMetaEl.textContent = `block ${at.block.index + 1}/${trialRun.blocks.length}`
    + ` \u00b7 ${Math.ceil(at.remainingSec)}s`;
}

function renderTrialsLink() {
  if (!trialsLinkEl.isConnected) return;
  trialsLinkEl.classList.toggle('active', !!trialRun);
  trialsLinkEl.textContent = trialRun ? `Trial: ${trialRun.protocol.label}` : 'Trials';
}

trialsLinkEl.addEventListener('click', () => setPopover('trials'));
renderTrialsLink();

/* --- Probes: the unbiased half of the labelling ------------------------------
 * See probes.js for why both label types are needed. In short: self-caught marks can
 * only ever sample what you NOTICED, so they are blind to being gone without knowing
 * it — and probes, decided by a clock, are not.
 *
 * Tied to Training mode, because that is where the practice instrumentation lives and
 * because probes must be opt-in: being interrupted unpredictably is the last thing
 * anyone wants in an ordinary sit.
 */
const probeHudEl = document.getElementById('probeHud');
const probeOptsEl = document.getElementById('probeOpts');
const probeMetaEl = document.getElementById('probeMeta');
const armedBarEl = document.getElementById('armedBar');

let probeTimes = [];
let probeAnswers = [];
let probePending = null;     // { index, atSec, cuedAt }
// The armed tap category: chosen once, then every press of its key records it with no
// further decision. Choosing per tap is deliberative and costs the sit more than it
// gains.
let armedTap = 'returned';

function resetProbes(durationSec) {
  // Scheduled up front from the intended length, so the schedule is a property of the
  // session and appears in the export. An analysis can then tell a MISSED probe from
  // one that was never scheduled, which are different facts.
  probeTimes = Probes.schedule(durationSec || 1800, { seed: (Date.now() / 60000) | 0 });
  probeAnswers = [];
  probePending = null;
  probeHudEl.hidden = true;
}

function renderArmedBar() {
  if (!armedBarEl.isConnected) return;
  armedBarEl.hidden = !trainingMode;
  if (!trainingMode) return;
  /* The hint lives at the TOP OF THIS PANEL rather than in a separate corner element.
     It used to be the small line under a large 0:00 clock in the opposite corner —
     two pieces of furniture for one sentence, and the clock itself was not wanted:
     an elapsed-time readout is a thing to watch, which is the opposite of what a sit
     needs. The sentence belongs with the keys it is talking about. */
  /* PRIMARY_TAP_CATEGORIES, not TAP_CATEGORIES. Deep thinking is reached by pressing T twice and has
     no letter of its own; listing it here would show a row with an empty key and invite pressing both
     it and Thinking for one event, which splits one state's marks across two buckets. It is announced
     under Thinking instead, where the gesture is. */
  /* ONLY THE MARKS PANE is rebuilt. The History pane is static markup in direct.html because it holds
     textareas, and reassigning innerHTML over a half-typed sentence takes the sentence and the caret with
     it — the same reason the metrics header and the notes textarea were made static before this. */
  const marksPane = document.getElementById('railMarks');
  if (marksPane) {
    marksPane.innerHTML = Probes.PRIMARY_TAP_CATEGORIES.map((t) =>
      `<span class="a${t.key === armedTap ? ' hot' : ''}" data-arm="${t.key}"`
      + ` title="${escapeHtml(t.hint)} — press twice quickly for a strong one"`
      + `><b>${t.kbd}${t.arrow ? ` ${arrowGlyphFor(t)}` : ''}</b>${escapeHtml(t.label)}`
      + `${t.grades ? ' <i style="opacity:.5">+1/2</i>' : ''}</span>`).join('')
      /* SAID ONCE, not on every row. The double-tap works on all ten now, so a "×2 = …" on each would be
         ten copies of one sentence in the panel that most needs to be short on a phone. */
      + '<div class="armedNote">Press any of these <b>twice quickly</b> for a strong one.</div>'
      + renderArrowEditorHtml();
    marksPane.querySelectorAll('[data-arm]').forEach((el) => {
      el.addEventListener('click', () => { armedTap = el.dataset.arm; renderArmedBar(); });
    });
    wireArrowEditor(marksPane);
  }
  ensureGrip(armedBarEl);
  renderMarkCount();       // the hint carries the tally
  renderRailTabs();
}

/*
 * WHICH TAB THE RAIL IS SHOWING.
 *
 * Marks is what you press; History is what has happened. Asked for as two tabs, and it also fixes the
 * column that was scrolling — two short panes rather than one long one with the arrow-key boxes below the
 * fold.
 */
let railTab = 'marks';
function renderRailTabs() {
  for (const b of armedBarEl.querySelectorAll('.railTab')) {
    b.classList.toggle('on', b.dataset.rail === railTab);
    if (!b.dataset.wired) {
      b.dataset.wired = '1';
      b.addEventListener('click', () => showRailTab(b.dataset.rail));
    }
  }
  for (const p of armedBarEl.querySelectorAll('.railPane')) {
    p.hidden = p.id !== (railTab === 'marks' ? 'railMarks' : 'railHistory');
  }
}

function showRailTab(next) {
  railTab = next === 'history' ? 'history' : 'marks';
  /* ONE SOURCE OF TRUTH for "the history is showing". `notesOpen` is read by the Notes pill's lit state
     and by the clock that keeps `at 0:42` counting while a note is being typed — and clicking the tab
     itself set neither, so the pill stayed dark and the stamp stayed at an em dash while the history was
     plainly on screen. Set here rather than only in toggleNotes, because this is the one function both
     the key and the tab go through. */
  notesOpen = railTab === 'history';
  renderNotesPanel();
  renderRailTabs();
  // The history is read from the notes store, so it is fetched when it is shown rather than kept warm.
  if (railTab === 'history') renderNoteList();
}

function fireProbe(due) {
  probePending = { index: due.index, atSec: due.atSec, cuedAt: Date.now() };
  // Two rising notes — distinct from the trial's single tone, so a probe is never
  // mistaken for a block boundary.
  tone(520, 130); setTimeout(() => tone(780, 200), 150);
  probeOptsEl.innerHTML = Probes.RESPONSES.map((r) =>
    `<button data-resp="${r.key}"><b>${r.kbd}</b><span>${escapeHtml(r.label)}`
    + `<span class="h">${escapeHtml(r.hint)}</span></span></button>`).join('');
  probeOptsEl.querySelectorAll('[data-resp]').forEach((b) => {
    b.addEventListener('click', () => answerProbe(b.dataset.resp));
  });
  probeMetaEl.textContent = `probe ${due.index + 1} of ${probeTimes.length}`
    + ' \u00b7 answer for the moment BEFORE the sound';
  probeHudEl.hidden = false;
}

async function answerProbe(key) {
  if (!probePending || !Probes.RESPONSE_BY_KEY[key]) return;
  const p = probePending;
  probePending = null;
  probeHudEl.hidden = true;
  // Latency is a MEASUREMENT, not a self-report: how long somebody takes to answer
  // suggests how far they had to come back from. It goes in as a feature.
  const latencySec = (Date.now() - p.cuedAt) / 1000;
  probeAnswers.push({ atSec: p.atSec, response: key, latencySec });
  await ensureRecording();
  if (recSession) {
    await recSession.addNote({ kind: 'probe', response: key, latencySec,
      probeIndex: p.index, probeAtSec: p.atSec, anchored: true });
  }
  const r = Probes.RESPONSE_BY_KEY[key];
  setStatus(`${r.label} \u00b7 ${latencySec.toFixed(1)}s`);
  statusLockUntil = Date.now() + 1600;
}

/*
 * Called from the tick, ABOVE the early return — a probe is a wall-clock event and a
 * headband dropout must not stall the schedule.
 */
/*
 * PROBES ARE OFF BY DEFAULT, and no longer implied by training mode.
 *
 * Asked for directly: "in training mode, I don't want the popups to come up." They were
 * tied to training on the reasoning that training is where the instrumentation lives —
 * but that made one switch mean two things, so turning on the tap panel also signed you
 * up to be interrupted by a question every few minutes. Those are different decisions and
 * one of them should be rare.
 *
 * They are kept, and kept opt-in, because they answer something self-caught taps
 * structurally cannot: a tap can only ever sample what you NOTICED, so it is blind to
 * being gone without knowing it. The toggle lives in the training panel, which is where
 * it is relevant, rather than taking another slot in the bar.
 */
let probesEnabled = false;

function updateProbes() {
  if (!probesEnabled || !trainingMode || !recArmed) {
    if (!probeHudEl.hidden && !probePending) probeHudEl.hidden = true;
    return;
  }
  if (probePending) {
    // An unanswered probe is recorded as a MISS rather than left hanging. A probe
    // nobody answered is data too: it usually means gone, or asleep.
    if ((Date.now() - probePending.cuedAt) / 1000 > Probes.DEFAULTS.responseTimeoutSec) {
      const p = probePending;
      probePending = null;
      probeHudEl.hidden = true;
      probeAnswers.push({ atSec: p.atSec, response: null, missed: true });
      if (recSession) {
        recSession.addNote({ kind: 'probe', response: null, missed: true,
          probeIndex: p.index, probeAtSec: p.atSec, anchored: true });
      }
      setStatus('probe missed \u2014 recorded as unanswered');
      statusLockUntil = Date.now() + 2500;
    }
    return;
  }
  const due = Probes.dueProbe(probeTimes, probeAnswers.length, sessionTSec());
  if (due) fireProbe(due);
}

// --- Saved sessions panel ---------------------------------------------------
async function openSessions() {
  summaryTitleEl.textContent = 'Saved sessions';
  summaryEl.classList.add('show');
  summaryBodyEl.innerHTML = '<p style="opacity:.6">reading\u2026</p>';
  let db, list;
  try {
    db = recDb || await Recorder.open();
    recDb = db;
    list = await Recorder.listSessions(db);
  } catch (err) {
    summaryBodyEl.innerHTML = `<p>Could not open storage: ${escapeHtml((err && err.message) || 'unknown')}</p>`;
    return;
  }
  if (!list.length) {
    // Copy that stopped being true when the Record pill was added, and a screen that
    // describes a behaviour the app no longer has is worse than one that says nothing.
    summaryBodyEl.innerHTML = '<p style="opacity:.7">Nothing saved yet. Connect a device and'
      + ' press <b>Record</b> \u2014 or turn Training on, which starts recording for you.</p>';
    return;
  }
  const q = recQuota;
  /* THE DEVICE CLOCK, SHOWN, because the app has no other one.
   *
   * Reported as "the date and time still off... off by a day and an hour and a half from what
   * i'm seeing". Every timestamp in this app is Date.now() rendered with the device's
   * timezone; there is no independent source of time, and nothing in here can detect a wrong
   * clock. What it CAN do is show what it is working from, next to the times it produced, so
   * a three-hour timezone error stops being a mystery about the app and becomes a visible
   * fact about the machine. The reassurance belongs here too: a constant offset moves every
   * label and no interval, so the data stays usable and can be corrected later. */
  let tz = 'unknown';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; } catch (err) { /* exotic runtime */ }
  const offMin = -new Date().getTimezoneOffset();
  const offStr = `${offMin < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0')}:`
    + String(Math.abs(offMin) % 60).padStart(2, '0');
  /* THE CROSS-CHECK, and a correction the user can state.
   *
   * Reported three times, finally: "i just recorded this (8/3) and the date still says 7/31. i
   * think all these dates might be off." Explaining where timestamps come from is not a fix. Two
   * things are offered instead: the measured verdict on whether this device's clock is even RUNNING
   * correctly (clockcheck.js compares it against the monotonic clock, which is proof rather than
   * opinion), and a place to say what the time actually is when the clock is merely SET wrong —
   * which no measurement on the device can detect. */
  const cc = clockCheck.report();
  const ccLine = !cc.available
    ? ''
    : cc.verdict
      ? `<div class="subtle" style="font-size:11.5px;color:#ffc98a;margin-bottom:8px">`
        + `<b>This device's clock is not running correctly.</b> Measured against the monotonic`
        + ` clock: ${escapeHtml(cc.reason)}. That is proof rather than a guess, and it means the`
        + ` times below are unreliable by roughly that much.</div>`
      : `<div class="subtle" style="font-size:11px;opacity:.6;margin-bottom:8px">`
        + `The clock is running correctly (checked against the monotonic clock over`
        + ` ${Math.round(cc.elapsedSec)}s, drift ${(cc.driftMs / 1000).toFixed(2)}s). That does`
        + ` <b>not</b> mean it is SET correctly — a clock wrong by whole days ticks perfectly, and`
        + ` nothing on this device can tell. If the times below are wrong, say so here.</div>`;
  const offLine = clockOffsetMs
    ? `Showing times corrected by <b>${(clockOffsetMs / 3600000).toFixed(2)}h</b>.`
      + ` Recorded data is untouched.`
    : 'Times below are exactly what the device reported.';
  const clockNote = `<div class="subtle" style="font-size:11px;opacity:.75;margin-bottom:10px">`
    + ccLine
    + `Device clock: <b>${escapeHtml(new Date().toLocaleString())}</b>`
    + ` &middot; ${escapeHtml(tz)} &middot; UTC${offStr}. ${offLine}<br>`
    + `<label style="display:inline-block;margin-top:6px">If it is actually`
    + ` <input id="clockActual" placeholder="HH:MM" maxlength="5"`
    + ` style="width:62px;font-size:11px;padding:2px 4px"> now,`
    + ` <button id="clockFix" style="font-size:11px">correct the display</button></label>`
    + `${clockOffsetMs ? ' <button id="clockClear" style="font-size:11px">remove correction</button>' : ''}`
    + `<br><span style="opacity:.7">A correction changes only what is shown. Every export keeps`
    + ` the device's own epochMs and UTC, so nothing is rewritten and no interval moves.</span></div>`;
  const rows = list.map((m) => {
    const d = displayTime(m.startedAt);
    const mins = Math.floor((m.durationSec || 0) / 60);
    const secs = Math.round((m.durationSec || 0) % 60);
    const live = recSession && recSession.id === m.id;
    /* THE MARK COUNT, because "some will be useless" and there was no way to tell.
       A sit with no marks cannot contribute to any event-locked analysis, and a date
       plus a duration does not say which those are. Shown plainly, and called out when
       it is zero rather than left as a quiet "0" to be scanned past. */
    const marks = m.markCount || 0;
    /* THE BREAKDOWN, not just the total. Eleven marks all of one kind cannot support any comparison
       BETWEEN kinds, which is the analysis these marks exist for — so a sit that looks rich in the
       list can be useless, and the total alone never says which. */
    /* Names from the same registries the keys are bound to, in the same order the note is read:
       probes.js TAP_BY_KEY is the authority on the arrow-key categories, Labels.TRANSITION_BY_KEY on
       the older transitions, Markers.KIND_BY_KEY on the typed marks. Falling back to the raw key
       rather than hiding an unrecognised kind — a mark whose category this file does not know about
       still happened, and dropping it from the tally would make the total disagree with the parts. */
    const kindLabel = (kind) => {
      const t = (typeof Probes !== 'undefined' && Probes.TAP_BY_KEY && Probes.TAP_BY_KEY[kind])
        || (typeof Labels !== 'undefined' && Labels.TRANSITION_BY_KEY && Labels.TRANSITION_BY_KEY[kind])
        || (typeof Markers !== 'undefined' && Markers.KINDS
            && Markers.KINDS.find((x) => x.key === kind));
      return (t && t.label) || kind;
    };
    const tally = (m.markTally || [])
      .map(([kind, n]) => `${n}\u00d7 ${escapeHtml(kindLabel(kind))}`).join(', ');
    const markText = marks
      ? `${marks} mark${marks === 1 ? '' : 's'}${tally ? ` <span style="opacity:.65">(${tally})</span>` : ''}`
        + ((m.markTally || []).length === 1 && marks > 1
          ? ' <span style="color:#ffc98a">— all one kind, so nothing to compare against</span>' : '')
      : '<span style="color:#ffc98a">no marks</span>';
    /* SAY WHEN A SESSION IS TOO LONG TO BE ONE SIT.
     *
     * Reported as "the dates/times don't look right. i just recorded this right now" against
     * a row stamped the previous afternoon. The timestamp was correct and the session was
     * not: a recording armed the day before had never stopped, so the row honestly showed
     * when it began and looked like a bug. Once a duration crosses a couple of hours the
     * start time stops meaning "when I sat down", and the row has to say so, because
     * everything downstream treats a session as one sit. */
    const longSit = (m.durationSec || 0) > 2 * 3600;
    const longNote = longSit
      ? `<br><span style="color:#ffc98a">${(m.durationSec / 3600).toFixed(1)} hours \u2014 longer`
        + ' than one sit. Recording probably ran on after you finished, so the start time above'
        + ' is when it began, not when you sat. Analysis treats a session as one sit.</span>'
      : '';
    return `<div class="sesRow" data-id="${escapeHtml(m.id)}">`
      + `<span class="sesWhen">${escapeHtml(d.toLocaleString())}`
      // Editable in place. A name is worth nothing if adding one is a chore, and this is
      // the moment you remember what the sit was.
      + `<br><input class="sesLabel" data-act="label" value="${escapeHtml(m.label || '')}"`
      + ` placeholder="name or note \u2014 what was this sit?" maxlength="120">`
      + longNote
      + `<br><span class="sesMeta">${mins}m ${secs}s \u00b7 ${markText}`
      + ` \u00b7 ${((m.bytes || 0) / 1e6).toFixed(1)}MB`
      + `${live ? ' \u00b7 recording now' : (m.ended ? '' : ' \u00b7 interrupted')}</span></span>`
      + `<button data-act="lab">Send to lab</button>`
      + `<button data-act="dl">Download .zip</button>`
      + `<button data-act="rm" class="danger">Delete</button></div>`;
  }).join('');
  summaryBodyEl.innerHTML = clockNote + rows
    + `<p class="sesMeta" style="margin-top:14px">Each .zip holds the raw EEG, the`
    + ` per-second scores as CSV, your voice notes as audio, and a markdown summary`
    + ` with timestamps.${q && q.quotaBytes ? ` Using ${(q.usageBytes / 1e6).toFixed(0)}MB`
      + ` of about ${(q.quotaBytes / 1e6).toFixed(0)}MB available.` : ''}</p>`;

  const actualEl = document.getElementById('clockActual');
  const fixEl = document.getElementById('clockFix');
  if (fixEl && actualEl) {
    fixEl.addEventListener('click', () => {
      const off = (typeof ClockCheck !== 'undefined' && ClockCheck.offsetFromStatedTime)
        ? ClockCheck.offsetFromStatedTime(actualEl.value) : null;
      if (off == null) {
        /* Refused rather than guessed. Near half a day a time of day cannot say which direction the
           correction goes, and a twelve-hour error applied backwards puts every sit on the wrong
           day — the exact bug this exists to fix. */
        setStatus('Could not use that. Enter the time as HH:MM. If the clock is out by around'
          + ' twelve hours or by whole days, fix the device\u2019s clock instead — a time of day'
          + ' alone cannot say which way the correction goes.');
        statusLockUntil = Date.now() + 9000;
        return;
      }
      clockOffsetMs = ClockCheck.writeOffset(off) || 0;
      openSessions();
    });
  }
  const clearEl = document.getElementById('clockClear');
  if (clearEl) {
    clearEl.addEventListener('click', () => {
      clockOffsetMs = ClockCheck.writeOffset(0);
      openSessions();
    });
  }

  /* Names save on blur and on Enter, never on every keystroke: one write per edit rather
     than one per letter, and no re-render mid-typing to move the caret. */
  summaryBodyEl.querySelectorAll('.sesLabel').forEach((input) => {
    const save = async () => {
      const id = input.closest('.sesRow').dataset.id;
      const was = input.dataset.saved == null ? input.defaultValue : input.dataset.saved;
      if (input.value === was) return;
      try {
        await Recorder.labelSession(db, id, input.value);
        input.dataset.saved = input.value;
        setStatus(input.value ? `named: ${escapeHtml(input.value)}` : 'name cleared');
      } catch (err) {
        setStatus(`could not save the name: ${escapeHtml((err && err.message) || 'unknown')}`);
      }
      statusLockUntil = Date.now() + 2000;
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      // Kept off the global shortcuts, or typing a name would drop marks mid-list.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  });

  summaryBodyEl.querySelectorAll('.sesRow button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.sesRow').dataset.id;
      if (btn.dataset.act === 'rm') {
        // No confirm dialog for a live session — just refuse. Deleting the sit you
        // are currently in is never what anyone meant.
        if (recSession && recSession.id === id) {
          setStatus('that session is still recording'); statusLockUntil = Date.now() + 2500; return;
        }
        await Recorder.deleteSession(db, id);
        openSessions();
        return;
      }
      /* SEND TO LAB, for any sit in the list. The handoff writes archive bytes into the lab's inbox
         and opens the lab in a new tab; openInLab() reports its own failures, including the blocked
         popup and the file:// storage case, so there is nothing to add here beyond passing the id. */
      if (btn.dataset.act === 'lab') {
        recDb = db;                    // openInLab reads recDb, which may not be set yet on this path
        await openInLab(btn, id);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'building\u2026';
      try {
        await downloadSession(db, id);
        btn.textContent = 'Download .zip';
      } catch (err) {
        btn.textContent = 'failed';
        setStatus(`export failed: ${escapeHtml((err && err.message) || 'unknown')}`);
        statusLockUntil = Date.now() + 6000;
      }
      btn.disabled = false;
    });
  });
}

/*
 * A stored session as archive bytes. One place that knows how to do this, because there
 * are now two reasons to want it — downloading, and handing the sit to the lab — and two
 * copies of the packaging would eventually produce two different archives from one sit.
 * `archiveMeta` comes back so the caller can name the file the same way either way.
 */
async function buildSessionArchive(db, id) {
  // Flush first: the session being exported may be the one still running, and
  // up to a few seconds sit in memory between commits.
  if (recSession && recSession.id === id) await recSession.flush();
  const session = await Recorder.loadSession(db, id);
  if (!session) throw new Error('session not found');
  // Audio has to be read out of its Blobs before the archive can be built, since
  // zip needs bytes rather than promises.
  const audio = {};
  for (const n of session.notes) {
    if (n.kind !== 'voice' || !n.audio) continue;
    audio[n.id] = new Uint8Array(await n.audio.arrayBuffer());
  }
  const { files } = Exporter.buildFiles(session, audio);
  const bytes = Exporter.zip(files, { date: new Date(session.meta.startedAt) });
  bytes.archiveMeta = session.meta;
  return bytes;
}

async function downloadSession(db, id) {
  const bytes = await buildSessionArchive(db, id);
  const session = { meta: bytes.archiveMeta };
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = Exporter.archiveName(session.meta);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a delay: revoking immediately can cancel the download in some
  // browsers before it has actually started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* --- Notes panel: write, review, delete ------------------------------------
 *
 * Typed notes rather than voice, by request, for a retreat where the plan is a few
 * reflections per sit rather than moment-by-moment capture. This removes the
 * transcription problem entirely: text is already searchable and already aligned.
 * Voice stays available for when talking is easier than typing.
 *
 * THE ANCHOR TOGGLE. A note is either about a MOMENT or about the SIT. Anchored is
 * the default because it is the useful case for finding patterns later — it pins the
 * note to a point in the signal. Unanchored notes are exported with a BLANK offset
 * rather than 0, because writing 0 would place a reflection about the whole sit at
 * its opening second, which is a claim nobody made.
 */
const noteAnchoredKey = 'zenbio.noteAnchored';
let noteAnchored = localStorage.getItem(noteAnchoredKey) !== 'false';

/*
 * Which arrow currently marks this category, as a glyph — or '' if none does.
 *
 * Derived from the live binding rather than from the category's own `arrow` field. Reading the field
 * would print the DEFAULT arrow next to a category the user has since unbound, which is worse than
 * printing nothing: a pill that teaches a key that does nothing.
 */
function arrowGlyphFor(tap) {
  if (!tap || !Probes.readArrowMap) return tap && tap.arrow ? (Probes.ARROW_GLYPH[tap.arrow] || '') : '';
  const map = Probes.readArrowMap();
  for (const arrow of Probes.ARROWS) {
    if (map[arrow] === tap.kbd) return Probes.ARROW_GLYPH[arrow] || '';
  }
  return '';
}

/*
 * ASSIGN THE ARROWS, as asked: "i can just put in a letter in a space and it ties that arrow key to
 * the letter command for the markers."
 *
 * The four arrows are the only marks that can be made without looking at anything, so which categories
 * they carry is worth choosing rather than inheriting. One text box per arrow, holding the keyboard
 * letter of the category it should mark; empty unbinds it.
 *
 * IT LIVES IN THE MARK PANEL NOW, not in Notes. Asked for directly: "the arrow key assignment makes
 * much more sense from the Mark panel than the notes panel." Obviously right — it is a control over
 * what the marks are, and it sat in the panel for writing prose, which meant opening Notes mid-sit to
 * change a key that marks something else.
 *
 * SPLIT INTO MARKUP AND WIRING because the mark bar rebuilds its whole innerHTML on every render, so
 * the editor has to be part of that string rather than something injected into a host afterwards —
 * otherwise every re-render would wipe it.
 */
function renderArrowEditorHtml() {
  const map = Probes.readArrowMap();
  /*
   * NO KEY LEGEND. It listed "C = Concentrating · A = Naturally concentrated · ..." — every letter and
   * its meaning — directly beneath the list that already shows exactly that, one letter per row, a
   * centimetre above. Reported as "we don't need the legend: it's right above", which is right: on a
   * phone it was four lines of duplication in the panel that most needs to be short.
   *
   * THE ARROW GLYPHS ARE LEGIBLE NOW. They were rgba(255,255,255,.85) inside a container the browser
   * was free to render at whatever weight a monospace fallback gives, at 15px, and on the phone they
   * effectively vanished — reported as "the arrows don't show". They are the whole point of the row:
   * without them the four boxes are unlabelled. Given their own class, at full opacity, sized up, and
   * with the box beneath rather than beside so a narrow rail lays them out in a row of four rather than
   * wrapping into two.
   */
  return `<div class="arrowEditor">`
    + `<div class="sideHead" style="margin-bottom:6px">Arrow keys</div>`
    + `<div class="arrowRow">`
    + Probes.ARROWS.map((a) => `<label class="arrowSlot">`
      + `<span class="arrowGlyph">${Probes.ARROW_GLYPH[a]}</span>`
      + `<input data-arrowkey="${a}" value="${escapeHtml(map[a] || '')}" maxlength="1"`
      + ` aria-label="mark made by the ${a.replace('Arrow', '').toLowerCase()} arrow"`
      + `></label>`).join('')
    + `</div><div class="arrowHelp">`
    + `Type a letter from the list above; blank unbinds that arrow.`
    + `</div></div>`;
}

function wireArrowEditor(host) {
  if (!host) return;
  host.querySelectorAll('[data-arrowkey]').forEach((input) => {
    // Kept off the global shortcuts, or typing a letter here would also fire the mark it names.
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const apply = () => {
      const next = {};
      host.querySelectorAll('[data-arrowkey]').forEach((el) => {
        next[el.dataset.arrowkey] = el.value.trim().toUpperCase();
      });
      const saved = Probes.writeArrowMap(next);
      // Re-read rather than trusting what was typed: writeArrowMap drops any letter that does not name
      // a real category, and the boxes must show what actually took effect.
      host.querySelectorAll('[data-arrowkey]').forEach((el) => {
        el.value = saved[el.dataset.arrowkey] || '';
      });
      setStatus('arrow keys updated');
      statusLockUntil = Date.now() + 1600;
      /* renderPatternBar only. Re-rendering the ARMED bar from here would destroy the input that is
         mid-blur and, on a `change` followed by a `blur`, run this twice against a detached node. The
         glyphs it would refresh are in the same string this editor lives in, so they are already
         redrawn on the next tick. */
      renderPatternBar();
    };
    input.addEventListener('change', apply);
    input.addEventListener('blur', apply);
  });
}

/*
 * NOTES: A PANEL, TOGGLED — not a modal that covers the sit.
 *
 * Asked for: "i want that to be something on the screen that maybe opens and stays there... then when i
 * click on it again, i see all that in the panel and can still add something new."
 *
 * It used to build its markup into #summary, a full-screen overlay. That hid the visual and the clock, so
 * a note about what was happening had to be written after it had stopped happening — and the panel had
 * to be closed to see anything, which is the opposite of "stays there".
 *
 * The markup is static in direct.html now for the same reason the metrics header is: this panel holds a
 * textarea, and rebuilding it on every render would throw away half-typed text and the caret with it.
 */
/*
 * "NOTES" IS THE RAIL'S HISTORY TAB NOW.
 *
 * There was a separate Notes panel with its own textarea and its own list. Both wrote to the same notes
 * store as the marks — a tap is a note with a category on it — so the split existed only on screen, and it
 * meant what you thought about the sit was filed somewhere other than what happened in it. Asked for:
 * "the notes and marks should be consolidated."
 *
 * `notesOpen` survives as "the history is showing", because the Notes pill's active state and the N key
 * both read it.
 */
let notesOpen = false;

function renderNotesPanel() {
  const link = document.getElementById('notesLink');
  if (link) link.classList.toggle('active', notesOpen);
}

function toggleNotes(force) {
  notesOpen = force == null ? !notesOpen : !!force;
  /* Notes only exist inside a sit being trained, which is where the rail is. Turning Training on rather
     than failing silently: the alternative is a key that does nothing and looks broken. */
  if (notesOpen && !trainingMode) setTrainingMode(true);
  showRailTab(notesOpen ? 'history' : 'marks');
  renderNotesPanel();
  if (!notesOpen) return;
  const box = document.getElementById('noteBox');
  if (box) box.focus();
}

function openNotes() { toggleNotes(true); }

/* Wired once, to nodes that live for the life of the page. The stamp keeps counting while a note is being
   typed, because it records when the note is SAVED rather than when the panel opened. */
{
  const box = document.getElementById('noteBox');
  const anchorBox = document.getElementById('noteAnchor');
  const stampEl = document.getElementById('noteStamp');
  if (anchorBox) {
    anchorBox.checked = noteAnchored;
    anchorBox.addEventListener('change', () => {
      noteAnchored = anchorBox.checked;
      try { localStorage.setItem(noteAnchoredKey, String(noteAnchored)); } catch (e) { /* private mode */ }
    });
  }
  if (stampEl) {
    setInterval(() => {
      if (!notesOpen) return;
      stampEl.textContent = recSession ? Exporter.clock(sessionTSec()) : '\u2014';
    }, 1000);
  }
  if (box) {
    // Ctrl/Cmd+Enter saves; plain Enter must keep making paragraphs. stopPropagation because every
    // letter here would otherwise also fire the mark it names.
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
      if (e.key === 'Escape') { e.preventDefault(); toggleNotes(false); }
    });
  }
  const saveBtn = document.getElementById('noteSave');
  if (saveBtn) saveBtn.addEventListener('click', saveNote);
}

async function saveNote() {
  const box = document.getElementById('noteBox');
  if (!box) return;
  const text = box.value.trim();
  if (!text) return;
  await ensureRecording();
  if (!recSession) {
    setStatus(`not saved — recording unavailable (${escapeHtml(recError || 'no session')})`);
    statusLockUntil = Date.now() + 6000;
    return;
  }
  await recSession.addNote({ kind: 'text', text, anchored: noteAnchored });
  box.value = '';
  box.focus();
  renderNoteList();
  setStatus(noteAnchored ? 'note saved at this moment' : 'general note saved for the whole sit');
  statusLockUntil = Date.now() + 1400;
}

async function renderNoteList() {
  const list = document.getElementById('noteList');
  if (!list) return;
  if (!recSession) {
    list.innerHTML = '<p style="opacity:.6">No session recording yet — connect the headband,'
      + ' or write a note anyway and it will start one.</p>';
    return;
  }
  /* NEVER REBUILD UNDER A CARET. Each row carries a field for saying what the mark was, so if one of
     them has focus the practitioner is mid-sentence and replacing the innerHTML would take the box and
     the caret with it. The list is rebuilt again on the next mark, save or delete, so nothing is lost by
     waiting — the same rule the metrics header and the notes textarea are held to. */
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const notes = await Recorder.listNotes(recDb, recSession.id);
  if (!notes.length) { list.innerHTML = '<p style="opacity:.6">No notes in this sit yet.</p>'; return; }
  // Newest first: the note you just wrote is the one you might want to remove.
  list.innerHTML = notes.slice().reverse().map((n) => {
    const when = n.anchored === false ? 'whole sit' : Exporter.clock(n.offsetSec);
    /* NAME THE MARK. A tap's row used to show only its stored text, so a list of marks read as a list of
       bare words with no indication of which category each was — and this list is where a mark gets
       deleted, which is exactly when you need to be sure which one you are deleting. */
    const kind = n.tapCategory || n.transition;
    const cat = kind && ((Probes.TAP_BY_KEY && Probes.TAP_BY_KEY[kind])
      || (Labels.TRANSITION_BY_KEY && Labels.TRANSITION_BY_KEY[kind]));
    const body = n.kind === 'voice'
      ? `<em style="opacity:.7">voice note, ${(n.seconds || 0).toFixed(0)}s</em>`
      : (cat
        ? `<b>${escapeHtml(cat.label)}</b>${n.comment ? ' — ' + escapeHtml(n.comment) : ''}`
        : escapeHtml(n.text || '(empty)'));
    /* A MARK'S ROW CARRIES A FIELD FOR SAYING WHAT IT WAS.
       "so i see them and can edit or delete?" \u2014 the per-mark note box used to live in a separate mark
       list, and consolidating the two lists into this one would have dropped it. A tap is one keypress
       with no words attached; the words are the only thing that makes it recoverable months later.
       Voice notes and the whole-sit label are edited where they are written, so they get no box. */
    const editable = !!cat && n.kind !== 'voice';
    return `<div class="noteItem${editable ? ' hasNote' : ''}" data-id="${n.id}">`
      + `<span class="noteWhen">${escapeHtml(when)}</span>`
      + `<span class="noteText">${body}</span>`
      + `<button class="noteX" title="delete this note">\u00d7</button>`
      + (editable ? `<input class="noteEdit" data-comment="${n.id}"`
        + ` value="${escapeHtml(n.comment || '')}" placeholder="what was it?" maxlength="200">` : '')
      + `</div>`;
  }).join('');

  list.querySelectorAll('[data-comment]').forEach((input) => {
    // Off the global shortcuts, or typing "t" about a mark would make another mark.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const id = Number(input.dataset.comment);
      const text = input.value.trim();
      /* THE `comment` FIELD, never `text`. A tap's `text` is its own category label, written the instant
         the key went down, and overwriting it would turn "Thinking" into whatever was typed \u2014 the tap
         category is what the whole analysis keys off. Same rule as the summary editor. */
      Recorder.updateNote(recDb, id, { comment: text })
        .then(() => { markerLog.annotateByNoteId(id, text); renderNoteList(); })
        .catch(() => { /* the screen still has it */ });
    });
  });
  list.querySelectorAll('.noteX').forEach((x) => {
    x.addEventListener('click', async () => {
      const id = Number(x.closest('.noteItem').dataset.id);
      // No confirmation dialog: the list is right there, and re-typing a lost note
      // is a smaller cost than a modal in the middle of a sit.
      await Recorder.deleteNote(recDb, id);
      /* AND OUT OF THE IN-MEMORY TALLY TOO. Asked for: "would also like to be able to delete a mark if
         i just made it." Deleting the stored note was already possible from this list, but the mark
         count on screen is kept separately in markerLog — so a deleted mark vanished from the archive
         while the readout still counted it, which is two records of one sit disagreeing. */
      markerLog.removeByNoteId(id);
      renderMarkCount();
      renderNoteList();
    });
  });
}

document.getElementById('notesLink').addEventListener('click', () => toggleNotes());

document.getElementById('sessionsLink').addEventListener('click', openSessions);

setInterval(updateBreathing, 2000);

// The breath row: a centred bar whose midpoint is the turnaround between
// in-breath and out-breath, per the request. Amount is a real phase estimate
// from RSA, so it lags the actual breath by about a fifth of a cycle (measured,
// see test-polar.js) — labelled "est" so that is visible rather than implied.
// ONE breath row, not three. An earlier version rendered breath as a composite
// bar, a rate row, AND a phase bar — three rows all labelled "Breath", each
// saying something different. Rate and direction now share the phase row.
function breathRow() {
  const rateSec = strapBreathSec != null ? strapBreathSec : breathPeriod;
  const rate = rateSec == null ? null : Math.round(60 / rateSec);
  // Where the number comes from, because they are not equally good. Chest motion
  // is the breath; RSA is an inference from beat timing that trails it by about a
  // second. Showing them identically would hide a real difference in quality.
  const src = breathSource === 'chest' ? 'chest' : breathSource === 'rsa' ? 'heart' : null;
  const tip = breathSource === 'chest'
    ? 'from chest-wall motion (strap accelerometer) — no lag, and a hold is visible'
    : 'estimated from heart timing; lags about a second';
  let bar, val;
  if (breathAmount == null) {
    // No respiratory signal is a real state — a fast heart has little RSA, and
    // breath-holding has none. An empty bar and "no signal" is honest; a bar
    // parked at the midpoint would claim we can see the turnaround.
    bar = '<span class="rBarC"></span>';
    val = rate == null ? 'reading…' : `${rate}/min`;
  } else {
    const a = Math.max(-1, Math.min(1, breathAmount));
    const pct = Math.round(Math.abs(a) * 50);
    // Right of centre on the in-breath, left on the out-breath.
    const cls = (a >= 0 ? 'rt' : 'lf') + (breathHolding ? ' held' : '');
    bar = `<span class="rBarC"><i class="${cls}" style="width:${pct}%"></i></span>`;
    /* A HOLD IS ITS OWN STATE, and this is what the accelerometer bought us.
     *
     * Held at the top of an inhale, the chest stays expanded — so the bar stays
     * right of centre and says "hold" instead of continuing to claim a direction
     * it no longer has. RSA could never do this: it sees respiratory modulation of
     * beat timing, and a held breath has none, so a hold and a dead sensor were
     * indistinguishable. This is the difference the user was looking for.
     */
    val = breathHolding ? 'hold'
      : `${rate == null ? '' : rate + '/min '}${breathRising ? 'in' : 'out'}`;
  }
  /* THE FLIP AFFORDANCE, only for the chest signal.
   *
   * The accelerometer cannot know which direction is inhale — the strap can be worn
   * either way up — so the sign is INFERRED by correlating against RSA. A wrong
   * inference draws a perfectly good signal upside down, and nothing in the data looks
   * wrong, so there was no way to notice or to correct it. Reported as "is it possible
   * that the graph is inverted even if the data is good": yes, and it now has a fix.
   *
   * Offered only when the reading comes from the chest. RSA's direction is known from
   * physiology (heart rate rises on inhalation), so there is nothing to flip there and
   * a button suggesting otherwise would invite breaking a correct signal. */
  const flip = breathSource === 'chest'
    ? '<span class="rFix" data-breath-cal title="Press this WHILE BREATHING IN.'
      + ' The strap can be worn either way up, so which direction is inhale is inferred'
      + ' from heart-rate timing and can be inferred wrongly. This sets it from you'
      + ' instead, and stops the guess overriding it.">in?</span>'
    : '';
  // EXACTLY three children, matching .rRow's three grid columns. A fourth (a tier
  // light) wraps the value onto its own line — which is what put "6/min in" on a
  // row of its own. Tier confidence lives in the info overlay by design.
  return `<div class="rRow" title="${tip}">`
    + `<span class="rLabel">Breath${src ? ` <em>${src}</em>` : ''}${flip}</span>`
    + `${bar}<span class="rVal">${val}</span></div>`;
}

/* Delegated, because #readoutRows is rebuilt four times a second — a listener bound to
 * the button itself would be destroyed by the next tick. */
readoutRowsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-breath-cal]');
  if (!btn || !accelBreath) return;
  const res = accelBreath.calibrateInhaling();
  if (res.ok) {
    // Persisted: it describes how the strap is worn, which does not change between
    // sits, and re-calibrating every session would make it feel broken.
    try { localStorage.setItem('zenbio.breathSign', String(res.sign)); } catch (err) { /* private mode */ }
    setStatus('breath direction set from you — in-breath is now the right-hand side');
  } else {
    // Refusing is the honest outcome at the turnaround: the signal is near zero there
    // and its sign is noise, so a mistimed press would latch a coin flip.
    setStatus(`could not set the breath direction: ${escapeHtml(res.reason)}`);
  }
  statusLockUntil = Date.now() + 4000;
});


/*
 * WHAT THE PANEL SAYS WHEN NOTHING IS CONNECTED.
 *
 * Until this existed, a fresh page showed the visual, the control bar, and NOTHING ELSE. The Metrics
 * panel only became visible when a Bluetooth connection succeeded, so the whole of a working app's
 * first screen was indistinguishable from a broken one — and the Metrics pill sat there lit up as
 * `active`, which made it worse than silence: the UI was reporting a panel as open while showing
 * nothing at all.
 *
 * "I don't see any panels. Do I need to connect in order to see the metrics?" is exactly the right
 * question, and the app should never have made anyone ask it. Yes — but nothing said so, and the app
 * already knew.
 *
 * So the panel opens on load and answers it. No values, because there are none and dashes in a table
 * read as broken sensors rather than as an absent device; a sentence instead, naming the next action
 * and where to click.
 */
function renderNotConnectedReadout() {
  readoutRowsEl.innerHTML =
    '<div class="rNote"><b>No headband connected.</b><br>'
    + 'Press <b>Connect</b> at the bottom right, then choose your Muse in the'
    + ' chooser Chrome pops up.<br><span class="rNoteDim">A page reload always drops the'
    + ' connection, even when the headband still shows as paired — so this is what you see after'
    + ' every refresh.</span></div>';
  readoutEl.classList.add('show');
  renderViewSwitch();
}

// A minimal readout for when the strap is connected but the headband isn't. The
// strap alone genuinely measures three things — heart rate, HRV, and a real
// breathing rate from RSA — and none of them need EEG.
function renderStrapOnlyReadout() {
  // Three children only — see breathRow().
  const line = (label, text) => `<div class="rRow"><span class="rLabel">${label}</span>`
    + `<span class="rBar"></span><span class="rVal">${text}</span></div>`;
  const rows = [];
  rows.push(line('Heart', hrBpm == null ? 'reading…' : `${hrBpm} bpm`, 'solid'));
  rows.push(line('HRV (RMSSD)', hrvRmssd == null
    ? `reading… (${rrBuffer.length}/20 beats)` : `${Math.round(hrvRmssd)} ms`, 'solid'));
  rows.push(breathRow());
  if (strapUnreliable()) {
    rows.push(line('Strap', strapContact === false
      ? 'no skin contact' : `${Math.round(rrBuffer.rejectRate() * 100)}% rejected`));
  }
  rows.push(line('Headband', 'not connected'));
  // Into the rows container, NOT into #readout: assigning to #readout here would
  // delete the static header and the view switch, reintroducing the same bug by a
  // different route.
  readoutRowsEl.innerHTML = rows.join('');
  readoutEl.classList.add('show');
}

renderDevices();   // initial paint; must come after the device state declarations
/* Painted here as well as on the tick, so the first frame is never the blank screen this exists to
   prevent. A quarter of a second of "is this thing broken?" is how the question gets asked. */
renderNotConnectedReadout();

let tickCount = 0;
setInterval(() => {
  // These three run FIRST, unconditionally. They used to sit after an early
  // return that required Muse data, which meant a strap-only session showed a
  // permanently stuck status message and never displayed a single heart row.
  renderDevices();
  renderLiveDot();
  renderBarModes();
  /* ABOVE the early return, deliberately — see the note below and HANDOFF §3. This tracks whether
     Meditate should be bare, and the transition it exists to catch (nothing connected -> streaming) is
     exactly the moment `result` is still null. Below the return it would only fire once a headband was
     already delivering, which is one tick too late and, on a strap-only sit, never.
     Idempotent: classList.toggle with an explicit boolean, and applyPlaceChrome only reassigns panel
     state when the answer has changed. */
  if (!trainingMode && document.body.classList.contains('preflight') === meditateIsBare()) {
    applyPlaceChrome();
  }
  const lockedNow = Date.now() < statusLockUntil;
  if (!lockedNow && !museConnected() && !museConnecting) {
    setStatus(strapConnected()
      ? 'heart strap linked \u00b7 connect the headband when you\u2019re ready'
      : '', { hide: !strapConnected() });
  }

  const result = computeCalm();
  /* The timer must fire even with no EEG. It used to live further down, BELOW the
   * `if (!result) return` that requires Muse data — so a headband that dropped out
   * meant the timer silently never completed and the sit never got packaged. Same
   * trap that once left the strap's status message on screen forever; anything that
   * must happen on a wall clock belongs above that return, not below it.
   */
  checkTimerDone();
  // Also above the early return: a trial block boundary is a wall-clock event, and a
  // headband dropout must not silently stall a protocol halfway through.
  updateTrial();
  updateProbes();

  if (!result) {
    // Strap-only operation is a legitimate state: the strap alone gives heart
    // rate, HRV and a real breathing rate, none of which need the headband.
    if (strapConnected()) renderStrapOnlyReadout();
    /* And no device at all is also a legitimate state — it is the state every page load starts in.
       It used to render nothing, which is why a working app's first screen looked broken. */
    else if (!museConnected()) renderNotConnectedReadout();
    if (lastDataAt && !lockedNow) setStatus('gathering signal — sit still for a moment…');
    return;
  }
  const channels = computeChannelLabels(); // one call, reused for readout + bands + chart
  updateBandState(channels);
  recentReturns += bandState.filter((b) => b.spike > 0.9).length;

  computeFeatures(result);

  // In composite view the visual is tuned to the SELECTED composite, not to
  // the raw sensor-derived calm score — that was the point of the toggle.
  const driver = viewMode === 'composites' ? Metrics.compute(primaryMetric, features) : null;
  /* TELL THE VISUAL WHAT IS DRIVING IT, so its key can say so. Eclipse and the other
     single-value visuals follow whichever composite is selected; without the name on screen,
     switching from Calm to Focus changes the image in a way nobody can see is a change. */
  visual.setDriver(viewMode === 'composites' ? (Metrics.get(primaryMetric) || {}).label : null);
  // Pulse draws one ring per composite, so it needs them by key rather than
  // just the single selected driver. Nulls are passed through untouched —
  // setState merges, so a metric with no inputs holds instead of reading zero.
  const pulseMetrics = {};
  for (const m of VizCore.PULSE_METRICS) {
    const v = Metrics.compute(m.key, features);
    if (v != null) pulseMetrics[m.key] = v;
  }

  visual.setState({
    calm: driver == null ? result.calm : driver,
    noise: result.artifactRate,
    activity: result.activity,
    // Strap first when present: the Breath visual should pace off the cleanest
    // available measurement of the actual breath, not the noisiest.
    breathPeriod: strapBreathSec != null ? strapBreathSec
      : (breathPeriod != null ? breathPeriod : 0),
    // The MEASURED phase, so "Follow me" genuinely follows rather than running a
    // synthetic sine at roughly the right rate. Null when there is no reliable
    // respiratory signal, and the visual falls back to its own pacer.
    breathAmount: strapUnreliable() ? null : breathAmount,
    metrics: pulseMetrics,
    bands: bandState.map((s) => ({ level: s.level, spike: s.spike, fresh: s.fresh })),
  });

  const stale = Date.now() - lastDataAt > 2000;
  clockCheck.sample();
  checkRunawayRecording();
  const statusLocked = Date.now() < statusLockUntil;
  if (statusLocked) {
    /* a transient message (visual mode name / a cue) owns the status line */
  } else if (stale) setStatus('signal lost — check the headband fit');
  else setStatus('', { hide: true });

  // Cues: silence is the default. At most one every 5 minutes, only when
  // there is something worth saying, and never the same one twice running.
  if (!statusLocked && !stale && sessionStartedAt != null) {
    const nowSec = (Date.now() - sessionStartedAt) / 1000;
    if (nowSec - settledStreakFrom > 0 && result.calm <= 0.6) settledStreakFrom = nowSec;
    const cue = cueEngine.update({
      tSec: nowSec,
      calm: result.calm,
      activity: result.activity == null ? 0.5 : result.activity,
      noise: result.artifactRate,
      recentReturns: recentReturns,
      settledStreakSec: result.calm > 0.6 ? nowSec - settledStreakFrom : 0,
    });
    if (cue) {
      setStatus(cue.text);
      statusLockUntil = Date.now() + 9000; // long enough to actually read
      recentReturns = 0;
    }
  }

  // One understated, plain-English readout. No jargon, no Greek letters,
  // no raw ratios — this is the only interface; there is no separate
  // technical/debug view anymore. Two groups: the raw per-sensor readings,
  // then the composite/rolled-up metrics built from them.
  const noiseLabel = result.artifactRate > 0.5 ? 'High' : result.artifactRate > 0.15 ? 'Some' : 'Low';
  const brainLabel = result.ratio == null ? '—' : result.alphaSum > result.betaSum ? 'Alpha (restful)' : 'Beta (active)';
  // A row with a level bar reads at a glance in a way a bare number does not.
  // Confidence tiers stay in the info overlay; the live table stays visually quiet.
  const row = (label, value01, { text = null, tier = null, color = null, primary = false, title = null } = {}) => {
    const pct = value01 == null ? 0 : Math.round(Math.max(0, Math.min(1, value01)) * 100);
    const bar = value01 == null ? '<span class="rBar"></span>'
      : `<span class="rBar"><i style="width:${pct}%;background:${color || 'rgba(255,255,255,.75)'}"></i></span>`;
    const val = text != null ? text : (value01 == null ? '—' : pct);
    return `<div class="rRow${primary ? ' primary' : ''}"${title ? ` title="${title}"` : ''}>`
      + `<span class="rLabel">${label}</span>${bar}<span class="rVal">${val}</span></div>`;
  };

  /*
   * THREE GROUPS, filled as the rows are built. `into('signal', row(...))` rather than one flat array,
   * so where a reading belongs is decided once, next to the reading, instead of by its position in a
   * list that anything can be inserted into.
   */
  const grouped = { mind: [], body: [], signal: [] };
  const into = (group, html) => { grouped[group].push(html); };
  // A composite's group comes from the one table; anything unlisted goes to MIND and says so in the
  // console rather than vanishing, because a metric that renders nowhere looks like a broken metric.
  const groupOf = (key) => {
    const g = METRIC_GROUP[key];
    if (g) return g;
    console.log(`[metrics] "${key}" has no MIND/BODY/SIGNAL group — showing it under Mind`);
    return 'mind';
  };

  /*
   * NO SENSORS/COMPOSITES SWITCH ANY MORE. Reported: "i dont think the sensors and composites makes
   * sense with the content on it. i like the division but calm is on sensors (it's a composite) and all
   * the stuff on body and signal are raw data."
   *
   * Exactly right, and the two controls were fighting each other. MIND / BODY / SIGNAL already IS the
   * sensors-versus-composites distinction, drawn more usefully: MIND is the interpreted scores, BODY and
   * SIGNAL are raw measurements. Putting a Sensors/Composites toggle above that grouping means each
   * group's contents change meaning depending on a switch that claims to divide them the same way —
   * hence a composite appearing under "Sensors", and BODY and SIGNAL holding raw data under both.
   *
   * So the panel now shows everything, once, in the three groups. The switch is not gone from the app —
   * it still chooses which lines the CHART plots, which is a real and different job — it has moved to
   * the live feed where that is what it does.
   */
  {
    /* PER-CHANNEL CONTACT IS SIGNAL. Four electrodes' fit is a measurement-quality fact, and it used
       to head the same undifferentiated list as Calm — which is exactly how a floating electrode gets
       read as a state of mind. */
    channels.forEach(({ name, label, pct, artifact, ptp, floating, flat }, i) => {
      const c = VizCore.CHANNEL_COLORS[i];
      // The µV figure only when something is wrong: it is a diagnostic, and a healthy
      // channel showing one would be four numbers to ignore for the whole sit.
      const text = artifact && ptp != null
        ? `${label} · ${Math.round(ptp)}\u00b5V` : label;
      /* WHAT TO DO ABOUT IT, on hover, and only for "No contact".
       * Asked, of the two ear channels: "any idea why tp 9 and 10 say disconnected?"
       * The app already knew the answer — the input is floating, not noisy — and kept it
       * in a source comment, where nobody sits reading it. The advice is per-position
       * because it genuinely differs: the ear tips dry out and need wetting, while the
       * frontal pair sit on hair or slide up the forehead.
       */
      const fix = flat
        ? `${name} is delivering a flat line — the stream is arriving but carries no signal`
          + ' at all, which is a connection fault rather than a fit problem. Disconnect the'
          + ' headband and reconnect it; if it persists, restart the Muse.'
        : !floating ? null
        : (name === 'TP9' || name === 'TP10')
          ? `${name} is floating, not noisy: the electrode is not touching skin, so the band`
            + ' is reading its own amplifier rather than you. Wet the skin behind that ear'
            + ' with a fingertip of water and reseat the band so the tip rests on bone,'
            + ' not hair. These two dry out first on every sit.'
          : `${name} is floating, not noisy: the electrode is not touching skin. Wipe the`
            + ' forehead, push the band down towards the eyebrows, and clear any hair from'
            + ' under it.';
      into('signal', row(name, pct, { text, color: `rgb(${c[0]},${c[1]},${c[2]})`, title: fix }));
    });
    // And every composite, in whichever group it belongs to. Both at once: they are different kinds of
    // reading about the same moment, not two views of one thing.
    for (const k of activeComposites) {
      const m = Metrics.get(k);
      const v = Metrics.compute(k, features);
      into(groupOf(k), row(m.label, v, {
        tier: Metrics.tierOf(k),
        color: COMPOSITE_COLORS[k],
        primary: k === primaryMetric,
      }));
    }
  }

  /* NOT ONE OF THE THREE. The visual's name, the timer and the mark count are bookkeeping about the
     session rather than readings about the meditator, so they sit unlabelled at the foot of the panel.
     Putting them under a heading would make the heading a lie. */
  const session = [];
  session.push(row('Visual', null, { text: visual.currentMode().label }));

  /* Brainwaves — which band is dominant right now — belongs with the interpreted readings. Calm is NOT
     added here any more: it is a composite, it comes through activeComposites above like every other
     one, and adding it separately is how it ended up listed under "Sensors". */
  into('mind', row('Brainwaves', null, { text: brainLabel }));
  // One row for breath, always, whenever any breath source exists. The strap's
  // RSA estimate takes precedence over the Muse's PPG: ECG-grade beat timing at
  // the chest is far cleaner than an optical pulse read through a temple.
  if (ppgAvailable || strapConnected()) into('body', breathRow());
  if (strapConnected()) {
    into('body', row('Heart', null, { text: hrBpm == null ? 'reading…' : `${hrBpm} bpm`, tier: 'solid' }));
    into('body', row('HRV (RMSSD)', null, {
      text: hrvRmssd == null ? 'reading…' : `${Math.round(hrvRmssd)} ms`, tier: 'solid',
    }));
    // The accelerometer decode's own verdict, shown while it is being trusted for
    // the first time. Gravity is the only honest test of a delta-compressed
    // decode: a body at rest experiences ~1000 mG, and no amount of plausible-
    // looking output can fake that. Once this is confirmed on real hardware it
    // should become a quiet indicator rather than a number.
    if (accAvailable) {
      /* SIGNAL, not BODY. This row is the accelerometer decode's verdict against gravity — whether
         the sensor can be believed — rather than a reading about the chest. The breath rate it feeds
         is in BODY, where it belongs. */
      into('signal', row('Chest', null, { text: accStatusText(),
        title: accTried.length ? escapeHtml(accTried.join(' · ')) : null }));
    } else if (accError) {
      // Say what happened rather than showing nothing and leaving it a mystery.
      into('signal', row('Chest', null, { text: accError }));
    }
    // Say when the strap's numbers should not be trusted, rather than showing
    // them at the same confidence as clean ones.
    if (strapUnreliable()) {
      into('signal', row('Strap', null, {
        text: strapContact === false ? 'no skin contact' : `${Math.round(rrBuffer.rejectRate() * 100)}% beats rejected`,
      }));
    }
  }
  /* SHOWN NEXT TO CALM, and labelled, because the two answer different questions and looked identical.
     "Calm" is relative to the last few minutes of this sit; this is absolute and comparable between
     sits. Printed as a percentage with its meaning attached rather than as another bare 0-100 score. */
  if (result.calmAbs != null) {
    /* BODY, deliberately, even though it comes from the EEG. It is a bounded ratio with no free
       parameter — 50 means equal alpha and beta power, in every sit, for every person — which puts it
       with the other quantities that mean the same thing on Tuesday and Thursday, not with the
       normalised scores in MIND. */
    into('body', row('Alpha share', result.calmAbs, {
      text: `${(result.calmAbs * 100).toFixed(0)}% of alpha+beta`,
    }));
  }
  into('signal', row('Noise', result.artifactRate, { text: noiseLabel, color: COMPOSITE_COLORS.jaw }));
  /* THE INDIVIDUAL ALPHA PEAK, LIVE. Asked for directly — "i also dont see alpha in the composites.
     was i supposed to?" It was being measured all along and shown only in the end-of-sit summary,
     which is the one place it cannot be checked against what you notice at the time.
     Its own row rather than a composite, because it is not a 0-100 score: it is a FREQUENCY in Hz, and
     squeezing a frequency into the same normalised scale as everything else is how the invented
     coefficients got here in the first place. It refuses to report until it has ~40s of clean signal
     and a peak that clears the prominence and width gates, so the row says what it is waiting for. */
  {
    /* `freqHz != null`, not `found`. pickAlphaPeak() returns the CHOSEN CHANNEL's summary — channels,
       best, bestName, freqHz — and has no `found` field of its own; that belongs to the per-channel
       results inside it. Reading `peak.found` gave undefined for a peak that had been located
       perfectly well, so the row said "no clear peak" while every one of the four channels had found
       one. Caught only because the simulator made it reproducible in ten seconds. */
    const peak = measuredAlphaPeak();
    if (peak && peak.freqHz != null) {
      // Which electrode, because the four disagree by a few tenths and the number is meaningless
      // without knowing where it came from. `fallback` means the gates were not met and this is the
      // best guess rather than a measurement, so it must not be presented as one.
      into('body', row('Alpha peak', null, {
        text: `${peak.freqHz.toFixed(1)} Hz${peak.fallback ? '?' : ''} ${peak.bestName || ''}`.trim(),
      }));
    } else {
      const windows = peak && peak.windows != null ? peak.windows : 0;
      into('body', row('Alpha peak', null, {
        text: windows < DSP.IAF_MIN_WINDOWS
          ? `measuring… ${windows}/${DSP.IAF_MIN_WINDOWS}` : 'no clear peak',
      }));
    }
  }
  if (timerEndAt) {
    const remaining = Math.max(0, timerEndAt - Date.now());
    const mm = Math.floor(remaining / 60000), ss = Math.floor((remaining % 60000) / 1000);
    session.push(row('Timer', null, { text: timerDone ? 'complete' : `${mm}:${String(ss).padStart(2, '0')}` }));
  }
  if (markerLog.length) session.push(row('Marks', null, { text: String(markerLog.length) }));

  /* SAY HOW MUCH SIGNAL IS BEHIND THE NUMBERS.
     16-second averaging is what stopped the scores being mostly estimator noise, and it is also a real
     limitation: the score lags its cause by up to a quarter of a minute. Someone reading it against
     what they just noticed themselves doing needs to know that, and the only honest place to say it is
     next to the numbers. During the warm-up it says so instead, because a 4-second average presented
     identically to a 16-second one is the kind of quiet difference this project keeps paying for. */
  {
    const secs = bandAverageSeconds();
    const full = secs >= DSP.BAND_AVERAGE_SEC;
    readoutSpanEl.classList.toggle('settling', !full);
    readoutSpanEl.textContent = full
      ? `${DSP.BAND_AVERAGE_SEC}s average · lags by up to that much`
      : `settling · ${secs}s of ${DSP.BAND_AVERAGE_SEC}s averaged`;
  }

  /* Rows only. Touching the pills' markup here is what broke them.
     A GROUP WITH NOTHING IN IT IS NOT DRAWN. With no strap connected BODY would otherwise be a heading
     over an empty space, which reads as a section that failed to load rather than as one that has
     nothing to say — and the panel is meant to be quiet. */
  readoutRowsEl.innerHTML = GROUPS
    .filter((g) => grouped[g.key].length)
    .map((g) => `<div class="rGroup">${g.label}</div>${grouped[g.key].join('')}`)
    .join('')
    + (session.length ? `<div class="rSession">${session.join('')}</div>` : '');
  renderViewSwitch();

  tickCount++;
  if (tickCount % 4 === 0) {
    sampleHistory(result, channels);     // ~1 sample/sec at a 250ms tick rate
    logSessionSample(result, channels);  // whole-session log, for the summary
  }
}, 250);

/* --- Draggable panels -------------------------------------------------------
 * Reported from real use, and both are the same problem rather than two:
 *   * Live feed opens at bottom-left, which is where the "Live feed" pill is, so it
 *     covered its own off switch.
 *   * The training clock sat under the Record button with Metrics across its right.
 * A fixed corner for each panel cannot be right for every combination of panels that
 * happens to be open, and there are now enough panels that hand-tuning the cases is
 * not a strategy. The person sitting there can see what is in the way.
 *
 * See panels.js for the positioning mechanics. This file only decides WHICH panels
 * move and WHERE the grip goes.
 */
function ensureGrip(el) {
  // Idempotent, and re-inserted after every innerHTML rebuild rather than held as a
  // reference — see the note in Panels.makeDraggable about why the listeners are on
  // the panel and not on the grip.
  let g = el.querySelector(':scope > .panelGrip');
  if (!g) {
    g = document.createElement('div');
    g.className = 'panelGrip';
    g.title = 'Drag to move this panel · double-click to dock it to a side, again to put it back';
  }
  if (el.firstChild !== g) el.insertBefore(g, el.firstChild);
  return g;
}

/*
 * SAY THAT THE PANEL CAN BE MOVED, and how.
 *
 * The mockup carries "Drag to move · Double-click to dock" along the foot of the floating panel, and it
 * is the part of the treatment that actually matters: dragging and docking have been possible for a
 * while and are discoverable only by trying to drag something that gives no sign of being draggable.
 *
 * At the FOOT rather than on the grip, because a tooltip on a strip nobody knows to hover is a hint
 * nobody reads. Re-inserted after an innerHTML rebuild for the same reason as the grip, and it reads
 * the live docked state so it always offers the move that is actually available.
 */
function ensureAffordance(el) {
  let a = el.querySelector(':scope > .panelHint');
  if (!a) {
    a = document.createElement('div');
    a.className = 'panelHint';
    el.appendChild(a);
  }
  if (el.lastChild !== a) el.appendChild(a);
  a.textContent = Panels.isDocked(el)
    ? 'Docked · double-click the top to release it'
    : 'Drag to move · double-click the top to dock';
  return a;
}

const DRAGGABLE_PANELS = [
  ['readout', readoutEl],
  ['dataPanel', document.getElementById('dataPanel')],
  ['modeBar', modeBarEl],
  ['armedBar', armedBarEl],
];
for (const [key, el] of DRAGGABLE_PANELS) {
  if (!el) continue;
  ensureGrip(el);
  /*
   * THE WHOLE HEADER IS THE HANDLE, not only the 14px grip strip.
   *
   * "double click the top thing" is what a person does, and the top thing is the title — LIVE METRICS,
   * the Marks/History tabs — not a row of three faint dots above it. A gesture that only works on a
   * target nobody knows is there is a gesture nobody has.
   *
   * `#dataToggle` is deliberately NOT here even though it is the live feed's title, because it is also
   * the button that collapses the panel. Making it a drag handle meant a 100px drag from it moved the
   * panel instead of being the press half of a click, which is the one thing that panel's title has to
   * do. That panel is dragged by its grip, immediately above.
   */
  const handle = Panels.makeDraggable(el, {
    key,
    from: '.panelGrip, #readoutHead, .railHead',
    /* In Train these three are laid out by CSS. Double-clicking then means "put it back in its slot",
       because docking it again would write an inline position and take it OUT of the layout. */
    layoutDocked: () => document.body.classList.contains('training')
      && ['readout', 'dataPanel', 'armedBar'].includes(key),
  });
  /* Only the two panels that are really read for minutes at a time carry the hint. On the mode bar and
     the mark bar it would be a line of instructions under a row of buttons, which is noise — they are
     still draggable, and their grip still says so on hover. */
  if (key === 'readout' || key === 'dataPanel') {
    ensureAffordance(el);
    // Refreshed after the gesture, so the line describes the state the panel is now in.
    el.addEventListener('dblclick', () => setTimeout(() => ensureAffordance(el), 0));
  }
  void handle;
}
// A position saved on a laptop is off-screen on a phone, and a panel that is
// off-screen cannot be dragged back — so re-clamping on resize is the recovery path,
// not a nicety. Rotating the phone is the common case.
addEventListener('resize', () => {
  Panels.reclampAll(DRAGGABLE_PANELS.map(([, el]) => el).filter(Boolean));
});

/*
 * IN SIMULATION, CONNECT WITHOUT BEING ASKED.
 *
 * A real headband cannot do this — Web Bluetooth requires a user gesture for requestDevice, and
 * rightly so. The simulated one has no such constraint, and removing the click matters more than it
 * looks: the check this whole feature exists for is "open the link, do the panels appear?" A step in
 * the middle turns a yes/no answer into a description of what someone did, which is how the last
 * three rounds of this went.
 *
 * Last in the file on purpose. Everything the connect path touches has to be defined and wired
 * first, and if any of it threw, this line never runs — which is itself the correct behaviour,
 * because then the boot banner in direct.html is what should be on screen.
 */
/* The app bar's initial paint. Here, at the very end, because it reads `trainingMode` — a `let`
   declared halfway down this file — and anything above that declaration reads it inside its temporal
   dead zone and throws. Two of this project's three total outages were exactly that. */
renderPlaces();
renderBarModes();
renderLiveDot();
/* And the chrome that goes with the place. The app opens on Meditate, so without this the first screen
   is the fully instrumented one wearing the Meditate highlight — the exact confusion this fixes. */
applyPlaceChrome();
/* The always-on-screen sit name. Wired here for the same reason: it reads `sitNoteText`, another `let`
   declared partway down this file, so wiring it earlier would touch it in its temporal dead zone. */
wireSitLabel();

if (SIM_ACTIVE) {
  setTimeout(() => { connect(); }, 200);
}
