// Discoveries: one optional authored structure per world, placed beside an outer waypoint, and
// the KEEPERS shrine bell hung beside the Meadows shrine (IMPROVEMENTS F2). Gameplay rewards
// (heal, rest, journal) and the bell's interaction belong to the encounters system; this module
// only places, draws and reports them.
import * as THREE from "three";
import { retroMaterial } from "../render/materials.js";
import { createShrineBellModel, PROP_COLORS } from "../render/models-props.js";
import { randomSource } from "../core/rng.js";
import { NAV_CLEARANCE } from "./terrain.js";
import { propTile, sceneryShapes } from "./scenery.js";
import { coverBounds } from "./ballistics.js";
import { LANDMARKS, LANDMARK_IDS } from "../data/landmarks.js";

// The landmark table lives in data/ (the Journal reads it too); re-exported for callers here.
export { LANDMARKS, LANDMARK_IDS };

// [stone, accent, detail] per stage.
const PALETTES = [
  ["#7c8775", "#b6b99b", "#667555"],
  ["#4a5c68", "#c3a571", "#89654c"],
  ["#53414c", "#b68570", "#b86c43"],
  ["#536b83", "#b3c2c6", "#65748a"],
  ["#504166", "#a99aaa", "#796788"],
];
const INTERACTION_RADIUS = 3.6;

// Parts are axis-aligned boxes [dx, y, dz, sx, sy, sz, colour]; the front faces +Z. The same
// numbers feed the meshes, the walk footprints and the shot covers. Upper parts stay within
// the foundation so there are no invisible overhead walk blockers.
const BASE = [0, 0.18, 0, 4, 0.36, 2.4, 0];
const ASSEMBLIES = [
  [
    [-1.5, 1.8, 0, 0.7, 3.25, 0.8, 0],
    [1.5, 1.8, 0, 0.7, 3.25, 0.8, 0],
    [-1.5, 3.5, 0, 1.05, 0.3, 1.1, 1],
    [1.5, 3.5, 0, 1.05, 0.3, 1.1, 1],
    [0, 3.78, 0, 3.8, 0.36, 1.1, 0],
    [0, 0.8, 0.2, 1.8, 0.9, 1.3, 0],
    [0, 1.35, 0.2, 2.1, 0.2, 1.5, 1],
    [0, 2.6, 0.48, 0.42, 0.68, 0.12, 2],
  ],
  [
    [-1.6, 2, 0, 0.6, 3.65, 0.9, 0],
    [1.6, 2, 0, 0.6, 3.65, 0.9, 0],
    [0, 3.92, 0, 3.9, 0.4, 0.95, 1],
    [0, 2.87, 0, 0.16, 1.7, 0.16, 1],
    [-0.75, 1.38, 0, 1.05, 2, 0.95, 0],
    [-0.75, 2.5, 0, 1.45, 0.25, 1.25, 1],
    [0.7, 0.8, 0.15, 1.4, 0.88, 1.3, 0],
    [0.7, 1.38, 0.15, 1.7, 0.24, 1.55, 1],
    [1.6, 2.8, 0.53, 0.18, 0.8, 0.14, 2],
    [-1.6, 2.8, 0.53, 0.18, 0.8, 0.14, 2],
  ],
  [
    [-1.5, 1.58, 0, 0.7, 2.8, 0.9, 0],
    [1.5, 1.58, 0, 0.7, 2.8, 0.9, 0],
    [0, 3.1, 0, 3.9, 0.4, 1.4, 0],
    [0, 3.46, 0, 2.9, 0.32, 1.2, 1],
    [0, 3.77, 0, 1.9, 0.3, 1, 0],
    [0, 1.05, 0, 2, 1.4, 1.45, 0],
    [0, 1.91, 0, 2.35, 0.3, 1.7, 1],
    [0, 2.23, 0, 0.7, 0.34, 0.7, 2],
    [0, 1.05, 0.75, 0.5, 0.6, 0.1, 2],
  ],
  [
    [-1.65, 1.98, 0, 0.5, 3.6, 1.5, 0],
    [1.65, 1.98, 0, 0.5, 3.6, 1.5, 0],
    [0, 3.85, 0, 3.9, 0.3, 1.8, 1],
    [0, 1.9, -0.48, 2.85, 3, 0.35, 0],
    [-0.78, 1.97, 0.05, 1.15, 2.8, 0.6, 1],
    [0.78, 1.97, 0.05, 1.15, 2.8, 0.6, 1],
    [-0.78, 1.1, 0.39, 0.72, 0.1, 0.08, 2],
    [-0.78, 1.7, 0.39, 0.72, 0.1, 0.08, 2],
    [-0.78, 2.3, 0.39, 0.72, 0.1, 0.08, 2],
    [0.78, 1.4, 0.39, 0.72, 0.1, 0.08, 2],
    [0.78, 2, 0.39, 0.72, 0.1, 0.08, 2],
    [0.78, 2.6, 0.39, 0.72, 0.1, 0.08, 2],
  ],
  [
    [-1.2, 1.9, 0, 1.1, 3.45, 1.3, 0],
    [1.2, 1.65, 0, 1.1, 2.95, 1.3, 0],
    [-1.45, 3.82, 0, 0.6, 0.4, 1.3, 1],
    [-0.97, 4.1, 0, 0.34, 0.95, 1.1, 0],
    [1.45, 3.32, 0, 0.6, 0.4, 1.3, 1],
    [0.97, 3.55, 0, 0.34, 0.85, 1.1, 0],
    [0, 0.7, 0.2, 1.15, 0.68, 1.35, 1],
    [0, 1.13, 0.2, 1.3, 0.18, 1.5, 0],
    [-1.2, 2.25, 0.68, 0.34, 0.7, 0.08, 2],
    [1.2, 1.92, 0.68, 0.34, 0.7, 0.08, 2],
  ],
];
const FOOTPRINT_CORNERS = [
  [-2, -1.2],
  [-2, 1.2],
  [2, -1.2],
  [2, 1.2],
];

