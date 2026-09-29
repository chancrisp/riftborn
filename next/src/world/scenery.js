// Per-stage props, projectile covers, walk obstacles, distant silhouettes, route markers and
// the ground surface. Covers stop shots, obstacles stop feet: keep both in sync when adding
// solid structures. Static props are batched into one InstancedMesh per shape/colour/glow.
import * as THREE from "three";
import { retroMaterial, bakeBaseAO, TILE } from "../render/materials.js";
import { randomSource } from "../core/rng.js";
import { clamp, lerp, smoothstep, TAU } from "../core/util.js";
import { EXTENT, CELLS, MAX_WALK_SLOPE } from "./terrain.js";
import { coverBounds } from "./ballistics.js";

const STRIDE = CELLS + 1;
// [low, high, trail] per stage; the tutorial cloister has its own slate palette.
const PALETTES = [
  ["#497c57", "#75915f", "#bac1a0"],
  ["#424c66", "#687992", "#b3b0a1"],
  ["#372d40", "#6d3948", "#b77561"],
  ["#273958", "#546d91", "#a5bcd1"],
  ["#241e48", "#503b76", "#9e83b6"],
];
const TUTORIAL_PALETTE = ["#596976", "#839194", "#d1c5a6"];
const ROCK_COLORS = ["#5a6358", "#465567", "#483a44", "#42546b", "#4b3b61"];

export function stagePalette(stage, tutorial = false) {
  const [low, high, trail] = tutorial ? TUTORIAL_PALETTE : PALETTES[stage - 1];
  return { low, high, trail };
}
// Atlas tile shared by a stage's props and its landmark.
export function propTile(stage) {
  return [TILE.cobble, TILE.rust, TILE.rock, TILE.brick, TILE.crystal][stage - 1];
}
const topTile = (stage, tutorial) =>
  tutorial ? TILE.cobble : [TILE.grass, TILE.cobble, TILE.rock, TILE.brick, TILE.crystal][stage - 1];
const rockTile = (stage) => (stage === 3 ? TILE.rock : stage === 5 ? TILE.crystal : TILE.cobble);

// Unit primitives shared by every stage (never disposed) and their convex hulls, so shot
// traces clip against the true faceted shape, scaled and rotated about Y.
let shapes = null;
export function sceneryShapes() {
  if (shapes) return shapes;
  const geometries = {
    box: new THREE.BoxGeometry(1, 1, 1),
    ico: new THREE.IcosahedronGeometry(1, 0),
    cone: new THREE.ConeGeometry(1, 1, 6),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 8),
    gem: new THREE.OctahedronGeometry(1, 0),
  };
  const hulls = {};
  for (const [name, geometry] of Object.entries(geometries)) hulls[name] = hullOf(bakeBaseAO(geometry));
  shapes = { geometries, hulls };
  return shapes;
}
function hullOf(geometry) {
  geometry.computeBoundingBox();
  const pos = geometry.attributes.position,
    index = geometry.index,
    count = index ? index.count : pos.count,
    planes = new Map(),
    vertex = (i) => (index ? index.getX(i) : i);
  for (let i = 0; i < count; i += 3) {
    const a = vertex(i),
      b = vertex(i + 1),
      c = vertex(i + 2),
      ax = pos.getX(a),
      ay = pos.getY(a),
      az = pos.getZ(a),
      ux = pos.getX(b) - ax,
      uy = pos.getY(b) - ay,
      uz = pos.getZ(b) - az,
      vx = pos.getX(c) - ax,
      vy = pos.getY(c) - ay,
      vz = pos.getZ(c) - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) continue; // degenerate (cone apex) faces carry no plane
    nx /= length;
    ny /= length;
    nz /= length;
    const w = nx * ax + ny * ay + nz * az,
      key = [nx, ny, nz, w].map((v) => v.toFixed(5)).join(",");
    planes.set(key, { x: nx, y: ny, z: nz, w });
  }
  const { min, max } = geometry.boundingBox;
  return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z }, planes: [...planes.values()] };
}

const dummy = new THREE.Object3D();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

// Molten pools (IMPROVEMENTS F10): the glowing surface over each crust block, the KEEPERS lava
// zone footprint.
export const LAVA_POOL = Object.freeze({ sx: 3.6, sz: 2.6, crustX: 4, crustZ: 3, crustHeight: 0.25 });

