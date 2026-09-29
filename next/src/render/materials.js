// The PS1 material pipeline. One shared 4x4 atlas of 64x64 cells, point-sampled with affine
// (screen-linear) UVs, and every vertex snapped to the internal pixel grid so geometry wobbles
// like it did on the original hardware. Lit surfaces use retroMaterial; glowing things use
// unlitMaterial, which snaps the same way so projectiles and pickups wobble with the world.
import * as THREE from "three";

// Atlas cells, read left->right, top->bottom.
export const TILE = Object.freeze({
  skin: 0,
  cloth: 1,
  leather: 2,
  metal: 3,
  grass: 4,
  cobble: 5,
  rust: 6,
  bark: 7,
  rock: 8,
  lava: 9,
  brick: 10,
  crystal: 11,
  face: 12,
  bone: 13,
  leaves: 14,
  scratched: 15,
});

// Internal render size shared by every snapped material and the cutaway (updated on resize).
export const retroResolution = new THREE.Vector2(320, 240);

export function setRetroResolution(w, h) {
  retroResolution.set(Math.max(1, w), Math.max(1, h));
}

// Occlusion cutaway: scenery between the camera and the hero is screen-door dithered away in
// an ellipse around the hero. The camera rig writes these every step; `active` is the master
// switch (developer "Disable cutaway" toggle).
export const cutaway = {
  center: { value: new THREE.Vector2(0.5, 0.5) },
  radius: { value: new THREE.Vector2(0.008, 0.012) },
  depth: { value: 0 },
  floor: { value: 0 },
  strength: { value: 0 },
  active: true,
};

// ---- atlas ------------------------------------------------------------------------------

const ATLAS_URL = new URL("../../assets/ps1-atlas.png", import.meta.url).href;

// Grey noise used until (or instead of) the real atlas: same pattern as the original's fallback.
function fallbackPixels() {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    const v = 155 + (((i * 73) ^ ((i >> 4) * 37)) % 70);
    pixels.set([v, v, v, 255], i * 4);
  }
  return pixels;
}

// A plain Texture (not a DataTexture) in browsers, so the loaded image can replace its source.
function createAtlas() {
  const pixels = fallbackPixels();
  const texture =
    typeof ImageData === "function"
      ? new THREE.Texture(new ImageData(pixels, 64, 64))
      : new THREE.DataTexture(new Uint8Array(pixels.buffer), 64, 64);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export const atlas = createAtlas();

let atlasLoading = null;

// Resolves once assets/ps1-atlas.png is on the shared texture. Never rejects: on any failure
// the noise fallback stays in place. A late arrival (after a boot timeout) still swaps in,
// because a new Source makes three allocate a fresh GL texture of the right size.
export function loadAtlas() {
  atlasLoading ??= new Promise((resolve) => {
    if (typeof document === "undefined") return resolve();
    try {
      new THREE.ImageLoader().load(
        ATLAS_URL,
        (image) => {
          atlas.source = new THREE.Source(image);
          atlas.needsUpdate = true;
          resolve();
        },
        undefined,
        () => resolve(),
      );
    } catch {
      resolve();
    }
  });
  return atlasLoading;
}

// ---- shader patches ---------------------------------------------------------------------

// Snap clip-space xy to whole internal pixels (keeps w, so depth and perspective survive).
const SNAP_VERTEX = `
  float retroW = max(0.01, gl_Position.w);
  gl_Position.xy = floor(gl_Position.xy / retroW * retroResolution * 0.5 + 0.5) / (retroResolution * 0.5) * retroW;`;

function afterProjection(source, code) {
  return source.replace("#include <project_vertex>", `#include <project_vertex>\n${code}`);
}

// Vertex snap for any three material whose vertex shader uses <project_vertex> (basic, points,
// lines, lambert). Usable directly as an onBeforeCompile hook.
export function applyVertexSnap(shader) {
  shader.uniforms.retroResolution = { value: retroResolution };
  shader.vertexShader = afterProjection(`uniform vec2 retroResolution;\n${shader.vertexShader}`, SNAP_VERTEX);
}

// Affine UVs + 64-texel tile sampling. uv*w interpolated perspective-correctly and divided by
// interpolated w gives screen-linear UVs: the PS1 texture warp. A baked (merged, mergeStatic)
// mesh carries its tile and its glow per vertex, so parts of every tile share one draw.
const BAKED_VERTEX = "attribute vec2 retroTile;\nattribute vec3 retroGlow;\nvarying vec2 vRetroTile;\nvarying vec3 vRetroGlow;\n";

function applyAtlasSampling(shader, tile, uvAttribute, baked = false) {
  if (!baked) shader.uniforms.atlasTile = { value: new THREE.Vector2(tile % 4, 3 - Math.floor(tile / 4)) };
  const declareUv = uvAttribute === "uv" ? "" : `attribute vec2 ${uvAttribute};\n`;
  shader.vertexShader = afterProjection(
    `varying vec2 affineUV;\nvarying float affineW;\n${baked ? BAKED_VERTEX : ""}${declareUv}${shader.vertexShader}`,
    `  affineW = max(0.01, gl_Position.w);\n  affineUV = ${uvAttribute} * affineW;${baked ? "\n  vRetroTile = retroTile;\n  vRetroGlow = retroGlow;" : ""}`,
  );
  const header = baked ? "varying vec2 vRetroTile;\nvarying vec3 vRetroGlow;\n" : "uniform vec2 atlasTile;\n";
  shader.fragmentShader = `${header}varying vec2 affineUV;\nvarying float affineW;\n${shader.fragmentShader}`.replace(
    "#include <map_fragment>",
    `vec2 atlasTexel = floor(fract(affineUV / affineW) * 64.0);
  diffuseColor *= texture2D(map, (${baked ? "vRetroTile" : "atlasTile"} + (atlasTexel + 0.5) / 64.0) / 4.0);`,
  );
  if (baked)
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += vRetroGlow;",
    );
}