// Candidate sites: connected outer nodes away from paths and the portal, best first
// (near an outer waypoint, about 36 m from the entry; ties by z then x).
function candidateSites(terrain) {
  const [portalX, portalZ] = terrain.points[0],
    waypoints = terrain.points.slice(1);
  const sites = [];
  for (const i of terrain.reachable) {
    const p = terrain.position(i),
      distance = Math.hypot(p.x, p.z);
    if (
      distance > 20 &&
      distance < 53 &&
      Math.hypot(p.x - portalX, p.z - portalZ) > 15 &&
      terrain.routeDistance(p.x, p.z) > 7.4 &&
      terrain.clear(p.x, p.z, 4.5)
    ) {
      p.score = Math.min(...waypoints.map(([x, z]) => Math.hypot(p.x - x, p.z - z))) + Math.abs(distance - 36) * 0.25;
      sites.push(p);
    }
  }
  return sites.sort((a, b) => a.score - b.score || a.z - b.z || a.x - b.x);
}

// Reserve the footprint, rebuild navigation and keep the site only if its approach is
// connected and no authored waypoint was cut off. Otherwise undo and report failure.
function trySite(terrain, site, parts, required) {
  const approach = { x: site.x, z: site.z + 3.2 };
  if (!terrain.walkable(approach.x, approach.z, NAV_CLEARANCE)) return null;
  const y = terrain.height(site.x, site.z);
  // The approach must stand at interaction height, not below a shelf.
  if (Math.abs(terrain.height(approach.x, approach.z) - y) > 1.5) return null;
  if (FOOTPRINT_CORNERS.some(([x, z]) => Math.abs(terrain.height(site.x + x, site.z + z) - y) > 1)) return null;
  const obstacles = parts.map(([x, , z, sx, , sz]) => terrain.addObstacle({ x: site.x + x, z: site.z + z, sx, sz }));
  terrain.rebuildNavigation();
  const node = terrain.cell(approach.x, approach.z),
    nav = terrain.position(node);
  if (
    terrain.valid[node] &&
    terrain.canMove(nav.x, nav.z, approach.x, approach.z, NAV_CLEARANCE) &&
    required.every((p) => terrain.valid[terrain.cell(p.x, p.z)])
  )
    return { x: site.x, z: site.z, y, approach, obstacles };
  for (const o of obstacles) terrain.removeObstacle(o);
  terrain.rebuildNavigation();
  return null;
}

