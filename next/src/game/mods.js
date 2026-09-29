// Weapon mods (Splinter Rounds, Storm Needle, Graveburst, Rift Scar, Event Horizon), dash
// traits (Rift Echo, Void Wake) and the build cue line. Every effect goes through combat's
// projectile, damage and blast path. Only a primary (generation 0) shot of the modded weapon
// triggers its mod; secondaries, echoes, arcs and scar ticks are generation 1 and never chain.
import * as THREE from "three";
import { BALANCE as B, TRAIL_COLORS } from "../data/progression.js";
import { WEAPONS } from "../data/weapons.js";
import { unlitMaterial } from "../render/materials.js";
import { hitBody } from "../world/ballistics.js";
import { volleyOffset, pitchTo } from "./combat.js";

const MOD = Object.freeze({ splinter: 0, storm: 1, grave: 2, scar: 3, horizon: 4 });
const SPLINTER_ANGLE = 0.45;
const SPLINTER_RANGE = 16;
const GRAVE_STEP = 0.16; // five fragments at -0.32..+0.32 rad
const GRAVE_FLIGHT = 10;
const SECONDARY_OFFSET = 0.12; // secondaries start this far from the hit, if no wall is between
const CHEST_HEIGHT = 1.2; // arcs and pulls aim at the chest
const MUZZLE_HEIGHT = 1.47;
const PLAYER_RADIUS = 0.45;
const PULL_CORE = 0.4; // pulled monsters stop this close to the singularity
const ORB_THICKNESS = 0.4;
const WAKE_REACH = 1.2;
const WAKE_MIN_SEGMENT = 0.05;
const ECHO_OPACITY = 0.4;
const STORM_FLASH = 0.18;
const COLORS = Object.freeze({ storm: "#89cbd7", scar: "#c3a4d4", orb: "#b891cf" });

// Build cue copy (spec combat §17.1): shown in #buildCue for 1.1 s, per-type cooldowns.
const CUE_TEXT = Object.freeze({
  splinter: "SPLINTER · SPLIT",
  storm: "STORM NEEDLE · ARC",
  stormEmpty: "STORM NEEDLE · DISCHARGED",
  grave: "GRAVEBURST",
  scar: "RIFT SCAR · ACTIVE",
  pull: "EVENT HORIZON · PULL",
  detonate: "EVENT HORIZON · DETONATE",
  echoReady: "RIFT ECHO · READY",
  echoExpired: "RIFT ECHO · EXPIRED",
  echo: "RIFT ECHO · VOLLEY",
  wake: "VOID WAKE · TRAIL",
});
const CUE_LIFE = 1.1;
const CUE_COOLDOWN = 1.2;
const SLOW_CUE_COOLDOWN = 2; // continuous effects (scar, wake) re-cue less often
const SLOW_CUES = new Set(["scar", "wake"]);

// Event Horizon ring: a flat torus scaled (r, r, thin) about its own axis, then laid down,
// so it reads as a true circle of the pull radius (the original's scale made an ellipse).
const ORB_GEOMETRY = new THREE.TorusGeometry(1, 0.08, 6, 32);
const NO_MODS = Object.freeze({ mods: Object.freeze([]), dash: null, charge: 0 });
const SIDES = Object.freeze([-1, 1]);
const notDead = (item) => !item.dead;
const notDone = (item) => !item.done;
const living = (item) => item.life > 0;

