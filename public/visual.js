/*
 * Shared reactive-field visual — used by both the Mind Monitor/OSC page
 * (index.html) and the direct-Bluetooth page (direct.html) so the visual
 * language stays identical regardless of how the data got there.
 *
 * Design: 4 soft horizontal "bands" of light, one per EEG electrode
 * (TP9/AF7/AF8/TP10) — a spectrum-analyzer-style mapping where each real
 * data stream gets its own visible line, rather than one blended score
 * driving a single field. Each band's undulation reflects that channel's
 * own alpha-vs-beta balance; a sudden shift in that balance ("a spike that
 * reflects thinking") triggers a sharp, bright, fast-decaying flash
 * distinct from the otherwise soft ambient motion. As calm rises, the
 * bands widen and soften ("dissolving") and blend into a bright shared
 * glow where they overlap, rather than staying sharply separated.
 */
function createZenVisual(canvas) {
  const gl = canvas.getContext('webgl');
  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FRAG = `
precision highp float;
uniform vec2 u_res; uniform float u_time; uniform float u_calm; uniform float u_breathPeriod;
uniform float u_noise;
uniform float u_bandLevel[4]; // per-electrode alpha share (0..1), TP9/AF7/AF8/TP10
uniform float u_bandSpike[4]; // per-electrode decaying "sudden shift" flash (0..1)
// Multiplying by large constants (123.34, 345.45) before taking fract()
// requires the GPU to resolve the fractional part of a *large* number —
// exactly where "highp" silently degrades to lower precision on some
// GPUs, collapsing this into visible blocky tiles. Small constants keep
// every intermediate value near [0,1), which stays precise everywhere.
float hash(vec2 p){ vec2 q=fract(p*vec2(0.1031,0.1030)); q+=dot(q,q.yx+19.19); return fract((q.x+q.y)*q.x); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float aspect = u_res.x / u_res.y;
  // Feeding raw elapsed time (even multiplied by a modest speed) straight
  // into noise()/hash() calls eventually exceeds this GPU's effective float
  // precision and collapses the field into visible blocky tiles — the
  // exact bug hit earlier. t itself stays bounded (mod caps it hard), but
  // it's ONLY ever used as a phase fed into sin()/cos() below, never
  // multiplied by a further large constant and passed into noise()/hash()
  // directly — those instead use the bounded clockA/clockB vectors, whose
  // magnitude cannot grow no matter how long the session runs.
  float loopedTime = mod(u_time, 100000.0);
  float speed = mix(0.5, 0.06, u_calm); // bands flow slower as calm rises
  float t = loopedTime * speed;
  vec2 clockA = vec2(cos(t), sin(t)) * 1.6;
  vec2 clockB = vec2(cos(t*0.63 + 1.7), sin(t*0.63 + 1.7)) * 1.6;

  // Dark navy base, always present — this never fully disappears into a
  // hue shift (that was the earlier bug that read as "muddy brown"). Only
  // the bands and their glow add real brightness on top of it.
  vec3 deep = vec3(0.020, 0.028, 0.062);
  vec3 mid  = vec3(0.045, 0.075, 0.145);
  float haze = 0.05 * (noise(uv*vec2(aspect,1.0)*1.4 + clockA*0.4) - 0.5);
  vec3 col = mix(deep, mid, clamp(uv.y + haze, 0.0, 1.0));

  vec3 coolHighlight = vec3(0.55, 0.70, 0.98);
  vec3 warmHighlight  = vec3(0.99, 0.94, 0.82);
  vec3 highlight = mix(coolHighlight, warmHighlight, u_calm);

  // Softer, wider, more overlapping bands at high calm ("everything's kinda
  // dissolving"); tighter and more distinct at low calm.
  float sharpness = mix(520.0, 130.0, u_calm);

  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float lvl = u_bandLevel[i];
    float spike = u_bandSpike[i];
    float baseY = mix(0.66, 0.34, fi / 3.0); // spread the 4 bands vertically, overlapping toward center
    float wob = (0.11 - 0.04*lvl) * sin(uv.x*aspect*3.0 + t*(1.2 + fi*0.29) + fi*2.3)
              + 0.045 * (noise(vec2(uv.x*aspect*2.0, fi*11.0) + clockB*(0.3 + fi*0.15)) - 0.5);
    float dist = uv.y - (baseY + wob);
    float glow = exp(-dist*dist*sharpness);
    float brightness = glow * mix(0.30, 0.85, lvl) * mix(0.55, 1.15, u_calm);
    col += highlight * brightness;

    // The spike: a sharp, bright, fast-decaying white flash distinct from
    // the soft ambient band — a real, sudden shift in that electrode's own
    // alpha/beta balance, not artifact (blinks/jaw are excluded upstream).
    if (spike > 0.01) {
      float jitter = hash(vec2(uv.x*420.0, fi*7.0) + clockA*30.0 + clockB*17.0);
      float spikeGlow = exp(-dist*dist*110.0) * spike * jitter;
      col += vec3(1.0) * spikeGlow * 1.5;
    }
  }

  // Noise shows up as visible grain — honest feedback that the signal
  // itself is noisy right now, rather than hiding it inside a smoothed
  // score. Coordinates kept bounded, same float-precision reason as above.
  float grain = hash(uv * u_res.xy * 0.7 + clockB*50.0 + clockA*13.0);
  col = mix(col, vec3(grain), 0.10 * clamp(u_noise, 0.0, 1.0));

  // Use a real measured breathing period once one exists (u_breathPeriod > 0);
  // fall back to a calm-linked guess until then (0 is the "no estimate yet" sentinel).
  float period = u_breathPeriod > 0.5 ? u_breathPeriod : mix(6.0, 11.0, u_calm);
  float breath = 0.5 + 0.5*sin(loopedTime*6.2831853/period);
  col *= mix(1.0, 0.92 + 0.14*breath, 0.6);
  float d = distance(uv, vec2(0.5));
  col *= 1.0 - 0.25*d*d;                          // soft vignette
  gl_FragColor = vec4(col, 1.0);
}`;
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, 'u_res');
  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uCalm = gl.getUniformLocation(prog, 'u_calm');
  const uBreathPeriod = gl.getUniformLocation(prog, 'u_breathPeriod');
  const uNoise = gl.getUniformLocation(prog, 'u_noise');
  const uBandLevel = gl.getUniformLocation(prog, 'u_bandLevel');
  const uBandSpike = gl.getUniformLocation(prog, 'u_bandSpike');

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  addEventListener('resize', resize); resize();

  let calm = 0.5, targetCalm = 0.5;
  let breathPeriod = 0, targetBreathPeriod = 0; // 0 = no real measurement yet
  let noise = 0, targetNoise = 0;
  // Sensible neutral defaults so callers that never call setBandLevels/
  // setBandSpikes (e.g. index.html's Mind Monitor path, which doesn't have
  // per-channel data) still render a reasonable, static set of bands.
  let bandLevel = [0.5, 0.5, 0.5, 0.5], targetBandLevel = [0.5, 0.5, 0.5, 0.5];
  let bandSpike = [0, 0, 0, 0], targetBandSpike = [0, 0, 0, 0];
  const start = performance.now();
  function frame(now) {
    calm += 0.035 * (targetCalm - calm); // gentle inertia so shifts settle rather than snap
    breathPeriod += 0.01 * (targetBreathPeriod - breathPeriod); // breath period changes glide, don't snap
    noise += 0.15 * (targetNoise - noise); // noise grain should react fairly promptly
    for (let i = 0; i < 4; i++) {
      bandLevel[i] += 0.06 * (targetBandLevel[i] - bandLevel[i]);
      // Spikes decay fast on their own (see direct.html); here just track
      // toward the latest target quickly so a new spike reads as sudden.
      bandSpike[i] += 0.5 * (targetBandSpike[i] - bandSpike[i]);
    }
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform1f(uCalm, calm);
    gl.uniform1f(uBreathPeriod, breathPeriod);
    gl.uniform1f(uNoise, noise);
    gl.uniform1fv(uBandLevel, bandLevel);
    gl.uniform1fv(uBandSpike, bandSpike);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setCalm: (v) => { targetCalm = v; },
    setBreathPeriod: (v) => { targetBreathPeriod = v == null ? 0 : v; },
    setNoise: (v) => { targetNoise = v == null ? 0 : v; },
    setBandLevels: (levels) => { targetBandLevel = levels.map((v) => (v == null ? 0.5 : v)); },
    setBandSpikes: (spikes) => { targetBandSpike = spikes.map((v) => (v == null ? 0 : v)); },
  };
}
