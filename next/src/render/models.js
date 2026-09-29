// Character art: the hero, the carried guns, every monster and boss, the encounter
// objects, and the 15 fps stop-motion animation they share. Geometry is shared
// module-wide and materials come from the cached PS1 pipeline, so a model owns only
// its scene-graph nodes. Hit flash and tints are palette swaps: each part's material
// is exchanged for a cached variant and restored later; shared materials never change.
import * as THREE from "three";
import { retroMaterial, unlitMaterial, mergeStatic, scaleRange, hashedCopy, TILE } from "./materials.js";
import { WEAPONS } from "../data/weapons.js";
import { ENEMY_TYPES } from "../data/enemies.js";

// Unit primitives scaled per part. Stock 0..1 UVs put one whole atlas tile on each
// face whatever the part's size (the intended PS1 texel-density wobble).
const GEO = {
  torso: new THREE.CylinderGeometry(0.82, 0.6, 1, 6),
  heroLimb: new THREE.CylinderGeometry(0.7, 0.52, 1, 5),
  head: new THREE.SphereGeometry(1, 6, 4),
  plate: new THREE.PlaneGeometry(1, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  flesh: new THREE.IcosahedronGeometry(1, 0),
  limb: new THREE.CylinderGeometry(0.65, 0.4, 1, 5),
  claw: new THREE.ConeGeometry(1, 1, 4),
  tube: new THREE.CylinderGeometry(1, 1, 1, 8),
  gem: new THREE.OctahedronGeometry(1, 0),
};

// [hide, bone] per kind; unknown kinds wear the runner palette like the original.
const PALETTES = {
  runner: ["#75885a", "#b2b58c"],
  skitter: ["#67743b", "#cad094"],
  gunner: ["#78904a", "#c6bc78"],
  charger: ["#9c5146", "#c8b591"],
  brute: ["#756552", "#b3a682"],
  mortar: ["#697747", "#b8c37c"],
  sniper: ["#8a596f", "#c5aaa3"],
  leaper: ["#92663e", "#c4ac77"],
  splitter: ["#507c68", "#99bea0"],
  stormer: ["#55567d", "#b3abca"],
  warden: ["#705269", "#d0baa0"],
  revenant: ["#7e262d", "#d8aaa0"],
  hexer: ["#622944", "#d7a0b0"],
  broodmother: ["#552b32", "#b8836e"],
};
const CRAWLERS = new Set(["skitter", "leaper", "broodmother"]);
const FLOATERS = new Set(["stormer", "hexer"]);
const FAT = new Set(["brute", "mortar", "splitter", "broodmother"]);
const DEFAULT_ARM_POSE = -0.95;
const IRON_MAW_SCALE = 1.35; // on top of the charger's own group scale
const HERO = { cloth: "#9aaf9d", skin: "#d5c3ac" };

// Death Mode re-skin for the ordinary roster only (Death kinds and bosses keep their
// identity): the hide drifts toward dried blood and the eyes glow.
const DEATH_BLOOD = "#8e1a22";
const DEATH_HIDE_SHIFT = 0.22;
const DEATH_EYE = "#ff6247";

// Hit flash: 3 held palette steps toward white with an emissive kick (decays 3,2,1,0).
const FLASH_LEVELS = [null, { mix: 0.4, glow: 0.2 }, { mix: 0.7, glow: 0.4 }, { mix: 1, glow: 0.55 }];
const TINT_STEPS = 4;

// Elite and trial marks hang off every monster (IMPROVEMENTS F1.7): a ring slot at the feet and
// a sigil slot this far above the head's centre, both on the root so the body's bob, squash and
// collapse never move them.
const SIGIL_LIFT = 0.75;

// The shade look (F6): lit parts lerp halfway to bone and draw at 60 % alphaHash coverage;
// unlit eyes and signature parts keep full colour and coverage. Rise and fade step in 6.
const SHADE_COVERAGE = 0.6;
const DISSOLVE_STEPS = 6;
const SHADE_TINT = new THREE.Color("#d9d2b0").lerp(new THREE.Color("#ffffff"), 0.35); // bone, washed like a lit part

// Death collapse: 6 held poses, toppling backwards while sinking into the ground.
const COLLAPSE_POSES = 6;
const COLLAPSE_TILT = 0.85;
const COLLAPSE_LEAN = 0.3;
const COLLAPSE_SINK = 0.9;

const scratchA = new THREE.Color();
const scratchB = new THREE.Color();
const scratchTint = new THREE.Color();
const mixHex = (a, b, t) => "#" + scratchA.set(a).lerp(scratchB.set(b), t).getHexString();
// White-to-tint multiplier at strength k (k = 1 multiplies by the tint exactly).
const tintMultiplier = (tint, k) => scratchTint.set("#ffffff").lerp(scratchB.set(tint), k);

// Palette records: one per (colour, tile, glow, lit/unlit), shared by every part painted with
// it. Each holds the base material and lazily built flash/tint variants, so swaps never
// allocate after the first use of a variant. Merged meshes share the baked records of
// materials.js (same shape, plus the `options` their variants are built with).
const paints = new Map();
function paint(color, tile = TILE.skin, unlit = false, glow = 0) {
  const key = unlit ? "unlit" + color : `${color}:${tile}:${glow}`;
  let record = paints.get(key);
  if (!record) {
    const base = unlit ? unlitMaterial(color) : retroMaterial(color, tile, { glow });
    record = { color, tile, glow, unlit, base, options: null, flash: [], tints: new Map() };
    paints.set(key, record);
  }
  return record;
}

function flashVariant(record, level) {
  if (!record.flash[level]) {
    const { mix, glow } = FLASH_LEVELS[level];
    const color = mixHex(record.color, "#ffffff", mix);
    record.flash[level] = record.unlit
      ? unlitMaterial(color, record.options ?? {})
      : retroMaterial(color, record.tile, { ...record.options, glow: Math.max(glow, record.glow || 0) });
  }
  return record.flash[level];
}

function tintVariant(record, tint, step) {
  let row = record.tints.get(tint);
  if (!row) record.tints.set(tint, (row = []));
  if (!row[step]) row[step] = makeTint(record, tint, step / TINT_STEPS);
  return row[step];
}

function makeTint(record, tint, k) {
  const multiplier = tintMultiplier(tint, k);
  if (record.unlit) return unlitMaterial("#" + scratchA.set(record.color).multiply(multiplier).getHexString());
  // Multiply the final (already washed) diffuse, exactly like the original Warden enrage;
  // a retro material's PS1 patch lives on its class + userData, so a clone keeps it.
  const clone = record.base.clone();
  clone.color.multiply(multiplier);
  return clone;
}

// Non-enumerable: Object3D.clone JSON-copies userData, which must not drag materials along.
// Writable, so setEyes can repaint a part.
function hide(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
  return value;
}

function addPart(parts, parent, geometry, record, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(geometry, record.base);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  hide(mesh.userData, "paint", record);
  parent.add(mesh);
  parts?.push(mesh);
  return mesh;
}

// The eye boxes of a body: kept apart from the static merge (bucket) as one range each, so
// setEyes can recolour and scale them after mergeStatic folded them into one mesh.
function tagEye(mesh) {
  mesh.userData.bucket = "eyes";
  mesh.userData.part = "eye";
  return mesh;
}

function newModel(kind) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.name = kind;
  g.add(body);
  return {
    g,
    body,
    legs: [],
    arms: [],
    appendages: [],
    gunMount: null,
    weapon: null,
    kind,
    crawler: false,
    floating: false,
    armPose: DEFAULT_ARM_POSE,
    monster: true,
    fixed: false,
    parts: [],
    lean: 0, // rest body.rotation.z (the runner's slouch), restored by collapseModel
    flashLevel: 0,
    tint: null,
    tintStep: 0,
    fallSide: 0,
  };
}