const CUTAWAY_UNIFORMS = [
  ["cutawayCenter", "center"],
  ["cutawayRadius", "radius"],
  ["cutawayDepth", "depth"],
  ["cutawayFloor", "floor"],
  ["cutawayStrength", "strength"],
];

// Fragments nearer than the hero's chest and above their feet, inside the aperture, are
// discarded in a diagonal 4-phase screen-door pattern (3 of 4 pixels at full strength).
function applyCutaway(shader) {
  for (const [name, key] of CUTAWAY_UNIFORMS) shader.uniforms[name] = cutaway[key];
  shader.vertexShader = afterProjection(
    `varying float sceneryDepth;\nvarying float sceneryHeight;\n${shader.vertexShader}`,
    `  sceneryDepth = -mvPosition.z;
  vec4 sceneryWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  sceneryWorld = instanceMatrix * sceneryWorld;
  #endif
  sceneryHeight = (modelMatrix * sceneryWorld).y;`,
  );
  shader.fragmentShader = `uniform vec2 cutawayCenter;
uniform vec2 cutawayRadius;
uniform float cutawayDepth;
uniform float cutawayFloor;
uniform float cutawayStrength;
uniform vec2 retroResolution;
varying float sceneryDepth;
varying float sceneryHeight;
${shader.fragmentShader}`.replace(
    "#include <dithering_fragment>",
    `#include <dithering_fragment>
  if (sceneryDepth < cutawayDepth && sceneryHeight > cutawayFloor) {
    float aperture = length((gl_FragCoord.xy / retroResolution - cutawayCenter) / cutawayRadius);
    float fade = (1.0 - smoothstep(0.65, 1.0, aperture)) * cutawayStrength;
    float checker = mod(floor(gl_FragCoord.x) + 2.0 * floor(gl_FragCoord.y), 4.0);
    if (checker < fade * 3.0) discard;
  }`,
  );
}

// Ambient clock of animated surfaces (seconds, real time): fx.frame advances it every rendered
// frame, so lava keeps flowing behind menus and pauses.
export const retroClock = { value: 0 };

export function advanceRetroClock(dt) {
  if (Number.isFinite(dt) && dt > 0) retroClock.value = (retroClock.value + dt) % 3600;
}

