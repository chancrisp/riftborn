// Hazard and world prop models (IMPROVEMENTS F2, F8, F10). A stage's hazard props of one kind
// share geometry and draw as one InstancedMesh per part (§1.4: at most 4 draws), posed and
// tinted per prop: marsh pods on moss, blasting charges, and the live beacon's gem, roof ring
// and runes (falling crystals stay in the Void spire batch). The shrine bell and the relic
// cache are single objects. Everything is built from the shared unit primitives and the atlas.
import * as THREE from "three";
import { retroMaterial, unlitMaterial, TILE } from "./materials.js";
import { sceneryShapes } from "../world/scenery.js";

const WHITE = new THREE.Color("#ffffff");
const FLASH_MIX = 0.7; // the white crack flash of a hit prop

export const PROP_COLORS = Object.freeze({
  pod: "#9fbf7a",
  moss: "#4f6b3e",
  crate: "#8a3a2a",
  stripe: "#c7a66d",
  fuse: "#3a3a3a",
  beaconGem: "#aef4ff",
  rune: "#83e7ff",
  runeSpent: "#2a4050",
  bell: "#9a7a3e",
  bellWood: "#5b4632",
  clapper: "#6a6a70",
  clapperAwake: "#e8e2a0",
  cacheBox: "#d9d2b0",
  cacheGem: "#d4bc78",
});

let torus = null;
const ringGeometry = () => (torus ??= new THREE.TorusGeometry(1, 0.12 / 1.4, 4, 16));

// Part layouts relative to a site's ground point and yaw: [x, y, z, sx, sy, sz] (+ yaw).
function marshParts(site) {
  return {
    pods: site.pods.map((p) => [p.dx, p.r * 0.8, p.dz, p.r, p.r, p.r]),
    moss: [[0, 0.03, 0, 0.9, 0.06, 0.9]],
  };
}
const CHARGE_PARTS = Object.freeze({
  crate: [[0, 0.4, 0, 1.0, 0.8, 0.7]],
  stripe: [[0, 0.45, 0, 1.03, 0.12, 0.73]],
  fuse: [[0.3, 0.92, 0, 0.05, 0.25, 0.05]],
});
// A beacon tower of height h: the brighter gem, the roof ring and four runes, one per face at
// 1.6 m (the tower is 3.5 m square).
function beaconParts(site) {
  const h = site.tower.h,
    face = 1.75 + 0.03;
  return {
    gem: [[0, h + 1.6, 0, 0.4, 1.1, 0.4]],
    ring: [[0, h + 0.45, 0, 1.4, 1.4, 1.4, 0, Math.PI / 2]],
    runes: [
      [0, 1.6, face, 1.0, 1.0, 0.06],
      [0, 1.6, -face, 1.0, 1.0, 0.06],
      [face, 1.6, 0, 0.06, 1.0, 1.0],
      [-face, 1.6, 0, 0.06, 1.0, 1.0],
    ],
  };
}

// part name -> { shape, color, tile (lit) or unlit, scaled: follows the prop's swell/regrow scale }
const KIND_PARTS = Object.freeze({
  marsh: {
    layout: marshParts,
    parts: {
      pods: { shape: "ico", color: PROP_COLORS.pod, tile: TILE.skin, scaled: true },
      moss: { shape: "cylinder", color: PROP_COLORS.moss, tile: TILE.grass },
    },
  },
  charge: {
    layout: () => CHARGE_PARTS,
    parts: {
      crate: { shape: "box", color: PROP_COLORS.crate, tile: TILE.rust, scaled: true },
      stripe: { shape: "box", color: PROP_COLORS.stripe, tile: TILE.rust, scaled: true },
      fuse: { shape: "cylinder", color: PROP_COLORS.fuse, tile: TILE.metal, scaled: true },
    },
  },
  beacon: {
    layout: beaconParts,
    parts: {
      gem: { shape: "gem", color: PROP_COLORS.beaconGem, unlit: true },
      ring: { shape: "ring", color: PROP_COLORS.rune, unlit: true },
      runes: { shape: "box", color: PROP_COLORS.rune, dim: PROP_COLORS.runeSpent, unlit: true, flashes: true },
    },
  },
});

const pose = new THREE.Object3D();
const color = new THREE.Color();

