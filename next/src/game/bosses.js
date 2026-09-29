// Bosses (ctx.bosses): the Rift Keepers (IMPROVEMENTS F1-F6) and the Wave-1 bosses they grew
// from. Every keeper is an ordinary Enemy record made by ctx.enemies.spawn; enemies.update ticks
// its hit flash and hands it to update(e, dt), which owns the rest (cooldown, movement, attacks,
// contact and pose). Gates and cinematics go through the director.
//
// Under ORIGINAL, startQuarry() and summonWarden() run the Wave-1 Iron Maw and Rift Warden
// exactly (the golden parity trace replays them). Under KEEPERS, startKeeper(id) raises any
// keeper: the Bellwether (keepers/bellwether.js), Iron Maw and the Warden (this file), the
// Cinder Abbot and the Castellan (keepers/abbot.js, keepers/castellan.js). Keeper AIs share the
// kit (keeperKit) and the attack registry (ATTACKS), which the Warden's shades replay.
import * as THREE from "three";
import { CHALLENGE, IRON_MAW, MAX_HOSTILES } from "../data/enemies.js";
import { KEEPER_ORDER, keeperDef } from "../data/keepers.js";
import { animateCharacter, createMonster, monsterKit, setTint, spectral } from "../render/models.js";
import { retroMaterial, unlitMaterial, TILE } from "../render/materials.js";
import { clamp, TAU } from "../core/util.js";
import { HOSTILE_ROUND } from "./logic/combat.js";
import {
  turnToward,
  pickAttack,
  gateFloor,
  gateDue,
  openGate,
  toward,
  chargeStep,
  simulateCharge,
  rockfallPoints,
  mawAfterSkid,
  wardenStrike,
  shardPoints,
  blastPoints,
  shadeList,
  shadeFloor,
  shadeBearing,
  daisLanding,
  crownPoint,
  PLAYER_REACH,
} from "./logic/keepers.js";
import { register as registerBellwether } from "./keepers/bellwether.js";
import { register as registerAbbot } from "./keepers/abbot.js";
import { register as registerCastellan } from "./keepers/castellan.js";

export { turnToward, pickAttack, gateFloor };

const CONTACT_REACH = PLAYER_REACH; // player radius added to the boss radius for contact damage
const ARRIVAL_GRACE = 2; // player invulnerability (at least) when a boss arrives

// Flow-field pursuit is paced like the ordinary monsters' (enemies.js): the rebuilt look-ahead
// steering closes ~1.9x faster than the original's node-by-node walk, so beyond point-blank
// range the stated speeds are scaled back to keep the original pressure.
const CHASE_PACE = 0.53;
const DIRECT_RANGE = 3;

// Iron Maw.
const MAW_REACH = 24; // starts a windup inside this distance
const MAW_ORIGIN = Object.freeze({ x: 10, z: -8 }); // arrival point (snapped by enemies.spawn)
const MAW_COVER_PROBE = 0.8; // cover trace radius = def.radius x this, 1 m above ground
const MAW_RECOVER = 2.2; // cooldown after a charge that found no cover
const MAW_REGROUP = 1.8; // cooldown after a stagger
const MAW_ENTRY_COOLDOWN = 1.5;
const MAW_REST = 7; // spawn rest after its death
const MAW_STAGGER_RING = "#e8cc80";
// F3 (charge sound and dust: both rulesets; the rest KEEPERS only).
const MAW_DUST = Object.freeze({ color: "#b6a184", every: 0.05, count: 3, speed: 2, ring: 2.5 });
const MAW_SKID = 0.35;
const MAW_REAIM = 0.45;
const MAW_SECOND_CHARGE = 0.7;
const MAW_RAGE = Object.freeze({ speed: 3.4, stagger: 2.4, ring: "#ff5656", size: 5, tint: "#ff9d8a", amount: 0.25 });
const ROCKFALL = Object.freeze({ radius: 1.8, fuse: 1, damage: 20, monsters: 60, crush: 80, drop: 0.35, height: 9, shake: 0.3, color: "#9a9286" });
const RUBBLE = Object.freeze({ text: "RUBBLE CRUSH", color: "#e2ba86" });
const SHADE_CHARGE_CONTACT = 30;

// Rift Warden.
const WARDEN_REACH = 8; // stands still inside this distance
const WARDEN_WINDUP = Object.freeze([1.1, 0.75]); // [normal, enraged]
const WARDEN_COOLDOWN = Object.freeze([2.4, 1.5]);
const WARDEN_ENTRY_COOLDOWN = 2.5;
const WARDEN_STRIDE = 0.4; // animation speed: always a slow stride
const WARDEN_TINT = "#efb6b0";
const RING_SHOTS = 14;
const RING_HEIGHT = 1.2; // radial shots fly level at chest height (Wave-1: no diving rings)
const RING_WEAPONS = Object.freeze([
  Object.freeze({ color: "#d18aff", speed: 9, range: 24, damage: 14, pierce: 0 }),
  Object.freeze({ color: "#d18aff", speed: 12, range: 24, damage: 14, pierce: 0 }),
]);
const RING_MARK = 4; // radius of the lavender ring telegraph under the Warden
const AIM_WIDTH = 0.085;
const BLAST = Object.freeze({ spacing: 2.8, radius: 2.3, damage: 25, fuse: 0.9 });
const COLLAPSE = Object.freeze({ spacing: 4, radius: 2.6, damage: 42, fuse: 1.5 });
const EXPOSED = 2.5;
const EXPOSED_VULN = CHALLENGE.quarryVulnerability; // the Maw's stagger and the Warden's windows
const NODE_REGROUP = 3; // cooldown once a node event resolves
const FIRST_NODE_DELAY = 4; // the first node event comes ~4 s after the enrage
const NODE_RETRY = 2; // no fair pair of sites visible: try again after this
const NODE_REACH = 30; // node sites must lie within this of the player
const NODE_SPREAD = 3; // minimum gap between the two nodes
const NODE_EYE = 1.47; // sight line from the player's chest...
const NODE_TOP = 1.3; // ...to the node's gem
// Two fixed flank offsets, then 12 points on a 6 m circle around the Warden.
const NODE_OFFSETS = Object.freeze([
  [-5, 3],
  [5, -3],
  ...Array.from({ length: 12 }, (_, i) => [Math.sin((i * Math.PI) / 6) * 6, Math.cos((i * Math.PI) / 6) * 6]),
]);
// F6 (KEEPERS): crown shards, the alive node phase, the crown ring and the shades.
const SHARDS = Object.freeze({ windup: 0.9, count: 6, deathCount: 8, radius: 1.8, damage: 20, drop: 0.3, height: 10, color: "#f0e6ff" });
const NODE_DRIFT = 0.6; // m/s while kneeling to the charging nodes
const KNEEL = Object.freeze({ body: -0.6, arms: -2.2 });
const SLUMP = -0.9;
const TETHER = Object.freeze({ color: "#e1ae74", width: 0.2, crown: 2.44 }); // crown height x model scale
const FINAL_CADENCE = 1.2; // cooldown factor once every shade has resolved
const CROWN = Object.freeze({ count: 5, radius: 3.5, height: 1.6, spin: 1.2, touch: 0.6, damage: 14, disc: 0.6, discColor: "#c7a4f0", bone: "#d0baa0" });
const CROWN_SPIKE = Object.freeze({ x: 0.3, y: 1.2, z: 0.3 }); // fallback spike size without parts.crown
const SHADE = Object.freeze({ rise: 0.4, fade: 0.4, steps: 6, exposed: 2.5, deathExposed: 1.8, reach: 12, gap: 6, retry: 1, stride: 0.6 });
const SHADE_ATTACKS = Object.freeze({ bellwether: "bellwether.toll", ironmaw: "ironmaw.charge", abbot: "abbot.fissure", castellan: "castellan.grid" });

// Keeper flow (F1.3, F1.6).
const KEEPER_ENTRY_COOLDOWN = 1.5;
const KEEPER_REST = 7; // spawn rest after a keeper falls
const KEEPER_BETWEEN = 14; // a keeper rises this far from the player toward the rift
const KEEPER_MIN_GAP = 10; // ...but never closer than this to the player
const BELL_BEYOND = 10; // the Bellwether rises this far beyond its bell
const PHASE_RING = Object.freeze({ size: 6, life: 1 });
const STALL = Object.freeze({ range: 30, wait: 12, sink: 0.4, rise: 0.6, depth: 2, back: 14, look: 0.25, eye: 1.3 });

// Readable causes for the run report (player-damage sources are { id, label }). The ids keep
// the original sources, so the report's hint lookup still finds the Bestiary tip.
const CAUSES = Object.freeze({
  mawTouch: Object.freeze({ id: "Iron Maw", label: "Iron Maw" }),
  mawCharge: Object.freeze({ id: "Iron Maw", label: "Iron Maw charge" }),
  rockfall: Object.freeze({ id: "ironmaw", label: "Maw rockfall" }),
  wardenTouch: Object.freeze({ id: "warden", label: "Rift Warden" }),
  wardenRing: Object.freeze({ id: "warden", label: "Warden ring" }),
  wardenBlast: Object.freeze({ id: "warden", label: "Warden blast" }),
  crownShard: Object.freeze({ id: "warden", label: "Crown shard" }),
  collapse: Object.freeze({ id: "warden-node", label: "Rift collapse" }),
});

// A player-damage source at a position (damage-direction wedges, F16.4).
const at = (cause, x, z) => ({ id: cause.id, label: cause.label, x, z });
const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
// "Shade of the Bellwether", "Shade of Iron Maw", ...: the keeper's name, mid-sentence.
const shadeLabel = (def) => `Shade of ${String(def?.name ?? "the Rift").replace(/^The /, "the ")}`;

// The Warden's node event: both nodes must fall before the deadline.
export class NodeCharge {
  constructor(ids) {
    this.ids = [...ids]; // in placement order, for the boss bar's pips
    this.nodes = new Set(ids);
    this.remaining = CHALLENGE.nodeDeadline;
    this.state = "charging";
  }
  destroy(id) {
    if (this.state === "charging") this.nodes.delete(id);
  }
  tick(dt) {
    if (this.state !== "charging") return this.state;
    if (!this.nodes.size) this.state = "interrupted";
    else if ((this.remaining -= dt) <= 0) this.state = "attack";
    return this.state;
  }
}

// ---- the keeper kit (IMPROVEMENTS F1.6) --------------------------------------------------------

// Keeper attacks by namespaced id ("bellwether.toll"): { windup, turn = 0.35, begin(actor, k,
// opts), tick(actor, dt, k) -> done, end(actor, k) }. Definitions are stateless and use only the
// k they are handed, so every context shares them; per-use state lives on actor.attack (the
// runner's record { id, t, opts, markers }). An attack touches only the actor contract
// { x, z, y, yaw, def, phase, lockYaw, shade, e? } and the k helpers, so a shade (a plain actor
// with shade: true) replays it exactly. Keeper files add theirs with k.attack.define.
export const ATTACKS = {};

