// Encounters (ctx.encounters): what a stage offers besides its kill goal. Skull statues (curses
// and Skull Trials with their rosters, vents and anchors), landmark discoveries, XP shards,
// powerup drops and the boons they grant, and the interact prompt. Encounter objects (trial
// anchors, Warden nodes) are damageable props owned here (hazard props route to ctx.hazards);
// the bosses live in bosses.js. KEEPERS adds (IMPROVEMENTS F1.9, F2, F8, F9, F12): the omen
// statue dialog and silent statues during keeper fights, the shrine bell, relic caches and the
// elite drops, the trial stall fix, the ledger's drop and boon terms, and the Lodestone Eye and
// Pilgrim Salts hooks. Per-run state binds to ctx.run on "runStart"/"stageEnter" (and lazily on
// any call), so a new run never inherits the last one's leftovers. Statue, landmark and omen
// dialogs open through ctx.progression.decision.
import * as THREE from "three";
import { unlitMaterial } from "../render/materials.js";
import { createMonster, disposeModel, setFlash } from "../render/models.js";
import { createCacheModel, PROP_COLORS } from "../render/models-props.js";
import { sceneryShapes } from "../world/scenery.js";
import { keyLabel } from "../input/preferences.js";
import { CHALLENGE, MAX_HOSTILES } from "../data/enemies.js";
import { DROPS, POWERUPS, createBoons } from "../data/progression.js";
import { FLOW, TRIAL_NAMES } from "../data/stages.js";
import { OMENS } from "../data/omens.js";
import { TAU } from "../core/util.js";

const SHARD = Object.freeze({ color: "#80ffde", lift: 0.45, bob: 0.12, spin: 2, reach: 0.65, width: 0.16, height: 0.26 });
const SHARD_BATCH = 64; // instanced capacity; doubles when a field outgrows it
const PICKUP = Object.freeze({ lift: 0.6, bob: 0.12, spin: 1.5, width: 0.36, height: 0.5, shadow: 0.34, blink: 3 });
const TIMED_BOONS = Object.freeze(["speed", "rapid", "execution", "ward"]);
const DROP_KINDS = Object.freeze(Object.keys(POWERUPS));
const HIT_FLASH = 0.12;
const OBJECT_RADIUS = 0.85;
const OBJECT_DEBRIS = "#e4bc84";
const LINK_COLOR = "#b887bc";
const LINK_HEIGHT = 1.3;
const TRIAL_MARK = "#dfb276";
const CURSE_RING = "#bc565a";
const TRIAL_SITES = 4;
const VENT_STAGE = 3; // Vent Hunt: vents on the brute and first two splitter sites
const ANCHOR_STAGE = 4; // Anchor Guard: one elite brute shielded by three anchors
const LAST_TRIAL_STAGE = 4; // the Void Crown has no Skull Trial
const VENT = Object.freeze({ radius: 2.2, pulse: 0.5, sites: 3 });
const VENT_CAUSE = Object.freeze({ id: "Trial vent", label: "Trial vent" });
const BONUS = FLOW.STATUE_BONUS;
const TRIAL_PROMPT = "SKULL TRIAL · PREVIEW";
const CURSE_PROMPT = `CHALLENGE ONLY · +${BONUS}% · NO REWARD`;
const TRIAL_DETAIL = Object.freeze({ 3: "Marked hunt with storming vents.", 4: "Three anchors shield the marked elite." });

// KEEPERS statues (F12): every activation adds 10 points to the Rift Score multiplier (F11).
const RIFT_SCORE = 10;
const OMEN_PROMPT = `SKULL OMEN · +${BONUS}% CURSE · +${RIFT_SCORE}% SCORE`;
const OMEN_TITLE = "SKULL OMEN · CHOOSE A CURSE";
const SILENT_SKULL = "THE SKULL IS SILENT WHILE A KEEPER STANDS";
const BELL_PROMPT = "RING THE BELL · WAKE THE BELLWETHER";
// Trial stall fix (F1.9): a roster member this far from the hero this long comes back.
const STALL = Object.freeze({ far: 45, time: 20, return: 14, grace: 0.4 });
// Relic Cache (F8): a queued reward, picked up like a powerup, never counted in the drop cap.
const CACHE = Object.freeze({ life: 30, blink: 5, bob: 0.12, lift: 0.1, light: 3, lightRange: 8, shadow: 0.4 });
const PILGRIM_HEAL = 30; // Pilgrim Salts: landmark recovery (F9)
const LODESTONE = Object.freeze({ reach: 12, speed: 2 }); // Lodestone Eye: shard drift (F9)
const SCALED_BOONS = Object.freeze(["speed", "rapid", "ward"]); // boonDuration never touches Insta Kill

// A designated roster, never the ambient population, decides a trial. Cleanup paths abandon it,
// never defeat it; descendants must be registered before their parent is counted as defeated.
export class SkullTrial {
  constructor(stage) {
    this.id = `trial:${stage}`;
    this.stage = stage;
    this.state = "available";
    this.roster = new Set();
    this.statue = null;
  }
  activate(ids, applyCurse) {
    if (this.state !== "available" || !ids.length) return false;
    this.roster = new Set(ids);
    this.state = "active";
    applyCurse();
    return true;
  }
  descendant(parent, id) {
    if (this.state === "active" && this.roster.has(parent)) this.roster.add(id);
  }
  defeat(id) {
    if (this.state !== "active" || !this.roster.delete(id)) return false;
    if (this.roster.size) return false;
    this.state = "completed";
    return true;
  }
  claim() {
    if (this.state !== "completed") return false;
    this.state = "claimed";
    return true;
  }
  abandon() {
    if (this.state !== "active" && this.state !== "completed") return false;
    this.state = "abandoned";
    this.roster.clear();
    return true;
  }
}

