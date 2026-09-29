// Rift-touched elites (ctx.elites, IMPROVEMENTS F8): the roll on ambient spawns (with pity and
// the body cap), the elite stat block, the six affix behaviours, BOUND pairs, and the per-stage
// rewards (the stage's first elite event slain drops a Relic Cache, later ones a guaranteed
// powerup). KEEPERS only, and only in real and practice runs: ORIGINAL, the tutorial and the
// attract demo never see an elite.
//
// Presentation is shared out by the bus: every elite event is emitted as "elite" { e, affixes,
// event: "spawn" | "defeat" | "shellBreak" | "enrage" } (one "spawn" per event, so a BOUND pair
// announces once); the HUD toasts and plates, audio plays its cues, the codex counts.
import { ELITE, AFFIXES } from "../data/affixes.js";
import { POWERUPS } from "../data/progression.js";
import { stageDef } from "../data/stages.js";
import { dressElite } from "../render/models-affixes.js";
import { setTint } from "../render/models.js";
import { playerCaused } from "./enemies.js";
import {
  AFFIX_IDS,
  rollElite,
  pickAffix,
  maxAlive,
  eliteChance,
  pityDue,
  eliteDef,
  platesLeft,
  shardYaws,
  eliteTitle,
  elitePowerup,
} from "./logic/elites.js";

export { AFFIX_IDS, rollElite, maxAlive, eliteChance, pityDue, eliteDef, platesLeft, shardYaws, eliteTitle, elitePowerup };

const POWERUP_KINDS = Object.freeze(Object.keys(POWERUPS));
const CHEST = 1.2;
const ARRIVAL = Object.freeze({ height: 8, width: 0.6, life: 0.5, opacity: 0.4, ring: 2.2, ringLife: 0.5 });
const PAIR_REACH = 2.5; // a BOUND partner stands this far from the first body
const PAIR_SLACK = 2; // snapped further than this from its spot, the partner cannot be placed
const PLATE_TURN = 1.2; // rad/s, held in 15 fps steps
const BONE = "#d9d2b0";
const SHARD = Object.freeze({ color: "#f0e6ff", radius: 1.5, flash: 2 });
const STREAKS = 3; // HASTED streak particles per second while moving
const MOVING = 0.5; // m/s
const ENRAGE_TINT = 0.35;

const eligible = (run) => !!run && !run.original && (run.kind === "real" || run.kind === "practice");
const alive = (e) => !!e && !e.dead && !e.removed && e.hp > 0;
const has = (e, id) => !!e.elite?.includes(id);