// Sink the base slab through the sampled hillside while keeping its top level; the terrain
// is never deformed.
function foundation(terrain, site) {
  let bottom = site.y;
  for (let x = -2; x <= 2; x += 0.4)
    for (let z = -1.2; z <= 1.201; z += 0.4) bottom = Math.min(bottom, terrain.height(site.x + x, site.z + z));
  bottom -= site.y + 0.12;
  return [0, (bottom + 0.36) / 2, 0, 4, 0.36 - bottom, 2.4, 0];
}

// Called after scenery and before statues. Returns null in the tutorial or when no site fits.
export function createLandmark(terrain, scenery) {
  if (terrain.tutorial) return null;
  const definition = LANDMARKS.find((item) => item.stage === terrain.stage);
  if (!definition) return null;
  const parts = [BASE, ...ASSEMBLIES[terrain.stage - 1]],
    required = terrain.points.map(([x, z]) => terrain.safeNear(x, z, NAV_CLEARANCE));
  let site = null;
  for (const candidate of candidateSites(terrain)) if ((site = trySite(terrain, candidate, parts, required))) break;
  if (!site) return null;
  parts[0] = foundation(terrain, site);

  const tile = propTile(terrain.stage),
    materials = PALETTES[terrain.stage - 1].map((color) => retroMaterial(color, tile, { occlusion: true, ao: true })),
    box = sceneryShapes().geometries.box,
    group = new THREE.Group(),
    covers = [];
  group.name = definition.name;
  for (const [dx, dy, dz, sx, sy, sz, color] of parts) {
    const mesh = new THREE.Mesh(box, materials[color]);
    mesh.position.set(site.x + dx, site.y + dy, site.z + dz);
    mesh.scale.set(sx, sy, sz);
    group.add(mesh);
    const cover = { shape: "box", x: site.x + dx, y: site.y + dy, z: site.z + dz, sx, sy, sz, rotation: 0 };
    cover.bounds = coverBounds(cover);
    covers.push(cover);
  }
  scenery.covers.push(...covers);

  let disposed = false;
  const landmark = {
    ...definition,
    x: site.x,
    z: site.z,
    y: site.y,
    approach: site.approach,
    group,
    claimed: false,
    interactionRadius: INTERACTION_RADIUS,
    // Accepts (x, z) or any object with x/z (e.g. the player).
    nearby(x, z) {
      const px = typeof x === "object" ? x?.x : x,
        pz = typeof x === "object" ? x?.z : z;
      return (
        !disposed &&
        Number.isFinite(px) &&
        Number.isFinite(pz) &&
        Math.hypot(px - site.x, pz - site.z) < INTERACTION_RADIUS &&
        Math.abs(terrain.height(px, pz) - site.y) < 2
      );
    },
    // First call wins (one recovery per stage); later calls return false.
    claim() {
      if (disposed || landmark.claimed) return false;
      landmark.claimed = true;
      return true;
    },
    // Idempotent. Rebuilds navigation unless the terrain itself is being discarded.
    dispose({ rebuild = true } = {}) {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const o of site.obstacles) terrain.removeObstacle(o);
      for (const cover of covers) {
        const at = scenery.covers.indexOf(cover);
        if (at >= 0) scenery.covers.splice(at, 1);
      }
      if (rebuild) terrain.rebuildNavigation();
    },
  };
  return landmark;
}

// ---- the shrine bell (F2) -----------------------------------------------------------------

const BELL = Object.freeze({
  gap: 3, // metres beyond the shrine's footprint, on the side facing the stage origin
  turns: Object.freeze([0, 0.7, -0.7, 1.4, -1.4]), // tried in order, so no statue crowds the bell
  statueGap: 4,
  obstacle: 0.5,
  reach: 2.5, // interaction radius
  swing: 0.6, // radians at the first swing
  swingRate: 7,
  swingTime: 3,
  pulseRate: 6, // the awake clapper's glow, 0.8..1.0, held at 15 fps
});
const HALF_FOOTPRINT = Object.freeze({ x: 2, z: 1.2 });
const glow = new THREE.Color();

const clearOf = (statues, p) => statues.every((s) => Math.hypot(s.x - p.x, s.z - p.z) >= BELL.statueGap);

