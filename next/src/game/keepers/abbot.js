// The Cinder Abbot, keeper of the Caldera (IMPROVEMENTS F4). It teaches flanking: the front
// crust shrugs off shots (x0.35) while the ember in its back takes double, it turns slowly, and
// it stops turning for about 3 s while it kneels to split the ground. The slam and the censer
// leave cinder patches that close off the floor; in phase 2 an ember trail follows it and a
// CENSER RELIGHT flares every patch at once. bosses.js calls register(kit) once per context and
// dispatches by e.keeper; the attacks are stateless ATTACKS entries under "abbot.*" ids, so the
// Warden's shade replays the fissure exactly.
import { clamp, lerp } from "../../core/util.js";
import { crownPoint, fissureBlasts, fissureYaws, relightZones, restoreZones, rockfallPoints, FISSURE } from "../logic/keepers.js";

const ID = (name) => `abbot.${name}`;
const STOP_RANGE = 3; // stops closing inside this, but still turns
const RAGE = Object.freeze({
  speed: 1.85,
  turn: 1.5,
  toast: "THE EMBER WAKES",
  guard: Object.freeze({ front: 70, frontMult: 0.6, rear: 110, rearMult: 1.75 }),
});
// Cinder patches: tick 0.5, 6 to the player and 15 to monsters; lava and cinders never burn
// the Abbot or the Ashworm.
const PATCH = Object.freeze({ tick: 0.5, player: 6, monsters: 15, immune: Object.freeze(["abbot", "ashworm"]), visual: "cinder", radius: 1.8, life: 4 });
const SLAM = Object.freeze({ reach: 5, windup: 0.9, radius: 4, damage: 26, monsters: 40, patches: 3, deathPatches: 5, scatter: 3.5 });
const CENSER = Object.freeze({ windup: 0.8, radius: 3.2, fuse: 1.2, damage: 24, monsters: 40, lead: 0.25, patch: 2.6, life: 5, peak: 5, height: 2, color: "#ffcf6a" });
// The crack runs from the Abbot to the last blast, 18 m out.
const FISSURE_HIT = Object.freeze({ windup: 1.1, width: 1.2, radius: 1.5, damage: 22, monsters: 40, basalt: "#2a1e22", cooled: 3 });
const RELIGHT = Object.freeze({ windup: 0.9, every: 16, grow: 1.3, pulse: 4, fewer: 2, seeds: 3, ring: 4.5, warn: 0.6 });
const TRAIL = Object.freeze({ every: 1.5, radius: 1.2, life: 4, max: 10, clear: 1.5 });
const RECOVER = Object.freeze({ slam: 1.2, censer: 0.5, fissure: 1, relight: 0.3 });
const COOLDOWN = Object.freeze({ slam: 2.4, censer: 2.8, fissure: 3.2, relight: 2 });
const POSE = Object.freeze({ raise: -2.2, overhead: -2.9, steps: 4, kneel: -0.5, staff: -1.3 });
const DEATH = Object.freeze({ gibs: 16, gibColor: "#7a756e", gibSize: 0.35, core: "#ff7a2e", coreHeight: 1.5, rise: 6, time: 1.2 });
const SOURCES = Object.freeze({
  slam: Object.freeze({ id: "abbot", label: "Abbot slam" }),
  censer: Object.freeze({ id: "abbot", label: "Censer burst" }),
  fissure: Object.freeze({ id: "abbot", label: "Fissure" }),
});

// Telegraph progress, reused (tele.set reads it at once).
const marking = { progress: 0 };
function progress(p) {
  marking.progress = clamp(p, 0, 1);
  return marking;
}

// A cinder patch owned by the scope's actor (a combat zone, sharing the 32-zone cap).
function cinders(k, x, z, radius, life, trail = false) {
  return k.zone(x, z, radius, { life, tick: PATCH.tick, playerDamage: PATCH.player, monsterDamage: PATCH.monsters, immune: PATCH.immune, visual: PATCH.visual, trail });
}

function livePatches(k) {
  let n = 0;
  for (const zone of k.ctx.combat?.zones?.() ?? []) if (!zone.dead && zone.owner === "abbot") n++;
  return n;
}

// ---- attacks -------------------------------------------------------------------------------

