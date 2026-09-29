// The hero: fresh run stats, walking and the phase dash, aim resolution (stick with vertical
// assist and the aim-assist tiers, mouse raycast, movement facing, the attract pilot), weapon
// switching, damage intake with its result codes, heals and drains, max integrity and dash
// charges from the Rules Ledger, and the hero model's transform, 15 fps animation,
// invulnerability blink (or dither) and ground ring.
import * as THREE from "three";
import { PLAYER_DEFAULTS, DASH, TRAIL_COLORS } from "../data/progression.js";
import { WEAPONS } from "../data/weapons.js";
import { ALL_DEFS } from "../data/defs.js";
import { RELIC_TUNING } from "../data/relics.js";
import { createHero, equipWeapon, animateCharacter } from "../render/models.js";
import { unlitMaterial } from "../render/materials.js";
import { traceWorld } from "../world/ballistics.js";
import { EXTENT } from "../world/terrain.js";
import { clamp, movementVector, movementResponse, wrapAngle } from "../core/util.js";
import { pitchTo } from "./combat.js";

const MUZZLE_HEIGHT = 1.47;
const AIM_LIFT = 1.2; // mouse aim points sit this far above the ground (chest height)
const RADIUS = 0.45;
const SPEED_BOOST = 1.3;
const STICK_AIM = 0.18; // aim-stick deflection that takes over aiming
const FACING_INPUT = 0.1; // movement that turns an idle, non-aiming hero
const WALK_ANIM = 5; // m/s of walking that plays the full stride
const RECOIL_DECAY = 9;
const BLINK_RATE = 24; // invulnerability blink: visible on even 1/24 s slots (12 Hz)
const DITHER_OPACITY = 0.5; // Reduce flashes: the blink becomes a steady alpha-hash dither
const ASSIST_CONE = 0.18; // rad either side of the stick bearing
const AIM_RAY = 230; // camera far plane
const HURT_INVULNERABILITY = 0.6;
const HURT_SHAKE = 0.22;
const DASH_TRAIL_HEIGHT = 0.6;
const WAKE_HEIGHT = 0.15;
const MIN_MAX = 40; // the ledger never takes max integrity below this
const MAX_DASHES = 4;
const REGEN_POP = 10; // Repair field reports its healing in 10-point pops
const BURST_AFFIXES = new Set(["molten", "shardborn"]); // Hunter's Mark immunity
const RING = Object.freeze({ inner: 0.63, outer: 0.69, segments: 12, color: "#a2fff1", opacity: 0.55, lift: 0.05 });
const COLORS = Object.freeze({ dash: "#98ffff", hurt: "#ff7193" });
const NO_COVERS = Object.freeze([]);

// Readable run-report causes for sources that arrive as bare ids (monster kinds and keepers are
// named from their tables; anything else reads as its own id).
const CAUSE_LABELS = Object.freeze({
  slam: "Brute slam",
  mortar: "Mortar shell",
  leap: "Leaper landing",
  hex: "Hexer cross",
  warden: "Rift Warden",
  "warden-node": "Rift collapse",
  ironmaw: "Iron Maw",
  vent: "Trial vent",
});
const UNKNOWN_CAUSE = "Unknown hazard";
const labelOf = (id) => CAUSE_LABELS[id] ?? (Object.hasOwn(ALL_DEFS, id) ? ALL_DEFS[id].name : id);

// Death-cause record { id, label } from a contract source object ({ id, label }), an entity
// passed as its own source (named by its kind), or a bare id string.
export function deathCause(source) {
  if (source && typeof source === "object") {
    const id = String(typeof source.id === "string" ? source.id : (source.kind ?? source.label ?? UNKNOWN_CAUSE));
    return { id, label: String(source.label ?? labelOf(id)) };
  }
  const id = source == null || source === "" ? UNKNOWN_CAUSE : String(source);
  return { id, label: labelOf(id) };
}

