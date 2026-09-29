// The Castellan, keeper of the Citadel (IMPROVEMENTS F5). It tests fire discipline: on a
// telegraphed VIGIL it raises the Aegis as a dome over its whole body that returns every bullet
// from every side and nullifies everything else, so the answers are to stop shooting or to break
// the vigil with a beacon flare. Outside a vigil a tower shield blunts frontal fire (x0.5). Its
// punish window is the AURORA GRID, a checkerboard of light called down around the player while
// the shield is lowered (x1.25); the 70% and 35% gates call the garrison. bosses.js calls
// register(kit) once per context and dispatches by e.keeper (onBlocked and stagger included);
// the attacks are stateless ATTACKS entries under "castellan.*" ids, so the Warden's shade
// replays the grid exactly.
import { clamp, lerp } from "../../core/util.js";
import { HOSTILE_ROUND } from "../logic/combat.js";
import { garrisonPosts, gridStrikes, inSweep, reflectDamage, reflectSlot, rockfallPoints, toward, REFLECT, VIGIL } from "../logic/keepers.js";
import { fallenShield } from "../../render/models-keepers.js";

const ID = (name) => `castellan.${name}`;
const PHASE_GATE = 0.5; // the others (70%, 35%) call the garrison
const RAGE_TOAST = "THE WALL REMEMBERS";
const LOWERED_VULN = 1.25;
const STOP_RANGE = 3;
const STEP_IN = Object.freeze({ from: 3.5, to: 4, mult: 1.6 }); // closes into bash range
// The vigil: first 6 s into the fight, then every 9 s (7.5 in phase 2), each a 0.8 s windup over
// an r 2.4 aegis marker and a 2.6 s stance (3.2 in phase 2 and Death Mode).
const VIGILS = Object.freeze({ first: 6, every: 9, rageEvery: 7.5, windup: 0.8, stance: 2.6, longStance: 3.2, mark: 2.4 });
const BASH = Object.freeze({ reach: 3.5, windup: 0.55, radius: 3.2, half: Math.PI / 3, damage: 20 });
const GRID_HIT = Object.freeze({ windup: 1.4, half: 1.6, damage: 24, monsters: 40 });
const PILLAR = Object.freeze({ color: "#f4e2b0", height: 9, width: 0.45, life: 0.3 });
const GARRISON = Object.freeze({ windup: 1, lamp: 8, sniperRadius: 0.52, toast: "THE GARRISON ANSWERS" });
const POSTS = Object.freeze({ count: 2, min: 14, max: 22, gap: 6 });
const SUMMON = Object.freeze({ mark: "#d9d2b0", bypassCap: true });
const RECOVER = Object.freeze({ bash: 0.5, grid: 0.8, garrison: 0.4 });
const COOLDOWN = Object.freeze({ bash: 1.6, grid: 2.6, garrison: 2 });
// A reflection is a standard hostile round (not cyan) leaving the dome surface (2.2 m out) at
// its centre height, aimed at the chest with a little jitter.
const ROUND = Object.freeze({ color: HOSTILE_ROUND, speed: 14, range: 22, damage: 0, pierce: 0 });
const DOME = Object.freeze({ radius: 2.2, height: 1.4, jitter: 0.05, chest: 1.2 });
const GLAIVE = Object.freeze({ raise: -2.6, steps: 4 });
const GREY = "#9c9a8b";
const DEATH = Object.freeze({ shards: 40, color: "#83e7ff", ahead: 0.8, lift: 0.14 });
const SOURCES = Object.freeze({
  bash: Object.freeze({ id: "castellan", label: "Castellan bash" }),
  grid: Object.freeze({ id: "castellan", label: "Aurora grid" }),
  aegis: Object.freeze({ id: "aegis", label: "Aegis reflection" }),
});

// Telegraph updates, reused (tele.set reads them at once).
const aiming = { yaw: 0, progress: 0 };
const marking = { progress: 0 };
function progress(p) {
  marking.progress = clamp(p, 0, 1);
  return marking;
}

// ---- attacks -------------------------------------------------------------------------------