// Four distinct, walkable roster sites around a statue, validated before the statue is used:
// rings of 5, 7 and 9 m, away from the player, the statue's reach and each other. All or none.
export function trialLocations(terrain, statue, count = TRIAL_SITES, player = null) {
  const sites = [];
  for (let i = 0; i < 32 && sites.length < count; i++) {
    const a = (i * TAU) / 13,
      r = 5 + Math.floor(i / 13) * 2,
      p = terrain.safeNear(statue.x + Math.sin(a) * r, statue.z + Math.cos(a) * r, 1.2);
    if (
      !p ||
      (player && Math.hypot(p.x - player.x, p.z - player.z) < 6) ||
      !terrain.clear(p.x, p.z, 1.2) ||
      Math.hypot(p.x - statue.x, p.z - statue.z) > 13 ||
      sites.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 3)
    )
      continue;
    sites.push(p);
  }
  return sites.length === count ? sites : [];
}

// First decide whether anything drops, then pick one of the five equally likely kinds. KEEPERS
// passes the ledger's chance and, while Insta Kill runs, noExecution (F9).
export function rollPowerup(random = Math.random, { chance = DROPS.chance, noExecution = false } = {}) {
  if (random() >= chance) return null;
  return powerupKind(random, noExecution);
}

// One of the five kinds; with noExecution an Insta Kill result is rerolled among the other four,
// so a live Insta Kill can never roll another.
export function powerupKind(random, noExecution = false) {
  const kind = DROP_KINDS[Math.min(DROP_KINDS.length - 1, Math.floor(random() * DROP_KINDS.length))];
  if (kind !== "execution" || !noExecution) return kind;
  const others = DROP_KINDS.filter((k) => k !== "execution");
  return others[Math.min(others.length - 1, Math.floor(random() * others.length))];
}

// Simulation clock only: pauses, cards and cinematics keep the remaining boon time.
export function tickBoons(boons, dt) {
  for (const kind of TIMED_BOONS) boons[kind] = Math.max(0, boons[kind] - dt);
  if (!boons.ward) boons.shield = 0;
}

// Bone Ward: returns the damage still owed to health. An emptied shield ends the ward early.
export function absorbDamage(boons, damage) {
  const blocked = Math.min(boons.shield, damage);
  boons.shield -= blocked;
  if (!boons.shield) boons.ward = 0;
  return damage - blocked;
}

let trialRingGeometry = null;
const trialRing = () => (trialRingGeometry ??= new THREE.TorusGeometry(1, 0.08, 6, 32));

// All XP shards share one instanced draw call: a long fight can leave dozens on the ground.
function createShardField(ctx) {
  const pose = new THREE.Object3D();
  pose.scale.set(SHARD.width, SHARD.height, SHARD.width);
  let mesh = null;

  function reserve(count) {
    if (mesh && count <= mesh.instanceMatrix.count) return mesh;
    const layer = ctx.gfx?.layers?.effects;
    if (!layer) return null;
    let size = SHARD_BATCH;
    while (size < count) size *= 2;
    const next = new THREE.InstancedMesh(sceneryShapes().geometries.gem, unlitMaterial(SHARD.color), size);
    next.name = "xp-shards";
    next.frustumCulled = false;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (mesh) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    layer.add(next);
    mesh = next;
    return mesh;
  }

  function hide() {
    if (mesh) mesh.visible = false;
  }

  return {
    hide,
    draw(gems, time, height) {
      if (!gems.length) {
        hide();
        return;
      }
      const field = reserve(gems.length);
      if (!field) return;
      for (let i = 0; i < gems.length; i++) {
        const g = gems[i];
        pose.position.set(g.x, height(g.x, g.z) + SHARD.lift + Math.sin(time * 4 + g.x) * SHARD.bob, g.z);
        pose.rotation.y = g.spin;
        pose.updateMatrix();
        field.setMatrixAt(i, pose.matrix);
      }
      field.count = gems.length;
      field.instanceMatrix.needsUpdate = true;
      field.visible = true;
    },
  };
}