export function createMods(ctx) {
  const scars = [],
    pulls = [],
    wake = [],
    scarCooldown = new Map(), // target id -> seconds; shared by every scar
    spareOrbs = [],
    arcCandidates = [],
    // Own target lists: damage dealt while iterating may re-enter combat.targets().
    scarTargets = [],
    pullTargets = [],
    arcTargets = [];
  let echo = null,
    dashTickAt = NaN,
    effectTickAt = NaN;
  const cue = { shown: null, life: 0, cooldowns: Object.fromEntries(Object.keys(CUE_TEXT).map((k) => [k, 0])) };

  // Scratch points for traces and lines (consumed immediately).
  const pointA = { x: 0, y: 0, z: 0 },
    pointB = { x: 0, y: 0, z: 0 };

  const ground = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const build = () => ctx.run?.build ?? NO_MODS;
  const alive = (t) => t && !t.dead && t.hp > 0;
  const clearLine = (a, b) => !ctx.world?.trace?.(a, b, 0);
  const enabled = (shot, id) => shot.generation === 0 && shot.weapon === id && build().mods.includes(id);
  // Bosses and encounter objects resist pulls and slows.
  const resists = (e) => !!(e.fixed || e.miniboss || e.boss || e.kind === "warden");

  function chest(e, out) {
    out.x = e.x;
    out.y = ground(e.x, e.z) + CHEST_HEIGHT;
    out.z = e.z;
    return out;
  }

  // One tick per simulation step however many callers (the director at step start and
  // combat.update both may call); keyed on run time so the demo's sub-steps each count.
  function firstTickAt(last) {
    const now = ctx.run?.elapsed;
    return Number.isFinite(now) && now === last ? null : now;
  }

  // ---- build cue -------------------------------------------------------------------------

  function emitCue(type) {
    if (ctx.run?.demo) return false;
    if (type === "echoCancel") {
      // A spent echo clears its READY line, and only that line.
      if (cue.shown === "echoReady" && cue.life > 0) {
        cue.shown = null;
        cue.life = 0;
        ctx.hud?.cue?.("");
      }
      return false;
    }
    const text = CUE_TEXT[type];
    if (!text || cue.cooldowns[type] > 0) return false;
    cue.shown = type;
    cue.life = CUE_LIFE;
    cue.cooldowns[type] = SLOW_CUES.has(type) ? SLOW_CUE_COOLDOWN : CUE_COOLDOWN;
    ctx.hud?.cue?.(text);
    ctx.audio?.fx?.(type === "echoReady" ? "switch" : "proc");
    return true;
  }

  function tickCue(dt) {
    cue.life = Math.max(0, cue.life - dt);
    if (!cue.life) cue.shown = null;
    for (const type in cue.cooldowns) cue.cooldowns[type] = Math.max(0, cue.cooldowns[type] - dt);
  }

  function clearCue() {
    for (const type in cue.cooldowns) cue.cooldowns[type] = 0;
    if (cue.shown) ctx.hud?.cue?.("");
    cue.shown = null;
    cue.life = 0;
  }

  // ---- secondary projectiles -------------------------------------------------------------

  // A splinter or bone fragment leaving hit point `p` at `angle`: the parent's speed, colour,
  // pitch and group, a share of its base damage, Ghost Rounds pierce only, and the parent's
  // struck targets excluded. None if its 0.12 m start would cross terrain or cover.
  function secondary(shot, p, angle, factor, range, kind) {
    const w = WEAPONS[shot.weapon];
    if (!w) return null;
    pointA.x = p.x + Math.sin(angle) * SECONDARY_OFFSET;
    pointA.y = p.y;
    pointA.z = p.z + Math.cos(angle) * SECONDARY_OFFSET;
    if (!clearLine(p, pointA)) return null;
    return ctx.combat?.projectile?.(pointA.x, pointA.z, angle, { ...w, range, rocket: false }, false, {
      y: p.y,
      pitch: Math.atan2(shot.vy, Math.hypot(shot.vx, shot.vz)),
      damage: shot.damage * factor,
      pierce: ctx.run?.player?.pierce ?? 0,
      weapon: shot.weapon,
      kind,
      shotId: shot.shotId,
      generation: 1,
      group: shot.group,
      hits: new Set(shot.hits),
    });
  }

  // ---- weapon mods -----------------------------------------------------------------------

  // After every non-rocket body hit (`p` = hit point): Splinter Rounds and Storm Needle.
  function onHit(shot, target, p) {
    if (!shot || !target || !p) return;
    if (enabled(shot, MOD.splinter) && !shot.split) {
      shot.split = true;
      const heading = Math.atan2(shot.vx, shot.vz);
      let made = 0;
      for (const side of SIDES) if (secondary(shot, p, heading + side * SPLINTER_ANGLE, B.splinter, SPLINTER_RANGE, "splinter")) made++;
      if (made) emitCue("splinter");
    }
    if (enabled(shot, MOD.storm) && shot.group && !shot.group.charged) {
      // One charge per connected trigger pull; the charge lives in the run build.
      shot.group.charged = true;
      const b = ctx.run.build;
      b.charge = (b.charge || 0) + 1;
      if (b.charge >= B.stormHits) {
        b.charge = 0;
        stormChain(shot, target, p);
      }
    }
  }

  // Nearest live, unvisited target within the hop radius with a clear line from `origin`.
  function nextArcTarget(origin, visited) {
    arcCandidates.length = 0;
    const targets = ctx.combat?.targets?.(arcTargets) ?? arcTargets;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (visited.has(t.id)) continue;
      const d = Math.hypot(t.x - origin.x, t.z - origin.z);
      if (d <= B.stormRadius) arcCandidates.push({ t, d });
    }
    arcCandidates.sort((a, b) => a.d - b.d);
    for (const { t } of arcCandidates) if (clearLine(origin, chest(t, pointB))) return t;
    return null;
  }

  // Storm Needle discharge: up to three non-critical arcs hopping target to target.
  function stormChain(shot, first, p) {
    const origin = { x: p.x, y: p.y, z: p.z },
      visited = new Set([first.id]),
      source = { weapon: shot.weapon, kind: "storm", generation: 1, group: shot.group, shotId: shot.shotId };
    let arcs = 0;
    for (let i = 0; i < B.stormTargets; i++) {
      const next = nextArcTarget(origin, visited);
      if (!next) break;
      const end = chest(next, { x: 0, y: 0, z: 0 });
      ctx.fx?.line?.(origin, end, COLORS.storm, STORM_FLASH);
      ctx.combat?.hurtEnemy?.(next, shot.damage * B.stormDamage, false, source);
      visited.add(next.id);
      origin.x = end.x;
      origin.y = end.y;
      origin.z = end.z;
      arcs++;
    }
    emitCue(arcs ? "storm" : "stormEmpty");
  }

  // A target died to `source`: combat calls this in the kill order, and right after a shot
  // breaks an anchor or node. Graveburst: a primary Scatter pellet that kills within 8 m of
  // its muzzle casts five bone fragments from the hit point, once per trigger pull.
  function onKill(e, source) {
    if (!e || !source?.impact || !source.group || !enabled(source, MOD.grave) || source.group.grave) return;
    const o = source.origin;
    if (!o || Math.hypot(e.x - o.x, e.z - o.z) > B.graveRange) return;
    source.group.grave = true;
    const heading = Math.atan2(source.vx, source.vz);
    let made = 0;
    for (let i = 0; i < B.graveFragments; i++)
      if (secondary(source, source.impact, heading + (i - 2) * GRAVE_STEP, B.graveDamage, GRAVE_FLIGHT, "grave")) made++;
    if (made) emitCue("grave");
  }

  // Rift Scar: each qualifying rail leaves one trace from its first point to where it is now
  // (a rail stopped by cover stops its scar there too). A rail a guard blocked marks its scar,
  // whose ticks then always strike that guard's front (IMPROVEMENTS F1.4a).
  function onTravel(shot, from, to) {
    if (!shot || !enabled(shot, MOD.scar)) return;
    if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) < 0.001) return;
    let scar = shot.scar;
    if (!scar || scar.dead) {
      if (scars.length >= B.maxScars) removeScar(scars.shift());
      scar = {
        from: { x: from.x, y: from.y, z: from.z },
        to: { x: to.x, y: to.y, z: to.z },
        life: B.scarLife,
        damage: shot.damage * B.scarDamage,
        source: { weapon: shot.weapon, kind: "scar", generation: 1, group: shot.group, shotId: shot.shotId },
        line: ctx.fx?.line?.(from, to, COLORS.scar, 0) ?? null,
        dead: false,
      };
      scars.push(scar);
      shot.scar = scar;
      emitCue("scar");
    }
    if (shot.blockedBy != null) scar.source.blockedBy = shot.blockedBy;
    scar.to.x = to.x;
    scar.to.y = to.y;
    scar.to.z = to.z;
    scar.line?.update(scar.from, scar.to);
  }

  function removeScar(scar) {
    if (!scar || scar.dead) return;
    scar.dead = true;
    scar.line?.remove();
    scar.line = null;
  }

  // Event Horizon: a qualifying rocket's blast is held 0.45 s while ordinary monsters within
  // 5 m are dragged in. Returns true when it took the detonation over.
  function onImpact(shot, p) {
    if (!shot || !enabled(shot, MOD.horizon)) return false;
    // At the cap the oldest resolves now rather than losing its damage.
    if (pulls.length >= B.maxPulls) detonate(pulls.shift());
    pulls.push({ shot, x: p.x, y: p.y, z: p.z, life: B.pullLife, orb: takeOrb(p), done: false });
    emitCue("pull");
    return true;
  }

  function detonate(pull) {
    if (!pull || pull.done) return;
    pull.done = true;
    pull.life = 0;
    releaseOrb(pull);
    emitCue("detonate");
    ctx.combat?.explode?.(pull.x, pull.z, pull.shot.radius, pull.shot.damage, false, pull.y, pull.shot);
  }

  function takeOrb(p) {
    let orb = spareOrbs.pop();
    if (!orb) {
      orb = new THREE.Mesh(ORB_GEOMETRY, unlitMaterial(COLORS.orb));
      orb.rotation.x = Math.PI / 2;
      orb.scale.set(B.pullRadius, B.pullRadius, ORB_THICKNESS);
    }
    orb.position.set(p.x, p.y, p.z);
    ctx.gfx?.layers?.effects?.add(orb);
    return orb;
  }

  function releaseOrb(pull) {
    if (!pull.orb) return;
    pull.orb.removeFromParent();
    spareOrbs.push(pull.orb);
    pull.orb = null;
  }

  // Scar ticks: every target whose bullet volume crosses a scar takes a non-critical tick,
  // at most once per 0.3 s across all scars.
  function tickScars(dt) {
    for (const [id, left] of scarCooldown) {
      if (left <= dt) scarCooldown.delete(id);
      else scarCooldown.set(id, left - dt);
    }
    const targets = scars.length ? ctx.combat?.targets?.(scarTargets) ?? scarTargets : scarTargets;
    for (let i = 0; i < scars.length; i++) {
      const s = scars[i];
      if (s.dead) continue;
      s.life -= dt;
      for (let k = 0; k < targets.length; k++) {
        const e = targets[k];
        if (!alive(e) || scarCooldown.get(e.id) > 0) continue;
        if (hitBody(s.from, s.to, ctx.combat.bodyBounds(e, true)) === null) continue;
        scarCooldown.set(e.id, B.scarTick);
        ctx.combat.hurtEnemy(e, s.damage, false, s.source);
      }
      if (s.life <= 0) removeScar(s);
    }
    compact(scars, notDead);
  }

  function tickPulls(dt) {
    const terrain = ctx.world?.terrain;
    for (let i = 0; i < pulls.length; i++) {
      const pull = pulls[i];
      if (pull.done) continue;
      pull.life -= dt;
      // Refreshed per pull: an earlier pull's blast may have killed some of them.
      const targets = ctx.combat?.targets?.(pullTargets) ?? pullTargets;
      for (let k = 0; terrain && k < targets.length; k++) {
        const e = targets[k];
        if (!alive(e) || resists(e)) continue;
        const dx = pull.x - e.x,
          dz = pull.z - e.z,
          d = Math.hypot(dx, dz);
        if (d <= PULL_CORE || d >= B.pullRadius || !clearLine(chest(e, pointA), pull)) continue;
        const step = Math.min(d - PULL_CORE, B.pullSpeed * dt);
        terrain.move(e, (dx / d) * step, (dz / d) * step, e.def?.radius ?? e.radius ?? 0.5);
      }
      if (pull.life <= 0) detonate(pull);
    }
    compact(pulls, notDone);
  }

  // Weapon-mod timers (scars, pulls). combat.update runs this after the shots.
  function tickEffects(dt) {
    const at = firstTickAt(effectTickAt);
    if (at === null) return;
    effectTickAt = at;
    tickScars(dt);
    tickPulls(dt);
  }

  // ---- dash traits -----------------------------------------------------------------------

  const trait = () => build().dash;

  // Echo origins and wake segments must be standable, reachable and not through walls.
  function valid(a, b) {
    const terrain = ctx.world?.terrain;
    return (
      !!terrain &&
      terrain.walkable(a.x, a.z, PLAYER_RADIUS) &&
      terrain.canMove(a.x, a.z, b.x, b.z, PLAYER_RADIUS) &&
      clearLine(a, b)
    );
  }

  // Rift Echo ghost: a see-through copy of the hero at the dash origin, always in the normal
  // trail colour whatever trail is equipped, so it never reads as a monster or a shade
  // (IMPROVEMENTS F19.4). Its cloned materials keep the PS1 patch (it lives on the class).
  function makeGhost(origin) {
    const hero = ctx.player?.hero;
    if (!hero) return null;
    const ghost = hero.g.clone(true);
    ghost.visible = true;
    ghost.position.set(origin.x, origin.y - MUZZLE_HEIGHT, origin.z);
    ghost.traverse((node) => {
      if (!node.isMesh) return;
      const material = node.material.clone();
      material.transparent = true;
      material.opacity = ECHO_OPACITY;
      material.alphaHash = false;
      material.color?.set(TRAIL_COLORS.normal);
      node.material = material;
    });
    ctx.gfx?.layers?.effects?.add(ghost);
    return ghost;
  }

  function removeEcho() {
    if (!echo) return;
    const ghost = echo.ghost;
    echo = null;
    if (!ghost) return;
    ghost.removeFromParent();
    ghost.traverse((node) => {
      if (node.isMesh) node.material.dispose();
    });
  }

  function onDashBegin(origin) {
    removeEcho();
    if (trait() !== "echo" || !origin || !valid(origin, origin)) return;
    echo = { x: origin.x, y: origin.y, z: origin.z, life: B.echoWindow, ghost: makeGhost(origin) };
    emitCue("echoReady");
  }

  // The next volley after an echo dash repeats from the dash origin at half damage, with the
  // volley's own spread (the ledger may widen it).
  function onVolley(volley) {
    if (!echo || !volley) return;
    const origin = { x: echo.x, y: echo.y, z: echo.z };
    removeEcho();
    emitCue("echoCancel");
    if (valid(origin, origin) && fireEcho(origin, volley)) emitCue("echo");
  }

  function fireEcho(origin, volley) {
    const w = WEAPONS[volley.weapon],
      target = volley.target;
    if (!w || !target) return false;
    const angle = Math.atan2(target.x - origin.x, target.z - origin.z),
      pitch = pitchTo(origin.x, origin.y, origin.z, target.x, target.y, target.z);
    let made = 0;
    for (let i = 0; i < volley.count; i++) {
      const shot = ctx.combat?.projectile?.(origin.x, origin.z, angle + volleyOffset(i, volley.count, volley.spread ?? w.spread), w, false, {
        y: origin.y,
        pitch,
        damage: w.damage * volley.damage * B.echoDamage,
        weapon: volley.weapon,
        kind: "echo",
        shotId: volley.shotId,
        generation: 1,
        group: volley.group,
      });
      if (shot) made++;
    }
    return made > 0;
  }

  // Void Wake: every dash step leaves a slowing segment in the trail colour.
  function onDashMove(a, b) {
    if (trait() !== "wake" || !a || !b) return;
    if (Math.hypot(a.x - b.x, a.z - b.z) < WAKE_MIN_SEGMENT || !valid(a, b)) return;
    if (wake.length >= B.maxWake) removeWake(wake.shift());
    emitCue("wake");
    const color = ctx.profile?.cosmetics?.trailColor?.() ?? "#9dacc7";
    wake.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, life: B.wakeLife, line: ctx.fx?.line?.(a, b, color, 0) ?? null });
  }

  function removeWake(segment) {
    segment?.line?.remove();
    if (segment) segment.line = null;
  }

  // Speed multiplier for a monster standing in the wake (no stacking; bosses resist).
  function slow(e) {
    if (!e || resists(e)) return 1;
    for (let i = 0; i < wake.length; i++) {
      const s = wake[i],
        dx = s.bx - s.ax,
        dz = s.bz - s.az,
        t = Math.max(0, Math.min(1, ((e.x - s.ax) * dx + (e.z - s.az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(e.x - s.ax - t * dx, e.z - s.az - t * dz) < WAKE_REACH) return B.wakeSlow;
    }
    return 1;
  }

  // Dash-trait and cue timers. The director calls this at step start; combat.update calls it
  // too, and the second call in a step is ignored.
  function tick(dt) {
    const at = firstTickAt(dashTickAt);
    if (at === null) return;
    dashTickAt = at;
    if (echo) {
      echo.life -= dt;
      if (echo.life <= 0) {
        emitCue("echoExpired");
        removeEcho();
      }
    }
    for (const s of wake) {
      s.life -= dt;
      if (s.life <= 0) removeWake(s);
    }
    compact(wake, living);
    tickCue(dt);
  }

  // ---- lifecycle -------------------------------------------------------------------------

  // Scars and pulls vanish without detonating (their damage is lost, as in the original).
  function clearWeaponEffects() {
    for (const s of scars) removeScar(s);
    for (const p of pulls) {
      p.done = true;
      releaseOrb(p);
    }
    scars.length = pulls.length = 0;
    scarCooldown.clear();
  }

  // Everything: new run, stage entry, run end.
  function clear() {
    clearWeaponEffects();
    removeEcho();
    for (const s of wake) removeWake(s);
    wake.length = 0;
    clearCue();
    dashTickAt = effectTickAt = NaN;
  }

  // Live effect counts (developer metrics).
  function counts() {
    return { scars: scars.length, pulls: pulls.length, wake: wake.length, echo: echo ? 1 : 0 };
  }

  ctx.bus.on("runStart", clear);
  ctx.bus.on("stageEnter", clear);
  ctx.bus.on("runEnd", clear);
  // A cinematic wipes weapon effects and the cue but keeps a pending echo and the wake frozen.
  ctx.bus.on("sequence", (event) => {
    if (!event?.active) return;
    clearWeaponEffects();
    clearCue();
  });

  return {
    onVolley,
    onHit,
    onKill,
    onImpact,
    onTravel,
    onDashBegin,
    onDashMove,
    slow,
    tick,
    tickEffects,
    clear,
    counts,
    cue: emitCue,
  };
}

// In-place filter (no new array per step).
function compact(list, keep) {
  let kept = 0;
  for (let i = 0; i < list.length; i++) if (keep(list[i])) list[kept++] = list[i];
  list.length = kept;
}