// BASH: a 120° shield sweep of 3.2 m along the keeper's facing, which turns slowly through the
// windup (the arc follows it).
const bash = Object.freeze({
  windup: BASH.windup,
  turn: 0.35,
  begin(actor, k) {
    actor.attack.mark = k.tele.arc(actor.x, actor.z, actor.yaw, BASH.radius, BASH.half, "arc", { eta: BASH.windup });
    k.voice(actor, "voiceBrute");
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      p = k.player;
    aiming.yaw = actor.yaw;
    aiming.progress = clamp(a.t / BASH.windup, 0, 1);
    k.tele.set(a.mark, aiming);
    if (a.t < BASH.windup) return false;
    if (p && inSweep(actor.x, actor.z, actor.yaw, p, BASH.radius, BASH.half)) k.hurt(BASH.damage, SOURCES.bash, actor.x, actor.z);
    return true;
  },
});

// AURORA GRID: the lattice is fixed on the player at windup start (the yaw locks too) and
// every cell is committed as a box hazard at once, each showing its own fuse: A at 1.4 s, B at
// 2.0 s and, in phase 2 and Death Mode, A again at 2.6 s; a shade strikes A only. A beacon flare
// that staggers the keeper leaves the cells to strike.
const grid = Object.freeze({
  windup: GRID_HIT.windup,
  turn: 0,
  begin(actor, k, opts = {}) {
    const p = k.player;
    actor.lockYaw = actor.yaw = k.yawToPlayer(actor);
    if (!p) return;
    const strikes = gridStrikes(p.x, p.z, opts.shade ? 1 : actor.phase === 2 || opts.death ? 3 : 2);
    for (const s of strikes)
      k.hazard(s.x, s.z, GRID_HIT.half, GRID_HIT.damage, s.fuse, "lance", SOURCES.grid, { friendlyFire: true, monsterDamage: GRID_HIT.monsters, shape: "box", sx: GRID_HIT.half, sz: GRID_HIT.half });
    k.effect(pillars(k, strikes));
  },
  tick: (actor) => actor.attack.t >= GRID_HIT.windup,
});

// A light column over each cell as its fuse runs out (the hazards strike on their own).
function pillars(k, strikes) {
  let t = 0,
    next = 0;
  return {
    kind: "grid",
    tick(dt) {
      t += dt;
      while (next < strikes.length && strikes[next].fuse <= t + 1e-9) {
        const s = strikes[next++];
        k.fx?.pillar?.(s.x, s.z, PILLAR.color, PILLAR.height, PILLAR.width, PILLAR.life);
      }
      return next >= strikes.length;
    },
  };
}

// GARRISON (forced by the 70% and 35% gates): the glaive rises to the bell; two snipers take the
// highest posts 14-22 m from the player and a lamplighter rises beside the keeper, all bearing
// the bone torus and outside the live cap.
const garrison = Object.freeze({
  windup: GARRISON.windup,
  turn: 0.35,
  begin(actor, k) {
    k.sound("garrisonBell", actor.x, actor.z, "garrisonBell");
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      p = k.player;
    a.raise = clamp(a.t / GARRISON.windup, 0, 1);
    if (a.t < GARRISON.windup) return false;
    if (p) {
      for (const post of sniperPosts(k, p)) k.summon("sniper", post, SUMMON);
      // A random point within 8 m on the ai stream (the Maw's scatter rule).
      k.summon("lamplighter", rockfallPoints(actor.x, actor.z, k.rng, 1, 0, GARRISON.lamp)[0], SUMMON);
    }
    k.toast(GARRISON.toast, 3);
    return true;
  },
});

// Reachable nav nodes in range (only those are measured); with none, terrain.spawn places them.
function sniperPosts(k, p) {
  const t = k.ctx.world?.terrain;
  if (!t) return [];
  const nodes = [];
  for (const i of t.reachable) {
    const n = t.position(i),
      d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d >= POSTS.min && d <= POSTS.max) nodes.push({ x: n.x, z: n.z, h: k.ground(n.x, n.z) });
  }
  const posts = garrisonPosts(nodes, p.x, p.z, POSTS);
  while (posts.length < POSTS.count) posts.push(t.spawn(p.x, p.z, GARRISON.sniperRadius, k.rng));
  return posts;
}

// ---- the AI --------------------------------------------------------------------------------

