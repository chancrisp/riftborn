// Weather: the Nightmare storm (rain, lightning and the "thunder" cue) plus subtle per-stage
// ambient motes. Both only move inside simulation steps, so they freeze with pause, cards and
// overlays. Reduced motion keeps the storm calm and hides the motes. Every lightning flash asks
// the renderer's flash budget, and Reduce flashes softens it (IMPROVEMENTS F17).
import * as THREE from "three";
import { applyVertexSnap } from "./materials.js";
import { randomSource } from "../core/rng.js";
import { clamp, TAU } from "../core/util.js";

// Storm volume: drops live in group-local x, z in [-32, 32), y in [0, 34).
const DROP_HALF = 32;
const DROP_SPAN = 64;
const DROP_TOP = 34;
const FALL_SPEED = 31;
const FALL_SPEED_CALM = 19;
const STREAK = 1.2;
const STREAK_CALM = 0.8;
const FIRST_STRIKE = 3.5; // s after the storm is (re)armed
const FLASH_TIME = 0.9;
const STRIKE_RADIUS = 38;
const BOLT_POINTS = 8;
const LIGHT_PEAK = 0.95;
const BOLT_PEAK = 0.65;
// Reduce flashes: storm light at most 0.35 and the bolt at most 0.3, on a stepped ramp of two
// steps up over 0.25 s and two steps down over 0.5 s.
const SOFT_LIGHT = 0.35;
const SOFT_BOLT = 0.3;
const SOFT_STEPS = Object.freeze([
  [0.125, 0.5],
  [0.25, 1],
  [0.5, 0.66],
  [0.75, 0.33],
]);

// Motes wrap around the player in a box this size, so you walk past them.
const MOTE_HALF = 24;
const MOTE_SPAN = MOTE_HALF * 2;
const MOTE_BELOW = 2;
const MOTE_HEIGHT = 16;
const MOTE_REFERENCE_HEIGHT = 320; // point sizes are authored in 320p pixels

const MOTES = Object.freeze({
  // Meadows: pollen lifting on a light breeze.
  1: Object.freeze({ color: "#f2e7a6", count: 70, size: 1.5, opacity: 0.85, drift: [0.3, 0.22, -0.12], sway: 0.55, additive: false, embers: false }),
  // Quarry: grit carried sideways on the wind.
  2: Object.freeze({ color: "#cbbfa4", count: 80, size: 1.3, opacity: 0.6, drift: [1.35, 0.05, 0.35], sway: 0.35, additive: false, embers: false }),
  // Caldera: embers rising and cooling as they climb.
  3: Object.freeze({ color: "#ff9a52", count: 90, size: 1.7, opacity: 1, drift: [0.15, 1.5, 0.1], sway: 0.7, additive: true, embers: true }),
  // Citadel: slow aurora snow.
  4: Object.freeze({ color: "#d9f0ff", count: 110, size: 1.5, opacity: 0.9, drift: [0.3, -1.15, 0.12], sway: 0.6, additive: false, embers: false }),
  // Void Crown: drifting ash.
  5: Object.freeze({ color: "#9b86c6", count: 80, size: 1.5, opacity: 0.75, drift: [0.1, -0.4, 0.05], sway: 0.45, additive: false, embers: false }),
});
const MOTE_CAPACITY = Math.max(...Object.values(MOTES).map((m) => m.count));

// Keep v within [center - half, center + half) by whole spans (handles teleports too).
function wrapAround(v, center, half, span) {
  const d = v - center;
  if (d >= -half && d < half) return v;
  return center + ((((d + half) % span) + span) % span) - half;
}