// The keeper kit: shared helpers bound to ctx and always read through it at use time. bosses.js
// sets the scope (k.enter) before any keeper code runs: the scope's actor owns the telegraphs it
// makes and names the damage it deals (a shade's reads "Shade of ..."); its host (the enemy
// being updated) carries the effects that outlive an attack, such as a travelling toll wave.
//
//   k.ctx, k.run, k.player, k.fx                       live references
//   k.rng(), k.rand(a, b)                              the run's "ai" stream
//   k.ground(x, z), k.trace(a, b, r)                   world queries
//   k.distance(actor), k.yawToPlayer(actor)
//   k.speed(base)                                      base x Death Mode x speedScale()
//   k.walk(e, speed, dt, stopAt = 0)                   steer toward the player, stop inside stopAt
//   k.face(actor, dt, mult = 1)                        turn at def.turn x mult
//   k.contact(e, damage = def.damage, label = def.name)  touch damage (outside rest/stagger)
//   k.place(e, stride = 1)                             model transform + 15 fps animation
//   k.pick(e, table, d)                                pickAttack on the ai stream
//   k.gateDue(e), k.openGate(e), k.phase2(e, { color, size, toast })   phase gates (F1.6)
//   k.emit(e, event, extra), k.toast(text, priority = 2), k.stats()
//   k.attack.define(id, def) / start(actor, id, opts) / step(actor, dt) / stop(actor) / turn(actor)
//   k.effect(fx, { cap })                              fx = { kind, tick(dt) -> done, end() }
//   k.tele.{line, area, path, arc, band, cell, fissure, set, remove, keep, minStrip, minGuide}
//   k.hazard(x, z, r, dmg, fuse, kind, source, { friendlyFire, monsterDamage, shape, sx, sz, yaw })
//   k.explode(x, z, r, dmgPlayer, dmgMonsters, source, { friendlyFire })
//   k.zone(x, z, r, opts), k.shoot(actor, yaw, { speed, range, damage, color, pitch, y, label })
//   k.hurt(amount, source, x, z) -> the player.hurt result code
//   k.summon(kind, pos, { mark, bypassCap, hpScale }), k.chargePath(actor, speed, duration, stopAtCover)
//   k.chargeStep(body, ax, az, distance, radius, walls), k.sound(name, x, z, src, { volume, rate })
//   k.voice(actor, name), k.decor(object3d)
export function keeperKit(ctx) {
  const scope = { actor: null, host: null };
  const decorations = [];
  const heading = { x: 0, z: 0 },
    from = { x: 0, y: 0, z: 0 },
    to = { x: 0, y: 0, z: 0 },
    enemyRound = { color: HOSTILE_ROUND, speed: 0, range: 0, damage: 0, pierce: 0 };

  const run = () => ctx.run;
  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const terrain = () => ctx.world?.terrain ?? null;
  const idOf = (actor) => actor?.keeper ?? actor?.kind ?? null;
  const stream = () => run()?.stream?.("ai") ?? run()?.rng ?? Math.random;

  // Runs fn with `actor` as the scope's actor, restoring the previous one after.
  function as(actor, fn) {
    const prev = scope.actor;
    scope.actor = actor;
    try {
      return fn();
    } finally {
      scope.actor = prev;
    }
  }

  // A player-damage source named for the scope's actor: a string label, or { id, label, x, z }.
  // Everything a shade deals reads "Shade of {keeper}" (death causes, F6).
  function cause(source, x, z) {
    const actor = scope.actor,
      id = idOf(actor) ?? "keeper",
      object = source && typeof source === "object";
    const label = actor?.shade ? shadeLabel(actor.def) : object ? (source.label ?? String(source.id ?? id)) : String(source ?? actor?.def?.name ?? id);
    return { id: object ? (source.id ?? id) : id, label, x: object ? (source.x ?? x) : x, z: object ? (source.z ?? z) : z };
  }

  // ---- telegraphs, owned by the running attack (or the actor) -------------------------------

  function own(marker) {
    const actor = scope.actor;
    if (marker && actor) (actor.attack?.markers ?? (actor.markers ??= [])).push(marker);
    return marker ?? null;
  }
  const meta = (extra) => ({ owner: scope.actor?.id ?? null, started: run()?.elapsed ?? 0, targetsPlayer: true, ...extra });
  function keep(marker) {
    for (const bag of [scope.actor?.attack?.markers, scope.actor?.markers]) {
      const i = bag ? bag.indexOf(marker) : -1;
      if (i >= 0) bag.splice(i, 1);
    }
    return marker;
  }
  const tele = {
    line: (x, z, yaw, length, width, kind, m) => own(ctx.tele?.line?.(x, z, yaw, length, width, kind, meta(m))),
    area: (x, z, radius, kind, m) => own(ctx.tele?.area?.(x, z, radius, kind, meta(m))),
    path: (points, width, kind, m) => own(ctx.tele?.path?.(points, width, kind, meta(m))),
    arc: (x, z, yaw, radius, half, kind, m) => own(ctx.tele?.arc?.(x, z, yaw, radius, half, kind, meta(m))),
    band: (x, z, radius, half, kind, m) => own(ctx.tele?.band?.(x, z, radius, half, kind, meta(m))),
    cell: (x, z, half, kind, m) => own(ctx.tele?.cell?.(x, z, half, kind, meta(m))),
    fissure: (points, width, kind, m) => own(ctx.tele?.fissure?.(points, width, kind, meta(m))),
    set: (marker, opts) => (marker ? ctx.tele?.set?.(marker, opts) : null),
    remove: (marker) => marker && ctx.tele?.remove?.(marker),
    keep,
    minStrip: () => ctx.tele?.minStrip?.() ?? 0.3,
    minGuide: () => ctx.tele?.minGuide?.() ?? 0.4,
  };
  const dropMarkers = (list) => {
    if (!list) return;
    for (const marker of list) ctx.tele?.remove?.(marker);
    list.length = 0;
  };

  // ---- attacks ------------------------------------------------------------------------------

  const attack = {
    define(id, def) {
      ATTACKS[id] = def;
    },
    // Begins ATTACKS[id] on the actor (ending any it was running). False when unregistered.
    start(actor, id, opts = {}) {
      const def = ATTACKS[id];
      if (!def || !actor) return false;
      attack.stop(actor);
      actor.lockYaw = actor.yaw;
      actor.attack = { id, def, t: 0, opts, markers: [] };
      as(actor, () => def.begin?.(actor, k, opts));
      return true;
    },
    // Advances the actor's attack; true once it has finished (or none is running).
    step(actor, dt) {
      const a = actor?.attack;
      if (!a) return true;
      a.t += dt;
      const done = !!as(actor, () => a.def.tick(actor, dt, k));
      if (done && actor.attack === a) attack.stop(actor);
      return done;
    },
    stop(actor) {
      const a = actor?.attack;
      if (!a) return;
      actor.attack = null;
      as(actor, () => a.def.end?.(actor, k));
      dropMarkers(a.markers);
    },
    // Turn-rate multiplier: the attack's `turn` (0.35 by default, 0 locked) during its windup,
    // locked after it; 1 with no attack.
    turn(actor) {
      const a = actor?.attack;
      if (!a) return 1;
      return a.t < (a.def.windup ?? 0) ? (a.def.turn ?? 0.35) : 0;
    },
  };

  // ---- effects that outlive an attack, carried and ticked by the host keeper ----------------

  function effect(fx, { cap = 0 } = {}) {
    const host = scope.host;
    if (!host || !fx) return null;
    const list = (host.effects ??= []);
    if (cap > 0) {
      const same = list.filter((other) => !other.done && other.kind === fx.kind);
      for (let i = 0; i <= same.length - cap; i++) finish(same[i]);
    }
    fx.actor = scope.actor;
    fx.done = false;
    list.push(fx);
    return fx;
  }
  function finish(fx) {
    if (fx.done) return;
    fx.done = true;
    as(fx.actor, () => fx.end?.());
  }
  // Once per simulation step, before the host's AI.
  function tickEffects(host, dt) {
    const list = host?.effects;
    if (!list?.length) return;
    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      if (!fx.done && as(fx.actor, () => fx.tick(dt))) finish(fx);
    }
    let kept = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].done) list[kept++] = list[i];
    list.length = kept;
  }
  function endEffects(host) {
    const list = host?.effects;
    if (!list) return;
    for (const fx of list) finish(fx);
    list.length = 0;
  }

  // ---- charges (F3): the Wave-1 lane rules plus the quarry-wall rule ------------------------

  // Only solid covers (walls, statues, landmark stones) count as an impact.
  function coverAhead(pos, dx, dz, radius) {
    from.x = pos.x;
    from.z = pos.z;
    from.y = to.y = ground(pos.x, pos.z) + 1;
    to.x = pos.x + dx;
    to.z = pos.z + dz;
    return ctx.world?.traceCovers?.(from, to, radius * MAW_COVER_PROBE)?.kind === "structure";
  }
  const chargeWorld = {
    coverAhead,
    canMove: (x, z, nx, nz, r) => terrain()?.canMove?.(x, z, nx, nz, r) ?? false,
    move: (body, dx, dz, r) => terrain()?.move?.(body, dx, dz, r),
    height: ground,
  };

  // ---- the kit -------------------------------------------------------------------------------

  function distance(actor) {
    const p = run()?.player;
    return p ? Math.hypot(p.x - actor.x, p.z - actor.z) : Infinity;
  }
  const yawToPlayer = (actor) => {
    const p = run()?.player;
    return p ? yawTo(actor, p) : actor.yaw;
  };

  function hurt(amount, source, x, z) {
    return ctx.player?.hurt?.(amount, cause(source, x, z)) ?? "none";
  }

  // Monsters caught by a keeper blast with friendly fire (explode): environment damage, never
  // to keepers or bosses, blocked by terrain and cover like the player's.
  function blastMonsters(x, z, r, damage) {
    const list = run()?.enemies;
    if (!list) return;
    from.x = x;
    from.z = z;
    from.y = ground(x, z) + 1;
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (!(e.hp > 0) || e.dead || e.fixed || e.untargetable || e.keeper || e.boss || e.miniboss) continue;
      if (Math.hypot(e.x - x, e.z - z) >= r + (e.def?.radius ?? e.radius ?? 0.5)) continue;
      to.x = e.x;
      to.z = e.z;
      to.y = ground(e.x, e.z) + 1;
      if (ctx.world?.trace?.(from, to, 0)) continue;
      ctx.combat?.hurtEnemy?.(e, damage, false, { environment: true, weapon: -1, kind: "keeper", blast: { x, z } });
    }
  }

  const k = {
    get ctx() {
      return ctx;
    },
    get run() {
      return run();
    },
    get player() {
      return run()?.player ?? null;
    },
    get fx() {
      return ctx.fx;
    },
    get actor() {
      return scope.actor;
    },
    // Scope for the keeper code about to run (bosses.js only).
    enter(actor, host = actor) {
      scope.actor = actor;
      scope.host = host;
      return k;
    },
    rng: () => stream()(),
    rand: (a = 0, b = 1) => a + stream()() * (b - a),
    ground,
    trace: (a, b, r) => ctx.world?.trace?.(a, b, r) ?? null,
    distance,
    yawToPlayer,
    speed: (base) => base * (run()?.tuning?.speed ?? 1) * (ctx.director?.speedScale?.() ?? 1),
    walk(e, speed, dt, stopAt = 0) {
      const p = run()?.player,
        t = terrain();
      if (!p || !t) return false;
      const d = Math.hypot(p.x - e.x, p.z - e.z);
      if (d <= stopAt) return false;
      const v = t.steer(e.x, e.z, p.x, p.z, e, heading),
        step = speed * dt * (d > DIRECT_RANGE ? CHASE_PACE : 1);
      t.move(e, v.x * step, v.z * step, e.def.radius);
      return true;
    },
    face: (actor, dt, mult = 1) => turnToward(actor, yawToPlayer(actor), (actor.def?.turn ?? 0) * mult, dt),
    contact(e, damage = e.def.damage, label = e.def.name) {
      return distance(e) < e.def.radius + CONTACT_REACH ? as(e, () => hurt(damage, label, e.x, e.z)) : null;
    },
    place(e, stride = 1) {
      const g = e.model?.g;
      if (!g) return;
      g.position.set(e.x, ground(e.x, e.z) + (e.y || 0), e.z);
      g.rotation.y = e.yaw;
      animateCharacter(e.model, run()?.elapsed ?? 0, stride);
    },
    pick: (e, table, d) => pickAttack(e, table, d, stream()),
    gateDue,
    openGate,
    // Phase 2 at the 0.5 gate (F1.6): ring, toast, bus "phase" and the phase sound; no cinematic.
    phase2(e, { color = e.def.color, size = PHASE_RING.size, toast } = {}) {
      e.phase = 2;
      openGate(e);
      const fight = run()?.keeper;
      if (fight?.e === e) fight.phase = 2;
      ctx.fx?.ring?.(e.x, e.z, color, size, PHASE_RING.life);
      if (toast) k.toast(toast, 3);
      k.emit(e, "phase");
      k.sound("phase", e.x, e.z, "phase");
    },
    emit: (e, event, extra = {}) => ctx.bus.emit("boss", { kind: idOf(e), event, e, ...extra }),
    toast: (text, priority = 2) => ctx.hud?.toast?.(text, { priority }),
    // The live fight's record book (run.keeper.stats) while the scope's actor is that keeper.
    stats() {
      const fight = run()?.keeper;
      return fight && scope.actor && fight.e === scope.actor ? fight.stats : null;
    },
    attack,
    effect,
    tickEffects,
    endEffects,
    tele,
    dropMarkers,
    hazard(x, z, r, dmg, fuse, kind, source, opts = {}) {
      const { friendlyFire = false, monsterDamage, ...shape } = opts;
      return (
        ctx.combat?.hazard?.(x, z, r, dmg, fuse, kind, null, {
          source: cause(source, x, z),
          eta: fuse,
          friendlyFire,
          monsterDamage: monsterDamage ?? dmg,
          immune: [idOf(scope.actor)],
          ...shape,
        }) ?? null
      );
    },
    explode(x, z, r, dmgPlayer, dmgMonsters, source, { friendlyFire = false } = {}) {
      ctx.combat?.explode?.(x, z, r, dmgPlayer, true, undefined, { source: cause(source, x, z) });
      if (friendlyFire && dmgMonsters > 0) blastMonsters(x, z, r, dmgMonsters);
    },
    zone(x, z, r, opts = {}) {
      const source = opts.source ? cause(opts.source, x, z) : undefined;
      return ctx.combat?.zone?.(x, z, r, { owner: idOf(scope.actor), ...opts, ...(source ? { source } : {}) }) ?? null;
    },
    shoot(actor, yaw, { speed, range, damage, color = HOSTILE_ROUND, pitch = 0, y = 1.2, label } = {}) {
      enemyRound.color = color;
      enemyRound.speed = speed;
      enemyRound.range = range;
      enemyRound.damage = damage;
      return (
        ctx.combat?.projectile?.(actor.x, actor.z, yaw, enemyRound, true, {
          emitter: actor.shade ? null : actor,
          source: as(actor, () => cause(label ?? actor.def?.name, actor.x, actor.z)),
          pitch,
          y: ground(actor.x, actor.z) + y,
          speed,
          range,
          damage,
          color,
        }) ?? null
      );
    },
    hurt,
    summon(kind, pos, { mark, bypassCap = false, hpScale } = {}) {
      if ((ctx.enemies?.live?.() ?? 0) >= MAX_HOSTILES) return null;
      const summoner = idOf(scope.actor);
      const e = ctx.enemies?.spawn?.(kind, pos, { summonedBy: summoner, mark, bypassCap, ...(hpScale ? { hpScale } : {}) }) ?? null;
      if (e) e.summonedBy ??= summoner;
      return e;
    },
    // The lane a charge from (x, z) along (ax, az) will take: the same steps as the charge, so it
    // bends and ends where the charge will. `walls` adds the quarry-wall rule to the Wave-1 rule.
    chargeLane: (x, z, ax, az, speed, duration, radius, walls = true) => simulateCharge(x, z, ax, az, speed, duration, radius, chargeWorld, walls).points,
    // The lane of a charge along actor.lockYaw; stopAtCover false keeps the Wave-1 cover-only rule.
    chargePath: (actor, speed, duration, stopAtCover = true) => {
      const yaw = actor.lockYaw ?? actor.yaw;
      return k.chargeLane(actor.x, actor.z, Math.sin(yaw), Math.cos(yaw), speed, duration, actor.def.radius, stopAtCover);
    },
    chargeStep: (body, ax, az, dist, radius, walls = true) => chargeStep(body, ax, az, dist, radius, chargeWorld, walls),
    // A shade's cues play at 0.7 gain through the echo send (F6).
    sound(name, x, z, src, { volume = 1, rate } = {}) {
      const shade = !!scope.actor?.shade;
      ctx.audio?.fx?.(name, volume * (shade ? 0.7 : 1), { x, z, src: src ?? idOf(scope.actor), rate, echo: shade || undefined });
    },
    voice: (actor, name) => ctx.audio?.voice?.(actor, name),
    // Leaves a model part in the world as decor until the stage ends (a fallen bell, a shield).
    decor(object) {
      const layer = ctx.gfx?.layers?.world;
      if (!object || !layer) return null;
      layer.attach(object);
      decorations.push(object);
      return object;
    },
    clearDecor() {
      for (const object of decorations) object.removeFromParent();
      decorations.length = 0;
    },
  };
  return k;
}

