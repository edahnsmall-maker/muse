/*
 * Shared reactive-field visual: a full-screen WebGL shader that warms,
 * slows, and softens as a 0..1 "calm" value rises. Used by both the
 * Mind Monitor/OSC page (index.html) and the direct-Bluetooth page
 * (direct.html) so the visual language stays identical regardless of
 * how the data got there.
 */
function createZenVisual(canvas) {
  const gl = canvas.getContext('webgl');
  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const FRAG = `
precision highp float;
uniform vec2 u_res; uniform float u_time; uniform float u_calm; uniform float u_breathPeriod;
// Multiplying by large constants (123.34, 345.45) before taking fract()
// requires the GPU to resolve the fractional part of a *large* number —
// exactly where "highp" silently degrades to lower precision on some
// GPUs, collapsing this into visible blocky tiles. Small constants keep
// every intermediate value near [0,1), which stays precise everywhere.
float hash(vec2 p){ vec2 q=fract(p*vec2(0.1031,0.1030)); q+=dot(q,q.yx+19.19); return fract((q.x+q.y)*q.x); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }
// Two fixed-octave-count noises (WebGL1 loop bounds must stay compile-time
// constant on some GPU drivers, so this can't just be one fbm() with a
// calm-dependent octave count) — fbmDetail is busy/small-scale, fbmSoft is
// a few big soft shapes. Blending BETWEEN THE FIELDS THEMSELVES (not just
// slowing down or overlaying effects on the busy one) is what actually
// removes the "marbled clouds" look at high calm rather than just freezing
// it in place.
float fbmDetail(vec2 p){ float v=0.0, amp=0.5; for(int i=0;i<5;i++){ v+=amp*noise(p); p*=2.02; amp*=0.5; } return v; }
float fbmSoft(vec2 p){ float v=0.0, amp=0.6; for(int i=0;i<2;i++){ v+=amp*noise(p); p*=1.8; amp*=0.5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = uv; p.x *= u_res.x / u_res.y;
  float speed = mix(0.30, 0.012, u_calm);   // near-stillness at high calm, not just "slower"
  float warp  = mix(1.5, 0.55, u_calm);
  // Feeding raw elapsed time straight into the noise coordinates grows
  // unbounded over a long session and eventually exceeds this GPU's
  // effective float precision, collapsing the smooth field into visible
  // blocky tiles. Route motion through bounded sin/cos "clocks" instead —
  // same flowing look, but the coordinates fed into fbm() never grow.
  float loopedTime = mod(u_time, 100000.0);
  float t = loopedTime * speed;
  vec2 clockA = vec2(cos(t), sin(t)) * 1.6;
  vec2 clockB = vec2(cos(t*0.63 + 1.7), sin(t*0.63 + 1.7)) * 1.6;

  vec2 q = vec2(fbmDetail(p*warp + clockA), fbmDetail(p*warp + clockB));
  float detail = fbmDetail(p*warp*1.5 + q*1.5 + clockA*0.5);
  float soft = fbmSoft(p*warp*0.35 + clockA*0.35);
  // At low calm: busy detailed field (as before). At high calm: replaced by
  // a few large, soft shapes — this is the actual "gradients, not marble" fix.
  float detailAmount = mix(1.0, 0.0, smoothstep(0.1, 0.85, u_calm));
  float n = mix(soft, detail, detailAmount);

  vec3 coolA=vec3(0.04,0.06,0.11), coolB=vec3(0.18,0.30,0.47), coolC=vec3(0.42,0.28,0.55);
  vec3 warmA=vec3(0.10,0.06,0.08), warmB=vec3(0.86,0.55,0.30), warmC=vec3(0.96,0.82,0.58);
  vec3 cool = mix(coolA, mix(coolB,coolC, smoothstep(0.4,0.9,n)), smoothstep(0.1,0.7,n));
  vec3 warm = mix(warmA, mix(warmB,warmC, smoothstep(0.4,0.95,n)), smoothstep(0.1,0.7,n));
  vec3 col = mix(cool, warm, smoothstep(0.0,1.0,u_calm));
  // Contrast also fades toward flat as calm rises — a soft field can't read
  // as "gradient-like" if it's still being pushed toward high contrast.
  float contrast = mix(1.2, 0.55, u_calm);
  col = (col-0.5)*contrast + 0.5;

  // Use a real measured breathing period once one exists (u_breathPeriod > 0);
  // fall back to a calm-linked guess until then (0 is the "no estimate yet" sentinel).
  float period = u_breathPeriod > 0.5 ? u_breathPeriod : mix(6.0, 11.0, u_calm);
  float breath = 0.5 + 0.5*sin(loopedTime*6.2831853/period);
  col *= mix(1.0, 0.9 + 0.18*breath, 0.6);
  float d = distance(uv, vec2(0.5));
  col *= 1.0 - 0.35*d*d;                          // soft vignette
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

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  addEventListener('resize', resize); resize();

  let calm = 0.5, targetCalm = 0.5;
  let breathPeriod = 0, targetBreathPeriod = 0; // 0 = no real measurement yet
  const start = performance.now();
  function frame(now) {
    calm += 0.035 * (targetCalm - calm); // gentle inertia so shifts settle rather than snap
    breathPeriod += 0.01 * (targetBreathPeriod - breathPeriod); // breath period changes glide, don't snap
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform1f(uCalm, calm);
    gl.uniform1f(uBreathPeriod, breathPeriod);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setCalm: (v) => { targetCalm = v; },
    setBreathPeriod: (v) => { targetBreathPeriod = v == null ? 0 : v; },
  };
}
