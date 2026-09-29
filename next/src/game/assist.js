// Aim assist tiers and auto-fire (ctx.assist, IMPROVEMENTS F18.2, F18.3), read by player.js
// (stick aim) and combat.updateFiring. Aim assist is for pads and touch only (the mouse keeps
// the Wave-1 pitch assist); nothing assists the attract demo; assisted fire never shoots into a
// Castellan vigil. The rules are the pure helpers of logic/assist.js; this module gathers the
// live targets for them without allocating per step.
import { ASSIST_TIERS, AUTO_FIRE, assistYaw, autoFireWants, blocksToward } from "./logic/assist.js";
import { WEAPONS } from "../data/weapons.js";
import { wrapAngle } from "../core/util.js";

export { ASSIST_TIERS, assistYaw, autoFireWants, blocksToward };

const MUZZLE_HEIGHT = 1.47;
const DEFAULT_RADIUS = 0.5;

// Targets the assists may consider: alive, hittable, and never a shade actor.
const assistable = (e) => !!e && !e.dead && !e.removed && e.hp > 0 && !e.untargetable && !e.shade;

export function createAssist(ctx) {
  const from = { x: 0, y: 0, z: 0 },
    to = { x: 0, y: 0, z: 0 };
  const aimPool = [],
    aimList = [],
    firePool = [],
    fire = { deflection: 0, range: 0, hostiles: [] };

  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const padOrTouch = () => ctx.input?.device === "pad" || ctx.input?.device === "touch";

  function stickDeflection() {
    const s = ctx.input?.aimStick?.();
    return s ? Math.hypot(s.x, s.y) : 0;
  }

  function weaponRange(run) {
    return (WEAPONS[run.weapon] ?? WEAPONS[0]).range;
  }

  // True when cover or terrain blocks the line from the muzzle column to the target's chest.
  function occluded(p, e) {
    from.x = p.x;
    from.y = ground(p.x, p.z) + MUZZLE_HEIGHT;
    from.z = p.z;
    const b = ctx.combat?.bodyBounds?.(e, true);
    to.x = e.x;
    to.y = b ? (b.bottom + b.top) / 2 : ground(e.x, e.z) + 1;
    to.z = e.z;
    return !!ctx.world?.trace?.(from, to, 0);
  }

  function record(pool, list) {
    let r = pool[list.length];
    if (!r) pool.push((r = {}));
    list.push(r);
    return r;
  }

  // Candidates near the stick bearing (magnetism) or under the current aim (friction), with
  // their line of sight; everything farther off is never traced.
  function gatherAim(run, p, aim, stickYaw, cone) {
    aimList.length = 0;
    const range = weaponRange(run),
      targets = ctx.combat?.targets?.() ?? [];
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (!assistable(e)) continue;
      const dx = e.x - p.x,
        dz = e.z - p.z,
        d = Math.hypot(dx, dz);
      if (d > range || d < 1e-3) continue;
      const bearing = Math.atan2(dx, dz),
        radius = e.def?.radius ?? e.radius ?? DEFAULT_RADIUS;
      const near = Math.abs(wrapAngle(bearing - stickYaw)) < cone || Math.abs(wrapAngle(bearing - aim)) < Math.atan2(radius, d);
      if (!near) continue;
      const r = record(aimPool, aimList);
      r.bearing = bearing;
      r.d = d;
      r.radius = radius;
      r.object = !!e.fixed;
      r.occluded = occluded(p, e);
    }
    return aimList;
  }

  // aimYaw(aim, stickYaw, dt) -> the assisted aim yaw (the stick's own bearing when assist is
  // off, on a mouse or keyboard, or in the demo).
  function aimYaw(aim, stickYaw, dt) {
    const tier = ASSIST_TIERS[ctx.prefs?.aimAssist];
    const run = ctx.run,
      p = run?.player;
    if (!tier || !p || run.demo || !padOrTouch()) return stickYaw;
    const targets = gatherAim(run, p, aim, stickYaw, tier.cone);
    return assistYaw(aim, stickYaw, targets, { cone: tier.cone, pull: tier.pull, deflection: stickDeflection() }, dt);
  }

  // Hostiles on or near the aim ray, placed for autoFireWants.
  function gatherFire(run, p, mode) {
    const list = fire.hostiles,
      aim = p.aim ?? 0,
      sin = Math.sin(aim),
      cos = Math.cos(aim),
      range = weaponRange(run),
      targets = ctx.combat?.targets?.() ?? [];
    list.length = 0;
    fire.range = range;
    fire.deflection = stickDeflection();
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (e.fixed || !assistable(e)) continue;
      const dx = e.x - p.x,
        dz = e.z - p.z,
        d = Math.hypot(dx, dz);
      if (d > range) continue;
      const along = dx * sin + dz * cos,
        perp = Math.abs(dx * cos - dz * sin),
        radius = e.def?.radius ?? e.radius ?? DEFAULT_RADIUS,
        delta = wrapAngle(Math.atan2(dx, dz) - aim),
        onRay = along > 0 && perp <= radius,
        inCone = Math.abs(delta) <= AUTO_FIRE.cone;
      if (!onRay && !inCone) continue;
      const r = record(firePool, list);
      r.along = along;
      r.perp = perp;
      r.radius = radius;
      r.delta = delta;
      r.d = d;
      r.blocking = blocksToward(e, p.x, p.z);
      r.visible = mode === "always" && inCone && !r.blocking && !occluded(p, e);
    }
    return fire;
  }

  // autoFire() -> true when prefs.autoFire wants a shot this step ("aiming": the aim stick is
  // deflected past 0.3; "always": a hostile in range and sight within 0.3 rad of the aim).
  function autoFire() {
    const mode = ctx.prefs?.autoFire;
    const run = ctx.run,
      p = run?.player;
    if ((mode !== "aiming" && mode !== "always") || !p || run.demo || !(p.hp > 0)) return false;
    return autoFireWants(mode, gatherFire(run, p, mode));
  }

  // enabled() -> whether any assist applies to the current device and run.
  function enabled() {
    const run = ctx.run;
    if (!run || run.demo) return false;
    const aim = !!ASSIST_TIERS[ctx.prefs?.aimAssist] && padOrTouch();
    return aim || ctx.prefs?.autoFire === "aiming" || ctx.prefs?.autoFire === "always";
  }

  return { aimYaw, autoFire, enabled };
}