// The shade-safe Iron Maw charge (F3, replayed by the Warden's shade): one telegraphed charge
// along the yaw locked at windup start, stopping at cover or a quarry wall. It never staggers
// and drops no rocks; contact 30 while it runs.
ATTACKS["ironmaw.charge"] = Object.freeze({
  windup: CHALLENGE.quarryWindup,
  turn: 0,
  begin(actor, k) {
    const a = actor.attack;
    actor.lockYaw = actor.yaw = k.yawToPlayer(actor);
    a.speed = k.speed(CHALLENGE.quarrySpeed);
    a.marker = k.tele.path(k.chargePath(actor, a.speed, CHALLENGE.quarryCharge), actor.def.radius, "charge", { eta: CHALLENGE.quarryWindup });
    k.sound("warnCharge", actor.x, actor.z, "warnCharge");
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      windup = CHALLENGE.quarryWindup;
    if (a.t < windup) {
      k.tele.set(a.marker, { progress: a.t / windup });
      return false;
    }
    if (!a.rushing) {
      a.rushing = true;
      k.tele.set(a.marker, { opacity: 0.3, progress: 1 });
      k.sound("charge", actor.x, actor.z, "charge");
    }
    const ax = Math.sin(actor.lockYaw),
      az = Math.cos(actor.lockYaw),
      stopped = !!k.chargeStep(actor, ax, az, a.speed * dt, actor.def.radius, true);
    if (k.distance(actor) < actor.def.radius + PLAYER_REACH) k.hurt(SHADE_CHARGE_CONTACT, actor.def.name, actor.x, actor.z);
    return stopped || a.t >= windup + CHALLENGE.quarryCharge;
  },
});

