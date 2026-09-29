// Firing, projectiles, damage, blasts, delayed hazards and ground zones: the single path every
// bullet, splash, weapon-mod effect, relic and enemy attack goes through. Shots sweep each
// step's segment against terrain and cover first and bodies second, so nothing ever hits
// through a wall; lethal damage runs the contract's kill order so every listener sees a
// consistent world. ORIGINAL runs keep the Wave-1 damage path verbatim; KEEPERS runs take the
// Wave-2 pipeline (IMPROVEMENTS F1.4): guards, windows, the Rules Ledger, Insta Kill with the
// keeper cap, BOUND splits, shells and phase gates, plus zones and hazard props.
import * as THREE from "three";
import { WEAPONS, WEAPON_FEEDBACK, MAX_SHOTS } from "../data/weapons.js";
import { shotStats } from "../data/progression.js";
import { CHALLENGE, anchorMultiplier } from "../data/enemies.js";
import { unlitMaterial } from "../render/materials.js";
import { hitBody } from "../world/ballistics.js";
import { clamp } from "../core/util.js";
import { isHittable } from "./enemies.js";
import {
  HOSTILE_ROUND,
  bossLike,
  guardOf,
  arcOf,
  arcMult,
  isBullet,
  classifyHit,
  executes,
  scaledHit,
  insideBox,
  insideZone,
  evictionIndex,
  placedSource,
} from "./logic/combat.js";

export { HOSTILE_ROUND, bossLike, guardOf, arcOf, arcMult, isBullet, classifyHit, executes, scaledHit, insideBox, insideZone, evictionIndex, placedSource };

const MUZZLE_HEIGHT = 1.47; // projectiles leave the shooter's centre column at chest height
const CHEST_HEIGHT = 1.2; // enemy shots aim here on the player
const BODY_FOOT = 0.08;
const BODY_HEIGHT = 2.3;
const PLAYER_RADIUS = 0.45;
const HIT_TIME = 0.12; // enemy hit flash / squash timer
const NEUTRAL_RECOIL = 0.5; // squash strength of non-weapon damage
const MIN_FAN = 0.05; // extra projectiles always spread at least this much (Wave-1)
const WALL_PULLBACK = 0.015; // impacts sit just in front of the surface they hit
const FAST_ROUND = 60; // m/s; faster player rounds draw a streak so they never "teleport"
const LANCER = 3;
const HITSTOP_LANCER = 2 / 60;
const HITSTOP_CRIT_KILL = 3 / 60;
const BLAST_SHAKE = 0.23;
const BLAST_HEIGHT = 0.5;
const SCORCH_LIFE = 10;
const REDUCED_MUZZLE = 0.35; // Reduce flashes: share of the muzzle light (F17)
const RELIC_RING_LIFE = 0.35;
const TARGETS_PLAYER = 8; // hazard footprints this close to the player target it (F16.2)
const ZONE_CAP = 32;
const ZONE_EARLY = 1e-9; // tick timers that land a rounding error short still fire
const ZONE_DEFAULTS = Object.freeze({ life: 4, tick: 0.5, visual: "cinder", source: Object.freeze({ id: "Cinders", label: "Cinders" }) });
const BURNS = new Set(["Lava", "Cinders"]); // zone causes Ash Salts shrugs off

const COLORS = Object.freeze({
  crit: "#e8d28a",
  neutral: "#c9fffe",
  stone: "#b6a184",
  smoke: "#ffbd65",
  enemyBlast: "#ff855f",
  playerBlast: "#ffd774",
  blastRing: "#ffe7ad",
  scorch: "#1b1612",
  absorbed: "#9c9a8b", // grey numbers: guarded fronts, shells and gates
  exposed: "#f0b25c", // amber numbers: a weak rear
});
// Hazard kinds whose arming cue is the sharp aim tone instead of the ground rumble.
const AIM_WARNED = new Set(["mortar", "hex", "warden-node"]);

// Shot meshes: long thin boxes, rockets a stretched icosahedron. Shared unit geometry;
// meshes are pooled so steady fire allocates nothing.
const SHAPES = Object.freeze({
  bullet: { geometry: new THREE.BoxGeometry(1, 1, 1), scale: new THREE.Vector3(0.065, 0.065, 0.6) },
  rocket: { geometry: new THREE.IcosahedronGeometry(1, 0), scale: new THREE.Vector3(0.16, 0.16, 0.35) },
});

export const pitchTo = (x, y, z, tx, ty, tz) => Math.atan2(ty - y, Math.hypot(tx - x, tz - z));

// Angle offset of projectile i in a volley of `count`. Single shots jitter within the
// weapon's spread (`jitter(a, b)` draws it; none for the echo); several fan out evenly,
// never tighter than MIN_FAN so extra rounds on zero-spread weapons stay visible.
export function volleyOffset(i, count, spread, jitter = null) {
  if (count <= 1) return jitter ? jitter(-spread, spread) : 0;
  return (i - (count - 1) / 2) * Math.max(spread, MIN_FAN);
}

// Tracks what combat has put in the scene. A list another system filtered directly (trial
// cleanup, boss resets) can then never leave an orphaned mesh or marker behind.
function createLedger(release) {
  const live = new Set();
  let epoch = 0;
  return {
    track(item) {
      live.add(item);
    },
    drop(item) {
      if (live.delete(item)) release(item);
    },
    // Release everything tracked that is no longer in `list`.
    reconcile(list) {
      if (live.size === list.length) return;
      epoch++;
      for (let i = 0; i < list.length; i++) list[i].ledgerMark = epoch;
      for (const item of live)
        if (item.ledgerMark !== epoch) {
          live.delete(item);
          release(item);
        }
    },
    releaseAll() {
      for (const item of live) release(item);
      live.clear();
    },
  };
}

