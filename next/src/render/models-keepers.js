// Keeper models (IMPROVEMENTS F1.7, F2–F6): the Bellwether, Iron Maw's added detail, the Cinder
// Abbot and the Castellan, registered with registerMonsterModel, plus the Rift Warden's crown
// (crownWarden, KEEPERS only). main.js imports this module for its side effects before the
// first createMonster call.
//
// Every builder ends in mergeStatic, which keeps a keeper within 8 draw calls: only the parts
// that move on their own stay apart (legs, arms, the bell, the robe hem, the tatters, eyes, the
// Aegis and glaive gem, the facing wedge, the vigil dome). Bespoke parts animate through
// model.animate (called by animateCharacter at 15 fps) from plain fields on model.rig, which the
// keeper AI sets: the AI never touches a material.
import * as THREE from "three";
import { registerMonsterModel, monsterKit } from "./models.js";
import { retroMaterial, unlitMaterial, scaleRange, TILE } from "./materials.js";
import { approach, lerp, TAU } from "../core/util.js";

const X_AXIS = new THREE.Vector3(1, 0, 0);
const scratch = new THREE.Vector3();

// Keeper-only shapes, shared by every instance.
const SHAPES = Object.freeze({
  cone: new THREE.ConeGeometry(1, 1, 6), // robes and hoods, apex up
  bell: new THREE.CylinderGeometry(0.18, 0.42, 0.55, 8),
  dome: new THREE.IcosahedronGeometry(1, 1),
});

// Places a part held in `arm` so that it sits upright at body-space (x, y, z) while the arm
// keeps its rest angle `pose` (rotation.x): props stay vertical in the hand.
function held(node, arm, pose, x, y, z) {
  scratch.set(x - arm.position.x, y - arm.position.y, z - arm.position.z).applyAxisAngle(X_AXIS, -pose);
  node.position.copy(scratch);
  node.rotation.x = -pose;
  return node;
}

// Whole 15 fps frames since the rig last animated (stepped poses advance per frame).
function framesSince(rig, t) {
  const frames = rig.t === null ? 0 : Math.max(0, Math.round((t - rig.t) * 15));
  rig.t = t;
  return frames;
}

// ---- the Bellwether (F2) ----------------------------------------------------------------------

const BELLWETHER = Object.freeze({
  hide: "#8b7d6b",
  bone: "#ffdca9",
  shroud: "#322c2d",
  bell: "#9a7a3e",
  signal: Object.freeze({ eyes: "#e8e2a0" }),
});
const CROOK = "#5b4632";
const SOCKET = "#1b1418";
const CLAPPER = "#5a5048";
const BELLWETHER_POSE = Object.freeze([-0.3, -0.9]); // the crook arm (arms[1]) leans forward
// Three chained horn spikes per side: [x, y, z, sy, angle] for s = +1 (mirrored for -1).
const HORNS = Object.freeze([
  [0.2, 2.12, 0, 0.4, -1.3],
  [0.34, 2.0, -0.1, 0.35, -2.3],
  [0.32, 1.86, 0.04, 0.3, -3.0],
]);

