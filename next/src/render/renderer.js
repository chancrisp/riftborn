// WebGL renderer, the low-resolution scene target and the retro post pass. The scene is drawn
// at the internal "pixelation" height into a render target (linear colour), then one
// full-screen triangle converts it to sRGB, grades it (Nightmare / death / hurt), applies the
// 4x4 ordered dither and quantizes to 31 levels per channel. The browser upscales the canvas
// with nearest-neighbour; the optional CRT pass (crt.js) redraws it at display resolution
// instead. The same pass
// draws the PS1 mosaic-swirl transition (F20), and every screen-luminance flash asks the flash
// budget first (F17).
import * as THREE from "three";
import { setRetroResolution } from "./materials.js";
import { createFlashBudget, reducedFlash } from "./flashes.js";
import { createLighting } from "./lighting.js";
import { stageDef } from "../data/stages.js";
import { clamp } from "../core/util.js";
import { createCrtPass, crtLevel, crtOutputSize } from "./crt.js";

export { createFlashBudget, reducedFlash, REDUCED_FLASH } from "./flashes.js";

export const PIXELATIONS = Object.freeze([160, 240, 320, 480, 720]);

// Adaptive ladder used only in "auto"; mobile starts one notch down.
const DESKTOP_LADDER = Object.freeze([320, 240, 200]);
const MOBILE_LADDER = Object.freeze([240, 200]);
// A downgrade soon after a recovery means the device cannot hold the higher tier: stop
// trying to recover for a while instead of oscillating.
const RELAPSE_WINDOW = 30;
const RESTORE_HOLD = 180;

const NIGHTMARE_SKY = "#111927";
const NIGHTMARE_FOG = "#344355";
const FLASH_DECAY = 22;
const FLASH_BUDGETED = 5; // point-light kicks above this intensity count as screen flashes
// The Omen of Darkness scales the fog through the Rules Ledger (fogMult); kept in a sane band.
const FOG_MULT_MIN = 0.2;
const FOG_MULT_MAX = 2;

// Original lighting (identical on every world) is the base; Wave-1 rigs give each world its
// own character in normal mode. Nightmare keeps the original values exactly.
const BASE_RIG = Object.freeze({
  sky: "#c9e5ff",
  ground: "#596651",
  hemi: 1.05,
  sun: "#ffe0ac",
  sunI: 1.25,
  rim: "#a791ff",
  rimI: 0.4,
  accent: "#000000",
  accentI: 0,
  accentDir: Object.freeze([0, -1, 0]),
});
const NIGHTMARE_RIG = Object.freeze({
  ...BASE_RIG,
  sky: "#b1bfd0",
  ground: "#818b95",
  hemi: 1.16,
  sun: "#c0cddd",
  sunI: 1.02,
  rim: "#869baa",
  rimI: 0.5,
});
const STAGE_RIGS = Object.freeze({
  1: BASE_RIG,
  // Quarry: dusty overcast, dimmer warm sun, steel-blue rim.
  2: Object.freeze({ ...BASE_RIG, ground: "#5d5a55", sun: "#ffe7c6", sunI: 1.18, rim: "#9fb3dc", rimI: 0.45 }),
  // Caldera: lava under-glow (warm ground bounce plus a low accent from below) and ember rim.
  3: Object.freeze({
    ...BASE_RIG,
    sky: "#e0c8da",
    ground: "#8c4b35",
    sun: "#ffc896",
    sunI: 1.12,
    rim: "#ff9258",
    rimI: 0.55,
    accent: "#ff6a2e",
    accentI: 0.45,
    accentDir: Object.freeze([6, -10, 14]),
  }),
  // Citadel: cold aurora rim and a pale moonlit key.
  4: Object.freeze({ ...BASE_RIG, sky: "#c0d7ff", ground: "#4b5b78", sun: "#e4edff", sunI: 1.1, rim: "#7fe8ff", rimI: 0.8 }),
  // Void Crown: violet key light over a dark bruise-coloured bounce.
  5: Object.freeze({
    ...BASE_RIG,
    sky: "#cbbcff",
    ground: "#4a3c66",
    sun: "#c7a3ff",
    sunI: 1.2,
    rim: "#a07dff",
    rimI: 0.55,
    accent: "#8a5cff",
    accentI: 0.25,
    accentDir: Object.freeze([-18, 22, -10]),
  }),
});

