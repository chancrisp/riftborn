// Attract mode: a CPU pilot plays the real simulation behind the main menu at 1.5x speed,
// cycling weapons and stages (spec flow.md §21). It never touches the player's input: the
// player system reads `move` (world space, |v| <= 1) and `firing` while the run is a demo,
// and the pilot writes its aim yaw/pitch straight onto run.player. Demo runs play the KEEPERS
// ruleset without keepers: the director opens each rift at its goal (IMPROVEMENTS §1.4).
import { WEAPONS } from "../data/weapons.js";
import { STAGES, FLOW } from "../data/stages.js";

const SUBSTEPS = 3;
const WEAPON_SECONDS = 7;
const CHASE_RANGE = 10; // farther targets are chased along the flow field
const BACK_OFF_RANGE = 5;
const DASH_RANGE = 4;
const STRAFE = 0.85;
const BACK_OFF = 0.7;
const MUZZLE = 1.47;
const CHEST = 1.2; // aim point above a target's feet, scaled by its model height

export function createDemo(ctx) {
  const move = { x: 0, z: 0 };
  const agent = { radius: 0.45 }; // the pilot's own navigation cache (steer writes onto it)
  let stage = 1;
  let age = 0;
  let weaponTime = 0;
  let firing = false;
  let finished = false;

  // A new run of any kind: the next demo starts fresh (the first switch lands on STINGER).
  function reset() {
    age = 0;
    weaponTime = 0;
    firing = false;
    finished = false;
    move.x = move.z = 0;
    delete agent.navCell;
    delete agent.navLayer;
    delete agent.navTick;
  }

  // Death, victory or a Death Mode toggle: the next step restarts on the following stage.
  function finish() {
    finished = true;
  }

  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;

  function steerTo(p, tx, tz) {
    const terrain = ctx.world?.terrain;
    if (terrain) {
      terrain.steer(p.x, p.z, tx, tz, agent, move);
      return;
    }
    const d = Math.hypot(tx - p.x, tz - p.z) || 1;
    move.x = (tx - p.x) / d;
    move.z = (tz - p.z) / d;
  }

  // Close in: circle the target, backing off when it gets too near.
  function strafe(aim, distance) {
    const side = aim + Math.PI / 2;
    const back = distance < BACK_OFF_RANGE ? BACK_OFF : 0;
    move.x = Math.sin(side) * STRAFE - Math.sin(aim) * back;
    move.z = Math.cos(side) * STRAFE - Math.cos(aim) * back;
    const n = Math.max(1, Math.hypot(move.x, move.z));
    move.x /= n;
    move.z /= n;
  }

  // Yaw and pitch from the muzzle to the target's chest.
  function aimAt(p, target) {
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const g = target.model?.g;
    const chest = g ? g.position.y + CHEST * g.scale.y : ground(target.x, target.z) + CHEST;
    p.aim = Math.atan2(dx, dz);
    p.aimPitch = Math.atan2(chest - (ground(p.x, p.z) + MUZZLE), Math.hypot(dx, dz));
  }

  function fly(run, dt) {
    const p = run.player;
    if (!p) return;
    age += dt;
    weaponTime -= dt;
    if (weaponTime <= 0) {
      ctx.player?.equip?.((run.weapon + 1) % WEAPONS.length);
      weaponTime = WEAPON_SECONDS;
    }
    // Burrowed monsters cannot be hit, so the pilot never chases one.
    const target = ctx.enemies?.nearest?.(p.x, p.z, ctx.enemies.isHittable) ?? null;
    firing = !!target;
    move.x = move.z = 0;
    if (target) {
      const distance = Math.hypot(target.x - p.x, target.z - p.z);
      aimAt(p, target);
      if (distance > CHASE_RANGE) steerTo(p, target.x, target.z);
      else strafe(p.aim, distance);
      if (distance < DASH_RANGE && p.dashCD <= 0) ctx.player?.dash?.();
    }
    const portal = ctx.world?.portal;
    if (run.portalActive && portal) steerTo(p, portal.x, portal.z);
  }

  // A fresh demo run: on stage 1 after a real run, otherwise on the next stage. The director
  // calls it under the results transition, so the menu reveals the new demo.
  function restart() {
    stage = ctx.run?.demo ? (stage % STAGES.length) + 1 : 1;
    ctx.director?.start?.({ demo: true, stage });
  }

  // Runs while the menu (or the results) is up. Restarts after a real run, and after the
  // demo dies, wins, is toggled or has played 80 demo-seconds.
  function update(dt) {
    if (globalThis.document?.hidden || ctx.overlay) return;
    const run = ctx.run;
    if (!run?.demo || finished || age > FLOW.DEMO_STAGE_SECONDS) restart();
    const current = ctx.run;
    if (!current?.demo) return;
    const step = (dt * FLOW.DEMO_SPEED) / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS && !finished; i++) {
      fly(current, step);
      ctx.director?.simulate?.(step);
      ctx.director?.effects?.(step);
    }
  }

  return {
    update,
    reset,
    finish,
    restart,
    get move() {
      return move;
    },
    get firing() {
      return firing && !!ctx.run?.demo;
    },
    get stage() {
      return stage;
    },
    get finished() {
      return finished;
    },
  };
}
