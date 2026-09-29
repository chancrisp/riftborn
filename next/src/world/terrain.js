// Stage terrain: heightfield, routes, collision, navigation and spawn placement. Pure math
// (no THREE) so worlds generate and test headless. One sampled surface drives rendering,
// walking, navigation and spawning, so they can never disagree.
import { randomSource } from "../core/rng.js";
import { clamp, lerp, smoothstep } from "../core/util.js";

export const EXTENT = 76;
export const CELLS = 152;
export const PLAY_RADIUS = 66;
export const TUTORIAL_RADIUS = 28;
export const MAX_WALK_SLOPE = 0.85;
export const NAV_SIZE = 65;
export const NAV_STEP = 2;
export const NAV_OFFSET = 64;
// The large layer fits the Warden and Iron Maw (radius 1.35) and drives every seeded
// placement exactly like the original single grid. The small layer lets ordinary monsters
// (radius <= SMALL_AGENT_RADIUS) path through the gaps the player uses.
export const NAV_CLEARANCE = 1.45;
export const NAV_SMALL_CLEARANCE = 0.85;
export const SMALL_AGENT_RADIUS = 0.75;

const STRIDE = CELLS + 1;
const SLOPE_LIMIT = MAX_WALK_SLOPE + 0.00001;
const MOVE_STEP = 0.18;
const NODES = NAV_SIZE * NAV_SIZE;
const CENTER = (NAV_SIZE >> 1) * NAV_SIZE + (NAV_SIZE >> 1);
// Nodes balanced on a cliff's triangle edge are not usable corridors (navigation only).
const NAV_MARGIN = 0.04;
const NODE_OFFSETS = [0, 0, NAV_MARGIN, 0, -NAV_MARGIN, 0, 0, NAV_MARGIN, 0, -NAV_MARGIN];

// Neighbour directions. The first four keep the original 4-connected order: BFS visit order
// feeds every seeded placement (statues, landmark), so it must not change.
const DIR_X = [-1, 1, 0, 0, -1, 1, -1, 1];
const DIR_Z = [0, 0, -1, 1, -1, -1, 1, 1];
const DIR_OPPOSITE = [1, 0, 3, 2, 7, 6, 5, 4];
const DIR_COST = [2, 2, 2, 2, 2 * Math.SQRT2, 2 * Math.SQRT2, 2 * Math.SQRT2, 2 * Math.SQRT2];

// Steering: advance within ARRIVE of a waypoint, string-pull up to LOOKAHEAD waypoints ahead,
// re-checking line of walk every RECHECK_STEPS calls per agent.
const ARRIVE = 0.75;
const LOOKAHEAD = 3;
const RECHECK_STEPS = 6;
const REPICK_DISTANCE = 4;
const COST_PROBE = 0.5; // sample spacing when a string-pull is checked against the cost layer

// Obstacle broadphase: 4 m buckets over the whole heightfield.
const BUCKET = 4;
const BUCKETS = (2 * EXTENT) / BUCKET;

// Authored stage layouts: [x, z, height]; point 0 is the reserved portal clearing.
const LAYOUTS = [
  { points: [[0, -30, 2], [-27, -19, 4], [-34, 14, 2], [0, 36, -1], [33, 21, 4], [35, -12, 1]], width: 4.5 },
  { points: [[27, -19, 5], [8, -42, 8], [-30, -28, 5], [-38, 8, 2], [-10, 37, 7], [31, 30, 9]], width: 4.2 },
  { points: [[-28, 22, 6], [-36, -10, 5], [-10, -37, 7], [29, -28, 6], [38, 8, 4], [8, 38, 5]], width: 4.3 },
  { points: [[6, 34, 8], [-27, 34, 8], [-32, -8, 4], [-22, -34, 8], [24, -34, 8], [34, 12, 4]], width: 4.8 },
  { points: [[-34, -20, 5], [-8, -41, 8], [32, -27, 5], [38, 16, 7], [5, 38, 5], [-32, 27, 8]], width: 4.8 },
];
const TUTORIAL_LAYOUT = { points: [[0, -20, 0], [-14, -10, 0], [14, -10, 0], [14, 10, 0], [-14, 10, 0]], width: 5 };