// Where the bell hangs: 3 m beyond the landmark's footprint toward the origin (turning a little
// either way if a statue stands there), snapped to the nearest walkable node. Without a
// landmark (no site fitted), a seeded reachable spot off the routes stands in.
function bellSite(terrain, landmark, seed, statues) {
  if (landmark) {
    const toward = Math.atan2(-landmark.x, -landmark.z);
    let first = null;
    for (const turn of BELL.turns) {
      const dx = Math.sin(toward + turn),
        dz = Math.cos(toward + turn),
        edge = Math.min(Math.abs(dx) > 1e-6 ? HALF_FOOTPRINT.x / Math.abs(dx) : Infinity, Math.abs(dz) > 1e-6 ? HALF_FOOTPRINT.z / Math.abs(dz) : Infinity),
        p = terrain.safeNear(landmark.x + dx * (edge + BELL.gap), landmark.z + dz * (edge + BELL.gap), BELL.obstacle);
      if (clearOf(statues, p)) return p;
      first ??= p;
    }
    return first;
  }
  const random = randomSource(seed),
    sites = terrain.reachable.map(terrain.position).filter((p) => {
      const d = Math.hypot(p.x, p.z);
      return d > 16 && d < 40 && terrain.routeDistance(p.x, p.z) > 6 && terrain.clear(p.x, p.z, 1.5) && clearOf(statues, p);
    });
  return sites.length ? sites[Math.floor(random() * sites.length)] : terrain.safeNear(0, 16, BELL.obstacle);
}

// createShrineBell(terrain, landmark, seed, { ring, sound }, statues) -> { x, z, y, state, group,
// wake(), ring(), nearby(x, z), update(dt, steady), dispose() }. `seed` is the stage seed plus
// PLACEMENT_OFFSETS.shrineBell. state: "still" (before the goal) -> "awake" (wake(), the goal is
// met) -> "rung" (ring() woke the Bellwether: hooks.ring() returned true). The bell rings once
// per stage; hooks.sound(name, volume, at) plays its toll.
export function createShrineBell(terrain, landmark, seed, hooks = {}, statues = []) {
  const site = bellSite(terrain, landmark, seed, statues),
    y = terrain.height(site.x, site.z),
    model = createShrineBellModel();
  model.g.position.set(site.x, y, site.z);
  // Broadside to the approach from the origin.
  model.g.rotation.y = Math.atan2(-site.x, -site.z) + Math.PI / 2;
  terrain.addObstacle({ x: site.x, z: site.z, r: BELL.obstacle });
  let swingT = -1,
    time = 0,
    shown = 0; // the clapper glow last painted (0 = dark)

  const bell = {
    x: site.x,
    z: site.z,
    y,
    group: model.g,
    state: "still",
    wake() {
      if (bell.state === "still") bell.state = "awake";
    },
    // True when the Bellwether answered; refused (still asleep, rung already, or refused by the
    // keeper flow, e.g. during a trial) returns false.
    ring() {
      if (bell.state !== "awake" || hooks.ring?.() !== true) return false;
      bell.state = "rung";
      swingT = 0;
      hooks.sound?.("toll", 0.6, bell);
      return true;
    },
    nearby(x, z) {
      return bell.state === "awake" && Math.hypot(x - bell.x, z - bell.z) < BELL.reach;
    },
    // Simulation step: the swing after a toll and the awake clapper glow (0.8..1.0, steady with
    // Reduce flashes), held at 15 fps.
    update(dt, steady = false) {
      time += dt;
      if (swingT >= 0) {
        swingT += dt;
        const left = Math.max(0, 1 - swingT / BELL.swingTime);
        model.pivot.rotation.z = BELL.swing * left * Math.sin((Math.floor(swingT * 15) / 15) * BELL.swingRate);
        if (!left) swingT = -1;
      }
      const k = bell.state !== "awake" ? 0 : steady ? 1 : 0.9 + 0.1 * Math.sin((Math.floor(time * 15) / 15) * BELL.pulseRate);
      if (k === shown) return;
      shown = k;
      model.tipMaterial.color.set(k ? glow.set(PROP_COLORS.clapperAwake).multiplyScalar(k) : PROP_COLORS.clapper);
    },
    dispose() {
      model.g.removeFromParent();
      model.tipMaterial.dispose();
    },
  };
  return bell;
}