// Internal render height for a pixelation preference and adaptive step.
export function renderHeight(pixelation, mobile = false, level = 0) {
  if (pixelation !== "auto") return pixelation;
  const ladder = mobile ? MOBILE_LADDER : DESKTOP_LADDER;
  return ladder[clamp(level, 0, ladder.length - 1)];
}

// Linear fog distances. Nightmare hugs the camera but never starts before the hero.
export function fogRange(amount, nightmare, viewDistance = 36, out = {}) {
  if (amount === 0) {
    out.near = 1000;
    out.far = 1200;
  } else if (nightmare) {
    out.near = Math.max(viewDistance + 3, 43 - amount * 0.08);
    out.far = out.near + 22 - amount * 0.12;
  } else {
    const strength = 0.5 + amount / 100;
    out.near = 48 / strength;
    out.far = 135 / strength;
  }
  return out;
}

export function normalizePixelation(value) {
  const n = Number(value);
  return PIXELATIONS.includes(n) ? n : "auto";
}

// Fog preference 0..100 (default 50 when missing or malformed).
function fogAmount(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? clamp(n, 0, 100) : 50;
}

// ---- post pass --------------------------------------------------------------------------

const POST_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const POST_FRAGMENT = `
uniform sampler2D tScene;
uniform vec2 resolution;
uniform float nightmare;
uniform float death;
uniform float hurt;
uniform float deathFade;
uniform float mosaic;
uniform float swirl;
uniform float crush;
uniform float fade;
uniform vec3 fadeColor;
varying vec2 vUv;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// Same curve as three's sRGBTransferOETF: the original graded after its OutputPass.
vec3 toSRGB(vec3 c) {
  return mix(pow(max(c, 0.0), vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

// Standard 4x4 Bayer matrix built arithmetically; p is the pixel position mod 4.
float bayer(vec2 p) {
  float a = mod(p.x, 2.0) * 2.0 + mod(p.y, 2.0) * 3.0;
  float b = mod(floor(p.x / 2.0), 2.0) * 2.0 + mod(floor(p.y / 2.0), 2.0) * 3.0;
  return (mod(a, 4.0) * 4.0 + mod(b, 4.0)) / 16.0 - 0.5;
}

vec3 grade(vec3 c, vec2 uv) {
  if (nightmare > 0.0) {
    // Cold, desaturated moonlight with a lifted blue-black floor that keeps shadow detail.
    float l = dot(c, LUMA);
    vec3 night = mix(vec3(l), c, 0.22) * vec3(0.62, 0.79, 1.12) + vec3(0.016, 0.023, 0.037);
    c = mix(c, night, nightmare);
  }
  if (death > 0.0) {
    float l = dot(c, LUMA);
    c = mix(c, vec3(l) * vec3(1.3, 0.6, 0.56) + vec3(0.03, 0.0, 0.0), death);
  }
  if (hurt > 0.0) {
    vec2 q = uv - 0.5;
    float edge = smoothstep(0.08, 0.36, dot(q, q));
    c = mix(c, c * vec3(1.0, 0.38, 0.38) + vec3(0.2, 0.0, 0.02), edge * hurt * 0.7);
  }
  return mix(c, vec3(0.02, 0.015, 0.03), deathFade);
}

// One internal pixel through the whole retro chain. The transition's crush lowers the levels
// per channel from 31 to 7.
vec3 retroPixel(vec2 px) {
  vec2 uv = (px + 0.5) / resolution;
  vec3 c = grade(toSRGB(texture2D(tScene, uv).rgb), uv);
  float levels = mix(31.0, 7.0, crush);
  c = clamp(c + bayer(mod(px, 4.0)) / levels, 0.0, 1.0);
  return floor(c * levels + 0.5) / levels;
}

// The mosaic swirl: every block of mosaic x mosaic pixels samples its centre, rotated about
// the screen centre by swirl x 2.5 rad, most at the middle and none at the corners.
vec2 transitionPixel(vec2 px) {
  if (mosaic <= 1.0 && swirl <= 0.0) return px;
  vec2 block = floor(px / mosaic) * mosaic + 0.5 * mosaic;
  vec2 aspect = vec2(resolution.x / resolution.y, 1.0);
  vec2 q = (block / resolution - 0.5) * aspect;
  float r = clamp(length(q) / length(0.5 * aspect), 0.0, 1.0);
  float a = swirl * 2.5 * (1.0 - r);
  q = vec2(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y);
  return clamp(floor((q / aspect + 0.5) * resolution), vec2(0.0), resolution - 1.0);
}

void main() {
  vec2 px = transitionPixel(floor(vUv * resolution));
  vec3 c = retroPixel(px);
  gl_FragColor = vec4(mix(c, fadeColor, fade), 1.0);
}`;