function buildBellwether(kit) {
  const { part, palette: paint, spike } = kit;
  const bone = paint(BELLWETHER.bone, TILE.bone);
  const model = kit.base("bellwether", { hide: BELLWETHER.hide, bone: BELLWETHER.bone, eye: paint(BELLWETHER.signal.eyes, 0, true) }, { head: false });
  model.g.scale.set(1.45, 1.9, 1.4);
  model.armPose = [...BELLWETHER_POSE];
  for (const leg of model.legs) leg.children[0].scale.y *= 1.3; // gaunt thighs

  // Ram skull in place of the default head, with sockets and pale eyes.
  part(model, "flesh", bone, 0, 1.96, 0.14, 0.3, 0.36, 0.34);
  part(model, "box", bone, 0, 1.9, 0.36, 0.2, 0.16, 0.22);
  for (const side of [-1, 1]) {
    part(model, "box", paint(SOCKET, TILE.skin), side * 0.12, 2.02, 0.4, 0.1, 0.08, 0.06);
    model.parts.eyes.push(kit.eye(part(model, "box", paint(BELLWETHER.signal.eyes, 0, true), side * 0.12, 2.02, 0.44, 0.06, 0.05, 0.03)));
    for (const [x, y, z, sy, angle] of HORNS) spike(model, bone, side * x, y, z, 0.09, sy, side * angle);
  }

  // Shroud over the back; its four tatters hang from one swaying pivot.
  const cloth = paint(BELLWETHER.shroud, TILE.cloth);
  part(model, "box", cloth, 0, 1.35, -0.12, 0.8, 1.0, 0.5);
  const tatters = kit.group(model, "appendages", 0, 1.0, -0.3);
  for (let i = 0; i < 4; i++) part(model, "box", cloth, -0.3 + i * 0.2, -0.22, 0, 0.12, 0.5, 0.04, tatters);

  // The crook in the forward hand, and the bell hanging from its hook (parts.bell swings).
  const arm = model.arms[1],
    pose = BELLWETHER_POSE[1],
    wood = paint(CROOK, TILE.bark);
  held(part(model, "tube", wood, 0, 0, 0, 0.07, 2.8, 0.07, arm), arm, pose, 0.54, 1.45, 0.82);
  held(part(model, "box", wood, 0, 0, 0, 0.07, 0.07, 0.3, arm), arm, pose, 0.54, 2.85, 0.95);
  held(part(model, "box", wood, 0, 0, 0, 0.07, 0.3, 0.07, arm), arm, pose, 0.54, 2.72, 1.08);
  const bell = held(kit.group(model, null, 0, 0, 0, arm), arm, pose, 0.54, 2.57, 1.08);
  const bronze = part(model, SHAPES.bell, paint(BELLWETHER.bell, TILE.rust), 0, -0.3, 0, 1, 1, 1, bell);
  const clapper = part(model, "flesh", paint(CLAPPER, TILE.metal), 0, -0.6, 0, 0.08, 0.08, 0.08, bell);
  bronze.userData.bucket = clapper.userData.bucket = "signature";
  model.parts.bell = bell;

  model.animate = animateBellwether;
  return kit.mergeStatic(model);
}

// The bell sways on its hook (15 fps, the shared stepped clock).
function animateBellwether(model, t) {
  model.parts.bell.rotation.z = Math.sin(t * 6) * 0.25;
}

// ---- Iron Maw (F3 model detail, both rulesets) --------------------------------------------------

// The Wave-1 charger x1.35 plus the lore parts. Iron greys are warmed so they clear the Quarry's
// blue-grey swatches (palette lint, F1.7); the Wave-1 hide and bone stay as they were.
const IRON_MAW = Object.freeze({
  jaw: "#6b5a4a",
  teeth: "#857d74",
  handle: "#5b4632",
  iron: "#62584f",
  signal: Object.freeze({}),
});

function buildIronMaw(kit, { death }) {
  const { part, palette: paint, spike } = kit;
  const model = kit.wave1("ironmaw", { death });
  const jaw = paint(IRON_MAW.jaw, TILE.rust),
    teeth = paint(IRON_MAW.teeth, TILE.metal),
    iron = paint(IRON_MAW.iron, TILE.metal);
  // Jaw plates under the head, lined with iron teeth: the Maw's signature with its horns.
  for (const side of [-1, 1]) {
    const plate = part(model, "box", jaw, side * 0.12, 1.74, 0.36, 0.14, 0.09, 0.3);
    plate.rotation.y = side * 0.15;
    plate.userData.bucket = "signature";
    for (let i = 0; i < 3; i++) spike(model, teeth, side * (0.05 + i * 0.07), 1.8, 0.48 - i * 0.04, 0.03, 0.1).userData.bucket = "signature";
  }
  // The worker's hammer, lodged in the hump.
  const handle = part(model, "limb", paint(IRON_MAW.handle, TILE.bark), 0.15, 2.0, -0.3, 0.08, 0.9, 0.08);
  handle.rotation.z = 0.5;
  const head = part(model, "box", iron, 0.15 - Math.sin(0.5) * 0.45, 2.0 + Math.cos(0.5) * 0.45, -0.3, 0.35, 0.18, 0.18);
  head.rotation.z = 0.5;
  // Three dragging chain links, one swaying pivot.
  const chain = kit.group(model, "appendages", 0, 1.1, -0.42);
  for (let i = 0; i < 3; i++) {
    const link = part(model, "box", iron, 0, -0.15 - i * 0.2, -0.06 * i, 0.12, 0.16, 0.05, chain);
    link.rotation.y = (i % 2) * (Math.PI / 2);
  }
  return kit.mergeStatic(model);
}

