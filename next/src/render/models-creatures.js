// KEEPERS creature models (IMPROVEMENTS F7): the Drowned, the Ashworm and the Lamplighter,
// registered with registerMonsterModel (main.js imports this module for its side effects, and
// enemies.js for the pose helpers below). The Drowned and the Lamplighter wear the shared
// monster body; the Ashworm is a segmented arch with its own pose. Every builder fills
// parts.eyes, head, torusSlot and sigilSlot (F1.7) and ends with mergeStatic.
//
// Also here: the Lamplighter's lantern-light cages, drawn for every caged monster at once with
// two instanced meshes (bars and ground ring), so wards never multiply draw calls.
import * as THREE from "three";
import { registerMonsterModel } from "./models.js";
import { TILE, mergeStatic, unlitMaterial } from "./materials.js";

const FPS = 15;
const stepped = (t) => Math.floor(t * FPS) / FPS;
const HALF_PI = Math.PI / 2;

// Palettes as named lint roles (F1.7); `signal` roles glow unlit and are exempt from the
// scenery swatches.
const DROWNED = Object.freeze({ hide: "#78776c", bone: "#ffe6c6", belly: "#a4b236", weed: "#2a3420", signal: Object.freeze({ eyes: "#cfe3d6" }) });
const ASHWORM = Object.freeze({ flesh: "#baa495", plate: "#100904", bone: "#d9d2b0", mound: "#4a3a36", signal: Object.freeze({ seams: "#ffb05c" }) });
const LAMPLIGHTER = Object.freeze({
  hide: "#4a4038",
  robe: "#5a4a3a",
  hat: "#2e261e",
  pole: "#3a2e24",
  bone: "#d9d2b0",
  frame: "#1e1a16",
  signal: Object.freeze({ lantern: "#9fe8ff", eyes: "#9fe8ff" }),
});
const JAW = "#271d22"; // the shared body's jaw colour

// Geometry the shared kit lacks, built once.
const ROBE = new THREE.ConeGeometry(1, 1, 7);
const HAT = new THREE.ConeGeometry(1, 1, 6);

// ---- shared helpers ---------------------------------------------------------------------------

// The Model record of models.js (ARCHITECTURE §5.5), for a body built from scratch (the Ashworm
// has no limbs, so it never goes through animateCharacter).
function blankModel(kind) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.name = kind;
  g.add(body);
  const gunMount = new THREE.Group();
  gunMount.visible = false;
  body.add(gunMount);
  return {
    g,
    body,
    legs: [],
    arms: [],
    appendages: [],
    gunMount,
    weapon: null,
    kind,
    crawler: false,
    floating: false,
    armPose: 0,
    monster: true,
    fixed: false,
    parts: [],
    lean: 0,
    flashLevel: 0,
    tint: null,
    tintStep: 0,
    fallSide: 0,
  };
}

function anchor(parent, x, y, z) {
  const node = new THREE.Object3D();
  node.position.set(x, y, z);
  parent.add(node);
  return node;
}

// The F1.7 slots: the head anchor, the ring slot at the feet and the sigil slot overhead.
function slots(model, head, feet, top, parent = model.g) {
  model.parts.head = head;
  model.parts.torusSlot = anchor(parent, 0, feet, 0);
  model.parts.sigilSlot = anchor(parent, 0, top, 0);
}

// Swaps the shared body's lit eyes for unlit signal eyes of `color` (same boxes, same places),
// or drops them when `keep` is false; returns the new eye list.
function signalEyes(kit, model, color, keep = true) {
  const eyes = [];
  for (const old of model.parts.eyes ?? []) {
    if (keep) {
      const { x, y, z } = old.position;
      eyes.push(kit.part(model, "box", kit.palette(color, 0, true), x, y, z, old.scale.x, old.scale.y, old.scale.z, old.parent));
    }
    old.removeFromParent();
    const i = model.parts.indexOf(old);
    if (i >= 0) model.parts.splice(i, 1);
  }
  model.parts.eyes = eyes;
  return eyes;
}