// SLAM: the censer is raised over a r 4 ground warning; the blast leaves 3 patches (5 in Death
// Mode) inside its own footprint, so none ignites under the player unwarned.
const slam = Object.freeze({
  windup: SLAM.windup,
  turn: 0.35,
  begin(actor, k) {
    const a = actor.attack;
    a.pose = "raise";
    a.mark = k.tele.area(actor.x, actor.z, SLAM.radius, "ground", { eta: SLAM.windup });
    k.sound("warnGround", actor.x, actor.z, "warnGround");
    k.voice(actor, "voiceBrute");
  },
  tick(actor, dt, k) {
    const a = actor.attack;
    a.raise = clamp(a.t / SLAM.windup, 0, 1);
    k.tele.set(a.mark, progress(a.raise));
    if (a.t < SLAM.windup) return false;
    k.explode(actor.x, actor.z, SLAM.radius, SLAM.damage, SLAM.monsters, SOURCES.slam, { friendlyFire: true });
    // Random points within 3.5 m on the ai stream (the Maw's scatter rule).
    for (const p of rockfallPoints(actor.x, actor.z, k.rng, a.opts.death ? SLAM.deathPatches : SLAM.patches, 0, SLAM.scatter)) cinders(k, p.x, p.z, PATCH.radius, PATCH.life);
    return true;
  },
});

// CENSER BURST: one ember lobbed at where the player will be in 0.25 s; the artillery blast
// lands after 1.2 s and leaves a 5 s patch there.
const censer = Object.freeze({
  windup: CENSER.windup,
  turn: 0.35,
  begin(actor) {
    actor.attack.pose = "swing";
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      p = k.player;
    a.raise = clamp(a.t / CENSER.windup, 0, 1);
    if (a.t < CENSER.windup) return false;
    if (p) lob(actor, k, p.x + (p.vx || 0) * CENSER.lead, p.z + (p.vz || 0) * CENSER.lead);
    return true;
  },
});

function lob(actor, k, x, z) {
  k.hazard(x, z, CENSER.radius, CENSER.damage, CENSER.fuse, "artillery", SOURCES.censer, { friendlyFire: true, monsterDamage: CENSER.monsters });
  k.fx?.lob?.({ x: actor.x, y: k.ground(actor.x, actor.z) + CENSER.height, z: actor.z }, { x, z }, CENSER.color, CENSER.peak, CENSER.fuse);
  let t = 0;
  k.effect({
    kind: "censer",
    tick(dt) {
      if ((t += dt) < CENSER.fuse) return false;
      cinders(k, x, z, CENSER.patch, CENSER.life);
      return true;
    },
  });
}

// FISSURE: kneels with the yaw locked toward the player at windup start (turn 0), then nine
// blasts run 2-18 m out along the crack 0.1 s apart; three lines at 0 and ±25° in phase 2 and
// Death Mode (a shade splits one). The Abbot turns again only after its recovery.
const fissure = Object.freeze({
  windup: FISSURE_HIT.windup,
  turn: 0,
  begin(actor, k, opts = {}) {
    const a = actor.attack;
    actor.lockYaw = actor.yaw = k.yawToPlayer(actor);
    a.pose = "kneel";
    a.next = 0;
    a.lines = fissureYaws(actor.lockYaw, !opts.shade && (actor.phase === 2 || !!opts.death)).map((yaw) => fissureBlasts(actor.x, actor.z, yaw));
    a.marks = a.lines.map((line) => k.tele.fissure([{ x: actor.x, z: actor.z }, ...line], FISSURE_HIT.width, "fissure", { eta: FISSURE_HIT.windup }));
    k.sound("rumble", actor.x, actor.z, "rumble");
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      since = a.t - FISSURE_HIT.windup;
    for (const mark of a.marks) k.tele.set(mark, progress(a.t / FISSURE_HIT.windup));
    // Blast i of every line lands together (1e-9: a step that lands a rounding error short).
    while (a.next < FISSURE.count && since >= a.lines[0][a.next].t - 1e-9) {
      for (const line of a.lines) split(k, line[a.next]);
      a.next++;
    }
    return since >= FISSURE.count * FISSURE.step - 1e-9;
  },
});