// anim "lava" (IMPROVEMENTS F10, both rulesets): the tile scrolls (0.05, 0.02) per second and the
// glow breathes 0.8..1.0 across the pool by world X, both stepped at 15 fps.
function applyLava(shader) {
  shader.uniforms.retroClock = retroClock;
  shader.vertexShader = afterProjection(
    `uniform float retroClock;\nvarying float lavaPulse;\n${shader.vertexShader}`,
    `  vec4 lavaWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  lavaWorld = instanceMatrix * lavaWorld;
  #endif
  lavaPulse = 0.8 + 0.2 * sin(1.3 * floor(retroClock * 15.0) / 15.0 + (modelMatrix * lavaWorld).x * 0.4);`,
  );
  shader.fragmentShader = `uniform float retroClock;\nvarying float lavaPulse;\n${shader.fragmentShader}`
    .replace("fract(affineUV / affineW)", "fract(affineUV / affineW + floor(retroClock * 15.0) / 15.0 * vec2(0.05, 0.02))")
    .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n  totalEmissiveRadiance *= lavaPulse;");
}

// Enhanced lighting (pref "lighting"): 1 darkens surfaces by their baked ambient occlusion
// (the per-vertex retroAO attribute, built once with the mesh), 0 is the classic look exactly.
export const retroEnhance = { value: 0 };

function applyBakedAO(shader) {
  shader.uniforms.retroEnhance = retroEnhance;
  shader.vertexShader = afterProjection(`attribute float retroAO;\nvarying float vRetroAO;\n${shader.vertexShader}`, "  vRetroAO = retroAO;");
  shader.fragmentShader = `uniform float retroEnhance;\nvarying float vRetroAO;\n${shader.fragmentShader}`.replace(
    "#include <color_fragment>",
    "#include <color_fragment>\n  diffuseColor.rgb *= 1.0 - vRetroAO * retroEnhance;",
  );
}

// Bakes a retroAO attribute darkening the bottom `depth` (fraction of the height) of a
// geometry, strongest at its base: props read as sitting in the ground. Idempotent.
export function bakeBaseAO(geometry, depth = 0.4, strength = 0.42) {
  if (geometry.getAttribute("retroAO")) return geometry;
  const position = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox,
    span = Math.max(1e-4, (max.y - min.y) * depth),
    ao = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const t = Math.min(1, (position.getY(i) - min.y) / span);
    ao[i] = strength * (1 - t) * (1 - t);
  }
  geometry.setAttribute("retroAO", new THREE.BufferAttribute(ao, 1));
  return geometry;
}

// ---- material classes -------------------------------------------------------------------

// The patch lives on the class and reads userData, so material.clone() (enrage tints, dash
// ghosts, per-enemy flash copies) keeps the PS1 look without re-wiring anything.
class RetroLambertMaterial extends THREE.MeshLambertMaterial {
  onBeforeCompile(shader) {
    const { tile = TILE.metal, occlusion = false, uv = "uv", anim = null, baked = false, ao = false } = this.userData.retro ?? {};
    applyVertexSnap(shader);
    applyAtlasSampling(shader, tile, uv, baked);
    if (ao) applyBakedAO(shader);
    if (occlusion) applyCutaway(shader);
    if (anim === "lava") applyLava(shader);
  }
  customProgramCacheKey() {
    const { occlusion = false, uv = "uv", anim = null, baked = false, ao = false } = this.userData.retro ?? {};
    const key = (occlusion ? "ps1-affine-cutaway-v2" : "ps1-affine-v1") + (anim ? `+${anim}` : "") + (baked ? "+baked" : "") + (ao ? "+ao" : "");
    return uv === "uv" ? key : `${key}:${uv}`;
  }
}

class RetroBasicMaterial extends THREE.MeshBasicMaterial {
  onBeforeCompile(shader) {
    applyVertexSnap(shader);
  }
  customProgramCacheKey() {
    return "ps1-snap-basic-v1";
  }
}

// ---- factories --------------------------------------------------------------------------

const WHITE = new THREE.Color("#ffffff");
const cache = new Map();

function colorKey(color) {
  return color?.isColor ? `#${color.getHexString()}` : String(color).toLowerCase();
}

function cached(key, shared, make) {
  if (!shared) return make();
  let material = cache.get(key);
  if (!material) cache.set(key, (material = make()));
  return material;
}