function limbGroup(model, list, x, y, z) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  model.body.add(group);
  list.push(group);
  return group;
}

// The hero (the original retroCharacter("player")), carrying the rifle.
export function createHero() {
  const model = newModel("player");
  model.monster = false;
  model.armPose = 0;
  const part = (geo, color, tile, x, y, z, sx, sy, sz, parent = model.body) =>
    addPart(model.parts, parent, GEO[geo], paint(color, tile), x, y, z, sx, sy, sz);

  part("torso", HERO.cloth, TILE.cloth, 0, 1.47, 0, 0.52, 0.7, 0.36);
  part("torso", "#666959", TILE.leather, 0, 1.09, 0, 0.46, 0.22, 0.34);
  part("head", HERO.skin, TILE.skin, 0, 2.04, 0.015, 0.22, 0.28, 0.22);
  // The face is painted on a plate in front of the low-poly head, not modelled.
  part("plate", HERO.skin, TILE.face, 0, 2.025, 0.209, 0.32, 0.4, 1);
  part("head", HERO.cloth, TILE.leather, 0, 2.24, -0.02, 0.235, 0.12, 0.225);
  part("torso", HERO.skin, TILE.skin, 0, 1.81, 0, 0.15, 0.18, 0.15);
  for (const side of [-1, 1]) {
    const leg = limbGroup(model, model.legs, side * 0.18, 1.04, 0);
    part("heroLimb", "#777668", TILE.cloth, 0, -0.22, 0, 0.22, 0.48, 0.23, leg);
    part("heroLimb", "#666b61", TILE.cloth, 0, -0.64, 0.02, 0.18, 0.4, 0.19, leg);
    part("box", "#74736a", TILE.leather, 0, -0.93, 0.08, 0.22, 0.18, 0.38, leg);
    const arm = limbGroup(model, model.arms, side * 0.39, 1.73, 0);
    part("heroLimb", HERO.cloth, TILE.cloth, 0, -0.21, 0, 0.21, 0.43, 0.22, arm);
    part("heroLimb", HERO.cloth, TILE.cloth, 0, -0.53, 0.04, 0.16, 0.31, 0.17, arm);
    part("head", HERO.skin, TILE.skin, 0, -0.73, 0.05, 0.1, 0.13, 0.1, arm);
  }
  part("box", "#777c6b", TILE.leather, 0, 1.49, -0.25, 0.43, 0.49, 0.2);
  part("box", "#bac0a1", TILE.metal, -0.16, 1.62, 0.22, 0.1, 0.3, 0.035);

  model.gunMount = new THREE.Group();
  model.gunMount.position.set(0.34, 1.47, 0.48);
  model.body.add(model.gunMount);
  equipWeapon(model, 0);
  return model;
}