// A swaying appendage: a group at (x, y, z) holding one part that hangs from it.
function strand(kit, model, record, x, y, z, sx, sy, sz) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  model.body.add(group);
  model.appendages.push(group);
  kit.part(model, "box", record, 0, -sy / 2, 0, sx, sy, sz, group);
  return group;
}

// ---- the Drowned ------------------------------------------------------------------------------

// The runner layout on the fat body: slouched, one long arm, a gas-bloated belly, a slack jaw
// and river weed hanging from the shoulders and head.
function buildDrowned(kit) {
  const model = kit.base("drowned", { hide: DROWNED.hide, bone: DROWNED.bone, eye: DROWNED.signal.eyes }, { fat: true });
  model.g.scale.set(1.1, 1, 1.1);
  model.body.rotation.z = model.lean = 0.08;
  model.arms[0].scale.y = 1.2;
  signalEyes(kit, model, DROWNED.signal.eyes);
  model.parts.belly = kit.part(model, "flesh", kit.palette(DROWNED.belly, TILE.skin), 0, 1.2, 0.25, 0.55, 0.5, 0.45);
  // A second jaw plate below the first: the mouth hangs 1.6 times as deep.
  kit.part(model, "box", kit.palette(JAW, TILE.skin), 0, 1.71, 0.39, 0.33, 0.1, 0.085);
  const weed = kit.palette(DROWNED.weed, TILE.leaves);
  for (const [x, y, z] of [
    [-0.46, 1.8, 0.02],
    [0.46, 1.8, 0.02],
    [-0.12, 2.22, 0.1],
    [0.1, 2.24, 0.02],
    [0, 2.2, -0.14],
  ])
    strand(kit, model, weed, x, y, z, 0.06, 0.45, 0.03);
  slots(model, anchor(model.body, 0, 1.96, 0.14), 0.02, 2.6);
  return mergeStatic(model);
}

// Swell progress 0..1 grows the belly 1 -> 1.4 in held 15 fps poses.
export function swellBelly(model, progress) {
  const belly = model?.parts?.belly;
  if (!belly) return;
  const k = 1 + 0.4 * (Math.floor(Math.min(1, Math.max(0, progress)) * 6) / 6);
  belly.scale.set(0.55 * k, 0.5 * k, 0.45 * k);
}

// ---- the Ashworm ------------------------------------------------------------------------------

const SEGMENTS = Object.freeze([0.55, 0.5, 0.45, 0.38, 0.3]); // head first
const ARCH_DEPTH = 2.6; // a burrowed arch sits this far below ground
const RISE_POSES = 6;

// Five pale segments, each with a dark crusted back plate and an ember seam; three bone
// mandibles (their tips are the "eyes" threat eyes recolour) and a ring of teeth on the head.
// A flat rock mound stands in for the whole body while it is burrowed.
function buildAshworm(kit) {
  const model = blankModel("ashworm");
  const flesh = kit.palette(ASHWORM.flesh, TILE.skin),
    plate = kit.palette(ASHWORM.plate, TILE.rock),
    seam = kit.palette(ASHWORM.signal.seams, 0, true),
    bone = kit.palette(ASHWORM.bone, TILE.bone);
  const segments = [];
  SEGMENTS.forEach((r) => {
    const seg = new THREE.Group();
    model.body.add(seg);
    segments.push(seg);
    kit.part(model, "flesh", flesh, 0, 0, 0, r, r * 0.95, r, seg);
    kit.part(model, "box", plate, 0, r * 0.1, -r * 0.62, r * 1.25, r * 1.1, r * 0.3, seg);
    kit.part(model, "box", seam, 0, r * 0.68, -r * 0.62, r * 1.27, 0.12, r * 0.32, seg);
  });
  const head = segments[0],
    r = SEGMENTS[0],
    eyes = [];
  for (let k = 0; k < 3; k++) {
    const jaw = new THREE.Group();
    jaw.rotation.z = (k * 2 * Math.PI) / 3;
    head.add(jaw);
    const spike = kit.spike(model, ASHWORM.bone, 0, 0.2, r * 0.9, 0.1, 0.55, 0, jaw);
    spike.rotation.x = HALF_PI - 0.4;
    // The apex of the spike: 0.275 along its tilted axis.
    eyes.push(kit.part(model, "box", bone, 0, 0.2 + 0.275 * Math.cos(HALF_PI - 0.4), r * 0.9 + 0.275 * Math.sin(HALF_PI - 0.4), 0.05, 0.05, 0.05, jaw));
  }
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    const tooth = kit.spike(model, ASHWORM.bone, Math.sin(a) * 0.14, Math.cos(a) * 0.14, r * 0.86, 0.035, 0.1, 0, head);
    tooth.rotation.x = HALF_PI;
  }
  model.parts.eyes = eyes;
  model.parts.segments = segments;
  model.parts.mound = kit.part(model, "flesh", kit.palette(ASHWORM.mound, TILE.rock), 0, 0.05, 0, 0.8, 0.25, 0.8, model.g);
  // Ring and sigil ride the arch, so they sink with it while it is burrowed.
  slots(model, head, 0.05, 3.1, model.body);
  return mergeStatic(model);
}

