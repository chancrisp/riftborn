// The Bellwether, optional keeper of the Meadows (IMPROVEMENTS F2). It teaches dash timing:
// expanding toll bands are dashed through (or sheltered from), the crook sweeps anyone close,
// the flock closes in from the far side, and every third toll (and the 66% and 33% gates) rings
// a knell of three bands (four in Death Mode) after which the bell rests and the keeper kneels,
// open to punishment. bosses.js calls register(kit) once per context and dispatches by
// e.keeper; the attacks are stateless ATTACKS entries under "bellwether.*" ids, so the Warden's
// shade replays the toll exactly.
import { clamp, lerp } from "../../core/util.js";
import { bandHit, herdPoints, inSweep, knellTimes, sheltered, TOLL_HALF } from "../logic/keepers.js";

const COLOR = "#d2cba6";
const PHASE_GATE = 0.5; // the other gates (66%, 33%) force a knell
const STOP_RANGE = 4; // stops closing inside this, but still turns
const TOLL_EVERY = 3; // every third toll pick rings a knell instead
const TOLL = Object.freeze({ windup: 1, start: 1, reach: 16, speed: 8, rageSpeed: 9.5, damage: 18, mark: 2, cap: 3, eye: 0.6 });
const SWEEP = Object.freeze({ windup: 0.8, second: 0.35, radius: 5.5, half: (75 * Math.PI) / 180, damage: 22, dust: 9, dustColor: "#bac1a0" });
const HERD = Object.freeze({ windup: 0.7, kind: "runner", back: 12, offsets: Object.freeze([-3, -1, 1, 3]), hp: 0.8, cd: 11, rageCd: 7, flock: 6 });
const KNELL_REWARN = 0.6; // each later emission is warned this long before
const REST = Object.freeze({ time: 2.5, vuln: 1.5, body: -0.45 });
const RECOVER = Object.freeze({ sweep: 0.6, toll: 0.5, herd: 0.4 });
const COOLDOWN = Object.freeze({ sweep: 2, toll: 2.6, herd: 2, knell: 2 });
const BELL = Object.freeze({ swing: 0.25, herdSwing: 0.6, raise: -2.6, raiseSteps: 6 });
const DEATH = Object.freeze({ gibs: 14, gibColor: "#ffdca9", gibSize: 0.3, burst: 40, rate: 0.6 });
const SOURCES = Object.freeze({
  toll: Object.freeze({ id: "bellwether-toll", label: "Bellwether toll" }),
  crook: Object.freeze({ id: "bellwether", label: "Bellwether crook" }),
});

const ID = (name) => `bellwether.${name}`;

// ---- the toll wave -------------------------------------------------------------------------

// One band expanding from (ox, oz), r 1 to 16. It touches the player at most once: a hit, a
// Bone Ward absorption or a dash through it (one "phased") spends it, while post-hit
// invulnerability leaves it live for the next step. Terrain or a structure within 6 m of the
// player shelters them. Monsters are never affected. Carried by the host keeper as an effect,
// so it keeps travelling after the attack (or the shade that rang it) is gone.
function tollWave(k, ox, oz, speed) {
  const eye = { x: ox, y: k.ground(ox, oz) + TOLL.eye, z: oz },
    target = { x: 0, y: 0, z: 0 },
    stats = k.stats(),
    marker = k.tele.keep(k.tele.band(ox, oz, TOLL.start, TOLL_HALF, "wave", {})),
    wave = { kind: "wave", r: TOLL.start, spent: false };

  function test() {
    const p = k.player;
    if (wave.spent || !p || !bandHit(Math.hypot(p.x - ox, p.z - oz), wave.r)) return;
    target.x = p.x;
    target.y = k.ground(p.x, p.z) + TOLL.eye;
    target.z = p.z;
    if (sheltered(k.trace(eye, target), p)) return;
    const result = k.hurt(TOLL.damage, SOURCES.toll, ox, oz);
    if (result === "inv") return;
    wave.spent = true;
    if (result === "hit" && stats) stats.tollHits = (stats.tollHits || 0) + 1;
  }

  wave.tick = (dt) => {
    wave.r += speed * dt;
    if (wave.r > TOLL.reach) return true;
    k.tele.set(marker, { radius: wave.r });
    test();
    return false;
  };
  wave.end = () => k.tele.remove(marker);
  test(); // a player standing inside the first metre is tested at once
  return wave;
}

