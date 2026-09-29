// Elite add-ons (IMPROVEMENTS F8): per-affix meshes, the double ground torus at
// parts.torusSlot and the sigil above the head at parts.sigilSlot. ctx.elites.apply (P3) calls
// dressElite once per elite, after the elite scale.
//
// The static add-ons (lava plates, fins, crystals, crown spikes, the collar) are folded into the
// host's merged body by mergeStatic, which also merges a Wave-1 host that was one mesh per part,
// so a dressed elite draws fewer calls than its plain Wave-1 kind. The torus is one mesh (both
// rings, each in its affix colour) and the sigil one billboard (dual affixes side by side on one
// texture). WARDED keeps its three bone plates as separate meshes on parts.plateRing, which the
// elite system turns and thins (parts.plates[i].visible).
import * as THREE from "three";
import { monsterKit, setEyes } from "./models.js";
import { unlitMaterial, TILE } from "./materials.js";
import { AFFIXES } from "../data/affixes.js";
import { ICONS } from "../data/icons.js";

const SIGIL = Object.freeze({ size: 0.6, bob: 0.1, rate: 4, alphaTest: 0.5 });
const TORUS = Object.freeze({ inner: 1.3, outer: 1.9, tube: 0.12, opacity: 0.8, lift: 0.06, sides: 4, segments: 28 });
const WARD = Object.freeze({ reach: 1.3, heights: Object.freeze([0.6, 1.0, 1.4]), size: Object.freeze([0.35, 0.45, 0.06]), color: "#d9d2b0" });
const COLLAR = Object.freeze({ color: "#6e6a66", radius: 0.25 });
const COLLAR_RING = new THREE.TorusGeometry(1, 0.32, 4, 10); // tube 0.08 at radius 0.25
// Drawn when an affix has no bitmap yet: a hollow frame keeps the sigil visible.
const NO_ICON = Object.freeze(["########", "#......#", "#......#", "#......#", "#......#", "#......#", "#......#", "########"]);

const TORUS_MATERIAL = unlitMaterial("#ffffff", { vertexColors: true, alphaHash: true, opacity: TORUS.opacity });
const sigilMaterials = new Map(); // "molten+hasted" -> SpriteMaterial

// Head-relative and body-relative add-ons, in the host's body space (Wave-1 layout units).
const ADD_ONS = Object.freeze({
  // Three glowing lava plates on the back and shoulders.
  molten(kit, model, color) {
    const lava = kit.palette(color, TILE.lava, false, 1.2);
    kit.part(model, "box", lava, 0, 1.62, -0.32, 0.28, 0.1, 0.22).rotation.x = -0.4;
    for (const side of [-1, 1]) kit.part(model, "box", lava, side * 0.42, 1.86, -0.04, 0.28, 0.1, 0.22).rotation.z = side * 0.3;
  },
  // Three opaque bone plates orbiting the body (turned and thinned by the elite system).
  warded(kit, model, color, radius) {
    const g = model.g.scale,
      ring = kit.group(model, null, 0, 0, 0, model.g),
      [w, h, d] = WARD.size,
      bone = kit.palette(WARD.color, TILE.bone);
    model.parts.plates = WARD.heights.map((y, i) => {
      const a = (i * Math.PI * 2) / WARD.heights.length,
        reach = radius * WARD.reach;
      const plate = kit.part(model, "box", bone, (Math.sin(a) * reach) / g.x, y, (Math.cos(a) * reach) / g.z, w / g.x, h / g.y, d / g.z, ring);
      plate.rotation.y = a;
      plate.userData.keep = true; // each plate falls away on its own
      return plate;
    });
    model.parts.plateRing = ring;
  },
  // Two swept-back head fins.
  hasted(kit, model, color) {
    const head = model.parts.head.position,
      fin = kit.palette(color, TILE.bone);
    for (const side of [-1, 1]) kit.spike(model, fin, head.x + side * 0.2, head.y + 0.12, head.z - 0.1, 0.06, 0.4, side * 0.6).rotation.x = -1.1;
  },
  // Three back crystals fanned at yaw -0.4, 0, 0.4.
  shardborn(kit, model, color) {
    const crystal = kit.palette(color, TILE.crystal);
    for (const yaw of [-0.4, 0, 0.4]) {
      const shard = kit.part(model, "gem", crystal, Math.sin(yaw) * 0.25, 1.78, -0.3, 0.06, 0.225, 0.06);
      shard.rotation.set(-0.5, yaw, -yaw * 0.6);
    }
  },
  // Three hexer-style crown spikes.
  hexing(kit, model, color) {
    const head = model.parts.head.position,
      spike = kit.palette(color, TILE.bone);
    for (let i = 0; i < 3; i++) kit.spike(model, spike, head.x + (i - 1) * 0.2, head.y + 0.36, head.z - 0.08, 0.07, 0.45, (i - 1) * 0.45);
  },
  // An iron collar at the neck (the chain between the pair is the elite system's fx line).
  bound(kit, model) {
    const head = model.parts.head.position;
    kit.part(model, COLLAR_RING, kit.palette(COLLAR.color, TILE.metal), head.x, head.y - 0.32, head.z - 0.1, COLLAR.radius, COLLAR.radius, COLLAR.radius).rotation.x = Math.PI / 2;
  },
});