// Arch pose. `rise` 0..1 lifts the arch out of the ground in held poses (0 = burrowed: only
// the mound shows); the segments sway at 15 fps and lean toward the model's facing.
export function poseAshworm(model, time, rise) {
  const segments = model?.parts?.segments;
  if (!segments) return;
  const k = Math.floor(Math.min(1, Math.max(0, rise)) * RISE_POSES) / RISE_POSES,
    t = stepped(time);
  model.body.visible = k > 0;
  if (model.parts.mound) model.parts.mound.visible = k < 1;
  model.body.position.y = -ARCH_DEPTH * (1 - k);
  const last = segments.length - 1;
  for (let i = 0; i <= last; i++) {
    const s = 1 - i / last, // 1 at the head, 0 at the tail
      seg = segments[i];
    seg.position.set(Math.sin(t * 6 + i) * 0.2, 0.3 + 1.8 * Math.sin(s * HALF_PI), -0.4 + 1.1 * s * s);
    seg.rotation.x = s * 0.9;
  }
}

// ---- the Lamplighter --------------------------------------------------------------------------

// A tall, thin walker carrying a light: a robe over the legs, a tall hat whose brim hides the
// face (two dot eyes glint under it), and a pole over the shoulder with a hanging lantern.
function buildLamplighter(kit) {
  const model = kit.base("lamplighter", { hide: LAMPLIGHTER.hide, bone: LAMPLIGHTER.bone, eye: LAMPLIGHTER.signal.eyes }, {});
  model.g.scale.set(0.85, 1.25, 0.85);
  signalEyes(kit, model, LAMPLIGHTER.signal.eyes, false);
  const robe = kit.palette(LAMPLIGHTER.robe, TILE.cloth),
    hat = kit.palette(LAMPLIGHTER.hat, TILE.leather),
    frame = kit.palette(LAMPLIGHTER.frame, TILE.metal),
    glow = kit.palette(LAMPLIGHTER.signal.lantern, 0, true);
  kit.part(model, ROBE, robe, 0, 0.82, 0, 0.52, 1.2, 0.46);
  kit.part(model, "box", hat, 0, 2.13, 0.02, 0.8, 0.05, 0.8);
  kit.part(model, HAT, hat, 0, 2.55, 0.02, 0.35, 0.8, 0.35);
  const dot = kit.palette(LAMPLIGHTER.signal.eyes, 0, true);
  model.parts.eyes = [-1, 1].map((side) => kit.part(model, "box", dot, side * 0.09, 2.03, 0.43, 0.045, 0.035, 0.02));
  // The pole leans out over the right shoulder; the lantern hangs plumb from its tip.
  const mount = new THREE.Group();
  mount.position.set(-0.45, 1.75, -0.02);
  mount.rotation.z = 0.6;
  model.body.add(mount);
  kit.part(model, "limb", kit.palette(LAMPLIGHTER.pole, TILE.bark), 0, 0.6, 0, 0.07, 2.2, 0.07, mount);
  const lantern = new THREE.Group();
  lantern.position.set(0, 1.7, 0);
  lantern.rotation.z = -0.6;
  mount.add(lantern);
  kit.part(model, "box", frame, 0, -0.14, 0, 0.3, 0.05, 0.3, lantern);
  kit.part(model, "box", frame, 0, -0.44, 0, 0.3, 0.05, 0.3, lantern);
  for (const [x, z] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ])
    kit.part(model, "box", frame, x * 0.13, -0.29, z * 0.13, 0.035, 0.3, 0.035, lantern);
  model.parts.lantern = kit.part(model, "gem", glow, 0, -0.29, 0, 0.1, 0.12, 0.1, lantern);
  slots(model, anchor(model.body, 0, 1.96, 0.14), 0.02, 3.2);
  return mergeStatic(model);
}

