// World facade (ctx.world): builds and tears down one stage's terrain, scenery, landmark,
// statues and portal placement, and traces shots against the result. Build order matters:
// every seeded placement depends on the obstacles placed before it. KEEPERS additions (the
// shrine bell, the Crown Dais, hazard sites, walkable lava with its cost layer, statue omens)
// come after the Wave-1 layout, so terrain, scenery, landmark and statues are the same under
// both rulesets.
import * as THREE from "three";
import { createTerrain } from "./terrain.js";
import { buildScenery } from "./scenery.js";
import { createLandmark, createShrineBell } from "./landmarks.js";
import { createStatues, noStatues } from "./statues.js";
import { createPortal } from "./portal.js";
import { createDais } from "./dais.js";
import { placeHazards } from "./hazards-place.js";
import { traceWorld, traceCovers, hitBody } from "./ballistics.js";
import { stageSeed, PLACEMENT_OFFSETS, pick } from "../core/rng.js";
import { ZONE_KINDS } from "../data/hazards.js";

const DEFAULT_SEED = 7361;
const LAST_STAGE = 5;
const BELL_STAGE = 1;
const CHARGE_OBSTACLE = 0.6; // blasting charges block feet, not shots (F10)
const LAVA_COST_PAD = 1; // half a nav step around each pool, so no node edge clips its corner
const EMBER = Object.freeze({ every: 0.5, color: "#ffb05c", reach: 40 });