// ---- the Cinder Abbot (F4) --------------------------------------------------------------------

const ABBOT = Object.freeze({
  robe: "#15130f",
  crust: "#5e5a56",
  plates: "#7a756e",
  hood: "#090402",
  candle: "#d8c8a8",
  bone: "#d9d2b0",
  signal: Object.freeze({ eyes: "#f2ecd8", core: "#ff7a2e", flames: "#ffcf6a" }),
});
const ABBOT_DETAIL = Object.freeze({ face: "#120c0e", chain: "#3a3a3a", censer: "#6a4a3a", staff: "#3a2a24" });
const ABBOT_POSE = -0.4;
const EYE_SCALE = 1.6;
const CANDLES = Object.freeze([
  [0.5, 2.2, -0.05],
  [0.62, 2.14, 0.1],
  [-0.58, 2.2, -0.02],
]);
// The facing wedge: a dark 70° sector (±35°), radius 2.6 m, draped 0.05 m over the ground.
const WEDGE = Object.freeze({ radius: 2.6, half: (35 * Math.PI) / 180, rings: 4, spokes: 7, lift: 0.05, color: "#0c0a0a", opacity: 0.45 });
const CORE_PULSE = 0.1; // the ember core breathes 0.9..1.1

function buildAbbot(kit) {
  const { part, palette: paint } = kit;
  const model = kit.base("abbot", { hide: ABBOT.crust, bone: ABBOT.bone, eye: paint(ABBOT.signal.eyes, 0, true) }, { fat: true, head: false });
  model.g.scale.set(1.9, 1.7, 1.9);
  model.armPose = ABBOT_POSE;
  for (const leg of model.legs) leg.visible = false;
  const rock = (color) => paint(color, TILE.rock),
    flame = paint(ABBOT.signal.flames, 0, true);

  // The robe hangs from the waist and sways as one hem.
  const hem = kit.group(model, "appendages", 0, 1.5, 0);
  part(model, SHAPES.cone, paint(ABBOT.robe, TILE.cloth), 0, -0.75, 0, 0.75, 1.5, 0.75, hem);
  // Basalt crust: the torso, three front plates and the pauldrons.
  part(model, "flesh", rock(ABBOT.crust), 0, 1.45, 0, 0.66, 0.6, 0.55);
  part(model, "box", rock(ABBOT.plates), 0, 1.55, 0.42, 0.45, 0.4, 0.12);
  for (const side of [-1, 1]) {
    part(model, "box", rock(ABBOT.plates), side * 0.3, 1.3, 0.38, 0.45, 0.4, 0.12).rotation.y = side * 0.2;
    part(model, "flesh", rock(ABBOT.plates), side * 0.55, 1.85, 0, 0.32, 0.32, 0.32);
  }
  // Hood over a void face with bone-white eyes: the front reads pale, never orange.
  part(model, SHAPES.cone, paint(ABBOT.hood, TILE.cloth), 0, 2.05, 0.08, 0.34, 0.6, 0.34).rotation.x = 0.3;
  part(model, "box", paint(ABBOT_DETAIL.face, TILE.skin), 0, 1.98, 0.3, 0.3, 0.26, 0.06);
  for (const side of [-1, 1])
    model.parts.eyes.push(kit.eye(part(model, "box", paint(ABBOT.signal.eyes, 0, true), side * 0.09, 2.0, 0.34, 0.055 * EYE_SCALE, 0.055 * EYE_SCALE, 0.025 * EYE_SCALE)));
  // The back ember core (the weak point, the only orange), framed by four bone ribs.
  const core = part(model, "gem", paint(ABBOT.signal.core, 0, true), 0, 1.5, -0.46, 0.35, 0.5, 0.2);
  core.userData.part = "core";
  model.parts.core = core;
  const rib = paint(ABBOT.bone, TILE.bone);
  for (const side of [-1, 1]) {
    part(model, "box", rib, 0, 1.5 + side * 0.28, -0.52, 0.5, 0.06, 0.06);
    part(model, "box", rib, side * 0.22, 1.5, -0.52, 0.06, 0.5, 0.06);
  }
  // Shoulder candles with unlit flames.
  for (const [x, y, z] of CANDLES) {
    part(model, "tube", paint(ABBOT.candle, TILE.skin), x, y, z, 0.05, 0.25, 0.05);
    part(model, "gem", flame, x, y + 0.17, z, 0.05, 0.09, 0.05);
  }

  // Left hand: the censer on three chain links, an ember glowing out of its top.
  const left = model.arms[0],
    right = model.arms[1];
  for (let i = 0; i < 3; i++) held(part(model, "box", paint(ABBOT_DETAIL.chain, TILE.metal), 0, 0, 0, 0.05, 0.1, 0.05, left), left, ABBOT_POSE, -0.54, 0.74 - i * 0.12, 0.5);
  held(part(model, "flesh", paint(ABBOT_DETAIL.censer, TILE.rust), 0, 0, 0, 0.28, 0.28, 0.28, left), left, ABBOT_POSE, -0.54, 0.34, 0.5);
  held(part(model, "gem", flame, 0, 0, 0, 0.12, 0.1, 0.12, left), left, ABBOT_POSE, -0.54, 0.58, 0.5);
  model.parts.censer = held(new THREE.Object3D(), left, ABBOT_POSE, -0.54, 0.34, 0.5);
  left.add(model.parts.censer);
  // Right hand: the staff, planted during the fissure.
  held(part(model, "limb", paint(ABBOT_DETAIL.staff, TILE.bark), 0, 0, 0, 0.07, 2.6, 0.07, right), right, ABBOT_POSE, 0.54, 1.3, 0.5);

  model.parts.wedge = facingWedge(model);
  model.rig = { ground: null, coreLit: true };
  model.animate = animateAbbot;
  return kit.mergeStatic(model);
}