export function buildScenery(terrain) {
  const { stage, tutorial } = terrain,
    rng = randomSource(terrain.seed + stage * 3571),
    palette = stagePalette(stage, tutorial),
    { geometries, hulls } = sceneryShapes(),
    [portalX, portalZ] = terrain.points[0],
    covers = [],
    batches = new Map(),
    group = new THREE.Group(),
    // Structures KEEPERS systems build on (hazard props, F10); bookkeeping only, no draws.
    records = { anchors: { block: [], gantry: [] }, towers: [], spires: [], lava: [] };
  group.name = "stage-scenery";
  // The cover and the instance slot of the most recent add()/decorate().
  let lastCover = null,
    lastBatch = null,
    lastIndex = -1;

  // The ground's per-vertex brightness noise is the first thing drawn from the scenery
  // stream; props follow in code order (bit-identical layouts depend on it).
  const jitter = new Float32Array(STRIDE * STRIDE);
  for (let i = 0; i < jitter.length; i++) jitter[i] = rng(0.92, 1.07);

  // Anything taller than 0.35 inside the arena also blocks shots.
  function add(shape, color, x, y, z, sx, sy, sz, glow = 0, rotation = 0, anim = null) {
    lastCover = null;
    if (sy > 0.35 && Math.hypot(x, z) < 75) {
      const cover = { shape, x, y, z, sx, sy, sz, rotation, hull: hulls[shape] };
      cover.bounds = coverBounds(cover);
      covers.push(cover);
      lastCover = cover;
    }
    decorate(shape, color, x, y, z, sx, sy, sz, glow, rotation, anim);
  }
  // Visual-only instance.
  function decorate(shape, color, x, y, z, sx, sy, sz, glow = 0, rotation = 0, anim = null) {
    const key = shape + color + glow + (anim ?? "");
    let batch = batches.get(key);
    if (!batch) batches.set(key, (batch = { shape, color, glow, anim, items: [], mesh: null }));
    batch.items.push(x, y, z, sx, sy, sz, rotation);
    lastBatch = batch;
    lastIndex = batch.items.length / 7 - 1;
  }
  // The instance the last add()/decorate() drew; its mesh is known once the batches are built.
  const slot = () => ({ batch: lastBatch, index: lastIndex });
  // The global prop placement rule: outside the plaza, off the paths, clear of the portal
  // pad and of earlier obstacles (with 1.4 m spacing), inside the play radius.
  function allowed(x, z, r) {
    const d = Math.hypot(x, z);
    return (
      !tutorial &&
      d > 11 &&
      d < 63 &&
      terrain.routeDistance(x, z) > 5.7 + r &&
      Math.hypot(x - portalX, z - portalZ) > 9 + r &&
      terrain.clear(x, z, r + 1.4)
    );
  }
  function block(x, z, sx, sz, h, color) {
    const y = terrain.height(x, z);
    add("box", color, x, y + h / 2, z, sx, h, sz);
    terrain.addObstacle({ x, z, sx, sz });
    return y;
  }
  // Level-enough sites on a 4 m grid (flatness checked along X only, like the original),
  // nearest to the entry first.
  function structureSites() {
    const sites = [];
    for (let z = -48; z <= 48; z += 4)
      for (let x = -48; x <= 48; x += 4) {
        if (Math.hypot(x, z) < 17 || !allowed(x, z, 4)) continue;
        const y = terrain.height(x, z);
        if (Math.abs(terrain.height(x - 3, z) - y) < 0.7 && Math.abs(terrain.height(x + 3, z) - y) < 0.7)
          sites.push([x, z]);
      }
    return sites.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  }

  const kit = { terrain, rng, palette, add, decorate, allowed, block, structureSites, records, slot, last: () => lastCover };
  if (tutorial) cloisterProps(kit);
  else STAGE_PROPS[stage - 1](kit);
  setPieces(kit);
  groundPlants(kit);
  silhouettes(kit);
  routeMarkers(kit);
  boundaryRing(kit);

  const ground = createGround(terrain, palette, jitter);
  group.add(ground.surface, ground.ledge);
  for (const batch of batches.values()) {
    const { shape, color, glow, anim, items } = batch;
    const tile =
      shape === "cone" && stage === 1
        ? TILE.leaves
        : shape === "cylinder" && stage === 1
          ? TILE.bark
          : glow && stage === 3
            ? TILE.lava
            : propTile(stage);
    const mesh = new THREE.InstancedMesh(geometries[shape], retroMaterial(color, tile, { glow, occlusion: true, anim, ao: true }), items.length / 7);
    for (let i = 0, k = 0; k < items.length; i++, k += 7) {
      dummy.position.set(items[k], items[k + 1], items[k + 2]);
      dummy.scale.set(items[k + 3], items[k + 4], items[k + 5]);
      dummy.rotation.set(0, items[k + 6], 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.computeBoundingSphere();
    group.add(mesh);
    batch.mesh = mesh;
  }
  terrain.rebuildNavigation();

  // Instance slots hidden by KEEPERS props (a live beacon's gem, a fallen crystal), keyed by the
  // record's slot, with the matrix to restore.
  const hidden = new Map();

  return {
    group,
    surface: ground.surface,
    covers,
    drawCalls: batches.size + ground.drawCalls,
    // KEEPERS placement anchors (F10): "block" (cut stone) and "gantry" sites as { x, z, r }.
    anchors: (kind) => records.anchors[kind] ?? [],
    // Citadel beacon towers: { x, z, y, h, cover, gem } (gem = the beacon's instance slot).
    towers: () => records.towers,
    // Void spires: { x, z, y, h, cover, gemCover, gem } (gem = the floating crystal's slot).
    spires: () => records.spires,
    // Caldera molten pools: { x, z, y, sx, sz, crust } (crust = the walk obstacle under it).
    lavaPools: () => records.lava,
    // Shows or hides one batched instance (scale 0); the original matrix comes back on show.
    setInstanceVisible(ref, visible) {
      const mesh = ref?.batch?.mesh;
      if (!mesh || visible === !hidden.has(ref)) return;
      if (visible) {
        mesh.setMatrixAt(ref.index, hidden.get(ref));
        hidden.delete(ref);
      } else {
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(ref.index, matrix);
        hidden.set(ref, matrix);
        mesh.setMatrixAt(ref.index, HIDDEN);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      group.removeFromParent();
      ground.dispose();
      group.traverse((o) => o.isInstancedMesh && o.dispose());
    },
  };
}

// TUTORIAL — "RIFT CLOISTER": perimeter pillars, the rift gate and pale flagstones.
function cloisterProps({ terrain, add, block }) {
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8,
      x = Math.cos(a) * 26,
      z = Math.sin(a) * 26,
      y = terrain.height(x, z),
      h = i % 3 === 0 ? 5 : 3.4;
    block(x, z, 1.3, 1.3, h, "#839194");
    add("box", "#c2c8b7", x, y + h + 0.2, z, 1.8, 0.4, 1.8);
  }
  for (const x of [-5, 5]) {
    const y = block(x, -21, 1.3, 1.3, 6, "#839194");
    add("box", "#d1c5a6", x, y + 6.2, -21, 1.8, 0.4, 1.8);
  }
  add("box", "#839194", 0, 6.7, -21, 12, 0.7, 1.5);
  for (const z of [-12, -6, 0, 6, 12])
    for (const x of [-20, 20]) add("box", "#c2c8b7", x, terrain.height(x, z) + 0.12, z, 1.8, 0.24, 3);
}

// 1 · MEADOWS — ruined arches and three kinds of tree.
function meadowProps({ terrain, rng, add, allowed, block, structureSites }) {
  let ruins = 0;
  for (const [x, z] of structureSites()) {
    if (!allowed(x, z, 4)) continue;
    const y = terrain.height(x, z);
    for (const d of [-2.2, 2.2]) {
      block(x + d, z, 1.1, 1.6, 4.2 + y - terrain.height(x + d, z), "#a5aba0");
      add("box", "#bdc5ad", x + d, y + 4.5, z, 1.6, 0.4, 2);
    }
    add("box", "#8c9795", x, y + 5, z, 6, 0.8, 1.6);
    if (++ruins === 3) break;
  }
  const pine = ["#245c51", "#327464", "#529076"];
  for (let i = 0; i < 95; i++) {
    const x = rng(-65, 65),
      z = rng(-65, 65),
      k = rng(0.8, 1.5);
    if (!allowed(x, z, 2)) continue;
    const y = terrain.height(x, z);
    add("cylinder", "#66503d", x, y + 1.8 * k, z, 0.3 * k, 3.6 * k, 0.3 * k);
    if (i % 3 === 0) {
      for (const side of [-1, 1]) add("ico", "#529076", x + side * 0.9 * k, y + 4.1 * k, z, 1.6 * k, 1.6 * k, 1.5 * k);
      add("ico", "#327464", x, y + 5 * k, z, 1.8 * k, 1.7 * k, 1.8 * k);
    } else if (i % 3 === 1) {
      for (let j = 0; j < 3; j++)
        add("cone", pine[j], x, y + (3 + j * 0.95) * k, z, (2 - j * 0.35) * k, 2.6 * k, (2 - j * 0.35) * k);
    } else {
      add("box", "#66503d", x, y + 2.7 * k, z, 2.5 * k, 0.45 * k, 0.35 * k, 0, 0.6);
      add("ico", "#245c51", x + 0.7 * k, y + 3.5 * k, z, 1.6 * k, 1 * k, 1.4 * k);
    }
    terrain.addObstacle({ x, z, r: 0.5 * k });
  }
}

// 2 · SHATTERED QUARRY — mining gantries and stacks of cut stone.
function quarryProps({ terrain, rng, add, allowed, block, structureSites, records }) {
  let gantries = 0;
  for (const [x, z] of structureSites()) {
    if (!allowed(x, z, 4)) continue;
    const y = terrain.height(x, z);
    for (const d of [-3, 3]) block(x + d, z, 1, 2, 8 + y - terrain.height(x + d, z), "#354556");
    add("box", "#c7a66d", x, y + 8.3, z, 8, 0.7, 1.4);
    add("box", "#506e7d", x + 1, y + 5.8, z, 0.25, 4, 0.25);
    records.anchors.gantry.push({ x, z, r: 4 });
    if (++gantries === 2) break;
  }
  for (let i = 0; i < 65; i++) {
    const x = rng(-63, 63),
      z = rng(-63, 63),
      w = rng(2, 5);
    if (!allowed(x, z, w)) continue;
    const h = rng(2, 7),
      y = block(x, z, w, w * 0.8, h, "#546078");
    add("box", "#8e9baf", x, y + h + 0.2, z, w + 0.3, 0.4, w * 0.85);
    records.anchors.block.push({ x, z, r: w / 2 });
  }
}

// 3 · EMBER CALDERA — basalt columns crowned with embers, and lava pools on low ground. Each
// pool is a low crust block (a walk obstacle; KEEPERS lifts it, F10) under a molten surface.
function calderaProps({ terrain, rng, add, allowed, records }) {
  for (let i = 0; i < 70; i++) {
    const x = rng(-65, 65),
      z = rng(-65, 65);
    if (!allowed(x, z, 2.5)) continue;
    const y = terrain.height(x, z),
      h = rng(2, 8);
    add("cylinder", "#443748", x, y + h / 2, z, 1.4, h, 1.4);
    add("gem", "#f19a58", x, y + h + 0.2, z, 0.55, 1.3, 0.55, 1.8);
    terrain.addObstacle({ x, z, r: 1.5 });
  }
  const { sx, sz, crustX, crustZ, crustHeight } = LAVA_POOL;
  for (let i = 0; i < 40; i++) {
    const x = rng(-62, 62),
      z = rng(-62, 62);
    if (!allowed(x, z, 2.8) || terrain.height(x, z) > 2) continue;
    const y = terrain.height(x, z);
    add("box", "#8f4039", x, y + crustHeight / 2, z, crustX, crustHeight, crustZ);
    const crust = terrain.addObstacle({ x, z, sx: crustX, sz: crustZ });
    add("box", "#ff7744", x, y + 0.27, z, sx, 0.08, sz, 1.8, 0, "lava");
    records.lava.push({ x, z, y, sx, sz, crust });
  }
}

// 4 · AURORA CITADEL — grid-snapped buildings; every third is a beacon tower.
function citadelProps({ rng, add, allowed, block, records, slot, last }) {
  for (let i = 0; i < 60; i++) {
    const x = Math.round(rng(-58, 58) / 8) * 8,
      z = Math.round(rng(-58, 58) / 8) * 8;
    if (!allowed(x, z, 3)) continue;
    const tower = i % 3 === 0,
      h = tower ? rng(8, 13) : rng(2, 4),
      y = block(x, z, 3.5, 3.5, h, "#405978"),
      cover = last();
    add("box", "#b4cddd", x, y + h, z, 4.1, 0.4, 4.1);
    if (tower) {
      for (const d of [-1.4, 1.4]) add("box", "#6e91b0", x + d, y + h + 0.8, z, 0.65, 1.4, 3.5);
      add("gem", "#83e7ff", x, y + h + 1.6, z, 0.35, 1, 0.35, 2);
      records.towers.push({ x, z, y, h, cover, gem: slot() });
    }
  }
}

// 5 · THE VOID CROWN — crystal spires with floating gems; every third carries a slab.
function voidProps({ terrain, rng, add, allowed, records, slot, last }) {
  for (let i = 0; i < 58; i++) {
    const x = rng(-65, 65),
      z = rng(-65, 65);
    if (!allowed(x, z, 3)) continue;
    const h = rng(3, 9),
      y = terrain.height(x, z);
    add("gem", "#54437a", x, y + h / 2, z, 2, h, 2);
    const cover = last();
    terrain.addObstacle({ x, z, r: 2 });
    add("gem", "#ba80ef", x, y + h + 2, z, 0.7, 1.8, 0.7, 2, rng(0, 6));
    records.spires.push({ x, z, y, h, cover, gemCover: last(), gem: slot() });
    if (i % 3 === 0) add("box", "#35294e", x, y + h + 5, z, 5, 0.8, 4, 0, rng(0, 3));
  }
}

const STAGE_PROPS = [meadowProps, quarryProps, calderaProps, citadelProps, voidProps];

// Up to three set pieces per stage: broken colonnades (S1, S4), quarry stacks (S2) or
// shrines (S3, S5). Each reserves its full assembly with a 5.5 m placement radius.
function setPieces({ terrain, palette, add, allowed, block, structureSites }) {
  const { stage } = terrain,
    { high, trail } = palette,
    color = stage === 1 ? "#a5aba0" : high;
  let placed = 0;
  for (const [x, z] of structureSites()) {
    if (!allowed(x, z, 5.5)) continue;
    const y = terrain.height(x, z);
    if (stage === 1 || stage === 4) {
      for (const side of [-1, 1]) {
        const h = side < 0 ? 2.8 : 4.4,
          px = x + side * 2.8;
        block(px, z, 1.3, 1.3, h + y - terrain.height(px, z), color);
        add("box", trail, px, y + h + 0.15, z, 1.8, 0.3, 1.8);
      }
      add("box", color, x, y + 0.45, z + 2.3, 3, 0.9, 1.2);
      terrain.addObstacle({ x, z: z + 2.3, sx: 3, sz: 1.2 });
    } else if (stage === 2) {
      block(x - 2, z, 2.2, 2.2, 1.5, color);
      block(x + 1, z, 2.2, 2.2, 3.2, color);
      add("box", trail, x + 1, y + 3.4, z, 2.3, 0.3, 2.3);
    } else {
      block(x, z, 2.3, 2.3, 1.1, color);
      for (const side of [-1, 1]) add("gem", trail, x + side * 0.5, y + 2, z, 0.45, 2, 0.45, 0, side * 0.5);
      add("box", high, x, y + 3.9, z, 3.5, 0.5, 2.4, 0, 0.4);
    }
    if (++placed === 3) break;
  }
}

// Non-solid leaf clumps everywhere, plus charred trees (S3) and crystal sprouts (S5).
function groundPlants({ terrain, rng, palette, add, allowed }) {
  const { stage } = terrain,
    { low, high, trail } = palette;
  for (let i = 0; i < 105; i++) {
    const x = rng(-62, 62),
      z = rng(-62, 62);
    if (!allowed(x, z, 1.2)) continue;
    const y = terrain.height(x, z);
    if (stage === 3 && i % 7 === 0) {
      add("cylinder", low, x, y + 1.8, z, 0.22, 3.6, 0.22);
      add("box", low, x, y + 2.8, z, 2, 0.45, 0.35, 0, i);
      terrain.addObstacle({ x, z, r: 0.4 });
    } else if (stage === 5 && i % 4 === 0) {
      add("cylinder", high, x, y + 0.5, z, 0.12, 1, 0.12);
      add("ico", trail, x, y + 1.1, z, 0.8, 0.3, 0.8);
    } else
      for (let j = 0; j < 3; j++)
        add(
          stage === 2 ? "ico" : "gem",
          i % 2 ? low : high,
          x + Math.sin(j * 2.1) * 0.3,
          y + 0.13,
          z + Math.cos(j * 2.1) * 0.3,
          0.45,
          0.25,
          0.28,
          0,
          j + i,
        );
  }
}

// 24 horizon shapes beyond the arena, inside the fog band: hills, volcanoes, fortress
// blocks or hovering crystals.
function silhouettes({ terrain, rng, palette, add }) {
  const { stage } = terrain,
    shape = stage === 4 ? "box" : stage === 5 ? "gem" : stage === 3 ? "cone" : "ico";
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12,
      r = rng(86, 113),
      h = rng(14, 34);
    add(shape, palette.low, Math.cos(a) * r, stage === 5 ? 8 : -3, Math.sin(a) * r, rng(7, 15), h, rng(7, 15), 0, a);
  }
}

// Low marker stones trace both edges of every authored path (glowing on S5).
function routeMarkers({ terrain, palette, add }) {
  const glow = terrain.stage === 5 ? 0.5 : 0;
  for (const [a, b] of terrain.routes) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      nx = -(b[1] - a[1]) / length,
      nz = (b[0] - a[0]) / length;
    for (let d = 4; d < length; d += 5) {
      const t = d / length,
        x = lerp(a[0], b[0], t),
        z = lerp(a[1], b[1], t);
      for (const side of [-1, 1]) {
        const px = x + nx * 3 * side,
          pz = z + nz * 3 * side;
        add("box", palette.trail, px, terrain.height(px, pz) + 0.07, pz, 0.28, 0.14, 0.28, glow);
      }
    }
  }
}