export function createWorld(ctx) {
  const root = new THREE.Group(),
    portal = createPortal(ctx);
  root.name = "world";
  root.add(portal.group, portal.base);
  ctx.gfx?.layers?.world?.add(root);

  let terrain = null,
    scenery = null,
    landmark = null,
    statues = noStatues(),
    shrineBell = null,
    dais = null,
    hazardSites = [],
    stage = 0,
    runSeed = DEFAULT_SEED,
    tutorial = false,
    original = false,
    emberClock = 0;
  // What traceWorld sees: the current heightfield and cover list.
  const view = { height: () => 0, covers: [] };

  function teardown() {
    // The terrain is discarded with the stage, so the landmark skips its navigation rebuild.
    landmark?.dispose({ rebuild: false });
    landmark = null;
    shrineBell?.dispose();
    shrineBell = null;
    dais?.dispose();
    dais = null;
    hazardSites = [];
    statues.dispose();
    statues = noStatues();
    scenery?.dispose();
    scenery = null;
    terrain = null;
    view.height = () => 0;
    view.covers = [];
  }

  // KEEPERS statue omens (F12): drawn from the run's "omens" stream among the omens still
  // available, preferring ones no other statue of the stage holds.
  function drawOmen(held) {
    const run = ctx.run,
      ids = ctx.omens?.available?.() ?? [];
    if (typeof run?.stream !== "function" || !ids.length) return null;
    const fresh = ids.filter((id) => !held.includes(id));
    return pick(run.stream("omens"), fresh.length ? fresh : ids);
  }

  const bellHooks = {
    ring: () => ctx.bosses?.startKeeper?.("bellwether") === true,
    sound: (name, volume, at) => ctx.audio?.fx?.(name, volume, { x: at.x, z: at.z, src: "bell" }),
  };

  // KEEPERS world objects after the Wave-1 layout, then one navigation rebuild for their
  // obstacles (bell, dais spikes, charges) and the walkable lava.
  function buildKeepers(placementSeed) {
    if (stage === BELL_STAGE) {
      shrineBell = createShrineBell(terrain, landmark, placementSeed + PLACEMENT_OFFSETS.shrineBell, bellHooks, statues.list);
      root.add(shrineBell.group);
    }
    if (stage === LAST_STAGE) {
      dais = createDais(terrain, scenery, portal, placementSeed + PLACEMENT_OFFSETS.dais);
      root.add(dais.group);
    }
    hazardSites = placeHazards({ stage, terrain, scenery, statues: statues.list, landmark, seed: placementSeed });
    for (const site of hazardSites) if (site.kind === "charge") site.obstacle = terrain.addObstacle({ x: site.x, z: site.z, r: CHARGE_OBSTACLE });
    // The crust is only 0.25 m tall: under KEEPERS the player can cross a pool, and walkers
    // route around it through the cost layer unless it is the only way (F10).
    for (const pool of scenery.lavaPools()) {
      terrain.removeObstacle(pool.crust);
      terrain.setCost(terrain.cellsInBox(pool.x, pool.z, pool.sx / 2 + LAVA_COST_PAD, pool.sz / 2 + LAVA_COST_PAD), ZONE_KINDS.lava.navCost);
    }
    terrain.rebuildNavigation();
  }

  // Disposes the previous stage, then terrain -> scenery -> landmark -> statues -> portal, then
  // (KEEPERS) the bell, the dais and the hazard sites. `original` marks an ORIGINAL-ruleset
  // build, which leaves every KEEPERS addition out.
  function build(nextStage, seed, { tutorial: training = false, original: originalRules = false } = {}) {
    teardown();
    stage = Math.min(LAST_STAGE, Math.max(1, Math.round(nextStage) || 1));
    tutorial = !!training;
    original = !!originalRules;
    runSeed = Number.isFinite(seed) ? seed : DEFAULT_SEED;
    const keepers = !tutorial && !original;
    terrain = createTerrain(stage, runSeed, { tutorial });
    scenery = buildScenery(terrain);
    root.add(scenery.group);
    landmark = createLandmark(terrain, scenery);
    if (landmark) root.add(landmark.group);
    if (!tutorial) {
      statues = createStatues(terrain, scenery, runSeed + stage * 107, { omen: keepers ? drawOmen : null });
      root.add(statues.group);
      // Stages 1–4 carry a Skull Trial; its statue is the first one placed.
      if (stage < LAST_STAGE && statues.list[0]) statues.markTrial(statues.list[0]);
      if (keepers) statues.drawOmens();
    }
    view.height = terrain.height;
    view.covers = scenery.covers;
    portal.place(terrain, { crownDais: keepers && stage === LAST_STAGE });
    portal.setActive(false);
    if (keepers) buildKeepers(stageSeed(runSeed, stage));
    // Warm the flow graphs now so the first chase step does not hitch.
    terrain.prepareNavigation();
    ctx.bus?.emit("stageBuilt", { stage });
  }

  // Simulation step (encounters drives it while the stage plays): the lava's rising embers
  // near the hero (both rulesets), the bell's swing and glow and the dais pulse.
  function update(dt) {
    if (!terrain || !(dt > 0)) return;
    const steady = ctx.prefs?.flashes === false;
    shrineBell?.update(dt, steady);
    dais?.update(dt, steady);
    emberClock += dt;
    if (emberClock < EMBER.every) return;
    emberClock -= EMBER.every;
    const p = ctx.run?.player;
    if (!p) return;
    for (const pool of scenery.lavaPools())
      if (Math.hypot(pool.x - p.x, pool.z - p.z) < EMBER.reach)
        ctx.fx?.burst?.(pool.x + (Math.random() - 0.5) * pool.sx, 0.3, pool.z + (Math.random() - 0.5) * pool.sz, EMBER.color, 1, 1.4);
  }

  // The Crown Dais wakes with the stage-5 goal (P6 emits bus "dais").
  ctx.bus?.on("dais", (event) => {
    if (event?.event === "awake") dais?.setAwake(true);
  });

  return {
    build,
    update,
    get terrain() {
      return terrain;
    },
    height: (x, z) => view.height(x, z),
    get covers() {
      return view.covers;
    },
    // Takes a cover out of the shot world (a fallen crystal's gem).
    removeCover(cover) {
      const at = view.covers.indexOf(cover);
      if (at >= 0) view.covers.splice(at, 1);
    },
    get surface() {
      return scenery ? scenery.surface : null;
    },
    // The stage's scenery records: anchors(kind), towers(), spires(), lavaPools(),
    // setInstanceVisible(ref, on) (IMPROVEMENTS §3.10).
    get scenery() {
      return scenery;
    },
    get landmark() {
      return landmark;
    },
    get statues() {
      return statues;
    },
    portal,
    get stage() {
      return stage;
    },
    get tutorial() {
      return tutorial;
    },
    get original() {
      return original;
    },
    // The placement seed of a stage of this run (F14.1): statues use it as is, other world
    // placement adds its PLACEMENT_OFFSETS entry.
    stageSeed: (s = stage) => stageSeed(runSeed, s),
    // KEEPERS world objects: the Crown Dais { x, z, awake, setAwake(bool) } on stage 5, the
    // shrine bell { x, z, state, wake(), ring(), nearby(x, z) } on stage 1 (F2, F6), and the
    // hazard prop sites (F10) that ctx.hazards brings to life on stage entry.
    get dais() {
      return dais;
    },
    get shrineBell() {
      return shrineBell;
    },
    get hazardSites() {
      return hazardSites;
    },
    trace: (a, b, r = 0.04) => (terrain ? traceWorld(a, b, view, r) : null),
    // Covers only, terrain ignored (Iron Maw's charge lane stops at the first solid cover).
    traceCovers: (a, b, r = 0.04) => traceCovers(a, b, view.covers, r),
    hitBody,
    dispose() {
      teardown();
      portal.dispose();
      root.removeFromParent();
    },
  };
}