export function createBosses(ctx) {
  const kit = keeperKit(ctx);
  // Keeper AI records by keeper id: { update(e, dt), onSpawn(e), onDeath(e), label(e) } plus
  // optional onBlocked(e, shot) and stagger(e, seconds).
  const keeperAI = {
    bellwether: registerBellwether(kit),
    abbot: registerAbbot(kit),
    castellan: registerCastellan(kit),
  };

  // Scratch objects reused every step (traces, steering, telegraph updates, instance matrices).
  const from = { x: 0, y: 0, z: 0 },
    to = { x: 0, y: 0, z: 0 },
    heading = { x: 0, z: 0 },
    bearing = { x: 0, z: 0 },
    spot = { x: 0, z: 0 },
    countdown = { progress: 0 },
    rushing = Object.freeze({ opacity: 0.3, progress: 1 });

  const height = (x, z) => ctx.world?.height(x, z) ?? 0;
  const curse = (run) => 1 + (run.difficultyBonus || 0) / 100;
  const pace = (run) => (run.tuning?.speed ?? 1) * curse(run);
  const toast = (text, priority) => ctx.hud?.toast?.(text, priority === undefined ? undefined : { priority });
  const isWarden = (e) => e?.boss === "warden";
  const isMaw = (e) => !!e && (e.boss === "ironmaw" || !!e.miniboss);
  const alive = (e) => !!e && e.hp > 0 && !e.dead;
  const stepping = (run) => ctx.run === run && !run.over && (ctx.mode === "play" || (run.demo && !ctx.demo?.finished));

  function clearMarker(e) {
    if (!e.marker) return;
    ctx.tele?.remove?.(e.marker);
    e.marker = null;
  }

  function showCountdown(e, timer, duration) {
    if (!e.marker) return;
    countdown.progress = 1 - timer / duration;
    ctx.tele?.set?.(e.marker, countdown);
  }

  // A boss arrival takes every monster off the field at once (no death collapse, no kill).
  function clearField(run) {
    const gone = run.enemies ? run.enemies.slice() : [];
    ctx.enemies?.clear?.();
    for (const e of gone) e.hp = 0;
  }

  function place(e, yaw) {
    e.yaw = yaw;
    const g = e.model?.g;
    if (!g) return;
    g.position.set(e.x, height(e.x, e.z), e.z);
    g.rotation.y = yaw;
  }

  function walk(e, run, speed, dt) {
    const p = run.player,
      terrain = ctx.world.terrain,
      v = terrain.steer(e.x, e.z, p.x, p.z, e, heading),
      step = speed * dt * (Math.hypot(p.x - e.x, p.z - e.z) > DIRECT_RANGE ? CHASE_PACE : 1);
    terrain.move(e, v.x * step, v.z * step, e.def.radius);
  }

  // Delayed blasts name a readable cause (with its position) for the run report.
  function hazard(x, z, spec, kind, cause) {
    return ctx.combat?.hazard?.(x, z, spec.radius, spec.damage, spec.fuse, kind, null, { source: at(cause, x, z), eta: spec.fuse }) ?? null;
  }

  // Wave-1 telegraph metadata for the threat registry (F16.2).
  const meta = (e, eta) => ({ owner: e.id, eta, started: ctx.run?.elapsed ?? 0, targetsPlayer: true });

  // ---- Iron Maw (ORIGINAL: the Wave-1 fight) ----------------------------------------------

  // Stage 2's kill goal: the portal waits behind Iron Maw (flow.md §9.5).
  function startQuarry() {
    const run = ctx.run;
    if (!run || (run.quarryState !== "dormant" && run.quarryState !== "waiting")) return null;
    if (run.trial?.state === "active") {
      run.quarryState = "waiting";
      toast("IRON MAW AWAITS · COMPLETE OR ABANDON TRIAL IN PAUSE");
      return null;
    }
    clearField(run);
    const maw = ctx.enemies?.spawn?.("ironmaw", MAW_ORIGIN);
    // Without a Maw the gate stays shut; the next kill retries rather than soft-locking stage 2.
    if (!maw) return null;
    run.quarryState = "active";
    (run.flags ??= {}).mawUntouched = true;
    maw.hp = maw.max = CHALLENGE.quarryHP * curse(run);
    maw.cooldown = MAW_ENTRY_COOLDOWN;
    maw.state = "approach";
    maw.timer = 0;
    run.player.inv = Math.max(run.player.inv, ARRIVAL_GRACE);
    toast("IRON MAW · BAIT ITS CHARGE INTO SOLID COVER");
    ctx.bus.emit("boss", { kind: "ironmaw", event: "spawn", e: maw });
    ctx.profile?.recordEnemy?.("ironmaw"); // sighting at spawn (F3), not as the charger it is built on
    ctx.director?.beginSequence?.("maw", maw);
    return maw;
  }

  function mawUpdate(e, run, dt) {
    const p = run.player,
      dx = p.x - e.x,
      dz = p.z - e.z,
      d = Math.max(1e-4, Math.hypot(dx, dz));
    if (e.state === "stagger") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.state = "approach";
        e.cooldown = MAW_REGROUP;
        e.vuln = 1;
      }
    } else if (e.state === "windup") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.state = "charge";
        e.timer = CHALLENGE.quarryCharge;
        e.dust = 0;
        if (e.marker) ctx.tele?.set?.(e.marker, rushing);
        ctx.audio?.fx?.("charge", 1, e); // the charge itself is heard (F3, spec quirk 10)
      } else showCountdown(e, e.timer, CHALLENGE.quarryWindup);
    } else if (e.state === "charge") originalRush(e, run, dt);
    else if (e.cooldown <= 0 && d < MAW_REACH) beginWindup(e, run, dx / d, dz / d);
    else walk(e, run, IRON_MAW.speed * pace(run), dt);

    // Contact uses the distance measured before this step's movement (original).
    if (d < e.def.radius + CONTACT_REACH) {
      const charging = e.state === "charge";
      ctx.player?.hurt?.(charging ? IRON_MAW.chargeDamage : IRON_MAW.damage, at(charging ? CAUSES.mawCharge : CAUSES.mawTouch, e.x, e.z));
    }
    const committed = e.state === "windup" || e.state === "charge";
    place(e, committed ? Math.atan2(e.ax, e.az) : Math.atan2(dx, dz));
    animateCharacter(e.model, run.elapsed, e.state === "stagger" ? 0 : 1);
  }

  // Windup: the Maw stands still behind a corridor that already stops at the first cover.
  function beginWindup(e, run, nx, nz) {
    e.state = "windup";
    e.timer = CHALLENGE.quarryWindup;
    e.ax = nx;
    e.az = nz;
    clearMarker(e);
    const lane = kit.chargeLane(e.x, e.z, nx, nz, CHALLENGE.quarrySpeed * pace(run), CHALLENGE.quarryCharge, e.def.radius, false);
    e.marker = ctx.tele?.path?.(lane, e.def.radius, "charge", meta(e, CHALLENGE.quarryWindup)) ?? null;
    ctx.audio?.fx?.("warnCharge", 1, e);
  }

  // One Wave-1 charge step: only solid cover stops it (and staggers).
  function originalRush(e, run, dt) {
    dustTrail(e, dt);
    if (kit.chargeStep(e, e.ax, e.az, CHALLENGE.quarrySpeed * pace(run) * dt, e.def.radius, false)) {
      mawStagger(e, CHALLENGE.quarryStagger);
      return;
    }
    e.timer -= dt;
    if (e.timer <= 0) {
      e.state = "approach";
      e.cooldown = MAW_RECOVER;
      clearMarker(e);
    }
  }

  // Dust kicked up along a charge, every 0.05 s (F3, cosmetic).
  function dustTrail(e, dt) {
    e.dust = (e.dust ?? 0) - dt;
    if (e.dust > 0) return;
    e.dust += MAW_DUST.every;
    ctx.fx?.burst?.(e.x, 0.3, e.z, MAW_DUST.color, MAW_DUST.count, MAW_DUST.speed);
  }

  function mawStagger(e, seconds, extra = {}) {
    e.state = "stagger";
    e.timer = seconds;
    e.vuln = EXPOSED_VULN;
    ctx.audio?.voice?.(e, "impactStone");
    clearMarker(e);
    ctx.fx?.ring?.(e.x, e.z, MAW_STAGGER_RING, 3, 0.5);
    toast("IRON MAW STAGGERED");
    ctx.bus.emit("boss", { kind: "ironmaw", event: "stagger", e, ...extra });
  }

  // Kill processing continues after this (score, gem, powerup roll, portal check).
  function mawDefeated(e, run) {
    (run.flags ??= {}).mawDefeated = true;
    run.pacing?.recover?.(MAW_REST);
    run.quarryState = "defeated";
    ctx.bus.emit("boss", { kind: "ironmaw", event: "defeat", e });
    // The major mod reward is the real gate: choosing it opens the stage-2 portal.
    ctx.progression?.queue?.("quarry", "major", () => {
      if (ctx.run !== run) return;
      run.quarryState = "rewarded";
      ctx.director?.activatePortal?.();
    });
  }

  // ---- Iron Maw (KEEPERS, F3): skid, quarry walls, rockfall and the rage phase ------------

  const mawAI = {
    onSpawn(e) {
      e.second = false;
      e.raging = false;
      e.dust = 0;
      (ctx.run.flags ??= {}).mawUntouched = true;
    },
    update: mawKeeperUpdate,
    onDeath() {
      (ctx.run.flags ??= {}).mawDefeated = true;
    },
    label: (e) => (e.state === "stagger" ? "IRON MAW · STAGGERED" : e.raging ? "IRON MAW · RAGING" : "IRON MAW"),
  };

  const mawSpeed = (e) => kit.speed(e.raging ? MAW_RAGE.speed : IRON_MAW.speed);
  const chargeSpeed = () => kit.speed(CHALLENGE.quarrySpeed);

  function mawKeeperUpdate(e, dt) {
    const run = ctx.run,
      p = run.player,
      dx = p.x - e.x,
      dz = p.z - e.z,
      d = Math.max(1e-4, Math.hypot(dx, dz)),
      charging = e.state === "charge";
    if (e.state === "stagger") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.state = "approach";
        e.cooldown = MAW_REGROUP;
        e.vuln = 1;
      }
    } else if (e.state === "windup" || e.state === "reaim") {
      e.timer -= dt;
      if (e.timer <= 0) beginRush(e);
      else showCountdown(e, e.timer, e.windup);
    } else if (charging) keeperRush(e, run, dt);
    else if (e.state === "skid") skid(e, run, dt);
    else {
      if (!e.raging && gateDue(e) !== null) rage(e, run);
      if (e.cooldown < 0 && d < MAW_REACH) mawWindup(e, dx / d, dz / d, "windup");
      else {
        kit.face(e, dt);
        kit.walk(e, mawSpeed(e), dt);
      }
    }
    // Contact uses the distance measured before this step's movement; a stagger holds it.
    if (e.state !== "stagger" && d < e.def.radius + CONTACT_REACH)
      ctx.player?.hurt?.(charging ? IRON_MAW.chargeDamage : IRON_MAW.damage, at(charging ? CAUSES.mawCharge : CAUSES.mawTouch, e.x, e.z));
    if (e.state !== "approach" && e.state !== "stagger") e.yaw = Math.atan2(e.ax, e.az);
    kit.place(e, e.state === "stagger" ? 0 : 1);
  }

  // The first windup (1.05 s) or the rage re-aim (0.45 s), both with the yaw locked at start.
  function mawWindup(e, nx, nz, kind) {
    const reaim = kind === "reaim";
    e.state = kind;
    e.windup = e.timer = reaim ? MAW_REAIM : CHALLENGE.quarryWindup;
    e.rush = reaim ? MAW_SECOND_CHARGE : CHALLENGE.quarryCharge;
    e.ax = nx;
    e.az = nz;
    e.yaw = Math.atan2(nx, nz);
    clearMarker(e);
    e.marker = ctx.tele?.path?.(kit.chargeLane(e.x, e.z, nx, nz, chargeSpeed(), e.rush, e.def.radius, true), e.def.radius, "charge", meta(e, e.windup)) ?? null;
    ctx.audio?.fx?.("warnCharge", 1, e);
  }

  function beginRush(e) {
    e.state = "charge";
    e.timer = e.rush;
    e.dust = 0;
    if (e.marker) ctx.tele?.set?.(e.marker, rushing);
    ctx.audio?.fx?.("charge", 1, e);
  }

  // A charge step into cover or a quarry wall staggers and brings the rocks down.
  function keeperRush(e, run, dt) {
    dustTrail(e, dt);
    const impact = kit.chargeStep(e, e.ax, e.az, chargeSpeed() * dt, e.def.radius, true);
    if (impact) {
      e.second = false;
      mawStagger(e, e.raging ? MAW_RAGE.stagger : CHALLENGE.quarryStagger, { cause: impact });
      rockfall(e);
      return;
    }
    e.timer -= dt;
    if (e.timer > 0) return;
    e.state = "skid";
    e.timer = MAW_SKID;
    clearMarker(e);
    ctx.fx?.ring?.(e.x, e.z, MAW_DUST.color, MAW_DUST.ring, 0.4);
    ctx.audio?.fx?.("skid", 1, e);
  }

  // A missed charge decelerates for 0.35 s and never staggers; raging (or in Death Mode) it
  // then re-aims once at the player for a second, shorter charge.
  function skid(e, run, dt) {
    const v = chargeSpeed() * Math.max(0, 1 - (MAW_SKID - e.timer) / MAW_SKID);
    ctx.world.terrain.move(e, e.ax * v * dt, e.az * v * dt, e.def.radius);
    e.timer -= dt;
    if (e.timer > 0) return;
    if (mawAfterSkid({ rage: e.raging, death: run.death, second: e.second }) === "reaim") {
      const p = run.player,
        d = Math.max(1e-4, Math.hypot(p.x - e.x, p.z - e.z));
      e.second = true;
      mawWindup(e, (p.x - e.x) / d, (p.z - e.z) / d, "reaim");
      return;
    }
    e.second = false;
    e.state = "approach";
    e.cooldown = MAW_RECOVER;
  }

  // The 50% gate: Iron Maw rages (faster walk, double charges, longer staggers).
  function rage(e, run) {
    e.raging = true;
    e.phase = 2;
    openGate(e);
    if (run.keeper?.e === e) run.keeper.phase = 2;
    ctx.fx?.ring?.(e.x, e.z, MAW_RAGE.ring, MAW_RAGE.size, PHASE_RING.life);
    toast("IRON MAW RAGES · IT CHARGES TWICE", 3);
    setTint(e.model, MAW_RAGE.tint, MAW_RAGE.amount);
    kit.emit(e, "phase");
    kit.emit(e, "rage");
    ctx.audio?.fx?.("phase", 1, e);
  }

  // Four boulders around the impact (F3d): 20 to the player and 60 to other monsters; a boulder
  // that catches the staggered Maw crushes it for 80 environment damage (x1.5 while staggered).
  function rockfall(e) {
    const drops = rockfallPoints(e.x, e.z, kit.rng).map((pt) => ({
      x: pt.x,
      z: pt.z,
      h: kit.hazard(pt.x, pt.z, ROCKFALL.radius, ROCKFALL.damage, ROCKFALL.fuse, "rockfall", CAUSES.rockfall, { friendlyFire: true, monsterDamage: ROCKFALL.monsters }),
      fell: false,
    }));
    kit.effect({
      kind: "rockfall",
      tick(dt) {
        let landed = true;
        for (const drop of drops) if (!landRock(e, drop, dt)) landed = false;
        return landed;
      },
      // The Maw is gone: rocks already on their way still come down on time.
      end() {
        for (const drop of drops) if (!drop.fell && pending(drop.h)) dropRock(drop, drop.h.life);
      },
    });
  }

  const pending = (h) => !!h && h.life > 0 && !!ctx.run?.hazards?.includes(h);

  function dropRock(drop, seconds) {
    drop.fell = true;
    ctx.fx?.fall?.(drop.x, drop.z, "boulder", ROCKFALL.color, ROCKFALL.height, seconds);
  }

  // True once the drop has landed (or its hazard was cleared). Runs before combat's hazard pass,
  // so a fuse at or below one step detonates later in this same step.
  function landRock(e, drop, dt) {
    const h = drop.h;
    if (!pending(h)) return true;
    if (!drop.fell && h.life <= ROCKFALL.drop) dropRock(drop, h.life);
    if (h.life > dt + 1e-9) return false;
    ctx.cam?.shake?.(ROCKFALL.shake);
    if (e.state === "stagger" && alive(e) && Math.hypot(e.x - drop.x, e.z - drop.z) < h.radius + e.def.radius) {
      ctx.combat?.hurtEnemy?.(e, ROCKFALL.crush, false, { environment: true, weapon: -1, kind: "rockfall", blast: { x: drop.x, z: drop.z } });
      ctx.fx?.label?.(e.x, height(e.x, e.z) + 3, e.z, RUBBLE.text, RUBBLE.color);
    }
    return true;
  }

  // ---- Rift Warden (ORIGINAL: the Wave-1 fight) --------------------------------------------

  // Stage 5's kill goal summons the Warden in place of a portal (flow.md §9.6). Under KEEPERS
  // the director calls this once the Crown Dais is climbed (or in the demo), and it raises the
  // KEEPERS Warden instead.
  function summonWarden() {
    const run = ctx.run;
    if (run && !run.original) return startKeeper("warden") ? run.keeper.e : null;
    if (!run || run.bossSpawned || (ctx.mode !== "play" && !run.demo)) return null;
    run.bossSpawned = true;
    clearField(run);
    ctx.combat?.clear?.();
    const boss = ctx.enemies?.spawn?.("warden");
    if (!boss) return null;
    Object.assign(boss, wardenFields(), { boss: "warden", cooldown: WARDEN_ENTRY_COOLDOWN, state: "approach", timer: 0 });
    run.player.inv = Math.max(run.player.inv, ARRIVAL_GRACE);
    ctx.bus.emit("boss", { kind: "warden", event: "spawn", e: boss });
    ctx.director?.beginSequence?.("warden", boss);
    toast("THE RIFT WARDEN · FINAL ENCOUNTER");
    ctx.audio?.fx?.("level");
    return boss;
  }

  const wardenFields = () => ({ attackIndex: 0, enraged: false, recovery: 0, windup: 0, nodeEvents: 0, nodeCooldown: null, nodeCharge: null });

  function wardenUpdate(e, run, dt) {
    // Node charges and exposure freeze the Warden completely (no move, attack, contact, pose).
    if (nodeEvent(e, run, dt)) return;
    const p = run.player,
      dx = p.x - e.x,
      dz = p.z - e.z,
      d = Math.max(1e-4, Math.hypot(dx, dz));
    if (!e.enraged && e.hp < e.max * 0.5 && enrage(e)) return;
    if (e.state === "bossWindup") {
      e.timer -= dt;
      if (e.timer <= 0) wardenAttack(e);
      else showCountdown(e, e.timer, e.windup);
    } else {
      if (d > WARDEN_REACH) walk(e, run, e.def.speed * pace(run), dt);
      if (e.cooldown <= 0) beginWardenWindup(e, run, dx / d, dz / d, d);
    }
    if (d < e.def.radius + CONTACT_REACH) ctx.player?.hurt?.(e.def.damage, at(CAUSES.wardenTouch, e.x, e.z));
    place(e, Math.atan2(dx, dz));
    animateCharacter(e.model, run.elapsed, WARDEN_STRIDE);
  }

  // Phase 2 below half health, once. Returns true when the "phase" cinematic took over.
  function enrage(e) {
    e.enraged = true;
    setTint(e.model, WARDEN_TINT, 1);
    toast("WARDEN ENRAGED · KEEP MOVING");
    ctx.fx?.ring?.(e.x, e.z, "#ff7979", 6, 1);
    ctx.bus.emit("boss", { kind: "warden", event: "phase", e });
    return ctx.director?.beginSequence?.("phase", e) === true;
  }

  // Alternates a lavender ring under itself (even) and an aim line to the player (odd).
  function beginWardenWindup(e, run, nx, nz, d) {
    beginStrike(e, run, e.attackIndex % 2 === 0 ? "ring" : "blast", nx, nz, d, WARDEN_WINDUP[e.enraged ? 1 : 0]);
  }

  function beginStrike(e, run, kind, nx, nz, d, windup) {
    const p = run.player;
    e.state = "bossWindup";
    e.strike = kind;
    e.windup = e.timer = windup;
    e.tx = p.x;
    e.tz = p.z;
    e.ax = nx;
    e.az = nz;
    clearMarker(e);
    if (kind === "ring") {
      e.marker = ctx.tele?.area?.(e.x, e.z, RING_MARK, "warden-ring", meta(e, windup)) ?? null;
      ctx.audio?.fx?.("warnRing", 1, e);
    } else if (kind === "blast") {
      e.marker = ctx.tele?.line?.(e.x, e.z, Math.atan2(nx, nz), d, AIM_WIDTH, "aim", meta(e, windup)) ?? null;
      ctx.audio?.fx?.("warnAim", 1, e);
    } else castShards(e, run);
  }

  function wardenAttack(e) {
    if (e.attackIndex % 2 === 0) fireRing(e);
    else for (let i = -1; i <= 1; i++) hazard(e.tx + i * BLAST.spacing, e.tz, BLAST, "warden", CAUSES.wardenBlast);
    e.attackIndex++;
    e.state = "approach";
    e.cooldown = WARDEN_COOLDOWN[e.enraged ? 1 : 0];
    clearMarker(e);
  }

  function fireRing(e) {
    const weapon = RING_WEAPONS[e.enraged ? 1 : 0],
      shot = { emitter: e, source: at(CAUSES.wardenRing, e.x, e.z), y: height(e.x, e.z) + RING_HEIGHT, pitch: 0 };
    for (let i = 0; i < RING_SHOTS; i++) ctx.combat?.projectile?.(e.x, e.z, (i * Math.PI * 2) / RING_SHOTS, weapon, true, shot);
  }

  // updateNodeEvent (enemies.md §10.4). True while the Warden must stay frozen.
  function nodeEvent(e, run, dt) {
    if (e.recovery > 0) {
      e.recovery -= dt;
      if (!(e.recovery > 0)) e.vuln = 1;
      return true;
    }
    if (e.nodeCharge) {
      const result = e.nodeCharge.tick(dt);
      if (result !== "charging") resolveNodes(e, run, result);
      return true;
    }
    if (!e.enraged) return false;
    return nodeDue(e, run, dt) && openNodes(e, run);
  }

  // The Wave-1 rules for when a node event may start (about 4 s after the enrage, no live
  // hazards, 15 s between events, three at most).
  function nodeDue(e, run, dt) {
    e.nodeCooldown = (e.nodeCooldown ?? FIRST_NODE_DELAY) - dt;
    return !(e.nodeCooldown > 0 || (e.nodeEvents || 0) >= CHALLENGE.nodeEvents || e.state !== "approach" || run.hazards?.length);
  }

  // Two nodes the player can see and reach; otherwise normal attacks continue and it retries.
  function openNodes(e, run) {
    const p = run.player,
      terrain = ctx.world.terrain,
      sites = [];
    from.x = p.x;
    from.y = height(p.x, p.z) + NODE_EYE;
    from.z = p.z;
    for (const [ox, oz] of NODE_OFFSETS) {
      const site = terrain.safeNear(e.x + ox, e.z + oz, 1);
      if (Math.hypot(site.x - p.x, site.z - p.z) > NODE_REACH) continue;
      if (sites.some((s) => Math.hypot(s.x - site.x, s.z - site.z) < NODE_SPREAD)) continue;
      to.x = site.x;
      to.y = height(site.x, site.z) + NODE_TOP;
      to.z = site.z;
      if (ctx.world.trace(from, to, 0)) continue;
      sites.push(site);
      if (sites.length === 2) break;
    }
    if (sites.length < 2) {
      e.nodeCooldown = NODE_RETRY;
      return false;
    }
    const ids = [];
    for (const site of sites) {
      const node = ctx.encounters?.addObject?.("node", site, CHALLENGE.nodeHP, "warden");
      if (node) ids.push(node.id);
    }
    e.nodeCharge = new NodeCharge(ids);
    e.nodeEvents = (e.nodeEvents || 0) + 1;
    clearMarker(e);
    toast("RIFT NODES · BREAK BOTH TO INTERRUPT");
    return true;
  }

  function resolveNodes(e, run, result) {
    ctx.encounters?.removeObjects?.("warden");
    e.nodeCharge = null;
    if (result === "interrupted") {
      e.recovery = EXPOSED;
      e.vuln = EXPOSED_VULN;
      toast("RIFT INTERRUPTED · WARDEN EXPOSED");
    } else {
      // A line of three blasts across the Warden's approach axis, centred on the player.
      const p = run.player,
        a = Math.atan2(p.x - e.x, p.z - e.z);
      for (let side = -1; side <= 1; side++)
        hazard(p.x + Math.cos(a) * side * COLLAPSE.spacing, p.z - Math.sin(a) * side * COLLAPSE.spacing, COLLAPSE, "warden-node", CAUSES.collapse);
      toast("RIFT COLLAPSE · LEAVE THE MARKED GROUND");
    }
    e.state = "approach";
    e.cooldown = NODE_REGROUP;
    e.nodeCooldown = CHALLENGE.nodeCooldown;
  }

  // Node leftovers: the charge itself and any pending collapse blasts.
  function resetNodes(run) {
    for (const e of run?.enemies || []) if (isWarden(e)) e.nodeCharge = null;
    ctx.combat?.removeHazards?.((h) => h.kind === "warden-node");
  }

  // The Warden stays on the field and drops nothing; its victory waits until the kill has been
  // scored (the 5000 points belong in the summary).
  function wardenDefeated(e, run) {
    resetNodes(run);
    ctx.encounters?.clearChallenges?.();
    ctx.bus.emit("boss", { kind: "warden", event: "defeat", e });
  }

  // "enemyKilled" is combat's last kill step, after the director's scoring. The director's
  // onKill normally starts the victory already; run.victory makes this idempotent, so the
  // finale plays exactly once whichever system gets there first. Without a sequence (demo,
  // automated tests) the Warden leaves and the run ends at once.
  function settleVictory({ e } = {}) {
    const run = ctx.run;
    if (!run || run.victory || run.over || !isWarden(e)) return;
    run.victory = true;
    if (ctx.director?.beginSequence?.("victory", e, () => ctx.director?.finishRun?.(false)) === true) return;
    ctx.enemies?.remove?.(e);
    ctx.director?.finishRun?.(false);
  }

  // ---- Rift Warden (KEEPERS, F6): shards, the alive node phase and THE CROWN UNMADE --------

  const wardenAI = {
    onSpawn(e) {
      Object.assign(e, wardenFields(), { cooldown: WARDEN_ENTRY_COOLDOWN, nodesResolved: 0, strike: null, tethers: null, unmade: null, answers: 0 });
    },
    update: wardenKeeperUpdate,
    onDeath: wardenDown,
    label: wardenLabel,
  };

  function wardenLabel(e) {
    const u = e.unmade;
    if (e.recovery > 0) return "RIFT WARDEN · EXPOSED";
    if (u) return u.r < u.n ? `RIFT WARDEN · UNMADE · SHADE ${u.r + 1} / ${u.n}` : "RIFT WARDEN · UNMADE";
    if (e.nodeCharge) return `RIFT NODES ${e.nodeCharge.nodes.size} · ${Math.ceil(e.nodeCharge.remaining)}s`;
    return e.phase >= 2 ? "RIFT WARDEN · ENRAGED" : "RIFT WARDEN";
  }

  function wardenKeeperUpdate(e, dt) {
    const run = ctx.run,
      p = run.player,
      dx = p.x - e.x,
      dz = p.z - e.z,
      d = Math.max(1e-4, Math.hypot(dx, dz));
    if (e.phase === 3) {
      unmadeStep(e, run, dt, d, dx, dz);
      return;
    }
    // Phases resolve in order, each at a decision point (never mid-windup).
    if (e.state !== "bossWindup") {
      if (e.phase === 1 && gateDue(e) !== null) {
        if (wardenPhase2(e)) return;
      } else if (e.phase === 2 && unmadeArmed(e)) {
        beginUnmade(e, run);
        return;
      }
    }
    const window = nodeWindow(e, run, dt);
    if (window === "exposed") {
      settle(e, dx, dz, 0, SLUMP);
      return;
    }
    if (window === "kneel") {
      if (d > e.def.radius) driftToward(e, p, NODE_DRIFT * dt);
      wardenContact(e, d);
      tethersFollow(e, run);
      settle(e, dx, dz, WARDEN_STRIDE, KNEEL.body, KNEEL.arms);
      return;
    }
    strikeCycle(e, run, dt, d, dx, dz, WARDEN_COOLDOWN[e.phase >= 2 ? 1 : 0]);
    wardenContact(e, d);
    settle(e, dx, dz, WARDEN_STRIDE);
  }

  // Walks in, winds up and strikes: the rotation (ring, blast, ring, shards) before phase 3, then
  // ring and blast in turn.
  function strikeCycle(e, run, dt, d, dx, dz, cooldown) {
    if (e.state === "bossWindup") {
      e.timer -= dt;
      if (e.timer <= 0) keeperStrike(e, run, cooldown);
      else showCountdown(e, e.timer, e.windup);
      return;
    }
    if (d > WARDEN_REACH) walk(e, run, kit.speed(e.def.speed), dt);
    if (e.cooldown <= 0) beginNextStrike(e, run, dx, dz, d);
  }

  // Phases 1-2 follow the rotation; phase 3 alternates ring and blast (at the enraged pace).
  function beginNextStrike(e, run, dx, dz, d) {
    const kind = e.phase === 3 ? (e.answers++ % 2 === 0 ? "ring" : "blast") : wardenStrike(e.attackIndex);
    beginStrike(e, run, kind, dx / d, dz / d, d, kind === "shards" ? SHARDS.windup : WARDEN_WINDUP[e.phase >= 2 ? 1 : 0]);
  }

  function keeperStrike(e, run, cooldown) {
    if (e.strike === "ring") fireRing(e);
    else if (e.strike === "blast")
      for (const pt of blastPoints(e.tx, e.tz, e.ax, e.az, BLAST.spacing)) hazard(pt.x, pt.z, BLAST, "warden", CAUSES.wardenBlast);
    if (e.phase < 3) e.attackIndex++;
    e.strike = null;
    e.state = "approach";
    e.cooldown = cooldown;
    clearMarker(e);
  }

  // CROWN SHARDS: every marker appears at windup start; the points spiral out from the player,
  // each fuse a little longer, a pale gem falling in the last 0.3 s of each.
  function castShards(e, run) {
    const p = run.player,
      crownY = height(e.x, e.z) + TETHER.crown * (e.model?.g?.scale?.y ?? 1),
      drops = shardPoints(p.x, p.z, kit.rng() * TAU, run.death ? SHARDS.deathCount : SHARDS.count).map((pt) => ({
        x: pt.x,
        z: pt.z,
        h: ctx.combat?.hazard?.(pt.x, pt.z, SHARDS.radius, SHARDS.damage, pt.fuse, "shard", null, { source: at(CAUSES.crownShard, pt.x, pt.z), eta: pt.fuse }) ?? null,
        fell: false,
      }));
    ctx.fx?.burst?.(e.x, crownY - height(e.x, e.z), e.z, SHARDS.color, 10, 1.5); // the crown glows
    kit.effect({
      kind: "shards",
      tick() {
        let landed = true;
        for (const drop of drops) {
          if (!pending(drop.h)) continue;
          landed = false;
          if (drop.fell || drop.h.life > SHARDS.drop) continue;
          drop.fell = true;
          ctx.fx?.fall?.(drop.x, drop.z, "gem", SHARDS.color, SHARDS.height, drop.h.life);
        }
        return landed;
      },
    });
  }

  function wardenContact(e, d) {
    if (d < e.def.radius + CONTACT_REACH) ctx.player?.hurt?.(e.def.damage, at(CAUSES.wardenTouch, e.x, e.z));
  }

  function driftToward(e, p, distance) {
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    if (d > 1e-4) ctx.world.terrain.move(e, ((p.x - e.x) / d) * distance, ((p.z - e.z) / d) * distance, e.def.radius);
  }

  // Faces the player, poses (kneeling, slumped) and animates at 15 fps.
  function settle(e, dx, dz, stride, body, arms) {
    e.yaw = Math.atan2(dx, dz);
    kit.place(e, stride);
    const model = e.model;
    if (!model || body === undefined) return;
    model.body.position.y = body;
    if (arms !== undefined) for (const arm of model.arms) arm.rotation.x = arms;
  }

  // Phase 2 at the 50% gate: the Wave-1 enrage (tint, toast, ring, the "phase" sequence).
  function wardenPhase2(e) {
    e.phase = 2;
    openGate(e);
    const fight = ctx.run.keeper;
    if (fight?.e === e) fight.phase = 2;
    return enrage(e);
  }

  // The alive node phase (F6 4): kneeling to the charging nodes (it still drifts and touches),
  // then EXPOSED after an interruption. Wave-1 start rules; each resolution counts toward the
  // 25% gate.
  function nodeWindow(e, run, dt) {
    if (e.recovery > 0) {
      e.recovery -= dt;
      if (!(e.recovery > 0)) e.vuln = 1;
      return "exposed";
    }
    if (e.nodeCharge) {
      const result = e.nodeCharge.tick(dt);
      if (result !== "charging") {
        dropTethers(e);
        resolveNodes(e, run, result);
        e.nodesResolved = (e.nodesResolved || 0) + 1;
        if (result === "interrupted") kit.emit(e, "exposed", { cause: "nodes" });
      }
      return "kneel";
    }
    if (e.phase < 2 || !nodeDue(e, run, dt) || !openNodes(e, run)) return null;
    raiseTethers(e, run);
    return "kneel";
  }

  // Pulsing beams from each node gem to the crown while the nodes charge.
  function raiseTethers(e, run) {
    dropTethers(e);
    e.tethers = [];
    for (const o of run.objects ?? []) {
      if (o.owner !== "warden" || !e.nodeCharge?.nodes.has(o.id)) continue;
      const line = ctx.fx?.line?.(null, null, TETHER.color, 0, TETHER.width);
      if (line) e.tethers.push({ o, line, cut: false, a: { x: o.x, y: 0, z: o.z }, b: { x: 0, y: 0, z: 0 } });
    }
    tethersFollow(e, run);
  }

  function tethersFollow(e, run) {
    if (!e.tethers) return;
    const crown = height(e.x, e.z) + TETHER.crown * (e.model?.g?.scale?.y ?? 1),
      t = Math.floor(run.elapsed * 15) / 15,
      opacity = 0.5 + 0.3 * Math.sin(12 * t);
    for (const tether of e.tethers) {
      if (tether.cut) continue;
      if (tether.o.dead || !(tether.o.hp > 0)) {
        tether.cut = true;
        tether.line.remove?.();
        continue;
      }
      tether.a.y = height(tether.o.x, tether.o.z) + NODE_TOP;
      tether.b.x = e.x;
      tether.b.y = crown;
      tether.b.z = e.z;
      tether.line.update(tether.a, tether.b);
      tether.line.setOpacity?.(opacity);
    }
  }

  function dropTethers(e) {
    for (const tether of e.tethers ?? []) tether.line.remove?.();
    e.tethers = null;
  }

  // Phase 3 is armed once HP reaches 25% after at least one node event has resolved.
  const unmadeArmed = (e) => (e.nodesResolved || 0) >= 1 && gateDue(e) !== null;

  // THE CROWN UNMADE (F6 5): node events stop, the crown breaks into an orbiting ring, and the
  // rift raises a shade of every keeper this run broke, one at a time.
  function beginUnmade(e, run) {
    ctx.encounters?.removeObjects?.("warden");
    ctx.combat?.removeHazards?.((h) => h.kind === "warden-node");
    e.nodeCharge = null;
    dropTethers(e);
    e.recovery = 0;
    e.vuln = 1;
    clearMarker(e);
    e.state = "approach";
    e.strike = null;
    e.phase = 3;
    openGate(e);
    const list = shadeList(run.flags.keepersBroken),
      n = list.length;
    for (const id of list) shadeModel(id);
    e.unmade = { list, n, r: 0, stage: n ? "next" : "done", t: 0, shade: null };
    e.shadeFloor = shadeFloor(e.max, 0, n);
    e.cooldown = 0;
    if (run.keeper?.e === e) run.keeper.phase = 3;
    Object.assign(run.flags, { unmade: true, shades: n, shadesResolved: 0 });
    run.flags.shadeHits ??= 0;
    ctx.director?.milestone?.("unmade");
    crown.start(e);
    kit.emit(e, "unmade", { n });
    ctx.director?.beginSequence?.("unmade", e);
  }

  // Phase 3, one step. Stages: a shade rises, attacks and fades (next / wait / rise / attack /
  // fade), the Warden slumps EXPOSED, answers with exactly one attack (answer), waits out the
  // enraged cooldown (gap) so shade and Warden attacks never overlap, and the next shade rises.
  // After the last shade (done) it alternates ring and blast until it falls.
  function unmadeStep(e, run, dt, d, dx, dz) {
    const u = e.unmade;
    crown.step(e, run, dt);
    switch (u.stage) {
      case "exposed":
        e.recovery -= dt;
        if (e.recovery > 0) {
          settle(e, dx, dz, 0, SLUMP);
          return;
        }
        e.vuln = 1;
        u.stage = "answer";
        beginNextStrike(e, run, dx, dz, d);
        break;
      case "answer":
        e.timer -= dt;
        if (e.timer > 0) showCountdown(e, e.timer, e.windup);
        else {
          keeperStrike(e, run, 0);
          u.stage = "gap";
          u.t = WARDEN_COOLDOWN[1];
        }
        break;
      case "gap":
        u.t -= dt;
        if (u.t <= 0) u.stage = u.r < u.n ? "next" : "done";
        walkIn(e, run, dt, d);
        break;
      case "done":
        strikeCycle(e, run, dt, d, dx, dz, WARDEN_COOLDOWN[1] * FINAL_CADENCE);
        break;
      default:
        shadeStep(e, run, dt, u);
        walkIn(e, run, dt, d);
    }
    if (u.stage !== "exposed") wardenContact(e, d);
    settle(e, dx, dz, WARDEN_STRIDE);
  }

  function walkIn(e, run, dt, d) {
    if (d > WARDEN_REACH) walk(e, run, kit.speed(e.def.speed), dt);
  }

  function shadeStep(e, run, dt, u) {
    const s = u.shade;
    switch (u.stage) {
      case "next":
        raiseShade(e, run, u);
        break;
      case "wait":
        u.t -= dt;
        if (u.t <= 0) u.stage = "next";
        break;
      case "rise":
        u.t += dt;
        kit.face(s, dt);
        dissolve(s, u.t / SHADE.rise);
        if (u.t >= SHADE.rise) {
          u.stage = "attack";
          // A keeper whose attack is not registered still rises and fades (its step is resolved).
          if (!kit.attack.start(s, SHADE_ATTACKS[s.kind], { shade: true })) fadeShade(u);
        }
        break;
      case "attack":
        kit.face(s, dt, kit.attack.turn(s));
        if (kit.attack.step(s, dt)) fadeShade(u);
        break;
      case "fade":
        u.t += dt;
        dissolve(s, 1 - u.t / SHADE.fade);
        if (u.t >= SHADE.fade) resolveShade(e, run, u);
        break;
    }
    if (u.shade) poseShade(u.shade, run);
  }

  // Places the next shade 12 m from the player on its camera-relative bearing. Where the ground
  // there puts it on top of the player (a map edge snaps it back), the other three bearings are
  // tried in turn; with none clear it tries again a second later.
  function raiseShade(e, run, u) {
    const id = u.list[u.r],
      def = keeperDef(id),
      p = run.player;
    let site = null;
    for (let j = 0; j < 4 && !site; j++) {
      shadeBearing(u.r + j, ctx.cam?.yaw ?? 0, bearing);
      const at = ctx.world.terrain.safeNear(p.x + bearing.x * SHADE.reach, p.z + bearing.z * SHADE.reach, def.radius);
      if (Math.hypot(at.x - p.x, at.z - p.z) >= SHADE.gap) site = at;
    }
    if (!site) {
      u.stage = "wait";
      u.t = SHADE.retry;
      return;
    }
    const actor = { id: `shade:${id}`, kind: id, keeper: id, x: site.x, z: site.z, y: 0, yaw: 0, def, phase: 1, shade: true, radius: def.radius, lockYaw: 0, attack: null, markers: [], model: shadeModel(id) };
    actor.yaw = yawTo(actor, p);
    u.shade = actor;
    u.stage = "rise";
    u.t = 0;
    kit.emit(e, "shade", { id, k: u.r + 1, n: u.n });
  }

  function fadeShade(u) {
    u.stage = "fade";
    u.t = 0;
  }

  // A shade has faded: it is resolved, the floor steps down and the Warden slumps, EXPOSED.
  function resolveShade(e, run, u) {
    retireShade(u.shade);
    u.shade = null;
    u.r++;
    e.shadeFloor = shadeFloor(e.max, u.r, u.n);
    run.flags.shadesResolved = u.r;
    u.stage = "exposed";
    e.recovery = run.death ? SHADE.deathExposed : SHADE.exposed;
    e.vuln = EXPOSED_VULN;
    kit.emit(e, "exposed", { cause: "shade" });
  }

  function retireShade(actor) {
    if (!actor) return;
    kit.attack.stop(actor);
    kit.dropMarkers(actor.markers);
    if (actor.model) actor.model.g.visible = false;
  }

  // ---- shade models: the keeper's own model, pooled (one per kind), in its spectral look ----

  const shadeModels = new Map();

  function shadeModel(kind) {
    let model = shadeModels.get(kind);
    if (!model) {
      model = spectral(createMonster(kind));
      model.g.visible = false;
      ctx.gfx?.layers?.actors?.add(model.g);
      shadeModels.set(kind, model);
    }
    return model;
  }

  // Rise and fade: a dissolve held in 6 steps (the spectral look's alpha-hash threshold).
  function dissolve(actor, k) {
    const model = actor?.model;
    if (!model) return;
    const step = Math.floor(clamp(k, 0, 1) * SHADE.steps + 1e-6) / SHADE.steps;
    model.g.visible = step > 0;
    model.setDissolve?.(step);
  }

  function poseShade(actor, run) {
    const g = actor.model?.g;
    if (!g) return;
    g.position.set(actor.x, height(actor.x, actor.z) + (actor.y || 0), actor.z);
    g.rotation.y = actor.yaw;
    animateCharacter(actor.model, run.elapsed, SHADE.stride);
  }

  function hideShades() {
    for (const model of shadeModels.values()) model.g.visible = false;
  }

  // ---- the crown ring (phase 3): five spikes orbit the Warden over boss-class ground discs ---

  const crown = createCrownRing(ctx, height);

  // The Warden has fallen (victory) or the run moved on: shades dissolve at once and the crown
  // spikes fall.
  function endUnmade(e) {
    retireShade(e.unmade?.shade);
    hideShades();
    crown.fall();
  }

  function wardenDown(e) {
    dropTethers(e);
    if (e.unmade) endUnmade(e);
    wardenDefeated(e, ctx.run);
    ctx.run.keeperState = "defeated";
    ctx.run.keeper = null;
  }

  // ---- the keeper flow (F1.3) ----------------------------------------------------------------

  keeperAI.ironmaw = mawAI;
  keeperAI.warden = wardenAI;

  const daisCenter = () => ctx.world?.dais ?? ctx.world?.portal ?? null;

  // Where a keeper rises: a fixed point (Iron Maw), the dais (the Warden lands clear of the
  // player), beyond the shrine bell (the Bellwether), or between the player and the rift.
  function spawnPoint(def, run) {
    const terrain = ctx.world.terrain,
      p = run.player,
      r = def.radius;
    if (Array.isArray(def.spawn)) return terrain.safeNear(def.spawn[0], def.spawn[1], r);
    if (def.spawn === "dais") return daisLanding(daisCenter() ?? p, p, 4, { x: 0, z: 0 });
    const bell = def.spawn === "bell" ? ctx.world.shrineBell : null;
    if (bell) {
      toward(p, bell, Math.hypot(bell.x - p.x, bell.z - p.z) + BELL_BEYOND, spot);
      const beyond = terrain.safeNear(spot.x, spot.z, r);
      if (Math.hypot(beyond.x - p.x, beyond.z - p.z) >= KEEPER_MIN_GAP) return beyond;
    }
    const target = bell ?? ctx.world.portal ?? { x: 0, z: 0 };
    toward(p, target, KEEPER_BETWEEN, spot);
    const between = terrain.safeNear(spot.x, spot.z, r);
    return Math.hypot(between.x - p.x, between.z - p.z) >= KEEPER_MIN_GAP ? between : terrain.safeNear(target.x, target.z, r);
  }

  // KEEPERS only: the generalised quarry gate. A mandatory keeper waits for an active trial; the
  // optional Bellwether refuses one (and wakes only after the goal). The arrival clears the
  // field (no score, drops or credit), plays its sequence and toast. Idempotent.
  function startKeeper(id) {
    const run = ctx.run,
      def = keeperDef(id);
    if (!run?.player || run.original || run.over || !def || !ctx.world?.terrain) return false;
    if (run.keeperState !== "dormant" && run.keeperState !== "waiting") return false;
    const warden = id === "warden";
    if (warden ? run.bossSpawned || (ctx.mode !== "play" && !run.demo) : run.demo || run.tutorial) return false;
    if (def.optional && run.stageKills < run.stageGoal) return false;
    if (run.trial?.state === "active") {
      if (def.optional) toast("FINISH THE TRIAL BEFORE RINGING THE BELL", 2);
      else {
        run.keeperState = "waiting";
        toast(`${def.title} AWAITS · COMPLETE OR ABANDON TRIAL IN PAUSE`, 2);
      }
      return false;
    }
    const point = spawnPoint(def, run);
    const e = ctx.enemies?.spawn?.(id, point, { keeper: true }) ?? null;
    if (!e) return false;
    for (const other of run.enemies.slice()) if (other !== e) retire(other);
    if (warden) {
      run.bossSpawned = true;
      ctx.combat?.clear?.();
      if (ctx.world.terrain.walkable(point.x, point.z, def.radius)) Object.assign(e, { x: point.x, z: point.z });
    }
    arm(e, def, id, run);
    run.keeperState = "active";
    run.keeper = { id, e, t0: run.elapsed, untouched: true, phase: 1, stats: {}, mSnapshot: ctx.scoring?.multiplier?.() ?? 1 };
    run.player.inv = Math.max(run.player.inv, ARRIVAL_GRACE);
    kit.enter(e, e);
    keeperAI[id]?.onSpawn?.(e);
    kit.place(e, 0);
    ctx.bus.emit("boss", { kind: id, event: "spawn", e });
    ctx.profile?.recordEnemy?.(id);
    ctx.scoring?.overtime?.("keeper");
    toast(`${def.title} · ${def.tagline}`, 3);
    if (warden) ctx.audio?.fx?.("level");
    ctx.director?.beginSequence?.(def.sequence, e);
    return true;
  }

  // A monster the keeper's arrival sweeps away: gone at once, no kill.
  function retire(e) {
    ctx.enemies?.remove?.(e);
    e.hp = 0;
  }

  // The keeper record's fields, whatever def the spawn resolved (the kit and the gates read
  // them): KEEPERS HP (never scaled by stage or wave), its gates, facing the player.
  function arm(e, def, id, run) {
    Object.assign(e, {
      def,
      radius: def.radius,
      keeper: id,
      boss: id,
      grace: 0,
      cooldown: KEEPER_ENTRY_COOLDOWN,
      state: "approach",
      timer: 0,
      phase: 1,
      gates: def.gates ?? [],
      gatesOpen: 0,
      vuln: 1,
      shadeFloor: 0,
      effects: [],
      markers: [],
      attack: null,
      stall: null,
      untargetable: false,
    });
    e.hp = e.max = keeperHp(id);
    e.yaw = yawTo(e, run.player);
  }

  // Keeper HP at spawn: def.hp × hpScale(), never scaled by stage or wave (KEEPERS only).
  function keeperHp(id) {
    return (keeperDef(id)?.hp ?? 0) * (ctx.director?.hpScale?.() ?? 1);
  }

  // Stage 5 under KEEPERS: the director has woken the Crown Dais (run.dais); the crown calls
  // the player up with a toast and the dais sequence, framed on the pad.
  function awaitDais() {
    const run = ctx.run,
      pad = daisCenter();
    if (!run?.dais?.awake || run.original || run.bossSpawned || !pad) return false;
    toast("THE CROWN AWAITS · ASCEND THE DAIS", 3);
    ctx.director?.beginSequence?.("dais", { x: pad.x, z: pad.z, y: height(pad.x, pad.z) });
    return true;
  }

  // A keeper fell (F1.3): records, the milestone and mastery, then its reward; choosing it
  // opens (or re-checks) the portal. Kill processing (score, gem, powerup) continues after.
  function keeperDefeated(e, run) {
    const id = e.keeper,
      def = keeperDef(id),
      fight = run.keeper?.e === e ? run.keeper : null,
      seconds = run.elapsed - (fight?.t0 ?? run.elapsed),
      untouched = fight?.untouched ?? false,
      key = id === "ironmaw" ? "quarry" : `keeper:${id}`;
    endKeeper(e);
    kit.enter(e, e);
    keeperAI[id]?.onDeath?.(e);
    run.flags.keepersBroken.push(id);
    run.flags.keeperTimes[id] = seconds;
    run.pacing?.recover?.(KEEPER_REST);
    ctx.director?.milestone?.(key);
    ctx.profile?.trackMastery?.("keeper", { id: `${run.id}-${id}`, keeper: id, untouched, seconds, stats: fight?.stats ?? {} });
    ctx.profile?.keeperRecord?.(id, { seconds, untouched });
    run.keeperState = "defeated";
    run.keeper = null;
    ctx.bus.emit("boss", { kind: id, event: "defeat", e });
    ctx.progression?.queue?.(ctx.director?.rewardKey?.(key) ?? key, def.reward, () => {
      if (ctx.run !== run) return;
      run.keeperState = "rewarded";
      ctx.encounters?.flushCaches?.();
      ctx.director?.activatePortal?.();
    });
  }

  // Everything a keeper left running: its attack, telegraphs, travelling effects, tethers.
  function endKeeper(e) {
    kit.attack.stop(e);
    kit.endEffects(e);
    kit.dropMarkers(e.markers);
    clearMarker(e);
    dropTethers(e);
    e.untargetable = false;
  }

  // ---- keeper anti-stall (F1.6): a keeper left far behind out of sight catches up -----------

  const idle = (e) => !e.attack && e.state === "approach" && !(e.recovery > 0) && !e.nodeCharge && e.phase !== 3;

  // True while the keeper sinks or rises (the AI waits, no contact, invulnerable).
  function antiStall(e, run, dt) {
    const s = (e.stall ??= { away: 0, look: 0, cooldown: 0, hidden: false, phase: null, t: 0 });
    if (s.phase) {
      burrow(e, run, s, dt);
      return true;
    }
    s.cooldown -= dt;
    const p = run.player;
    if (!idle(e) || Math.hypot(p.x - e.x, p.z - e.z) <= STALL.range) {
      s.away = 0;
      s.look = 0;
      return false;
    }
    if ((s.look -= dt) <= 0) {
      s.look = STALL.look;
      s.hidden = !inSight(e, p);
    }
    s.away = s.hidden ? s.away + dt : 0;
    if (s.away < STALL.wait || s.cooldown > 0) return false;
    s.phase = "sink";
    s.t = 0;
    s.away = 0;
    e.untargetable = true;
    return true;
  }

  function inSight(e, p) {
    from.x = e.x;
    from.y = height(e.x, e.z) + STALL.eye;
    from.z = e.z;
    to.x = p.x;
    to.y = height(p.x, p.z) + STALL.eye;
    to.z = p.z;
    return !ctx.world.trace(from, to, 0);
  }

  // Sinks for 0.4 s, reappears 14 m from the player on its own side and rises like its
  // sequence (0.6 s).
  function burrow(e, run, s, dt) {
    s.t += dt;
    const p = run.player;
    if (s.phase === "sink") {
      e.y = -STALL.depth * Math.min(1, s.t / STALL.sink);
      if (s.t >= STALL.sink) {
        toward(p, e, STALL.back, spot);
        const site = ctx.world.terrain.safeNear(spot.x, spot.z, e.def.radius);
        e.x = site.x;
        e.z = site.z;
        s.phase = "rise";
        s.t = 0;
      }
    } else {
      e.y = -Math.max(0, 1 - (2 * s.t) / STALL.rise) * STALL.depth;
      if (s.t >= STALL.rise) {
        s.phase = null;
        e.y = 0;
        e.untargetable = false;
        s.cooldown = STALL.wait;
      }
    }
    e.yaw = yawTo(e, p);
    kit.place(e, 0);
  }

  // ---- API -----------------------------------------------------------------------------------

  // The boss half of enemies.update: the cooldown counts down every active step, whatever
  // the state (enemies.md §5.1), then the boss's own machine runs.
  function update(e, dt) {
    const run = ctx.run;
    if (!run?.player || !e || !(e.hp > 0) || !ctx.world?.terrain || !(dt > 0)) return;
    e.cooldown -= dt;
    if (e.keeper) keeperStep(e, run, dt);
    else if (isWarden(e)) wardenUpdate(e, run, dt);
    else if (isMaw(e)) mawUpdate(e, run, dt);
  }

  // A KEEPERS keeper's step: its travelling effects, the anti-stall, then its AI.
  function keeperStep(e, run, dt) {
    const ai = keeperAI[e.keeper];
    if (!ai) return;
    kit.enter(e, e);
    kit.tickEffects(e, dt);
    if (!(e.hp > 0) || !stepping(run) || antiStall(e, run, dt)) return;
    ai.update(e, dt);
  }

  // Called from enemies.onDeath, before trial bookkeeping, drops and score.
  function onDeath(e) {
    const run = ctx.run;
    if (!run || !e) return;
    clearMarker(e);
    if (e.keeper === "warden") {
      endKeeper(e);
      wardenDown(e);
    } else if (e.keeper) keeperDefeated(e, run);
    else if (isWarden(e)) wardenDefeated(e, run);
    else if (isMaw(e)) mawDefeated(e, run);
  }

  // The live boss or keeper (the Wave-1 pair under ORIGINAL).
  function current() {
    const list = ctx.run?.enemies;
    if (!list) return null;
    for (const e of list) if ((e.keeper || isWarden(e) || isMaw(e)) && alive(e)) return e;
    return null;
  }

  // The Warden's live shade actor ({ id, kind, x, z, def, ... }) or null (radar, F6).
  function shade() {
    const warden = current();
    return warden?.unmade?.shade ?? null;
  }

  // Boss bar label: the keeper's own, else the Wave-1 labels.
  function label(e) {
    if (!e) return "";
    if (e.keeper) return keeperAI[e.keeper]?.label?.(e) ?? e.def?.title ?? e.def?.name ?? "";
    if (isMaw(e)) return e.state === "stagger" ? "IRON MAW · STAGGERED" : "IRON MAW";
    if (isWarden(e)) {
      if (e.nodeCharge) return `RIFT NODES ${e.nodeCharge.nodes.size} · ${Math.ceil(e.nodeCharge.remaining)}s`;
      if (e.recovery > 0) return "WARDEN · EXPOSED";
      return e.enraged ? "ENRAGED" : "RIFT WARDEN";
    }
    return e.def?.name ?? "";
  }

  // Gate fractions for the boss bar (the Wave-1 Warden shows its 50% tick until the enrage).
  function ticks(e) {
    if (e?.keeper) return e.gates ?? [];
    return isWarden(e) && !e.enraged ? [0.5] : [];
  }

  // [node 1 alive, node 2 alive, share of the deadline left] while a node event charges.
  function pips(e) {
    const charge = isWarden(e) ? e.nodeCharge : null;
    if (charge?.state !== "charging") return null;
    return [charge.nodes.has(charge.ids[0]), charge.nodes.has(charge.ids[1]), clamp(charge.remaining / CHALLENGE.nodeDeadline, 0, 1)];
  }

  // stagger(e, seconds): a stun on a keeper that supports staggering (F1.4d); others ignore it.
  function stagger(e, seconds) {
    const ai = keeperAI[e?.keeper];
    if (!ai?.stagger || !alive(e)) return;
    kit.enter(e, e);
    ai.stagger(e, seconds);
  }

  // A bullet stopped by a blocking guard (the Castellan's vigil reflects it).
  function onBlocked(e, shot) {
    const ai = keeperAI[e?.keeper];
    if (!ai?.onBlocked || !alive(e)) return;
    kit.enter(e, e);
    ai.onBlocked(e, shot);
  }

  // Run start and stage entry: node charge, collapse blasts, any keeper's leftovers, the gate.
  function clear() {
    const run = ctx.run;
    resetNodes(run);
    for (const e of run?.enemies ?? []) if (e.keeper) endKeeper(e);
    hideShades();
    crown.hide();
    kit.clearDecor();
    if (run) {
      run.quarryState = "dormant";
      run.keeper = null;
    }
  }

  ctx.bus.on("enemyKilled", settleVictory);
  // Run end clears the node event like the original's clearChallenges(); shades dissolve.
  ctx.bus.on("runEnd", () => {
    resetNodes(ctx.run);
    for (const e of ctx.run?.enemies ?? []) if (e.unmade) retireShade(e.unmade.shade);
    hideShades();
  });

  // Records: Untouched by Iron (Wave-1), the keeper's untouched flag and the Crown Unmade's shade
  // hits count only real HP loss (Bone Ward absorption excluded); Crown of Thorns drain spoils
  // untouched too.
  ctx.bus.on("playerHit", ({ amount = 0, absorbed = 0, source } = {}) => {
    const run = ctx.run;
    if (!run || !(amount - absorbed > 0)) return;
    if (run.quarryState === "active") (run.flags ??= {}).mawUntouched = false;
    if (run.keeper) run.keeper.untouched = false;
    if (String(source?.label ?? "").startsWith("Shade of")) run.flags.shadeHits = (run.flags.shadeHits || 0) + 1;
  });
  ctx.bus.on("playerDrain", () => {
    if (ctx.run?.keeper) ctx.run.keeper.untouched = false;
  });

  // Practice scenarios (IMPROVEMENTS §3.15).
  ctx.bus.on("practice", ({ register } = {}) => {
    if (typeof register !== "function") return;
    register("bellwether", scenarioBellwether, { stage: 1, mortal: true });
    register("quarry", (c, params, h) => h.goalMet(), { stage: 2, mortal: true });
    register("abbot", (c, params, h) => h.goalMet(), { stage: 3, mortal: true });
    register("castellan", (c, params, h) => h.goalMet(), { stage: 4, mortal: true });
    register("warden", (c, params, h) => h.goalMet(), { stage: 5, mortal: true });
    register("unmade", scenarioUnmade, { stage: 5, mortal: true });
    register("trialwait", scenarioTrialWait, { stage: 3 });
  });

  // Stage 1 at its goal, the shrine bell rung: the Bellwether rises (the Wave-1 Meadows under
  // &original=1).
  function scenarioBellwether(c, params, h) {
    h.goalMet();
    if (c.run.original) return;
    c.world?.shrineBell?.ring?.();
    if (c.run.keeperState !== "active") startKeeper("bellwether");
  }

  // The Warden at 26% in phase 2 with a node event behind it and all four keepers broken, the
  // player 10 m from the dais: crossing 25% plays THE CROWN UNMADE and four shades.
  function scenarioUnmade(c, params, h) {
    const run = c.run;
    if (run.original) {
      h.goalMet();
      return;
    }
    h.breakKeepers(KEEPER_ORDER);
    run.stageKills = run.stageGoal;
    const pad = daisCenter();
    if (pad) {
      toward(pad, { x: 0, z: 0 }, 10, spot);
      const site = ctx.world.terrain.safeNear(spot.x, spot.z, 0.45);
      c.player?.place?.(site.x, site.z);
    }
    const e = h.keeper("warden", { hpFraction: 0.26 });
    if (!e) return;
    e.phase = 2;
    e.enraged = true;
    e.gatesOpen = 1;
    e.nodesResolved = 1;
    e.nodeEvents = CHALLENGE.nodeEvents;
    setTint(e.model, WARDEN_TINT, 1);
    if (run.keeper) run.keeper.phase = 2;
  }

  // A Skull Trial running when the goal is met: the stage's keeper waits (the bell refuses).
  function scenarioTrialWait(c, params, h) {
    h.trialNearPlayer();
    h.goalMet();
    if (!c.run.original && c.run.stage === 1) startKeeper("bellwether");
  }

  return {
    startQuarry,
    summonWarden,
    startKeeper,
    keeperHp,
    awaitDais,
    label,
    ticks,
    pips,
    // floor(e) -> the HP the boss bar seals in grey (the current gate or shade floor).
    floor: gateFloor,
    // gateFloor(e) -> HP that damage cannot pass this hit (combat pipeline step 8).
    gateFloor,
    stagger,
    onBlocked,
    update,
    onDeath,
    current,
    shade,
    clear,
    // The live Warden's node event ({ nodes: Set, ids, remaining, state, destroy(id) }) or null.
    get nodeCharge() {
      const boss = current();
      return isWarden(boss) ? boss.nodeCharge || null : null;
    },
  };
}