function createStorm(ctx) {
  const reduced = !!ctx.env?.reduced;
  const count = ctx.env?.mobile ? 360 : 720;
  const random = randomSource(93127); // deterministic layout and strikes, like the original
  const drops = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    drops[i * 3] = (random() - 0.5) * DROP_SPAN;
    drops[i * 3 + 1] = random() * DROP_TOP;
    drops[i * 3 + 2] = (random() - 0.5) * DROP_SPAN;
  }

  const positions = new Float32Array(count * 6);
  const rainAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const rainGeometry = new THREE.BufferGeometry().setAttribute("position", rainAttribute);
  const rain = new THREE.LineSegments(
    rainGeometry,
    new THREE.LineBasicMaterial({ color: "#a5b6c3", transparent: true, opacity: 0.4, depthWrite: false }),
  );
  rain.frustumCulled = false;

  const boltAttribute = new THREE.BufferAttribute(new Float32Array(BOLT_POINTS * 3), 3);
  const boltMaterial = new THREE.LineBasicMaterial({ color: "#c0cbd5", transparent: true, opacity: 0, fog: false });
  const bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute("position", boltAttribute), boltMaterial);
  bolt.frustumCulled = false;

  // The light stays in the always-visible root so toggling Nightmare never changes the scene's
  // light count (which would recompile every material); only rain and bolt hide.
  const root = new THREE.Group();
  root.name = "storm";
  const visuals = new THREE.Group();
  visuals.visible = false;
  visuals.add(rain, bolt);
  const light = new THREE.DirectionalLight("#bcc8d6", 0);
  light.position.set(-20, 35, -15);
  light.target = root;
  root.add(visuals, light);

  // light/bolt: this strike's peaks after the flash budget; soft: the Reduce flashes ramp;
  // x, z: the strike point in world space (the thunder pans toward it).
  const state = { enabled: false, age: 0, nextStrike: FIRST_STRIKE, flashAge: 2, thunderDelay: -1, light: 0, bolt: 0, soft: false, x: 0, z: 0 };

  function layoutRain() {
    const streak = reduced ? STREAK_CALM : STREAK;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      const k = i * 6;
      positions[k] = drops[j];
      positions[k + 1] = drops[j + 1];
      positions[k + 2] = drops[j + 2];
      positions[k + 3] = drops[j] - 0.45;
      positions[k + 4] = drops[j + 1] + streak;
      positions[k + 5] = drops[j + 2] - 0.1;
    }
    rainAttribute.needsUpdate = true;
  }

  function moveDrops(dt, time) {
    const wind = 7 + Math.sin(time * 0.65) * 3;
    const fall = (reduced ? FALL_SPEED_CALM : FALL_SPEED) * dt;
    for (let j = 0; j < count * 3; j += 3) {
      drops[j] += wind * dt;
      drops[j + 1] -= fall;
      drops[j + 2] += 2 * dt;
      if (drops[j] > DROP_HALF) drops[j] -= DROP_SPAN;
      if (drops[j + 2] > DROP_HALF) drops[j + 2] -= DROP_SPAN;
      if (drops[j + 1] < 0) drops[j + 1] += DROP_TOP;
    }
    layoutRain();
  }

  // A jagged 8-point bolt 38 m away in a random direction, from 35 m down to 7 m (local).
  // Reduced motion keeps the thunder but shows no flash or bolt; otherwise the flash budget
  // (and Reduce flashes) set this strike's peaks.
  function strike() {
    state.nextStrike = state.age + 5 + random() * 6;
    state.flashAge = 0;
    state.thunderDelay = 0.5 + random() * 0.7;
    const angle = random() * TAU;
    const x = Math.cos(angle) * STRIKE_RADIUS;
    const z = Math.sin(angle) * STRIKE_RADIUS;
    for (let i = 0; i < BOLT_POINTS; i++) boltAttribute.setXYZ(i, x + (random() - 0.5) * 3, 35 - i * 4, z + (random() - 0.5) * 2);
    boltAttribute.needsUpdate = true;
    state.x = root.position.x + x;
    state.z = root.position.z + z;
    state.soft = ctx.prefs?.flashes === false;
    const peak = state.soft ? SOFT_LIGHT : LIGHT_PEAK;
    const allowed = reduced ? 0 : (ctx.gfx?.requestFlash?.("lightning", peak) ?? peak);
    state.light = allowed;
    state.bolt = (allowed / peak) * (state.soft ? SOFT_BOLT : BOLT_PEAK);
  }

  // 0..1 envelope of the current flash: one soft pulse (peak at 0.45 s), or the stepped ramp.
  function envelope(age) {
    if (!state.soft) return age < FLASH_TIME ? Math.sin((age / FLASH_TIME) * Math.PI) ** 2 : 0;
    for (const [until, level] of SOFT_STEPS) if (age < until) return level;
    return 0;
  }

  // (Re)arming also schedules the first strike 3.5 s out, as every stage change did originally.
  function setEnabled(value) {
    state.enabled = value;
    visuals.visible = value;
    light.intensity = 0;
    boltMaterial.opacity = 0;
    state.flashAge = 2;
    state.thunderDelay = -1;
    state.nextStrike = state.age + FIRST_STRIKE;
  }

  // Returns true on the step the thunder should sound.
  function update(dt, time, x, ground, z) {
    if (!state.enabled) return false;
    state.age += dt;
    root.position.set(x, ground - 4, z);
    moveDrops(dt, time);
    if (state.age >= state.nextStrike) strike();
    state.flashAge += dt;
    const flash = envelope(state.flashAge);
    light.intensity = flash * state.light;
    boltMaterial.opacity = flash * state.bolt;
    if (state.thunderDelay >= 0) {
      state.thunderDelay -= dt;
      if (state.thunderDelay < 0) return true;
    }
    return false;
  }

  layoutRain();
  return {
    root,
    setEnabled,
    update,
    get enabled() {
      return state.enabled;
    },
    // World point of the latest strike, for the thunder's pan.
    get strikeX() {
      return state.x;
    },
    get strikeZ() {
      return state.z;
    },
  };
}

