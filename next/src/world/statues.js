// Skull statues: a stone plinth with a camera-facing skull billboard (PS1 sprite scenery).
// The trial statue gets a gold plinth, a warm skull and a flickering flame so players can
// tell it from the challenge-only curse statues. Curse/trial rules live in encounters.
import * as THREE from "three";
import { retroMaterial, unlitMaterial, TILE } from "../render/materials.js";
import { randomSource } from "../core/rng.js";
import { sceneryShapes } from "./scenery.js";
import { coverBounds } from "./ballistics.js";

const MAX_STATUES = 4;
const ATTEMPTS = 80;
const SPACING = 13;
const SITE_CLEARANCE = 3.4;
const NEARBY_RADIUS = 3.1;
const SKULL_LIVE = "#ffffff";
const SKULL_FALLBACK = "#b53738"; // solid skull colour when the sprite is unavailable
const SKULL_TRIAL = "#ffd9a0";
const SKULL_USED = "#51474a";
const STONE = "#969991";
const TRIAL_GOLD = "#c9a45a";
const STEP = 1 / 60; // face() runs once per simulation step

// Sprite and billboard materials are shared by every stage and live for the page.
let skull = null;
function skullMaterials() {
  if (skull) return skull;
  const make = (color) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, alphaTest: 0.15, side: THREE.DoubleSide });
  skull = { plane: new THREE.PlaneGeometry(2.4, 2.4), live: make(SKULL_LIVE), trial: make(SKULL_TRIAL), used: make(SKULL_USED) };
  const all = [skull.live, skull.trial, skull.used],
    useFallback = () => {
      for (const material of all) {
        material.map = null;
        material.needsUpdate = true;
      }
      skull.live.color.set(SKULL_FALLBACK);
      skull.trial.color.set(SKULL_FALLBACK);
    },
    texture = loadSkullTexture(useFallback);
  if (texture) for (const material of all) material.map = texture;
  else useFallback();
  return skull;
}
function loadSkullTexture(onError) {
  if (typeof document === "undefined") return null;
  try {
    const texture = new THREE.TextureLoader().load("assets/death-skull.png", undefined, undefined, onError);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch {
    return null;
  }
}

// `omen` (KEEPERS, IMPROVEMENTS F12): () -> an omen id or null, drawn once per challenge-only
// statue (drawOmens() after the trial statue is marked, and place()); ORIGINAL passes none.
export function createStatues(terrain, scenery, seed, { omen = null } = {}) {
  const random = randomSource(seed + 29831),
    group = new THREE.Group(),
    { geometries } = sceneryShapes(),
    materials = skullMaterials(),
    stone = retroMaterial(STONE, TILE.cobble),
    gold = retroMaterial(TRIAL_GOLD, TILE.cobble, { glow: 0.35 }),
    flameOuter = unlitMaterial("#ff9a3c"),
    flameInner = unlitMaterial("#ffe38a"),
    list = [],
    parts = new Map();
  group.name = "skull-statues";

  const choices = terrain.reachable.map(terrain.position).filter((p) => {
    const d = Math.hypot(p.x, p.z);
    return d > 13 && d < 49 && terrain.routeDistance(p.x, p.z) > 7 && terrain.clear(p.x, p.z, SITE_CLEARANCE);
  });
  // Up to four separated sites, all standing on the shared navigation surface.
  for (let n = 0; n < ATTEMPTS && list.length < MAX_STATUES && choices.length; n++) {
    const p = choices[Math.floor(random() * choices.length)];
    if (list.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < SPACING) || !terrain.clear(p.x, p.z, SITE_CLEARANCE)) continue;
    list.push(build(p.x, p.z));
  }
  terrain.rebuildNavigation();

  function build(x, z) {
    const y = terrain.height(x, z),
      base = mesh(geometries.box, stone, x, y + 0.2, z, 2, 0.4, 2),
      pillar = mesh(geometries.box, stone, x, y + 1.1, z, 1.1, 1.8, 1.1),
      sprite = new THREE.Mesh(materials.plane, materials.live),
      flame = new THREE.Group();
    sprite.position.set(x, y + 2.75, z);
    flame.add(mesh(geometries.gem, flameOuter, 0, 0, 0, 0.32, 0.62, 0.32), mesh(geometries.gem, flameInner, 0, -0.04, 0, 0.17, 0.36, 0.17));
    flame.position.set(x, y + 4.4, z);
    flame.visible = false;
    group.add(base, pillar, sprite, flame);
    terrain.addObstacle({ x, z, r: 1.05 });
    const cover = { shape: "box", x, y: y + 1, z, sx: 1.3, sy: 2, sz: 1.3, rotation: 0 };
    cover.bounds = coverBounds(cover);
    scenery.covers.push(cover);
    const statue = { x, z, y, used: false, trial: false, rewarded: false, omen: null };
    parts.set(statue, { base, sprite, flame, phase: (x * 12.9898 + z * 78.233) % 6.28 });
    return statue;
  }
  // The statue's omen: drawn among those no other statue of this stage holds while any remain.
  function drawOmen(statue) {
    const held = list.filter((s) => s !== statue && s.omen).map((s) => s.omen);
    statue.omen = omen?.(held) ?? null;
  }
  function mesh(geometry, material, x, y, z, sx, sy, sz) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    return m;
  }
  function refresh(statue) {
    const part = parts.get(statue),
      lit = statue.trial && !statue.used;
    part.sprite.material = statue.used ? materials.used : lit ? materials.trial : materials.live;
    part.base.material = lit ? gold : stone;
    part.flame.visible = lit;
  }

  let time = 0;
  return {
    group,
    list,
    // First unused statue within 3.1 m horizontally. Accepts (x, z) or an object with x/z.
    nearby(x, z) {
      const px = typeof x === "object" ? x?.x : x,
        pz = typeof x === "object" ? x?.z : z;
      return list.find((s) => !s.used && Math.hypot(px - s.x, pz - s.z) < NEARBY_RADIUS) || null;
    },
    // Y-axis billboards toward the camera; also flickers the trial flame. Called every step.
    face(camera) {
      const cam = camera?.position || camera;
      if (!cam) return;
      time += STEP;
      for (const statue of list) {
        const part = parts.get(statue);
        part.sprite.rotation.y = Math.atan2(cam.x - statue.x, cam.z - statue.z);
        if (!part.flame.visible) continue;
        const flicker = Math.sin(time * 17 + part.phase) * 0.16 + Math.sin(time * 31 + part.phase * 2) * 0.08;
        part.flame.scale.set(1 - flicker * 0.4, 1 + flicker, 1 - flicker * 0.4);
        part.flame.rotation.y = time * 2.2 + part.phase;
      }
    },
    // Marks a statue used and darkens its skull; false if it was already used.
    activate(statue) {
      if (!statue || statue.used || !parts.has(statue)) return false;
      statue.used = true;
      refresh(statue);
      return true;
    },
    // Designates (or clears) the Skull Trial statue. `rewarded` mirrors the original flag.
    markTrial(statue, on = true) {
      if (!parts.has(statue)) return;
      statue.trial = statue.rewarded = on;
      refresh(statue);
    },
    // KEEPERS: one omen per challenge-only statue, in placement order (after markTrial).
    drawOmens() {
      for (const statue of list) if (!statue.trial) drawOmen(statue);
    },
    // A statue at the walkable spot nearest (x, z): kind "trial" (the stage's Skull Trial
    // statue) or "curse" (challenge-only, with its omen under KEEPERS). Practice (h.placeStatue)
    // places them near the player at run time; navigation is rebuilt for the new footprint.
    place(x, z, kind = "curse") {
      const p = terrain.safeNear(x, z, SITE_CLEARANCE),
        statue = build(p.x, p.z);
      list.push(statue);
      terrain.rebuildNavigation();
      if (kind === "trial") statue.trial = statue.rewarded = true;
      else drawOmen(statue);
      refresh(statue);
      return statue;
    },
    dispose() {
      group.removeFromParent();
    },
  };
}

// Stand-in for worlds without statues (the tutorial): same API, nothing to find.
export function noStatues() {
  return {
    group: null,
    list: [],
    nearby: () => null,
    face() {},
    activate: () => false,
    markTrial() {},
    drawOmens() {},
    place: () => null,
    dispose() {},
  };
}