// Low-poly carried gun in mount space (+Z = barrel). Accent strips are unlit glow.
export function createWeaponModel(index) {
  const weapon = WEAPONS[index] || WEAPONS[0];
  const g = new THREE.Group();
  g.name = "weapon-" + weapon.id;
  const lit = (color, x, y, z, sx, sy, sz, geo = GEO.box) =>
    addPart(null, g, geo, paint(color, TILE.metal), x, y, z, sx, sy, sz);
  const glow = (color, x, y, z, sx, sy, sz) => addPart(null, g, GEO.box, paint(color, 0, true), x, y, z, sx, sy, sz);

  if (weapon.id === 4) {
    // HAVOC replaces the common receiver with a launcher tube lying along Z.
    lit("#536c4c", 0, 0, 0.3, 0.24, 1.1, 0.24, GEO.tube).rotation.x = Math.PI / 2;
    lit("#dca651", 0, 0.12, 0.35, 0.38, 0.13, 0.7);
    lit("#243340", 0, -0.25, 0.2, 0.15, 0.3, 0.17);
    return g;
  }
  lit("#253549", 0, 0, 0.18, 0.22, 0.25, 0.8);
  glow(weapon.color, 0, 0.04, 0.27, 0.25, 0.17, 0.46);
  lit("#192b3d", 0, -0.19, 0.03, 0.12, 0.32, 0.17);
  lit("#65798c", 0, 0, 0.72, 0.09, 0.09, 0.42);
  if (weapon.id === 1) {
    g.scale.setScalar(0.85);
    lit(weapon.color, 0, 0.17, 0.2, 0.1, 0.08, 0.3);
  } else if (weapon.id === 2) {
    for (const side of [1, -1]) lit("#706681", side * 0.1, 0, 0.64, 0.11, 0.13, 0.7);
  } else if (weapon.id === 3) {
    lit("#243951", 0, 0.23, 0.13, 0.17, 0.15, 0.32);
    glow(weapon.color, 0, 0.02, 0.68, 0.17, 0.16, 0.9);
  }
  return g;
}

// Swap the gun held in a model's gunMount (the hero's weapon switch). Returns the new group.
export function equipWeapon(model, index) {
  if (!model.gunMount) return null;
  if (model.weapon) model.gunMount.remove(model.weapon);
  model.weapon = createWeaponModel(index);
  model.gunMount.add(model.weapon);
  return model.weapon;
}

// Registered builders (IMPROVEMENTS F1.7): keeper, creature and prop models register from
// their own modules (render/models-keepers.js, models-creatures.js, models-props.js, imported
// by main.js), so several packages author monsters without editing this file.
const REGISTRY = new Map(); // kind -> { builder, palette }

// builder(monsterKit, { death }) -> Model. `palette` names the model's colour roles for the
// palette lint (tests/models-palette.test.mjs): every key is a lint role ({ hide: "#8b7d6b",
// ... }) except `signal`, an object of the unlit signal colours (eyes, cores, lanterns), which
// only have to clear the ground swatches.
export function registerMonsterModel(kind, builder, palette = {}) {
  const { signal = {}, ...roles } = palette;
  REGISTRY.set(kind, Object.freeze({ builder, palette: Object.freeze({ ...roles, signal: Object.freeze({ ...signal }) }) }));
}

// The named palette a registered kind declared, or null for Wave-1 kinds.
export const registeredPalette = (kind) => REGISTRY.get(kind)?.palette ?? null;