// The crown ring's two instanced meshes (spikes and their ground discs), built on first use and
// reused by every later phase 3. Spikes reuse the Warden model's crown part when it has one.
function createCrownRing(ctx, height) {
  const matrix = new THREE.Matrix4(),
    rotation = new THREE.Quaternion(),
    position = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    euler = new THREE.Euler(),
    point = { x: 0, z: 0 },
    spikeScale = new THREE.Vector3(CROWN_SPIKE.x, CROWN_SPIKE.y, CROWN_SPIKE.z),
    hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let spikes = null,
    discs = null,
    angle = 0,
    hiddenParts = [];

  function build(model) {
    const part = model?.parts?.crown?.[0];
    if (part) spikeScale.copy(part.scale).multiply(model.g.scale);
    spikes = new THREE.InstancedMesh(part?.geometry ?? monsterKit.geo.claw, part?.material ?? retroMaterial(CROWN.bone, TILE.bone), CROWN.count);
    discs = new THREE.InstancedMesh(
      new THREE.CircleGeometry(CROWN.disc, 12).rotateX(-Math.PI / 2),
      unlitMaterial(CROWN.discColor, { transparent: true, opacity: 0.5, depthWrite: false }),
      CROWN.count,
    );
    for (const mesh of [spikes, discs]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.visible = false;
      ctx.gfx?.layers?.actors?.add(mesh);
    }
  }

  function set(mesh, i, x, y, z, yaw, tilt, s) {
    position.set(x, y, z);
    rotation.setFromEuler(euler.set(0, yaw, tilt));
    matrix.compose(position, rotation, s);
    mesh.setMatrixAt(i, matrix);
  }

  const ring = {
    // The crown breaks: its spikes leave the model and start to orbit.
    start(e) {
      if (!spikes) build(e.model);
      angle = 0;
      hiddenParts = [...(e.model?.parts?.crown ?? [])];
      for (const part of hiddenParts) part.visible = false;
      spikes.visible = discs.visible = true;
      ring.place(e);
    },
    place(e) {
      scale.set(1, 1, 1);
      for (let i = 0; i < CROWN.count; i++) {
        crownPoint(angle, i, CROWN.count, CROWN.radius, e.x, e.z, point);
        const floor = height(point.x, point.z);
        set(spikes, i, point.x, floor + CROWN.height, point.z, angle, 0, spikeScale);
        set(discs, i, point.x, floor + 0.05, point.z, 0, 0, scale);
      }
      spikes.instanceMatrix.needsUpdate = discs.instanceMatrix.needsUpdate = true;
    },
    // Orbits at 1.2 rad/s around the Warden and hurts a player whose centre enters a disc.
    step(e, run, dt) {
      if (!spikes) return;
      angle += CROWN.spin * dt;
      ring.place(e);
      const p = run.player;
      for (let i = 0; i < CROWN.count; i++) {
        crownPoint(angle, i, CROWN.count, CROWN.radius, e.x, e.z, point);
        if (Math.hypot(p.x - point.x, p.z - point.z) < CROWN.touch) {
          ctx.player?.hurt?.(CROWN.damage, at(CAUSES.crownShard, point.x, point.z));
          break;
        }
      }
    },
    // Victory: the spikes drop where they are and lie there until the stage clears.
    fall() {
      if (!spikes?.visible) return;
      discs.visible = false;
      for (let i = 0; i < CROWN.count; i++) {
        spikes.getMatrixAt(i, matrix);
        matrix.decompose(position, rotation, scale);
        set(spikes, i, position.x, height(position.x, position.z) + 0.25, position.z, (i * TAU) / CROWN.count, Math.PI / 2, spikeScale);
      }
      spikes.instanceMatrix.needsUpdate = true;
    },
    hide() {
      if (!spikes) return;
      spikes.visible = discs.visible = false;
      for (let i = 0; i < CROWN.count; i++) {
        spikes.setMatrixAt(i, hidden);
        discs.setMatrixAt(i, hidden);
      }
      for (const part of hiddenParts) part.visible = true;
      hiddenParts = [];
    },
  };
  return ring;
}
