// Transient visual effects: pooled particles, expanding rings, effect lines and tracers, gibs,
// ground decals, blob shadows, floating damage numbers, the hurt frame and hit-stop.
// Everything that ages does so in update(dt) (simulation time), so pause, reward cards and
// overlays freeze it like the original; frame(dt) only re-projects the DOM numbers, re-drapes
// blob shadows under moving actors and fades the hurt frame.
import * as THREE from "three";
import { unlitMaterial, retroMaterial, advanceRetroClock, TILE } from "./materials.js";
import { ZONE_STYLES } from "../data/hazards.js";
import { clamp, TAU } from "../core/util.js";

const PARTICLE_CAP = 361; // the original stops spawning once more than 360 are alive
const PARTICLE_GRAVITY = 12;
const RING_CAP = 64;
const RING_OPACITY = 0.7;
const RING_OPACITY_REDUCED = 0.5; // Reduce flashes caps explosion rings (IMPROVEMENTS F17)
const LINE_WIDTH = 0.09;
const TRACER_CAP = 128;
const TRACER_LIFE = 0.07;
const TRACER_WIDTH = 0.07;
const GIB_CAP = 120;
const GIB_GRAVITY = 16;
const GIB_FADE = 0.45; // gibs shrink away over their final moments
const DECAL_CAP = 40;
const DECAL_LIFT = 0.045;
const SHADOW_CAP = 128;
const SHADOW_LIFT = 0.03;
const SHADOW_ORPHAN = 2; // seconds a detached object keeps its shadow slot before it is dropped
const NUMBER_CAP = 26;
const NUMBER_LIFE = 0.7;
const LABEL_LIFE = 1.2; // worded labels (fx.label, number text) stay long enough to read
const NUMBER_RISE = 1.7;
const NUMBER_HEIGHT = 2.2;
const MERGE_WINDOW = 0.15; // hits on one target closer together than this share a number...
const MERGE_AGE = 0.45; // ...until that number has floated this long, so a stream re-anchors
const HITSTOP_CAP = 0.1;
const HURT_DECAY = 4;
const HURT_OPACITY = 0.6;

const rand = (a, b) => a + Math.random() * (b - a);

// Scratch objects shared by every pool; nothing below allocates per frame.
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _world = new THREE.Vector3();
const _color = new THREE.Color();
const _tint = new THREE.Color();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color("#ffffff");
const SHADOW_COLOR = new THREE.Color("#0b0a10");
const GIB_FLESH = new THREE.Color("#3a2a2c");
const SPLAT_DARK = new THREE.Color("#1d1618");

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// A vertex-snapped unlit material this module owns, for effects that animate their own colour
// or opacity (the shared cached ones must never be mutated).
export function privateUnlitMaterial(color, options = {}) {
  return unlitMaterial(color, { ...options, shared: false });
}

// Terrain height that tolerates a world that is not built yet.
export function groundAt(ctx, x, z) {
  const world = ctx.world;
  if (!world?.terrain) return 0;
  const h = world.height(x, z);
  return Number.isFinite(h) ? h : 0;
}

// Screen-door transparency: fragments are discarded against a 4x4 Bayer threshold in internal
// pixels (the PS1/Saturn mesh-transparency look), so soft alpha needs no blending or sorting.
const SCREEN_DOOR = `
  {
    vec2 sdCell = mod(floor(gl_FragCoord.xy), 4.0);
    vec2 sdHalf = floor(sdCell * 0.5);
    float sdA = mod(mod(sdCell.x, 2.0) * 2.0 + mod(sdCell.y, 2.0) * 3.0, 4.0);
    float sdB = mod(sdHalf.x * 2.0 + sdHalf.y * 3.0, 4.0);
    if (diffuseColor.a * 16.0 <= sdA * 4.0 + sdB + 0.5) discard;
  }
  #include <opaque_fragment>`;

// Wraps the snapped material's own shader hook, so the PS1 vertex snap still applies.
function screenDoorMaterial() {
  const material = privateUnlitMaterial("#ffffff", { side: THREE.DoubleSide, depthWrite: false });
  const snap = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    snap.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", SCREEN_DOOR);
  };
  material.customProgramCacheKey = () => key + "|screen-door";
  material.vertexColors = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -4;
  return material;
}

// Fixed-capacity instanced pool. Per-instance state lives in one strided Float32Array and dead
// entries are swap-removed, so live instances stay packed at the front of a single draw call.
//   step(data, offset, dt) -> false when the entry has expired
//   pose(data, offset)     -> the instance Matrix4 (a shared scratch matrix)
function createInstancePool({ geometry, material, cap, stride, lifeField, recycle, step, pose }) {
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.visible = false;
  const data = new Float32Array(cap * stride),
    colors = mesh.instanceColor;
  let n = 0;

  function sync(recolored) {
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (recolored) colors.needsUpdate = true;
  }

  // A free slot; when full, either nothing (-1) or the entry with the least life left.
  function claim() {
    if (n < cap) return n++;
    if (!recycle) return -1;
    let best = 0;
    for (let i = 1; i < n; i++) if (data[i * stride + lifeField] < data[best * stride + lifeField]) best = i;
    return best;
  }

  function removeAt(i) {
    n--;
    if (i === n) return;
    data.copyWithin(i * stride, n * stride, n * stride + stride);
    colors.setXYZ(i, colors.getX(n), colors.getY(n), colors.getZ(n));
  }

  return {
    mesh,
    data,
    claim,
    full: () => !recycle && n >= cap,
    // Call after filling a claimed slot: colour it and pose it at once, so an entry spawned
    // outside the effects step (pause, cinematics) never shows a stale matrix.
    commit(i, color) {
      colors.setXYZ(i, color.r, color.g, color.b);
      mesh.setMatrixAt(i, pose(data, i * stride));
      sync(true);
    },
    update(dt) {
      if (!n) return;
      let removed = false;
      for (let i = 0; i < n; ) {
        if (step(data, i * stride, dt)) {
          mesh.setMatrixAt(i, pose(data, i * stride));
          i++;
        } else {
          removeAt(i);
          removed = true;
        }
      }
      sync(removed);
    },
    clear() {
      n = 0;
      sync(false);
    },
    count: () => n,
  };
}

// ---- particles: the original burst cubes, gravity 12, spin, exp(-1.5 dt) shrink ---------------

// Strided fields: position, velocity, spin angles, size, life.
const PX = 0, PY = 1, PZ = 2, PVX = 3, PVY = 4, PVZ = 5, PRX = 6, PRZ = 7, PSIZE = 8, PLIFE = 9;
const PARTICLE_STRIDE = 10;

function createParticles(mount, ground) {
  let shrink = 1;
  const pool = createInstancePool({
    geometry: UNIT_BOX,
    material: unlitMaterial("#ffffff"),
    cap: PARTICLE_CAP,
    stride: PARTICLE_STRIDE,
    lifeField: PLIFE,
    recycle: false,
    step(d, o, dt) {
      d[o + PLIFE] -= dt;
      if (d[o + PLIFE] <= 0) return false;
      d[o + PVY] -= PARTICLE_GRAVITY * dt;
      d[o + PX] += d[o + PVX] * dt;
      d[o + PY] += d[o + PVY] * dt;
      d[o + PZ] += d[o + PVZ] * dt;
      d[o + PRX] += 5 * dt;
      d[o + PRZ] += 3 * dt;
      d[o + PSIZE] *= shrink;
      return true;
    },
    pose(d, o) {
      _euler.set(d[o + PRX], 0, d[o + PRZ]);
      _quat.setFromEuler(_euler);
      _pos.set(d[o + PX], d[o + PY], d[o + PZ]);
      _scale.setScalar(d[o + PSIZE]);
      return _mat.compose(_pos, _quat, _scale);
    },
  });

  function burst(x, y, z, color, count, speed) {
    if (!(count > 0) || pool.full()) return;
    mount(pool.mesh);
    const base = y + ground(x, z),
      d = pool.data;
    _color.set(color);
    for (let c = 0; c < count; c++) {
      const i = pool.claim();
      if (i < 0) break;
      const o = i * PARTICLE_STRIDE;
      d[o + PX] = x;
      d[o + PY] = base;
      d[o + PZ] = z;
      d[o + PVX] = rand(-1, 1) * speed;
      d[o + PVY] = rand(0.3, 1.7) * speed;
      d[o + PVZ] = rand(-1, 1) * speed;
      d[o + PRX] = d[o + PRZ] = 0;
      d[o + PSIZE] = rand(0.055, 0.17);
      d[o + PLIFE] = rand(0.25, 0.65);
      pool.commit(i, _color);
    }
  }

  return {
    burst,
    update(dt) {
      shrink = Math.exp(-1.5 * dt);
      pool.update(dt);
    },
    clear: pool.clear,
    count: pool.count,
  };
}