// The bus form of a player-damage source (IMPROVEMENTS F16.4): the cause plus where it came from
// (x/z, when known) and the tags other systems read (affix: Hunter's Mark; hammer: a Tithe
// Hammer blast, which never scores PHASED).
export function hitSource(source, cause = deathCause(source)) {
  const out = { id: cause.id, label: cause.label };
  if (!source || typeof source !== "object") return out;
  if (Number.isFinite(source.x) && Number.isFinite(source.z)) {
    out.x = source.x;
    out.z = source.z;
  }
  if (source.affix) out.affix = source.affix;
  if (source.hammer) out.hammer = true;
  return out;
}

export function createPlayer(ctx) {
  const hero = createHero();
  ctx.gfx?.layers?.actors?.add(hero.g);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(RING.inner, RING.outer, RING.segments),
    unlitMaterial(RING.color, { transparent: true, opacity: RING.opacity, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ctx.gfx?.layers?.actors?.add(ring);
  ctx.fx?.shadow?.(hero.g, RADIUS);

  let equipped = 0,
    shooting = false,
    aimMode = "move", // "stick" | "mouse" | "move" | "pilot"
    invulnerable = false, // practice toggle (the chain scenario's panel)
    dithered = false,
    regenPool = 0;

  // Scratch (no per-step allocation beyond the shared util helpers).
  const moveOut = { x: 0, z: 0 },
    velocity = { x: 0, z: 0 },
    walkTarget = { x: 0, z: 0 },
    wakeFrom = { x: 0, y: 0, z: 0 },
    wakeTo = { x: 0, y: 0, z: 0 },
    dashOrigin = { x: 0, y: 0, z: 0 },
    assistFrom = { x: 0, y: 0, z: 0 },
    assistTo = { x: 0, y: 0, z: 0 },
    rayFrom = { x: 0, y: 0, z: 0 },
    rayTo = { x: 0, y: 0, z: 0 },
    aimOut = { yaw: 0, pitch: 0 },
    drainEvent = { amount: 0 },
    aimPoint = new THREE.Vector3(),
    aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    raycaster = new THREE.Raycaster(),
    ditherMaterials = new Map(), // hero material -> its dithered twin
    solidMaterials = new WeakMap(), // dithered hero mesh -> its own material
    pickList = [],
    picks = [];
  // Terrain-only view of the world: the aim ray ignores props, like the original surface raycast.
  const terrainView = { height: (x, z) => ctx.world.height(x, z), covers: NO_COVERS };

  const ground = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const yaw = () => (Number.isFinite(ctx.cam?.yaw) ? ctx.cam.yaw : 0.35);
  const trailColor = () => ctx.profile?.cosmetics?.trailColor?.() ?? TRAIL_COLORS.normal;
  const tutorialEvent = (action, value) => {
    if (ctx.run?.tutorial) ctx.tutorial?.event?.(action, value);
  };
  const difficulty = (run) => ctx.director?.difficultyScale?.() ?? 1 + (run.difficultyBonus || 0) / 100;
  // Crown of Thorns stops kill heals and regeneration while it bleeds the hero.
  const draining = (run) => !!run.relicState?.thornsDraining;

  function fresh(overrides = {}) {
    return {
      ...PLAYER_DEFAULTS,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      dashCharges: DASH.max,
      dashCD: 0,
      dashing: 0,
      inv: 0,
      dx: 0,
      dz: 1,
      aim: 0,
      aimPitch: 0,
      recoil: 0,
      maxLedger: 0, // the Rules Ledger's share of max (recomputeMax)
      ...overrides,
    };
  }

  // World-space movement intent, |v| <= 1: camera-relative input, or the attract pilot's
  // world-space vector (ctx.demo.move).
  function movementInput(run) {
    moveOut.x = moveOut.z = 0;
    if (run.demo) {
      const m = ctx.demo?.move;
      if (m) {
        const l = Math.max(1, Math.hypot(m.x, m.z));
        moveOut.x = m.x / l;
        moveOut.z = m.z / l;
      }
      return moveOut;
    }
    const m = ctx.input?.move?.();
    if (m) {
      const v = movementVector(m.x, m.y, yaw());
      moveOut.x = v.x;
      moveOut.z = v.z;
    }
    return moveOut;
  }

  // ---- Rules Ledger (IMPROVEMENTS F9.1) ------------------------------------------------------

  // Dash charges: clamp(DASH.max + rules.sum("dashCharges"), 1, 4) under KEEPERS.
  function dashMax() {
    const run = ctx.run;
    if (!run || run.original) return DASH.max;
    return clamp(DASH.max + (ctx.rules?.sum?.("dashCharges") ?? 0), 1, MAX_DASHES);
  }

  // Walking speed multiplier from the ground zones around the hero: the slowest (1 if none, or
  // with a slowImmune relic). It never touches dash speed.
  function moveMul() {
    const run = ctx.run,
      p = run?.player;
    if (!p || run.original || ctx.rules?.flag?.("slowImmune")) return 1;
    return ctx.combat?.zoneSlow?.(p.x, p.z, RADIUS, null) ?? 1;
  }

  // Max integrity is recomputed, never patched: max(40, the run's base max (defaults, Phase
  // armor picks, practice overrides) + rules.sum("maxHp")). A rise heals the difference; a fall
  // clamps HP. The result is the same in any order of pushes and pops. Returns the new max.
  function recomputeMax() {
    const run = ctx.run,
      p = run?.player;
    if (!p || run.original) return p?.max ?? 0;
    const base = p.max - (p.maxLedger || 0),
      max = Math.max(MIN_MAX, base + (ctx.rules?.sum?.("maxHp") ?? 0)),
      rise = max - p.max;
    p.maxLedger = max - base;
    p.max = max;
    if (rise > 0) heal(rise, "relic");
    else p.hp = Math.min(p.hp, max);
    return max;
  }

  // Every ledger change: max integrity and dash charges follow at once.
  function onRules() {
    const p = ctx.run?.player;
    if (!p || ctx.run.original) return;
    recomputeMax();
    p.dashCharges = Math.min(p.dashCharges, dashMax());
  }

  // ---- per step --------------------------------------------------------------------------

  function tickTimers(run, p, dt) {
    const charges = dashMax();
    p.inv = Math.max(0, p.inv - dt);
    if (p.dashCharges < charges) {
      p.dashCD -= dt;
      // Sequential recharge that carries the remainder into the next charge.
      while (p.dashCD <= 0 && p.dashCharges < charges) {
        p.dashCharges++;
        p.dashCD = p.dashCharges < charges ? p.dashCD + DASH.cooldown : 0;
      }
    }
    p.dashing = Math.max(0, p.dashing - dt);
    if (p.hp > 0 && !draining(run)) {
      const before = p.hp;
      p.hp = Math.min(p.max, p.hp + p.regen * dt);
      reportRegen(p.hp - before);
    }
    p.recoil = Math.max(0, p.recoil - RECOIL_DECAY * dt);
  }

  // Repair field heals silently every step and reports it as +10 pops (IMPROVEMENTS F16.5).
  function reportRegen(gained) {
    if (!(gained > 0)) return;
    regenPool += gained;
    if (regenPool < REGEN_POP) return;
    regenPool -= REGEN_POP;
    ctx.bus.emit("playerHeal", { amount: REGEN_POP, reason: "regen" });
  }

  function moveBody(p, dx, dz) {
    const terrain = ctx.world?.terrain;
    if (terrain) terrain.move(p, dx, dz, RADIUS);
    else {
      p.x += dx;
      p.z += dz;
    }
  }

  // Walking velocity keeps easing even mid-dash; the dash itself moves along its locked line.
  // KEEPERS walking also follows the ledger's moveSpeed and the ground zones' slow.
  function walk(run, p, input, dt) {
    let speed = p.speed * (run.boons?.speed > 0 ? SPEED_BOOST : 1);
    if (!run.original) speed *= (ctx.rules?.mul?.("moveSpeed") ?? 1) * moveMul();
    velocity.x = p.vx;
    velocity.z = p.vz;
    walkTarget.x = input.x * speed;
    walkTarget.z = input.z * speed;
    const v = movementResponse(velocity, walkTarget, dt);
    p.vx = v.x;
    p.vz = v.z;
    if (!(p.dashing > 0)) {
      moveBody(p, p.vx * dt, p.vz * dt);
      return;
    }
    wakeFrom.x = p.x;
    wakeFrom.z = p.z;
    wakeFrom.y = ground(p.x, p.z) + WAKE_HEIGHT;
    moveBody(p, p.dx * DASH.speed * dt, p.dz * DASH.speed * dt);
    ctx.fx?.burst?.(p.x, DASH_TRAIL_HEIGHT, p.z, trailColor(), 3, 1);
    wakeTo.x = p.x;
    wakeTo.z = p.z;
    wakeTo.y = ground(p.x, p.z) + WAKE_HEIGHT;
    ctx.mods?.onDashMove?.(wakeFrom, wakeTo);
    if (!run.original) ctx.relics?.onDashMove?.(wakeFrom, wakeTo);
  }

  // Stick aim only: pick the pitch toward the best visible target near the stick bearing.
  // Never bends yaw (the aim-assist tiers do that).
  function assistedPitch(run, p, angle) {
    const range = WEAPONS[run.weapon]?.range ?? WEAPONS[0].range;
    assistFrom.x = p.x;
    assistFrom.y = ground(p.x, p.z) + MUZZLE_HEIGHT;
    assistFrom.z = p.z;
    let rank = Infinity,
      found = false,
      bestY = 0,
      bestX = 0,
      bestZ = 0;
    const targets = ctx.combat?.targets?.() ?? [];
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i],
        dx = e.x - p.x,
        dz = e.z - p.z,
        d = Math.hypot(dx, dz),
        delta = Math.abs(wrapAngle(Math.atan2(dx, dz) - angle)),
        priority = delta * 20 + d * 0.01;
      if (delta >= ASSIST_CONE || d > range || priority >= rank) continue;
      const bounds = ctx.combat.bodyBounds(e, true);
      assistTo.x = e.x;
      assistTo.y = (bounds.bottom + bounds.top) / 2;
      assistTo.z = e.z;
      if (ctx.world?.trace?.(assistFrom, assistTo, 0)) continue;
      found = true;
      rank = priority;
      bestX = assistTo.x;
      bestY = assistTo.y;
      bestZ = assistTo.z;
    }
    return found ? pitchTo(assistFrom.x, assistFrom.y, assistFrom.z, bestX, bestY, bestZ) : 0;
  }

  // Mouse aim: the first live target model under the cursor (occluded or not, like the
  // original), else the terrain surface lifted to chest height, else a chest-height plane
  // (no intersection keeps the previous aim point). A camera that supplies a world-space
  // aimPoint (the headless test harness) replaces the cursor ray.
  function mouseAim(p) {
    const floor = ground(p.x, p.z);
    if (!ctx.cam?.aimPoint?.(aimPoint)) {
      const mouse = ctx.input.mouse,
        ray = ctx.cam?.screenRay?.(mouse.x, mouse.y);
      if (!ray) return;
      raycaster.ray.copy(ray);
      if (!pickTarget() && !pickTerrain(ray)) {
        aimPlane.constant = -(floor + AIM_LIFT);
        ray.intersectPlane(aimPlane, aimPoint);
      }
    }
    p.aim = Math.atan2(aimPoint.x - p.x, aimPoint.z - p.z);
    p.aimPitch = pitchTo(p.x, floor + MUZZLE_HEIGHT, p.z, aimPoint.x, aimPoint.y, aimPoint.z);
  }

  function pickTarget() {
    const targets = ctx.combat?.targets?.() ?? [];
    pickList.length = 0;
    for (let i = 0; i < targets.length; i++) if (targets[i].model?.g) pickList.push(targets[i].model.g);
    if (!pickList.length) return false;
    picks.length = 0;
    // Sprites (billboards on a model) can only be raycast with the camera set.
    raycaster.camera = ctx.gfx?.camera ?? null;
    raycaster.intersectObjects(pickList, true, picks);
    if (!picks.length) return false;
    aimPoint.copy(picks[0].point);
    return true;
  }

  // The ground mesh is the heightfield, so an exact heightfield trace replaces a per-step
  // raycast over its ~46k triangles. Off the mesh's extent the plane fallback applies.
  function pickTerrain(ray) {
    if (!ctx.world?.terrain) return false;
    rayFrom.x = ray.origin.x;
    rayFrom.y = ray.origin.y;
    rayFrom.z = ray.origin.z;
    rayTo.x = ray.origin.x + ray.direction.x * AIM_RAY;
    rayTo.y = ray.origin.y + ray.direction.y * AIM_RAY;
    rayTo.z = ray.origin.z + ray.direction.z * AIM_RAY;
    const hit = traceWorld(rayFrom, rayTo, terrainView, 0);
    if (!hit || Math.abs(hit.x) > EXTENT || Math.abs(hit.z) > EXTENT) return false;
    aimPoint.set(hit.x, hit.y + AIM_LIFT, hit.z);
    return true;
  }

  function resolveAim(run, p, input, dt) {
    // The attract pilot writes aim and pitch onto run.player itself.
    if (run.demo) {
      aimMode = "pilot";
      return;
    }
    const stick = ctx.input?.aimStick?.();
    if (stick && Math.hypot(stick.x, stick.y) > STICK_AIM) {
      const v = movementVector(stick.x, stick.y, yaw()),
        stickYaw = Math.atan2(v.x, v.z);
      // The aim-assist tiers bend the yaw toward targets (IMPROVEMENTS F18.2).
      p.aim = ctx.assist?.aimYaw?.(p.aim, stickYaw, dt) ?? stickYaw;
      p.aimPitch = assistedPitch(run, p, p.aim);
      aimMode = "stick";
      return;
    }
    // Only while the mouse is the active device: a pad player who once nudged the mouse must
    // not snap back to a stale cursor whenever the stick rests.
    if (ctx.input?.mouse?.moved && ctx.input.device === "mouse") {
      mouseAim(p);
      aimMode = "mouse";
      return;
    }
    aimMode = "move";
    // Movement facing (aimPitch kept), frozen while firing so strafing keeps the line of fire.
    if (!shooting && Math.hypot(input.x, input.z) > FACING_INPUT) p.aim = Math.atan2(input.x, input.z);
  }

  function update(dt) {
    const run = ctx.run,
      p = run?.player;
    if (!p) return;
    tickTimers(run, p, dt);
    if (p.hp <= 0) {
      shooting = false;
      return;
    }
    const input = movementInput(run),
      beforeX = p.x,
      beforeZ = p.z;
    walk(run, p, input, dt);
    tutorialEvent("move", Math.hypot(p.x - beforeX, p.z - beforeZ));
    // Held or toggled fire, or the assists' auto-fire (never in the attract demo).
    shooting = run.demo ? !!ctx.demo?.firing : !!ctx.input?.firing?.() || !!ctx.assist?.autoFire?.();
    resolveAim(run, p, input, dt);
    if (!run.original) ctx.relics?.tick?.(dt);
    poseHero(run, p);
  }

  // ---- hero model ------------------------------------------------------------------------

  function sync() {
    const p = ctx.run?.player;
    if (!p) return;
    const floor = ground(p.x, p.z);
    hero.g.position.set(p.x, floor, p.z);
    hero.g.rotation.y = p.aim;
    hero.gunMount.rotation.x = -p.aimPitch;
    ring.position.set(p.x, floor + RING.lift, p.z);
  }

  function poseHero(run, p) {
    sync();
    const time = run.elapsed || 0;
    animateCharacter(hero, time, Math.min(1, Math.hypot(p.vx, p.vz) / WALK_ANIM), p.recoil);
    // Developer scenarios keep the hero permanently invulnerable (unless mortal), so it never
    // blinks there. With Reduce flashes the blink becomes a steady dither (F17).
    const blinking = !(run.scenario && !run.mortal) && p.inv > 0;
    if (ctx.prefs?.flashes === false) {
      setDither(blinking);
      hero.g.visible = true;
    } else {
      setDither(false);
      hero.g.visible = !blinking || Math.floor(time * BLINK_RATE) % 2 === 0;
    }
  }

  // The hero's shared materials are never mutated: a dithered twin of each (alpha-hashed at
  // 50%) is made once and swapped in while the dither is on.
  function ditherOf(material) {
    let twin = ditherMaterials.get(material);
    if (!twin) {
      twin = material.clone();
      twin.alphaHash = true;
      twin.opacity = DITHER_OPACITY;
      ditherMaterials.set(material, twin);
    }
    return twin;
  }

  // Idempotent per mesh, so a gun equipped mid-dither is caught by applyDither(true) too. The
  // swap is kept outside userData, which Object3D.clone() deep-copies (the Rift Echo ghost).
  function applyDither(on) {
    hero.g.traverse((node) => {
      if (!node.isMesh) return;
      const solid = solidMaterials.get(node);
      if (on && !solid) {
        solidMaterials.set(node, node.material);
        node.material = ditherOf(node.material);
      } else if (!on && solid) {
        node.material = solid;
        solidMaterials.delete(node);
      }
    });
  }

  function setDither(on) {
    if (dithered === on) return;
    dithered = on;
    applyDither(on);
  }

  function showWeapon(index) {
    if (equipped === index && hero.weapon) return;
    equipped = index;
    equipWeapon(hero, index);
    if (dithered) applyDither(true);
  }

  // ---- actions ---------------------------------------------------------------------------

  // Phase dash: 0.22 s along the move direction (or the aim, with prefs.dashToward "aim" or no
  // movement), charges (2, or the ledger's) recharging 1.8 s each.
  function dash() {
    const run = ctx.run,
      p = run?.player;
    if (!p || p.hp <= 0 || (ctx.mode !== "play" && !run.demo) || p.dashCharges <= 0 || p.dashing > 0) return false;
    const v = movementInput(run),
      l = Math.hypot(v.x, v.z),
      towardMove = l > FACING_INPUT && (run.demo || ctx.prefs?.dashToward !== "aim");
    p.dx = towardMove ? v.x / l : Math.sin(p.aim);
    p.dz = towardMove ? v.z / l : Math.cos(p.aim);
    p.dashing = DASH.duration;
    p.dashCharges--;
    if (p.dashCD <= 0) p.dashCD = DASH.cooldown;
    // Never shortens a longer grace (stage entry, boss arrival).
    p.inv = Math.max(p.inv, DASH.invulnerability);
    dashOrigin.x = p.x;
    dashOrigin.y = ground(p.x, p.z) + MUZZLE_HEIGHT;
    dashOrigin.z = p.z;
    ctx.mods?.onDashBegin?.(dashOrigin);
    tutorialEvent("dash");
    ctx.fx?.burst?.(p.x, 1, p.z, COLORS.dash, 25, 5);
    ctx.audio?.fx?.("dash");
    ctx.input?.rumble?.(0.2, 60);
    if (run.stats) run.stats.dashes++;
    ctx.bus.emit("dash", {});
    ctx.hud?.update?.();
    return true;
  }

  // Weapon switch. The fire timer is untouched: the previous weapon's cooldown carries over.
  function equip(index) {
    const run = ctx.run;
    if (!run || !Number.isFinite(index)) return;
    const count = WEAPONS.length,
      next = ((Math.trunc(index) % count) + count) % count;
    if (next === run.weapon && equipped === next && hero.weapon) return;
    run.weapon = next;
    showWeapon(next);
    ctx.bus.emit("weapon", { index: next });
    if (ctx.mode === "play") ctx.audio?.fx?.("switch");
    tutorialEvent("weapon", next);
  }

  // Hunter's Mark: Molten and Shardborn death bursts never hurt (KEEPERS).
  function immune(run, source) {
    return !run.original && BURST_AFFIXES.has(source?.affix) && !!ctx.rules?.flag?.("eliteBurstSafe");
  }

  // What a hit costs under the run's rules: the curse (Wave-1) or, under KEEPERS, the capped
  // damageScale and the ledger's damageTaken. Death Mode tuning applies to both.
  function intake(run) {
    if (run.original) return difficulty(run);
    return (ctx.director?.damageScale?.() ?? 1) * (ctx.rules?.mul?.("damageTaken") ?? 1);
  }

  // The original hurtPlayer: mode and curse multipliers, Bone Ward, 0.6 s invulnerability
  // (even when the ward took it all), feedback, and death; Ferryman's Coin may turn a lethal
  // hit into 1 integrity and 2 s of invulnerability. Returns the F1.4(f) result code: "hit"
  // (HP lost), "absorbed" (the ward took it all), "phased" (mid-dash; bus "phased"), "inv" (any
  // other invulnerability) or "none" (nothing to take, or a relic immunity).
  function hurt(amount, source = UNKNOWN_CAUSE) {
    const run = ctx.run,
      p = run?.player;
    if (!p || p.hp <= 0 || (ctx.mode !== "play" && !run.demo) || !(amount > 0) || immune(run, source)) return "none";
    if (p.dashing > 0) {
      ctx.bus.emit("phased", { source: hitSource(source) });
      return "phased";
    }
    if (p.inv > 0 || invulnerable) return "inv";
    const before = p.hp,
      scaled = amount * (run.tuning?.damage ?? 1) * intake(run),
      remaining = ctx.encounters?.absorb ? ctx.encounters.absorb(scaled) : scaled,
      spared = remaining >= p.hp && !run.original && !!ctx.relics?.cheatDeath?.();
    p.hp = spared ? 1 : Math.max(0, p.hp - remaining);
    const lost = before - p.hp;
    if (run.stats) run.stats.damageTaken += lost;
    p.inv = spared ? RELIC_TUNING.ferryman.invulnerability : HURT_INVULNERABILITY;
    ctx.fx?.hurtFlash?.(1);
    ctx.cam?.shake?.(HURT_SHAKE);
    ctx.fx?.burst?.(p.x, 1, p.z, COLORS.hurt, 15, 3);
    ctx.audio?.fx?.(lost > 0 ? "hurt" : "shield");
    ctx.input?.rumble?.(lost > 0 ? 0.55 : 0.3, 140);
    const cause = deathCause(source);
    ctx.bus.emit("playerHit", { amount: scaled, source: hitSource(source, cause), absorbed: Math.max(0, scaled - remaining) });
    if (p.hp <= 0) die(run, cause);
    return lost > 0 || spared ? "hit" : "absorbed";
  }

  function die(run, cause) {
    ctx.audio?.fx?.("playerDeath");
    if (run.stats) run.stats.lethal = cause;
    // The death beat collapses the body, so it must not be caught mid-blink.
    setDither(false);
    hero.g.visible = true;
    ctx.bus.emit("playerDeath", { source: cause });
    ctx.director?.finishRun?.(true);
  }

  // Returns the HP actually restored; bus "playerHeal" { amount, reason } reports it. Reasons:
  // kill, surge, stage, mend, upgrade, landmark, spoils, trial, relic, regen. Crown of Thorns
  // refuses kill heals while it bleeds the hero.
  function heal(amount, reason = "") {
    const run = ctx.run,
      p = run?.player;
    if (!p || p.hp <= 0 || !(amount > 0) || (reason === "kill" && draining(run))) return 0;
    const before = p.hp;
    p.hp = Math.min(p.max, p.hp + amount);
    const gained = p.hp - before;
    if (gained > 0) ctx.bus.emit("playerHeal", { amount: gained, reason });
    return gained;
  }

  // Crown of Thorns' bleed: never below 1 HP and never a hit (no invulnerability, feedback or
  // chain sever); bus "playerDrain" { amount } (a shared payload: read it, do not keep it).
  // Returns the HP drained.
  function drain(amount) {
    const run = ctx.run,
      p = run?.player;
    if (!p || p.hp <= 1 || !(amount > 0)) return 0;
    const lost = Math.min(amount, p.hp - 1);
    p.hp -= lost;
    if (run.stats) run.stats.damageTaken += lost;
    drainEvent.amount = lost;
    ctx.bus.emit("playerDrain", drainEvent);
    return lost;
  }

  // Stage entry teleport: stops walking and any dash, and moves the model and ring with it.
  function place(x, z) {
    const p = ctx.run?.player;
    if (!p) return;
    p.x = x;
    p.z = z;
    p.vx = p.vz = 0;
    p.dashing = 0;
    sync();
  }

  function aimVector() {
    const p = ctx.run?.player;
    aimOut.yaw = p?.aim ?? 0;
    aimOut.pitch = p?.aimPitch ?? 0;
    return aimOut;
  }

  // Where the current aim points: the mouse aim point while mouse-aiming, else `range` metres
  // from the muzzle along yaw/pitch (the Rift Echo aims its repeat here).
  function aimTarget(range, out = {}) {
    const p = ctx.run?.player;
    if (!p) return null;
    if (aimMode === "mouse") {
      out.x = aimPoint.x;
      out.y = aimPoint.y;
      out.z = aimPoint.z;
      return out;
    }
    const level = Math.cos(p.aimPitch);
    out.x = p.x + Math.sin(p.aim) * level * range;
    out.y = ground(p.x, p.z) + MUZZLE_HEIGHT + Math.sin(p.aimPitch) * range;
    out.z = p.z + Math.cos(p.aim) * level * range;
    return out;
  }

  // ---- wiring ----------------------------------------------------------------------------

  ctx.bus.on("input:dash", dash);
  ctx.bus.on("input:weapon", (event) => equip(event?.index));
  ctx.bus.on("input:cycleWeapon", (event) => {
    if (ctx.run) equip((ctx.run.weapon ?? 0) + (event?.dir || 0));
  });
  ctx.bus.on("rules", onRules);
  ctx.bus.on("runStart", () => {
    const run = ctx.run;
    if (!run) return;
    if (!Number.isInteger(run.weapon)) run.weapon = 0;
    showWeapon(run.weapon);
    shooting = false;
    aimMode = "move";
    invulnerable = false;
    regenPool = 0;
    setDither(false);
    hero.g.visible = ring.visible = true;
    sync();
  });
  ctx.bus.on("stageBuilt", sync);
  // The ring is hidden exactly while mode is "dead" (the death beat and the results screen).
  ctx.bus.on("modeChange", (event) => {
    ring.visible = event?.mode !== "dead";
  });

  return {
    hero,
    get shooting() {
      return shooting;
    },
    // Practice only: a run-long invulnerability toggle (hits return "inv").
    get invulnerable() {
      return invulnerable;
    },
    set invulnerable(on) {
      invulnerable = !!on;
    },
    fresh,
    update,
    dash,
    equip,
    hurt,
    heal,
    drain,
    aimVector,
    aimTarget,
    place,
    moveMul,
    dashMax,
    recomputeMax,
  };
}
