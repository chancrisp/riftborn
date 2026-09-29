// Camera rig: eased follow of the player at a fixed 0.85 height ratio (~40 degree pitch),
// cinematic and attract-mode framing, boss framing (IMPROVEMENTS F1.6), pause-aware shake, the
// occlusion cutaway uniforms, and screen-space helpers for DOM overlays and mouse aim. Runs
// every simulation step in every mode.
import * as THREE from "three";
import { cutaway } from "./materials.js";
import { clamp, wrapAngle } from "../core/util.js";

const DEFAULT_YAW = 0.35;
const DEFAULT_DISTANCE = 25;
const MIN_DISTANCE = 16;
const MAX_DISTANCE = 36;
const HEIGHT_RATIO = 0.85;
const FOLLOW_RATE = 7;
const ORBIT_SPEED = 1.6; // rad/s for the orbit keys
const DRAG_ORBIT = 0.008; // rad per pixel of mouse drag
const WHEEL_ZOOM = 0.018; // metres per wheel pixel
const SHAKE_DECAY = 14;
const DEMO_YAW = 0.4;
const DEMO_DISTANCE = 29;
const DEMO_SHIFT = 7; // metres along camera-right: the attract hero sits left of centre
const CUTAWAY_RATE = 12;
// Boss framing: while a boss or keeper lives within 40 m in play, the look target moves 30% of
// the way toward it and the camera pulls back as they separate, never past 29 m, so ground
// telegraph strips stay at least two internal pixels wide (F1.5). Both ease at 2.5 /s.
const FRAME_RANGE = 40;
const FRAME_SHIFT = 0.3;
const FRAME_NEAR = 14;
const FRAME_PULL = 0.6;
const FRAME_MIN = 25;
const FRAME_MAX = 29;
const FRAME_RATE = 2.5;

// e.buttons bit for each bindable mouse button code.
const BUTTON_BITS = { Mouse0: 1, Mouse1: 4, Mouse2: 2 };

// Scratch objects: the rig runs every step and must not allocate.
const desired = new THREE.Vector3();
const chest = new THREE.Vector3();
const edge = new THREE.Vector3();
const top = new THREE.Vector3();
const view = new THREE.Vector3();
const ndc = new THREE.Vector3();
const sharedRay = new THREE.Ray();