// The bell tolls: the wave leaves the actor's position at 8 m/s (9.5 in phase 2), with the
// Death Mode and curse speed terms.
function emitWave(actor, k) {
  k.sound("toll", actor.x, actor.z, "toll");
  k.effect(tollWave(k, actor.x, actor.z, k.speed(actor.phase === 2 ? TOLL.rageSpeed : TOLL.speed)), { cap: TOLL.cap });
}

// The toll warning on the keeper: a wave area of r 2 and, before the first band, the static
// r 16 reach guide at the guide width and half opacity. Replaces the previous warning.
function warnToll(actor, k, guide) {
  const a = actor.attack;
  k.tele.remove(a.mark);
  a.mark = k.tele.area(actor.x, actor.z, TOLL.mark, "wave", { eta: TOLL.windup });
  if (guide) {
    a.guide = k.tele.band(actor.x, actor.z, TOLL.reach, k.tele.minGuide() / 2, "wave", { eta: TOLL.windup });
    k.tele.set(a.guide, { opacity: 0.5 });
  }
  k.sound("warnRing", actor.x, actor.z, "warnRing");
}

function clearWarning(a, k) {
  k.tele.remove(a.mark);
  k.tele.remove(a.guide);
  a.mark = a.guide = null;
}

// ---- attacks -------------------------------------------------------------------------------

// TOLL: the bell rises overhead for 1 s, then one band.
const toll = Object.freeze({
  windup: TOLL.windup,
  turn: 0.35,
  begin(actor, k) {
    warnToll(actor, k, true);
  },
  tick(actor, dt, k) {
    const a = actor.attack;
    a.raise = clamp(a.t / TOLL.windup, 0, 1);
    k.tele.set(a.mark, { progress: a.raise });
    if (a.t < TOLL.windup) return false;
    clearWarning(a, k);
    emitWave(actor, k);
    return true;
  },
});

// KNELL: bands at 1.0, 2.0 and 3.0 s (and 4.6 s in Death Mode). The first windup shows the toll
// warning; each later band gets a 0.6 s wave marker and warnRing as the bell rises again.
const knell = Object.freeze({
  windup: TOLL.windup,
  turn: 0.35,
  begin(actor, k, opts = {}) {
    const a = actor.attack;
    a.times = knellTimes(!!opts.death);
    a.next = 0;
    a.warned = 1;
    a.from = 0;
    warnToll(actor, k, true);
  },
  tick(actor, dt, k) {
    const a = actor.attack,
      due = a.times[a.next];
    if (a.warned === a.next && a.t >= due - KNELL_REWARN) {
      a.warned++;
      a.from = due - KNELL_REWARN;
      warnToll(actor, k, false);
    }
    const warned = a.warned > a.next;
    a.raise = warned ? clamp((a.t - a.from) / (due - a.from), 0, 1) : 0;
    if (warned) k.tele.set(a.mark, { progress: a.raise });
    if (a.t < due) return false;
    clearWarning(a, k);
    emitWave(actor, k);
    a.raise = 0;
    return ++a.next >= a.times.length;
  },
});

// SWEEP: a 75° crook arc of 5.5 m, the yaw locked at windup start; in phase 2 a mirrored second
// sweep locks onto the player's bearing the instant the first resolves (windup 0.35 s).
const sweep = Object.freeze({
  windup: SWEEP.windup,
  turn: 0,
  begin(actor, k, opts = {}) {
    const a = actor.attack;
    a.double = !!opts.double;
    a.second = false;
    aimSweep(actor, k, 0, SWEEP.windup);
  },
  tick(actor, dt, k) {
    const a = actor.attack;
    k.tele.set(a.mark, { progress: clamp((a.t - a.from) / (a.due - a.from), 0, 1) });
    if (a.t < a.due) return false;
    resolveSweep(actor, k);
    if (!a.double || a.second) return true;
    a.second = true;
    aimSweep(actor, k, a.t, SWEEP.second);
    return false;
  },
});