// Every registered kind, then every ENEMY_TYPES/DEATH_TYPES kind, "warden", "ironmaw" (the
// charger x1.35) and the "node"/"anchor" encounter objects. `death` reskins the ordinary
// roster for Death Mode.
export function createMonster(kind, { death = false } = {}) {
  const registered = REGISTRY.get(kind);
  if (registered) return registered.builder(monsterKit, { death });
  if (kind === "node" || kind === "anchor") return createEncounterObject(kind);
  return wave1Monster(kind, death);
}

// The Wave-1 model of a kind, whatever is registered for it (a registered builder may start
// from it, as Iron Maw's does).
function wave1Monster(kind, death) {
  const shape = kind === "ironmaw" ? "charger" : kind;
  const model = newModel(kind);
  const reskin = death && kind in ENEMY_TYPES;
  const [rawHide, bone] = PALETTES[shape] || PALETTES.runner;
  const hide = reskin ? mixHex(rawHide, DEATH_BLOOD, DEATH_HIDE_SHIFT) : rawHide;
  const eye = reskin ? paint(DEATH_EYE, 0, true) : paint(shape === "runner" ? "#d3b77a" : "#d77b65", TILE.skin);
  model.crawler = CRAWLERS.has(shape);
  model.floating = FLOATERS.has(shape);
  const kit = shapeKit(model, { hide, bone, eye }, FAT.has(shape));
  buildBaseBody(kit);
  const extras = EXTRAS[shape];
  if (extras) extras(kit);
  if (model.floating) floatingKit(kit);
  if (kind === "ironmaw") model.g.scale.multiplyScalar(IRON_MAW_SCALE);
  finishMonster(model);
  return model;
}

// An empty node marking a place on a model (head, ring and sigil slots).
function anchor(parent, x, y, z) {
  const node = new THREE.Object3D();
  node.position.set(x, y, z);
  parent.add(node);
  return node;
}

// Monsters carry no weapon; the hidden mount keeps the model shape uniform. The ring slot sits
// at the feet and the sigil slot above the head (F1.7).
function finishMonster(model) {
  model.gunMount = new THREE.Group();
  model.gunMount.visible = false;
  model.body.add(model.gunMount);
  model.lean = model.body.rotation.z;
  const head = model.parts.head.position;
  model.parts.torusSlot = anchor(model.g, 0, 0, 0);
  model.parts.sigilSlot = anchor(model.g, 0, head.y + SIGIL_LIFT, head.z);
}

// Part helpers bound to one monster: its palette ({ hide, bone } colours with the Death Mode
// hide shift already applied, `eye` a paint record) and its part list.
function shapeKit(model, { hide, bone, eye }, fat) {
  const part = (geo, record, x, y, z, sx, sy, sz, parent = model.body) =>
    addPart(model.parts, parent, GEO[geo], record, x, y, z, sx, sy, sz);
  const spike = (x, y, z, sx, sy, angle = 0, parent = model.body) => {
    const mesh = part("claw", paint(bone, TILE.bone), x, y, z, sx, sy, sx, parent);
    mesh.rotation.z = angle;
    return mesh;
  };
  return {
    model,
    hide,
    bone,
    eye,
    fat,
    part,
    spike,
    flesh: (color, x, y, z, sx, sy, sz, parent) => part("flesh", paint(color, TILE.skin), x, y, z, sx, sy, sz, parent),
    limb: (color, tile, x, y, z, sx, sy, sz, parent) => part("limb", paint(color, tile), x, y, z, sx, sy, sz, parent),
    box: (color, tile, x, y, z, sx, sy, sz) => part("box", paint(color, tile), x, y, z, sx, sy, sz),
  };
}

