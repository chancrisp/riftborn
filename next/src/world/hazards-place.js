// Hazard placement (IMPROVEMENTS F10), KEEPERS only: where each world's props stand. It runs
// after scenery, the landmark and the statues, seeded randomSource(stageSeed +
// PLACEMENT_OFFSETS.hazards) (F14.1), never a run stream. Sites keep clear of the portal pad
// (9 m), the origin plaza (11 m), routes (more than 3 m), statues (4 m) and the landmark (6 m).
// Pure math over the terrain and scenery records: no THREE, so it runs and tests headless.
import { randomSource, PLACEMENT_OFFSETS } from "../core/rng.js";
import { PROP_KINDS } from "../data/hazards.js";

export const PLACEMENT = Object.freeze({
  portal: 9,
  plaza: 11,
  route: 3,
  statue: 4,
  landmark: 6,
  attempts: 400,
  // Meadows marsh pods: within 4 m of the stream centreline, on low ground, 3 m off route centres.
  stream: Object.freeze({ reach: 4, maxHeight: 1.5, clearance: 1.0, spacing: 7 }),
  // Quarry charges: 1.2..4 m beyond the edge of a cut-stone block or gantry.
  anchor: Object.freeze({ near: 1.2, far: 4, clearance: 0.8, spacing: 2.5 }),
});

// The Meadows stream: the terrain's marsh trough runs along x = -13 sin(0.06 z).
export const streamX = (z) => -13 * Math.sin(0.06 * z);

// The shared exclusion rule for a new site at (x, z).
export function siteAllowed(terrain, x, z, { statues = [], landmark = null } = {}) {
  const [portalX, portalZ] = terrain.points[0];
  return (
    Math.hypot(x, z) > PLACEMENT.plaza &&
    Math.hypot(x - portalX, z - portalZ) > PLACEMENT.portal &&
    terrain.routeDistance(x, z) > PLACEMENT.route &&
    !statues.some((s) => Math.hypot(s.x - x, s.z - z) < PLACEMENT.statue) &&
    !(landmark && Math.hypot(landmark.x - x, landmark.z - z) < PLACEMENT.landmark)
  );
}

const nearestFirst = (list, count) =>
  list
    .map((item, i) => ({ item, i, d: Math.hypot(item.x, item.z) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, count)
    .map(({ item }) => item);

const spaced = (sites, x, z, gap) => sites.every((s) => Math.hypot(s.x - x, s.z - z) >= gap);

// Three swollen pods on a moss disc: offsets and radii (0.35..0.5 m) from the placement stream.
function podsFor(random) {
  const turn = random(0, Math.PI * 2);
  return [0, 1, 2].map((i) => {
    const a = turn + (i * Math.PI * 2) / 3 + random(-0.3, 0.3),
      d = random(0.25, 0.45);
    return { dx: Math.sin(a) * d, dz: Math.cos(a) * d, r: random(0.35, 0.5) };
  });
}

function marshSites(terrain, random, avoid) {
  const { reach, maxHeight, clearance, spacing } = PLACEMENT.stream,
    sites = [];
  for (let n = 0; n < PLACEMENT.attempts && sites.length < PROP_KINDS.marsh.count; n++) {
    const z = random(-60, 60),
      x = streamX(z) + random(-reach, reach);
    if (terrain.height(x, z) >= maxHeight || !terrain.clear(x, z, clearance) || !siteAllowed(terrain, x, z, avoid)) continue;
    if (!spaced(sites, x, z, spacing)) continue;
    sites.push({ kind: "marsh", x, z, y: terrain.height(x, z), yaw: 0, pods: podsFor(random) });
  }
  return sites;
}

function chargeSites(terrain, scenery, random, avoid) {
  const { near, far, clearance, spacing } = PLACEMENT.anchor,
    anchors = [...scenery.anchors("block"), ...scenery.anchors("gantry")],
    sites = [];
  if (!anchors.length) return sites;
  for (let n = 0; n < PLACEMENT.attempts && sites.length < PROP_KINDS.charge.count; n++) {
    const anchor = anchors[Math.min(anchors.length - 1, Math.floor(random() * anchors.length))],
      a = random(0, Math.PI * 2),
      d = anchor.r + random(near, far),
      x = anchor.x + Math.sin(a) * d,
      z = anchor.z + Math.cos(a) * d;
    if (!terrain.walkable(x, z, clearance) || !siteAllowed(terrain, x, z, avoid) || !spaced(sites, x, z, spacing)) continue;
    // The crate sits square to the stone it leans on.
    sites.push({ kind: "charge", x, z, y: terrain.height(x, z), yaw: Math.atan2(anchor.x - x, anchor.z - z) });
  }
  return sites;
}

// placeHazards({ stage, terrain, scenery, statues, landmark, seed }) -> the stage's prop sites:
// { kind, x, z, y, yaw, pods? (marsh), tower? (beacon), spire? (crystal) }. `seed` is the stage
// seed (world.stageSeed). The Caldera's lava pools are scenery (scenery.lavaPools()), not props.
export function placeHazards({ stage, terrain, scenery, statues = [], landmark = null, seed }) {
  const random = randomSource(seed + PLACEMENT_OFFSETS.hazards),
    avoid = { statues, landmark };
  if (stage === PROP_KINDS.marsh.stage) return marshSites(terrain, random, avoid);
  if (stage === PROP_KINDS.charge.stage) return chargeSites(terrain, scenery, random, avoid);
  if (stage === PROP_KINDS.beacon.stage)
    return nearestFirst(scenery.towers(), PROP_KINDS.beacon.count).map((tower) => ({ kind: "beacon", x: tower.x, z: tower.z, y: tower.y, yaw: 0, tower }));
  if (stage === PROP_KINDS.crystal.stage)
    return nearestFirst(scenery.spires(), PROP_KINDS.crystal.count).map((spire) => ({ kind: "crystal", x: spire.x, z: spire.z, y: spire.y, yaw: 0, spire }));
  return [];
}