export function createEncounters(ctx) {
  const shards = createShardField(ctx),
    vents = [],
    linkFrom = { x: 0, y: 0, z: 0 },
    linkTo = { x: 0, y: 0, z: 0 },
    ventStyle = { opacity: 0, progress: 0, wireframe: false },
    prompt = { target: null, suffix: "", device: "", binding: "", text: null },
    // The last rolled drop (dropPowerup with no kind): an elite's kill checks it (onKilled).
    lastRoll = { x: NaN, z: NaN, pickup: null },
    // One cache light, always in the scene (a light joining later would recompile every lit
    // material mid-fight); it follows the newest cache on the ground.
    cacheLight = new THREE.PointLight(PROP_COLORS.cacheGem, 0, CACHE.lightRange, 2);
  let bound = null,
    trialStage = null,
    cacheDrop = null, // where this stage's relic cache dropped ({ x, z }), or null
    lull = false; // the pacing lull was on last step (a lull start flushes caches)
  cacheLight.name = "relic-cache-light";
  ctx.gfx?.layers?.effects?.add(cacheLight);

  const height = (x, z) => ctx.world?.height(x, z) ?? 0;
  const toast = (text, priority) => ctx.hud?.toast?.(text, priority ? { priority } : undefined);
  const curse = (run) => 1 + run.difficultyBonus / 100;
  const ledger = (key) => ctx.rules?.mul?.(key) ?? 1;
  // KEEPERS draws come from named run streams (F14.1); ORIGINAL keeps the Wave-1 generator.
  const stream = (run, name) => run.stream?.(name) ?? run.rng;
  // The attract demo runs the same simulation behind the menu.
  const simulating = (run) => ctx.mode === "play" || !!run.demo;
  // run.kind is fixed at creation; run.tutorial appears once the tutorial begins.
  const inTutorial = (run) => !!run.tutorial || run.kind === "tutorial";
  // KEEPERS statues fall silent while a keeper stands or the Warden lives (F1.3).
  const keeperStands = (run) => run.keeperState === "active" || !!ctx.bosses?.current?.();

  // ---- per-run binding ---------------------------------------------------------------------

  function bind() {
    const run = ctx.run;
    if (!run) return null;
    if (run !== bound) adopt(run);
    // Every stage but the Void Crown (and never the tutorial) carries a fresh Skull Trial.
    if (trialStage !== run.stage) {
      trialStage = run.stage;
      run.trial = !inTutorial(run) && run.stage <= LAST_TRIAL_STAGE ? new SkullTrial(run.stage) : null;
      cacheDrop = null;
      lull = false;
    }
    return run;
  }

  function adopt(run) {
    if (bound) release(bound);
    bound = run;
    trialStage = null;
    run.boons ??= createBoons();
    run.difficultyBonus ??= 0;
    run.statueCount ??= 0;
    run.trialCount ??= 0;
    run.gems ??= [];
    run.powerups ??= [];
    run.objects ??= [];
    // Relic caches on the ground, picked-up caches waiting for a flush, and caches queued so
    // far (their reward keys).
    run.caches ??= [];
    run.cachesPending ??= 0;
    run.cachesQueued ??= 0;
  }

  function release(run) {
    clearVents();
    for (const o of run.objects || []) releaseObject(o);
    for (const p of run.powerups || []) releasePickup(p);
    for (const c of run.caches || []) releaseCache(c);
    if (run.objects) run.objects.length = 0;
    if (run.powerups) run.powerups.length = 0;
    if (run.caches) run.caches.length = 0;
    if (run.gems) run.gems.length = 0;
    shards.hide();
  }

  function nextId(run) {
    if (!Number.isFinite(run.nextId)) run.nextId = 1;
    return run.nextId++;
  }

  // ---- boons -------------------------------------------------------------------------------

  // Health applies at once; timed boons refresh their duration and never stack strength.
  // KEEPERS stretches Speed, Rapid Fire and Bone Ward by the ledger's boonDuration (F9).
  function collectBoon(kind) {
    const run = bind();
    if (!run) return;
    if (kind === "heal") {
      ctx.player?.heal?.(DROPS.heal, "mend");
      return;
    }
    if (!POWERUPS[kind]) return;
    const duration = POWERUPS[kind].duration;
    run.boons[kind] = !run.original && SCALED_BOONS.includes(kind) ? duration * ledger("boonDuration") : duration;
    if (kind === "ward") run.boons.shield = DROPS.wardShield;
  }

  function absorb(damage) {
    const run = bind();
    return run ? absorbDamage(run.boons, damage) : damage;
  }

  // ---- XP shards ---------------------------------------------------------------------------

  function dropGem(x, z, value) {
    const run = bind();
    if (!run || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const gem = { x, z, v: Number(value) || 0, spin: 0, dead: false };
    run.gems.push(gem);
    shards.draw(run.gems, run.elapsed || 0, height);
    return gem;
  }

  function updateGems(run, dt) {
    const p = run.player,
      gems = run.gems,
      // Lodestone Eye (F9): shards within 12 m, outside the magnet, drift in at 2 m/s.
      lodestone = !run.original && !!ctx.relics?.has?.("lodestone_eye");
    let kept = 0;
    for (let i = 0; i < gems.length; i++) {
      const g = gems[i];
      if (g.dead) continue;
      const dx = p.x - g.x,
        dz = p.z - g.z,
        d = Math.hypot(dx, dz);
      if (d < p.magnet) {
        const pull = Math.min(d, dt * (4 + 16 / (d + 0.2))) / (d || 1);
        g.x += dx * pull;
        g.z += dz * pull;
      } else if (lodestone && d < LODESTONE.reach) {
        const drift = (LODESTONE.speed * dt) / d;
        g.x += dx * drift;
        g.z += dz * drift;
      }
      g.spin += SHARD.spin * dt;
      // Reach is measured before this step's pull, as in the original.
      if (d < SHARD.reach) {
        collectGem(run, g);
        continue;
      }
      gems[kept++] = g;
    }
    gems.length = kept;
    shards.draw(gems, run.elapsed || 0, height);
  }

  function collectGem(run, g) {
    g.dead = true;
    run.player.xp += g.v;
    ctx.audio?.fx?.("gem");
    ctx.bus.emit("gem", { value: g.v });
  }

  // Stage exit (portal entry): every shard left on the ground is banked at once, and (KEEPERS)
  // every relic cache on the ground is picked up and the pending caches queue their rewards.
  // Returns the XP banked.
  function collectAllGems() {
    const run = bind();
    if (!run) return 0;
    let total = 0;
    for (const g of run.gems) if (!g.dead) total += g.v;
    if (run.player) run.player.xp += total;
    run.gems.length = 0;
    shards.hide();
    if (!run.original) {
      for (const c of run.caches) if (!c.dead) pickCache(run, c);
      flushCaches();
    }
    return total;
  }

  // ---- powerups ----------------------------------------------------------------------------

  // The drop roll: Wave-1 on ORIGINAL; KEEPERS draws from the "drops" stream with the ledger's
  // dropChance, and never rolls Insta Kill while one runs (F9, F14.1).
  function roll(run) {
    if (run.original) return rollPowerup(run.rng);
    return rollPowerup(stream(run, "drops"), { chance: DROPS.chance * ledger("dropChance"), noExecution: run.boons.execution > 0 });
  }

  // kind: a POWERUPS key, null for nothing, or omitted to roll the 18% drop on the run's stream.
  function dropPowerup(x, z, kind) {
    const run = bind();
    if (!run || inTutorial(run) || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const rolled = kind === undefined,
      type = rolled ? roll(run) : kind,
      spec = POWERUPS[type];
    if (rolled) Object.assign(lastRoll, { x, z, pickup: null });
    if (!spec || run.powerups.length >= DROPS.max) return null;
    const mesh = new THREE.Mesh(sceneryShapes().geometries[spec.shape], unlitMaterial(spec.color));
    mesh.scale.set(PICKUP.width, PICKUP.height, PICKUP.width);
    // Cosmetic phase so neighbouring drops bob and spin out of step.
    const phase = Math.random() * TAU;
    mesh.rotation.y = phase;
    const life = run.original ? DROPS.lifetime : DROPS.lifetime * ledger("dropLifetime");
    const pickup = { kind: type, x, z, life, mesh, phase, shadow: null, dead: false };
    if (rolled) lastRoll.pickup = pickup;
    placePickup(pickup, run.elapsed || 0);
    ctx.gfx?.layers?.effects?.add(mesh);
    pickup.shadow = ctx.fx?.shadow?.(mesh, PICKUP.shadow) ?? null;
    run.powerups.push(pickup);
    return pickup;
  }

  function placePickup(pickup, time) {
    const { mesh, x, z, life } = pickup;
    mesh.position.set(x, height(x, z) + PICKUP.lift + Math.sin(time * 4 + pickup.phase) * PICKUP.bob, z);
    // Blinks through its last seconds, faster in the final one, so expiry never surprises.
    mesh.visible = life > PICKUP.blink || Math.floor(life * (life < 1 ? 16 : 8)) % 2 === 0;
  }

  function updatePowerups(run, dt) {
    const p = run.player,
      list = run.powerups;
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      const pickup = list[i];
      pickup.life -= dt;
      pickup.mesh.rotation.y += PICKUP.spin * dt;
      placePickup(pickup, run.elapsed || 0);
      if (Math.hypot(p.x - pickup.x, p.z - pickup.z) < DROPS.pickupRadius) {
        collectPickup(pickup);
        pickup.life = 0;
      }
      if (pickup.life <= 0) {
        releasePickup(pickup);
        continue;
      }
      list[kept++] = pickup;
    }
    list.length = kept;
  }

  function collectPickup(pickup) {
    const spec = POWERUPS[pickup.kind];
    collectBoon(pickup.kind);
    toast(pickup.kind === "execution" ? `${spec.label} · ${spec.duration} SECONDS` : spec.label);
    ctx.audio?.fx?.("pickup");
    ctx.bus.emit("powerup", { kind: pickup.kind });
  }

  function releasePickup(pickup) {
    if (pickup.dead) return;
    pickup.dead = true;
    if (pickup.shadow) ctx.fx?.removeShadow?.(pickup.shadow);
    pickup.mesh.removeFromParent();
  }

  // ---- elite drops and relic caches (KEEPERS, F8) --------------------------------------------

  // The first elite event slain on a stage leaves the stage's one Relic Cache; later elites leave
  // a guaranteed powerup (unless the kill's own roll already dropped one, or the elite only came
  // with the Omen of the Hunt). A BOUND pair pays when its second body falls.
  function onKilled({ e } = {}) {
    const run = bind();
    if (!run || run.original || !e?.elite || e.fixed) return;
    if (e.partner && !e.partner.dead && e.partner.hp > 0) return;
    if (!cacheDrop) {
      dropCache(e.x, e.z);
      return;
    }
    // This elite's cache (dropped by the elite system during the kill) is its reward.
    if (cacheDrop.x === e.x && cacheDrop.z === e.z) return;
    if (e.eliteExtra || (lastRoll.x === e.x && lastRoll.z === e.z && lastRoll.pickup)) return;
    dropPowerup(e.x, e.z, powerupKind(stream(run, "drops"), run.boons.execution > 0));
  }

  // dropCache(x, z): the stage's Relic Cache (one per stage; later calls are refused). It lasts
  // 30 s, blinks in its last 5, sits outside the 4-drop cap, and is picked up by walking over it.
  function dropCache(x, z) {
    const run = bind();
    if (!run || run.original || inTutorial(run) || cacheDrop || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    cacheDrop = { x, z };
    const model = createCacheModel(),
      cache = { x, z, life: CACHE.life, model, phase: Math.random() * TAU, shadow: null, dead: false };
    model.g.position.set(x, height(x, z) + CACHE.lift, z);
    ctx.gfx?.layers?.effects?.add(model.g);
    cache.shadow = ctx.fx?.shadow?.(model.g, CACHE.shadow) ?? null;
    run.caches.push(cache);
    ctx.fx?.ring?.(x, z, PROP_COLORS.cacheGem, 2, 0.5);
    ctx.fx?.burst?.(x, 1, z, PROP_COLORS.cacheGem, 12, 3);
    return cache;
  }

  function releaseCache(cache) {
    if (cache.dead) return;
    cache.dead = true;
    if (cache.shadow) ctx.fx?.removeShadow?.(cache.shadow);
    cache.model.g.removeFromParent();
  }

  // A picked-up cache waits in run.cachesPending (the HUD's CACHE · n chip) for a flush: a
  // reward screen never opens mid-horde.
  function pickCache(run, cache) {
    releaseCache(cache);
    run.cachesPending += 1;
    ctx.audio?.fx?.("pickup", 1, cache);
    ctx.fx?.ring?.(cache.x, cache.z, PROP_COLORS.cacheGem, 1.6, 0.4);
  }

  function updateCaches(run, dt) {
    const p = run.player,
      list = run.caches;
    let kept = 0,
      newest = null;
    for (let i = 0; i < list.length; i++) {
      const cache = list[i];
      if (cache.dead) continue;
      cache.life -= dt;
      if (Math.hypot(p.x - cache.x, p.z - cache.z) < DROPS.pickupRadius) pickCache(run, cache);
      else if (cache.life <= 0) releaseCache(cache);
      if (cache.dead) continue;
      const { g, gem } = cache.model,
        t = run.elapsed || 0;
      gem.position.y = 0.95 + Math.sin(t * 3 + cache.phase) * CACHE.bob;
      gem.rotation.y += PICKUP.spin * dt;
      g.visible = cache.life > CACHE.blink || Math.floor(cache.life * (cache.life < 1 ? 16 : 8)) % 2 === 0;
      newest = cache;
      list[kept++] = cache;
    }
    list.length = kept;
    cacheLight.intensity = newest?.model.g.visible ? CACHE.light : 0;
    if (newest) cacheLight.position.set(newest.x, height(newest.x, newest.z) + 1.4, newest.z);
  }

  // flushCaches(): one "relic" reward per pending cache (RIFT-TOUCHED CACHE, two relic cards),
  // keyed rewardKey("cache:{stage}:{i}"). Called at a pacing lull start, after a keeper's
  // spoils and at portal entry. Returns the number queued.
  function flushCaches() {
    const run = bind();
    if (!run || run.original) return 0;
    let queued = 0;
    for (; run.cachesPending > 0; run.cachesPending--) {
      const base = `cache:${run.stage}:${run.cachesQueued++}`,
        key = ctx.director?.rewardKey?.(base) ?? base;
      if (ctx.progression?.queue?.(key, "relic")) queued++;
    }
    return queued;
  }

  // A pacing lull just began: the natural cash-out for pending caches. Keeper fights, the
  // Warden and active trials ignore the lull (the horde keeps coming), so they never flush here.
  function lullFlush(run) {
    const pacing = run.pacing,
      now = !!pacing && pacing.rest <= 0 && !pacing.allowSpawns(false) && run.trial?.state !== "active" && !keeperStands(run);
    if (now && !lull && run.cachesPending > 0) flushCaches();
    lull = now;
  }

  // ---- encounter objects (trial anchors, Warden nodes) -------------------------------------

  function addObject(kind, p, hp, owner) {
    const run = bind();
    if (!run || !p) return null;
    const y = height(p.x, p.z),
      model = createMonster(kind);
    model.g.position.set(p.x, y, p.z);
    ctx.gfx?.layers?.actors?.add(model.g);
    const o = {
      id: nextId(run),
      kind,
      x: p.x,
      z: p.z,
      y,
      hp,
      max: hp,
      radius: OBJECT_RADIUS,
      def: { radius: OBJECT_RADIUS },
      fixed: true,
      owner,
      model,
      dead: false,
      flash: 0,
      link: null,
    };
    // Anchors tether to the elite they shield; the beam shows only while the elite lives.
    if (kind === "anchor") {
      o.link = ctx.fx?.line?.(linkPoint(o, linkFrom), linkPoint(o, linkTo), LINK_COLOR, 0) ?? null;
      if (o.link?.mesh) o.link.mesh.visible = false;
    }
    run.objects.push(o);
    return o;
  }

  // No elite, stagger or Insta Kill multipliers: objects take the hit as dealt (crit included).
  // Hazard props (F10) take raw damage through their own system.
  function hurtObject(o, damage, source = {}) {
    if (o?.kind === "prop") return ctx.hazards?.hurtProp?.(o, damage, source) ?? 0;
    const run = bind();
    if (!run || !o || o.dead || !(o.hp > 0) || !(damage > 0)) return 0;
    const dealt = Math.min(o.hp, damage);
    o.hp -= dealt;
    const w = source?.weapon ?? source?.sourceWeapon,
      tally = run.stats?.damage;
    if (tally && Number.isInteger(w) && w >= 0 && w < tally.length) tally[w] += dealt;
    ctx.fx?.number?.(o.x, null, o.z, dealt, { crit: false, target: o });
    o.flash = HIT_FLASH;
    ctx.bus.emit("objectHit", { o, damage: dealt, source });
    if (o.hp <= 0) destroyObject(o);
    return dealt;
  }

  function destroyObject(o) {
    if (o.kind === "node") ctx.bosses?.nodeCharge?.destroy(o.id);
    ctx.fx?.burst?.(o.x, 1, o.z, OBJECT_DEBRIS, 15, 3);
    releaseObject(o);
  }

  // Removal only marks and hides; the list is compacted in update(), outside any combat pass.
  function releaseObject(o) {
    if (o.dead) return;
    o.dead = true;
    o.hp = 0;
    disposeModel(o.model);
    o.link?.remove();
    o.link = null;
  }

  function removeObjects(owner) {
    const run = bind();
    if (!run) return;
    for (const o of run.objects) if (o.owner === owner) releaseObject(o);
  }

  function compactObjects(run) {
    const list = run.objects;
    let kept = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead) list[kept++] = list[i];
    list.length = kept;
  }

  // Hazard props flash and tick in ctx.hazards; only dead ones are compacted here.
  function updateObjects(run, dt) {
    for (const o of run.objects) {
      if (o.dead || o.kind === "prop") continue;
      if (o.flash > 0) {
        o.flash = Math.max(0, o.flash - dt);
        setFlash(o.model, o.flash / HIT_FLASH);
      }
      if (o.link) tether(run, o);
    }
    compactObjects(run);
  }

  function tether(run, o) {
    const elite = eliteOf(run, o.owner);
    o.link.mesh.visible = !!elite;
    if (elite) o.link.update(linkPoint(o, linkFrom), linkPoint(elite, linkTo));
  }

  function eliteOf(run, trialId) {
    for (const e of run.enemies || []) if (e.trialElite && e.hp > 0 && e.trialId === trialId) return e;
    return null;
  }

  function linkPoint(at, out) {
    out.x = at.x;
    out.y = height(at.x, at.z) + LINK_HEIGHT;
    out.z = at.z;
    return out;
  }

  // ---- trial vents -------------------------------------------------------------------------

  function addVent(p) {
    const marker = ctx.tele?.area?.(p.x, p.z, VENT.radius, "vent") ?? null;
    vents.push({ x: p.x, z: p.z, phase: "warning", timer: CHALLENGE.ventWarning, tick: 0, marker });
  }

  function clearVents() {
    for (const v of vents) ctx.tele?.remove?.(v.marker);
    vents.length = 0;
  }

  // warning 1.5 s -> active 1.4 s (a blast on entry and every 0.5 s) -> recovery 2 s -> ...
  function updateVents(run, dt) {
    for (let i = 0; i < vents.length; i++) {
      // A blast can end the trial (its roster dies too) or the run; both clear the vents.
      if (run.trial?.state !== "active" || !simulating(run)) return;
      const v = vents[i];
      v.timer -= dt;
      if (v.timer <= 0) advanceVent(v);
      paintVent(v);
      if (v.phase === "active" && (v.tick -= dt) <= 0) {
        v.tick = VENT.pulse;
        ctx.combat?.explode?.(v.x, v.z, VENT.radius, CHALLENGE.ventDamage, true, undefined, ventBlast());
      }
    }
  }

  function advanceVent(v) {
    v.phase = v.phase === "warning" ? "active" : v.phase === "active" ? "recovery" : "warning";
    v.timer = v.phase === "active" ? CHALLENGE.ventActive : v.phase === "recovery" ? CHALLENGE.ventRecovery : CHALLENGE.ventWarning;
    if (v.phase === "active") v.tick = 0;
    if (v.phase === "warning") ctx.audio?.fx?.("warnGround", 1, v);
  }

  function paintVent(v) {
    const warming = v.phase === "warning" ? 1 - v.timer / CHALLENGE.ventWarning : 0,
      active = v.phase === "active";
    ventStyle.opacity = active ? 0.95 : v.phase === "warning" ? 0.45 + 0.4 * warming : 0.18;
    ventStyle.progress = active ? 1 : warming;
    ventStyle.wireframe = v.phase === "recovery";
    ctx.tele?.set?.(v.marker, ventStyle);
  }

  // Environmental friendly fire: hurts the player and every monster, never Insta Kill, no credit.
  const ventBlast = () => ({ weapon: -1, kind: "vent", source: VENT_CAUSE, environment: true, friendlyFire: true });

  // ---- statues, curses and Skull Trials ----------------------------------------------------

  function applyCurse(statue) {
    const run = bind();
    if (!run || !ctx.world?.statues?.activate(statue)) return false;
    const before = curse(run);
    run.difficultyBonus += BONUS;
    run.statueCount += 1;
    if (run.stats) run.stats.curses = run.statueCount;
    ctx.enemies?.rescale?.(curse(run) / before);
    ctx.fx?.ring?.(statue.x, statue.z, CURSE_RING, 3, 0.7);
    ctx.audio?.fx?.("charge", 1, statue);
    ctx.bus.emit("curse", { bonus: run.difficultyBonus, statue });
    ctx.hud?.update?.();
    return true;
  }

  function beginTrial(statue) {
    const run = bind(),
      trial = run?.trial,
      terrain = ctx.world?.terrain;
    if (!trial || trial.state !== "available" || !statue || statue.used || !terrain) return false;
    const places = trialLocations(terrain, statue, TRIAL_SITES, run.player);
    if (!places.length) {
      toast("NO SAFE TRIAL SPACE · STATUE NOT USED");
      return false;
    }
    const guarded = run.stage === ANCHOR_STAGE,
      hunters = guarded ? 1 : places.length;
    if ((ctx.enemies?.live?.() ?? 0) + hunters > MAX_HOSTILES) {
      toast("CLEAR A FEW MONSTERS BEFORE STARTING THIS TRIAL");
      return false;
    }
    const roster = [];
    for (let i = 0; i < hunters; i++) {
      const kind = i === 0 ? "brute" : run.stage >= VENT_STAGE ? "splitter" : "runner",
        e = spawnHunter(trial, kind, places[i], i === 0 ? 2 : 1.25);
      if (e) roster.push(e);
    }
    if (!roster.length) return false;
    if (guarded) {
      roster[0].trialElite = true;
      for (let i = 1; i < places.length; i++) addObject("anchor", places[i], CHALLENGE.anchorHP, trial.id);
    }
    if (run.stage === VENT_STAGE) for (let i = 0; i < VENT.sites; i++) addVent(places[i]);
    trial.statue = statue;
    // Activation applies the statue's curse, exactly once.
    trial.activate(
      roster.map((e) => e.id),
      () => applyCurse(statue),
    );
    toast("TRIAL STARTED · DEFEAT THE MARKED HUNT");
    ctx.bus.emit("trial", { state: "active", trial });
    return true;
  }

  function spawnHunter(trial, kind, place, toughness) {
    const e = ctx.enemies?.spawn?.(kind, place);
    if (!e) return null;
    e.hp *= toughness;
    e.max = e.hp;
    e.trialId = trial.id;
    markHunter(e);
    return e;
  }

  // A glowing ground ring parented to the model, so it inherits the model's scale.
  function markHunter(e) {
    const g = e.model?.g;
    if (!g) return;
    const mark = new THREE.Mesh(trialRing(), unlitMaterial(TRIAL_MARK));
    mark.position.y = 0.12;
    mark.scale.setScalar(1.25);
    mark.rotation.x = Math.PI / 2;
    g.add(mark);
  }

  // Kill processing, after enemies.onDeath registered any children (splitter splits and brood
  // summons join the roster through trial.descendant). True when this kill completed the trial.
  function trialDefeat(e) {
    const run = bind(),
      trial = run?.trial;
    if (!trial || !e || e.trialId !== trial.id || !trial.defeat(e.id)) return false;
    run.trialCount += 1;
    if (run.stats) run.stats.trials = run.trialCount;
    run.pacing?.recover?.(6);
    clearTrialObjects(run, trial);
    ctx.progression?.queue?.(trial.id, "trial");
    toast("TRIAL COMPLETE");
    ctx.bus.emit("trial", { state: "complete", trial });
    return true;
  }

  // Manual (pause menu), portal entry and run end. The statue stays used and the curse stays.
  // Any keeper that was waiting for the trial goes back to sleep until the goal re-wakes it.
  function abandonTrial() {
    const run = bind(),
      trial = run?.trial;
    if (!trial?.abandon()) return false;
    discardHunters(run, trial.id);
    clearTrialObjects(run, trial);
    if (run.keeperState === "waiting") run.keeperState = "dormant";
    toast("TRIAL ABANDONED · CURSE REMAINS");
    ctx.bus.emit("trial", { state: "abandoned", trial });
    return true;
  }

  // Trial stall fix (KEEPERS, F1.9): keepers wait for trials, so a roster member that has been
  // over 45 m away for 20 s straight rises again 14 m from the hero, at a bearing from the
  // "ai" stream, with the arrival grace.
  function huntStall(run, dt) {
    const trial = run.trial,
      p = run.player;
    if (trial?.state !== "active") return;
    for (const e of run.enemies) {
      if (e.trialId !== trial.id || e.dead || !(e.hp > 0) || e.removed) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) <= STALL.far) e.huntStall = 0;
      else if ((e.huntStall = (e.huntStall || 0) + dt) >= STALL.time) returnHunter(run, trial, e);
    }
  }

  function returnHunter(run, trial, e) {
    const p = run.player,
      a = stream(run, "ai")() * TAU,
      at = ctx.world?.terrain?.safeNear?.(p.x + Math.sin(a) * STALL.return, p.z + Math.cos(a) * STALL.return, e.def?.radius ?? 0.5);
    if (!at) return;
    if (e.marker) ctx.tele?.remove?.(e.marker);
    Object.assign(e, { x: at.x, z: at.z, huntStall: 0, grace: STALL.grace, state: "approach", timer: 0, marker: null, navCell: undefined });
    e.model?.g?.position.set(at.x, height(at.x, at.z), at.z);
    ctx.fx?.ring?.(at.x, at.z, TRIAL_MARK, 1.5, 0.45);
    ctx.fx?.burst?.(at.x, 0.2, at.z, TRIAL_MARK, 6, 1.6);
    if (trial.huntReturned) return;
    trial.huntReturned = true;
    toast("THE HUNT RETURNS");
  }

  // The marked hunt leaves at once: no kill, no collapse. remove() detaches each monster from
  // run.enemies by reassignment, so the loop walks a snapshot.
  function discardHunters(run, trialId) {
    for (const e of (run.enemies || []).slice()) {
      if (e.trialId !== trialId || e.removed) continue;
      ctx.enemies?.remove?.(e);
      e.hp = 0;
    }
  }

  // Trial-owned enemy shots and blasts, the anchors and every vent.
  function clearTrialObjects(run, trial) {
    const id = trial.id;
    ctx.combat?.removeShots?.((b) => b.enemy && b.emitter?.trialId === id);
    ctx.combat?.removeHazards?.((h) => h.owner === id);
    for (const o of run.objects) if (o.owner === id) releaseObject(o);
    clearVents();
  }

  // ---- decisions (statue and landmark dialogs) ---------------------------------------------

  // A dismissible choice (progression.decision): Escape / pad B picks the last card, "Leave".
  const decide = (title, options) => ctx.progression?.decision?.(title, options);

  function landmarkDialog(run, landmark) {
    const claimed = landmark.claimed;
    decide(landmark.name.toUpperCase(), [
      {
        title: claimed ? "Read inscription" : "Discover & recover",
        text: claimed ? landmark.text : `${landmark.text} Heal up to ${landmark.heal} integrity. One recovery per stage.`,
        onPick: () => discover(run, landmark),
      },
      { title: "Leave", text: "Continue through the fracture." },
    ]);
  }

  // One recovery per stage; the Journal records it for real runs (the profile checks). Pilgrim
  // Salts (KEEPERS, F9) makes it heal 30 and grant BONE WARD.
  function discover(run, landmark) {
    if (!landmark.claim()) return;
    const salts = !run.original && !!ctx.relics?.has?.("pilgrim_salts");
    ctx.player?.heal?.(salts ? PILGRIM_HEAL : landmark.heal, "landmark");
    if (salts) collectBoon("ward");
    run.pacing?.recover?.(landmark.rest);
    ctx.bus.emit("discovery", { id: landmark.id });
    ctx.audio?.fx?.("level");
    toast(`DISCOVERED · ${landmark.name.toUpperCase()}`);
  }

  function statueDialog(run, statue) {
    const trial = run.trial,
      rewarded = !!statue.rewarded && trial?.state === "available",
      leave = { title: "Leave", text: "Keep your current difficulty." };
    if (!run.original && keeperStands(run)) {
      toast(SILENT_SKULL, 2);
      return;
    }
    if (rewarded && run.keeperState === "active") {
      toast("DEFEAT IRON MAW BEFORE STARTING A TRIAL");
      return;
    }
    if (rewarded) {
      const detail = TRIAL_DETAIL[run.stage] ?? "Defeat the marked hunt.";
      decide(`SKULL TRIAL · ${TRIAL_NAMES[run.stage - 1]}`, [
        {
          title: "Accept trial",
          text: `+${BONUS}% persistent statue curse. ${detail} Reward: major mod, upgrade, or heal + ward.`,
          onPick: () => beginTrial(statue),
        },
        leave,
      ]);
    } else if (!run.original) omenDialog(statue, leave);
    else {
      decide("CHALLENGE-ONLY STATUE", [
        { title: "Accept curse", text: `+${BONUS}% persistent statue curse. No encounter reward.`, onPick: () => applyCurse(statue) },
        leave,
      ]);
    }
  }

  // KEEPERS challenge-only statues (F12): the statue's omen (drawn at stage build, offered by
  // ctx.omens.dialogCards), a bare curse, or Leave. Any curse is the original applyCurse; an
  // omen also activates.
  function omenDialog(statue, leave) {
    // dialogCards returns the whole dialog (omen, bare curse, leave); only its omen card is
    // taken here, since the bare curse and Leave below carry the handlers. Mapping its "leave"
    // card to acceptCurse would curse a player who chose to leave.
    const cards = ctx.omens?.dialogCards?.(statue) ?? [];
    const omens = cards.filter((card) => (card.kind ?? "omen") === "omen" && (card.id ?? card.omen)).map((card) => {
      const id = card.id ?? card.omen,
        omen = OMENS[id];
      return {
        ...card,
        title: card.title ?? omen?.name ?? "",
        text: card.text ?? `${omen?.text ?? ""} +${BONUS}% persistent curse. +${RIFT_SCORE + (omen?.bonus ?? 0)}% rift score.`,
        onPick: () => acceptCurse(statue, id),
      };
    });
    decide(OMEN_TITLE, [
      ...omens,
      { title: "Bare curse", text: `+${BONUS}% persistent curse. +${RIFT_SCORE}% rift score.`, onPick: () => acceptCurse(statue, null) },
      leave,
    ]);
  }

  function acceptCurse(statue, id) {
    if (!applyCurse(statue)) return;
    const omen = id ? OMENS[id] : null;
    if (omen) ctx.omens?.activate?.(id, "statue");
    toast(omen ? `${omen.name} · +${RIFT_SCORE + omen.bonus}% RIFT SCORE` : `SKULL CURSE · +${RIFT_SCORE}% RIFT SCORE`);
  }

  // The shrine bell (KEEPERS, F2) wins over the shrine when the hero stands nearer to it.
  function bellFirst(world, x, z) {
    const bell = world?.shrineBell,
      landmark = world?.landmark;
    if (!bell?.nearby(x, z)) return null;
    if (landmark?.nearby(x, z) && Math.hypot(landmark.x - x, landmark.z - z) < Math.hypot(bell.x - x, bell.z - z)) return null;
    return bell;
  }

  // Landmarks take priority over statues. Never in the tutorial or the demo. The bell's refusals
  // (a trial running) toast from the keeper flow.
  function interact() {
    const run = bind();
    if (!run?.player || ctx.mode !== "play" || ctx.overlay || inTutorial(run) || run.demo) return;
    const { x, z } = run.player,
      world = ctx.world,
      landmark = world?.landmark,
      bell = bellFirst(world, x, z);
    if (bell) {
      bell.ring();
      return;
    }
    if (landmark?.nearby(x, z)) {
      landmarkDialog(run, landmark);
      return;
    }
    const statue = world?.statues?.nearby(x, z);
    if (statue) statueDialog(run, statue);
  }

  // ---- interact prompt ---------------------------------------------------------------------

  function updatePrompt(run) {
    let text = null;
    if (ctx.mode === "play" && !inTutorial(run) && !run.demo) {
      const { x, z } = run.player,
        world = ctx.world,
        landmark = world?.landmark,
        bell = bellFirst(world, x, z);
      if (bell) text = promptFor(bell, BELL_PROMPT);
      else if (landmark?.nearby(x, z)) text = promptFor(landmark, landmark.name);
      else {
        const statue = world?.statues?.nearby(x, z);
        if (statue) text = promptFor(statue, statue.rewarded ? TRIAL_PROMPT : run.original ? CURSE_PROMPT : OMEN_PROMPT);
      }
    }
    ctx.hud?.setInteract?.(text);
  }

  // "<key> · <what>" with the last-used device's key; rebuilt only when an input changes.
  function promptFor(target, suffix) {
    const device = ctx.input?.device ?? "mouse",
      binding = ctx.prefs?.bindings?.interact ?? "";
    if (prompt.target !== target || prompt.suffix !== suffix || prompt.device !== device || prompt.binding !== binding) {
      prompt.target = target;
      prompt.suffix = suffix;
      prompt.device = device;
      prompt.binding = binding;
      const key = device === "touch" ? "INTERACT" : device === "pad" ? "X" : keyLabel(binding);
      prompt.text = `${key} · ${suffix}`;
    }
    return prompt.text;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  // Every encounter object (and anchor beam) and every vent: stage change, run end, victory.
  function clearChallenges() {
    const run = bind();
    if (!run) return;
    for (const o of run.objects) releaseObject(o);
    run.objects.length = 0;
    clearVents();
  }

  // Stage change: challenges plus ground drops. Bank shards (and caches) first with
  // collectAllGems().
  function clearStage() {
    const run = bind();
    if (!run) return;
    clearChallenges();
    for (const p of run.powerups) releasePickup(p);
    for (const c of run.caches) releaseCache(c);
    run.powerups.length = 0;
    run.caches.length = 0;
    run.gems.length = 0;
    cacheLight.intensity = 0;
    shards.hide();
  }

  // One simulation step. It also drives the world's animated props and (KEEPERS) the hazard
  // system, the relic caches, the trial stall fix and the lull flush.
  function update(dt) {
    const run = bind();
    if (!run?.player || !(dt > 0)) return;
    tickBoons(run.boons, dt);
    updateVents(run, dt);
    if (!simulating(run)) return;
    updateGems(run, dt);
    updatePowerups(run, dt);
    updateObjects(run, dt);
    ctx.world?.update?.(dt);
    if (!run.original) {
      updateCaches(run, dt);
      huntStall(run, dt);
      lullFlush(run);
      ctx.hazards?.update?.(dt);
    }
    updatePrompt(run);
  }

  // interact() is safe to reach twice for one press: the first call that opens a dialog leaves
  // play mode, and a refused one only repeats the same toast.
  ctx.bus.on("input:interact", interact);
  // A run's trial exists from its first frame (the HUD and pause menu read run.trial); the
  // original's finishRun cleared every challenge too.
  ctx.bus.on("runStart", bind);
  ctx.bus.on("stageEnter", bind);
  ctx.bus.on("runEnd", clearChallenges);
  ctx.bus.on("enemyKilled", onKilled);

  return {
    update,
    interact,
    applyCurse,
    beginTrial,
    abandonTrial,
    trialDefeat,
    dropGem,
    dropPowerup,
    collectAllGems,
    collectBoon,
    addObject,
    hurtObject,
    removeObjects,
    absorb,
    clearChallenges,
    clearStage,
    // Relic caches (KEEPERS, F8): dropCache(x, z) leaves the stage's RIFT-TOUCHED CACHE;
    // flushCaches() queues a "relic" reward per picked-up cache (a keeper's spoils, a lull,
    // portal entry).
    dropCache,
    flushCaches,
  };
}