// The shared monster body (spec enemies.md §13.2). Fills model.parts.head (an anchor at the
// head's centre) and model.parts.eyes; without `head` the builder brings its own head and eyes.
function buildBaseBody(kit, head = true) {
  const { model, hide, bone, eye, fat, part, flesh, spike, limb, box } = kit;
  const crawler = model.crawler;
  const eyes = (model.parts.eyes = []);
  flesh(hide, 0, 1.38, 0, fat ? 0.66 : 0.43, fat ? 0.67 : 0.53, crawler ? 0.57 : 0.33);
  // Exposed rib plates and an angular open jaw read at the game's internal resolution.
  for (let i = 0; i < 3; i++) box(bone, TILE.bone, 0, 1.55 - i * 0.18, 0.29, 0.5 - i * 0.05, 0.065, 0.065);
  const headY = crawler ? 1.45 : 1.96;
  const headZ = crawler ? 0.55 : 0.14;
  model.parts.head = anchor(model.body, 0, headY, headZ);
  if (head) {
    flesh(bone, 0, headY, headZ, 0.29, 0.34, 0.29);
    box("#271d22", TILE.skin, 0, headY - 0.16, headZ + 0.255, 0.35, 0.15, 0.09);
  }
  for (const side of [-1, 1]) {
    if (head) {
      box("#211921", TILE.skin, side * 0.14, headY + 0.055, headZ + 0.255, 0.13, 0.12, 0.055);
      eyes.push(tagEye(part("box", eye, side * 0.145, headY + 0.04, headZ + 0.288, 0.055, 0.055, 0.025)));
      for (let i = 0; i < 2; i++) spike(side * (0.055 + i * 0.085), headY - 0.17, headZ + 0.31, 0.035, 0.12, Math.PI);
    }

    const leg = limbGroup(model, model.legs, side * (crawler ? 0.36 : 0.23), 1.03, -0.04);
    limb(hide, TILE.skin, 0, -0.24, 0, 0.28, 0.52, 0.26, leg);
    limb(bone, TILE.bone, 0, -0.64, 0.02, 0.17, 0.35, 0.17, leg);
    flesh(hide, 0, -0.92, 0.14, 0.19, 0.12, 0.32, leg);

    const arm = limbGroup(model, model.arms, side * 0.44, 1.7, 0);
    limb(hide, TILE.skin, side * 0.05, -0.26, 0, 0.24, 0.58, 0.25, arm);
    limb(bone, TILE.bone, side * 0.1, -0.7, 0.05, 0.16, 0.43, 0.17, arm);
    for (let i = 0; i < 3; i++) spike(side * 0.1 + (i - 1) * 0.08, -0.99, 0.13, 0.035, 0.25, Math.PI, arm);

    if (crawler) {
      const rear = limbGroup(model, model.appendages, side * 0.4, 1.12, -0.34);
      const upper = limb(hide, TILE.skin, side * 0.22, -0.25, 0, 0.19, 0.8, 0.19, rear);
      upper.rotation.z = side * 0.9;
      spike(side * 0.48, -0.68, 0.1, 0.075, 0.55, Math.PI, rear);
    }
  }
}

// Per-kind silhouette: root scale, extra parts and the resting arm pose.
const EXTRAS = {
  runner({ model, box }) {
    model.body.rotation.z = 0.08;
    model.arms[0].scale.y = 1.2;
    box("#443f34", TILE.cloth, 0, 1.02, -0.05, 0.52, 0.25, 0.36);
  },
  skitter({ model, spike }) {
    model.g.scale.set(0.9, 0.48, 1.1);
    model.armPose = -1.45;
    for (const side of [-1, 1]) spike(side * 0.22, 1.35, 0.85, 0.08, 0.55, side * 1.1);
  },
  gunner({ model, flesh, box }) {
    flesh("#a6af55", 0, 1.76, 0.5, 0.3, 0.34, 0.33);
    box("#34432a", TILE.skin, 0, 1.77, 0.79, 0.21, 0.2, 0.06);
    model.armPose = -0.25;
  },
  charger({ model, flesh, spike }) {
    model.g.scale.set(1.15, 1.05, 1.1);
    for (const side of [-1, 1]) {
      const horn = spike(side * 0.34, 2.23, 0.32, 0.13, 0.85, -side * 0.7);
      horn.rotation.x = 0.8;
      // Iron Maw's horns are part of its signature, bright even on its shade (F6).
      if (model.kind === "ironmaw") horn.userData.bucket = "signature";
    }
    flesh("#51473e", 0, 1.64, -0.22, 0.6, 0.48, 0.4);
  },
  brute({ model, hide, flesh }) {
    model.g.scale.set(1.6, 1.45, 1.5);
    for (const side of [-1, 1]) flesh(hide, side * 0.61, 0.72, 0.15, 0.33, 0.34, 0.33);
    model.armPose = -0.18;
  },
  mortar({ model, flesh, spike }) {
    model.g.scale.set(1.12, 1.03, 1.18);
    for (const side of [-1, 1]) flesh("#afaa53", side * 0.3, 1.65, -0.35, 0.37, 0.49, 0.4);
    spike(0, 2.07, -0.2, 0.2, 0.5);
    model.armPose = -0.3;
  },
  sniper({ model, spike }) {
    model.g.scale.set(0.82, 1.18, 0.85);
    for (let i = 0; i < 4; i++) spike((i - 1.5) * 0.18, 2.27, 0, 0.055, 0.4 + (i % 2) * 0.3, (i - 1.5) * 0.4);
    spike(0, 1.97, 0.63, 0.12, 0.8).rotation.x = Math.PI / 2;
    model.armPose = -0.4;
  },
  leaper({ model, hide, flesh }) {
    model.g.scale.set(1.1, 0.72, 1.2);
    for (const side of [-1, 1]) flesh(hide, side * 0.46, 0.65, -0.32, 0.35, 0.4, 0.38);
    model.armPose = -1.6;
  },
  splitter({ model, flesh }) {
    model.g.scale.set(1.18, 1.05, 1.16);
    for (const side of [-1, 1])
      for (let j = 0; j < 2; j++) flesh("#b9c28e", side * 0.5, 1.25 + j * 0.36, -0.25, 0.28, 0.28, 0.28);
    model.armPose = -0.4;
  },
  warden({ model, flesh, spike }) {
    model.g.scale.set(2.25, 2.4, 2.05);
    for (const side of [-1, 1]) {
      spike(side * 0.33, 2.44, 0, 0.13, 0.8, -side * 0.4);
      spike(side * 0.66, 1.86, 0, 0.2, 0.6, -side * 1.1);
    }
    flesh("#382a3b", 0, 1.5, -0.3, 0.68, 0.69, 0.3);
    model.armPose = -0.4;
  },
  revenant({ model, spike }) {
    model.g.scale.set(0.85, 1.15, 0.9);
    for (const arm of model.arms) arm.scale.y = 1.25;
    for (const side of [-1, 1]) spike(side * 0.19, 2.34, -0.07, 0.06, 0.55, -side * 0.3);
    model.armPose = -1.4;
  },
  hexer({ model, spike }) {
    model.g.scale.set(1.04, 1.12, 1.04);
    for (let i = 0; i < 3; i++) spike((i - 1) * 0.28, 2.35, 0, 0.09, 0.55, (i - 1) * 0.45);
  },
  broodmother({ model, flesh }) {
    model.g.scale.set(1.65, 0.78, 1.6);
    flesh("#8f4545", 0, 1.22, -0.6, 0.68, 0.7, 0.78);
    for (const side of [-1, 1]) flesh("#bc8170", side * 0.4, 1.65, -0.72, 0.25, 0.28, 0.26);
    model.armPose = -1.25;
  },
};

