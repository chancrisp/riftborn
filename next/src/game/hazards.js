// Living Worlds (ctx.hazards, IMPROVEMENTS F10): each KEEPERS stage's hazard props (marsh pods,
// blasting charges, live beacons, falling crystals) and its lava pools. Props are encounter
// objects of kind "prop" in run.objects, kept out of combat.targets(): damage that physically
// reaches them arrives through hitVolumes() (shot sweeps, explosions) or a cover hit
// (propForCover), as raw damage. On "stageEnter" the world's placed sites come alive here; fuses,
// blasts, chains, flares, regrowth and relights then run in simulation time (encounters.update
// drives update(dt)), monsters that step into lava are seared, and each kind toasts on its
// first sighting. Nothing exists under ORIGINAL or in the tutorial.
import { PROP_KINDS, ZONE_KINDS, HAZARD, chainReach, inPool, playerTriggered } from "../data/hazards.js";
import { TILE } from "../render/materials.js";
import { createPropBatch } from "../render/models-props.js";
import { clamp, TAU } from "../core/util.js";

// Blast looks; marsh gas pops with its own sound (PROP_KINDS), the others explode.
const BLAST = Object.freeze({
  marsh: Object.freeze({ color: "#b8d98e", ring: "#9fbf7a", volume: 1, shake: 0.15 }),
  charge: Object.freeze({ color: "#ffb05c", ring: "#ffe7ad", sound: "explosion", volume: 1 }),
  crystal: Object.freeze({ color: "#d9b6ff", ring: "#ba80ef", sound: "explosion", volume: 0.7, shake: 0.3 }),
});
const SCORCH = Object.freeze({ color: "#1b1612", life: 10 });
const FLARE_RING = "#83e7ff";
const FUSE_SPARK = "#ffd774";
const SEAR = Object.freeze({ color: "#ff7a2e", sound: "sear" });
const CRYSTAL = Object.freeze({ color: "#ba80ef", sx: 0.7, sy: 1.8, sz: 0.7, lift: 2 });
const AMBIENT_REACH = 40; // bubbles and sparks only near the hero
const THREAT_REACH = 8; // a fuse marker "targets the player" within its radius + this (F16)
const GRID_OFFSET = 128;
const GRID_ROW = 4096;

const isWarden = (e) => e.boss === "warden" || e.kind === "warden";