export function createCombat(ctx) {
  const spare = { bullet: [], rocket: [] };
  const shotLedger = createLedger(retireShot);
  const hazardLedger = createLedger((h) => {
    ctx.tele?.remove?.(h.marker);
    h.marker = null;
  });
  const pendingZones = []; // zones made while the zones tick (a kill's death effects)
  let shotSerial = 0;
  let ticking = false;

  // Scratch, reused every step (nothing below allocates per shot per step).
  const from = { x: 0, y: 0, z: 0 },
    to = { x: 0, y: 0, z: 0 },
    stop = { x: 0, y: 0, z: 0 },
    losFrom = { x: 0, y: 0, z: 0 },
    losTo = { x: 0, y: 0, z: 0 },
    body = { x: 0, z: 0, radius: 0, bottom: 0, top: 0 },
    propBody = { x: 0, z: 0, radius: 0, bottom: 0, top: 0 },
    volleyTarget = { x: 0, y: 0, z: 0 },
    markerState = { opacity: 1, progress: 0 },
    numberOptions = { crit: false, target: null, color: undefined },
    greyOptions = { crit: false, target: null, color: COLORS.absorbed },
    hazardBlast = { source: null },
    arcInfo = { arc: "side", angle: 0 },
    hitList = [],
    targetList = [];
  let hitCount = 0;

  const ground = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const isWarden = (e) => e.boss === "warden" || e.kind === "warden";
  const isMiniboss = (e) => !!e.miniboss || e.boss === "ironmaw";
  const isProp = (o) => o.kind === "prop";
  const alive = (t) => t && !t.dead && t.hp > 0;
  const reduceFlashes = () => ctx.prefs?.flashes === false;
  // The Rules Ledger applies to KEEPERS runs only; ORIGINAL keeps every Wave-1 number.
  const ledger = (run) => (run.original ? null : (ctx.rules ?? null));

  // Crits and spread jitter roll on the "combat" stream (IMPROVEMENTS F14.1), so a fire pattern
  // never shifts spawns or offers. Under ORIGINAL every stream is the Wave-1 run generator.
  function combatRoll() {
    const run = ctx.run,
      stream = run?.stream?.("combat") ?? run?.rng;
    return typeof stream === "function" ? stream() : Math.random();
  }
  const jitter = (a, b) => a + combatRoll() * (b - a);
  const rollCrit = (run) => combatRoll() < (run.player?.crit ?? 0);

  function nextId(run) {
    if (!Number.isFinite(run.nextId)) run.nextId = 1;
    return run.nextId++;
  }

  function weaponOf(source) {
    const w = source?.weapon ?? source?.sourceWeapon;
    return Number.isInteger(w) && w >= 0 && w < WEAPONS.length ? w : -1;
  }

  // ---- hit volumes -----------------------------------------------------------------------

  // Vertical body cylinder (spec combat §7.3). `bullet` gives squat monsters at least standing
  // height so chest-high rounds connect; blasts use the true scale. null = the player.
  // Returns a shared object, valid until the next call.
  function bodyBounds(e, bullet = false) {
    if (!e) {
      const p = ctx.run?.player,
        x = p?.x ?? 0,
        z = p?.z ?? 0,
        base = ground(x, z);
      body.x = x;
      body.z = z;
      body.radius = PLAYER_RADIUS;
      body.bottom = base + BODY_FOOT;
      body.top = base + BODY_HEIGHT;
      return body;
    }
    const g = e.model?.g,
      floor = ground(e.x, e.z),
      // Leaps lift the volume with the model; an arrival rising out of the ground stands on it.
      base = g ? Math.max(g.position.y, floor) : floor + (e.y || 0),
      scale = g ? g.scale.y : 1;
    body.x = e.x;
    body.z = e.z;
    body.radius = e.def?.radius ?? e.radius ?? 0.5;
    body.bottom = base + BODY_FOOT;
    body.top = base + BODY_HEIGHT * (bullet ? Math.max(1, scale) : scale);
    return body;
  }

  // A hazard prop's hit volume ({ o, x, z, r, bottom, top }, IMPROVEMENTS F10) as a body.
  function volumeBody(v) {
    propBody.x = v.x;
    propBody.z = v.z;
    propBody.radius = v.r;
    propBody.bottom = v.bottom;
    propBody.top = v.top;
    return propBody;
  }

  // Live, hittable enemies then encounter objects (hazard props excluded: only damage that
  // physically reaches them breaks them), written into `out` (default: a shared array valid
  // until the next call; pass your own when damage dealt inside the loop could re-enter).
  function targets(out = targetList) {
    out.length = 0;
    const run = ctx.run;
    if (!run) return out;
    for (const e of run.enemies) if (alive(e) && isHittable(e)) out.push(e);
    for (const o of run.objects) if (alive(o) && !isProp(o)) out.push(o);
    return out;
  }

  // ---- projectiles -----------------------------------------------------------------------

  function takeMesh(rocket, color) {
    const kind = rocket ? "rocket" : "bullet",
      mesh = spare[kind].pop() ?? new THREE.Mesh(SHAPES[kind].geometry);
    mesh.material = unlitMaterial(color);
    mesh.scale.copy(SHAPES[kind].scale);
    mesh.userData.shape = kind;
    mesh.visible = true;
    ctx.gfx?.layers?.effects?.add(mesh);
    return mesh;
  }

  function retireShot(shot) {
    shot.retired = true;
    shot.life = 0;
    const mesh = shot.mesh;
    if (!mesh) return;
    shot.mesh = null;
    mesh.removeFromParent();
    spare[mesh.userData.shape]?.push(mesh);
  }

  // KEEPERS enemy rounds fly faster with curses (speedScale, capped) and the Omen of Iron.
  function enemyShotScale(run) {
    if (run.original) return 1;
    return (ctx.director?.speedScale?.() ?? 1) * (ctx.rules?.mul?.("enemyShotSpeed") ?? 1);
  }

  // One projectile. Player shots take damage/pierce from shotStats unless overridden;
  // enemy shots (enemy = true) use the weapon-like numbers, aim at the player's chest from
  // the emitter's muzzle height, and carry `source` (placed where they were fired) as the
  // player's damage source. Hostile rounds without a colour are HOSTILE_ROUND.
  // opts: { emitter, source, pitch, y, speed, range, damage, color, pierce, weapon, kind,
  //         generation, group, shotId, hits }.
  function projectile(x, z, yaw, weapon, enemy = false, opts = {}) {
    const run = ctx.run,
      p = run?.player;
    if (!run || !weapon || run.shots.length >= MAX_SHOTS) return null;
    opts ??= {};
    const emitter = enemy ? (opts.emitter ?? null) : null;
    const speed = (opts.speed ?? weapon.speed) * (enemy ? enemyShotScale(run) : 1),
      range = opts.range ?? weapon.range;
    if (!(speed > 0) || !(range > 0)) return null;
    const y = opts.y ?? ground(x, z) + MUZZLE_HEIGHT * (emitter?.model?.g?.scale?.y || 1);
    const pitch =
      opts.pitch ??
      (enemy ? (p ? pitchTo(x, y, z, p.x, ground(p.x, p.z) + CHEST_HEIGHT, p.z) : 0) : p?.aimPitch || 0);
    const stats = enemy || !p ? null : shotStats(p, weapon, run.boons ?? {}, ledger(run));
    const color = opts.color ?? weapon.color ?? (enemy ? HOSTILE_ROUND : "#ffffff"),
      rocket = !!weapon.rocket,
      horizontal = Math.cos(pitch) * speed;
    const id = nextId(run);
    const shot = {
      id,
      shot: id, // the id every hit reports as source.shot
      enemy,
      weapon: enemy ? -1 : (opts.weapon ?? weapon.id ?? run.weapon ?? 0),
      kind: opts.kind ?? (rocket ? "rocket" : "bullet"),
      x,
      y,
      z,
      vx: Math.sin(yaw) * horizontal,
      vy: Math.sin(pitch) * speed,
      vz: Math.cos(yaw) * horizontal,
      dir: enemy ? null : { x: -Math.sin(yaw), z: -Math.cos(yaw) }, // where its hits come from (F1.4a)
      speed,
      life: range / speed,
      damage: opts.damage ?? (stats ? stats.damage : weapon.damage),
      pierce: opts.pierce ?? (stats ? stats.pierce : (weapon.pierce ?? 0)),
      hits: opts.hits ?? new Set(),
      rocket,
      radius: weapon.radius || 0,
      color,
      generation: opts.generation ?? 0,
      group: opts.group ?? (enemy ? null : {}),
      shotId: opts.shotId ?? shotSerial,
      origin: { x, y, z },
      source: enemy ? placedSource(opts.source ?? emitter?.kind ?? "Projectile", x, z) : null,
      emitter,
      mesh: null,
      impact: null, // last body hit point (Graveburst casts from it)
      split: false,
      detonated: false,
      retired: false,
      blockedBy: null, // the enemy whose blocking guard stopped it
      phased: false, // an enemy round already reported passing through a dash
    };
    shot.mesh = takeMesh(rocket, color);
    shot.mesh.position.set(x, y, z);
    shot.mesh.rotation.set(-pitch, yaw, 0, "YXZ");
    run.shots.push(shot);
    shotLedger.track(shot);
    return shot;
  }

  // ---- firing ----------------------------------------------------------------------------

  // Hold-to-autofire. The timer accumulates (+= interval) so stated fire rates are exact at
  // 60 Hz; while idle it rests at 0 so a fresh pull fires at once but never stores a burst.
  // player.shooting already folds in the assists' auto-fire.
  function updateFiring(dt) {
    const run = ctx.run,
      p = run?.player;
    if (!p) return;
    if (!Number.isFinite(run.fireTimer)) run.fireTimer = 0;
    run.fireTimer -= dt;
    if (!ctx.player?.shooting || p.hp <= 0) {
      if (run.fireTimer < 0) run.fireTimer = 0;
      return;
    }
    if (run.fireTimer > 0) return;
    fire();
    const w = WEAPONS[run.weapon] ?? WEAPONS[0];
    run.fireTimer = Math.max(0, run.fireTimer + shotStats(p, w, run.boons ?? {}).interval);
  }

  // One trigger pull of the selected weapon, plus its feel (recoil, muzzle light, particles,
  // sound, shake) and the Rift Echo hand-off.
  function fire() {
    const run = ctx.run,
      p = run?.player;
    if (!p) return;
    const slot = Number.isInteger(run.weapon) ? run.weapon : 0,
      w = WEAPONS[slot] ?? WEAPONS[0],
      rules = ledger(run);
    shotSerial++;
    if (run.tutorial) ctx.tutorial?.event?.("shoot", slot);
    const group = {},
      { count, spread } = shotStats(p, w, run.boons ?? {}, rules);
    for (let i = 0; i < count; i++) projectile(p.x, p.z, p.aim + volleyOffset(i, count, spread, jitter), w, false, { group, shotId: shotSerial });
    if (run.stats) run.stats.shots++;
    const target = ctx.player?.aimTarget?.(w.range, volleyTarget) ?? null;
    // The echo repeats the volley as fired: ledger damage and spread included.
    const damage = rules ? p.damage * rules.mul("playerDamage") * rules.mul("projectileDamage") : p.damage;
    ctx.mods?.onVolley?.({ weapon: slot, count, spread, shotId: shotSerial, damage, group, target });
    const feel = WEAPON_FEEDBACK[slot];
    p.recoil = ctx.env?.reduced ? feel.recoil * 0.35 : feel.recoil;
    ctx.gfx?.flash?.(p.x, ground(p.x, p.z) + MUZZLE_HEIGHT, p.z, w.color, reduceFlashes() ? feel.flash * REDUCED_MUZZLE : feel.flash);
    ctx.fx?.burst?.(p.x, MUZZLE_HEIGHT, p.z, w.color, feel.particles, 2);
    ctx.audio?.fx?.(w.sound);
    ctx.cam?.shake?.(feel.shake);
    ctx.bus.emit("fire", { weapon: slot, count });
  }

  // ---- shot update -----------------------------------------------------------------------

  function addHit(t, target, prop = false) {
    let record = hitList[hitCount];
    if (!record) hitList[hitCount] = record = { t: 0, target: null, prop: false };
    record.t = t;
    record.target = target;
    record.prop = prop;
    hitCount++;
    // Insertion sort: a step rarely crosses more than a couple of bodies.
    for (let i = hitCount - 1; i > 0 && hitList[i - 1].t > hitList[i].t; i--) {
      hitList[i] = hitList[i - 1];
      hitList[i - 1] = record;
    }
  }

  function scanBodies(list, shot, limit) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!alive(e) || isProp(e) || !isHittable(e) || shot.hits.has(e.id)) continue;
      const t = hitBody(from, to, bodyBounds(e, true));
      if (t !== null && t < limit) addHit(t, e);
    }
  }

  // Player shots also cross hazard props' hit volumes (KEEPERS).
  function scanProps(shot, limit) {
    const volumes = ctx.hazards?.hitVolumes?.();
    if (!volumes?.length) return;
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i];
      if (!v?.o || shot.hits.has(v.o.id)) continue;
      const t = hitBody(from, to, volumeBody(v));
      if (t !== null && t < limit) addHit(t, v, true);
    }
  }

  function collectHits(shot, limit) {
    hitCount = 0;
    const run = ctx.run;
    if (!shot.enemy) {
      scanBodies(run.enemies, shot, limit);
      scanBodies(run.objects, shot, limit);
      if (!run.original) scanProps(shot, limit);
      return;
    }
    const p = run.player;
    if (!p) return;
    const t = hitBody(from, to, bodyBounds(null));
    if (t === null || t >= limit) return;
    // Phase dash: bullets pass through a dashing player (Wave-1), which still reports the hit
    // once as "phased" (IMPROVEMENTS F1.4f). Post-hit invulnerability still eats them.
    if (!(p.dashing > 0)) addHit(t, null);
    else if (!shot.phased) {
      shot.phased = true;
      ctx.player?.hurt?.(shot.damage, shot.source);
    }
  }

  function setPoint(out, t) {
    out.x = from.x + (to.x - from.x) * t;
    out.y = from.y + (to.y - from.y) * t;
    out.z = from.z + (to.z - from.z) * t;
    return out;
  }

  // Ends the shot at `t` along this step's segment (point in `stop`).
  function stopAt(shot, t) {
    setPoint(stop, t);
    shot.life = 0;
  }

  // Resolve the body hits of one step in order. Returns true when the shot stopped (point in
  // `stop`).
  function resolveHits(shot) {
    const run = ctx.run;
    for (let k = 0; k < hitCount; k++) {
      const { t, target, prop } = hitList[k];
      if (shot.enemy) {
        stopAt(shot, t);
        ctx.player?.hurt?.(shot.damage, shot.source);
        return true;
      }
      if (prop) {
        if (hitProp(shot, target, t)) return true;
        continue;
      }
      shot.hits.add(target.id);
      if (shot.rocket) {
        stopAt(shot, t);
        impact(shot, stop);
        return true;
      }
      const point = setPoint((shot.impact ??= { x: 0, y: 0, z: 0 }), t);
      const critical = rollCrit(run),
        dealt = strike(target, shot.damage * (critical ? 2 : 1), critical, shot, null);
      // A kill can end the run or start a cinematic that clears every shot mid-step.
      if (shot.retired) return true;
      // A blocking guard (the Castellan's vigil) ends the round, pierce and all.
      if (shot.blockedBy === target.id) {
        stopAt(shot, t);
        return true;
      }
      if (!target.fixed) {
        if (shot.weapon === LANCER) ctx.fx?.hitstop?.(HITSTOP_LANCER);
      } else if (dealt > 0 && !(target.hp > 0)) {
        // Breaking an anchor or node counts as a pellet kill for Graveburst, as in the original.
        ctx.mods?.onKill?.(target, shot);
      }
      ctx.mods?.onHit?.(shot, target, point);
      if (--shot.pierce < 0) {
        stopAt(shot, t);
        return true;
      }
    }
    return false;
  }

  // A prop's hit volume takes a bullet's raw damage (no crit, no multipliers) and costs a
  // pierce; a rocket bursts there and its blast reaches the prop.
  function hitProp(shot, v, t) {
    if (shot.rocket) {
      stopAt(shot, t);
      impact(shot, stop);
      return true;
    }
    shot.hits.add(v.o.id);
    ctx.hazards?.hurtProp?.(v.o, shot.damage, shot);
    if (shot.retired) return true;
    if (--shot.pierce < 0) {
      stopAt(shot, t);
      return true;
    }
    return false;
  }

  // A bullet stopped by a cover a prop owns (beacon runes, crystal spires) damages that prop.
  function coverHit(shot, wall) {
    const o = wall.cover ? ctx.hazards?.propForCover?.(wall.cover) : null;
    if (!o || shot.hits.has(o.id)) return;
    shot.hits.add(o.id);
    ctx.hazards.hurtProp?.(o, shot.damage, shot);
  }

  function stepShot(shot, dt) {
    if (shot.retired || shot.life <= 0) return;
    const travel = Math.min(dt, Math.max(0, shot.life));
    from.x = shot.x;
    from.y = shot.y;
    from.z = shot.z;
    to.x = shot.x + shot.vx * travel;
    to.y = shot.y + shot.vy * travel;
    to.z = shot.z + shot.vz * travel;
    shot.life -= dt;
    const wall = ctx.world?.trace?.(from, to) ?? null;
    collectHits(shot, wall ? wall.t : 1);
    let stopped = resolveHits(shot);
    if (shot.retired) return;
    if (!stopped && wall) {
      stopped = true;
      stopAt(shot, Math.max(0, wall.t - WALL_PULLBACK));
      if (shot.rocket) impact(shot, stop);
      else {
        if (!shot.enemy && !ctx.run.original) coverHit(shot, wall);
        ctx.fx?.burst?.(stop.x, stop.y - ground(stop.x, stop.z), stop.z, COLORS.stone, 5, 1.5);
        if (!shot.enemy) {
          ctx.audio?.fx?.("impactStone", 0.65, stop);
          ctx.audio?.ricochet?.(stop);
        }
      }
      if (shot.retired) return;
    }
    const end = stopped ? stop : to;
    if (!shot.enemy) {
      ctx.mods?.onTravel?.(shot, from, end);
      if (shot.speed >= FAST_ROUND) ctx.fx?.tracer?.(from, end, shot.color);
    }
    shot.x = end.x;
    shot.y = end.y;
    shot.z = end.z;
    shot.mesh?.position.set(shot.x, shot.y, shot.z);
    if (shot.rocket && shot.life > 0 && Math.random() < 0.5)
      ctx.fx?.burst?.(shot.x, shot.y - ground(shot.x, shot.z), shot.z, COLORS.smoke, 1, 0.7);
    // A rocket that runs out of range airbursts where it is.
    if (shot.life <= 0 && !stopped && shot.rocket) impact(shot, shot);
  }

  // Moves every shot one step, then the weapon-mod effects and (KEEPERS) the ground zones.
  // Shots created mid-step (splinters, fragments) fly in the same step, like the original's
  // live list.
  function update(dt) {
    const run = ctx.run;
    if (!run) return;
    ctx.mods?.tick?.(dt);
    const shots = run.shots;
    for (let i = 0; i < shots.length; i++) stepShot(shots[i], dt);
    let kept = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      if (shot.life > 0 && !shot.retired) shots[kept++] = shot;
      else shotLedger.drop(shot);
    }
    shots.length = kept;
    shotLedger.reconcile(shots);
    ctx.mods?.tickEffects?.(dt);
    if (!run.original) tickZones(run, dt);
  }

  // Rocket detonation, resolved once per rocket: Event Horizon may take it over.
  function impact(shot, point) {
    if (shot.detonated) return;
    shot.detonated = true;
    if (!ctx.mods?.onImpact?.(shot, point)) explode(point.x, point.z, shot.radius, shot.damage, false, point.y, shot);
  }

  // ---- damage to monsters ----------------------------------------------------------------

  // Returns the damage dealt (0 when refused). Callers detect kills with e.hp <= 0.
  function hurtEnemy(e, damage, critical = false, source = {}) {
    return strike(e, damage, critical, source ?? {}, null);
  }

  // Every monster hit enters here. `blast` = the explosion centre (explode passes it; a
  // caller's source.blast works too) for the guard's bearing.
  function strike(e, damage, critical, source, blast) {
    const run = ctx.run;
    if (!run || !e || e.dead || !(e.hp > 0) || run.victory || ctx.cinematic) return 0;
    if (e.fixed) return hurtFixed(run, e, damage, source);
    if (run.original) return originalHit(run, e, damage, critical, source);
    if (!isHittable(e)) return 0;
    return keepersHit(run, e, damage, critical, source, blast);
  }

  // Anchors, nodes and props: encounters takes the hit as dealt. KEEPERS anchors and nodes
  // take the ledger's bossDamage (pipeline step 4); props ignore every multiplier.
  function hurtFixed(run, o, damage, source) {
    if (!run.original && !isProp(o)) damage *= ctx.rules?.mul?.("bossDamage") ?? 1;
    return ctx.encounters?.hurtObject?.(o, damage, source) ?? 0;
  }

  // The Wave-1 multipliers, verbatim (ORIGINAL): anchors, the Maw stagger / Warden exposure
  // window and Insta Kill.
  function originalDamage(run, e, damage, source) {
    if (e.trialElite) damage *= anchorMultiplier(liveAnchors(run, e));
    if (e.state === "stagger" || e.recovery > 0) damage *= CHALLENGE.quarryVulnerability;
    if (run.boons?.execution > 0 && !source.environment)
      damage = isWarden(e) || isMiniboss(e) || e.trialElite ? damage * 1.5 : Math.max(damage, e.hp);
    return damage;
  }

  function originalHit(run, e, damage, critical, source) {
    damage = originalDamage(run, e, damage, source);
    const slot = weaponOf(source);
    if (slot >= 0 && run.stats?.damage) run.stats.damage[slot] += Math.min(e.hp, damage);
    e.hp -= damage;
    hitFeedback(e, slot, critical, source);
    showNumber(e, damage, critical, undefined);
    ctx.bus.emit("enemyHit", { e, damage, critical, source, arc: null, preExec: damage });
    if (e.hp <= 0 && !e.dead) kill(run, e, source, critical);
    return damage;
  }

  function liveAnchors(run, e) {
    let anchors = 0;
    for (const o of run.objects) if (alive(o) && o.owner === e.trialId) anchors++;
    return anchors;
  }

  // Step 3's window: the AI's own e.vuln, else the Wave-1 Maw stagger / Warden exposure.
  const windowOf = (e) => e.vuln ?? (e.state === "stagger" || e.recovery > 0 ? CHALLENGE.quarryVulnerability : 1);

  // The KEEPERS pipeline (IMPROVEMENTS F1.4b), steps 1-6; applyDamage runs steps 7-9.
  function keepersHit(run, e, damage, critical, source, blast) {
    const g = guardOf(e);
    let arc = null,
      m1 = 1;
    if (g) {
      arc = classifyHit(e, source, blast, run.player, arcInfo).arc;
      m1 = arcMult(g, arc);
      guardHit(e, g, arc, m1, source);
    }
    const m2 = e.trialElite ? anchorMultiplier(liveAnchors(run, e)) : 1;
    const v = windowOf(e);
    const m4 = (bossLike(e) ? (ctx.rules?.mul?.("bossDamage") ?? 1) : 1) * (ctx.relics?.hitMul?.(e, source) ?? 1);
    const preExec = damage * m1 * m2 * v * m4;
    damage = scaledHit(damage, m1, m2, v, m4, executes(run.boons, source), e);
    if (!(damage > 0)) return 0;
    const tone = arc === "front" && m1 < 1 ? COLORS.absorbed : arc === "rear" && m1 > 1 ? COLORS.exposed : undefined;
    // BOUND: split after the multipliers; the partner's half enters at the shell (step 7).
    const partner = e.partner;
    if (partner && partner !== e && alive(partner) && isHittable(partner)) {
      damage /= 2;
      applyDamage(run, partner, damage, critical, source, null, damage, undefined);
    }
    return applyDamage(run, e, damage, critical, source, arc, preExec, tone);
  }

  // Every guarded hit reports its arc (bus "guardHit"); a blocking guard's front stops a bullet
  // and hands it to the keeper AI (the Castellan's reflection).
  function guardHit(e, g, arc, mult, source) {
    const bullet = isBullet(source),
      blocked = !!g.block && arc === "front" && bullet,
      at = bullet ? source.impact : null;
    ctx.bus.emit("guardHit", {
      e,
      arc,
      mult,
      blocked,
      x: at?.x ?? e.x,
      y: at?.y ?? ground(e.x, e.z) + CHEST_HEIGHT,
      z: at?.z ?? e.z,
    });
    if (!blocked) return;
    source.blockedBy = e.id;
    ctx.bosses?.onBlocked?.(e, source);
  }

  // Steps 7-9: the shell, the phase-gate floor, HP, and the kill. Grey numbers show what the
  // shell and the gate absorbed. Returns the HP taken.
  function applyDamage(run, e, damage, critical, source, arc, preExec, tone) {
    let absorbed = 0;
    if (e.shell > 0) {
      absorbed = Math.min(e.shell, damage);
      e.shell -= absorbed;
      damage -= absorbed;
      if (e.shell <= 0) {
        e.shell = 0;
        ctx.elites?.onShellBreak?.(e);
      }
    }
    const floor = ctx.bosses?.gateFloor?.(e) ?? 0;
    const dealt = Math.min(damage, Math.max(0, e.hp - floor));
    if (floor > 0) absorbed += damage - dealt;
    const slot = weaponOf(source);
    if (slot >= 0 && run.stats?.damage) run.stats.damage[slot] += dealt;
    e.hp -= dealt;
    hitFeedback(e, slot, critical, source);
    if (dealt > 0) showNumber(e, dealt, critical, tone);
    if (absorbed > 0) ctx.fx?.number?.(e.x, null, e.z, absorbed, greyOptions);
    ctx.bus.emit("enemyHit", { e, damage: dealt, critical, source, arc, preExec });
    if (e.hp <= 0 && !e.dead) kill(run, e, source, critical);
    return dealt;
  }

  function hitFeedback(e, slot, critical, source) {
    const feel = WEAPON_FEEDBACK[slot];
    e.flash = HIT_TIME;
    e.squash = feel?.recoil ?? NEUTRAL_RECOIL;
    e.lastSource = source;
    ctx.fx?.burst?.(e.x, 1.2, e.z, critical ? COLORS.crit : (WEAPONS[slot]?.color ?? COLORS.neutral), feel?.hit ?? 3, 2);
    ctx.audio?.fx?.("fleshHit", 0.55, e);
  }

  function showNumber(e, amount, critical, color) {
    numberOptions.crit = critical;
    numberOptions.target = e;
    numberOptions.color = color;
    ctx.fx?.number?.(e.x, null, e.z, amount, numberOptions);
    numberOptions.target = null;
  }

  // Contract §7 kill order: dead -> kind death effects -> trial bookkeeping -> drops ->
  // director (score, kill tallies, portal) -> mods -> "enemyKilled" (profile, audio, gibs).
  // KEEPERS shards carry the ledger's xpMult; relic bursts never trigger mods.
  function kill(run, e, source, critical) {
    e.dead = true;
    const def = e.def ?? {},
      color = def.color ?? COLORS.neutral;
    ctx.fx?.burst?.(e.x, 1.2, e.z, color, e.kind === "brute" ? 32 : 18, 4);
    ctx.fx?.ring?.(e.x, e.z, color, 1.4, 0.3);
    if (critical) ctx.fx?.hitstop?.(HITSTOP_CRIT_KILL);
    ctx.enemies?.onDeath?.(e, source);
    ctx.encounters?.trialDefeat?.(e);
    // The Warden leaves nothing behind: its fall is the victory cinematic. The powerup roll
    // is told which monster fell (elites have their own drop rules).
    if (!isWarden(e)) {
      if (!run.tutorial && def.xp > 0) ctx.encounters?.dropPowerup?.(e.x, e.z, undefined, e);
      const xp = def.xp ?? 0;
      ctx.encounters?.dropGem?.(e.x, e.z, run.original ? xp : xp * (ctx.rules?.mul?.("xpMult") ?? 1));
    }
    ctx.director?.onKill?.(e, source);
    if (!source.noMods) ctx.mods?.onKill?.(e, source);
    ctx.bus.emit("enemyKilled", { e, source, critical });
  }

  // ---- explosions ------------------------------------------------------------------------

  // True when the blast at (x, y, z) reaches the nearest point of the target's true-scale body
  // with a clear line (ridges and cover block splash). null = the player.
  function affects(target, x, y, z, radius) {
    const b = bodyBounds(target);
    losTo.x = b.x;
    losTo.y = clamp(y, b.bottom, b.top);
    losTo.z = b.z;
    if (Math.hypot(losTo.x - x, losTo.y - y, losTo.z - z) >= radius + b.radius) return false;
    losFrom.x = x;
    losFrom.y = y + 0.08;
    losFrom.z = z;
    return !ctx.world?.trace?.(losFrom, losTo, 0);
  }

  // The same test against a prop's hit volume; the prop's own cover never shields it.
  function reachesProp(v, x, y, z, radius) {
    losTo.x = v.x;
    losTo.y = clamp(y, v.bottom, v.top);
    losTo.z = v.z;
    if (Math.hypot(losTo.x - x, losTo.y - y, losTo.z - z) >= radius + v.r) return false;
    losFrom.x = x;
    losFrom.y = y + 0.08;
    losFrom.z = z;
    const hit = ctx.world?.trace?.(losFrom, losTo, 0);
    return !hit || (!!hit.cover && ctx.hazards?.propForCover?.(hit.cover) === v.o);
  }

  // The blast's look: the Wave-1 burst, ring, scorch, shake, sound and rumble, or for a relic
  // burst (source.ring) just a small ring in that colour.
  function blastFx(x, y, z, floor, radius, enemy, source) {
    if (source.ring) {
      ctx.fx?.ring?.(x, z, source.ring, radius, RELIC_RING_LIFE);
      return;
    }
    ctx.fx?.burst?.(x, y - floor, z, enemy ? COLORS.enemyBlast : COLORS.playerBlast, 38, 7);
    ctx.fx?.ring?.(x, z, COLORS.blastRing, radius, 0.45);
    // Only blasts near the ground scorch it (a rocket timing out in the air leaves no mark).
    if (y - floor < radius) ctx.fx?.decal?.(x, z, COLORS.scorch, radius * 0.6, SCORCH_LIFE);
    ctx.cam?.shake?.(BLAST_SHAKE);
    ctx.audio?.fx?.("explosion", 1, { x, z });
    if (!enemy) ctx.input?.rumble?.(0.35, 120);
  }

  // Full damage anywhere inside radius + target radius (no falloff). Player blasts roll one
  // crit for the whole blast (none with source.noCrit). Enemy blasts hurt the player (cause =
  // source.source, placed at the blast) and hurt monsters only with source.friendlyFire (at
  // source.monsterDamage when given; source.environment blocks Insta Kill). KEEPERS blasts also
  // reach hazard props (player blasts and friendly fire) and feed Ember Reliquary.
  // source (player blasts): { weapon, relic, noCrit, noMods, nova, ring } plus shot fields.
  function explode(x, z, radius, damage, enemy = false, y, source = {}) {
    const run = ctx.run;
    if (!run) return;
    source ??= {};
    const floor = ground(x, z);
    if (!Number.isFinite(y)) y = floor + BLAST_HEIGHT;
    const critical = !enemy && !source.noCrit && rollCrit(run);
    const dealt = critical ? damage * 2 : damage;
    blastFx(x, y, z, floor, radius, enemy, source);
    const blast = { x, z };
    if (enemy) {
      if (run.player && affects(null, x, y, z, radius)) ctx.player?.hurt?.(dealt, placedSource(source.source ?? "Blast", x, z));
      if (!source.friendlyFire) return;
      const monsters = source.monsterDamage ?? dealt;
      blastList(run.enemies, x, y, z, radius, monsters, false, source, blast);
      if (!run.original) blastProps(x, y, z, radius, monsters, source);
      return;
    }
    blastList(run.enemies, x, y, z, radius, dealt, critical, source, blast);
    blastList(run.objects, x, y, z, radius, dealt, critical, source, blast);
    if (run.original) return;
    blastProps(x, y, z, radius, damage, source);
    ctx.relics?.onBlast?.(x, z, source);
  }

  // Captured length: monsters spawned by these kills (splitter children) are not in the blast.
  function blastList(list, x, y, z, radius, damage, critical, source, blast) {
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (alive(e) && !isProp(e) && isHittable(e) && !immuneTo(source.immune, e) && affects(e, x, y, z, radius)) strike(e, damage, critical, source, blast);
    }
  }

  // Props take the blast's raw damage (no crit).
  function blastProps(x, y, z, radius, damage, source) {
    const volumes = ctx.hazards?.hitVolumes?.();
    if (!volumes?.length) return;
    for (let i = 0, n = volumes.length; i < n; i++) {
      const v = volumes[i];
      if (v?.o && reachesProp(v, x, y, z, radius)) ctx.hazards.hurtProp?.(v.o, damage, source);
    }
  }

  // ---- hazards ---------------------------------------------------------------------------

  // Delayed ground blast with a danger marker (brute slam, mortar shell, leaper landing, hexer
  // cross, warden blasts, node collapse and every keeper strike). `owner` = the emitter's trial
  // id for trial cleanup. `cause` = the player's damage source if it lands: { id, label }, an
  // id, or the options form { source, eta, friendlyFire, monsterDamage, immune, shape, sx, sz,
  // yaw, emitter } (read now, so a reused options object is safe). shape "box" strikes a yawed
  // box of sx, sz half-extents (the Castellan's grid). friendlyFire hurts monsters too, at
  // monsterDamage (default: damage), sparing those named in immune (kinds or keeper ids). The
  // marker's meta carries eta (default: the fuse) and whether the footprint targets the player
  // (F16.2).
  function hazard(x, z, radius, damage, delay, kind, owner = null, cause = kind) {
    const run = ctx.run;
    if (!run) return null;
    const opts = cause && typeof cause === "object" && "source" in cause ? cause : null;
    const source = opts ? opts.source : cause;
    const box = opts?.shape === "box";
    const h = {
      x,
      z,
      y: ground(x, z),
      radius,
      damage,
      life: delay,
      max: delay,
      kind,
      owner: owner ?? null,
      source: source ?? kind,
      shape: box ? "box" : "circle",
      sx: box ? (opts.sx ?? radius) : 0,
      sz: box ? (opts.sz ?? radius) : 0,
      yaw: box ? (opts.yaw ?? 0) : 0,
      friendlyFire: !!opts?.friendlyFire,
      monsterDamage: opts?.monsterDamage ?? damage,
      immune: opts?.immune ?? null,
      marker: null,
    };
    const meta = { owner: opts?.emitter?.id ?? null, eta: opts?.eta ?? delay, started: run.elapsed ?? 0, targetsPlayer: targetsPlayer(run, h) };
    h.marker = (box ? ctx.tele?.cell?.(x, z, Math.max(h.sx, h.sz), kind, meta) : ctx.tele?.area?.(x, z, radius, kind, meta)) ?? null;
    run.hazards.push(h);
    hazardLedger.track(h);
    ctx.audio?.fx?.(AIM_WARNED.has(kind) ? "warnAim" : "warnGround", 1, h);
    return h;
  }

  function targetsPlayer(run, h) {
    const p = run.player;
    if (!p) return false;
    const reach = h.shape === "box" ? Math.hypot(h.sx, h.sz) : h.radius;
    return Math.hypot(p.x - h.x, p.z - h.z) - reach < TARGETS_PLAYER;
  }

  // Fuses burn down; markers brighten 0.45 -> 0.95 and fill with the countdown.
  function updateHazards(dt) {
    const run = ctx.run;
    if (!run) return;
    const list = run.hazards;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      h.life -= dt;
      if (h.life > 0) {
        const fuse = 1 - h.life / h.max;
        markerState.opacity = 0.45 + fuse * 0.5;
        markerState.progress = fuse;
        if (h.marker) ctx.tele?.set?.(h.marker, markerState);
        continue;
      }
      hazardLedger.drop(h);
      if (h.shape === "box") boxBlast(run, h);
      else if (h.friendlyFire) explode(h.x, h.z, h.radius, h.damage, true, undefined, friendlySource(h));
      else {
        hazardBlast.source = h.source ?? h.kind;
        explode(h.x, h.z, h.radius, h.damage, true, undefined, hazardBlast);
      }
    }
    let kept = 0;
    for (let i = 0; i < list.length; i++) if (list[i].life > 0) list[kept++] = list[i];
    list.length = kept;
    hazardLedger.reconcile(list);
  }

  const friendlySource = (h) => ({ source: h.source ?? h.kind, friendlyFire: true, monsterDamage: h.monsterDamage, environment: true, immune: h.immune });

  // A friendly-fire strike's immune list names kinds or keeper ids (the keeper kit passes its
  // own actor's), so a keeper is never struck by its own strikes (the Castellan's grid).
  const immuneTo = (list, e) => !!list?.length && (list.includes(e.kind) || (e.keeper != null && list.includes(e.keeper)));

  // A box strike hits everything standing in its footprint (a column of light from above:
  // cover does not shield it).
  function boxBlast(run, h) {
    const p = run.player;
    ctx.fx?.burst?.(h.x, BLAST_HEIGHT, h.z, COLORS.enemyBlast, 18, 4);
    if (p && insideBox(p.x - h.x, p.z - h.z, h.sx, h.sz, h.yaw, PLAYER_RADIUS)) ctx.player?.hurt?.(h.damage, placedSource(h.source ?? h.kind, h.x, h.z));
    if (!h.friendlyFire) return;
    const source = friendlySource(h),
      list = run.enemies;
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (alive(e) && isHittable(e) && !immuneTo(h.immune, e) && insideBox(e.x - h.x, e.z - h.z, h.sx, h.sz, h.yaw, e.def?.radius ?? 0.5))
        strike(e, h.monsterDamage, false, source, h);
    }
  }

  // ---- ground zones (IMPROVEMENTS F1.4c) -------------------------------------------------

  // zone(x, z, radius, opts) -> Zone | null (KEEPERS only). opts: { life = 4, tick = 0.5,
  // playerDamage, monsterDamage, slow = 1, shape: "circle" | "box" (sx, sz half-extents, yaw),
  // friendly, weapon, relic, immune: [kinds], source: { id, label }, owner, trail, visual }.
  // The first tick lands on the zone's first step, then one every `tick` seconds. A friendly
  // (player-owned) zone never touches the player and credits `weapon`; every zone's monster
  // damage is environment damage. owner "world" (lava) lives in run.worldZones, outside the
  // 32-zone cap; at the cap trail zones go first, then friendly ones, then the oldest.
  function zone(x, z, radius, opts = {}) {
    const run = ctx.run;
    if (!run || run.original) return null;
    opts ??= {};
    const friendly = !!opts.friendly,
      weapon = Number.isInteger(opts.weapon) ? opts.weapon : -1,
      life = opts.life ?? ZONE_DEFAULTS.life,
      source = opts.source ?? ZONE_DEFAULTS.source,
      box = opts.shape === "box";
    const record = {
      id: nextId(run),
      x,
      z,
      radius,
      life,
      max: life,
      tick: opts.tick ?? ZONE_DEFAULTS.tick,
      playerDamage: opts.playerDamage ?? 0,
      monsterDamage: opts.monsterDamage ?? 0,
      slow: opts.slow ?? 1,
      shape: box ? "box" : "circle",
      sx: box ? (opts.sx ?? radius) : 0,
      sz: box ? (opts.sz ?? radius) : 0,
      yaw: box ? (opts.yaw ?? 0) : 0,
      friendly,
      weapon,
      immune: opts.immune ?? [],
      source,
      owner: opts.owner ?? null,
      trail: !!opts.trail,
      visual: opts.visual === undefined ? ZONE_DEFAULTS.visual : opts.visual,
      born: run.elapsed ?? 0,
      wait: 0,
      handle: null,
      dead: false,
      playerSource: { id: source.id, label: source.label, x, z },
      monsterSource: { weapon: friendly ? weapon : -1, kind: "zone", environment: true, zone: true, player: friendly, relic: !!opts.relic },
    };
    if (ticking) pendingZones.push(record);
    else insertZone(run, record);
    return record;
  }

  function insertZone(run, record) {
    if (record.owner === "world") (run.worldZones ??= []).push(record);
    else {
      const list = (run.zones ??= []);
      if (list.length >= ZONE_CAP) removeZone(list[evictionIndex(list)]);
      list.push(record);
    }
    if (record.visual) record.handle = ctx.fx?.zone?.(record) ?? null;
  }

  // Marks a zone gone and drops its visual; the lists compact outside the zone tick.
  function releaseZone(record) {
    if (record.dead) return;
    record.dead = true;
    record.life = 0;
    if (record.handle) ctx.fx?.removeZone?.(record.handle);
    record.handle = null;
  }

  function compactZones(list) {
    if (!list) return;
    let kept = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead) list[kept++] = list[i];
    list.length = kept;
  }

  function removeZone(record) {
    if (!record) return;
    releaseZone(record);
    if (ticking || !ctx.run) return;
    compactZones(ctx.run.zones);
    compactZones(ctx.run.worldZones);
  }

  // Zones of `owner` (a keeper id, "relic", "world", ...), or every zone. Returns the count.
  function clearZones(owner) {
    let removed = 0;
    const drop = (list) => {
      for (const record of list ?? [])
        if (!record.dead && (owner === undefined || record.owner === owner)) {
          releaseZone(record);
          removed++;
        }
    };
    const run = ctx.run;
    drop(run?.zones);
    drop(run?.worldZones);
    drop(pendingZones);
    compactZones(pendingZones);
    if (!ticking && run) {
      compactZones(run.zones);
      compactZones(run.worldZones);
    }
    return removed;
  }

  function tickZones(run, dt) {
    ticking = true;
    try {
      tickZoneList(run, run.zones, dt);
      tickZoneList(run, run.worldZones, dt);
    } finally {
      ticking = false;
    }
    compactZones(run.zones);
    compactZones(run.worldZones);
    while (pendingZones.length) insertZone(run, pendingZones.shift());
  }

  function tickZoneList(run, list, dt) {
    if (!list?.length) return;
    for (let i = 0; i < list.length; i++) {
      const record = list[i];
      if (record.dead) continue;
      record.life -= dt;
      if (record.life <= 0) {
        releaseZone(record);
        continue;
      }
      if (record.wait <= ZONE_EARLY) {
        record.wait += record.tick;
        applyZone(run, record);
      }
      record.wait -= dt;
    }
  }

  // One damage tick: the player (unless friendly, or Ash Salts against Lava and Cinders), then
  // every monster standing in it that is not immune. Objects are never touched.
  function applyZone(run, record) {
    const p = run.player;
    if (!record.friendly && record.playerDamage > 0 && p && p.hp > 0 && !burnsHarmlessly(record) && insideZone(record, p.x, p.z, PLAYER_RADIUS))
      ctx.player?.hurt?.(record.playerDamage, record.playerSource);
    if (!(record.monsterDamage > 0)) return;
    const list = run.enemies;
    for (let i = 0, n = list.length; i < n && !record.dead; i++) {
      const e = list[i];
      if (!alive(e) || !isHittable(e) || record.immune.includes(e.kind)) continue;
      if (insideZone(record, e.x, e.z, e.def?.radius ?? 0.5)) strike(e, record.monsterDamage, false, record.monsterSource, null);
    }
  }

  const burnsHarmlessly = (record) => BURNS.has(record.source.id) && !!ctx.rules?.flag?.("burnImmune");

  // The slowest `slow` among the zones a body of `radius` at (x, z) stands in: 1 when none.
  // kind = the monster's kind (its immune zones are skipped); null = the player, whom friendly
  // zones never touch. (player.moveMul and enemies.slowMul read it.)
  function zoneSlow(x, z, radius, kind = null) {
    const run = ctx.run;
    if (!run || run.original) return 1;
    return slowIn(run.worldZones, x, z, radius, kind, slowIn(run.zones, x, z, radius, kind, 1));
  }

  function slowIn(list, x, z, radius, kind, slow) {
    if (!list) return slow;
    for (let i = 0; i < list.length; i++) {
      const record = list[i];
      if (record.dead || record.slow >= slow || (kind === null ? record.friendly : record.immune.includes(kind))) continue;
      if (insideZone(record, x, z, radius)) slow = record.slow;
    }
    return slow;
  }

  // ---- directional guard (IMPROVEMENTS F1.4a) ---------------------------------------------

  // hitArc(e, source) -> { arc: "front" | "side" | "rear", angle } (degrees from e's facing),
  // with source.dir (shots), source.blast (explosions) or the player's bearing.
  function hitArc(e, source = {}) {
    return classifyHit(e, source ?? {}, null, ctx.run?.player ?? null, { arc: "side", angle: 0 });
  }

  // ---- lifecycle -------------------------------------------------------------------------

  // Removes the shots matching `predicate` (e.g. an abandoned trial's rounds). Returns the count.
  function removeShots(predicate) {
    const shots = ctx.run?.shots;
    if (!shots) return 0;
    let kept = 0,
      removed = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      if (predicate(shot)) {
        shotLedger.drop(shot);
        removed++;
      } else shots[kept++] = shot;
    }
    shots.length = kept;
    return removed;
  }

  // Removes the pending hazards matching `predicate` without detonating them. Returns the count.
  function removeHazards(predicate) {
    const list = ctx.run?.hazards;
    if (!list) return 0;
    let kept = 0,
      removed = 0;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (predicate(h)) {
        hazardLedger.drop(h);
        h.life = 0;
        removed++;
      } else list[kept++] = h;
    }
    list.length = kept;
    return removed;
  }

  // Every shot and hazard (stage entry, cinematic start, boss summon). Zones are kept: they
  // freeze with sim time through sequences.
  function clearShots() {
    shotLedger.releaseAll();
    hazardLedger.releaseAll();
    const run = ctx.run;
    if (!run) return;
    if (run.shots) run.shots.length = 0;
    if (run.hazards) {
      for (const h of run.hazards) h.life = 0;
      run.hazards.length = 0;
    }
  }

  // Run start and stage change (the director's resets, before the next stage is built): shots,
  // hazards and every zone.
  function clear() {
    clearShots();
    clearZones();
  }

  ctx.bus.on("runStart", () => {
    shotSerial = 0;
    clearShots();
    if (ctx.run) ctx.run.fireTimer = 0;
  });
  ctx.bus.on("stageEnter", clearShots);
  ctx.bus.on("sequence", (event) => {
    if (event?.active) clearShots();
  });

  return {
    updateFiring,
    fire,
    projectile,
    update,
    updateHazards,
    hurtEnemy,
    explode,
    hazard,
    targets,
    clear,
    bodyBounds,
    removeShots,
    removeHazards,
    hitArc,
    zone,
    // zones() -> the live capped zones (run.zones); world zones live in run.worldZones.
    zones: () => ctx.run?.zones ?? [],
    clearZones,
    removeZone,
    zoneSlow,
  };
}