// ---- rings -----------------------------------------------------------------------------------

// `peak()` is the opacity a new ring starts from.
function createRings(mount, ground, peak) {
  const geometry = new THREE.RingGeometry(0.9, 1, 12);
  const pool = [];

  function make() {
    const material = privateUnlitMaterial("#ffffff", { transparent: true, opacity: RING_OPACITY, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    const ring = { mesh, life: 0, max: 1, size: 1, peak: RING_OPACITY };
    pool.push(ring);
    return ring;
  }

  // A free ring, a new one while under the cap, else the one closest to finishing.
  function acquire() {
    let oldest = null;
    for (const r of pool) {
      if (r.life <= 0) return r;
      if (!oldest || r.life / r.max < oldest.life / oldest.max) oldest = r;
    }
    return pool.length < RING_CAP ? make() : oldest;
  }

  function spawn(x, z, color, size, life) {
    if (!(life > 0) || !(size > 0)) return;
    const r = acquire();
    mount(r.mesh);
    r.life = r.max = life;
    r.size = size;
    r.peak = peak();
    r.mesh.material.color.set(color);
    r.mesh.material.opacity = r.peak;
    r.mesh.position.set(x, ground(x, z) + 0.12, z);
    r.mesh.scale.setScalar(1e-3);
    r.mesh.visible = true;
  }

  // Expands 0 -> size while fading from its peak (0.7, or 0.5 with Reduce flashes) to 0.
  function update(dt) {
    for (const r of pool) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      const left = r.life / r.max;
      r.mesh.scale.setScalar(Math.max(1e-3, r.size * (1 - left)));
      r.mesh.material.opacity = r.peak * left;
    }
  }

  function clear() {
    for (const r of pool) {
      r.life = 0;
      r.mesh.visible = false;
    }
  }

  function count() {
    let c = 0;
    for (const r of pool) if (r.life > 0) c++;
    return c;
  }

  return { spawn, update, clear, count };
}

// ---- effect lines (storm arcs, rift scars, wake segments, anchor links) ----------------------

function createLines(mount) {
  const spare = [];
  const live = new Set();

  // Handles are never reused, so a stale handle kept by its owner after clear() is inert.
  class EffectLine {
    constructor(mesh, life, width) {
      this.mesh = mesh;
      this.life = life;
      this.width = width;
      this.dead = false;
    }
    update(a, b) {
      if (!this.dead && a && b) place(this, a, b);
      return this;
    }
    remove() {
      release(this);
    }
  }

  // Unit box stretched between the points: 0.09 cross-section, minimum length 0.05.
  function place(h, a, b) {
    const m = h.mesh;
    m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    m.scale.set(h.width, h.width, Math.max(0.05, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)));
    m.lookAt(b.x, b.y, b.z);
  }

  function release(h) {
    if (!(h instanceof EffectLine) || h.dead) return;
    h.dead = true;
    live.delete(h);
    h.mesh.visible = false;
    spare.push(h.mesh);
    h.mesh = null;
  }

  // life <= 0 or non-finite keeps the line until its owner removes it.
  function spawn(a, b, color, life, width) {
    const material = unlitMaterial(color);
    let mesh = spare.pop();
    if (mesh) mesh.material = material;
    else mesh = new THREE.Mesh(UNIT_BOX, material);
    mesh.visible = true;
    mount(mesh);
    const h = new EffectLine(mesh, life > 0 && Number.isFinite(life) ? life : Infinity, width > 0 ? width : LINE_WIDTH);
    live.add(h);
    if (a && b) place(h, a, b);
    return h;
  }

  function update(dt) {
    for (const h of live) {
      if (h.life === Infinity) continue;
      h.life -= dt;
      if (h.life <= 0) release(h);
    }
  }

  function clear() {
    for (const h of live) release(h);
  }

  return { spawn, release, update, clear, isLine: (h) => h instanceof EffectLine, count: () => live.size };
}

// ---- tracers: a fast round's swept segment drawn as a streak whose tail catches the head -----

const TAX = 0, TAY = 1, TAZ = 2, TBX = 3, TBY = 4, TBZ = 5, TLIFE = 6;
const TRACER_STRIDE = 7;

function createTracers(mount) {
  const pool = createInstancePool({
    geometry: UNIT_BOX,
    material: unlitMaterial("#ffffff"),
    cap: TRACER_CAP,
    stride: TRACER_STRIDE,
    lifeField: TLIFE,
    recycle: true,
    step(d, o, dt) {
      d[o + TLIFE] -= dt;
      return d[o + TLIFE] > 0;
    },
    pose(d, o) {
      const k = d[o + TLIFE] / TRACER_LIFE,
        dx = d[o + TBX] - d[o + TAX],
        dy = d[o + TBY] - d[o + TAY],
        dz = d[o + TBZ] - d[o + TAZ];
      _dir.set(dx, dy, dz).normalize();
      _quat.setFromUnitVectors(AXIS_Z, _dir);
      // The tail sits at a + (b - a)(1 - k), so the streak's centre is at 1 - k/2.
      const t = 1 - k / 2,
        w = TRACER_WIDTH * (0.4 + 0.6 * k);
      _pos.set(d[o + TAX] + dx * t, d[o + TAY] + dy * t, d[o + TAZ] + dz * t);
      _scale.set(w, w, Math.max(0.02, Math.hypot(dx, dy, dz) * k));
      return _mat.compose(_pos, _quat, _scale);
    },
  });

  function spawn(a, b, color) {
    if (!a || !b) return;
    mount(pool.mesh);
    const i = pool.claim(),
      o = i * TRACER_STRIDE,
      d = pool.data;
    d[o + TAX] = a.x;
    d[o + TAY] = a.y;
    d[o + TAZ] = a.z;
    d[o + TBX] = b.x;
    d[o + TBY] = b.y;
    d[o + TBZ] = b.z;
    d[o + TLIFE] = TRACER_LIFE;
    pool.commit(i, _color.set(color));
  }

  return { spawn, update: pool.update, clear: pool.clear, count: pool.count };
}

// ---- gibs: faceted chunks that arc out, bounce once on the terrain, settle and shrink away ---

// Strided fields: position, velocity, rotation, spin rates, scale, life, bounce state.
const GX = 0, GY = 1, GZ = 2, GVX = 3, GVY = 4, GVZ = 5, GRX = 6, GRY = 7, GRZ = 8;
const GWX = 9, GWY = 10, GWZ = 11, GSX = 12, GSY = 13, GSZ = 14, GLIFE = 15, GBOUNCE = 16;
const GIB_STRIDE = 17;