export function createCamera(ctx) {
  const cine = { actor: null, progress: 0 };
  const focus = { x: 0, y: 0, z: 0 }; // the player's feet: cutaway, lights
  const framing = { x: 0, z: 0, extra: 0 }; // eased boss-framing shift and pull-back beyond the zoom
  let shakeAmount = 0;

  const groundAt = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const camera = () => ctx.gfx?.camera ?? null;
  // Shake holds (no jitter, no decay) while the simulation is frozen behind a modal.
  const frozen = () => ctx.mode === "pause" || ctx.mode === "upgrade" || !!ctx.overlay;

  function orbit(deltaRad) {
    if (Number.isFinite(deltaRad)) api.yaw = wrapAngle(api.yaw + deltaRad);
  }

  function zoom(delta) {
    if (Number.isFinite(delta)) api.distance = clamp(api.distance + delta, MIN_DISTANCE, MAX_DISTANCE);
  }

  function shake(amount) {
    if (ctx.env?.reduced || !(amount > 0)) return;
    shakeAmount = Math.max(shakeAmount, amount);
  }

  // `kind` is accepted for the contract but framing keys off the actor itself: an enemy with a
  // model, or a position actor { x, z, y } (y = absolute height) such as the Crown Dais.
  function setCinematic(actor, { progress = 0 } = {}) {
    cine.actor = actor ?? null;
    cine.progress = Number.isFinite(progress) ? progress : 0;
  }

  // The director's sequence object is authoritative when it names an actor; a stale
  // setCinematic() is dropped as soon as no sequence is running.
  function cinematicActor() {
    const sequence = ctx.cinematic;
    if (!sequence && ctx.mode !== "sequence") {
      cine.actor = null;
      return null;
    }
    if (ctx.env?.reduced) return null;
    const actor = sequence?.actor !== undefined ? sequence.actor : cine.actor;
    return actor && Number.isFinite(actor.x) && Number.isFinite(actor.z) ? actor : null;
  }

  function cinematicProgress() {
    const p = ctx.cinematic?.progress;
    return Number.isFinite(p) ? p : cine.progress;
  }

  const isWarden = (actor) => actor.boss === "warden" || actor.kind === "warden";
  // A position actor ({ x, z, y }, no model: the Crown Dais) is framed wide, like the Warden.
  const isPlace = (actor) => !actor.model && !actor.g;
  const actorHeight = (actor) =>
    actor.model?.g?.position.y ?? actor.g?.position.y ?? (isPlace(actor) && Number.isFinite(actor.y) ? actor.y : groundAt(actor.x, actor.z));

  // The live boss to frame, or null: pref on, no reduced motion, in play, alive and within range.
  function framedBoss() {
    if (ctx.prefs?.bossFraming === false || ctx.env?.reduced || ctx.mode !== "play" || ctx.run?.demo) return null;
    const boss = ctx.bosses?.current?.();
    if (!boss || boss.dead || !(boss.hp > 0) || !Number.isFinite(boss.x) || !Number.isFinite(boss.z)) return null;
    return Math.hypot(boss.x - focus.x, boss.z - focus.z) <= FRAME_RANGE ? boss : null;
  }

  // Eases the framing shift and distance toward the boss (or back to the player and the
  // player's own zoom). Holds while the simulation is frozen behind a modal.
  function updateBossFraming(dt) {
    if (frozen()) return;
    const boss = framedBoss();
    let sx = 0;
    let sz = 0;
    let extra = 0;
    if (boss) {
      const dx = boss.x - focus.x;
      const dz = boss.z - focus.z;
      sx = dx * FRAME_SHIFT;
      sz = dz * FRAME_SHIFT;
      // distance = max(zoom, clamp(25 + max(0, separation - 14) x 0.6, 25, 29))
      extra = Math.max(0, clamp(FRAME_MIN + Math.max(0, Math.hypot(dx, dz) - FRAME_NEAR) * FRAME_PULL, FRAME_MIN, FRAME_MAX) - api.distance);
    }
    const k = 1 - Math.exp(-FRAME_RATE * dt);
    framing.x += (sx - framing.x) * k;
    framing.z += (sz - framing.z) * k;
    framing.extra += (extra - framing.extra) * k;
  }

  // Look target and desired camera position for this step (written into api.target/desired).
  function computeFraming() {
    const player = ctx.run?.player;
    focus.x = Number.isFinite(player?.x) ? player.x : 0;
    focus.z = Number.isFinite(player?.z) ? player.z : 0;
    focus.y = groundAt(focus.x, focus.z);
    let tx = focus.x + framing.x;
    let ty = focus.y + 1;
    let tz = focus.z + framing.z;
    let yaw = api.yaw;
    // The player's zoom, plus whatever boss framing pulls further back.
    let dist = api.distance + framing.extra;
    const actor = cinematicActor();
    if (actor) {
      const wide = isWarden(actor) || isPlace(actor);
      tx = actor.x;
      tz = actor.z;
      ty = actorHeight(actor) + (wide ? 3.5 : 1.8);
      dist = wide ? 22 : 17;
      yaw += 0.15 * Math.sin(cinematicProgress() * Math.PI); // slow half-arc drift
    }
    if (ctx.run?.demo) {
      yaw = DEMO_YAW;
      dist = DEMO_DISTANCE;
      tx += Math.cos(yaw) * DEMO_SHIFT;
      tz -= Math.sin(yaw) * DEMO_SHIFT;
    }
    api.target.x = tx;
    api.target.y = ty;
    api.target.z = tz;
    desired.set(tx + Math.sin(yaw) * dist, ty + HEIGHT_RATIO * dist, tz + Math.cos(yaw) * dist);
  }

  function applyKeyboardOrbit(dt) {
    if (ctx.mode !== "play" || ctx.overlay || ctx.run?.demo) return;
    const input = ctx.input;
    if (!input?.held) return;
    if (input.held("orbitLeft")) orbit(ORBIT_SPEED * dt);
    if (input.held("orbitRight")) orbit(-ORBIT_SPEED * dt);
  }

  // Pure translation jitter applied after lookAt; it also seeds the next step's lerp, like
  // the original. Cosmetic randomness only, so seeded runs stay deterministic.
  function applyShake(cam, dt) {
    if (shakeAmount <= 0 || frozen()) return;
    shakeAmount *= Math.exp(-SHAKE_DECAY * dt);
    if (shakeAmount < 1e-4) {
      shakeAmount = 0;
      return;
    }
    const amount = shakeAmount * clamp((ctx.prefs?.shake ?? 100) / 100, 0, 1);
    cam.position.x += (Math.random() * 2 - 1) * amount;
    cam.position.y += (Math.random() * 2 - 1) * amount;
  }

  // Three projections per step, no raycasts: the aperture ellipse around the hero's chest in
  // screen UV, the depth in front of which scenery may be cut, and the feet floor.
  function updateCutaway(cam, dt) {
    cam.updateMatrixWorld();
    chest.set(focus.x, focus.y + 1.2, focus.z);
    view.copy(chest).applyMatrix4(cam.matrixWorldInverse);
    edge.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(1.7).add(chest).project(cam);
    top.set(chest.x, chest.y + 2.1, chest.z).project(cam);
    chest.project(cam);
    cutaway.center.value.set(chest.x * 0.5 + 0.5, chest.y * 0.5 + 0.5);
    cutaway.radius.value.set(Math.max(0.008, Math.abs(edge.x - chest.x) * 0.5), Math.max(0.012, Math.abs(top.y - chest.y) * 0.7));
    cutaway.depth.value = -view.z - 0.6;
    cutaway.floor.value = focus.y + 0.25;
    const enabled = cutaway.active !== false && ctx.mode !== "dead";
    const goal = enabled && view.z < 0 ? 1 : 0;
    cutaway.strength.value += (goal - cutaway.strength.value) * (1 - Math.exp(-CUTAWAY_RATE * dt));
  }

  function update(dt) {
    const cam = camera();
    if (!cam || !(dt > 0)) return;
    applyKeyboardOrbit(dt);
    updateBossFraming(dt);
    computeFraming();
    cam.position.lerp(desired, 1 - Math.exp(-FOLLOW_RATE * dt));
    cam.lookAt(api.target.x, api.target.y, api.target.z);
    applyShake(cam, dt);
    updateCutaway(cam, dt);
    ctx.gfx.followLights?.(focus.x, focus.y, focus.z);
  }

  // New run: default yaw and zoom, no shake, and the camera placed on its framing at once.
  function reset() {
    api.yaw = DEFAULT_YAW;
    api.distance = DEFAULT_DISTANCE;
    shakeAmount = 0;
    framing.x = framing.z = framing.extra = 0;
    setCinematic(null);
    const cam = camera();
    if (!cam) return;
    computeFraming();
    cam.position.copy(desired);
    cam.lookAt(api.target.x, api.target.y, api.target.z);
    cam.updateMatrixWorld();
  }

  // World point -> CSS pixels (the canvas fills the window). Pass `out` to avoid allocation.
  function project(x, y, z, out = {}) {
    const cam = camera();
    if (!cam) {
      out.x = out.y = 0;
      out.visible = false;
      return out;
    }
    ndc.set(x, y, z).project(cam);
    out.x = (ndc.x * 0.5 + 0.5) * innerWidth;
    out.y = (-ndc.y * 0.5 + 0.5) * innerHeight;
    out.visible = ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1;
    return out;
  }

  // Ray from the camera through a client-space point. The default result is a shared Ray,
  // valid until the next call; pass `out` to keep it.
  function screenRay(clientX, clientY, out = sharedRay) {
    const cam = camera();
    if (!cam) return out;
    out.origin.setFromMatrixPosition(cam.matrixWorld);
    out.direction
      .set((clientX / Math.max(1, innerWidth)) * 2 - 1, -(clientY / Math.max(1, innerHeight)) * 2 + 1, 0.5)
      .unproject(cam)
      .sub(out.origin)
      .normalize();
    return out;
  }

  // Line/page wheel deltas (Firefox) are scaled to pixels so zoom speed is browser-independent.
  function wheelPixels(e) {
    return e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1);
  }

  function dragHeld(e) {
    const bit = BUTTON_BITS[ctx.prefs?.bindings?.orbitDrag ?? "Mouse2"];
    return bit ? (e.buttons & bit) !== 0 : !!ctx.input?.held?.("orbitDrag");
  }

  function bindPointer(canvas) {
    if (!canvas?.addEventListener) return;
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoom(wheelPixels(e) * WHEEL_ZOOM);
      },
      { passive: false },
    );
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || ctx.mode !== "play" || ctx.overlay) return;
      if (dragHeld(e)) orbit(-e.movementX * DRAG_ORBIT);
    });
    // Right-drag orbits the camera; never let the browser menu interrupt it.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  const api = {
    yaw: DEFAULT_YAW,
    distance: DEFAULT_DISTANCE,
    target: { x: 0, y: 1, z: 0 },
    cutaway,
    update,
    reset,
    orbit,
    zoom,
    setCinematic,
    shake,
    project,
    screenRay,
  };

  bindPointer(ctx.canvas);
  ctx.bus.on("runStart", reset);
  return api;
}