export function register(k) {
  k.attack.define(ID("bash"), bash);
  k.attack.define(ID("grid"), grid);
  k.attack.define(ID("garrison"), garrison);

  const table = Object.freeze([
    Object.freeze({ id: ID("bash"), weight: 0, forced: (e, d) => d < BASH.reach }),
    Object.freeze({ id: ID("grid"), weight: 1, min: 4, max: 26 }),
  ]);
  const origin = { x: 0, z: 0 };

  // Records: reflected hits that cost HP (Held Fire is a fight without one).
  k.ctx.bus.on("playerHit", ({ amount = 0, absorbed = 0, source } = {}) => {
    const fight = k.run?.keeper;
    if (fight?.id === "castellan" && source?.id === SOURCES.aegis.id && amount > absorbed) fight.stats.reflectHits = (fight.stats.reflectHits || 0) + 1;
  });
  // The first hit of each lowered window reads EXPOSED.
  k.ctx.bus.on("enemyHit", ({ e, damage = 0 } = {}) => {
    if (e?.keeper !== "castellan" || e.guard !== null || e.exposed || !(damage > 0)) return;
    e.exposed = true;
    k.fx?.label?.(e.x, null, e.z, "EXPOSED", GREY);
  });

  // Guard states (F5): the shield (the def's guard), the vigil dome, or lowered (x1.25).
  function shield(e) {
    e.guard = e.def.guard;
    e.vuln = 1;
  }
  function lower(e) {
    if (e.guard !== null) {
      e.exposed = false;
      k.emit(e, "lowered");
    }
    e.guard = null;
    e.vuln = LOWERED_VULN;
  }

  function begin(e, id) {
    if (id === ID("grid")) lower(e);
    e.state = "attack";
    k.attack.start(e, id, { death: !!k.run?.death });
  }

  // A decision point: a due gate first (the 50% gate is phase 2; the others call the garrison
  // and open as it begins), then a due vigil, then the attack table once the cooldown is out.
  function decide(e) {
    const gate = k.gateDue(e);
    if (gate === PHASE_GATE) k.phase2(e, { toast: RAGE_TOAST });
    else if (gate !== null) {
      k.openGate(e);
      e.garrisonDue = true;
    }
    if (e.garrisonDue) {
      e.garrisonDue = false;
      begin(e, ID("garrison"));
      return;
    }
    if (e.vigilIn <= 0) {
      startVigil(e);
      return;
    }
    if (!(e.cooldown < 0)) return;
    const row = k.pick(e, table, k.distance(e));
    if (row) begin(e, row.id);
  }

  // The bash recovers with the shield lowered, the grid keeps it lowered through its recovery.
  function finish(e, id) {
    e.state = "recover";
    e.after = id.slice(ID("").length);
    e.timer = RECOVER[e.after];
    if (e.after === "bash") lower(e);
  }

  // ---- VIGIL: a timed stance, never started inside an attack's windup or recovery ------------

  // Windup: the shield is planted, the Aegis flares and the dome fades in over an aegis marker.
  function startVigil(e) {
    e.state = "vigil";
    e.vigil = { stance: false, t: 0, reflections: 0, lastReflect: -Infinity, mark: k.tele.area(e.x, e.z, VIGILS.mark, "aegis", { eta: VIGILS.windup }) };
    e.vigilIn = e.phase === 2 ? VIGILS.rageEvery : VIGILS.every;
    k.emit(e, "vigil");
    if (e.vigils++ === 0) k.toast("VIGIL · HOLD YOUR FIRE", 3);
  }

  function vigilStep(e, dt) {
    const v = e.vigil;
    v.t += dt;
    if (v.stance) {
      if (v.t >= (e.phase === 2 || k.run?.death ? VIGILS.longStance : VIGILS.stance)) endVigil(e);
      return;
    }
    k.tele.set(v.mark, progress(v.t / VIGILS.windup));
    if (v.t < VIGILS.windup) return;
    dropMark(v);
    v.stance = true;
    v.t = 0;
    e.guard = VIGIL;
  }

  function endVigil(e) {
    dropMark(e.vigil);
    e.vigil = null;
    shield(e);
    e.state = "approach";
    k.emit(e, "vigilEnd");
  }

  function dropMark(v) {
    k.tele.remove(k.tele.keep(v.mark));
    v.mark = null;
  }

  // One returned round per blocked bullet, from any side, within the limiter.
  function reflect(e, shot) {
    const p = k.player,
      v = e.vigil;
    if (!p || !v?.stance || !reflectSlot(v, k.run.elapsed, e.phase === 2 ? REFLECT.rageCap : REFLECT.cap)) return;
    toward(e, p, DOME.radius, origin);
    const y = k.ground(e.x, e.z) + (e.y || 0) + DOME.height * (e.model?.g?.scale?.y ?? 1),
      chest = k.ground(p.x, p.z) + DOME.chest,
      reach = Math.hypot(p.x - origin.x, p.z - origin.z);
    k.ctx.combat?.projectile?.(origin.x, origin.z, Math.atan2(p.x - origin.x, p.z - origin.z) + k.rand(-DOME.jitter, DOME.jitter), ROUND, true, {
      emitter: e,
      source: { ...SOURCES.aegis, x: origin.x, z: origin.z },
      pitch: Math.atan2(chest - y, reach),
      y,
      damage: reflectDamage(shot?.damage ?? 0),
    });
  }

  function walk(e, dt) {
    const d = k.distance(e),
      pace = d >= STEP_IN.from && d < STEP_IN.to ? STEP_IN.mult : 1;
    return k.walk(e, k.speed(e.def.speed) * pace, dt, STOP_RANGE);
  }

  // Shield, dome and gem flags feed the model's rig before it animates; the glaive rises for
  // the garrison in 4 steps.
  function pose(e, stride) {
    const model = e.model,
      rig = model?.rig,
      a = e.attack;
    if (rig) {
      rig.lowered = e.guard === null;
      rig.vigil = !!e.vigil;
      rig.flare = !!e.vigil && !e.vigil.stance;
      rig.gemFlare = a?.id === ID("grid") || (e.state === "recover" && e.after === "grid");
      rig.steady = k.ctx.prefs?.flashes === false;
    }
    k.place(e, stride);
    const raise = a?.id === ID("garrison") ? Math.floor(a.raise * GLAIVE.steps) / GLAIVE.steps : 0;
    if (raise > 0 && model) model.arms[1].rotation.x = lerp(model.armPose[1], GLAIVE.raise, raise);
  }

  return {
    onSpawn(e) {
      shield(e);
      Object.assign(e, { vigil: null, vigilIn: VIGILS.first, vigils: 0, garrisonDue: false, after: null, exposed: false });
      const stats = k.stats();
      if (stats) stats.reflectHits = 0;
    },
    update(e, dt) {
      e.vigilIn -= dt;
      let stride = 0;
      if (e.state === "attack") {
        const id = e.attack?.id;
        k.face(e, dt, k.attack.turn(e));
        if (k.attack.step(e, dt)) finish(e, id);
      } else if (e.state === "recover" || e.state === "stagger") {
        e.timer -= dt;
        if (e.timer <= 0) {
          if (e.state === "recover") e.cooldown = COOLDOWN[e.after];
          shield(e);
          e.state = "approach";
        }
      } else if (e.state === "vigil") vigilStep(e, dt);
      else {
        decide(e);
        if (e.state === "approach") {
          k.face(e, dt);
          if (walk(e, dt)) stride = 1;
        }
      }
      if (e.state !== "stagger") k.contact(e, e.def.damage, "Castellan");
      pose(e, stride);
    },
    // A bullet stopped by the VIGIL dome comes back (the shield itself never blocks).
    onBlocked: reflect,
    // A beacon flare (or any stun): the vigil or its windup breaks and the keeper staggers with
    // the shield lowered. A grid's cells still strike; a cancelled garrison is called again.
    stagger(e, seconds) {
      if (e.vigil) endVigil(e);
      if (e.attack?.id === ID("garrison")) e.garrisonDue = true;
      k.attack.stop(e);
      e.timer = e.state === "stagger" ? Math.max(e.timer, seconds) : seconds;
      e.state = "stagger";
      lower(e);
    },
    // The shield topples flat and stays; the Aegis and the glaive gem shatter.
    onDeath(e) {
      if (e.vigil) {
        dropMark(e.vigil);
        e.vigil = null;
        k.emit(e, "vigilEnd");
      }
      const scale = e.model?.g?.scale;
      if (scale) {
        const prop = fallenShield(scale);
        prop.position.set(e.x + Math.sin(e.yaw) * DEATH.ahead, k.ground(e.x, e.z) + DEATH.lift, e.z + Math.cos(e.yaw) * DEATH.ahead);
        prop.rotation.y = e.yaw;
        k.decor(prop);
      }
      k.fx?.burst?.(e.x, k.ground(e.x, e.z) + DOME.height * (scale?.y ?? 1), e.z, DEATH.color, DEATH.shards, 4);
      k.sound("impactStone", e.x, e.z, "impactStone");
      k.toast("THE GATES OPEN", 3);
    },
    label(e) {
      if (e.vigil) return "THE CASTELLAN · VIGIL · HOLD FIRE";
      if (e.guard === null) return "THE CASTELLAN · EXPOSED";
      return e.phase === 2 ? `THE CASTELLAN · ${RAGE_TOAST}` : "THE CASTELLAN";
    },
  };
}