// Lit PS1 surface. Colour is washed 35 % toward white (in linear space, like the original);
// the un-washed colour doubles as emissive, capped at 0.55. `uv` names the UV attribute
// (terrain rock faces pass "cliffUv"). Shared materials are cached by their arguments and must
// not be mutated; pass shared:false for a private copy the caller owns and disposes.
export function retroMaterial(
  color = "#ffffff",
  tile = TILE.metal,
  {
    glow = 0,
    vertexColors = false,
    occlusion = false,
    transparent = false,
    opacity = 1,
    side = THREE.FrontSide,
    uv = "uv",
    shared = true,
    anim = null, // "lava": scrolling, breathing molten surface (applyLava)
    baked = false, // per-vertex tile and glow (merged meshes, mergeStatic)
    ao = false, // the geometry carries a baked retroAO attribute (bakeBaseAO, terrain)
  } = {},
) {
  const cell = Math.min(15, Math.max(0, tile | 0));
  const key = ["lit", colorKey(color), cell, glow, vertexColors, occlusion, transparent, opacity, side, uv, anim, baked, ao].join("|");
  return cached(key, shared, () => {
    const base = new THREE.Color(color);
    const material = new RetroLambertMaterial({
      color: base.clone().lerp(WHITE, 0.35),
      emissive: base,
      emissiveIntensity: Math.min(Math.max(0, glow), 0.55),
      map: atlas,
      vertexColors,
      flatShading: true,
      transparent,
      opacity,
      side,
    });
    material.userData.retro = { tile: cell, occlusion, uv, anim, baked, ao };
    return material;
  });
}

// Unlit flat colour (fogged, untextured) for glow: projectiles, particles, pickups, portal.
// Vertex-snapped unless snap:false. Additive implies transparent and no depth writes. alphaHash
// draws `opacity` as an ordered-dither cutout instead of blending (no sorting, the PS1 way).
export function unlitMaterial(
  color = "#ffffff",
  {
    transparent = false,
    opacity = 1,
    additive = false,
    snap = true,
    side = THREE.FrontSide,
    depthWrite = !additive,
    fog = true,
    shared = true,
    vertexColors = false,
    alphaHash = false,
  } = {},
) {
  const key = ["unlit", colorKey(color), transparent, opacity, additive, snap, side, depthWrite, fog, vertexColors, alphaHash].join("|");
  return cached(key, shared, () => {
    const Kind = snap ? RetroBasicMaterial : THREE.MeshBasicMaterial;
    return new Kind({
      color,
      transparent: !alphaHash && (transparent || additive || opacity < 1),
      alphaHash,
      opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side,
      depthWrite,
      fog,
      vertexColors,
    });
  });
}

// ---- static merge (IMPROVEMENTS §1.4) ------------------------------------------------------

// Every model part is its own mesh, so a detailed keeper would cost dozens of draw calls.
// mergeStatic(model) folds the parts that never move on their own into one mesh per container
// (body, limb group, pivot) and material class: lit parts become one "baked" retro mesh whose
// colour, atlas tile and glow travel per vertex, unlit parts one vertex-coloured basic mesh. The
// look is unchanged, and flash and tint still work through the shared baked paint records.
// Part flags (userData) steer it:
//   keep    never merged (parts that move on their own: the vigil dome, crown spikes, wedge)
//   bucket  merged only within the same bucket: "eyes" stay one mesh setEyes can recolour,
//           "signature" parts stay bright on a shade (models.spectral)
//   part    a named vertex range kept inside the merged mesh (scaleRange: eye boxes, a core)
// Merged geometry belongs to the model (userData.ownGeometry; disposeModel frees it). Calling it
// again after adding parts (elite dressing) folds them into the existing merged meshes. Every
// keeper and creature builder calls it last.
const BAKED = Object.freeze({
  lit: Object.freeze({ vertexColors: true, baked: true }),
  unlit: Object.freeze({ vertexColors: true }),
});
const bakedRecords = new Map();

// The paint record (the render/models.js shape: { color, tile, glow, unlit, base, options, flash,
// tints }) that every merged mesh of a class shares; `options` rebuild its flash and tint variants.
export function bakedPaint(unlit) {
  const key = unlit ? "unlit" : "lit";
  let record = bakedRecords.get(key);
  if (!record) {
    const options = BAKED[key];
    const base = unlit ? unlitMaterial("#ffffff", options) : retroMaterial("#ffffff", TILE.skin, options);
    record = { color: "#ffffff", tile: TILE.skin, glow: 0, unlit, base, options, flash: [], tints: new Map() };
    bakedRecords.set(key, record);
  }
  return record;
}