// The props of one kind on a stage: createPropBatch(kind, sites) -> { group, set(i, look),
// dispose() } or null for a kind drawn by the scenery (crystal). set(i, { scale, dim, flash })
// re-poses prop i: `scale` (0 hides) grows its body about each part's own centre, `dim` swaps
// in the spent colour, `flash` (0..1) mixes toward white.
export function createPropBatch(kind, sites) {
  const spec = KIND_PARTS[kind];
  if (!spec || !sites.length) return null;
  const { geometries } = sceneryShapes(),
    group = new THREE.Group(),
    layouts = sites.map((site) => spec.layout(site)),
    parts = [];
  group.name = `hazard-${kind}`;
  for (const [name, part] of Object.entries(spec.parts)) {
    const perSite = layouts[0][name].length,
      geometry = part.shape === "ring" ? ringGeometry() : geometries[part.shape],
      material = part.unlit ? unlitMaterial("#ffffff") : retroMaterial("#ffffff", part.tile, { occlusion: true }),
      mesh = new THREE.InstancedMesh(geometry, material, perSite * sites.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(perSite * sites.length * 3), 3);
    // Lit parts carry retroMaterial's 35 % wash in the instance colour (the material is white).
    const base = new THREE.Color(part.color),
      dim = new THREE.Color(part.dim ?? part.color);
    if (!part.unlit) {
      base.lerp(WHITE, 0.35);
      dim.lerp(WHITE, 0.35);
    }
    group.add(mesh);
    parts.push({ name, part, mesh, perSite, base, dim });
  }

  function set(i, { scale = 1, dim = false, flash = 0 } = {}) {
    const site = sites[i],
      layout = layouts[i],
      c = Math.cos(site.yaw),
      s = Math.sin(site.yaw);
    for (const { name, part, mesh, perSite, base, dim: spent } of parts) {
      // Scaled parts are the prop's body (they swell, regrow and vanish); the rest stays put.
      const k = part.scaled ? scale : 1;
      color.copy(dim ? spent : base);
      if (flash > 0 && (part.scaled || part.flashes)) color.lerp(WHITE, FLASH_MIX * flash);
      for (let j = 0; j < perSite; j++) {
        const [x, y, z, sx, sy, sz, yaw = 0, roll = 0] = layout[name][j];
        pose.position.set(site.x + x * c + z * s, site.y + y * k, site.z - x * s + z * c);
        pose.rotation.set(roll, site.yaw + yaw, 0);
        pose.scale.set(sx * k, sy * k, sz * k);
        pose.updateMatrix();
        mesh.setMatrixAt(i * perSite + j, pose.matrix);
        mesh.setColorAt(i * perSite + j, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  for (let i = 0; i < sites.length; i++) set(i);
  for (const { mesh } of parts) mesh.computeBoundingSphere();
  return {
    group,
    set,
    dispose() {
      group.removeFromParent();
      for (const { mesh } of parts) mesh.dispose();
    },
  };
}

// The shrine bell (F2): two posts, a crossbar and a bronze bell with its clapper, hung from a
// pivot so it can swing. The clapper tip has its own material: it glows once the bell wakes.
export function createShrineBellModel() {
  const { geometries } = sceneryShapes(),
    g = new THREE.Group(),
    pivot = new THREE.Group(),
    wood = retroMaterial(PROP_COLORS.bellWood, TILE.bark),
    tipMaterial = unlitMaterial(PROP_COLORS.clapper, { shared: false }),
    mesh = (geometry, material, x, y, z, sx, sy, sz, parent = g) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      parent.add(m);
      return m;
    };
  g.name = "shrine-bell";
  for (const side of [-1, 1]) mesh(geometries.cylinder, wood, side * 0.75, 1.3, 0, 0.09, 2.6, 0.09);
  mesh(geometries.box, wood, 0, 2.55, 0, 1.8, 0.14, 0.16);
  pivot.position.y = 2.48;
  g.add(pivot);
  // An 8-sided cylinder tapering from r 0.35 at the lip to r 0.2 at the crown.
  const bell = new THREE.Mesh(bellGeometry(), retroMaterial(PROP_COLORS.bell, TILE.rust));
  bell.position.y = -0.3;
  pivot.add(bell);
  mesh(geometries.ico, retroMaterial(PROP_COLORS.clapper, TILE.metal), 0, -0.55, 0, 0.07, 0.07, 0.07, pivot);
  mesh(geometries.ico, tipMaterial, 0, -0.64, 0, 0.06, 0.06, 0.06, pivot);
  return { g, pivot, tipMaterial };
}
let bellShape = null;
const bellGeometry = () => (bellShape ??= new THREE.CylinderGeometry(0.2, 0.35, 0.5, 8));

// The Relic Cache pickup (F8): a bone box over an unlit gold octahedron. The caller bobs `gem`.
export function createCacheModel() {
  const { geometries } = sceneryShapes(),
    g = new THREE.Group(),
    box = new THREE.Mesh(geometries.box, retroMaterial(PROP_COLORS.cacheBox, TILE.bone)),
    gem = new THREE.Mesh(geometries.gem, unlitMaterial(PROP_COLORS.cacheGem));
  g.name = "relic-cache";
  box.scale.setScalar(0.5);
  box.position.y = 0.25;
  gem.scale.set(0.28, 0.4, 0.28);
  gem.position.y = 0.95;
  g.add(box, gem);
  return { g, box, gem };
}