// Stormer/Hexer: no legs, a hanging lower mass and five swaying tendrils.
function floatingKit({ model, hide, flesh, spike }) {
  for (const leg of model.legs) leg.visible = false;
  flesh(hide, 0, 1.25, -0.18, 0.65, 0.65, 0.52);
  for (let i = 0; i < 5; i++) {
    const tendril = limbGroup(model, model.appendages, (i - 2) * 0.2, 1.02, -0.05);
    spike(0, -0.3, 0, 0.1, 0.8, Math.PI + (i - 2) * 0.1, tendril);
  }
  for (const side of [-1, 1]) spike(side * 0.47, 1.99, 0, 0.1, 0.6, -side * 0.85);
  model.armPose = -1.5;
}

// Builders for registered models (F1.7). A builder returns a Model whose parts carry the
// conventions: parts.eyes (eye meshes, tagged by eye() so they stay apart from the merge),
// parts.head (an anchor at the head), parts.core (an optional weak-point mesh), parts.torusSlot
// and parts.sigilSlot (base() and wave1() add them), and it calls mergeStatic last.
//   geo                                          the shared unit primitives, by name
//   palette(color, tile, unlit = false, glow = 0) a cached paint record for part()
//   part(model, geo, record, x, y, z, sx, sy, sz, parent = model.body) -> mesh
//                                                (geo: a GEO name or any BufferGeometry)
//   spike(model, colorOrRecord, x, y, z, sx, sy, angle = 0, parent = model.body) -> mesh
//                                                (a colour paints bone-tiled, like Wave 1)
//   eye(mesh) -> mesh                            tags a part as one of the eyes
//   group(model, role, x, y, z, parent = model.body) -> Group
//                                                a pivot; role "arms" | "legs" | "appendages"
//                                                enrols it in that animated list, null does not
//   base(kind, { hide, bone, eye }, { crawler, fat, floating, head = true }) -> Model
//                                                (eye: a colour for lit eyes or a record;
//                                                head: false leaves the head to the builder)
//   wave1(kind, { death }) -> Model              the Wave-1 model of a kind
//   setEyes, mergeStatic
export const monsterKit = Object.freeze({
  geo: GEO,
  palette: paint,
  part: (model, geo, record, x, y, z, sx, sy, sz, parent = model.body) =>
    addPart(model.parts, parent, GEO[geo] ?? geo, record, x, y, z, sx, sy, sz),
  spike(model, paintOrColor, x, y, z, sx, sy, angle = 0, parent = model.body) {
    const record = typeof paintOrColor === "string" ? paint(paintOrColor, TILE.bone) : paintOrColor;
    const mesh = addPart(model.parts, parent, GEO.claw, record, x, y, z, sx, sy, sx);
    mesh.rotation.z = angle;
    return mesh;
  },
  eye: tagEye,
  group(model, role, x, y, z, parent = model.body) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);
    if (role) model[role].push(group);
    return group;
  },
  base(kind, { hide, bone, eye }, { crawler = false, fat = false, floating = false, head = true } = {}) {
    const model = newModel(kind);
    model.crawler = crawler;
    model.floating = floating;
    const kit = shapeKit(model, { hide, bone, eye: typeof eye === "string" ? paint(eye, TILE.skin) : eye }, fat);
    buildBaseBody(kit, head);
    if (floating) floatingKit(kit);
    finishMonster(model);
    return model;
  },
  wave1: (kind, { death = false } = {}) => wave1Monster(kind, death),
  setEyes,
  mergeStatic,
});