function aimSweep(actor, k, from, windup) {
  const a = actor.attack;
  actor.lockYaw = actor.yaw = k.yawToPlayer(actor);
  a.from = from;
  a.due = from + windup;
  k.tele.remove(a.mark);
  a.mark = k.tele.arc(actor.x, actor.z, actor.lockYaw, SWEEP.radius, SWEEP.half, "arc", { eta: windup });
}

function resolveSweep(actor, k) {
  const p = k.player;
  if (p && inSweep(actor.x, actor.z, actor.lockYaw, p, SWEEP.radius, SWEEP.half)) k.hurt(SWEEP.damage, SOURCES.crook, actor.x, actor.z);
  for (let i = 0; i < SWEEP.dust; i++) {
    const yaw = actor.lockYaw + lerp(-SWEEP.half, SWEEP.half, i / (SWEEP.dust - 1)),
      r = SWEEP.radius * 0.8;
    k.fx?.burst?.(actor.x + Math.sin(yaw) * r, 0.3, actor.z + Math.cos(yaw) * r, SWEEP.dustColor, 3, 2);
  }
}

// HERD: four runners (80% HP, a pale torus) rise in a pincer 12 m beyond the player.
const herd = Object.freeze({
  windup: HERD.windup,
  turn: 0.35,
  begin(actor, k) {
    k.voice(actor, "voiceGroan");
  },
  tick(actor, dt, k) {
    if (actor.attack.t < HERD.windup) return false;
    const p = k.player;
    if (p) for (const point of herdPoints(actor, p, HERD.back, HERD.offsets)) k.summon(HERD.kind, point, { mark: COLOR, hpScale: HERD.hp, bypassCap: true });
    return true;
  },
});

// ---- the AI --------------------------------------------------------------------------------