function createGibs(mount, ground) {
  const pool = createInstancePool({
    geometry: new THREE.IcosahedronGeometry(1, 0),
    material: retroMaterial("#ffffff", TILE.skin),
    cap: GIB_CAP,
    stride: GIB_STRIDE,
    lifeField: GLIFE,
    recycle: true,
    step(d, o, dt) {
      d[o + GLIFE] -= dt;
      if (d[o + GLIFE] <= 0) return false;
      if (d[o + GBOUNCE] < 2) fly(d, o, dt);
      return true;
    },
    pose(d, o) {
      const k = Math.min(1, d[o + GLIFE] / GIB_FADE);
      _euler.set(d[o + GRX], d[o + GRY], d[o + GRZ]);
      _quat.setFromEuler(_euler);
      _pos.set(d[o + GX], d[o + GY], d[o + GZ]);
      _scale.set(d[o + GSX] * k, d[o + GSY] * k, d[o + GSZ] * k);
      return _mat.compose(_pos, _quat, _scale);
    },
  });

  function fly(d, o, dt) {
    d[o + GVY] -= GIB_GRAVITY * dt;
    d[o + GX] += d[o + GVX] * dt;
    d[o + GY] += d[o + GVY] * dt;
    d[o + GZ] += d[o + GVZ] * dt;
    d[o + GRX] += d[o + GWX] * dt;
    d[o + GRY] += d[o + GWY] * dt;
    d[o + GRZ] += d[o + GWZ] * dt;
    const rest = ground(d[o + GX], d[o + GZ]) + d[o + GSY] * 0.5;
    if (d[o + GY] > rest || d[o + GVY] >= 0) return;
    d[o + GY] = rest;
    // First contact bounces with lost energy; the second (or a soft first) settles the chunk.
    if (d[o + GBOUNCE] === 0 && d[o + GVY] < -1.5) {
      d[o + GVY] *= -0.35;
      d[o + GVX] *= 0.5;
      d[o + GVZ] *= 0.5;
      d[o + GWX] *= 0.5;
      d[o + GWY] *= 0.5;
      d[o + GWZ] *= 0.5;
      d[o + GBOUNCE] = 1;
      return;
    }
    d.fill(0, o + GVX, o + GVZ + 1);
    d.fill(0, o + GWX, o + GWZ + 1);
    d[o + GBOUNCE] = 2;
  }

  function spawn(x, z, color, count, size) {
    if (!(count > 0) || !(size > 0)) return;
    mount(pool.mesh);
    const floor = ground(x, z),
      d = pool.data;
    // Instance colours bypass retroMaterial's 35 % wash toward white, so apply it here to keep
    // chunks in the same palette as the monster that shed them.
    _color.set(color).lerp(WHITE, 0.35);
    for (let c = 0; c < Math.min(count, 16); c++) {
      const o = pool.claim() * GIB_STRIDE,
        heading = rand(0, TAU),
        speed = rand(1.4, 4),
        s = size * rand(0.7, 1.3);
      d[o + GX] = x + rand(-0.3, 0.3);
      d[o + GY] = floor + rand(0.6, 1.3);
      d[o + GZ] = z + rand(-0.3, 0.3);
      d[o + GVX] = Math.sin(heading) * speed;
      d[o + GVY] = rand(2.8, 6);
      d[o + GVZ] = Math.cos(heading) * speed;
      d[o + GRX] = rand(0, TAU);
      d[o + GRY] = rand(0, TAU);
      d[o + GRZ] = rand(0, TAU);
      d[o + GWX] = rand(-9, 9);
      d[o + GWY] = rand(-6, 6);
      d[o + GWZ] = rand(-9, 9);
      d[o + GSX] = s;
      d[o + GSY] = s * rand(0.6, 0.9);
      d[o + GSZ] = s * rand(0.8, 1.1);
      d[o + GLIFE] = rand(1.5, 2.3);
      d[o + GBOUNCE] = 0;
      pool.commit(o / GIB_STRIDE, _color);
    }
  }

  return { spawn, update: pool.update, clear: pool.clear, count: pool.count };
}

// ---- draped discs shared by decals and blob shadows: centre, inner ring, rim ------------------

const DISC_SEGS = 12;
const DISC_VERTS = 1 + DISC_SEGS * 2;
const DISC_INDICES = DISC_SEGS * 9; // 12 fan + 24 band triangles
const DISC_INNER = 0.55;
const UNIT_DISC = new Float32Array(DISC_VERTS * 2);
for (let j = 0; j < DISC_SEGS; j++) {
  const a = (j / DISC_SEGS) * TAU,
    s = Math.sin(a),
    c = Math.cos(a);
  UNIT_DISC.set([s * DISC_INNER, c * DISC_INNER], (1 + j) * 2);
  UNIT_DISC.set([s, c], (1 + DISC_SEGS + j) * 2);
}