const mergeScratch = {
  vertex: new THREE.Vector3(),
  normal: new THREE.Matrix3(),
  color: new THREE.Color(),
  glow: new THREE.Color(),
};
const FLIPPED = [0, 2, 1];

const mergeable = (mesh) => !!mesh.userData.paint && !mesh.userData.keep && !mesh.material.transparent;
const vertexCount = (geometry) => (geometry.index ? geometry.index.count : geometry.attributes.position.count);

export function mergeStatic(model) {
  if (!model?.g) return model;
  const containers = [];
  model.g.traverse((node) => {
    if (node.isMesh && mergeable(node) && !containers.includes(node.parent)) containers.push(node.parent);
  });
  const replaced = new Map(); // source mesh -> its merged mesh
  for (const parent of containers) mergeChildren(parent, replaced);
  if (replaced.size) remapParts(model.parts, replaced);
  return model;
}

function mergeChildren(parent, replaced) {
  const buckets = new Map();
  for (const child of parent.children) {
    if (!child.isMesh || !mergeable(child)) continue;
    const key = `${child.userData.bucket ?? "static"}|${child.userData.paint.unlit}`;
    const list = buckets.get(key);
    if (list) list.push(child);
    else buckets.set(key, [child]);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue; // a lone part already costs one draw
    const merged = bake(list);
    for (const source of list) {
      parent.remove(source);
      replaced.set(source, merged);
      // A mesh merged by an earlier pass owned its geometry.
      if (source.userData.ownGeometry) source.geometry.dispose();
    }
    parent.add(merged);
  }
}