// Walks, in increasing order, the parameters t in (0, 1) where segment A->B crosses the
// heightfield's triangle edges (integer x, integer z and integer x+z lines). Between two
// consecutive crossings the ground under the segment is one plane. Reusable, allocation-free.
export class EdgeCrossings {
  constructor() {
    this.start = new Float64Array(3);
    this.end = new Float64Array(3);
    this.line = new Float64Array(3);
    this.dir = new Float64Array(3);
    this.t = new Float64Array(3);
  }
  reset(ax, az, bx, bz) {
    this.family(0, ax, bx);
    this.family(1, az, bz);
    this.family(2, ax + az, bx + bz);
    return this;
  }
  family(k, start, end) {
    this.start[k] = start;
    this.end[k] = end;
    if (Math.abs(end - start) < 1e-12) {
      this.t[k] = 2;
      return;
    }
    this.dir[k] = end > start ? 1 : -1;
    this.line[k] = end > start ? Math.floor(start) + 1 : Math.ceil(start) - 1;
    this.measure(k);
  }
  measure(k) {
    const n = this.line[k],
      inside = this.dir[k] > 0 ? n < this.end[k] : n > this.end[k];
    this.t[k] = inside ? (n - this.start[k]) / (this.end[k] - this.start[k]) : 2;
  }
  // Next crossing parameter, or 1 once every crossing has been returned.
  next() {
    let k = -1,
      best = 1;
    for (let i = 0; i < 3; i++)
      if (this.t[i] < best) {
        best = this.t[i];
        k = i;
      }
    if (k >= 0) {
      this.line[k] += this.dir[k];
      this.measure(k);
    }
    return best;
  }
}

// Module-level scratch: JS is single-threaded and navigation work never nests.
const bfsQueue = new Int32Array(NODES);
const bfsSeen = new Uint8Array(NODES);
const heapCost = new Float64Array(NODES * 8 + 1);
const heapNode = new Int32Array(NODES * 8 + 1);
const sweepCuts = new EdgeCrossings();
const spawnNear = [];
const spawnHidden = [];

const nodeX = (i) => (i % NAV_SIZE) * NAV_STEP - NAV_OFFSET;
const nodeZ = (i) => Math.floor(i / NAV_SIZE) * NAV_STEP - NAV_OFFSET;

function createLayer(id, clearance) {
  return {
    id,
    clearance,
    valid: new Uint8Array(NODES),
    links: new Uint8Array(NODES), // bit d = directed edge toward direction d
    reachable: [],
    cost: new Float64Array(NODES),
    next: new Int32Array(NODES).fill(-1),
    target: -1,
  };
}

// Binary min-heap over the shared typed arrays (Dijkstra with lazy deletion).
function heapPush(size, cost, node) {
  let i = size;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapCost[parent] <= cost) break;
    heapCost[i] = heapCost[parent];
    heapNode[i] = heapNode[parent];
    i = parent;
  }
  heapCost[i] = cost;
  heapNode[i] = node;
  return size + 1;
}
function heapPop(size) {
  const last = size - 1,
    cost = heapCost[last],
    node = heapNode[last];
  let i = 0;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= last) break;
    if (child + 1 < last && heapCost[child + 1] < heapCost[child]) child++;
    if (heapCost[child] >= cost) break;
    heapCost[i] = heapCost[child];
    heapNode[i] = heapNode[child];
    i = child;
  }
  heapCost[i] = cost;
  heapNode[i] = node;
  return last;
}

