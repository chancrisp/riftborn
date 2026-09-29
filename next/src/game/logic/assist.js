// Pure assist rules (IMPROVEMENTS F18.2, F18.3), THREE-free so tests drive them directly;
// game/assist.js gathers the live targets and re-exports these.
import { wrapAngle } from "../../core/util.js";
import { arcOf, guardOf } from "./combat.js";

// Aim assist tiers (prefs.aimAssist; "off" has no row): cone half-angle (rad) around the stick
// bearing, and the share of the gap to the target's bearing closed per unit of the time factor.
export const ASSIST_TIERS = Object.freeze({
  low: Object.freeze({ cone: 0.1, pull: 0.35 }),
  standard: Object.freeze({ cone: 0.18, pull: 0.55 }),
  high: Object.freeze({ cone: 0.26, pull: 0.75 }),
});
// Magnetism needs this stick deflection; friction scales stick rotation while the aim is on a
// target's body; `rate` is the time constant of 1 − exp(−rate·dt).
export const ASSIST = Object.freeze({ deflection: 0.18, friction: 0.6, rate: 14 });
// Auto-fire: "aiming" fires past this aim-stick deflection; "always" wants a hostile within
// this many radians of the aim.
export const AUTO_FIRE = Object.freeze({ deflection: 0.3, cone: 0.3 });

const DEG = 180 / Math.PI;

// Priority of a candidate in the cone: the lowest delta × 20 + d × 0.01 wins.
function bestIn(targets, stickYaw, cone, objects) {
  let best = null,
    rank = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.occluded || !!t.object !== objects) continue;
    const delta = Math.abs(wrapAngle(t.bearing - stickYaw));
    if (delta >= cone) continue;
    const r = delta * 20 + t.d * 0.01;
    if (r < rank) {
      rank = r;
      best = t;
    }
  }
  return best;
}

// Hostiles first; anchors and nodes only when no hostile qualifies.
export function assistTarget(targets, stickYaw, cone) {
  return bestIn(targets, stickYaw, cone, false) ?? bestIn(targets, stickYaw, cone, true);
}

// True when the aim lies within a visible target's angular half-width atan(radius / d).
function onBody(targets, aim) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.occluded && Math.abs(wrapAngle(t.bearing - aim)) < Math.atan2(t.radius, t.d)) return true;
  }
  return false;
}

// assistYaw(aim, stickYaw, targets, cfg, dt) -> the aim yaw for this step.
//   aim: last step's aim yaw; stickYaw: the aim stick's bearing now;
//   targets: [{ bearing, d, radius, object, occluded }] (occluded ones never count: no assist
//   through cover); cfg: { cone, pull, deflection } or null (assist off).
// Friction: while the aim rests on a body, the aim follows the stick's turn at ×0.6.
// Magnetism: past a 0.18 deflection, the aim is pulled toward the best target in the cone by
// pull × (1 − exp(−14·dt)) of the remaining gap.
export function assistYaw(aim, stickYaw, targets, cfg, dt) {
  if (!cfg) return stickYaw;
  let yaw = onBody(targets, aim) ? aim + wrapAngle(stickYaw - aim) * ASSIST.friction : stickYaw;
  const best = cfg.deflection > ASSIST.deflection ? assistTarget(targets, stickYaw, cfg.cone) : null;
  if (best) yaw += wrapAngle(best.bearing - yaw) * cfg.pull * (1 - Math.exp(-ASSIST.rate * dt));
  return wrapAngle(yaw);
}

// True when `e` keeps a blocking guard (the Castellan's VIGIL dome) toward a player at (px, pz):
// guard.block and the player's bearing falls in its front arc.
export function blocksToward(e, px, pz) {
  const g = guardOf(e);
  if (!g?.block) return false;
  const dx = px - e.x,
    dz = pz - e.z,
    len = Math.hypot(dx, dz) || 1,
    yaw = e.yaw ?? 0,
    dot = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / len;
  return arcOf(Math.acos(Math.max(-1, Math.min(1, dot))) * DEG, g) === "front";
}

// autoFireWants(mode, state) -> whether assisted fire shoots this step.
//   mode: prefs.autoFire ("off" | "aiming" | "always");
//   state: { deflection, range, hostiles: [{ along, perp, radius, delta, d, visible, blocking }] }
//   where along / perp place a hostile on the aim ray, delta is its bearing minus the aim.
// The VIGIL rule: never while the first hostile along the aim ray (within range) blocks; the
// "always" candidates skip blocking hostiles too. Held fire is never suppressed (not here).
export function autoFireWants(mode, state) {
  if (mode !== "aiming" && mode !== "always") return false;
  const hostiles = state?.hostiles ?? [];
  const range = state?.range ?? 0;
  let first = null;
  for (let i = 0; i < hostiles.length; i++) {
    const h = hostiles[i];
    if (h.along > 0 && h.along <= range && h.perp <= h.radius && (!first || h.along < first.along)) first = h;
  }
  if (first?.blocking) return false;
  if (mode === "aiming") return (state?.deflection ?? 0) > AUTO_FIRE.deflection;
  for (let i = 0; i < hostiles.length; i++) {
    const h = hostiles[i];
    if (h.visible && !h.blocking && h.d <= range && Math.abs(h.delta) <= AUTO_FIRE.cone) return true;
  }
  return false;
}