// Play-boundary cue: a rubble line with standing stones just beyond the walkable radius.
// Drawn after every original prop so seeded layouts are untouched; visual only.
function boundaryRing({ terrain, rng, palette, decorate }) {
  const radius = terrain.playRadius + 1.2,
    rock = ROCK_COLORS[terrain.tutorial ? 0 : terrain.stage - 1],
    count = Math.round((TAU * radius) / 1.7);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rng(-0.02, 0.02),
      r = radius + rng(-0.35, 0.5),
      x = Math.cos(a) * r,
      z = Math.sin(a) * r,
      y = terrain.height(x, z),
      s = rng(0.45, 1);
    if (i % 8 === 0) {
      const h = rng(1.3, 2.2);
      decorate("box", palette.high, x, y + h / 2 - 0.1, z, 0.6, h, 0.6, 0, a);
      decorate("box", palette.trail, x, y + h, z, 0.8, 0.22, 0.8, 0, a);
    } else decorate("ico", rock, x, y + 0.12 * s, z, 1.1 * s, s * rng(0.5, 0.85), s, 0, rng(0, TAU));
  }
}

// GROUND — the exact collision surface as one mesh: flat top faces and cliff faces as two
// material groups, plus a thin lip along every upper cliff rim.
function createGround(terrain, { low, high, trail }, jitter) {
  const heights = terrain.heights,
    cLow = new THREE.Color(low),
    cHigh = new THREE.Color(high),
    cTrail = new THREE.Color(trail),
    edge = terrain.playRadius;
  const vertexCount = STRIDE * STRIDE,
    colors = new Float32Array(vertexCount * 3);
  for (let iz = 0; iz <= CELLS; iz++)
    for (let ix = 0; ix <= CELLS; ix++) {
      const i = iz * STRIDE + ix,
        x = ix - EXTENT,
        z = iz - EXTENT,
        y = heights[i],
        mix = clamp((y + 3) / 14, 0, 1),
        path = terrain.routeDistance(x, z) < 2.8,
        // Out-of-bounds ground dims so the edge of the arena reads at a glance.
        shade = jitter[i] * (1 - 0.38 * smoothstep(edge, edge + 6, Math.hypot(x, z)));
      for (let k = 0; k < 3; k++) {
        const channel = k === 0 ? "r" : k === 1 ? "g" : "b";
        let c = lerp(cLow[channel], cHigh[channel], mix);
        if (path) c = lerp(c, cTrail[channel], 0.72);
        colors[i * 3 + k] = lerp(c, 1, 0.62) * shade;
      }
    }

  const flats = [],
    cliffs = [],
    lips = [],
    // Undirected triangle edges: horizontal, vertical and diagonal families.
    edgeSteep = new Int8Array(STRIDE * CELLS * 3).fill(-1),
    edgeInside = new Int32Array(STRIDE * CELLS * 3);
  const H = 0,
    V = STRIDE * CELLS,
    D = 2 * STRIDE * CELLS;
  const px = (i) => (i % STRIDE) - EXTENT,
    pz = (i) => Math.floor(i / STRIDE) - EXTENT;

  function lip(a, b, inside) {
    const ax = px(a),
      az = pz(a),
      dx = px(b) - ax,
      dz = pz(b) - az,
      length = Math.hypot(dx, dz);
    let nx = -dz / length,
      nz = dx / length;
    if (nx * (px(inside) - ax) + nz * (pz(inside) - az) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const xs = [ax, ax + dx, ax + nx * 0.18, ax + dx + nx * 0.18],
      zs = [az, az + dz, az + nz * 0.18, az + dz + nz * 0.18];
    // Shared edges arrive in either direction; keep every ribbon facing up.
    const order = dx * nz - dz * nx > 0 ? LIP_UP_A : LIP_UP_B;
    for (const k of order) lips.push(xs[k], terrain.height(xs[k], zs[k]) + 0.035, zs[k]);
  }
  function visitEdge(id, a, b, inside, steep) {
    const seen = edgeSteep[id];
    if (seen < 0) {
      edgeSteep[id] = steep ? 1 : 0;
      edgeInside[id] = inside;
      return;
    }
    if (seen === (steep ? 1 : 0)) return;
    const highPoint = steep ? edgeInside[id] : inside,
      lowPoint = steep ? inside : edgeInside[id];
    // Only upper rims get a lip; cliff feet must not masquerade as ramps.
    if (heights[highPoint] > heights[lowPoint] + 0.12) lip(a, b, highPoint);
  }
  function triangle(a, b, c) {
    const x1 = px(a),
      z1 = pz(a),
      y1 = heights[a],
      det = (px(b) - x1) * (pz(c) - z1) - (px(c) - x1) * (pz(b) - z1),
      gx = ((heights[b] - y1) * (pz(c) - z1) - (heights[c] - y1) * (pz(b) - z1)) / det,
      gz = ((px(b) - x1) * (heights[c] - y1) - (px(c) - x1) * (heights[b] - y1)) / det,
      steep = Math.hypot(gx, gz) > MAX_WALK_SLOPE;
    if (steep) cliffs.push(a, b, c, Math.abs(gx) >= Math.abs(gz) ? 1 : 0);
    else flats.push(a, b, c);
    return steep;
  }
  for (let iz = 0; iz < CELLS; iz++)
    for (let ix = 0; ix < CELLS; ix++) {
      const a = iz * STRIDE + ix,
        b = a + 1,
        c = a + STRIDE,
        d = c + 1,
        diagonal = D + iz * CELLS + ix;
      const lower = triangle(a, c, b);
      visitEdge(V + iz * STRIDE + ix, a, c, b, lower);
      visitEdge(diagonal, c, b, a, lower);
      visitEdge(H + iz * CELLS + ix, b, a, c, lower);
      const upper = triangle(b, c, d);
      visitEdge(diagonal, b, c, d, upper);
      visitEdge(H + (iz + 1) * CELLS + ix, c, d, b, upper);
      visitEdge(V + iz * STRIDE + ix + 1, d, b, c, upper);
    }

  // Cliff faces get their own vertices so each face can pick its texture projection:
  // u runs along the face's horizontal extent (x or z), v up the wall. No smeared stripes.
  const cliffCount = cliffs.length / 4,
    total = vertexCount + cliffCount * 3,
    positions = new Float32Array(total * 3),
    uvs = new Float32Array(total * 2),
    allColors = new Float32Array(total * 3),
    index = total > 65535 ? new Uint32Array(flats.length + cliffCount * 3) : new Uint16Array(flats.length + cliffCount * 3);
  allColors.set(colors);
  for (let i = 0; i < vertexCount; i++) {
    const x = px(i),
      z = pz(i);
    positions[i * 3] = x;
    positions[i * 3 + 1] = heights[i];
    positions[i * 3 + 2] = z;
    uvs[i * 2] = x / 6;
    uvs[i * 2 + 1] = z / 6;
  }
  index.set(flats);
  for (let t = 0, v = vertexCount, n = flats.length; t < cliffCount; t++) {
    const alongZ = cliffs[t * 4 + 3] === 1;
    for (let k = 0; k < 3; k++, v++) {
      const src = cliffs[t * 4 + k];
      positions[v * 3] = positions[src * 3];
      positions[v * 3 + 1] = positions[src * 3 + 1];
      positions[v * 3 + 2] = positions[src * 3 + 2];
      allColors[v * 3] = colors[src * 3];
      allColors[v * 3 + 1] = colors[src * 3 + 1];
      allColors[v * 3 + 2] = colors[src * 3 + 2];
      uvs[v * 2] = (alongZ ? pz(src) : px(src)) / 4;
      uvs[v * 2 + 1] = heights[src] / 3;
      index[n++] = v;
    }
  }
  // Baked ambient occlusion (enhanced lighting): a vertex darkens with the rise of the ground
  // around it, so cliff feet, gullies and wall corners sit in soft shade. Computed once here.
  const occlusion = new Float32Array(total);
  for (let i = 0; i < vertexCount; i++) {
    const ix = i % STRIDE,
      iz = (i - ix) / STRIDE;
    let rise = 0;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = ix + dx,
          z = iz + dz;
        if ((dx || dz) && x >= 0 && z >= 0 && x < STRIDE && z < STRIDE)
          rise += Math.max(0, heights[z * STRIDE + x] - heights[i]) / (Math.abs(dx) + Math.abs(dz));
      }
    occlusion[i] = Math.min(0.5, rise * 0.045);
  }
  for (let t = 0, v = vertexCount; t < cliffCount; t++) for (let k = 0; k < 3; k++, v++) occlusion[v] = occlusion[cliffs[t * 4 + k]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(allColors, 3));
  geometry.setAttribute("retroAO", new THREE.BufferAttribute(occlusion, 1));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.addGroup(0, flats.length, 0);
  geometry.addGroup(flats.length, cliffCount * 3, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const { stage, tutorial } = terrain,
    top = retroMaterial("#d0cab4", topTile(stage, tutorial), { vertexColors: true, occlusion: true, ao: true }),
    rock = retroMaterial(ROCK_COLORS[tutorial ? 0 : stage - 1], rockTile(tutorial ? 1 : stage), {
      vertexColors: true,
      occlusion: true,
      ao: true,
    }),
    surface = new THREE.Mesh(geometry, [top, rock]);
  surface.name = "terrain-surface";

  const lipGeometry = new THREE.BufferGeometry();
  lipGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lips), 3));
  lipGeometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((lips.length / 3) * 2), 2));
  lipGeometry.computeVertexNormals();
  const ledge = new THREE.Mesh(lipGeometry, retroMaterial(trail, TILE.cobble, { occlusion: true }));
  ledge.name = "terrain-upper-edges";
  ledge.visible = lips.length > 0;

  return {
    surface,
    ledge,
    drawCalls: (flats.length ? 1 : 0) + (cliffCount ? 1 : 0) + (lips.length ? 1 : 0),
    dispose() {
      geometry.dispose();
      lipGeometry.dispose();
    },
  };
}
const LIP_UP_A = [0, 2, 1, 1, 2, 3];
const LIP_UP_B = [0, 1, 2, 1, 3, 2];