export function createTerrain(stage, seed = 7361, { tutorial = false } = {}) {
  const rng = randomSource(seed + stage * 7919),
    phase = rng(-3, 3),
    layout = tutorial ? TUTORIAL_LAYOUT : LAYOUTS[stage - 1],
    width = layout.width,
    playRadius = tutorial ? TUTORIAL_RADIUS : PLAY_RADIUS;
  // The entry and the portal stay fixed; outer waypoints drift between runs.
  const points = layout.points.map((p, i) =>
    tutorial || i === 0 ? [...p] : [p[0] + rng(-3, 3), p[1] + rng(-3, 3), p[2] + rng(-0.6, 0.6)],
  );
  const routes = buildRoutes(stage, tutorial, points);

  // BASE GEOGRAPHY — stage character before paths and clearings flatten selected areas.
  function raw(x, z) {
    const d = Math.hypot(x, z),
      wave = Math.sin(x * 0.085 + phase) * Math.cos(z * 0.095 - phase);
    if (tutorial) return Math.max(0, d - 23) * 0.28 + 0.22 * Math.sin(x * 0.13) * Math.sin(z * 0.11);
    if (stage === 1)
      return 2 + 3.6 * wave + 2.5 * Math.sin(z * 0.055) - 2.6 * Math.exp(-(((x + Math.sin(z * 0.06) * 13) / 9) ** 2));
    if (stage === 2) {
      const q = Math.max(Math.abs(x + 4) * 0.9, Math.abs(z - 3));
      return -3 + Math.floor(q / 11) * 3.4 + 0.35 * wave;
    }
    if (stage === 3) return -3 + 11 * Math.exp(-(((d - 34) / 12) ** 2)) + 2 * wave + Math.max(0, d - 45) * 0.22;
    if (stage === 4)
      return Math.floor(Math.max(Math.abs(x), Math.abs(z)) / 13) * 3.2 + (Math.abs(x) > 18 && Math.abs(x) < 28 ? -4 : 0);
    const a = Math.atan2(z, x);
    return 2 + Math.floor(d / 15) * 2.1 + 2 * wave - 10 * Math.exp(-(((Math.sin(a * 3 + phase * 0.2) * d) / 3.5) ** 2));
  }

  // Route blend: distance to the nearest path segment and a smooth mix of nearby path heights.
  let routeDist = 0,
    routeY = 0;
  function sampleRoutes(x, z) {
    let distance = Infinity,
      total = 0,
      sum = 0;
    for (let i = 0; i < routes.length; i++) {
      const a = routes[i][0],
        b = routes[i][1],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1),
        d = Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz),
        w = Math.max(0, 1 - d / (width + 4)) ** 4;
      distance = Math.min(distance, d);
      total += w;
      sum += w * lerp(a[2], b[2], t);
    }
    routeDist = distance;
    routeY = total ? sum / total : 0;
  }
  function routeAt(x, z) {
    sampleRoutes(x, z);
    return { distance: routeDist, y: routeY };
  }
  function routeDistance(x, z) {
    sampleRoutes(x, z);
    return routeDist;
  }

  // Paths flatten to route height, the entry plaza to 0 and the portal pad to its height.
  function generatedHeight(x, z) {
    sampleRoutes(x, z);
    let y = lerp(routeY, raw(x, z), smoothstep(width, width + 4, routeDist));
    y = lerp(0, y, smoothstep(6, 11, Math.hypot(x, z)));
    const p = points[0];
    return lerp(p[2], y, smoothstep(5, 10, Math.hypot(x - p[0], z - p[1])));
  }
  const heights = new Float32Array(STRIDE * STRIDE);
  for (let iz = 0; iz <= CELLS; iz++)
    for (let ix = 0; ix <= CELLS; ix++) heights[iz * STRIDE + ix] = generatedHeight(ix - EXTENT, iz - EXTENT);

  // Exact height of the rendered triangle (cell diagonal from (ix+1, iz) to (ix, iz+1)).
  function height(x, z) {
    const gx = clamp(x + EXTENT, 0, CELLS - 0.00001),
      gz = clamp(z + EXTENT, 0, CELLS - 0.00001),
      ix = Math.floor(gx),
      iz = Math.floor(gz),
      u = gx - ix,
      v = gz - iz,
      k = iz * STRIDE + ix,
      a = heights[k],
      b = heights[k + 1],
      c = heights[k + STRIDE],
      d = heights[k + STRIDE + 1];
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
  // Constant gradient of the triangle under (x, z), written to gradX/gradZ (no allocation).
  let gradX = 0,
    gradZ = 0;
  function gradientAt(x, z) {
    const gx = clamp(x + EXTENT, 0, CELLS - 0.00001),
      gz = clamp(z + EXTENT, 0, CELLS - 0.00001),
      ix = Math.floor(gx),
      iz = Math.floor(gz),
      k = iz * STRIDE + ix,
      a = heights[k],
      b = heights[k + 1],
      c = heights[k + STRIDE],
      d = heights[k + STRIDE + 1];
    if (gx - ix + gz - iz <= 1) {
      gradX = b - a;
      gradZ = c - a;
    } else {
      gradX = d - c;
      gradZ = d - b;
    }
  }
  function surfaceGradient(x, z, out = { x: 0, z: 0 }) {
    gradientAt(x, z);
    out.x = gradX;
    out.z = gradZ;
    return out;
  }
  // Rendering, walking and navigation all classify cliffs with this one number.
  function surfaceSlope(x, z) {
    gradientAt(x, z);
    return Math.hypot(gradX, gradZ);
  }

  // OBSTACLES — 2-D circles {x, z, r} and boxes {x, z, sx, sz}, bucketed for fast queries.
  const obstacles = [],
    buckets = Array.from({ length: BUCKETS * BUCKETS }, () => []);
  let indexed = 0;
  const bucketOf = (v) => clamp(Math.floor((v + EXTENT) / BUCKET), 0, BUCKETS - 1);
  function eachBucket(o, fn) {
    const hx = o.sx ? o.sx / 2 : o.r,
      hz = o.sx ? o.sz / 2 : o.r;
    for (let bz = bucketOf(o.z - hz); bz <= bucketOf(o.z + hz); bz++)
      for (let bx = bucketOf(o.x - hx); bx <= bucketOf(o.x + hx); bx++) fn(buckets[bz * BUCKETS + bx]);
  }
  function reindex() {
    for (const list of buckets) list.length = 0;
    for (const o of obstacles) eachBucket(o, (list) => list.push(o));
    indexed = obstacles.length;
  }
  // Direct pushes to `obstacles` (the original API) are picked up lazily.
  const sync = () => indexed !== obstacles.length && reindex();
  function addObstacle(o) {
    sync();
    obstacles.push(o);
    eachBucket(o, (list) => list.push(o));
    indexed = obstacles.length;
    return o;
  }
  function removeObstacle(o) {
    const at = obstacles.indexOf(o);
    if (at < 0) return false;
    obstacles.splice(at, 1);
    reindex();
    return true;
  }

  function blockedAt(x, z, r) {
    sync();
    const x1 = bucketOf(x + r),
      z1 = bucketOf(z + r);
    for (let bz = bucketOf(z - r); bz <= z1; bz++)
      for (let bx = bucketOf(x - r); bx <= x1; bx++) {
        const list = buckets[bz * BUCKETS + bx];
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (o.sx) {
            if (Math.abs(x - o.x) < o.sx / 2 + r && Math.abs(z - o.z) < o.sz / 2 + r) return true;
          } else if (Math.hypot(x - o.x, z - o.z) < o.r + r) return true;
        }
      }
    return false;
  }
  function sweepBlocked(o, x, z, dx, dz, d, r) {
    if (!o.sx) {
      const at = clamp(((o.x - x) * dx + (o.z - z) * dz) / (d * d), 0, 1);
      return Math.hypot(x + dx * at - o.x, z + dz * at - o.z) < o.r + r;
    }
    let low = 0,
      high = 1;
    for (let axis = 0; axis < 2; axis++) {
      const start = axis ? z - o.z : x - o.x,
        delta = axis ? dz : dx,
        extent = (axis ? o.sz : o.sx) / 2 + r;
      if (Math.abs(delta) < 1e-12) {
        if (Math.abs(start) >= extent) return false;
        continue;
      }
      let a = (-extent - start) / delta,
        b = (extent - start) / delta;
      if (a > b) [a, b] = [b, a];
      low = Math.max(low, a);
      high = Math.min(high, b);
      if (low >= high) return false;
    }
    return high > 1e-10 && low < 1 - 1e-10;
  }

  // COLLISION
  function clear(x, z, r = 0.45) {
    if (Math.hypot(x, z) > playRadius - r) return false;
    return !blockedAt(x, z, r);
  }
  function walkable(x, z, r = 0.45) {
    return clear(x, z, r) && surfaceSlope(x, z) <= SLOPE_LIMIT;
  }
  function canMove(x, z, nx, nz, r = 0.45) {
    if (!walkable(nx, nz, r)) return false;
    const dx = nx - x,
      dz = nz - z,
      d = Math.hypot(dx, dz);
    if (d < 1e-10) return true;
    sync();
    const x1 = bucketOf(Math.max(x, nx) + r),
      z1 = bucketOf(Math.max(z, nz) + r);
    for (let bz = bucketOf(Math.min(z, nz) - r); bz <= z1; bz++)
      for (let bx = bucketOf(Math.min(x, nx) - r); bx <= x1; bx++) {
        const list = buckets[bz * BUCKETS + bx];
        for (let i = 0; i < list.length; i++) if (sweepBlocked(list[i], x, z, dx, dz, d, r)) return false;
      }
    // Never average opposing slopes across a crease: sample every planar piece of the
    // segment, or a step could enter a steep facet that ordinary walking cannot leave.
    sweepCuts.reset(x, z, nx, nz);
    let last = 0;
    for (;;) {
      const t = sweepCuts.next();
      if (t < 1 && (t <= 1e-10 || t >= 1 - 1e-10)) continue;
      if (t - last >= 1e-10) {
        const mid = (last + t) / 2;
        if (surfaceSlope(x + dx * mid, z + dz * mid) > SLOPE_LIMIT) return false;
      }
      if (t >= 1) return true;
      last = t;
    }
  }

  // MOVEMENT — bounded swept sub-steps; a blocked uphill step slides along the cliff contour,
  // otherwise the axis-separated components slide along walls and obstacles.
  function move(o, dx, dz, r) {
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / MOVE_STEP));
    dx /= n;
    dz /= n;
    for (let i = 0; i < n; i++) {
      if (canMove(o.x, o.z, o.x + dx, o.z + dz, r)) {
        o.x += dx;
        o.z += dz;
        continue;
      }
      gradientAt(o.x + dx, o.z + dz);
      const length = Math.hypot(gradX, gradZ);
      if (length > MAX_WALK_SLOPE) {
        const nx = gradX / length,
          nz = gradZ / length,
          dot = dx * nx + dz * nz,
          sx = dx - dot * nx,
          sz = dz - dot * nz;
        if (Math.hypot(sx, sz) > 0.00001 && canMove(o.x, o.z, o.x + sx, o.z + sz, r)) {
          o.x += sx;
          o.z += sz;
          continue;
        }
      }
      if (canMove(o.x, o.z, o.x + dx, o.z, r)) o.x += dx;
      if (canMove(o.x, o.z, o.x, o.z + dz, r)) o.z += dz;
    }
  }

  // NAVIGATION — 65x65 nodes every 2 m. Only nodes connected to the entry stay valid.
  const large = createLayer("large", NAV_CLEARANCE),
    small = createLayer("small", NAV_SMALL_CLEARANCE),
    reachable = large.reachable,
    valid = large.valid;
  let flowReady = false,
    // Per-node walking cost multipliers (KEEPERS lava pools, IMPROVEMENTS F10); null keeps the
    // Wave-1 flow field exactly.
    navCost = null;

  const position = (i) => ({ x: nodeX(i), z: nodeZ(i) });
  function cell(x, z) {
    return (
      clamp(Math.round((z + NAV_OFFSET) / NAV_STEP), 0, NAV_SIZE - 1) * NAV_SIZE +
      clamp(Math.round((x + NAV_OFFSET) / NAV_STEP), 0, NAV_SIZE - 1)
    );
  }
  function neighbour(i, d) {
    const x = (i % NAV_SIZE) + DIR_X[d],
      z = Math.floor(i / NAV_SIZE) + DIR_Z[d];
    return x < 0 || z < 0 || x >= NAV_SIZE || z >= NAV_SIZE ? -1 : z * NAV_SIZE + x;
  }
  // Three parallel sweeps: the centre line and +/- the margin perpendicular to the edge.
  function edgeClear(i, j, d, r) {
    const px = nodeX(i),
      pz = nodeZ(i),
      qx = nodeX(j),
      qz = nodeZ(j),
      scale = d < 4 ? NAV_MARGIN : NAV_MARGIN / Math.SQRT2,
      ox = -DIR_Z[d] * scale,
      oz = DIR_X[d] * scale;
    return (
      canMove(px, pz, qx, qz, r) &&
      canMove(px + ox, pz + oz, qx + ox, qz + oz, r) &&
      canMove(px - ox, pz - oz, qx - ox, qz - oz, r)
    );
  }
  function nodeValid(i, r) {
    const x = nodeX(i),
      z = nodeZ(i);
    if (!walkable(x, z, r)) return false;
    for (let k = 0; k < NODE_OFFSETS.length; k += 2)
      if (surfaceSlope(x + NODE_OFFSETS[k], z + NODE_OFFSETS[k + 1]) > SLOPE_LIMIT) return false;
    return true;
  }
  // Validity, directed 4-connected edges and BFS connectivity from the entry.
  function buildLayer(layer) {
    const { valid: ok, links, clearance } = layer;
    for (let i = 0; i < NODES; i++) {
      links[i] = 0;
      ok[i] = nodeValid(i, clearance) ? 1 : 0;
    }
    for (let i = 0; i < NODES; i++) {
      if (!ok[i]) continue;
      for (let d = 0; d < 4; d++) {
        const j = neighbour(i, d);
        if (j >= 0 && ok[j] && edgeClear(i, j, d, clearance)) links[i] |= 1 << d;
      }
    }
    let size = 1;
    bfsQueue[0] = CENTER;
    bfsSeen.fill(0);
    bfsSeen[CENTER] = 1;
    for (let n = 0; n < size; n++) {
      const u = bfsQueue[n];
      for (let d = 0; d < 4; d++) {
        if (!(links[u] & (1 << d))) continue;
        const j = neighbour(u, d);
        if (bfsSeen[j]) continue;
        bfsSeen[j] = 1;
        bfsQueue[size++] = j;
      }
    }
    for (let i = 0; i < NODES; i++) if (!bfsSeen[i]) ok[i] = 0;
    layer.reachable.length = 0;
    for (let n = 0; n < size; n++) layer.reachable.push(bfsQueue[n]);
    layer.target = -1;
  }
  // Diagonal edges for smoother flow: both corner nodes must be valid too.
  function addDiagonals(layer) {
    const { valid: ok, links, clearance } = layer;
    for (const i of layer.reachable)
      for (let d = 4; d < 8; d++) {
        const j = neighbour(i, d);
        if (j < 0 || !ok[j] || !ok[i + DIR_X[d]] || !ok[i + DIR_Z[d] * NAV_SIZE]) continue;
        if (edgeClear(i, j, d, clearance)) links[i] |= 1 << d;
      }
  }
  // Call after obstacles change. Rebuilds the placement graph now; the diagonal edges and
  // the small-agent layer follow in prepareNavigation (world.build warms them up front).
  function rebuildNavigation() {
    buildLayer(large);
    small.target = -1;
    flowReady = false;
  }
  function prepareNavigation() {
    if (flowReady) return;
    addDiagonals(large);
    buildLayer(small);
    addDiagonals(small);
    flowReady = true;
  }

  function closestIn(layer, x, z) {
    const i = cell(x, z);
    if (layer.valid[i]) return i;
    let best = Infinity,
      result = -1;
    for (const k of layer.reachable) {
      const d = (nodeX(k) - x) ** 2 + (nodeZ(k) - z) ** 2;
      if (d < best) {
        best = d;
        result = k;
      }
    }
    return result;
  }
  const closest = (x, z) => closestIn(large, x, z);

  // FLOW FIELD — Dijkstra from the target node over 8-connected edges, shared by every agent
  // on the layer and recomputed only when the target's node changes. next[i] is the node to
  // walk to from i.
  function solveFlow(layer, tx, tz) {
    const target = closestIn(layer, tx, tz);
    if (target === layer.target) return;
    layer.target = target;
    const { cost, next, links } = layer;
    cost.fill(Infinity);
    next.fill(-1);
    if (target < 0) return;
    cost[target] = 0;
    next[target] = target;
    let size = heapPush(0, 0, target);
    while (size > 0) {
      const c = heapCost[0],
        u = heapNode[0];
      size = heapPop(size);
      if (c > cost[u]) continue;
      for (let d = 0; d < 8; d++) {
        if (!(links[u] & (1 << d))) continue;
        const v = neighbour(u, d);
        // Agents walk v -> u, so the edge in that direction must exist.
        if (!(links[v] & (1 << DIR_OPPOSITE[d]))) continue;
        const nc = c + (navCost ? DIR_COST[d] * (navCost[u] + navCost[v]) * 0.5 : DIR_COST[d]);
        if (nc < cost[v]) {
          cost[v] = nc;
          next[v] = u;
          size = heapPush(size, nc, v);
        }
      }
    }
  }
  function updateFlow(tx, tz) {
    prepareNavigation();
    solveFlow(large, tx, tz);
    solveFlow(small, tx, tz);
  }

  // Cost layer: walking through `cells` (node indices) costs `mult` times the distance, so the
  // flow field routes around them unless they are the only way (mult 1 restores a node).
  function setCost(cells, mult) {
    const cost = Math.max(1, Number(mult) || 1);
    navCost ??= new Float64Array(NODES).fill(1);
    for (const i of cells) if (i >= 0 && i < NODES) navCost[i] = cost;
    large.target = small.target = -1;
  }
  // Node indices whose position lies inside the axis-aligned box centred on (x, z) with the
  // given half extents.
  function cellsInBox(x, z, halfX, halfZ) {
    const cells = [],
      x0 = Math.max(0, Math.ceil((x - halfX + NAV_OFFSET) / NAV_STEP)),
      x1 = Math.min(NAV_SIZE - 1, Math.floor((x + halfX + NAV_OFFSET) / NAV_STEP)),
      z0 = Math.max(0, Math.ceil((z - halfZ + NAV_OFFSET) / NAV_STEP)),
      z1 = Math.min(NAV_SIZE - 1, Math.floor((z + halfZ + NAV_OFFSET) / NAV_STEP));
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) cells.push(iz * NAV_SIZE + ix);
    return cells;
  }

  const scratchAgent = {};
  // Unit direction toward the next waypoint (shrinks only within 0.24 m of the final target).
  // Agents advance within ARRIVE of a waypoint and string-pull to farther waypoints they can
  // walk straight to, so they neither creep onto nodes nor staircase along the grid.
  function steer(x, z, tx, tz, agent, out = { x: 0, z: 0 }) {
    prepareNavigation();
    // Agents without a radius are treated as the largest body the large layer is built for.
    const radius = agent?.radius ?? NAV_CLEARANCE - 0.1,
      layer = radius > SMALL_AGENT_RADIUS ? large : small;
    solveFlow(layer, tx, tz);
    const target = layer.target,
      nav = agent || scratchAgent;
    let current = nav.navCell;
    if (target < 0) return aimAt(x, z, tx, tz, out);
    if (
      nav.navLayer !== layer.id ||
      current === undefined ||
      current < 0 ||
      !layer.valid[current] ||
      Math.hypot(nodeX(current) - x, nodeZ(current) - z) > REPICK_DISTANCE
    ) {
      current = closestIn(layer, x, z);
      nav.navTick = 0;
    }
    for (let hop = 0; hop < LOOKAHEAD && current !== target; hop++) {
      const ahead = layer.next[current];
      if (ahead < 0 || Math.hypot(nodeX(current) - x, nodeZ(current) - z) >= ARRIVE) break;
      current = ahead;
      nav.navTick = 0;
    }
    nav.navTick = (nav.navTick || 0) - 1;
    if (nav.navTick < 0) {
      nav.navTick = RECHECK_STEPS;
      // When the target moves, the cached waypoint can end up behind the agent: restart from
      // the agent's own node if it is already closer to the target.
      const here = cell(x, z);
      if (
        here !== current &&
        layer.valid[here] &&
        layer.cost[here] < layer.cost[current] &&
        walkClear(x, z, nodeX(here), nodeZ(here), radius)
      )
        current = here;
      for (let k = 0; k < LOOKAHEAD && current !== target; k++) {
        const ahead = layer.next[current];
        if (ahead < 0 || !walkClear(x, z, nodeX(ahead), nodeZ(ahead), radius)) break;
        current = ahead;
      }
    }
    nav.navCell = current;
    nav.navLayer = layer.id;
    return current === target ? aimAt(x, z, tx, tz, out) : aimAt(x, z, nodeX(current), nodeZ(current), out);
  }
  // A straight walk the string-pull may take: unobstructed and, with a cost layer, never into
  // nodes costlier than the one it starts on (a pool's corner is not a shortcut; an agent
  // already standing in one may still leave).
  function walkClear(x, z, tx, tz, radius) {
    if (!canMove(x, z, tx, tz, radius)) return false;
    if (!navCost) return true;
    const start = navCost[cell(x, z)],
      steps = Math.ceil(Math.hypot(tx - x, tz - z) / COST_PROBE);
    for (let i = 1; i <= steps; i++) if (navCost[cell(x + ((tx - x) * i) / steps, z + ((tz - z) * i) / steps)] > start) return false;
    return true;
  }
  function aimAt(x, z, ax, az, out) {
    const d = Math.max(0.24, Math.hypot(ax - x, az - z));
    out.x = (ax - x) / d;
    out.z = (az - z) / d;
    return out;
  }

  // SPAWNING — a reachable, walkable node 17–26 m from the player (else >= 12 m). With a
  // view test, nodes outside the camera view are preferred so monsters do not pop in on screen.
  function gather(px, pz, r, min, max, isVisible) {
    spawnNear.length = 0;
    spawnHidden.length = 0;
    for (const i of reachable) {
      const x = nodeX(i),
        z = nodeZ(i),
        d = Math.hypot(x - px, z - pz);
      if (d < min || d > max || !walkable(x, z, r)) continue;
      spawnNear.push(i);
      if (isVisible && !isVisible(x, z)) spawnHidden.push(i);
    }
    return spawnHidden.length ? spawnHidden : spawnNear;
  }
  function spawn(px, pz, r = 0.5, random = Math.random, isVisible = null) {
    let pool = gather(px, pz, r, 17, 26, isVisible);
    if (!pool.length) pool = gather(px, pz, r, 12, Infinity, isVisible);
    const roll = random(),
      pick = pool.length ? pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))] : CENTER;
    return position(pick);
  }
  // PLACEMENT RECOVERY — nearest reachable walkable node (ties keep BFS order). Falls back to
  // the entry like the original; it never returns null on a real map.
  function safeNear(x, z, r = 0.5) {
    let best = Infinity,
      result = -1;
    for (const i of reachable) {
      const d = (nodeX(i) - x) ** 2 + (nodeZ(i) - z) ** 2;
      if (d < best && walkable(nodeX(i), nodeZ(i), r)) {
        best = d;
        result = i;
      }
    }
    return result < 0 ? { x: 0, z: 0 } : position(result);
  }

  return {
    stage,
    seed,
    tutorial,
    playRadius,
    width,
    heights,
    points,
    routes,
    obstacles,
    reachable,
    valid,
    height,
    surfaceGradient,
    surfaceSlope,
    routeAt,
    routeDistance,
    clear,
    walkable,
    canMove,
    move,
    addObstacle,
    removeObstacle,
    rebuildNavigation,
    prepareNavigation,
    position,
    cell,
    closest,
    updateFlow,
    setCost,
    cellsInBox,
    steer,
    spawn,
    safeNear,
  };
}

function buildRoutes(stage, tutorial, points) {
  const routes = [],
    origin = [0, 0, 0];
  const spokes = tutorial
    ? [0, 1, 2, 3, 4]
    : stage === 2 || stage === 4
      ? [0]
      : stage === 5
        ? [0, 1, 2, 3, 4, 5]
        : [0, 2, 4];
  for (const i of spokes) routes.push([origin, points[i]]);
  if (stage !== 5)
    for (let i = 0; i < points.length; i++) routes.push([points[i], points[(i + 1) % points.length]]);
  if (stage === 2) {
    // Dog-leg path west then north.
    const bend = [-16, 0, 0],
      rise = [-16, 14, 1];
    routes.push([origin, bend], [bend, rise], [rise, points[3]]);
  }
  if (stage === 4) {
    // Causeways across the moats.
    const south = [0, -34, 4],
      west = [-32, 0, 3];
    routes.push([origin, south], [south, points[3]], [south, points[4]], [origin, west], [west, points[2]]);
  }
  return routes;
}