// Threat eyes (F8, F17): model.parts.eyes turn unlit `color` with their boxes scaled by `scale`
// (each box about its own centre, also inside a merged eye mesh); null restores the authored
// eyes at scale 1. A flash or tint in progress carries over to the new paint.
export function setEyes(model, color = null, scale = 1) {
  const eyes = model?.parts?.eyes;
  if (!eyes?.length) return model;
  const size = color ? scale : 1;
  for (const mesh of eyes) {
    const data = mesh.userData;
    if (!data.authoredPaint) {
      hide(data, "authoredPaint", data.paint);
      hide(data, "authoredScale", mesh.scale.clone());
    }
    data.paint = color ? paint(color, TILE.skin, true) : data.authoredPaint;
    if (!scaleRange(mesh, "eye", size)) mesh.scale.copy(data.authoredScale).multiplyScalar(size);
  }
  model.eyeState = color ? { color, scale: size } : null; // re-applied if the model is merged later
  repaint(model);
  return model;
}

// The shade look of a keeper model (F6). The first call turns the model into a shade for good
// (the Warden's shade actors are pooled per keeper): every mesh gets a private alphaHash copy of
// its material, lit parts lerp halfway to bone at 60 % coverage, unlit parts (eyes, cores, the
// Aegis) and the "signature" bucket (the bell, the Maw's jaw and horns) keep full colour and
// coverage, and parts flagged userData.shadeHidden (the Abbot's facing wedge) hide. `amount`
// 0..1 is the rise/fade dissolve, held in 6 steps. Returns the model.
export function spectral(model, amount = 1) {
  if (!model?.g) return model;
  const shade = model.shade ?? makeShade(model);
  const step = Math.round(Math.min(1, Math.max(0, amount)) * DISSOLVE_STEPS);
  if (step !== shade.step) {
    shade.step = step;
    for (const [material, full] of shade.coverage) material.opacity = (full * step) / DISSOLVE_STEPS;
  }
  return model;
}

function makeShade(model) {
  const coverage = new Map();
  const bone = SHADE_TINT;
  for (const mesh of model.parts) {
    const record = mesh.userData.paint;
    const bright = !!record?.unlit || mesh.userData.bucket === "signature";
    const material = hashedCopy(mesh.material, 1);
    if (!bright) {
      if (mesh.userData.merged) lerpColors(mesh.geometry, bone, 0.5);
      else material.color.lerp(bone, 0.5);
    }
    mesh.material = material;
    mesh.userData.phaseMaterial = true; // private: repaint leaves it alone, disposeModel frees it
    coverage.set(material, bright ? 1 : SHADE_COVERAGE);
  }
  model.g.traverse((node) => {
    if (node.userData.shadeHidden) node.visible = false;
  });
  model.shade = { step: -1, coverage };
  return model.shade;
}

// Lerps a merged mesh's vertex colours toward `color` (its geometry belongs to the model).
function lerpColors(geometry, color, t) {
  const attribute = geometry.attributes.color,
    array = attribute.array,
    target = [color.r, color.g, color.b];
  for (let i = 0; i < array.length; i++) array[i] += (target[i % 3] - array[i]) * t;
  attribute.needsUpdate = true;
}

// Anchors (Skull Trial) and Warden nodes: a stone plinth under a glowing gem.
function createEncounterObject(kind) {
  const model = newModel(kind);
  model.fixed = true;
  const gem = kind === "anchor" ? "#b887bc" : "#e1ae74";
  addPart(model.parts, model.body, GEO.box, paint("#625c76", TILE.metal), 0, 0.25, 0, 1.25, 0.5, 1.25);
  addPart(model.parts, model.body, GEO.gem, paint(gem, 0, true), 0, 1.3, 0, 0.65, 1.1, 0.65);
  return model;
}