export function register(k) {
  k.attack.define(ID("toll"), toll);
  k.attack.define(ID("knell"), knell);
  k.attack.define(ID("sweep"), sweep);
  k.attack.define(ID("herd"), herd);

  function flock() {
    let n = 0;
    for (const e of k.run?.enemies ?? []) if (e.summonedBy === "bellwether" && e.hp > 0 && !e.dead) n++;
    return n;
  }

  const table = Object.freeze([
    Object.freeze({ id: ID("sweep"), weight: 0, forced: (e, d) => d < SWEEP.radius }),
    Object.freeze({ id: ID("toll"), weight: 0.6, min: SWEEP.radius }),
    Object.freeze({ id: ID("herd"), weight: 0.4, cd: "herdCD", when: () => flock() < HERD.flock }),
  ]);

  function begin(e, id) {
    if (id === ID("herd")) e.herdCD = e.phase === 2 ? HERD.rageCd : HERD.cd;
    e.state = "attack";
    k.attack.start(e, id, { double: e.phase === 2, death: !!k.run?.death });
  }

  // A decision point: a due gate first (the 50% gate is phase 2; the others force a knell and
  // open as it begins), then the attack table once the cooldown has run out.
  function decide(e) {
    const gate = k.gateDue(e);
    if (gate === PHASE_GATE) k.phase2(e, { color: COLOR, toast: "THE FLOCK ANSWERS" });
    else if (gate !== null) {
      k.openGate(e);
      begin(e, ID("knell"));
      return;
    }
    if (!(e.cooldown < 0)) return;
    const row = k.pick(e, table, k.distance(e));
    if (!row) return;
    begin(e, row.id === ID("toll") && ++e.tolls % TOLL_EVERY === 0 ? ID("knell") : row.id);
  }

  // After a knell the bell rests (2.5 s, x1.5 damage, no contact); after anything else the
  // keeper recovers, then waits out that attack's cooldown.
  function finish(e, id) {
    const kind = id?.slice(ID("").length);
    if (kind === "knell") {
      e.state = "rest";
      e.timer = REST.time;
      e.vuln = REST.vuln;
      k.emit(e, "rest");
      if (e.rests++ === 0) k.toast("THE BELL RESTS · STRIKE NOW", 2);
    } else if (kind in RECOVER) {
      e.state = "recover";
      e.after = kind;
      e.timer = RECOVER[kind];
    } else e.state = "approach";
  }

  // The bell swings (sideways for the herd), rises overhead through toll windups, and lies on
  // the ground while the keeper kneels in its rest; held at 15 fps.
  function pose(e, stride) {
    const resting = e.state === "rest";
    k.place(e, resting ? 0 : stride);
    const model = e.model;
    if (!model) return;
    const bell = model.parts?.bell,
      a = e.attack;
    if (resting) {
      model.body.position.y = REST.body;
      for (const arm of model.arms) arm.rotation.x = 0;
      if (bell) bell.rotation.z = 0;
      return;
    }
    const t = Math.floor((k.run?.elapsed ?? 0) * 15) / 15,
      herding = a?.id === ID("herd");
    if (bell) bell.rotation.z = Math.sin(t * (herding ? 12 : 6)) * (herding ? BELL.herdSwing : BELL.swing);
    const raise = a?.raise ?? 0;
    if (raise > 0 && model.arms[1]) model.arms[1].rotation.x = lerp(model.armPose, BELL.raise, Math.floor(raise * BELL.raiseSteps) / BELL.raiseSteps);
  }

  return {
    onSpawn(e) {
      e.herdCD = -1;
      e.tolls = 0;
      e.rests = 0;
      e.after = null;
    },
    update(e, dt) {
      e.herdCD -= dt;
      let stride = 0.4;
      if (e.state === "attack") {
        const id = e.attack?.id;
        k.face(e, dt, k.attack.turn(e));
        if (k.attack.step(e, dt)) finish(e, id);
      } else if (e.state === "recover") {
        e.timer -= dt;
        // The keeper walks on while its toll travels; other recoveries hold still.
        if (e.after === "toll" && k.walk(e, k.speed(e.def.speed), dt, STOP_RANGE)) stride = 1;
        if (e.timer <= 0) {
          e.state = "approach";
          e.cooldown = COOLDOWN[e.after];
        }
      } else if (e.state === "rest") {
        e.timer -= dt;
        if (e.timer <= 0) {
          e.vuln = 1;
          e.state = "approach";
          e.cooldown = COOLDOWN.knell;
        }
      } else {
        decide(e);
        if (e.state === "approach") {
          k.face(e, dt);
          if (k.walk(e, k.speed(e.def.speed), dt, STOP_RANGE)) stride = 1;
        }
      }
      if (e.state !== "rest") k.contact(e, e.def.damage, "Bellwether");
      pose(e, stride);
    },
    // The bell falls and cracks, and stays in the Meadows until the stage ends.
    onDeath(e) {
      k.sound("toll", e.x, e.z, "toll", { rate: DEATH.rate });
      k.sound("impactStone", e.x, e.z, "impactStone");
      k.fx?.gibs?.(e.x, e.z, DEATH.gibColor, DEATH.gibs, DEATH.gibSize);
      k.fx?.burst?.(e.x, 1.5, e.z, COLOR, DEATH.burst, 4);
      const bell = e.model?.parts?.bell;
      if (bell && k.decor(bell)) {
        bell.position.y = k.ground(bell.position.x, bell.position.z) + 0.3;
        bell.rotation.set(0, bell.rotation.y, Math.PI / 2);
      }
      k.toast("THE BELL IS SILENT", 3);
    },
    label(e) {
      if (e.state === "rest") return "THE BELLWETHER · RESTING";
      return e.phase === 2 ? "THE BELLWETHER · THE FLOCK ANSWERS" : "THE BELLWETHER";
    },
  };
}