// The wedge lives in metres under the root (inverse root scale), rotates with the keeper's yaw
// and is re-draped on the terrain by the rig every step. Its geometry belongs to the model.
function facingWedge(model) {
  const { radius, half, rings, spokes } = WEDGE;
  const layout = [0, 0];
  for (let r = 1; r <= rings; r++)
    for (let s = 0; s < spokes; s++) {
      const a = -half + (2 * half * s) / (spokes - 1),
        d = (radius * r) / rings;
      layout.push(Math.sin(a) * d, Math.cos(a) * d);
    }
  const index = [];
  const at = (r, s) => 1 + (r - 1) * spokes + s;
  for (let s = 0; s < spokes - 1; s++) index.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < spokes - 1; s++) index.push(at(r, s), at(r, s + 1), at(r + 1, s + 1), at(r, s), at(r + 1, s + 1), at(r + 1, s));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((layout.length / 2) * 3), 3));
  geometry.setIndex(index);
  const wedge = new THREE.Mesh(geometry, unlitMaterial(WEDGE.color, { alphaHash: true, opacity: WEDGE.opacity }));
  const g = model.g.scale;
  wedge.scale.set(1 / g.x, 1 / g.y, 1 / g.z);
  wedge.frustumCulled = false; // re-draped every step; its bounds never settle
  Object.assign(wedge.userData, { ownGeometry: true, shadeHidden: true, layout: Float32Array.from(layout) });
  model.g.add(wedge);
  return wedge;
}

