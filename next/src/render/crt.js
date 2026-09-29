// The CRT pass (prefs.crt: "off" | "subtle" | "full"). The PS1 post pass still renders the
// dithered, quantized low-resolution frame; with CRT on it goes into `input` instead of the
// canvas, and this pass redraws it at display resolution so the mask and beams stay crisp:
//   1. halation: a half-resolution separable blur of the frame (two tiny passes);
//   2. the tube: barrel warp with rounded corners and a soft black bezel, per-channel
//      convergence drift toward the edges, Gaussian scanline beams that swell with brightness,
//      an aperture-grille (Subtle) or slot (Full) phosphor mask with brightness compensation,
//      halation, vignette, and a faint noise / flicker (none under reduced motion or Reduce
//      flashes). Beam, mask and glow maths run in linear light.
// Everything is allocated once; a frame only writes a few uniforms and draws three triangles.
import * as THREE from "three";

export const CRT_MODES = Object.freeze(["off", "subtle", "full"]);

// Tube parameters per level (index 1 = Subtle, 2 = Full).
const LEVELS = [
  null,
  { warp: 0.55, corner: 0.02, convergence: 0.18, beam: 0.6, mask: 0.18, slot: 0, glow: 0.07, vignette: 0.12, noise: 0.008, flicker: 0.004 },
  { warp: 1, corner: 0.035, convergence: 0.4, beam: 1, mask: 0.32, slot: 1, glow: 0.15, vignette: 0.22, noise: 0.016, flicker: 0.01 },
];

// Output cap: 2560x1440 worth of pixels keeps the tube well inside a mid laptop GPU's budget.
const MAX_OUTPUT_PIXELS = 2560 * 1440;
const MAX_PIXEL_RATIO = 2;

// "off" | "subtle" | "full" (or the old boolean) -> 0 | 1 | 2.
export function crtLevel(value) {
  if (value === true || value === "full") return 2;
  return value === "subtle" ? 1 : 0;
}

// Canvas buffer size for the tube: the display in device pixels (ratio capped at 2), scaled
// down to the pixel cap, never below the internal resolution. Writes into and returns `out`.
export function crtOutputSize(srcW, srcH, viewW, viewH, pixelRatio, out = { w: 0, h: 0 }) {
  const ratio = Math.min(Math.max(Number(pixelRatio) || 1, 1), MAX_PIXEL_RATIO);
  let w = Math.max(1, viewW) * ratio;
  let h = Math.max(1, viewH) * ratio;
  if (w * h > MAX_OUTPUT_PIXELS) {
    const f = Math.sqrt(MAX_OUTPUT_PIXELS / (w * h));
    w *= f;
    h *= f;
  }
  out.w = Math.max(srcW, Math.round(w));
  out.h = Math.max(srcH, Math.round(h));
  return out;
}

const VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 5 bilinear taps = a 9-tap Gaussian along `dir` (in source uv); runs at half resolution.
const BLUR_FRAGMENT = `
uniform sampler2D tSource;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSource, vUv).rgb * 0.2270;
  c += (texture2D(tSource, vUv + dir * 1.3846).rgb + texture2D(tSource, vUv - dir * 1.3846).rgb) * 0.3162;
  c += (texture2D(tSource, vUv + dir * 3.2308).rgb + texture2D(tSource, vUv - dir * 3.2308).rgb) * 0.0703;
  gl_FragColor = vec4(c, 1.0);
}`;

const TUBE_FRAGMENT = `
uniform sampler2D tSource;
uniform sampler2D tGlow;
uniform vec2 srcSize;
uniform vec2 outSize;
uniform vec2 warp;
uniform float corner;
uniform float convergence;
uniform float beam;
uniform float maskLow;
uniform float maskGain;
uniform float slot;
uniform float glow;
uniform float vignette;
uniform float noise;
uniform float flicker;
uniform float seed;
varying vec2 vUv;

vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

// One internal row at uv.x: a sharpened bilinear fetch keeps pixel edges crisp but not jagged.
vec3 row(float x, float r) {
  float i = floor(x);
  float f = clamp((x - i - 0.5) * 2.5 + 0.5, 0.0, 1.0);
  return toLinear(texture2D(tSource, vec2((i + f + 0.5) / srcSize.x, (r + 0.5) / srcSize.y)).rgb);
}

// The two nearest scanlines through a Gaussian beam whose width grows with brightness; each
// beam is normalised by its area so the average light per row is kept.
vec3 tube(vec2 uv) {
  vec2 p = uv * srcSize - 0.5;
  float r0 = floor(p.y);
  float f = p.y - r0;
  vec3 a = row(p.x, r0);
  vec3 b = row(p.x, min(r0 + 1.0, srcSize.y - 1.0));
  vec3 sa = mix(vec3(0.2), vec3(0.42), sqrt(a));
  vec3 sb = mix(vec3(0.2), vec3(0.42), sqrt(b));
  vec3 da = f / sa;
  vec3 db = (1.0 - f) / sb;
  vec3 lit = a * exp(-0.5 * da * da) / (sa * 2.5066) + b * exp(-0.5 * db * db) / (sb * 2.5066);
  vec3 even = mix(a, b, smoothstep(0.35, 0.65, f));
  return mix(even, lit, beam);
}

// Aperture grille (vertical RGB stripes) or slot mask (staggered cells with row gaps).
vec3 phosphors(vec2 fc) {
  float x = floor(fc.x);
  float t = mod(x, 3.0);
  vec3 m = vec3(maskLow);
  m.r = t < 1.0 ? 1.0 : maskLow;
  m.g = t >= 1.0 && t < 2.0 ? 1.0 : maskLow;
  m.b = t >= 2.0 ? 1.0 : maskLow;
  float shift = step(3.0, mod(x, 6.0)) * 2.0;
  float gap = step(mod(floor(fc.y) + shift, 4.0), 0.5);
  return m * mix(1.0, maskLow, gap * slot) * maskGain;
}

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 q = vUv * 2.0 - 1.0;
  q *= vec2(1.0 + q.y * q.y * warp.x, 1.0 + q.x * q.x * warp.y);
  vec2 uv = q * 0.5 + 0.5;

  // Rounded-rectangle glass edge with a soft falloff into the black bezel.
  vec2 halfSize = 0.5 * outSize;
  float radius = corner * outSize.y;
  vec2 e = abs(q) * halfSize - (halfSize - radius);
  float sdf = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - radius;
  float bezel = 1.0 - smoothstep(-0.006 * outSize.y, 0.0, sdf);
  if (bezel <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Convergence: red and blue drift apart toward the edges (in internal pixels).
  vec2 drift = q * abs(q) * convergence / srcSize;
  vec3 c = vec3(tube(uv + drift).r, tube(uv).g, tube(uv - drift).b);

  c *= phosphors(gl_FragCoord.xy);
  c += toLinear(texture2D(tGlow, uv).rgb) * glow;
  vec2 v = uv * (1.0 - uv);
  c *= pow(clamp(v.x * v.y * 16.0, 0.0, 1.0), vignette);

  c = toGamma(c) * flicker + (hash(gl_FragCoord.xy + seed) - 0.5) * noise;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * bezel, 1.0);
}`;

function lowTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
  });
}

function shader(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader, depthTest: false, depthWrite: false });
}

export function createCrtPass() {
  const input = lowTarget(); // the PS1 pass's finished frame
  const glowH = lowTarget();
  const glowV = lowTarget();

  const blurH = shader(BLUR_FRAGMENT, { tSource: { value: input.texture }, dir: { value: new THREE.Vector2() } });
  const blurV = shader(BLUR_FRAGMENT, { tSource: { value: glowH.texture }, dir: { value: new THREE.Vector2() } });
  const u = {
    tSource: { value: input.texture },
    tGlow: { value: glowV.texture },
    srcSize: { value: new THREE.Vector2(320, 240) },
    outSize: { value: new THREE.Vector2(320, 240) },
    warp: { value: new THREE.Vector2() },
    corner: { value: 0 },
    convergence: { value: 0 },
    beam: { value: 0 },
    maskLow: { value: 1 },
    maskGain: { value: 1 },
    slot: { value: 0 },
    glow: { value: 0 },
    vignette: { value: 0 },
    noise: { value: 0 },
    flicker: { value: 1 },
    seed: { value: 0 },
  };
  const tube = shader(TUBE_FRAGMENT, u);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quad = new THREE.Mesh(geometry, tube);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let level = 0;
  let params = null;
  let srcH = 240;
  let outH = 240;

  // Beams need about two display pixels per internal row; below that they fade to flat rows.
  function applyLevel() {
    if (!params) return;
    const lines = outH / Math.max(1, srcH);
    const t = Math.min(Math.max((lines - 1.5) / 1.2, 0), 1);
    u.beam.value = params.beam * t * t * (3 - 2 * t);
    u.warp.value.set(params.warp / 32, params.warp / 24);
    u.corner.value = params.corner;
    u.convergence.value = params.convergence;
    u.maskLow.value = 1 - params.mask;
    // The mask's average transmission, divided back out so it never darkens the picture.
    const low = 1 - params.mask;
    const mean = ((1 + 2 * low) / 3) * (params.slot ? (3 + low) / 4 : 1);
    u.maskGain.value = 1 / mean;
    u.slot.value = params.slot;
    u.glow.value = params.glow;
    u.vignette.value = params.vignette;
    u.noise.value = params.noise;
  }

  return {
    input,
    get active() {
      return level > 0;
    },
    get level() {
      return level;
    },
    setLevel(value) {
      level = typeof value === "number" ? Math.min(Math.max(Math.round(value) || 0, 0), 2) : crtLevel(value);
      params = LEVELS[level];
      applyLevel();
    },
    // Internal (source) resolution and the canvas buffer size.
    setSize(w, h, outW, outHeight) {
      srcH = h;
      outH = outHeight;
      input.setSize(w, h);
      const gw = Math.max(1, Math.round(w / 2));
      const gh = Math.max(1, Math.round(h / 2));
      glowH.setSize(gw, gh);
      glowV.setSize(gw, gh);
      blurH.uniforms.dir.value.set(2 / w, 0);
      blurV.uniforms.dir.value.set(0, 1 / gh);
      u.srcSize.value.set(w, h);
      u.outSize.value.set(outW, outHeight);
      applyLevel();
    },
    // Call after the PS1 pass rendered into `input`; draws the tube to the canvas.
    // moving: false under reduced motion (static grain, no flicker); flicker: false when
    // Reduce flashes is on.
    render(renderer, time, moving, flicker) {
      if (!params) return;
      const t = moving ? time : 0;
      u.seed.value = moving ? Math.floor(t * 60) % 997 * 7.31 : 0;
      u.flicker.value = moving && flicker ? 1 + params.flicker * (0.6 * Math.sin(t * 47.1) + 0.4 * Math.sin(t * 13.7)) : 1;
      quad.material = blurH;
      renderer.setRenderTarget(glowH);
      renderer.render(scene, camera);
      quad.material = blurV;
      renderer.setRenderTarget(glowV);
      renderer.render(scene, camera);
      quad.material = tube;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
  };
}