function createDiscLayer(slots, renderOrder) {
  const index = new Uint16Array(slots * DISC_INDICES);
  let o = 0;
  for (let s = 0; s < slots; s++) {
    const c = s * DISC_VERTS;
    for (let j = 0; j < DISC_SEGS; j++) {
      const i0 = c + 1 + j,
        i1 = c + 1 + ((j + 1) % DISC_SEGS),
        o0 = i0 + DISC_SEGS,
        o1 = i1 + DISC_SEGS;
      index[o++] = c;
      index[o++] = i0;
      index[o++] = i1;
      index[o++] = i0;
      index[o++] = o0;
      index[o++] = o1;
      index[o++] = i0;
      index[o++] = o1;
      index[o++] = i1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(slots * DISC_VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.BufferAttribute(new Float32Array(slots * DISC_VERTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  geometry.setAttribute("color", color);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  const mesh = new THREE.Mesh(geometry, screenDoorMaterial());
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, geometry, position: position.array, color: color.array, attrs: [position, color] };
}

// Writes one disc into `slot`: local offsets (x, z pairs) scaled by `size` and turned by `turn`,
// every vertex sampled on the terrain so the disc drapes over slopes and ledges.
function drapeDisc(layer, slot, cx, cz, local, localOffset, size, turn, lift, ground) {
  const c = Math.cos(turn),
    s = Math.sin(turn),
    pos = layer.position;
  for (let v = 0; v < DISC_VERTS; v++) {
    const lx = local[localOffset + v * 2] * size,
      lz = local[localOffset + v * 2 + 1] * size;
    const x = cx + lx * c + lz * s,
      z = cz - lx * s + lz * c,
      p = (slot * DISC_VERTS + v) * 3;
    pos[p] = x;
    pos[p + 1] = ground(x, z) + lift;
    pos[p + 2] = z;
  }
}

function collapseDisc(layer, slot) {
  layer.position.fill(0, slot * DISC_VERTS * 3, (slot + 1) * DISC_VERTS * 3);
}

function markDirty(layer) {
  for (const a of layer.attrs) a.needsUpdate = true;
}

// ---- decals: flat dithered splats and scorches that dissolve out ------------------------------

function createDecals(mount, ground) {
  const layer = createDiscLayer(DECAL_CAP, 1);
  const local = new Float32Array(DECAL_CAP * DISC_VERTS * 2);
  const baseAlpha = new Float32Array(DECAL_CAP * DISC_VERTS);
  const life = new Float32Array(DECAL_CAP),
    fade = new Float32Array(DECAL_CAP);
  layer.geometry.setDrawRange(0, DECAL_CAP * DISC_INDICES);
  for (let s = 0; s < DECAL_CAP; s++) collapseDisc(layer, s);

  function acquire() {
    let best = 0;
    for (let s = 0; s < DECAL_CAP; s++) {
      if (life[s] <= 0) return s;
      if (life[s] < life[best]) best = s;
    }
    return best;
  }

  // Ragged outline: every rim vertex gets its own radius so no two splats match.
  function shape(slot) {
    const o = slot * DISC_VERTS * 2,
      a = slot * DISC_VERTS;
    local[o] = local[o + 1] = 0;
    baseAlpha[a] = 1;
    for (let j = 0; j < DISC_SEGS; j++) {
      const angle = ((j + rand(-0.3, 0.3)) / DISC_SEGS) * TAU,
        s = Math.sin(angle),
        c = Math.cos(angle),
        inner = DISC_INNER * rand(0.85, 1.1),
        rim = rand(0.72, 1.05);
      local[o + (1 + j) * 2] = s * inner;
      local[o + (1 + j) * 2 + 1] = c * inner;
      local[o + (1 + DISC_SEGS + j) * 2] = s * rim;
      local[o + (1 + DISC_SEGS + j) * 2 + 1] = c * rim;
      baseAlpha[a + 1 + j] = 0.95;
      baseAlpha[a + 1 + DISC_SEGS + j] = rand(0.3, 0.55);
    }
  }

  function paint(slot, k) {
    const col = layer.color;
    for (let v = 0; v < DISC_VERTS; v++) col[(slot * DISC_VERTS + v) * 4 + 3] = baseAlpha[slot * DISC_VERTS + v] * k;
  }

  function spawn(x, z, color, size, duration) {
    if (!(size > 0) || !(duration > 0)) return;
    mount(layer.mesh);
    const slot = acquire();
    life[slot] = duration;
    fade[slot] = Math.min(2, duration * 0.4);
    shape(slot);
    drapeDisc(layer, slot, x, z, local, slot * DISC_VERTS * 2, size, rand(0, TAU), DECAL_LIFT, ground);
    _color.set(color);
    const col = layer.color;
    for (let v = 0; v < DISC_VERTS; v++) {
      const p = (slot * DISC_VERTS + v) * 4;
      col[p] = _color.r;
      col[p + 1] = _color.g;
      col[p + 2] = _color.b;
    }
    paint(slot, 1);
    layer.mesh.visible = true;
    markDirty(layer);
  }

  function update(dt) {
    if (!layer.mesh.visible) return;
    let dirty = false,
      alive = 0;
    for (let s = 0; s < DECAL_CAP; s++) {
      if (life[s] <= 0) continue;
      life[s] -= dt;
      if (life[s] <= 0) {
        collapseDisc(layer, s);
        dirty = true;
      } else {
        alive++;
        if (life[s] < fade[s]) {
          paint(s, life[s] / fade[s]);
          dirty = true;
        }
      }
    }
    if (dirty) markDirty(layer);
    layer.mesh.visible = alive > 0;
  }

  function clear() {
    life.fill(0);
    for (let s = 0; s < DECAL_CAP; s++) collapseDisc(layer, s);
    markDirty(layer);
    layer.mesh.visible = false;
  }

  function count() {
    let c = 0;
    for (let s = 0; s < DECAL_CAP; s++) if (life[s] > 0) c++;
    return c;
  }

  return { spawn, update, clear, count };
}

// ---- blob shadows: dithered dark discs that follow an object and drape at ground height ------

function createShadows(mount, ground) {
  const layer = createDiscLayer(SHADOW_CAP, 2);
  const byObject = new Map();
  for (let s = 0; s < SHADOW_CAP; s++) {
    const col = layer.color;
    for (let v = 0; v < DISC_VERTS; v++) {
      const p = (s * DISC_VERTS + v) * 4;
      col[p] = SHADOW_COLOR.r;
      col[p + 1] = SHADOW_COLOR.g;
      col[p + 2] = SHADOW_COLOR.b;
    }
  }

  class BlobShadow {
    constructor(object, radius) {
      this.object = object;
      this.radius = radius;
      this.baseScale = Math.abs(object.scale?.x) || 1;
      this.orphaned = 0;
      this.dead = false;
    }
    remove() {
      release(this);
    }
  }

  function release(h) {
    const handle = h instanceof BlobShadow ? h : byObject.get(h);
    if (!handle || handle.dead) return;
    handle.dead = true;
    byObject.delete(handle.object);
  }

  // One shadow per object: registering again (e.g. the hero on every run) updates the radius.
  function add(object, radius = 0.6) {
    if (!object?.isObject3D) return null;
    const r = radius > 0 ? radius : 0.6;
    const existing = byObject.get(object);
    if (existing) {
      existing.radius = r;
      return existing;
    }
    const handle = new BlobShadow(object, r);
    byObject.set(object, handle);
    return handle;
  }

  // 1 = visible in the scene, 0 = in the scene but hidden, -1 = detached from any scene.
  function presence(object) {
    let visible = true,
      top = object;
    for (let o = object; o; o = o.parent) {
      if (!o.visible) visible = false;
      top = o;
    }
    if (!top.isScene) return -1;
    return visible ? 1 : 0;
  }

  function writeAlpha(slot, k) {
    const col = layer.color,
      base = slot * DISC_VERTS * 4;
    col[base + 3] = 0.62 * k;
    for (let j = 0; j < DISC_SEGS; j++) {
      col[base + (1 + j) * 4 + 3] = 0.58 * k;
      col[base + (1 + DISC_SEGS + j) * 4 + 3] = 0;
    }
  }

  function frame(dt) {
    if (!byObject.size) {
      layer.mesh.visible = false;
      return;
    }
    mount(layer.mesh);
    let slot = 0;
    for (const h of byObject.values()) {
      const state = presence(h.object);
      if (state < 0) {
        h.orphaned += dt;
        if (h.orphaned > SHADOW_ORPHAN) release(h);
        continue;
      }
      h.orphaned = 0;
      if (state === 0 || slot >= SHADOW_CAP) continue;
      h.object.getWorldPosition(_world);
      const floor = ground(_world.x, _world.z),
        lift = clamp(_world.y - floor, 0, 8);
      // Airborne actors (leaps, floaters) cast a smaller, fainter blob.
      const size = h.radius * ((Math.abs(h.object.scale.x) || h.baseScale) / h.baseScale) * (1 - Math.min(lift, 4) * 0.08);
      drapeDisc(layer, slot, _world.x, _world.z, UNIT_DISC, 0, size, 0, SHADOW_LIFT, ground);
      writeAlpha(slot, clamp(1 - lift / 5, 0.25, 1));
      slot++;
    }
    layer.geometry.setDrawRange(0, slot * DISC_INDICES);
    layer.mesh.visible = slot > 0;
    if (slot) markDirty(layer);
  }

  // Shadows of objects that outlive a stage (the hero) survive; orphans are dropped.
  function clear() {
    for (const h of byObject.values()) if (presence(h.object) < 0) release(h);
  }

  return { add, release, frame, clear, isShadow: (h) => h instanceof BlobShadow, count: () => byObject.size };
}

// ---- floating damage numbers (DOM) -----------------------------------------------------------

function createNumbers(ctx, ground) {
  const doc = globalThis.document;
  const root = doc?.querySelector("#damageNumbers") ?? null;
  const live = [];
  const spare = [];
  const screen = { x: 0, y: 0, visible: false }; // reused projection result
  let now = 0;

  function element(critical, color, label) {
    if (!root) return null;
    const el = spare.pop() ?? doc.createElement("span");
    el.className = critical ? "damage critical" : label ? "damage fx-label" : "damage";
    el.style.position = "absolute";
    el.style.color = color ?? "";
    el.style.display = "none";
    root.appendChild(el);
    return el;
  }

  function sameTarget(n, key, x, z) {
    if (key != null) return n.key === key;
    return n.key == null && (n.x - x) ** 2 + (n.z - z) ** 2 < 0.64;
  }

  // Rapid hits on one target merge into a running total (crits never fold into plain numbers,
  // so a crit is never hidden by a Stinger or Scatter stream). `text` shows words instead of
  // the amount (labels such as RUBBLE CRUSH) and never merges.
  function spawn(x, y, z, amount, options) {
    if (!Number.isFinite(amount) || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const opts = typeof options === "boolean" ? { crit: options } : options ?? {};
    const crit = !!opts.crit,
      key = opts.target ?? null,
      text = opts.text ? String(opts.text) : null;
    for (const n of live) {
      if (text || n.text || n.crit !== crit || !sameTarget(n, key, x, z) || now - n.last > MERGE_WINDOW || n.age > MERGE_AGE) continue;
      n.amount += amount;
      n.life = NUMBER_LIFE;
      n.last = now;
      if (n.el) n.el.textContent = String(Math.round(n.amount));
      return;
    }
    if (live.length >= NUMBER_CAP) return;
    const el = element(crit, opts.color, !!text);
    if (el) el.textContent = text ?? String(Math.round(amount));
    live.push({
      el,
      x,
      y: Number.isFinite(y) ? y : ground(x, z) + NUMBER_HEIGHT,
      z,
      amount,
      crit,
      key,
      text,
      life: text ? LABEL_LIFE : NUMBER_LIFE,
      age: 0,
      last: now,
      shownX: NaN,
      shownY: NaN,
      shownOpacity: NaN,
      shown: false,
    });
  }

  function retire(i) {
    const n = live[i];
    live[i] = live[live.length - 1];
    live.pop();
    if (n.el) {
      n.el.remove();
      spare.push(n.el);
    }
  }

  function update(dt) {
    now += dt;
    for (let i = live.length - 1; i >= 0; i--) {
      const n = live[i];
      n.life -= dt;
      n.age += dt;
      n.y += NUMBER_RISE * dt;
      if (n.life <= 0) retire(i);
    }
  }

  // Position every render frame so numbers stay glued to the world while the camera eases.
  function frame() {
    const project = ctx.cam?.project;
    for (const n of live) {
      if (!n.el) continue;
      const p = project ? ctx.cam.project(n.x, n.y, n.z, screen) : null;
      const visible = !!p?.visible;
      if (visible !== n.shown) {
        n.el.style.display = visible ? "" : "none";
        n.shown = visible;
      }
      if (!visible) continue;
      const left = Math.round(p.x),
        top = Math.round(p.y),
        opacity = Math.min(1, n.life * 3);
      if (left !== n.shownX) n.el.style.left = (n.shownX = left) + "px";
      if (top !== n.shownY) n.el.style.top = (n.shownY = top) + "px";
      if (opacity !== n.shownOpacity) n.el.style.opacity = String((n.shownOpacity = opacity));
    }
  }

  function clear() {
    for (let i = live.length - 1; i >= 0; i--) retire(i);
  }

  return { spawn, update, frame, clear, count: () => live.length };
}

// ---- transient meshes: light pillars, falling bodies and lobbed embers (IMPROVEMENTS §3.10) -

// A pool of short-lived meshes with never-reused handles (a stale handle is inert). `step(h, dt)`
// returns false when the effect is over; the oldest effect gives way at the cap.
function createMeshEffects(mount, cap, step) {
  const spare = [],
    live = new Set();

  class MeshEffect {
    constructor(mesh) {
      this.mesh = mesh;
      this.dead = false;
    }
    remove() {
      release(this);
    }
  }

  function release(h) {
    if (!(h instanceof MeshEffect) || h.dead) return;
    h.dead = true;
    live.delete(h);
    h.mesh.visible = false;
    spare.push(h.mesh);
    h.mesh = null;
  }

  // A pooled mesh wearing `geometry` and `material` (a shared material is never mutated).
  function spawn(geometry, material) {
    if (live.size >= cap) release(live.values().next().value);
    const mesh = spare.pop() ?? new THREE.Mesh(geometry, material);
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.rotation.set(0, 0, 0);
    mesh.visible = true;
    mount(mesh);
    const h = new MeshEffect(mesh);
    live.add(h);
    return h;
  }

  return {
    spawn,
    release,
    update(dt) {
      for (const h of live) if (!step(h, dt)) release(h);
    },
    clear() {
      for (const h of live) release(h);
    },
    count: () => live.size,
  };
}

const PILLAR_CAP = 16;
const PILLAR_OPACITY = 0.5;
const PILLAR_STEPS = 4; // the fade is held in 4 frames, PS1 style
const FALL_CAP = 16;
const FALL_SPIN = 5;
const FALL_DUST = "#b6a184";
const LOB_CAP = 12;
const LOB_SIZE = 0.2;
const LOB_TRAIL = 0.06; // seconds between trail sparks
const GEM = new THREE.OctahedronGeometry(1, 0);
const ICO = new THREE.IcosahedronGeometry(1, 0);
const FALL_SHAPES = Object.freeze({ box: UNIT_BOX, gem: GEM, ico: ICO });

// Unlit columns that fade out while spinning (beacon charge, elite arrival, grid strikes). Each
// pooled pillar owns its material: colour and opacity change per use.
function createPillars(mount, ground) {
  const effects = createMeshEffects(mount, PILLAR_CAP, (h, dt) => {
    h.life -= dt;
    if (h.life <= 0) return false;
    h.mesh.material.opacity = h.opacity * (Math.ceil((h.life / h.max) * PILLAR_STEPS) / PILLAR_STEPS);
    h.mesh.rotation.y += h.spin * dt;
    return true;
  });
  const materials = new WeakMap();

  // x, z: base; h: height; w: full width; gem: an octahedron instead of a box.
  function spawn(x, z, color, h, w, life, { gem = false, spin = 0, opacity = PILLAR_OPACITY } = {}) {
    if (!(h > 0) || !(w > 0) || !(life > 0)) return null;
    const handle = effects.spawn(gem ? GEM : UNIT_BOX, null),
      mesh = handle.mesh;
    let material = materials.get(mesh);
    if (!material) {
      material = privateUnlitMaterial("#ffffff", { transparent: true, depthWrite: false, side: THREE.DoubleSide });
      materials.set(mesh, material);
    }
    mesh.material = material;
    material.color.set(color);
    material.opacity = opacity;
    mesh.position.set(x, ground(x, z) + h / 2, z);
    if (gem) mesh.scale.set(w / 2, h / 2, w / 2);
    else mesh.scale.set(w, h, w);
    Object.assign(handle, { life, max: life, opacity, spin });
    return handle;
  }

  return { spawn, update: effects.update, clear: effects.clear, count: effects.count };
}

// A body dropping onto (x, z) from `from` metres up, accelerating to land after `duration`
// (after `delay`), then bursting into dust. `shape` names a primitive ("ico", "gem", "box", a
// 0.5 m body) or is { shape, sx, sy, sz, tile, unlit } (lit retro material by default).
function createFalls(mount, ground, burst) {
  const effects = createMeshEffects(mount, FALL_CAP, (h, dt) => {
    h.t += dt;
    const p = (h.t - h.delay) / h.duration;
    h.mesh.visible = p >= 0;
    if (p < 0) return true;
    if (p >= 1) {
      burst(h.x, 0.2, h.z, h.color, 4, 3);
      burst(h.x, 0.2, h.z, FALL_DUST, 5, 2.5);
      return false;
    }
    h.mesh.position.y = ground(h.x, h.z) + h.half + h.from * (1 - p * p);
    h.mesh.rotation.y += FALL_SPIN * dt;
    return true;
  });

  function spawn(x, z, shape, color, from, duration, delay = 0) {
    if (!(duration > 0) || !Number.isFinite(from)) return null;
    const spec = shape && typeof shape === "object" ? shape : { shape },
      sx = spec.sx ?? 0.5,
      sy = spec.sy ?? sx,
      sz = spec.sz ?? sx,
      material = spec.unlit ? unlitMaterial(color) : retroMaterial(color, spec.tile ?? TILE.rock),
      handle = effects.spawn(FALL_SHAPES[spec.shape] ?? ICO, material);
    handle.mesh.scale.set(sx, sy, sz);
    handle.mesh.position.set(x, ground(x, z) + sy + from, z);
    handle.mesh.visible = !(delay > 0);
    Object.assign(handle, { x, z, color, from, duration, delay: Math.max(0, delay || 0), t: 0, half: sy });
    return handle;
  }

  return { spawn, update: effects.update, clear: effects.clear, count: effects.count };
}

// A glowing ember on a parabola from a to b ({x, z, y?}; y absolute, default chest height at
// a and the ground at b), `peak` metres above the straight line at mid-flight, trailing sparks.
function createLobs(mount, ground, burst) {
  const effects = createMeshEffects(mount, LOB_CAP, (h, dt) => {
    h.t += dt;
    const p = Math.min(1, h.t / h.duration),
      x = h.ax + (h.bx - h.ax) * p,
      z = h.az + (h.bz - h.az) * p,
      y = h.ay + (h.by - h.ay) * p + 4 * h.peak * p * (1 - p);
    h.mesh.position.set(x, y, z);
    h.trail -= dt;
    if (h.trail <= 0) {
      h.trail = LOB_TRAIL;
      burst(x, y - ground(x, z), z, h.color, 1, 0.5);
    }
    return p < 1;
  });

  function spawn(a, b, color, peak = 4, duration = 1) {
    if (!a || !b || !(duration > 0)) return null;
    const handle = effects.spawn(ICO, unlitMaterial(color));
    handle.mesh.scale.setScalar(LOB_SIZE);
    Object.assign(handle, {
      ax: a.x,
      az: a.z,
      ay: Number.isFinite(a.y) ? a.y : ground(a.x, a.z) + 1.2,
      bx: b.x,
      bz: b.z,
      by: Number.isFinite(b.y) ? b.y : ground(b.x, b.z) + 0.2,
      peak,
      duration,
      color,
      t: 0,
      trail: 0,
    });
    handle.mesh.position.set(handle.ax, handle.ay, handle.az);
    return handle;
  }

  return { spawn, update: effects.update, clear: effects.clear, count: effects.count };
}

// ---- ground zones: one instanced disc layer per ZONE_STYLES style (§1.4: at most 3 draws) ----

const ZONE_CAP = 48;
const ZONE_LIFT = 0.12;
const ZONE_FLICKER = 0.15; // brightness dips up to 15 %, a new value every 15 fps frame
const EMBER_FALLBACK = "#ffb05c";

// fx.zone(zone) follows a live combat zone record ({ x, z, radius, shape, sx, sz, yaw, life,
// dead, visual }) every step, so a zone that grows (the Abbot's relight) or ends needs no call;
// removeZone(handle) drops it early. Styles without colour (lava) only shed embers.
function createZoneDiscs(mount, ground, burst) {
  const geometry = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2),
    layers = new Map(),
    live = new Set();
  let clock = 0,
    serial = 0;

  class ZoneMark {
    constructor(zone, layer) {
      this.zone = zone;
      this.layer = layer;
      this.ember = layer.style.ember > 0 ? layer.style.ember * Math.random() : Infinity;
      this.seed = ++serial;
      this.dead = false;
    }
    remove() {
      release(this);
    }
  }

  function release(h) {
    if (!(h instanceof ZoneMark) || h.dead) return;
    h.dead = true;
    live.delete(h);
  }

  function layerFor(name) {
    const style = ZONE_STYLES[name];
    if (!style) return null;
    let layer = layers.get(name);
    if (layer) return layer;
    layer = { style, mesh: null, color: new THREE.Color(style.color ?? EMBER_FALLBACK), count: 0 };
    if (style.color && style.opacity > 0) {
      const material = privateUnlitMaterial("#ffffff", { transparent: true, opacity: style.opacity, depthWrite: false, side: THREE.DoubleSide });
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -4;
      const mesh = new THREE.InstancedMesh(geometry, material, ZONE_CAP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ZONE_CAP * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      layer.mesh = mesh;
    }
    layers.set(name, layer);
    return layer;
  }

  function add(zone) {
    if (!zone || zone.dead) return null;
    const layer = layerFor(zone.visual);
    if (!layer) return null;
    if (layer.mesh) mount(layer.mesh);
    const h = new ZoneMark(zone, layer);
    live.add(h);
    return h;
  }

  function emberAt(zone, color) {
    const box = zone.shape === "box",
      a = Math.random() * TAU,
      r = Math.sqrt(Math.random()),
      x = box ? (Math.random() * 2 - 1) * zone.sx : Math.sin(a) * r * zone.radius,
      z = box ? (Math.random() * 2 - 1) * zone.sz : Math.cos(a) * r * zone.radius,
      c = Math.cos(zone.yaw || 0),
      s = Math.sin(zone.yaw || 0);
    burst(zone.x + x * c + z * s, 0.15, zone.z - x * s + z * c, color, 1, 1.2);
  }

  function place(h, layer, frame) {
    const zone = h.zone,
      i = layer.count++,
      box = zone.shape === "box";
    _pos.set(zone.x, ground(zone.x, zone.z) + ZONE_LIFT, zone.z);
    _euler.set(0, box ? zone.yaw || 0 : 0, 0);
    _quat.setFromEuler(_euler);
    _scale.set(box ? zone.sx : zone.radius, 1, box ? zone.sz : zone.radius);
    layer.mesh.setMatrixAt(i, _mat.compose(_pos, _quat, _scale));
    const n = Math.sin(frame * 12.9898 + h.seed * 78.233) * 43758.5453;
    _tint.copy(layer.color).multiplyScalar(1 - ZONE_FLICKER * (n - Math.floor(n)));
    layer.mesh.setColorAt(i, _tint);
  }

  function update(dt) {
    clock += dt;
    const frame = Math.floor(clock * 15);
    for (const layer of layers.values()) layer.count = 0;
    for (const h of live) {
      const zone = h.zone;
      if (zone.dead || !(zone.life > 0)) {
        release(h);
        continue;
      }
      const layer = h.layer;
      h.ember -= dt;
      if (h.ember <= 0) {
        h.ember += layer.style.ember;
        emberAt(zone, layer.color);
      }
      if (layer.mesh && layer.count < ZONE_CAP) place(h, layer, frame);
    }
    for (const { mesh, count } of layers.values()) {
      if (!mesh) continue;
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  function clear() {
    for (const h of live) release(h);
    for (const { mesh } of layers.values()) if (mesh) mesh.visible = false;
  }

  return { add, release, update, clear, count: () => live.size };
}

// ---- screen tint (the aurora flare): a full-screen colour wash that fades in real time -------

function createFlareTint(doc, hitflash) {
  let el = null,
    strength = 0,
    fade = 0,
    shown = -1;

  // Created on first use, right above the hurt frame so the HUD stays on top.
  function element() {
    if (el || !doc?.body) return el;
    el = doc.createElement("div");
    el.id = "flareTint";
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, { position: "fixed", inset: "0", pointerEvents: "none", opacity: "0" });
    if (hitflash?.parentNode) hitflash.after(el);
    else doc.body.append(el);
    return el;
  }

  function paint() {
    const opacity = Math.round(strength * 1000) / 1000;
    if (!el || opacity === shown) return;
    el.style.opacity = String(opacity);
    shown = opacity;
  }

  return {
    show(color, amount, duration) {
      if (!(amount > 0) || !(duration > 0) || !element()) return;
      el.style.background = color;
      strength = Math.max(strength, amount);
      fade = strength / duration;
      paint();
    },
    frame(dt) {
      if (strength <= 0) return;
      strength = Math.max(0, strength - fade * dt);
      paint();
    },
    clear() {
      strength = 0;
      paint();
    },
  };
}

// Directional armour feedback (IMPROVEMENTS F1.4, F4, F5) on bus "guardHit": crust or steel
// sparks on the guarded front, Aegis cyan on a blocked shot, embers on a punished rear.
const GUARD_SPARKS = Object.freeze({ stone: "#b6a184", steel: "#b8b4ac", aegis: "#83e7ff", rear: "#ff9a5c" });
const STUN_COLOR = "#e8e2a0";
const REDUCED_FLARE = 0.1;

// ---- enhanced lighting: glowing sparks, embers and smoke (pref "lighting") -----------------

// Additive sparks drawn as boxes stretched along their velocity (a short motion trail), and
// embers that rise, sway and flicker. One instanced draw. Only spawned in enhanced mode.
const GLOW_CAP = 360;
const GX_ = 0, GY_ = 1, GZ_ = 2, GVX_ = 3, GVY_ = 4, GVZ_ = 5, GLIFE_ = 6, GMAX_ = 7, GSIZE_ = 8, GKIND_ = 9;
const GLOW_STRIDE = 10;
const SPARK_GRAVITY = 9;
const SPARK_DRAG = 2.2;
const EMBER_LIFT = 1.6;
const TRAIL = 0.05; // seconds of motion the streak spans
const HOT = new THREE.Color("#fff4dc");

function createGlow(mount) {
  let clock = 0;
  const pool = createInstancePool({
    geometry: UNIT_BOX,
    material: unlitMaterial("#ffffff", { additive: true, fog: false }),
    cap: GLOW_CAP,
    stride: GLOW_STRIDE,
    lifeField: GLIFE_,
    recycle: true,
    step(d, o, dt) {
      d[o + GLIFE_] -= dt;
      if (d[o + GLIFE_] <= 0) return false;
      if (d[o + GKIND_] > 0) {
        // Ember: buoyant, swaying, slowing.
        d[o + GVY_] += (EMBER_LIFT - d[o + GVY_] * 0.8) * dt;
        d[o + GVX_] += Math.sin(clock * 3 + o) * 1.2 * dt;
        d[o + GVX_] *= Math.exp(-0.9 * dt);
        d[o + GVZ_] *= Math.exp(-0.9 * dt);
      } else {
        const drag = Math.exp(-SPARK_DRAG * dt);
        d[o + GVX_] *= drag;
        d[o + GVZ_] *= drag;
        d[o + GVY_] = d[o + GVY_] * drag - SPARK_GRAVITY * dt;
      }
      d[o + GX_] += d[o + GVX_] * dt;
      d[o + GY_] += d[o + GVY_] * dt;
      d[o + GZ_] += d[o + GVZ_] * dt;
      return true;
    },
    pose(d, o) {
      const vx = d[o + GVX_],
        vy = d[o + GVY_],
        vz = d[o + GVZ_];
      const speed = Math.hypot(vx, vy, vz);
      const fade = d[o + GLIFE_] / d[o + GMAX_];
      let w = d[o + GSIZE_] * (0.35 + 0.65 * fade);
      let back = 0;
      if (d[o + GKIND_] > 0) {
        // Flicker stepped at 15 fps, per-ember phase.
        w *= 0.55 + 0.45 * Math.abs(Math.sin(Math.floor(clock * 15) * 1.7 + o * 0.37));
        _quat.identity();
        _scale.set(w, w, w);
        _dir.set(0, 0, 0);
      } else {
        if (speed > 1e-3) _dir.set(vx / speed, vy / speed, vz / speed);
        else _dir.set(0, 1, 0);
        _quat.setFromUnitVectors(AXIS_Z, _dir);
        _scale.set(w, w, w + speed * TRAIL);
        back = (speed * TRAIL) / 2; // the streak trails behind the head
      }
      _pos.set(d[o + GX_] - _dir.x * back, d[o + GY_] - _dir.y * back, d[o + GZ_] - _dir.z * back);
      return _mat.compose(_pos, _quat, _scale);
    },
  });

  function emit(x, y, z, color, count, speed, kind) {
    if (!(count > 0)) return;
    mount(pool.mesh);
    const d = pool.data;
    _tint.set(color).lerp(HOT, kind > 0 ? 0.15 : 0.4);
    for (let c = 0; c < count; c++) {
      const i = pool.claim();
      if (i < 0) break;
      const o = i * GLOW_STRIDE,
        a = Math.random() * TAU,
        h = kind > 0 ? rand(0.2, 1) : rand(0.35, 1);
      d[o + GX_] = x + (kind > 0 ? rand(-0.4, 0.4) : 0);
      d[o + GY_] = y;
      d[o + GZ_] = z + (kind > 0 ? rand(-0.4, 0.4) : 0);
      d[o + GVX_] = Math.cos(a) * h * speed;
      d[o + GVY_] = kind > 0 ? rand(0.6, 1.8) * speed * 0.35 : rand(0.4, 1.6) * speed * 0.8;
      d[o + GVZ_] = Math.sin(a) * h * speed;
      d[o + GMAX_] = d[o + GLIFE_] = kind > 0 ? rand(0.9, 1.8) : rand(0.18, 0.42);
      d[o + GSIZE_] = kind > 0 ? rand(0.06, 0.11) : rand(0.035, 0.07);
      d[o + GKIND_] = kind;
      pool.commit(i, _tint);
    }
  }

  return {
    emit,
    update(dt) {
      clock += dt;
      pool.update(dt);
    },
    clear: pool.clear,
    count: pool.count,
  };
}

// Soft smoke after explosions: low-poly puffs that swell, rise and thin out through the 4x4
// screen door (per-instance alpha), so they need no blending or sorting.
const SMOKE_CAP = 48;
const SMOKE_STRIDE = 8; // x y z vy life max size spin
const SMOKE_COLOR = new THREE.Color("#4a4543");

function createSmoke(mount) {
  const material = privateUnlitMaterial("#ffffff", { depthWrite: false });
  const snap = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    snap.call(material, shader, renderer);
    shader.vertexShader = `attribute float puffAlpha;\nvarying float vPuffAlpha;\n${shader.vertexShader}`.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\n  vPuffAlpha = puffAlpha;",
    );
    shader.fragmentShader = `varying float vPuffAlpha;\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `diffuseColor.a *= vPuffAlpha;\n${SCREEN_DOOR}`,
    );
  };
  material.customProgramCacheKey = () => key + "|smoke-puff";
  const geometry = ICO.clone();
  const alpha = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_CAP), 1);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("puffAlpha", alpha);
  const mesh = new THREE.InstancedMesh(geometry, material, SMOKE_CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_CAP * 3), 3);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  const colors = mesh.instanceColor;
  const d = new Float32Array(SMOKE_CAP * SMOKE_STRIDE);
  let n = 0;

  function spawn(x, y, z, count, size) {
    mount(mesh);
    for (let c = 0; c < count && n < SMOKE_CAP; c++, n++) {
      const o = n * SMOKE_STRIDE,
        a = Math.random() * TAU,
        r = rand(0, size * 0.5);
      d[o] = x + Math.cos(a) * r;
      d[o + 1] = y + rand(0.2, 0.9);
      d[o + 2] = z + Math.sin(a) * r;
      d[o + 3] = rand(0.6, 1.4);
      d[o + 5] = d[o + 4] = rand(1.1, 1.9);
      d[o + 6] = size * rand(0.35, 0.6);
      d[o + 7] = Math.random() * TAU;
      _tint.copy(SMOKE_COLOR).multiplyScalar(rand(0.8, 1.2));
      colors.setXYZ(n, _tint.r, _tint.g, _tint.b);
      alpha.setX(n, 0);
    }
    colors.needsUpdate = true;
  }

  function update(dt) {
    if (!n) return;
    for (let i = 0; i < n; ) {
      const o = i * SMOKE_STRIDE;
      d[o + 4] -= dt;
      if (d[o + 4] <= 0) {
        n--;
        if (i !== n) {
          d.copyWithin(o, n * SMOKE_STRIDE, n * SMOKE_STRIDE + SMOKE_STRIDE);
          colors.setXYZ(i, colors.getX(n), colors.getY(n), colors.getZ(n));
          colors.needsUpdate = true;
        }
        continue;
      }
      const k = 1 - d[o + 4] / d[o + 5];
      d[o + 1] += d[o + 3] * dt;
      d[o + 3] *= Math.exp(-0.7 * dt);
      _euler.set(0, d[o + 7] + k, 0);
      _quat.setFromEuler(_euler);
      _pos.set(d[o], d[o + 1], d[o + 2]);
      _scale.setScalar(d[o + 6] * (0.6 + 1.1 * Math.sqrt(k)));
      mesh.setMatrixAt(i, _mat.compose(_pos, _quat, _scale));
      alpha.setX(i, 0.85 * (1 - k) * Math.min(1, k * 8 + 0.3));
      i++;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    alpha.needsUpdate = true;
  }

  return {
    spawn,
    update,
    clear() {
      n = 0;
      mesh.count = 0;
      mesh.visible = false;
    },
    count: () => n,
  };
}

// ---- the system -----------------------------------------------------------------------------

export function createFx(ctx) {
  const ground = (x, z) => groundAt(ctx, x, z);
  const mount = (object) => {
    if (!object.parent) ctx.gfx?.layers?.effects?.add(object);
  };
  const reduced = () => ctx.prefs?.flashes === false;
  const particles = createParticles(mount, ground);
  const rings = createRings(mount, ground, () => (reduced() ? RING_OPACITY_REDUCED : RING_OPACITY));
  const lines = createLines(mount);
  const tracers = createTracers(mount);
  const gibs = createGibs(mount, ground);
  const decals = createDecals(mount, ground);
  const shadows = createShadows(mount, ground);
  const numbers = createNumbers(ctx, ground);
  const pillars = createPillars(mount, ground);
  const falls = createFalls(mount, ground, particles.burst);
  const lobs = createLobs(mount, ground, particles.burst);
  const zones = createZoneDiscs(mount, ground, particles.burst);
  const glow = createGlow(mount);
  const smoke = createSmoke(mount);
  // Enhanced lighting extras exist only with a renderer in enhanced mode (never headless).
  const enhanced = () => !!ctx.gfx?.enhanced?.();

  // Enhanced dressing for a burst: coloured glowing sparks (the weapon or monster colour), and
  // for big bursts (explosions, deaths) rising embers, a flash that lights the ground and, for
  // blasts, smoke puffs. Visual only: Math.random, never a run stream.
  function dress(x, y, z, color, count, speed) {
    if (!(count >= 2) || !enhanced()) return;
    const base = y + ground(x, z);
    glow.emit(x, base, z, color, Math.min(36, Math.round(3 + count * 0.7)), Math.max(2.5, speed * 1.3), 0);
    if (count >= 14) {
      glow.emit(x, base, z, color, Math.min(24, Math.round(count / 3)), 1.2, 1);
      ctx.gfx?.light?.(x, base + 0.8, z, color, 4.5 + count * 0.25, 6 + speed, 6);
      if (count >= 30 && speed >= 6) smoke.spawn(x, ground(x, z), z, 6, 2.2);
    } else if (count >= 3) ctx.gfx?.light?.(x, base + 0.3, z, color, 1.8 + count * 0.35, 4.5, 16);
  }
  const hitflash = globalThis.document?.querySelector("#hitflash") ?? null;
  const flare = createFlareTint(globalThis.document, hitflash);
  let hurt = 0,
    shownHurt = -1,
    stall = 0;

  function paintHurt() {
    const opacity = Math.round(hurt * HURT_OPACITY * 1000) / 1000;
    if (opacity === shownHurt || !hitflash) return;
    hitflash.style.opacity = String(opacity);
    shownHurt = opacity;
  }

  // Kill leftovers: a few chunks in the monster's palette and a dark splat under it. The death
  // burst and ring stay with combat's kill accounting, as in the original.
  function onKill({ e } = {}) {
    if (!e || e.fixed || e.boss === "warden" || !Number.isFinite(e.x)) return;
    const radius = e.def?.radius ?? e.radius ?? 0.5,
      color = e.def?.color ?? "#c9fffe";
    _tint.set(color).lerp(GIB_FLESH, 0.45);
    gibs.spawn(e.x, e.z, _tint, Math.round(3 + radius * 4), 0.12 + radius * 0.14);
    _tint.set(color).lerp(SPLAT_DARK, 0.65);
    decals.spawn(e.x, e.z, _tint, 0.3 + radius * 1.1, 9);
    // Enhanced: the dying body lights up the ground around it.
    if (enhanced()) ctx.gfx?.light?.(e.x, ground(e.x, e.z) + 1, e.z, color, 4.5 + radius * 4, 5 + radius * 3, 5);
  }
  ctx.bus?.on("enemyKilled", onKill);

  // Guarded hits: sparks at the impact (y absolute, else chest height) coloured by the arc.
  function onGuardHit({ e, arc, mult = 1, blocked = false, x, y, z } = {}) {
    const at = Number.isFinite(x) ? { x, z } : e;
    if (!at || !Number.isFinite(at.x)) return;
    const color = blocked ? GUARD_SPARKS.aegis : arc === "front" ? (e?.keeper === "abbot" ? GUARD_SPARKS.stone : GUARD_SPARKS.steel) : arc === "rear" && mult > 1 ? GUARD_SPARKS.rear : null;
    if (!color) return;
    const floor = ground(at.x, at.z);
    particles.burst(at.x, Number.isFinite(y) ? Math.max(0, y - floor) : 1.4, at.z, color, arc === "rear" ? 7 : 5, 3);
  }
  ctx.bus?.on("guardHit", onGuardHit);

  // Stunned monsters (beacon flares): a pale starburst over the head and a quick ring.
  function onStun({ e } = {}) {
    if (!e || !Number.isFinite(e.x)) return;
    particles.burst(e.x, 2.3 * (e.model?.g?.scale?.y ?? 1), e.z, STUN_COLOR, 6, 1.6);
    rings.spawn(e.x, e.z, STUN_COLOR, 1.6, 0.35);
  }
  ctx.bus?.on("stun", onStun);

  const api = {
    burst(x, y, z, color = "#ffffff", count = 12, speed = 4) {
      particles.burst(x, y, z, color, count, speed);
      dress(x, y, z, color, count, speed);
    },
    ring(x, z, color = "#ffffff", size = 3, life = 0.4) {
      rings.spawn(x, z, color, size, life);
    },
    // Returns a handle with update(a, b) / remove(); `life` <= 0 keeps it until removed.
    line(a, b, color = "#ffffff", life = 0, width = LINE_WIDTH) {
      return lines.spawn(a, b, color, life, width);
    },
    tracer(a, b, color = "#ffffff") {
      tracers.spawn(a, b, color);
    },
    // y is an absolute world height; omit it for the original anchor (ground + 2.2). options:
    // { crit, color, target, text } (text replaces the amount and never merges).
    number(x, y, z, amount, options = {}) {
      numbers.spawn(x, y, z, amount, options);
    },
    gibs(x, z, color = "#ffffff", count = 6, size = 0.22) {
      gibs.spawn(x, z, color, count, size);
    },
    decal(x, z, color = "#1d1618", size = 1, life = 8) {
      decals.spawn(x, z, color, size, life);
    },
    shadow(object3d, radius = 0.6) {
      return shadows.add(object3d, radius);
    },
    removeShadow(handle) {
      shadows.release(handle);
    },
    // Generic removal for any handle this module returns (lines and shadows).
    remove(handle) {
      if (lines.isLine(handle)) lines.release(handle);
      else shadows.release(handle);
    },
    hitstop(seconds) {
      if (ctx.env?.reduced || !(seconds > 0)) return;
      stall = Math.max(stall, Math.min(HITSTOP_CAP, seconds));
    },
    tickHitstop(dt) {
      if (stall <= 1e-6) return false;
      stall = Math.max(0, stall - dt);
      return true;
    },
    hurtFlash(amount = 1) {
      if (ctx.prefs?.flashes === false) return;
      hurt = Math.max(hurt, clamp(amount, 0, 1));
      paintHurt();
    },
    shake(amount) {
      ctx.cam?.shake?.(amount);
    },
    // Wave-2 primitives (IMPROVEMENTS §3.10). Each effect returns a handle with remove() (null
    // when refused) and ages in simulation time.
    // A light column: base (x, z), height h, full width w; options { gem, spin (rad/s), opacity }.
    pillar(x, z, color = "#ffffff", h = 8, w = 0.6, life = 0.5, options = {}) {
      return pillars.spawn(x, z, color, h, w, life, options);
    },
    // A body falling onto (x, z) from `from` m up over `duration` s, after an optional `delay`.
    fall(x, z, shape = "ico", color = "#8e8a80", from = 9, duration = 0.35, delay = 0) {
      return falls.spawn(x, z, shape, color, from, duration, delay);
    },
    // A glowing ember on a parabolic arc from a to b, `peak` m above the chord at mid-flight.
    lob(a, b, color = "#ffcf6a", peak = 5, duration = 1) {
      return lobs.spawn(a, b, color, peak, duration);
    },
    // A worded label at a world point (y absolute, null = ground + 2.2), e.g. RUBBLE CRUSH.
    label(x, y, z, text, color = "#e2ba86") {
      if (text) numbers.spawn(x, y, z, 0, { text, color });
      return null;
    },
    // Instanced discs under a combat zone (ZONE_STYLES by zone.visual); follows the zone record
    // until it ends or removeZone(handle).
    zone(zone) {
      return zones.add(zone);
    },
    removeZone(handle) {
      zones.release(handle);
    },
    // A full-screen colour wash (the aurora flare) through the renderer's flash budget; Reduce
    // flashes holds it at 0.1 (IMPROVEMENTS F17).
    flare(kind, color, strength, duration) {
      const allowed = ctx.gfx?.requestFlash?.(kind, strength) ?? strength;
      flare.show(color, reduced() ? Math.min(allowed, REDUCED_FLARE) : allowed, duration);
    },
    // update(dt) advances every simulation-time effect. Also accepts (lineHandle, a, b) so a
    // caller that reads the contract's "update(handle, a, b)" literally still moves its line.
    update(dt, a, b) {
      if (lines.isLine(dt)) {
        dt.update(a, b);
        return;
      }
      if (!(dt > 0)) return;
      particles.update(dt);
      rings.update(dt);
      lines.update(dt);
      tracers.update(dt);
      gibs.update(dt);
      decals.update(dt);
      numbers.update(dt);
      pillars.update(dt);
      falls.update(dt);
      lobs.update(dt);
      zones.update(dt);
      glow.update(dt);
      smoke.update(dt);
    },
    // Per rendered frame (real time): DOM numbers, blob shadows, the hurt frame and flare fades
    // (which decay in real time so they never stick while the simulation is frozen) and the
    // ambient clock of animated surfaces (lava).
    frame(dt) {
      const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      numbers.frame();
      shadows.frame(step);
      flare.frame(step);
      advanceRetroClock(step);
      if (hurt > 0) {
        hurt = Math.max(0, hurt - HURT_DECAY * step);
        paintHurt();
      }
    },
    clear() {
      particles.clear();
      rings.clear();
      lines.clear();
      tracers.clear();
      gibs.clear();
      decals.clear();
      shadows.clear();
      numbers.clear();
      pillars.clear();
      falls.clear();
      lobs.clear();
      zones.clear();
      glow.clear();
      smoke.clear();
      flare.clear();
      stall = 0;
      hurt = 0;
      paintHurt();
    },
    counts() {
      return {
        particles: particles.count(),
        numbers: numbers.count(),
        rings: rings.count(),
        lines: lines.count(),
        tracers: tracers.count(),
        gibs: gibs.count(),
        decals: decals.count(),
        shadows: shadows.count(),
        pillars: pillars.count(),
        falls: falls.count(),
        lobs: lobs.count(),
        zones: zones.count(),
      };
    },
  };
  return api;
}