function drapeWedge(model, ground) {
  const { wedge } = model.parts,
    { position: root, rotation } = model.g,
    layout = wedge.userData.layout,
    attribute = wedge.geometry.attributes.position,
    array = attribute.array,
    cos = Math.cos(rotation.y),
    sin = Math.sin(rotation.y);
  for (let i = 0, o = 0; i < layout.length; i += 2, o += 3) {
    const lx = layout[i],
      lz = layout[i + 1];
    array[o] = lx;
    array[o + 1] = ground(root.x + lx * cos + lz * sin, root.z - lx * sin + lz * cos) + WEDGE.lift - root.y;
    array[o + 2] = lz;
  }
  attribute.needsUpdate = true;
}

// The core breathes (0 once it has left the body); the wedge follows the ground.
function animateAbbot(model, t) {
  const { rig, parts } = model;
  scaleRange(parts.core, "core", rig.coreLit ? 1 + CORE_PULSE * Math.sin(t * 9) : 0);
  if (rig.ground && parts.wedge.visible) drapeWedge(model, rig.ground);
}

// ---- the Castellan (F5) -----------------------------------------------------------------------

const CASTELLAN = Object.freeze({
  hide: "#4a3e3a",
  steel: "#918b8d",
  shield: "#7e7b7b",
  bone: "#d9d2b0",
  cape: "#6a2a2a",
  signal: Object.freeze({ aegis: "#83e7ff", eyes: "#83e7ff", glaive: "#f4e2b0" }),
});
const VISOR = "#101418";
const SHIELD_RAISED = -1.2; // arms[0].rotation.x with the shield raised in front
const SHIELD_LOWERED = Object.freeze({ x: 0.2, z: 1.1 }); // swung aside and down
const GLAIVE_POSE = -0.6;
const DOME = Object.freeze({ radius: 2.2, height: 1.4, spin: 0.5, steps: 4, opacity: 0.35 });
// The dome fades in over 4 stepped frames: one alphaHash material per step, shared.
const DOME_MATERIALS = Object.freeze(
  Array.from({ length: DOME.steps }, (_, i) => unlitMaterial(CASTELLAN.signal.aegis, { alphaHash: true, opacity: (DOME.opacity * (i + 1)) / DOME.steps })),
);
const AEGIS_SIZE = Object.freeze(new THREE.Vector3(0.15, 0.2, 0.05)); // 0.3 × 0.4 × 0.1
const GEM_SIZE = Object.freeze(new THREE.Vector3(0.1, 0.25, 0.1)); // 0.2 × 0.5 × 0.2
const AEGIS_FLARE = 1.5;
const GEM_FLARE = 1.6;
const GEM_PULSE = 0.08;
const SHIELD_CENTRE = Object.freeze([-0.08, 1.25, 0.72]); // body space, raised

// The shield and its bone rim as [x, y, z, sx, sy, sz] around SHIELD_CENTRE.
const SHIELD_PARTS = Object.freeze([
  [0, 0, 0, 1.3, 2.0, 0.18],
  [0, 1.0, 0.1, 1.4, 0.1, 0.12],
  [0, -1.0, 0.1, 1.4, 0.1, 0.12],
  [-0.65, 0, 0.1, 0.1, 2.0, 0.12],
  [0.65, 0, 0.1, 0.1, 2.0, 0.12],
]);