// One fissure blast and its cooled-basalt scar (harmless, clearly not lava).
function split(k, point) {
  k.explode(point.x, point.z, FISSURE_HIT.radius, FISSURE_HIT.damage, FISSURE_HIT.monsters, SOURCES.fissure, { friendlyFire: true });
  k.fx?.decal?.(point.x, point.z, FISSURE_HIT.basalt, FISSURE_HIT.radius, FISSURE_HIT.cooled);
}

// CENSER RELIGHT (phase 2): the censer rises overhead; with fewer than two live patches it first
// seeds three at 120° 4.5 m around itself (each warned 0.6 s), then every patch it owns returns
// to full life at x1.3 radius for 4 s.
const relight = Object.freeze({
  windup: RELIGHT.windup,
  turn: 0.35,
  begin(actor, k) {
    actor.attack.pose = "overhead";
    k.sound("rumble", actor.x, actor.z, "rumble");
  },
  tick(actor, dt, k) {
    const a = actor.attack;
    a.raise = clamp(a.t / RELIGHT.windup, 0, 1);
    if (!a.seeds && a.t >= RELIGHT.windup - RELIGHT.warn) a.seeds = seed(actor, k);
    if (a.t < RELIGHT.windup) return false;
    for (const p of a.seeds) cinders(k, p.x, p.z, PATCH.radius, PATCH.life);
    flare(k);
    return true;
  },
});

function seed(actor, k) {
  if (livePatches(k) >= RELIGHT.fewer) return [];
  return Array.from({ length: RELIGHT.seeds }, (_, i) => {
    const p = crownPoint(actor.yaw, i, RELIGHT.seeds, RELIGHT.ring, actor.x, actor.z);
    k.tele.area(p.x, p.z, PATCH.radius, "ground", { eta: RELIGHT.warn });
    return p;
  });
}

// The pulse is an effect on the Abbot, so it shrinks the patches back even if it dies first;
// a newer relight ends an older pulse before growing anything.
function flare(k) {
  let t = 0;
  const pulse = k.effect(
    {
      kind: "relight",
      lit: [],
      tick: (dt) => (t += dt) >= RELIGHT.pulse,
      end: () => restoreZones(pulse.lit),
    },
    { cap: 1 },
  );
  if (pulse) pulse.lit = relightZones(k.ctx.combat?.zones?.(), "abbot", RELIGHT.grow);
}

// ---- the AI --------------------------------------------------------------------------------