function bake(list) {
  const unlit = !!list[0].userData.paint.unlit;
  let total = 0;
  for (const mesh of list) total += vertexCount(mesh.geometry);
  const out = {
    position: new Float32Array(total * 3),
    normal: new Float32Array(total * 3),
    uv: new Float32Array(total * 2),
    color: new Float32Array(total * 3),
    tile: unlit ? null : new Float32Array(total * 2),
    glow: unlit ? null : new Float32Array(total * 3),
  };
  const ranges = {};
  let at = 0;
  for (const mesh of list) at += append(mesh, out, at, ranges);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(out.position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(out.normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(out.uv, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(out.color, 3));
  if (!unlit) {
    geometry.setAttribute("retroTile", new THREE.BufferAttribute(out.tile, 2));
    geometry.setAttribute("retroGlow", new THREE.BufferAttribute(out.glow, 3));
  }
  geometry.computeBoundingSphere();
  const record = bakedPaint(unlit);
  const mesh = new THREE.Mesh(geometry, record.base);
  // Writable like addPart's record, so setEyes can swap a merged eye mesh's paint.
  Object.defineProperty(mesh.userData, "paint", { value: record, writable: true, configurable: true, enumerable: false });
  Object.assign(mesh.userData, { merged: true, ownGeometry: true, ranges });
  if (list[0].userData.bucket) mesh.userData.bucket = list[0].userData.bucket;
  return mesh;
}

// Writes one part's triangles (in its parent's space) at vertex `at`; returns the count written.
function append(mesh, out, at, ranges) {
  mesh.updateMatrix();
  const matrix = mesh.matrix,
    geometry = mesh.geometry,
    { position, normal, uv } = geometry.attributes,
    index = geometry.index,
    count = vertexCount(geometry),
    flip = matrix.determinant() < 0, // a mirrored part keeps its outward winding
    source = mesh.userData.merged ? geometry.attributes : null,
    record = mesh.userData.paint,
    unlit = !out.tile;
  const { vertex, color, glow } = mergeScratch;
  const normals = mergeScratch.normal.getNormalMatrix(matrix);
  if (!source) paintColors(record, color, glow);
  const tileX = record.tile % 4,
    tileY = 3 - Math.floor(record.tile / 4);
  for (let i = 0; i < count; i++) {
    const corner = flip ? i - (i % 3) + FLIPPED[i % 3] : i,
      v = index ? index.getX(corner) : corner,
      o = at + i;
    vertex.fromBufferAttribute(position, v).applyMatrix4(matrix).toArray(out.position, o * 3);
    if (normal) vertex.fromBufferAttribute(normal, v).applyMatrix3(normals).normalize().toArray(out.normal, o * 3);
    if (uv) {
      out.uv[o * 2] = uv.getX(v);
      out.uv[o * 2 + 1] = uv.getY(v);
    }
    if (source) copyBaked(source, v, out, o, unlit);
    else {
      color.toArray(out.color, o * 3);
      if (unlit) continue;
      out.tile[o * 2] = tileX;
      out.tile[o * 2 + 1] = tileY;
      glow.toArray(out.glow, o * 3);
    }
  }
  recordRanges(mesh, out.position, at, count, ranges);
  return count;
}

// A re-merged mesh already carries its per-vertex paint.
function copyBaked(source, v, out, o, unlit) {
  for (let k = 0; k < 3; k++) out.color[o * 3 + k] = source.color.array[v * 3 + k];
  if (unlit) return;
  out.tile[o * 2] = source.retroTile.array[v * 2];
  out.tile[o * 2 + 1] = source.retroTile.array[v * 2 + 1];
  for (let k = 0; k < 3; k++) out.glow[o * 3 + k] = source.retroGlow.array[v * 3 + k];
}

// What a part's own material shows: retroMaterial washes the colour 35 % toward white (linear)
// and glows with the unwashed colour at the capped intensity; unlitMaterial uses it as is.
function paintColors(record, color, glow) {
  color.set(record.color);
  glow.copy(color).multiplyScalar(Math.min(Math.max(0, record.glow || 0), 0.55));
  if (!record.unlit) color.lerp(WHITE, 0.35);
}

// Named parts (and the ranges of a re-merged mesh) keep their vertex range and centre.
function recordRanges(mesh, positions, at, count, ranges) {
  const add = (name, start, length, centre) => {
    (ranges[name] ??= []).push({
      start,
      count: length,
      centre,
      base: positions.slice(start * 3, (start + length) * 3),
      scale: 1,
    });
  };
  if (mesh.userData.part) add(mesh.userData.part, at, count, mesh.position.toArray());
  for (const [name, list] of Object.entries(mesh.userData.ranges ?? {}))
    for (const range of list) add(name, at + range.start, range.count, mergeScratch.vertex.fromArray(range.centre).applyMatrix4(mesh.matrix).toArray());
}

// model.parts is the mesh list (flash/tint repaint) plus named references (eyes, core, ...):
// both now point at the merged meshes.
function remapParts(parts, replaced) {
  if (!parts) return;
  for (let i = parts.length - 1; i >= 0; i--) if (replaced.has(parts[i])) parts.splice(i, 1);
  for (const merged of new Set(replaced.values())) parts.push(merged);
  for (const key of Object.keys(parts)) {
    if (/^\d+$/.test(key)) continue;
    const value = parts[key];
    if (Array.isArray(value)) parts[key] = [...new Set(value.map((item) => replaced.get(item) ?? item))];
    else if (replaced.has(value)) parts[key] = replaced.get(value);
  }
}

// Scales every vertex range named `name` of a merged mesh about its own centre (eye boxes, the
// Abbot's pulsing core). Writes in place; an unchanged scale costs nothing. False if the mesh
// has no such range.
export function scaleRange(mesh, name, scale) {
  const list = mesh?.userData?.ranges?.[name];
  if (!list?.length) return false;
  const attribute = mesh.geometry.attributes.position,
    array = attribute.array;
  for (const range of list) {
    if (range.scale === scale) continue;
    range.scale = scale;
    const [cx, cy, cz] = range.centre;
    for (let i = 0, o = range.start * 3; i < range.count * 3; i += 3, o += 3) {
      array[o] = cx + (range.base[i] - cx) * scale;
      array[o + 1] = cy + (range.base[i + 1] - cy) * scale;
      array[o + 2] = cz + (range.base[i + 2] - cz) * scale;
    }
    attribute.needsUpdate = true;
  }
  return true;
}

// A private copy of `material` drawn as an alphaHash cutout at `opacity` (shade dissolves). The
// caller owns it: flag the mesh userData.phaseMaterial so disposeModel frees it.
export function hashedCopy(material, opacity) {
  const copy = material.clone();
  copy.alphaHash = true;
  copy.transparent = false;
  copy.opacity = opacity;
  return copy;
}