function buildCastellan(kit) {
  const { part, palette: paint, spike } = kit;
  const model = kit.base("castellan", { hide: CASTELLAN.hide, bone: CASTELLAN.bone, eye: paint(CASTELLAN.signal.eyes, 0, true) }, { head: false });
  model.g.scale.set(1.6, 2.0, 1.5);
  model.armPose = [SHIELD_RAISED, GLAIVE_POSE];
  const steel = paint(CASTELLAN.steel, TILE.metal),
    bone = paint(CASTELLAN.bone, TILE.bone);

  part(model, "box", steel, 0, 1.5, 0.2, 0.8, 0.7, 0.3); // chest plate
  part(model, "box", steel, 0, 1.98, 0.12, 0.4, 0.45, 0.4); // helm
  part(model, "box", paint(VISOR, TILE.skin), 0, 1.98, 0.33, 0.34, 0.1, 0.03);
  model.parts.eyes.push(kit.eye(part(model, "box", paint(CASTELLAN.signal.eyes, 0, true), 0, 1.98, 0.35, 0.3, 0.06, 0.02)));
  for (let i = 0; i < 3; i++) spike(model, bone, 0, 2.24 + (i === 1 ? 0.03 : 0), 0.12 - i * 0.12, 0.06, 0.35).rotation.x = -0.3;
  for (const side of [-1, 1]) part(model, "flesh", steel, side * 0.5, 1.85, 0, 0.3, 0.3, 0.3);
  part(model, "box", paint(CASTELLAN.cape, TILE.cloth), 0, 1.3, -0.3, 0.75, 1.3, 0.08).rotation.x = 0.12;

  // The tower shield in arms[0] with its bone rim and the Aegis boss at its centre.
  const shieldArm = model.arms[0],
    [cx, cy, cz] = SHIELD_CENTRE;
  SHIELD_PARTS.forEach(([x, y, z, sx, sy, sz], i) =>
    held(part(model, "box", i ? bone : paint(CASTELLAN.shield, TILE.metal), 0, 0, 0, sx, sy, sz, shieldArm), shieldArm, SHIELD_RAISED, cx + x, cy + y, cz + z),
  );
  model.parts.shield = shieldArm;
  model.parts.aegis = held(part(model, "gem", paint(CASTELLAN.signal.aegis, 0, true), 0, 0, 0, AEGIS_SIZE.x, AEGIS_SIZE.y, AEGIS_SIZE.z, shieldArm), shieldArm, SHIELD_RAISED, cx, cy, cz + 0.13);

  // The beacon glaive in arms[1]: a steel pole under a pale gem that pulses and flares.
  const glaiveArm = model.arms[1];
  held(part(model, "limb", steel, 0, 0, 0, 0.07, 3.0, 0.07, glaiveArm), glaiveArm, GLAIVE_POSE, 0.54, 1.5, 0.67);
  model.parts.glaive = held(part(model, "gem", paint(CASTELLAN.signal.glaive, 0, true), 0, 0, 0, GEM_SIZE.x, GEM_SIZE.y, GEM_SIZE.z, glaiveArm), glaiveArm, GLAIVE_POSE, 0.54, 3.25, 0.67);

  // The vigil dome: a sphere in metres around the body, hidden outside a vigil.
  const dome = new THREE.Mesh(SHAPES.dome, DOME_MATERIALS[DOME.steps - 1]);
  const g = model.g.scale;
  dome.scale.set(DOME.radius / g.x, DOME.radius / g.y, DOME.radius / g.z);
  dome.position.y = DOME.height;
  dome.visible = false;
  dome.userData.shadeHidden = true;
  model.g.add(dome);
  model.parts.dome = dome;

  // lowered: shield swung aside; vigil: dome up; flare: the Aegis flares; gemFlare: the glaive
  // gem flares (grid windup); steady: Reduce flashes holds the dome still.
  model.rig = { lowered: false, vigil: false, flare: false, gemFlare: false, steady: false, shieldPose: 0, domeLevel: 0, t: null };
  model.animate = animateCastellan;
  return kit.mergeStatic(model);
}