// The lantern gem pulses 0.8..1.0 in 15 fps steps and flares x1.5 while a ward is channelled.
export function glowLantern(model, time, flare = false) {
  const gem = model?.parts?.lantern;
  if (!gem) return;
  const k = (0.9 + 0.1 * Math.sin(stepped(time) * 5)) * (flare ? 1.5 : 1);
  gem.scale.set(0.1 * k, 0.12 * k, 0.1 * k);
}

registerMonsterModel("drowned", (kit) => buildDrowned(kit), DROWNED);
registerMonsterModel("ashworm", (kit) => buildAshworm(kit), ASHWORM);
registerMonsterModel("lamplighter", (kit) => buildLamplighter(kit), LAMPLIGHTER);

// ---- lantern-light cages (the Lamplighter's ward) ---------------------------------------------

const CAGE_COLOR = "#9fe8ff";
const CAGE_BARS = 4;
const CAGE_RING = 12; // flat segments of the ground ring
const CAGE_BAR = Object.freeze({ width: 0.18, height: 2 });
const CAGE_LIFT = 0.06;
const CAGE_TURN = 1.5; // rad/s, held in 15 fps steps
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// Every caged monster in two draw calls. draw(list, height, strip, time) rewrites the instance
// matrices from list entries { x, z, radius } (bars at `radius`, a ring `strip` metres wide).
export function createCageField(capacity = 16) {
  const group = new THREE.Group();
  group.name = "cages";
  const bars = new THREE.InstancedMesh(UNIT_BOX, unlitMaterial(CAGE_COLOR), capacity * CAGE_BARS);
  const ring = new THREE.InstancedMesh(UNIT_BOX, unlitMaterial(CAGE_COLOR, { transparent: true, opacity: 0.6 }), capacity * CAGE_RING);
  for (const mesh of [bars, ring]) {
    mesh.count = 0;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  const matrix = new THREE.Matrix4(),
    position = new THREE.Vector3(),
    rotation = new THREE.Quaternion(),
    scale = new THREE.Vector3(),
    up = new THREE.Vector3(0, 1, 0);

  function draw(list, height, strip, time) {
    const n = Math.min(capacity, list.length),
      turn = stepped(time) * CAGE_TURN;
    for (let c = 0; c < n; c++) {
      const { x, z, radius } = list[c],
        y = height(x, z);
      for (let i = 0; i < CAGE_BARS; i++) {
        const a = turn + (i * 2 * Math.PI) / CAGE_BARS;
        position.set(x + Math.sin(a) * radius, y + CAGE_BAR.height / 2, z + Math.cos(a) * radius);
        rotation.setFromAxisAngle(up, a);
        scale.set(CAGE_BAR.width, CAGE_BAR.height, CAGE_BAR.width);
        bars.setMatrixAt(c * CAGE_BARS + i, matrix.compose(position, rotation, scale));
      }
      const chord = 2 * radius * Math.sin(Math.PI / CAGE_RING) * 1.08;
      for (let i = 0; i < CAGE_RING; i++) {
        const a = turn + ((i + 0.5) * 2 * Math.PI) / CAGE_RING;
        position.set(x + Math.sin(a) * radius, y + CAGE_LIFT, z + Math.cos(a) * radius);
        rotation.setFromAxisAngle(up, a);
        scale.set(chord, 0.02, strip);
        ring.setMatrixAt(c * CAGE_RING + i, matrix.compose(position, rotation, scale));
      }
    }
    bars.count = n * CAGE_BARS;
    ring.count = n * CAGE_RING;
    bars.instanceMatrix.needsUpdate = true;
    ring.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    draw,
    clear() {
      bars.count = ring.count = 0;
    },
  };
}