// Stop-motion at 15 fps (PS1 feel). `speed` scales stride and arm swing; `recoil` drives
// the hero's gun arm and mount. Encounter objects do not animate. A monster's armPose is one
// rest angle for every arm or an array with one per arm; model.animate(model, t, speed), when a
// builder or dressing set one, runs last with the same stepped clock (bells, cores, sigils).
export function animateCharacter(model, time, speed, recoil = 0) {
  if (!model || model.fixed) return;
  const t = Math.floor(time * 15) / 15;
  const stride = Math.sin(t * (model.crawler ? 15 : 9));
  const { legs, arms, appendages, body } = model;
  legs[0].rotation.x = stride * 0.65 * speed;
  legs[1].rotation.x = -legs[0].rotation.x;
  body.position.y = model.floating ? 0.12 + Math.sin(t * 3) * 0.12 : Math.abs(stride) * 0.06 * speed;
  if (model.monster) {
    const poses = model.armPose;
    for (let i = 0; i < arms.length; i++)
      arms[i].rotation.x = (typeof poses === "number" ? poses : poses[i]) + Math.sin(t * 9 + i * Math.PI) * 0.25 * speed;
    // Tendrils and rear limbs always sway, whatever the walking speed.
    for (let i = 0; i < appendages.length; i++) appendages[i].rotation.z = Math.sin(t * 6 + i) * 0.18;
    model.animate?.(model, t, speed);
    return;
  }
  arms[0].rotation.x = -0.6 + stride * 0.18 * speed;
  arms[1].rotation.x = -1.15 - recoil * 0.5;
  model.gunMount.position.z = 0.48 - recoil * 0.14;
}

// Death pose (Wave-1 polish): the model topples backwards to a random side while
// sinking and squashing into the ground. t = 0..1 progress of the caller's death
// timer, held in 6 poses; t = 0 restores the rest pose. Only `body` moves, so the
// caller's placement of `g` on the terrain stays valid.
export function collapseModel(model, t) {
  if (!model) return;
  const k = Math.min(1, Math.max(0, Math.ceil(t * COLLAPSE_POSES - 1e-6) / COLLAPSE_POSES));
  if (!model.fallSide) model.fallSide = Math.random() < 0.5 ? -1 : 1; // cosmetic only
  const { body } = model;
  body.rotation.x = -COLLAPSE_TILT * k;
  body.rotation.z = model.lean + model.fallSide * COLLAPSE_LEAN * k;
  body.position.y = -COLLAPSE_SINK * k * k;
  body.scale.set(1 + 0.12 * k, 1 - 0.35 * k, 1 + 0.12 * k);
}

// Hit flash, amount 0..1 (e.g. remaining flash time / its duration). Held in 3 steps so
// a decaying flash reads as discrete PS1 frames; unchanged steps cost nothing.
export function setFlash(model, amount) {
  if (!model) return;
  const steps = FLASH_LEVELS.length - 1;
  const level = amount > 0 ? Math.min(steps, Math.ceil(amount * steps)) : 0;
  if (level === model.flashLevel) return;
  model.flashLevel = level;
  repaint(model);
}

// Multiply every part by `color` (e.g. the Warden enrage "#efb6b0"); amount 0..1 blends
// from no tint to the full multiply in 4 steps. null (or amount 0) clears it.
export function setTint(model, color, amount = 1) {
  if (!model) return;
  const step = color ? Math.round(Math.min(1, Math.max(0, amount)) * TINT_STEPS) : 0;
  const tint = step ? color : null;
  if (tint === model.tint && step === model.tintStep) return;
  model.tint = tint;
  model.tintStep = step;
  repaint(model);
}

function repaint(model) {
  const { parts, flashLevel, tint, tintStep } = model;
  for (let i = 0; i < parts.length; i++) {
    const mesh = parts[i];
    // A caller-owned per-model clone (original enrage path) is left alone.
    if (mesh.userData.phaseMaterial) continue;
    const record = mesh.userData.paint;
    mesh.material = flashLevel
      ? flashVariant(record, flashLevel)
      : tintStep
        ? tintVariant(record, tint, tintStep)
        : record.base;
  }
}

// Detach a model and free what belongs to it alone. Shared geometry, base materials and the
// flash/tint variants are caches and stay alive; merged geometry (userData.ownGeometry) and the
// materials cloned for this model and flagged `userData.phaseMaterial` (spec §12.5, shades)
// are disposed. Idempotent.
export function disposeModel(model) {
  if (!model?.g) return;
  model.g.removeFromParent();
  model.g.traverse((node) => {
    const data = node.userData;
    if (data.ownGeometry) {
      node.geometry?.dispose();
      delete data.ownGeometry;
    }
    if (!data.phaseMaterial) return;
    node.material?.dispose?.();
    delete data.phaseMaterial;
  });
}