function createPostPass(texture) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const uniforms = {
    tScene: { value: texture },
    resolution: { value: new THREE.Vector2(320, 240) },
    nightmare: { value: 0 },
    death: { value: 0 },
    hurt: { value: 0 },
    deathFade: { value: 0 },
    mosaic: { value: 1 },
    swirl: { value: 0 },
    crush: { value: 0 },
    fade: { value: 0 },
    fadeColor: { value: new THREE.Color(0, 0, 0) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: POST_VERTEX,
    fragmentShader: POST_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), uniforms };
}

// Half-float keeps dark linear values precise before the sRGB curve (Nightmare lives there).
function sceneTargetType(renderer) {
  const ext = renderer.extensions;
  return ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

// ---- renderer ---------------------------------------------------------------------------

export function createRenderer(ctx) {
  const canvas = ctx.canvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = false;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  try {
    canvas.style.imageRendering = "pixelated";
  } catch {}

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#89b4e2");
  scene.fog = new THREE.Fog("#89b4e2", 65, 165);
  const camera = new THREE.PerspectiveCamera(47, viewAspect(), 0.1, 230);
  camera.position.set(10, 22, 25);
  camera.lookAt(0, 1, 0);

  const layers = { world: new THREE.Group(), actors: new THREE.Group(), effects: new THREE.Group() };
  for (const [name, group] of Object.entries(layers)) {
    group.name = name;
    scene.add(group);
  }

  // Every light is created up front and never removed, so the light count (part of every
  // shader's program key) is stable and stage changes never trigger recompiles.
  const ambient = new THREE.HemisphereLight(BASE_RIG.sky, BASE_RIG.ground, BASE_RIG.hemi);
  const sun = new THREE.DirectionalLight(BASE_RIG.sun, BASE_RIG.sunI);
  sun.position.set(-24, 45, 18);
  const rim = new THREE.DirectionalLight(BASE_RIG.rim, BASE_RIG.rimI);
  rim.position.set(30, 15, -40);
  const accent = new THREE.DirectionalLight(BASE_RIG.accent, 0);
  const flashLight = new THREE.PointLight("#ffcf67", 0, 11, 2);
  scene.add(ambient, sun, sun.target, rim, accent, flashLight);
  // Enhanced lighting (lighting.js): fill light, AO switch and a fixed point-light pool, all
  // created now so the light count never changes. "classic" keeps them at 0.
  const enhanced = createLighting(ctx, scene, { ambient, sun, rim, accent });
  const enhancedPref = () => ctx.prefs?.lighting !== "classic";
  let enhancedOn = enhancedPref();

  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: sceneTargetType(renderer),
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  const post = createPostPass(target.texture);

  const resolution = { w: 320, h: 240 };
  const lighting = { stage: stageDef(1), nightmare: false, fog: 50 };
  const crt = createCrtPass();
  const outSize = { w: 1, h: 1 };
  const applied = { pixelation: normalizePixelation(ctx.prefs?.pixelation), crt: crtLevel(ctx.prefs?.crt) };
  const fogScratch = { near: 0, far: 0 };
  let level = 0;
  let lastRestore = -Infinity;
  let restoreHoldUntil = 0;
  let lastFrame = 0;
  let calls = 0;
  const flashBudget = createFlashBudget();

  function viewAspect() {
    return Math.max(1, innerWidth) / Math.max(1, innerHeight);
  }

  const now = () => ctx.time?.real ?? 0;
  // The muzzle light freezes with the simulation, like every other effect.
  const frozen = () => ctx.mode === "pause" || ctx.mode === "upgrade";

  // With CRT on, the PS1 pass renders into the CRT pass's input and the canvas buffer runs at
  // display resolution (crt.js) so the mask and beams stay crisp.
  function outputSize(w, h) {
    if (!applied.crt) {
      outSize.w = w;
      outSize.h = h;
      return outSize;
    }
    return crtOutputSize(w, h, innerWidth, innerHeight, globalThis.devicePixelRatio, outSize);
  }

  function resize() {
    camera.aspect = viewAspect();
    camera.updateProjectionMatrix();
    const h = renderHeight(applied.pixelation, !!ctx.env?.mobile, level);
    const w = Math.max(1, Math.round(h * viewAspect()));
    resolution.w = w;
    resolution.h = h;
    target.setSize(w, h);
    setRetroResolution(w, h);
    post.uniforms.resolution.value.set(w, h);
    const out = outputSize(w, h);
    renderer.setSize(out.w, out.h, false);
    crt.setLevel(applied.crt);
    crt.setSize(w, h, out.w, out.h);
  }

  function setPixelation(value) {
    applied.pixelation = normalizePixelation(value);
    if (ctx.prefs) ctx.prefs.pixelation = applied.pixelation;
    level = 0;
    resize();
  }

  function setCrt(value) {
    applied.crt = crtLevel(value);
    resize();
  }

  function reduceQuality() {
    if (applied.pixelation !== "auto") return false;
    const ladder = ctx.env?.mobile ? MOBILE_LADDER : DESKTOP_LADDER;
    if (level >= ladder.length - 1) return false;
    level++;
    if (now() - lastRestore < RELAPSE_WINDOW) restoreHoldUntil = now() + RESTORE_HOLD;
    resize();
    return true;
  }

  function restoreQuality() {
    if (level === 0 || now() < restoreHoldUntil) return false;
    level--;
    lastRestore = now();
    resize();
    return true;
  }

  // Rules Ledger fog scale (the Omen of Darkness closes the fog in by 30%); 1 under ORIGINAL.
  function fogMult() {
    const m = Number(ctx.rules?.mul?.("fogMult"));
    return Number.isFinite(m) && m > 0 ? clamp(m, FOG_MULT_MIN, FOG_MULT_MAX) : 1;
  }

  function applyFog(viewDistance) {
    fogRange(lighting.fog, lighting.nightmare, viewDistance, fogScratch);
    const m = fogMult();
    scene.fog.near = fogScratch.near * m;
    scene.fog.far = fogScratch.far * m;
  }

  function applyLighting() {
    const { stage, nightmare } = lighting;
    scene.background.set(nightmare ? NIGHTMARE_SKY : stage.sky);
    scene.fog.color.set(nightmare ? NIGHTMARE_FOG : stage.fog);
    applyFog(36);
    const rig = nightmare ? NIGHTMARE_RIG : (STAGE_RIGS[stage.id] ?? BASE_RIG);
    ambient.color.set(rig.sky);
    ambient.groundColor.set(rig.ground);
    ambient.intensity = rig.hemi;
    sun.color.set(rig.sun);
    sun.intensity = rig.sunI;
    rim.color.set(rig.rim);
    rim.intensity = rig.rimI;
    accent.color.set(rig.accent);
    accent.intensity = rig.accentI;
    accent.position.fromArray(rig.accentDir);
    post.uniforms.nightmare.value = nightmare ? 1 : 0;
    flashLight.intensity = 0;
    enhanced.applyRig(stage.id ?? 1, nightmare, enhancedOn);
  }

  // stage: 1..5 or a STAGES entry (tutorial uses stage 1). Options override the prefs.
  function applyStage(stage, { nightmare, fog } = {}) {
    lighting.stage = stage && typeof stage === "object" ? stage : stageDef(Number(stage) || 1);
    lighting.nightmare = nightmare ?? !!ctx.prefs?.nightmare;
    lighting.fog = fogAmount(fog ?? ctx.prefs?.fog);
    applyLighting();
    enhanced.collectStatics(layers.world);
    ctx.weather?.setStage?.(lighting.stage.id ?? 1);
    ctx.weather?.setNightmare?.(lighting.nightmare);
  }

  // Nightmare fog is re-fitted every step to the camera-to-hero distance (weather drives it).
  function updateFog(viewDistance) {
    if (lighting.nightmare) applyFog(viewDistance);
  }

  function setGrade(grade = {}) {
    for (const key of ["nightmare", "death", "hurt", "deathFade"]) {
      const value = grade[key];
      if (value !== undefined) post.uniforms[key].value = clamp(Number(value) || 0, 0, 1);
    }
  }

  // requestFlash(kind, strength) -> the strength allowed now: Reduce flashes caps known kinds,
  // then the three-per-second budget downgrades the excess to 30%.
  function requestFlash(kind, strength = 1) {
    return flashBudget.request(now(), reducedFlash(kind, strength, ctx.prefs?.flashes === false));
  }

  // Muzzle and explosion light kicks; strong ones are screen flashes and ask the budget.
  function flash(x, y, z, color = "#ffcf67", intensity = 5) {
    if (ctx.env?.reduced || !(intensity > 0)) return;
    const allowed = intensity > FLASH_BUDGETED ? requestFlash("light", intensity) : intensity;
    if (enhancedOn) {
      enhanced.kick(x, y, z, color, allowed * 1.5, 11, FLASH_DECAY);
      return;
    }
    flashLight.position.set(x, y, z);
    flashLight.color.set(color);
    flashLight.intensity = Math.max(flashLight.intensity, allowed);
  }

  // The transition's post uniforms (F20): block size in internal pixels, swirl and crush
  // (0..1), and a fade toward fadeColor. Neutral values leave the frame untouched.
  function setMosaic({ mosaic = 1, swirl = 0, crush = 0, fade = 0, fadeColor = "#000000" } = {}) {
    const u = post.uniforms;
    u.mosaic.value = clamp(Math.round(mosaic) || 1, 1, 32);
    u.swirl.value = clamp(swirl, 0, 1);
    u.crush.value = clamp(crush, 0, 1);
    u.fade.value = clamp(fade, 0, 1);
    u.fadeColor.value.set(fadeColor);
  }

  function decayFlash() {
    const t = now();
    const dt = clamp(t - lastFrame, 0, 0.25);
    lastFrame = t;
    enhanced.frame(t, dt, frozen());
    if (flashLight.intensity <= 0 || frozen()) return;
    flashLight.intensity *= Math.exp(-FLASH_DECAY * dt);
    if (flashLight.intensity < 0.01) flashLight.intensity = 0;
  }

  function followLights(x, y, z) {
    sun.position.set(x - 24, y + 45, z + 18);
    sun.target.position.set(x, y, z);
    sun.target.updateMatrixWorld();
    enhanced.setFocus(x, y, z);
  }

  function render() {
    decayFlash();
    ctx.transition?.update?.();
    renderer.info.reset();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    if (crt.active) {
      renderer.setRenderTarget(crt.input);
      renderer.render(post.scene, post.camera);
      crt.render(renderer, now(), !ctx.env?.reduced, ctx.prefs?.flashes !== false);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(post.scene, post.camera);
    }
    calls = renderer.info.render.calls;
  }

  // Settings write ctx.prefs and announce "prefs"; only react to what actually changed so a
  // volume tweak never resets the adaptive quality level or re-arms the storm.
  function syncPrefs() {
    const prefs = ctx.prefs ?? {};
    if (normalizePixelation(prefs.pixelation) !== applied.pixelation) setPixelation(prefs.pixelation);
    if (crtLevel(prefs.crt) !== applied.crt) setCrt(prefs.crt);
    const nightmare = !!prefs.nightmare;
    const fog = fogAmount(prefs.fog);
    if (nightmare !== lighting.nightmare || fog !== lighting.fog || enhancedPref() !== enhancedOn) {
      lighting.nightmare = nightmare;
      lighting.fog = fog;
      enhancedOn = enhancedPref();
      applyLighting();
      ctx.weather?.setNightmare?.(nightmare);
    }
  }

  ctx.bus.on("prefs", syncPrefs);
  ctx.bus.on("stageBuilt", (payload) => applyStage(payload?.stage ?? 1));
  // An omen changing fogMult mid-stage takes effect at once.
  ctx.bus.on("rules", () => applyFog(36));
  // A new run (or the demo restarting after a death) always starts from a clean grade.
  ctx.bus.on("runStart", () => setGrade({ death: 0, hurt: 0, deathFade: 0 }));

  resize();
  applyStage(1);

  return {
    renderer,
    scene,
    camera,
    layers,
    resolution,
    sun,
    ambient,
    rim,
    accent,
    render,
    resize,
    setPixelation,
    setCrt,
    reduceQuality,
    restoreQuality,
    applyStage,
    updateFog,
    setGrade,
    flash,
    // Enhanced-lighting transient light (impacts, explosions, deaths); a no-op under classic.
    // Strong kicks are screen flashes and ask the flash budget, like flash().
    light(x, y, z, color = "#ffcf67", intensity = 4, range = 8, decay = 12) {
      if (!enhancedOn || !(intensity > 0)) return;
      const allowed = intensity > FLASH_BUDGETED ? requestFlash("light", intensity) : intensity;
      enhanced.kick(x, y, z, color, ctx.env?.reduced ? allowed * 0.5 : allowed, range, decay);
    },
    enhanced: () => enhancedOn,
    lights: enhanced,
    followLights,
    // Draw calls of the last frame (scene and post pass): the practice DRAWS readout (§1.4).
    drawCalls: () => calls,
    requestFlash,
    setMosaic,
  };
}