function createMotes(ctx) {
  const scale = ctx.env?.mobile ? 0.6 : 1;
  const positions = new Float32Array(MOTE_CAPACITY * 3);
  const colors = new Float32Array(MOTE_CAPACITY * 3);
  const phase = new Float32Array(MOTE_CAPACITY);
  const brightness = new Float32Array(MOTE_CAPACITY);
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colorAttribute = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", colorAttribute);

  // Square pixel specks at a constant internal-pixel size, snapped like the rest of the world.
  const material = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false });
  material.onBeforeCompile = applyVertexSnap;
  material.customProgramCacheKey = () => "ps1-snap-points-v1";
  const points = new THREE.Points(geometry, material);
  points.name = "motes";
  points.frustumCulled = false;
  points.visible = false;

  let config = null;
  let count = 0;
  let time = 0;
  let sizedFor = 0;
  let scattered = false;

  function configure(stage) {
    config = MOTES[stage] ?? null;
    count = config ? Math.round(config.count * scale) : 0;
    geometry.setDrawRange(0, count);
    if (config) {
      material.color.set(config.color);
      material.opacity = config.opacity;
      material.blending = config.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    }
    sizedFor = 0;
    scattered = false;
  }

  function writeColor(i, value) {
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = value;
  }

  function scatter(x, ground, z) {
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x + (Math.random() * 2 - 1) * MOTE_HALF;
      positions[i * 3 + 1] = ground - MOTE_BELOW + Math.random() * MOTE_HEIGHT;
      positions[i * 3 + 2] = z + (Math.random() * 2 - 1) * MOTE_HALF;
      phase[i] = Math.random() * TAU;
      brightness[i] = 0.55 + Math.random() * 0.45;
      writeColor(i, brightness[i]);
    }
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    scattered = true;
  }

  // Embers flicker and cool (dim) as they climb through the volume.
  function emberGlow(i, y, ground) {
    const climb = clamp((y - ground + MOTE_BELOW) / MOTE_HEIGHT, 0, 1);
    const flicker = 0.6 + 0.4 * Math.sin(time * 9 + phase[i] * 3);
    return brightness[i] * flicker * (1 - 0.75 * climb);
  }

  function update(dt, x, ground, z) {
    if (!points.visible || !config) return;
    if (!scattered) scatter(x, ground, z);
    const height = ctx.gfx?.resolution?.h ?? MOTE_REFERENCE_HEIGHT;
    if (height !== sizedFor) {
      sizedFor = height;
      material.size = Math.max(1, (config.size * height) / MOTE_REFERENCE_HEIGHT);
    }
    time += dt;
    const drift = config.drift;
    const dx = drift[0];
    const dy = drift[1];
    const dz = drift[2];
    const sway = config.sway;
    const bottom = ground - MOTE_BELOW;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      const p = phase[i];
      const px = positions[j] + (dx + sway * Math.sin(time * 0.9 + p)) * dt;
      const py = positions[j + 1] + (dy + sway * 0.35 * Math.sin(time * 1.3 + p * 1.7)) * dt;
      const pz = positions[j + 2] + (dz + sway * Math.cos(time * 0.7 + p)) * dt;
      positions[j] = wrapAround(px, x, MOTE_HALF, MOTE_SPAN);
      positions[j + 1] = wrapAround(py, bottom + MOTE_HEIGHT / 2, MOTE_HEIGHT / 2, MOTE_HEIGHT);
      positions[j + 2] = wrapAround(pz, z, MOTE_HALF, MOTE_SPAN);
      if (config.embers) writeColor(i, emberGlow(i, positions[j + 1], ground));
    }
    positionAttribute.needsUpdate = true;
    if (config.embers) colorAttribute.needsUpdate = true;
  }

  return {
    points,
    configure,
    update,
    setVisible(visible) {
      points.visible = visible && count > 0;
    },
    // Re-seed around the player on the next update (stage change / run start).
    reset() {
      scattered = false;
    },
  };
}