export function createHazards(ctx) {
  const props = [], // this stage's prop objects, live or spent
    pools = [], // this stage's lava pools: { x, z, sx, sz, zone, inside: Set<Enemy> }
    volumes = [], // live hit volumes (rebuilt when a prop changes state)
    found = [], // hitVolumes(bounds) result, reused
    grid = new Map(), // 8 m broad phase: cell -> volumes
    markers = new Map(), // prop -> its fuse telegraph
    falling = new Set(), // crystals dropping now
    look = { scale: 1, dim: false, flash: 0 },
    markerState = { progress: 0, opacity: 1 },
    losFrom = { x: 0, y: 0, z: 0 },
    losTo = { x: 0, y: 0, z: 0 };
  let bound = null,
    batch = null,
    dirty = true,
    stamp = 0,
    bubble = 0,
    spark = 0;

  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const live = (o) => !o.dead && o.prop.state === "live";
  const hittable = (e) => e && !e.dead && e.hp > 0 && (ctx.enemies?.isHittable?.(e) ?? !e.untargetable);
  const sound = (name, volume, at, src) => ctx.audio?.fx?.(name, volume, { x: at.x, z: at.z, src });

  function emit(event, o, kills = 0) {
    ctx.bus.emit("prop", { kind: o.prop.kind, id: o.id, event, x: o.x, z: o.z, kills, player: o.prop.player });
  }

  // ---- stage setup ----------------------------------------------------------------------

  function nextId(run) {
    if (!Number.isFinite(run.nextId)) run.nextId = 1;
    return run.nextId++;
  }

  function makeProp(run, site, index) {
    const spec = PROP_KINDS[site.kind],
      register = HAZARD.register[site.kind],
      o = {
        id: nextId(run),
        kind: "prop",
        x: site.x,
        z: site.z,
        y: 0,
        hp: spec.hp,
        max: spec.hp,
        radius: spec.radius,
        def: { radius: spec.radius },
        fixed: true,
        owner: "world",
        model: null,
        dead: false,
        flash: 0,
        prop: { kind: site.kind, state: "live", t: 0, fuse: spec.fuse, player: false, hammer: false, index, site, dropped: false },
      };
    o.volume = { o, x: o.x, z: o.z, r: spec.radius, bottom: site.y, top: site.y + Math.max(HAZARD.minHeight, register ?? 0), stamp: 0 };
    // Tower and spire bodies route shots that hit them low (world.trace cover.prop).
    const cover = site.tower?.cover ?? site.spire?.cover;
    if (cover) {
      cover.prop = o.id;
      cover.propTop = site.y + register;
    }
    // A live beacon's brighter gem replaces the tower's own.
    if (site.tower) ctx.world?.scenery?.setInstanceVisible?.(site.tower.gem, false);
    run.objects.push(o);
    return o;
  }

  // The molten box as a world zone (F1.4c, owner "world", never evicted); its pool mesh and
  // embers are the scenery's, so the zone draws nothing itself.
  function makeLava(pool) {
    const lava = ZONE_KINDS.lava,
      zone =
        ctx.combat?.zone?.(pool.x, pool.z, Math.hypot(pool.sx, pool.sz) / 2, {
          shape: "box",
          sx: pool.sx / 2,
          sz: pool.sz / 2,
          yaw: 0,
          life: Infinity,
          tick: lava.tick,
          playerDamage: lava.player,
          monsterDamage: lava.monsters,
          immune: [...lava.immune],
          source: { id: lava.source, label: lava.source },
          owner: "world",
          visual: null,
        }) ?? null;
    return { x: pool.x, z: pool.z, sx: pool.sx, sz: pool.sz, zone, inside: new Set() };
  }

  // Stage entry (and run start): the world's hazard sites and lava pools come alive.
  function setup() {
    clear();
    const run = ctx.run,
      world = ctx.world;
    if (!run || run.original || run.tutorial || run.kind === "tutorial" || !world?.terrain) return;
    bound = run;
    run.objects ??= [];
    run.flags ??= {};
    run.flags.hazardSeen ??= {};
    const sites = world.hazardSites ?? [];
    for (let i = 0; i < sites.length; i++) props.push(makeProp(run, sites[i], i));
    if (sites.length) {
      batch = createPropBatch(sites[0].kind, sites);
      if (batch) ctx.gfx?.layers?.world?.add(batch.group);
    }
    for (const pool of world.scenery?.lavaPools?.() ?? []) pools.push(makeLava(pool));
    dirty = true;
  }

  // ---- hit volumes ----------------------------------------------------------------------

  const cellOf = (v) => Math.floor((v + GRID_OFFSET) / HAZARD.grid);

  function rebuildVolumes() {
    volumes.length = 0;
    grid.clear();
    for (const o of props) {
      if (!live(o)) continue;
      const v = o.volume;
      volumes.push(v);
      for (let ix = cellOf(v.x - v.r); ix <= cellOf(v.x + v.r); ix++)
        for (let iz = cellOf(v.z - v.r); iz <= cellOf(v.z + v.r); iz++) {
          const key = ix * GRID_ROW + iz;
          let cell = grid.get(key);
          if (!cell) grid.set(key, (cell = []));
          cell.push(v);
        }
    }
    dirty = false;
  }

  // hitVolumes() -> every live prop's { o, x, z, r, bottom, top }; with a bounding box
  // (minX, minZ, maxX, maxZ), only those in the 8 m cells it touches. Reused arrays: read them
  // before the next call.
  function hitVolumes(minX, minZ, maxX, maxZ) {
    if (dirty) rebuildVolumes();
    if (!Number.isFinite(minX) || !volumes.length) return volumes;
    found.length = 0;
    stamp++;
    for (let ix = cellOf(minX); ix <= cellOf(maxX); ix++)
      for (let iz = cellOf(minZ); iz <= cellOf(maxZ); iz++) {
        const cell = grid.get(ix * GRID_ROW + iz);
        if (!cell) continue;
        for (const v of cell)
          if (v.stamp !== stamp) {
            v.stamp = stamp;
            found.push(v);
          }
      }
    return found;
  }

  // The live prop a cover belongs to (a beacon tower, a crystal spire), or null. With the hit
  // point's height `y`, only hits below the prop's register height count.
  function propForCover(cover, y) {
    if (cover?.prop == null) return null;
    const o = props.find((p) => p.id === cover.prop);
    if (!o || !live(o) || (Number.isFinite(y) && y > cover.propTop)) return null;
    return o;
  }

  // ---- damage, fuses and blasts -----------------------------------------------------------

  // Raw damage: no multipliers, crits, numbers or score. A white crack flash; at 0 HP the fuse
  // starts, credited to the player when their damage broke it.
  function hurtProp(o, damage, source = {}) {
    if (!o?.prop || !live(o) || !(damage > 0) || ctx.cinematic || ctx.run?.victory) return 0;
    const dealt = Math.min(o.hp, damage);
    o.hp -= dealt;
    o.flash = HAZARD.flash;
    paint(o);
    const player = playerTriggered(source);
    ctx.bus.emit("prop", { kind: o.prop.kind, id: o.id, event: "hit", x: o.x, z: o.z, kills: 0, player });
    if (o.hp <= 0) detonate(o, { player });
    return dealt;
  }

  // Sets a live prop off: { player } credits the blast's kills to the player's chain, { fuse }
  // overrides the kind's fuse (0 = at once), { hammer } (or fuse 0: the Tithe Hammer dash)
  // tags its player damage so it never scores PHASED. Crystals wait while two already fall.
  function detonate(o, { player = false, fuse, hammer = false } = {}) {
    if (!o?.prop || !live(o) || !bound) return false;
    const p = o.prop;
    p.player = !!player;
    p.hammer = hammer || fuse === 0;
    p.fuse = Number.isFinite(fuse) ? Math.max(0, fuse) : PROP_KINDS[p.kind].fuse;
    p.t = p.fuse;
    o.hp = 0;
    dirty = true;
    if (p.kind === "crystal" && falling.size >= HAZARD.fallsAtOnce) p.state = "queued";
    else ignite(o);
    return true;
  }

  function ignite(o) {
    const run = ctx.run,
      p = o.prop,
      spec = PROP_KINDS[p.kind],
      radius = spec.blast?.r ?? spec.flare?.r,
      hero = run?.player;
    p.state = "fuse";
    if (p.kind === "crystal") falling.add(o);
    const threat = !!hero && Math.hypot(hero.x - o.x, hero.z - o.z) < radius + THREAT_REACH;
    markers.set(o, ctx.tele?.area?.(o.x, o.z, radius, HAZARD.marker[p.kind], { owner: o.id, eta: p.fuse, started: run?.elapsed ?? 0, targetsPlayer: threat }) ?? null);
    // The charge's hissing fuse and the struck crystal's falling whine start with the fuse.
    if (p.kind === "charge" || p.kind === "crystal") sound(spec.sound, 1, o, p.kind);
    if (p.kind === "beacon") {
      const { color, height, width, opacity } = HAZARD.pillar;
      ctx.fx?.pillar?.(o.x, o.z, color, height, width, Math.max(p.fuse, 0.05), { opacity });
    }
    emit("fuse", o);
    paint(o);
    if (p.t <= 0) blast(o);
  }

  // True when a blast at (x, y, z) reaches the nearest point of the body (null = the hero)
  // with a clear line; `skin` starts the line that far out (a spire's own cover).
  function reaches(target, x, y, z, radius, skin = 0) {
    const b = ctx.combat?.bodyBounds?.(target);
    if (!b) return false;
    const by = clamp(y, b.bottom, b.top);
    if (Math.hypot(b.x - x, by - y, b.z - z) >= radius + b.radius) return false;
    const d = Math.hypot(b.x - x, b.z - z);
    if (skin >= d) return true;
    const k = d > 0 ? skin / d : 0;
    losFrom.x = x + (b.x - x) * k;
    losFrom.y = y + 0.08;
    losFrom.z = z + (b.z - z) * k;
    losTo.x = b.x;
    losTo.y = by;
    losTo.z = b.z;
    return !ctx.world?.trace?.(losFrom, losTo, 0);
  }

  // Environment damage to one monster; true when it killed it.
  function strike(e, damage, source) {
    const before = e.hp;
    ctx.combat?.hurtEnemy?.(e, damage, false, source);
    return before > 0 && !(e.hp > 0);
  }

  // Marsh gas, a blasting charge or a fallen crystal: fixed damage to the hero and monsters in
  // reach (friendly fire), and to other props (chains). Returns the monsters killed.
  function explodeProp(o) {
    const run = ctx.run,
      p = o.prop,
      spec = PROP_KINDS[p.kind],
      { r, monsters, player, source: cause } = spec.blast,
      style = BLAST[p.kind],
      y = ground(o.x, o.z) + HAZARD.blastHeight,
      skin = p.kind === "crystal" ? spec.radius : 0;
    ctx.fx?.burst?.(o.x, HAZARD.blastHeight, o.z, style.color, 34, 6);
    ctx.fx?.ring?.(o.x, o.z, style.ring, r, 0.45);
    if (p.kind === "marsh") ctx.fx?.decal?.(o.x, o.z, HAZARD.cloud.color, r, HAZARD.cloud.life);
    else ctx.fx?.decal?.(o.x, o.z, SCORCH.color, r * 0.6, SCORCH.life);
    ctx.cam?.shake?.(spec.shake ?? style.shake ?? 0.23);
    sound(style.sound ?? spec.sound, style.volume, o, p.kind);
    if (run.player && reaches(null, o.x, y, o.z, r, skin))
      ctx.player?.hurt?.(player, p.hammer ? { id: cause, label: cause, x: o.x, z: o.z, hammer: true } : { id: cause, label: cause, x: o.x, z: o.z });
    const source = { weapon: -1, kind: "prop", environment: true, friendlyFire: true, prop: p.kind, player: p.player, source: { id: cause, label: cause } };
    let kills = 0;
    const list = run.enemies;
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (hittable(e) && reaches(e, o.x, y, o.z, r, skin) && strike(e, monsters, source)) kills++;
    }
    const reach = spec.chain ?? r;
    for (const other of props) if (other !== o && live(other) && chainReach(o, other, reach)) hurtProp(other, monsters, source);
    return kills;
  }

  // The AURORA FLARE of a live beacon: a screen tint, the flare ring, and every monster within
  // 14 m of the tower base stunned (keepers staggered, the Warden immune) and burned.
  function flareProp(o) {
    const run = ctx.run,
      { r, stun, damage } = PROP_KINDS.beacon.flare,
      tint = HAZARD.flareTint,
      source = { weapon: -1, kind: "prop", environment: true, prop: "beacon", player: true, source: { id: "Beacon flare", label: "Beacon flare" } };
    ctx.fx?.flare?.("beacon", tint.color, tint.strength, tint.duration);
    ctx.fx?.ring?.(o.x, o.z, FLARE_RING, r, 0.6);
    ctx.fx?.burst?.(o.x, (o.prop.site.tower?.h ?? 8) + 1.6, o.z, HAZARD.pillar.color, 30, 5);
    sound(PROP_KINDS.beacon.sound, 1, o, "beacon");
    let kills = 0;
    const list = run.enemies;
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (!hittable(e) || isWarden(e) || Math.hypot(e.x - o.x, e.z - o.z) > r) continue;
      if (e.keeper) ctx.bosses?.stagger?.(e, HAZARD.castellanStagger);
      else ctx.enemies?.stun?.(e, stun);
      if (strike(e, damage, source)) kills++;
    }
    return kills;
  }

  function blast(o) {
    const p = o.prop,
      spec = PROP_KINDS[p.kind];
    ctx.tele?.remove?.(markers.get(o));
    markers.delete(o);
    const kills = spec.flare ? flareProp(o) : explodeProp(o);
    p.state = "spent";
    p.t = spec.regrow ?? spec.relight ?? Infinity;
    if (p.kind === "crystal") {
      falling.delete(o);
      startQueued();
    }
    // A spent charge leaves no crate to walk around.
    if (p.site.obstacle) {
      ctx.world?.terrain?.removeObstacle?.(p.site.obstacle);
      p.site.obstacle = null;
    }
    paint(o);
    emit("blast", o, kills);
    emit("spent", o);
  }

  function startQueued() {
    for (const o of props) {
      if (falling.size >= HAZARD.fallsAtOnce) return;
      if (!o.dead && o.prop.state === "queued") ignite(o);
    }
  }

  // The last 0.4 s of a crystal's fuse: its batched gem vanishes and a dynamic one drops.
  function drop(o) {
    const p = o.prop,
      spire = p.site.spire;
    p.dropped = true;
    ctx.world?.scenery?.setInstanceVisible?.(spire.gem, false);
    ctx.world?.removeCover?.(spire.gemCover);
    const shape = { shape: "gem", sx: CRYSTAL.sx, sy: CRYSTAL.sy, sz: CRYSTAL.sz, tile: TILE.crystal };
    ctx.fx?.fall?.(o.x, o.z, shape, CRYSTAL.color, spire.h + CRYSTAL.lift - CRYSTAL.sy, Math.max(p.t, 0.05));
  }

  // Regrown pods and relit runes return at full HP.
  function renew(o) {
    o.prop.state = "live";
    o.prop.player = false;
    o.hp = o.max;
    dirty = true;
    paint(o);
    emit("relit", o);
  }

  // ---- per step -----------------------------------------------------------------------------

  function paint(o) {
    if (!batch) return;
    const p = o.prop;
    look.flash = o.flash > 0 ? 1 : 0;
    look.dim = p.state === "spent";
    look.scale = 1;
    if (p.kind === "marsh")
      look.scale =
        p.state === "fuse" ? 1 + HAZARD.swell * (1 - p.t / Math.max(p.fuse, 1e-3)) : p.state === "spent" ? 0 : p.state === "regrow" ? 1 - p.t / HAZARD.regrowTime : 1;
    else if (p.kind === "charge" && p.state === "spent") look.scale = 0;
    batch.set(p.index, look);
  }

  function tickProp(o, dt) {
    const p = o.prop;
    if (o.flash > 0) {
      o.flash = Math.max(0, o.flash - dt);
      if (!o.flash) paint(o);
    }
    if (p.state === "fuse") {
      p.t -= dt;
      const marker = markers.get(o);
      if (marker) {
        markerState.progress = clamp(1 - p.t / Math.max(p.fuse, 1e-3), 0, 1);
        markerState.opacity = 0.45 + 0.5 * markerState.progress;
        ctx.tele?.set?.(marker, markerState);
      }
      if (p.kind === "marsh") paint(o);
      if (p.kind === "crystal" && !p.dropped && p.t <= HAZARD.fallTime) drop(o);
      if (p.t <= 0) blast(o);
    } else if (p.state === "spent" && Number.isFinite(p.t)) {
      p.t -= dt;
      if (p.t > 0) return;
      if (p.kind === "marsh") {
        p.state = "regrow";
        p.t = HAZARD.regrowTime;
      } else renew(o);
    } else if (p.state === "regrow") {
      p.t -= dt;
      if (p.t <= 0) renew(o);
      else paint(o);
    }
  }

  // Cosmetic life near the hero: marsh bubbles and a lit charge's fuse sparks.
  function ambience(run, dt) {
    const hero = run.player;
    bubble += dt;
    spark += dt;
    const bubbles = bubble >= HAZARD.bubbleEvery,
      sparks = spark >= HAZARD.sparkEvery;
    if (bubbles) bubble -= HAZARD.bubbleEvery;
    if (sparks) spark -= HAZARD.sparkEvery;
    if (!bubbles && !sparks) return;
    for (const o of props) {
      if (o.dead || Math.hypot(o.x - hero.x, o.z - hero.z) > AMBIENT_REACH) continue;
      const p = o.prop;
      if (bubbles && p.kind === "marsh" && p.state === "live")
        ctx.fx?.burst?.(o.x + (Math.random() - 0.5) * 0.6, 0.45, o.z + (Math.random() - 0.5) * 0.6, HAZARD.cloud.color, 1, 0.6);
      if (sparks && p.kind === "charge" && p.state === "fuse")
        ctx.fx?.burst?.(o.x + Math.sin(p.site.yaw + Math.PI / 2) * 0.3, 1.05, o.z + Math.cos(p.site.yaw + Math.PI / 2) * 0.3, FUSE_SPARK, 2, 2);
    }
  }

  // Seared: a monster entering lava flinches 0.5 s (a stun), once per entry. Keepers, bosses
  // and the immune kinds walk through.
  function sear(run) {
    const lava = ZONE_KINDS.lava,
      list = run.enemies;
    for (const pool of pools) {
      for (const e of pool.inside) if (e.dead || !(e.hp > 0) || !inPool(pool, e.x, e.z, e.def?.radius ?? 0.5)) pool.inside.delete(e);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!hittable(e) || e.keeper || e.boss || lava.immune.includes(e.kind) || pool.inside.has(e)) continue;
        if (!inPool(pool, e.x, e.z, e.def?.radius ?? 0.5)) continue;
        pool.inside.add(e);
        ctx.enemies?.stun?.(e, lava.sear);
        ctx.fx?.burst?.(e.x, 0.6, e.z, SEAR.color, 6, 2.2);
        sound(SEAR.sound, 0.6, e, "lava");
      }
    }
  }

  // First sighting of each kind in a run (within 12 m): its toast, the flag and the codex.
  function sightings(run) {
    const hero = run.player,
      seen = run.flags.hazardSeen;
    for (const o of props) {
      const kind = o.prop.kind;
      if (!seen[kind] && Math.hypot(o.x - hero.x, o.z - hero.z) < HAZARD.seen) sight(run, kind, PROP_KINDS[kind].toast);
    }
    if (seen.lava) return;
    const near = pools.some((pool) => {
      const dx = Math.max(0, Math.abs(hero.x - pool.x) - pool.sx / 2),
        dz = Math.max(0, Math.abs(hero.z - pool.z) - pool.sz / 2);
      return Math.hypot(dx, dz) < HAZARD.seen;
    });
    if (near) sight(run, "lava", ZONE_KINDS.lava.toast);
  }

  function sight(run, kind, toast) {
    run.flags.hazardSeen[kind] = true;
    ctx.hud?.toast?.(toast, { priority: 1 });
    ctx.profile?.recordHazard?.(kind);
  }

  // One simulation step (encounters.update drives it while the stage plays).
  function update(dt) {
    const run = ctx.run;
    if (!run || run !== bound || !(dt > 0) || !run.player) return;
    for (const o of props) if (!o.dead) tickProp(o, dt);
    ambience(run, dt);
    sear(run);
    if (!run.demo) sightings(run);
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  // Stage change, run start: every prop, fuse and pool goes; pending blasts are dropped.
  function clear() {
    for (const o of props) {
      o.dead = true;
      o.hp = 0;
      const { tower, spire } = o.prop.site,
        cover = tower?.cover ?? spire?.cover;
      if (cover?.prop === o.id) delete cover.prop;
      if (tower) ctx.world?.scenery?.setInstanceVisible?.(tower.gem, true);
    }
    for (const marker of markers.values()) ctx.tele?.remove?.(marker);
    markers.clear();
    falling.clear();
    batch?.dispose();
    batch = null;
    props.length = 0;
    pools.length = 0;
    volumes.length = 0;
    grid.clear();
    dirty = true;
    bound = null;
  }

  // ---- practice ------------------------------------------------------------------------------

  // ?practice=hazards&stage=N (mortal): the stage's props, the hero 9 m from the first one
  // (the first lava pool on the Caldera) and ten runners around it; on the Caldera the runners
  // start across the pool, so they must route around it.
  function scenario(_ctx, _params, h) {
    const run = ctx.run,
      terrain = ctx.world?.terrain,
      target = props[0] ?? pools[0] ?? null;
    if (!run?.player || !terrain || !target) return;
    const d = Math.hypot(target.x, target.z) || 1,
      ux = target.x / d,
      uz = target.z / d,
      spot = terrain.safeNear(target.x - ux * 9, target.z - uz * 9, 0.45);
    ctx.player?.place?.(spot.x, spot.z);
    const lava = !props.length,
      cx = lava ? target.x + ux * 7 : target.x,
      cz = lava ? target.z + uz * 7 : target.z,
      ring = lava ? 2 : 2.5 + (target.radius ?? 0);
    for (let i = 0; i < 10; i++) {
      const a = (i * TAU) / 10;
      h.spawnAt("runner", cx + Math.sin(a) * ring, cz + Math.cos(a) * ring);
    }
  }

  ctx.bus.on("stageEnter", setup);
  ctx.bus.on("practice", ({ register } = {}) => register?.("hazards", scenario, { stage: 1, mortal: true }));

  return {
    hitVolumes,
    propForCover,
    hurtProp,
    detonate,
    // props() -> this stage's prop objects (live or spent; o.prop.state), e.g. for the radar.
    props: () => props,
    // The stage's lava pools { x, z, sx, sz, zone } (Caldera, KEEPERS).
    lavaPools: () => pools,
    update,
    clear,
  };
}