// Shield poses and the dome fade step over whole 15 fps frames (2 and 4 frames); the dome turns
// 0.5 rad/s in stepped time.
function animateCastellan(model, t) {
  const { rig, parts, arms } = model;
  const frames = framesSince(rig, t);
  rig.shieldPose = approach(rig.shieldPose, rig.lowered ? 1 : 0, frames * 0.5);
  const arm = arms[0];
  arm.rotation.x = lerp(SHIELD_RAISED, SHIELD_LOWERED.x, rig.shieldPose);
  arm.rotation.z = -SHIELD_LOWERED.z * rig.shieldPose; // outward: arms[0] is on the -x side
  rig.domeLevel = approach(rig.domeLevel, rig.vigil ? DOME.steps : 0, frames);
  const dome = parts.dome;
  dome.visible = rig.domeLevel > 0;
  if (dome.visible) {
    dome.material = DOME_MATERIALS[rig.domeLevel - 1];
    if (!rig.steady) dome.rotation.y = t * DOME.spin;
  }
  parts.aegis.scale.copy(AEGIS_SIZE).multiplyScalar(rig.flare ? AEGIS_FLARE : 1);
  parts.glaive.scale.copy(GEM_SIZE).multiplyScalar((rig.gemFlare ? GEM_FLARE : 1) * (1 + GEM_PULSE * Math.sin(t * 8)));
}

// The Castellan's toppled shield (F5 death): the shield and its rim lying flat, a prop in metres
// that the keeper AI places in the world until the stage ends. Shared geometry and materials.
export function fallenShield(scale) {
  const group = new THREE.Group();
  const shield = retroMaterial(CASTELLAN.shield, TILE.metal),
    rim = retroMaterial(CASTELLAN.bone, TILE.bone);
  SHIELD_PARTS.forEach(([x, y, z, sx, sy, sz], i) => {
    const mesh = new THREE.Mesh(monsterKit.geo.box, i ? rim : shield);
    mesh.position.set(x * scale.x, z * scale.z, -y * scale.y);
    mesh.scale.set(sx * scale.x, sz * scale.z, sy * scale.y);
    group.add(mesh);
  });
  return group;
}

// ---- the Rift Warden's crown (F6, KEEPERS) ----------------------------------------------------

const CROWN = Object.freeze({ spikes: 5, radius: 0.24, lift: 0.36, tilt: 0.35, size: Object.freeze([0.07, 0.35]) });
const CROWN_LIT = retroMaterial("#54437a", TILE.crystal);
const CROWN_GLOW = unlitMaterial("#ba80ef");

// Five crown spikes ring the Warden's head (model.parts.crown, kept apart so they can glow,
// detach and fall), then the rest of the Wave-1 body is merged. The ORIGINAL Warden keeps its
// Wave-1 model; the director (P1) calls this for KEEPERS only. Idempotent.
export function crownWarden(model) {
  if (!model?.g || model.parts.crown) return model;
  const head = model.parts.head.position,
    [sx, sy] = CROWN.size;
  model.parts.crown = Array.from({ length: CROWN.spikes }, (_, i) => {
    const a = (i / CROWN.spikes) * TAU;
    const spike = new THREE.Mesh(monsterKit.geo.claw, CROWN_LIT);
    spike.position.set(head.x + Math.sin(a) * CROWN.radius, head.y + CROWN.lift, head.z + Math.cos(a) * CROWN.radius);
    spike.scale.set(sx, sy, sx);
    spike.rotation.set(Math.cos(a) * CROWN.tilt, 0, -Math.sin(a) * CROWN.tilt); // leaning outward
    model.body.add(spike);
    return spike;
  });
  return monsterKit.mergeStatic(model);
}

// The crown spikes glow during the CROWN SHARDS windup.
export function setCrownGlow(model, on) {
  for (const spike of model?.parts?.crown ?? []) spike.material = on ? CROWN_GLOW : CROWN_LIT;
}

registerMonsterModel("bellwether", buildBellwether, BELLWETHER);
registerMonsterModel("ironmaw", buildIronMaw, IRON_MAW);
registerMonsterModel("abbot", buildAbbot, ABBOT);
registerMonsterModel("castellan", buildCastellan, CASTELLAN);