export function createElites(ctx) {
  const bodies = [];
  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;

  // ---- per-stage state ----------------------------------------------------------------------

  // run.stageElites counts elite events this stage (a BOUND pair is one); run.eliteState keeps
  // the stage's entry wave, events slain and the pity state ("idle" | "armed" | "spent").
  function resetStage(run) {
    run.stageElites = 0;
    run.eliteState = { stage: run.stage, entryWave: run.wave || 1, slain: 0, pity: "idle" };
    return run.eliteState;
  }
  const stateOf = (run) => (run.eliteState?.stage === run.stage ? run.eliteState : resetStage(run));
  // Waves since stage entry: the late-stage chance term restarts on every stage.
  const stageWave = (run, state) => Math.max(0, (run.wave || 1) - state.entryWave);

  function liveBodies(run) {
    let n = 0;
    for (const e of run?.enemies ?? []) if (e.elite && alive(e)) n++;
    return n;
  }

  // ---- the roll -----------------------------------------------------------------------------

  // roll(kind, { ambient, surge, forced }) -> { affixes, extra } | null. Ambient spawns only
  // (surges included); an armed pity forces the next one that can carry an affix.
  function roll(kind, { ambient = false, forced = false } = {}) {
    const run = ctx.run;
    if (!eligible(run) || !ambient) return null;
    const state = stateOf(run),
      pity = state.pity === "armed";
    const result = rollElite({
      kind,
      stage: run.stage,
      stageWave: stageWave(run, state),
      death: !!run.death,
      alive: liveBodies(run),
      keeperActive: run.keeperState === "active",
      forced: forced || pity,
      rng: run.stream("elites"),
      rules: ctx.rules,
    });
    if (result && pity) state.pity = "spent";
    return result;
  }

  // ---- making an elite ----------------------------------------------------------------------

  // Where a BOUND partner can stand beside `e`, or null.
  function partnerSpot(e, run) {
    const t = ctx.world?.terrain;
    if (!t) return null;
    const a = run.stream("elites")() * 2 * Math.PI,
      x = e.x + Math.sin(a) * PAIR_REACH,
      z = e.z + Math.cos(a) * PAIR_REACH,
      spot = t.safeNear(x, z, e.def.radius);
    return spot && Math.hypot(spot.x - x, spot.z - z) <= PAIR_SLACK ? spot : null;
  }

  function applyAffix(e, id) {
    const spec = AFFIXES[id];
    if (id === "hasted") {
      e.walkMul *= spec.walk;
      e.cooldownMul *= spec.cooldown;
      e.windupMul *= spec.windup;
    } else if (id === "warded") {
      e.shell = e.shellMax = spec.shell * e.max;
      e.shellT = 0;
      e.shellSeen = e.shell;
      e.hpSeen = e.hp;
      e.shellBroken = false;
      e.plates = spec.plates;
    } else if (id === "hexing") e.hexT = spec.first;
  }

  // Pillar and ring in the (first) affix colour as the body arrives.
  function arrive(e) {
    const color = AFFIXES[e.elite[0]].color;
    ctx.fx?.pillar?.(e.x, e.z, color, ARRIVAL.height, ARRIVAL.width, ARRIVAL.life, { opacity: ARRIVAL.opacity });
    ctx.fx?.ring?.(e.x, e.z, color, ARRIVAL.ring, ARRIVAL.ringLife);
  }

  // The chain drawn chest to chest between a BOUND pair (owned by the first body).
  function chainPoints(a, b) {
    return [
      { x: a.x, y: ground(a.x, a.z) + CHEST, z: a.z },
      { x: b.x, y: ground(b.x, b.z) + CHEST, z: b.z },
    ];
  }
  function link(first, second) {
    first.partner = second;
    second.partner = first;
    const [a, b] = chainPoints(first, second);
    first.chain = ctx.fx?.line?.(a, b, AFFIXES.bound.color, 0, ctx.tele?.minStrip?.() ?? 0.3) ?? null;
    first.chainA = a;
    first.chainB = b;
  }
  function dropChain(e) {
    for (const body of [e, e.partner]) {
      if (!body?.chain) continue;
      body.chain.remove?.();
      body.chain = null;
    }
  }

  // apply(e, roll, partner?): turns a fresh spawn into an elite, after its normal scaling: HP
  // x2.5, the elite stat block, the affix state, x1.18 model and a 0.6 s arrival. A BOUND roll
  // brings its partner (the same kind, beside it); if no partner fits, the elite re-rolls
  // without BOUND. `partner` marks the second body of a pair.
  function apply(e, rolled, partner = null) {
    const run = ctx.run;
    if (!e || !eligible(run) || e.elite || !rolled?.affixes?.length) return false;
    let affixes = [...rolled.affixes];
    let spot = null;
    if (!partner && affixes.includes("bound")) {
      spot = partnerSpot(e, run);
      if (!spot) {
        const other = pickAffix(e.kind, run.stream("elites"), maxAlive(run.stage) - liveBodies(run), [], ["bound"]);
        affixes = other ? [other] : [];
      }
    }
    if (!affixes.length) return false;
    e.elite = affixes;
    e.eliteExtra = !!rolled.extra;
    e.stageElite = true;
    e.hp = e.max = e.max * ELITE.hp;
    e.def = eliteDef(e.def);
    e.radius = e.def.radius;
    e.cooldownMul = 1;
    e.walkMul = 1;
    e.windupMul = 1;
    for (const id of affixes) applyAffix(e, id);
    e.model?.g?.scale.multiplyScalar(ELITE.scale);
    if (e.grace > 0) e.grace = e.graceLen = ELITE.grace;
    if (e.model) dressElite(e.model, affixes, { radius: e.def.radius });
    arrive(e);
    if (partner) {
      link(partner, e);
      return true;
    }
    stateOf(run);
    run.stageElites = (run.stageElites || 0) + 1;
    if (spot) ctx.enemies?.spawn?.(e.kind, spot, { elite: { affixes, extra: e.eliteExtra }, partner: e });
    for (const id of affixes) ctx.profile?.recordAffix?.(id, false);
    ctx.bus.emit("elite", { e, affixes, event: "spawn" });
    return true;
  }

  // ---- affix behaviours ---------------------------------------------------------------------

  // WARDED plates: one falls away per third of the shell lost; the ring turns in 15 fps steps.
  function showPlates(e, count, time) {
    if (count < e.plates) ctx.fx?.gibs?.(e.x, e.z, BONE, 2 * (e.plates - count), 0.14);
    e.plates = count;
    const parts = e.model?.parts;
    if (!parts?.plates) return;
    for (let i = 0; i < parts.plates.length; i++) parts.plates[i].visible = i < count;
    if (parts.plateRing) parts.plateRing.rotation.y = (Math.floor(time * 15) / 15) * PLATE_TURN;
  }

  // The shell regenerates in full 6 s after the last damage (shell or HP), unless it broke once.
  function tickWard(e, dt, time) {
    const hit = e.shell < e.shellSeen - 1e-6 || e.hp < e.hpSeen - 1e-6;
    e.shellT = hit ? 0 : e.shellT + dt;
    if (!e.shellBroken && e.shell < e.shellMax && e.shellT >= AFFIXES.warded.regenDelay) {
      e.shell = e.shellMax;
      ctx.audio?.fx?.("impactStone", 0.8, { x: e.x, z: e.z, src: e.kind }); // the plates clack back
    }
    e.shellSeen = e.shell;
    e.hpSeen = e.hp;
    showPlates(e, platesLeft(e.shell, e.shellMax), time);
  }

  // HEXING: every 5 s while the player is within 22 m, a hex mark under the player's feet.
  function tickHex(e, dt) {
    e.hexT -= dt;
    const p = ctx.run?.player,
      spec = AFFIXES.hexing;
    if (e.hexT > 0 || !p || Math.hypot(p.x - e.x, p.z - e.z) >= spec.range) return;
    ctx.combat?.hazard?.(p.x, p.z, spec.radius, spec.damage, spec.fuse, "hex", e.trialId ?? null, { id: "hexing", label: spec.source, x: p.x, z: p.z });
    e.hexT = spec.every;
  }

  function tickChain(e) {
    const mate = e.partner;
    if (!alive(mate)) return;
    const a = e.chainA,
      b = e.chainB;
    a.x = e.x;
    a.y = ground(e.x, e.z) + CHEST;
    a.z = e.z;
    b.x = mate.x;
    b.y = ground(mate.x, mate.z) + CHEST;
    b.z = mate.z;
    e.chain.update?.(a, b);
  }

  function tickStreaks(e, dt) {
    e.streakT = (e.streakT ?? 0) - dt;
    if (e.streakT > 0 || Math.hypot(e.vx || 0, e.vz || 0) < MOVING) return;
    e.streakT = 1 / STREAKS;
    ctx.fx?.burst?.(e.x, CHEST, e.z, AFFIXES.hasted.color, 1, 2);
  }

  // tick(e, dt): one simulation step of an elite's affixes (enemies.update, after its AI). The
  // hex clock holds through the arrival and any stun.
  function tick(e, dt) {
    if (!e?.elite || !alive(e)) return;
    const acting = !(e.grace > 0) && !(e.stunned > 0);
    if (has(e, "warded") && e.shellMax > 0) tickWard(e, dt, ctx.run?.elapsed ?? 0);
    if (has(e, "hexing") && acting) tickHex(e, dt);
    if (has(e, "hasted") && acting) tickStreaks(e, dt);
    if (e.chain) tickChain(e);
  }

  // A WARDED shell reached 0 (combat's damage pipeline): it shatters for good.
  function onShellBreak(e) {
    if (!has(e, "warded") || e.shellBroken) return;
    e.shellBroken = true;
    e.shell = 0;
    e.shellSeen = 0;
    showPlates(e, 0, 0);
    ctx.fx?.gibs?.(e.x, e.z, BONE, 8, 0.16);
    ctx.audio?.fx?.("shield", 1, { x: e.x, z: e.z, src: e.kind });
    ctx.bus.emit("elite", { e, affixes: e.elite, event: "shellBreak" });
  }

  // ---- death --------------------------------------------------------------------------------

  // MOLTEN: 0.8 s under a marker, then 20 to the player and 40 to monsters in 3 m (props too).
  function moltenBurst(e, player) {
    const { x, z } = e,
      spec = AFFIXES.molten.death;
    ctx.enemies?.fuse?.(x, z, spec.radius, spec.delay, "molten", () =>
      ctx.enemies?.blast?.(x, z, spec.radius, spec.player, spec.monsters, {
        cause: { id: "molten", label: spec.source, affix: "molten", x, z },
        kind: "molten",
        player,
      }), e.id);
  }

  // SHARDBORN: a pale flash and a 0.3 s marker, then 8 level shards, one per 45° sector.
  function shardBurst(e) {
    const { x, z } = e,
      spec = AFFIXES.shardborn.death,
      shard = { color: SHARD.color, damage: spec.damage, speed: spec.speed, range: spec.range, pierce: 0 };
    ctx.gfx?.flash?.(x, ground(x, z) + CHEST, z, SHARD.color, SHARD.flash);
    ctx.enemies?.fuse?.(x, z, SHARD.radius, spec.delay, "shard", () => {
      const run = ctx.run;
      if (!run) return;
      const y = ground(x, z) + CHEST;
      for (const yaw of shardYaws(run.stream("elites"), spec.shots))
        ctx.combat?.projectile?.(x, z, yaw, shard, true, { y, pitch: 0, source: { id: "shardborn", label: spec.source, affix: "shardborn", x, z } });
    }, e.id);
  }

  // BOUND: the survivor enrages (faster, shorter cooldowns, reddened).
  function enrage(e) {
    const spec = AFFIXES.bound.enrage;
    e.eliteEnraged = true;
    e.walkMul = (e.walkMul ?? 1) * spec.walk;
    e.cooldownMul = (e.cooldownMul ?? 1) * spec.cooldown;
    setTint(e.model, spec.tint, ENRAGE_TINT);
    ctx.bus.emit("elite", { e, affixes: e.elite, event: "enrage" });
  }

  // The stage's first elite event slain leaves a Relic Cache; later ones a guaranteed powerup
  // (none for the Omen of the Hunt's extras). A BOUND pair pays when its second body falls.
  function reward(e, run) {
    const state = stateOf(run);
    state.slain += 1;
    if (state.slain === 1) ctx.encounters?.dropCache?.(e.x, e.z);
    else if (!e.eliteExtra) {
      const kind = elitePowerup(run.stream("drops"), POWERUP_KINDS, (run.boons?.execution ?? 0) > 0);
      if (kind) ctx.encounters?.dropPowerup?.(e.x, e.z, kind);
    }
  }

  // onDeath(e, source): the death effects, before the kill event (enemies.onDeath).
  function onDeath(e, source) {
    const run = ctx.run;
    if (!e?.elite || e.eliteDown || !run) return;
    e.eliteDown = true;
    dropChain(e);
    if (has(e, "molten")) moltenBurst(e, playerCaused(source));
    if (has(e, "shardborn")) shardBurst(e);
    for (const id of e.elite) ctx.profile?.recordAffix?.(id, true);
    if (alive(e.partner)) enrage(e.partner);
    else reward(e, run);
    ctx.bus.emit("elite", { e, affixes: e.elite, event: "defeat" });
  }

  // ---- queries and lifecycle ----------------------------------------------------------------

  // The live elite bodies (a reused array; a BOUND pair is two).
  function aliveBodies() {
    bodies.length = 0;
    for (const e of ctx.run?.enemies ?? []) if (e.elite && alive(e)) bodies.push(e);
    return bodies;
  }

  // Stage entry: counters and pity start over (live elites leave with the stage).
  function stageReset() {
    if (ctx.run) resetStage(ctx.run);
  }

  // Pity: once half the stage's goal is met with no elite yet, the next ambient spawn is one.
  ctx.bus.on("enemyKilled", () => {
    const run = ctx.run;
    if (!eligible(run)) return;
    const state = stateOf(run);
    if (state.pity === "idle" && pityDue({ stage: run.stage, stageKills: run.stageKills, stageGoal: run.stageGoal, spawned: run.stageElites }))
      state.pity = "armed";
  });
  ctx.bus.on("runStart", () => {
    if (ctx.run) resetStage(ctx.run);
  });

  // ?practice=elites: one elite per affix on stage 3 (a BOUND pair counts as one), in a ring at
  // 14 m, each on a different kind of the stage's pool that can carry it.
  function showcase(c, params, h) {
    const run = ctx.run,
      p = run?.player;
    if (!p) return;
    const pool = stageDef(run.stage).pool;
    AFFIX_IDS.forEach((id, i) => {
      let kind = pool[i % pool.length];
      for (let k = 0; k < pool.length && (AFFIXES[id].exclude.includes(kind) || ELITE.never.includes(kind)); k++) kind = pool[(i + k + 1) % pool.length];
      const a = (i * 2 * Math.PI) / AFFIX_IDS.length;
      h.spawnAt(kind, p.x + Math.sin(a) * 14, p.z + Math.cos(a) * 14, { elite: { affixes: [id], extra: false } });
    });
  }
  ctx.bus.on("practice", ({ register }) => register("elites", showcase, { stage: 3 }));

  return {
    roll,
    apply,
    tick,
    onDeath,
    onShellBreak,
    alive: aliveBodies,
    stageReset,
    // The name plate and toast text, "HASTED WARDED SNIPER" (for the HUD).
    title: eliteTitle,
  };
}