export function register(k) {
  k.attack.define(ID("slam"), slam);
  k.attack.define(ID("censer"), censer);
  k.attack.define(ID("fissure"), fissure);
  k.attack.define(ID("relight"), relight);

  const table = Object.freeze([
    Object.freeze({ id: ID("slam"), weight: 0, forced: (e, d) => d < SLAM.reach }),
    Object.freeze({ id: ID("censer"), weight: 0.5, min: 5, max: 20 }),
    Object.freeze({ id: ID("fissure"), weight: 0.5, min: 6, max: 26 }),
  ]);

  // Records: damage dealt by arc for the Quenched mastery (at least half to its back).
  k.ctx.bus.on("enemyHit", ({ e, damage = 0, arc } = {}) => {
    const fight = k.run?.keeper;
    if (!fight || fight.e !== e || e.keeper !== "abbot" || !(damage > 0)) return;
    fight.stats.total = (fight.stats.total || 0) + damage;
    if (arc === "rear") fight.stats.rear = (fight.stats.rear || 0) + damage;
  });

  // Phase 2 turns faster; windups keep their attack's share of it.
  const turn = (e) => (e.phase === 2 ? RAGE.turn / e.def.turn : 1);

  function begin(e, id) {
    if (id === ID("relight")) e.relightIn = RELIGHT.every;
    e.state = "attack";
    k.attack.start(e, id, { death: !!k.run?.death });
  }

  // The 50% gate is phase 2: the crust eases, the Abbot quickens and relights at once.
  function decide(e) {
    if (k.gateDue(e) !== null) {
      k.phase2(e, { toast: RAGE.toast });
      e.guard = RAGE.guard;
      begin(e, ID("relight"));
      return;
    }
    if (!(e.cooldown < 0)) return;
    if (e.phase === 2 && e.relightIn <= 0) {
      begin(e, ID("relight"));
      return;
    }
    const row = k.pick(e, table, k.distance(e));
    if (row) begin(e, row.id);
  }

  function finish(e, id) {
    e.state = "recover";
    e.after = id.slice(ID("").length);
    e.timer = RECOVER[e.after];
  }

  function walk(e, dt) {
    const x = e.x,
      z = e.z;
    if (!k.walk(e, k.speed(e.phase === 2 ? RAGE.speed : e.def.speed), dt, STOP_RANGE)) return false;
    if (e.phase === 2) trail(e, Math.hypot(e.x - x, e.z - z));
    return true;
  }

  // EMBER TRAIL (phase 2): a small patch every 1.5 m walked, never within 1.5 m of the player;
  // at most ten live, the oldest put out first.
  function trail(e, moved) {
    if ((e.walked += moved) < TRAIL.every) return;
    e.walked -= TRAIL.every;
    if (k.distance(e) < TRAIL.clear) return;
    const zone = cinders(k, e.x, e.z, TRAIL.radius, TRAIL.life, true);
    if (!zone) return;
    const list = e.trail;
    let kept = 0;
    for (const other of list) if (!other.dead) list[kept++] = other;
    list.length = kept;
    list.push(zone);
    while (list.length > TRAIL.max) k.ctx.combat?.removeZone?.(list.shift());
  }

  // Kneeling through the fissure and its recovery with the staff planted; the censer arm rises
  // (or swings once) through the other windups, held at 15 fps.
  function pose(e, stride) {
    const a = e.attack,
      kneeling = a?.pose === "kneel" || (e.state === "recover" && e.after === "fissure");
    k.place(e, kneeling ? 0 : stride);
    const model = e.model;
    if (!model) return;
    if (kneeling) {
      model.body.position.y = POSE.kneel;
      model.arms[1].rotation.x = POSE.staff;
      return;
    }
    const raise = Math.floor((a?.raise ?? 0) * POSE.steps) / POSE.steps;
    if (!(raise > 0)) return;
    const reach = a.pose === "swing" ? Math.sin(Math.PI * raise) : raise;
    model.arms[0].rotation.x = lerp(model.armPose, a.pose === "overhead" ? POSE.overhead : POSE.raise, reach);
  }

  return {
    onSpawn(e) {
      e.relightIn = RELIGHT.every;
      e.walked = 0;
      e.trail = [];
      e.after = null;
      if (e.model?.rig) e.model.rig.ground = k.ground;
    },
    update(e, dt) {
      e.relightIn -= dt;
      let stride = 0;
      if (e.state === "attack") {
        const id = e.attack?.id;
        k.face(e, dt, k.attack.turn(e) * turn(e));
        if (k.attack.step(e, dt)) finish(e, id);
      } else if (e.state === "recover") {
        e.timer -= dt;
        if (e.timer <= 0) {
          e.state = "approach";
          e.cooldown = COOLDOWN[e.after];
        }
      } else {
        decide(e);
        if (e.state === "approach") {
          k.face(e, dt, turn(e));
          if (walk(e, dt)) stride = 1;
        }
      }
      k.contact(e, e.def.damage, "Cinder Abbot");
      pose(e, stride);
    },
    // Crust gibs; the ember core leaves the body, rises 6 m over 1.2 s and winks out.
    onDeath(e) {
      const y = k.ground(e.x, e.z) + DEATH.coreHeight * (e.model?.g?.scale?.y ?? 1);
      if (e.model?.rig) e.model.rig.coreLit = false;
      k.fx?.lob?.({ x: e.x, y, z: e.z }, { x: e.x, y: y + DEATH.rise, z: e.z }, DEATH.core, 0, DEATH.time);
      k.fx?.gibs?.(e.x, e.z, DEATH.gibColor, DEATH.gibs, DEATH.gibSize);
      k.sound("impactStone", e.x, e.z, "impactStone");
      k.toast("THE EMBER GOES QUIET", 3);
    },
    label: (e) => (e.phase === 2 ? "THE CINDER ABBOT · THE EMBER WAKES" : "THE CINDER ABBOT"),
  };
}