export function createWeather(ctx) {
  const reduced = !!ctx.env?.reduced;
  const storm = createStorm(ctx);
  const motes = createMotes(ctx);
  ctx.gfx.scene.add(storm.root, motes.points);
  let stage = 1;

  const groundAt = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };

  // The storm replaces the ambient motes; reduced motion hides them entirely.
  function refreshMotes() {
    motes.setVisible(!storm.enabled && !reduced);
  }

  function update(dt) {
    if (!(dt > 0)) return;
    const run = ctx.run;
    const x = Number.isFinite(run?.player?.x) ? run.player.x : 0;
    const z = Number.isFinite(run?.player?.z) ? run.player.z : 0;
    const ground = groundAt(x, z);
    // Original gate: Nightmare weather runs in play or behind the attract demo, never under
    // an overlay (so it freezes in pause, cards and cinematics).
    if (storm.enabled && !ctx.overlay && (ctx.mode === "play" || run?.demo)) {
      const cam = ctx.gfx?.camera?.position;
      if (cam) ctx.gfx.updateFog?.(Math.hypot(cam.x - x, cam.y - ground, cam.z - z));
      if (storm.update(dt, run?.elapsed ?? 0, x, ground, z)) ctx.bus.emit("thunder", { x: storm.strikeX, z: storm.strikeZ });
    }
    if (!ctx.overlay && (ctx.mode === "play" || ctx.mode === "sequence" || run?.demo)) motes.update(dt, x, ground, z);
  }

  // stage: 1..5 or a STAGES entry. Every stage build re-arms the first strike.
  function setStage(value) {
    const id = clamp(Math.round(Number(typeof value === "object" ? value?.id : value)) || 1, 1, 5);
    if (id !== stage) {
      stage = id;
      motes.configure(id);
      refreshMotes();
    }
    storm.setEnabled(storm.enabled);
  }

  function setNightmare(on) {
    if (!!on === storm.enabled) return;
    storm.setEnabled(!!on);
    refreshMotes();
  }

  // Stage change / run start: calm sky, first strike re-armed, motes re-seeded.
  function clear() {
    storm.setEnabled(storm.enabled);
    motes.reset();
  }

  motes.configure(stage);
  setNightmare(!!ctx.prefs?.nightmare);
  refreshMotes();
  return { update, setStage, setNightmare, clear };
}