// dressElite(model, affixes, { radius }): the elite's add-ons, torus and sigil. `radius` is the
// elite's body radius in metres (def.radius, already x1.1). Call it after the elite scale; the
// sizes are fixed in metres at that scale. Once per model; returns the model.
export function dressElite(model, affixes = [], { radius = 0.5 } = {}) {
  const ids = affixes.filter((id) => AFFIXES[id]);
  if (!model?.g || model.dressing || !ids.length) return model;
  for (const id of ids) ADD_ONS[id](monsterKit, model, AFFIXES[id].color, radius);
  const torus = doubleTorus(model, ids, radius);
  const sigil = sigilSprite(model, ids);
  model.dressing = { torus, sigil };
  const own = model.animate;
  model.animate = own
    ? (m, t, speed) => {
        own(m, t, speed);
        bobSigil(m, t);
      }
    : bobSigil;
  // The merge must start from the authored eyes; threat eyes painted earlier come back after.
  const eyes = model.eyeState;
  if (eyes) setEyes(model, null);
  monsterKit.mergeStatic(model);
  if (eyes) setEyes(model, eyes.color, eyes.scale);
  return model;
}

// Shows or hides the dressing (a burrowed Ashworm keeps it out of sight, F8).
export function showDressing(model, visible) {
  const dressing = model?.dressing;
  if (!dressing) return;
  dressing.torus.visible = dressing.sigil.visible = visible;
  if (model.parts.plateRing) model.parts.plateRing.visible = visible;
}

// The sigil bobs ±0.1 m on the shared 15 fps clock.
function bobSigil(model, t) {
  const sigil = model.dressing.sigil;
  sigil.position.y = (Math.sin(t * SIGIL.rate) * SIGIL.bob) / model.g.scale.y;
}

// Two flat rings (1.3 and 1.9 x radius, tube 0.12) in metres under the root's scale; the inner
// in the first affix colour, the outer in the second (or the first again). Owned geometry.
function doubleTorus(model, ids, radius) {
  const rings = [TORUS.inner, TORUS.outer].map((k) => new THREE.TorusGeometry(radius * k, TORUS.tube, TORUS.sides, TORUS.segments).rotateX(-Math.PI / 2).toNonIndexed());
  const count = rings[0].attributes.position.count + rings[1].attributes.position.count;
  const position = new Float32Array(count * 3),
    color = new Float32Array(count * 3),
    paint = new THREE.Color();
  let at = 0;
  rings.forEach((ring, i) => {
    const source = ring.attributes.position;
    position.set(source.array, at * 3);
    paint.set(AFFIXES[ids[Math.min(i, ids.length - 1)]].color);
    for (let v = 0; v < source.count; v++) paint.toArray(color, (at + v) * 3);
    at += source.count;
    ring.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.computeBoundingSphere();
  const torus = new THREE.Mesh(geometry, TORUS_MATERIAL);
  const g = model.g.scale;
  torus.scale.set(1 / g.x, 1 / g.y, 1 / g.z);
  torus.position.y = TORUS.lift / g.y;
  torus.userData.ownGeometry = true;
  model.parts.torusSlot.add(torus);
  return torus;
}

// One billboard 0.6 m tall, 0.6 m wide per affix, textured with the affix bitmaps in their colours.
function sigilSprite(model, ids) {
  const sprite = new THREE.Sprite(sigilMaterial(ids));
  const g = model.g.scale;
  sprite.scale.set((SIGIL.size * ids.length) / g.x, SIGIL.size / g.y, 1);
  // Decoration only: the mouse-aim raycast (player.pickTarget) walks the whole model and a
  // Sprite would throw there (it needs raycaster.camera) or pull the aim above the head.
  sprite.raycast = () => {};
  model.parts.sigilSlot.add(sprite);
  return sprite;
}

// Nearest-filtered 8n x 8 texture, shared per affix combination, built from data/icons.js.
function sigilMaterial(ids) {
  const key = ids.join("+");
  let material = sigilMaterials.get(key);
  if (material) return material;
  const width = 8 * ids.length,
    data = new Uint8Array(width * 8 * 4);
  ids.forEach((id, k) => {
    const rows = ICONS[id] ?? NO_ICON;
    const hex = parseInt(AFFIXES[id].color.slice(1), 16),
      texel = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) if (rows[y][x] === "#") data.set(texel, ((7 - y) * width + k * 8 + x) * 4); // rows run bottom-up
  });
  const texture = new THREE.DataTexture(data, width, 8);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  material = new THREE.SpriteMaterial({ map: texture, alphaTest: SIGIL.alphaTest });
  sigilMaterials.set(key, material);
  return material;
}
