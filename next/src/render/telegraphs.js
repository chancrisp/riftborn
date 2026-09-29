// Danger markers: flat strip geometry draped on the terrain and drawn over everything (no depth
// test), with the original warnings' shapes, colour-coded per threat. The damaging boundary
// never animates; callers drive opacity and an optional countdown (`progress` 0..1) that fills
// the shape or sweeps along the lane until it meets the boundary at impact.
//
// Wave 2 (IMPROVEMENTS F1.5, F16.2, F17): filled arcs, expanding bands, grid cells and jagged
// fissures; a width floor so every strip is at least 2 internal pixels wide; per-palette colours
// recoloured live and class patterns; a trailing `meta` on every constructor feeding active()
// (radar marks and off-screen arrows); aim lines that thicken over their windup and show a
// spinning reticle in their last 0.3 s. Geometry is built once per marker; later changes only
// rewrite vertices in place.
import * as THREE from "three";
import { privateUnlitMaterial, groundAt } from "./fx.js";
import { clamp, TAU } from "../core/util.js";
import {
  PATTERNS,
  UNDER_COLORS,
  UNDER_KINDS,
  UNDER_WIDEN,
  WAVE2_KINDS,
  classOfKind,
  kindColor,
  patternsOn,
  setLook,
  stripFloor,
  guideFloor,
  validPalette,
} from "../data/palettes.js";

export { PATTERNS, pxPerMetre, stripFloor, guideFloor } from "../data/palettes.js";

const LIFT = 0.13; // marker height above the sampled terrain
const PIECE = 0.5; // longer strips are split so every 0.5 m drapes over bumps and ledges
const OPACITY = 0.72;
const THIN = 0.2; // path widths below this draw a single thin aim line
const LINE_STEP = 0.5; // aim lines carry a point every 0.5 m, as the original
const INNER_RING = 0.8; // the double ring of spoke-less areas
const RING_SEGMENTS = 64;
const FILL_ALPHA = 0.3; // countdown fill body, and the static fill of arcs and cells
const BAND_ALPHA = 0.35;
const GUIDE_OPACITY = 0.5;
const FILL_RINGS = 3;
const FILL_SEGS = 32;
const FILL_STEP = 1.2; // metres between the static fill rings of arcs and cells
const HEAD_DEPTH = 0.14;
const CHEVRON_AT = 0.55; // an arc's two inner chevrons sit at this fraction of its radius
const JAG_STEP = 0.5; // fissure crack: a zig-zag vertex every 0.5 m...
const JAG_AMP = 0.15; // ...up to 0.15 m off the centre line
const FADE_FPS = 15; // Wave-2 markers fade in over 0.15 s, stepped at 15 fps:
const FADE_STEPS = Math.round(0.15 * FADE_FPS); // 0, half, then full opacity
const RETICLE_TIME = 0.3; // the aim reticle shows in the last 0.3 s of the windup
const RETICLE_HALF = 0.3; // a 0.6 m square
const RETICLE_SPIN = 3; // rad/s, stepped at 15 fps
const THICKEN_STEPS = 8; // aim lines re-lay their strips at most this often per windup
const MOVE_EPSILON = 1e-4;
const PROGRESS_EPSILON = 0.004;
const MATERIAL_POOL = 48;

const MAIN = 0; // vertex roles: the kind's colour...
const UNDER = 1; // ...or the dark under-strip

// Shape and decoration per kind. Colours come from data/palettes.js (kind colours under rift,
// class colours elsewhere); `jagged` kinds draw a crack instead of rails.
const STYLES = Object.freeze({
  charge: { spokes: 0 },
  aim: { spokes: 0 },
  artillery: { spokes: 4 },
  ground: { spokes: 0 },
  ring: { spokes: 8 },
  hex: { spokes: 4 },
  boss: { spokes: 8 },
  vent: { spokes: 0 },
  node: { spokes: 4 },
  arc: { spokes: 0 },
  wave: { spokes: 0 },
  fissure: { spokes: 0, jagged: true },
  lance: { spokes: 4 },
  aegis: { spokes: 6 },
  burrow: { spokes: 0, jagged: true },
  tear: { spokes: 4 },
  gas: { spokes: 0 },
  rockfall: { spokes: 4 },
  shard: { spokes: 4 },
  molten: { spokes: 0 },
  beacon: { spokes: 8 },
});
const FADING = new Set(WAVE2_KINDS);

// The original marker kinds (hazard kinds) map onto the contract kinds.
const ALIASES = Object.freeze({
  blast: "ground",
  slam: "ground",
  leap: "ground",
  warden: "ground",
  mortar: "artillery",
  salvo: "ring",
  "warden-ring": "boss",
  "warden-node": "node",
  line: "aim",
});

const kindOf = (kind, fallback) => (Object.hasOwn(STYLES, kind) ? kind : Object.hasOwn(ALIASES, kind) ? ALIASES[kind] : fallback);

const FILL_SIN = new Float32Array(FILL_SEGS);
const FILL_COS = new Float32Array(FILL_SEGS);
for (let j = 0; j < FILL_SEGS; j++) {
  FILL_SIN[j] = Math.sin((j / FILL_SEGS) * TAU);
  FILL_COS[j] = Math.cos((j / FILL_SEGS) * TAU);
}

const _color = new THREE.Color();
const NOOP = () => {};

// Deterministic 0..1 noise from a position (the fissure crack is seeded by where it lies).
function hash01(x, z, i) {
  const n = Math.sin(x * 12.9898 + z * 78.233 + i * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

// ---- shape builder ------------------------------------------------------------------------------

// Collects a marker's outline in local x/z: static fill triangles (per-vertex alpha) and strips
// (quads of a full width, split into 0.5 m pieces so they drape). compile() lays out the vertex
// order once: fills, then dark under-strips (high contrast, shards), then the strips themselves.
function createShape(floor) {
  const fills = [];
  const strips = [];
  const half = floor / 2;
  let thinnest = Infinity;
  return {
    half,
    fill(ax, az, bx, bz, cx, cz, alpha = FILL_ALPHA) {
      fills.push(ax, az, alpha, bx, bz, alpha, cx, cz, alpha);
    },
    // A strip from a to b of half-width w (raised to the floor).
    strip(ax, az, bx, bz, w = half) {
      const h = Math.max(w, half);
      thinnest = Math.min(thinnest, 2 * h);
      strips.push(ax, az, bx, bz, h);
    },
    polyline(pts, w = half) {
      for (let i = 2; i < pts.length; i += 2) {
        if (Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]) < 1e-3) continue;
        this.strip(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], w);
      }
    },
    circle(r, from = -Math.PI, to = Math.PI, segments = RING_SEGMENTS, w = half) {
      const n = Math.max(2, Math.ceil((segments * (to - from)) / TAU));
      for (let i = 0; i < n; i++) {
        const a = from + ((to - from) * i) / n,
          b = from + ((to - from) * (i + 1)) / n;
        this.strip(Math.sin(a) * r, Math.cos(a) * r, Math.sin(b) * r, Math.cos(b) * r, w);
      }
    },
    spokes(r, count, from = 0.25, to = 0.83) {
      for (let i = 0; i < count; i++) {
        const a = (i * TAU) / count,
          s = Math.sin(a),
          c = Math.cos(a);
        this.strip(s * r * from, c * r * from, s * r * to, c * r * to);
      }
    },
    pattern(list) {
      for (const [ax, az, bx, bz, w] of list) this.strip(ax, az, bx, bz, w);
    },
    get fills() {
      return fills;
    },
    get strips() {
      return strips;
    },
    get thinnest() {
      return thinnest;
    },
  };
}

const piecesOf = (strips, i, split) => (split ? Math.max(1, Math.ceil(Math.hypot(strips[i + 2] - strips[i], strips[i + 3] - strips[i + 1]) / PIECE)) : 1);

// The immutable part of a marker's outline: vertex count, alpha and colour role per vertex, the
// strip list (kept so aim lines can re-lay their width) and the local positions.
function compile(shape, under, split = true) {
  const fills = new Float32Array(shape.fills);
  const strips = new Float32Array(shape.strips);
  let pieces = 0;
  for (let i = 0; i < strips.length; i += 5) pieces += piecesOf(strips, i, split);
  const fillCount = fills.length / 3;
  const count = fillCount + pieces * 6 * (under ? 2 : 1);
  const spec = {
    fills,
    strips,
    split,
    under,
    fillCount,
    count,
    local: new Float32Array(count * 2),
    alpha: new Float32Array(count),
    role: new Uint8Array(count),
    thinnest: shape.thinnest,
    factor: 1,
  };
  for (let v = 0; v < fillCount; v++) spec.alpha[v] = fills[v * 3 + 2];
  spec.alpha.fill(1, fillCount);
  if (under) spec.role.fill(UNDER, fillCount, fillCount + pieces * 6);
  layout(spec, 1);
  return spec;
}

// Quad from a to b of half-width w, split into draping pieces, as local x/z pairs at `o`.
function emitStrip(out, o, ax, az, bx, bz, w, pieces) {
  const dx = bx - ax,
    dz = bz - az,
    d = Math.hypot(dx, dz) || 1,
    nx = (-dz / d) * w,
    nz = (dx / d) * w;
  for (let k = 0; k < pieces; k++) {
    const x0 = ax + (dx * k) / pieces,
      z0 = az + (dz * k) / pieces,
      x1 = ax + (dx * (k + 1)) / pieces,
      z1 = az + (dz * (k + 1)) / pieces;
    out[o++] = x0 + nx;
    out[o++] = z0 + nz;
    out[o++] = x0 - nx;
    out[o++] = z0 - nz;
    out[o++] = x1 + nx;
    out[o++] = z1 + nz;
    out[o++] = x0 - nx;
    out[o++] = z0 - nz;
    out[o++] = x1 - nx;
    out[o++] = z1 - nz;
    out[o++] = x1 + nx;
    out[o++] = z1 + nz;
  }
  return o;
}

// Writes the local positions; `factor` scales every strip's width (aim lines thickening).
function layout(spec, factor) {
  const { fills, strips, local, split } = spec;
  let o = 0;
  for (let i = 0; i < fills.length; i += 3) {
    local[o++] = fills[i];
    local[o++] = fills[i + 1];
  }
  if (spec.under)
    for (let i = 0; i < strips.length; i += 5)
      o = emitStrip(local, o, strips[i], strips[i + 1], strips[i + 2], strips[i + 3], strips[i + 4] * factor + UNDER_WIDEN / 2, piecesOf(strips, i, split));
  for (let i = 0; i < strips.length; i += 5)
    o = emitStrip(local, o, strips[i], strips[i + 1], strips[i + 2], strips[i + 3], strips[i + 4] * factor, piecesOf(strips, i, split));
  spec.factor = factor;
}

// ---- outlines -------------------------------------------------------------------------------------

// Areas: the outer ring, then the kind's decoration (spokes for emitters and aimed blasts, an
// inner ring for slams and landings) or, with patterns on, its class pattern.
function areaShape(shape, r, kind, cls, patterned) {
  shape.circle(r);
  const pattern = PATTERNS[cls];
  if (patterned && pattern?.shape === "circle") shape.pattern(pattern.strips({ radius: r }, shape.half));
  else if (STYLES[kind].spokes) shape.spokes(r, STYLES[kind].spokes);
  else shape.circle(r * INNER_RING, -Math.PI, Math.PI, 32);
}

// Filled sector facing local +z: a dim fill, two edges, the rim, and two chevrons at 0.55 r
// pointing outward (or the class pattern clipped to the sector).
function arcShape(shape, r, h, kind, cls, patterned) {
  const segs = Math.max(4, Math.ceil((RING_SEGMENTS * 2 * h) / TAU));
  const rings = clamp(Math.ceil(r / FILL_STEP), 1, 8);
  for (let k = 0; k < rings; k++) {
    const r0 = (r * k) / rings,
      r1 = (r * (k + 1)) / rings;
    for (let i = 0; i < segs; i++) {
      const a = -h + (2 * h * i) / segs,
        b = -h + (2 * h * (i + 1)) / segs,
        sa = Math.sin(a),
        ca = Math.cos(a),
        sb = Math.sin(b),
        cb = Math.cos(b);
      shape.fill(sa * r0, ca * r0, sa * r1, ca * r1, sb * r1, cb * r1);
      if (k > 0) shape.fill(sa * r0, ca * r0, sb * r1, cb * r1, sb * r0, cb * r0);
    }
  }
  shape.strip(0, 0, Math.sin(-h) * r, Math.cos(-h) * r);
  shape.strip(0, 0, Math.sin(h) * r, Math.cos(h) * r);
  shape.circle(r, -h, h);
  const pattern = PATTERNS[cls];
  if (patterned && pattern?.shape === "circle") {
    shape.pattern(pattern.strips({ radius: r, sector: h }, shape.half));
    return;
  }
  const c = Math.min(0.6, r * 0.12);
  for (const a of [-h / 2, h / 2]) {
    const s = Math.sin(a),
      k = Math.cos(a),
      px = -k,
      pz = s, // perpendicular
      tx = s * (r * CHEVRON_AT + c),
      tz = k * (r * CHEVRON_AT + c),
      bx = s * (r * CHEVRON_AT - c),
      bz = k * (r * CHEVRON_AT - c);
    shape.strip(bx + px * c, bz + pz * c, tx, tz);
    shape.strip(bx - px * c, bz - pz * c, tx, tz);
  }
}

// Square cell (Castellan grid): a dim fill, four edges and the class spokes (or pattern).
function cellShape(shape, half, kind, cls, patterned) {
  const n = clamp(Math.ceil((2 * half) / FILL_STEP), 1, 8),
    size = (2 * half) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x0 = -half + i * size,
        z0 = -half + j * size,
        x1 = x0 + size,
        z1 = z0 + size;
      shape.fill(x0, z0, x1, z0, x1, z1);
      shape.fill(x0, z0, x1, z1, x0, z1);
    }
  shape.polyline([-half, -half, half, -half, half, half, -half, half, -half, -half]);
  const pattern = PATTERNS[cls];
  if (patterned && pattern?.shape === "circle") shape.pattern(pattern.strips({ radius: half * 0.9 }, shape.half));
  else if (STYLES[kind].spokes) shape.spokes(half, STYLES[kind].spokes);
}

// pts: local x/z pairs. Thin paths are one strip (dashed for aim lines with patterns on);
// lanes get rails, cross caps at the end of the first segment and at the final point, and a
// chevron along travel every 8th segment (every 1.5 m with the charge pattern); jagged kinds
// draw a crack down the centre with cross caps instead of rails.
function pathShape(shape, pts, width, cls, { patterned, jagged }) {
  const count = pts.length / 2;
  if (jagged) return crackShape(shape, pts, width);
  if (width < THIN) {
    if (patterned && cls === "aim") shape.pattern(PATTERNS.aim.strips({ pts }, Math.max(width, shape.half)));
    else shape.polyline(pts, width);
    return;
  }
  const chevrons = patterned && cls === "charge";
  const rail = shape.half;
  for (let i = 1; i < count; i++) {
    const ax = pts[i * 2 - 2],
      az = pts[i * 2 - 1],
      bx = pts[i * 2],
      bz = pts[i * 2 + 1],
      d = Math.hypot(bx - ax, bz - az);
    if (d < 0.001) continue;
    const nx = (-(bz - az) / d) * width,
      nz = ((bx - ax) / d) * width;
    shape.strip(ax + nx, az + nz, bx + nx, bz + nz, rail);
    shape.strip(ax - nx, az - nz, bx - nx, bz - nz, rail);
    if (i === 1 || i === count - 1) shape.strip(bx + nx, bz + nz, bx - nx, bz - nz, rail);
    if (!chevrons && i % 8 === 0) {
      shape.strip(ax + nx * 0.45, az + nz * 0.45, bx, bz, rail);
      shape.strip(ax - nx * 0.45, az - nz * 0.45, bx, bz, rail);
    }
  }
  if (chevrons) shape.pattern(PATTERNS.charge.strips({ pts, width }, rail));
}

// A zig-zag crack every 0.5 m (seeded by the stations' positions) and caps across the width.
function crackShape(shape, pts, width) {
  const crack = [];
  let travelled = 0,
    station = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2],
      az = pts[i - 1],
      dx = pts[i] - ax,
      dz = pts[i + 1] - az,
      d = Math.hypot(dx, dz);
    if (d < 1e-6) continue;
    const nx = -dz / d,
      nz = dx / d;
    if (!crack.length) crack.push(ax, az);
    for (let at = Math.ceil((travelled + 1e-6) / JAG_STEP) * JAG_STEP; at < travelled + d - 1e-6; at += JAG_STEP) {
      const t = (at - travelled) / d,
        x = ax + dx * t,
        z = az + dz * t,
        side = station++ % 2 ? 1 : -1,
        amp = JAG_AMP * (0.55 + 0.45 * hash01(x, z, station));
      crack.push(x + nx * amp * side, z + nz * amp * side);
    }
    travelled += d;
    crack.push(pts[i], pts[i + 1]);
  }
  shape.polyline(crack);
  const n = pts.length;
  if (n < 4) return;
  const cap = (x, z, dx, dz) => {
    const d = Math.hypot(dx, dz) || 1,
      nx = (-dz / d) * width,
      nz = (dx / d) * width;
    shape.strip(x + nx, z + nz, x - nx, z - nz);
  };
  cap(pts[0], pts[1], pts[2] - pts[0], pts[3] - pts[1]);
  cap(pts[n - 2], pts[n - 1], pts[n - 2] - pts[n - 4], pts[n - 1] - pts[n - 3]);
}

// ---- bands --------------------------------------------------------------------------------------

// Expanding band: 64 annular quads. A damage band is a dim fill across its width with bright
// edges on both boundaries; a reach guide is one ring of the guide width. Laid out again in
// place whenever its radius changes.
function bandSpec(guide, halfWidth, edge, under) {
  const rings = guide ? [["guide", 1]] : [["fill", BAND_ALPHA], ...(under ? [["inner", 1, UNDER], ["outer", 1, UNDER]] : []), ["inner", 1], ["outer", 1]];
  const count = rings.length * RING_SEGMENTS * 6;
  const spec = {
    band: { guide, halfWidth, edge, rings },
    fillCount: guide ? 0 : RING_SEGMENTS * 6,
    count,
    local: new Float32Array(count * 2),
    alpha: new Float32Array(count),
    role: new Uint8Array(count),
    thinnest: edge,
    factor: 1,
  };
  rings.forEach(([, alpha, role = MAIN], k) => {
    spec.alpha.fill(alpha, k * RING_SEGMENTS * 6, (k + 1) * RING_SEGMENTS * 6);
    spec.role.fill(role, k * RING_SEGMENTS * 6, (k + 1) * RING_SEGMENTS * 6);
  });
  return spec;
}

function layoutBand(spec, radius) {
  const { halfWidth, edge, rings } = spec.band;
  const out = spec.local;
  let o = 0;
  for (const [name, , role] of rings) {
    const widen = role === UNDER ? UNDER_WIDEN / 2 : 0;
    let r0, r1;
    if (name === "guide") [r0, r1] = [radius - edge / 2, radius + edge / 2];
    else if (name === "fill") [r0, r1] = [radius - halfWidth, radius + halfWidth];
    else {
      const at = name === "inner" ? radius - halfWidth : radius + halfWidth;
      [r0, r1] = [at - edge / 2 - widen, at + edge / 2 + widen];
    }
    r0 = Math.max(0, r0);
    r1 = Math.max(r0, r1);
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a = (i * TAU) / RING_SEGMENTS,
        b = ((i + 1) * TAU) / RING_SEGMENTS,
        sa = Math.sin(a),
        ca = Math.cos(a),
        sb = Math.sin(b),
        cb = Math.cos(b);
      out[o++] = sa * r0;
      out[o++] = ca * r0;
      out[o++] = sa * r1;
      out[o++] = ca * r1;
      out[o++] = sb * r1;
      out[o++] = cb * r1;
      out[o++] = sa * r0;
      out[o++] = ca * r0;
      out[o++] = sb * r1;
      out[o++] = cb * r1;
      out[o++] = sb * r0;
      out[o++] = cb * r0;
    }
  }
}

// ---- countdown fill geometry ----------------------------------------------------------------------

function fillGeometry(vertexCount, index, alphaFor) {
  const geometry = new THREE.BufferGeometry();
  const colors = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) colors[v * 4 + 3] = alphaFor(v);
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(index);
  return geometry;
}

// Polar fill: centre, FILL_RINGS dim rings, then a two-ring bright band at the fill edge. A
// closed disc for areas; an open sector (one more vertex per ring) for arcs.
function polarFillGeometry(open) {
  const S = open ? FILL_SEGS + 1 : FILL_SEGS,
    spans = FILL_SEGS,
    verts = 1 + (FILL_RINGS + 2) * S,
    index = [];
  const at = (ring, j) => 1 + ring * S + (open ? j : j % S);
  for (let j = 0; j < spans; j++) index.push(0, at(0, j), at(0, j + 1));
  const band = (a, b) => {
    for (let j = 0; j < spans; j++) index.push(at(a, j), at(b, j), at(b, j + 1), at(a, j), at(b, j + 1), at(a, j + 1));
  };
  for (let r = 0; r < FILL_RINGS - 1; r++) band(r, r + 1);
  band(FILL_RINGS, FILL_RINGS + 1);
  return fillGeometry(verts, index, (v) => (v >= 1 + FILL_RINGS * S ? 1 : FILL_ALPHA));
}

// Square fill for cells: a dim inner square (vertices 0-3) and a bright frame around it (4-11).
function boxFillGeometry() {
  const index = [0, 1, 2, 0, 2, 3];
  for (let k = 0; k < 4; k++) {
    const i0 = 4 + k,
      i1 = 4 + ((k + 1) % 4),
      o0 = 8 + k,
      o1 = 8 + ((k + 1) % 4);
    index.push(i0, o0, o1, i0, o1, i1);
  }
  return fillGeometry(12, index, (v) => (v < 4 ? FILL_ALPHA : 1));
}

// Lane sweep: a bright head quad (vertices 0-3, drawn first) then a dim ladder of left/right
// pairs, one per path point; the draw range grows with progress.
function pathFillGeometry(pointCount) {
  const index = [0, 1, 2, 1, 3, 2];
  for (let k = 0; k < pointCount - 1; k++) {
    const l0 = 4 + k * 2,
      r0 = l0 + 1,
      l1 = l0 + 2,
      r1 = l0 + 3;
    index.push(l0, r0, l1, r0, r1, l1);
  }
  return fillGeometry(4 + pointCount * 2, index, (v) => (v < 4 ? 1 : FILL_ALPHA));
}

// Always drawn over everything, unfogged, like the original markers. White: every colour is a
// vertex colour, so a palette change rewrites colours without touching the material.
function markerMaterial() {
  const material = privateUnlitMaterial("#ffffff", { transparent: true, opacity: OPACITY, side: THREE.DoubleSide, depthWrite: false, fog: false });
  material.depthTest = false;
  material.vertexColors = true;
  return material;
}

export function createTelegraphs(ctx) {
  const markers = new Set();
  const spare = []; // released marker materials, reused before new ones are made
  const entries = []; // active() rows, reused
  const listing = [];
  const look = { palette: "rift", patterns: false };
  const ground = (x, z) => groundAt(ctx, x, z);
  // Marker time is play-simulation time: fades, fuses and the reticle freeze with the game.
  const clock = () => ctx.run?.elapsed ?? 0;

  function acquireMaterial() {
    const material = spare.pop() ?? markerMaterial();
    material.opacity = OPACITY;
    material.wireframe = false;
    return material;
  }

  function releaseMaterial(material) {
    if (spare.length < MATERIAL_POOL) spare.push(material);
    else material.dispose();
  }

  // The live width floors, read when a marker is built: 2 internal pixels at the current
  // retro resolution and camera distance.
  function viewDistance() {
    const eye = ctx.gfx?.camera?.position,
      target = ctx.cam?.target,
      rig = eye && target ? Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z) / 1.312 : 0;
    return Math.max(ctx.cam?.distance ?? 25, Number.isFinite(rig) ? rig : 0);
  }
  const resolutionHeight = () => ctx.gfx?.resolution?.h ?? 240;
  const minStrip = () => stripFloor(resolutionHeight(), viewDistance());
  const minGuide = () => guideFloor(resolutionHeight(), viewDistance());

  // Local (x, z) pairs -> draped world positions under the marker's anchor and yaw.
  function drape(marker, local, position, count) {
    const c = Math.cos(marker.yaw),
      s = Math.sin(marker.yaw),
      out = position.array;
    for (let v = 0; v < count; v++) {
      const lx = local[v * 2],
        lz = local[v * 2 + 1],
        x = marker.x + lx * c + lz * s,
        z = marker.z - lx * s + lz * c;
      out[v * 3] = x;
      out[v * 3 + 1] = ground(x, z) + LIFT;
      out[v * 3 + 2] = z;
    }
    position.needsUpdate = true;
  }

  // Vertex colours from the current palette: the kind's colour or the dark under-strip.
  function paint(marker) {
    const spec = marker.spec,
      colors = marker.mesh.geometry.attributes.color,
      out = colors.array;
    _color.set(marker.under);
    const ur = _color.r,
      ug = _color.g,
      ub = _color.b;
    _color.set(marker.color);
    for (let v = 0; v < spec.count; v++) {
      const dark = spec.role[v] === UNDER;
      out[v * 4] = dark ? ur : _color.r;
      out[v * 4 + 1] = dark ? ug : _color.g;
      out[v * 4 + 2] = dark ? ub : _color.b;
      out[v * 4 + 3] = spec.alpha[v];
    }
    colors.needsUpdate = true;
    if (marker.fill) paintFill(marker);
    marker.reticle?.material.color.set(marker.color);
  }

  function paintFill(marker) {
    const colors = marker.fill.geometry.attributes.color,
      out = colors.array;
    _color.set(marker.color);
    for (let v = 0; v < colors.count; v++) {
      out[v * 4] = _color.r;
      out[v * 4 + 1] = _color.g;
      out[v * 4 + 2] = _color.b;
    }
    colors.needsUpdate = true;
  }

  // Fade-in (Wave-2 markers) and the aim reticle, evaluated as each marker mesh is drawn.
  function animate() {
    const marker = this.userData.marker;
    if (!marker || marker.dead) return;
    const age = clock() - marker.born;
    const fade = marker.fades ? clamp(Math.floor(age * FADE_FPS + 1e-6) / FADE_STEPS, 0, 1) : 1;
    this.material.opacity = marker.opacity * fade;
    if (this === marker.mesh && marker.aim) updateReticle(marker);
  }

  function updateReticle(marker) {
    const left = remaining(marker);
    const show = marker.visible && left !== null && left <= RETICLE_TIME && marker.length > 0;
    if (!show) {
      if (marker.reticle) marker.reticle.visible = false;
      return;
    }
    const reticle = marker.reticle ?? createReticle(marker);
    const c = Math.cos(marker.yaw),
      s = Math.sin(marker.yaw),
      x = marker.x + marker.length * s,
      z = marker.z + marker.length * c;
    reticle.position.set(x, ground(x, z) + LIFT + 0.02, z);
    reticle.rotation.y = (Math.floor(clock() * FADE_FPS) / FADE_FPS) * RETICLE_SPIN;
    reticle.updateMatrixWorld();
    reticle.visible = true;
  }

  function createReticle(marker) {
    const shape = createShape(marker.floor);
    const h = RETICLE_HALF;
    shape.polyline([-h, -h, h, -h, h, h, -h, h, -h, -h]);
    const local = compile(shape, false, false).local;
    const positions = new Float32Array((local.length / 2) * 3);
    for (let v = 0; v < local.length / 2; v++) {
      positions[v * 3] = local[v * 2];
      positions[v * 3 + 2] = local[v * 2 + 1];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = privateUnlitMaterial(marker.color, { transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, fog: false });
    material.depthTest = false;
    const reticle = new THREE.Mesh(geometry, material);
    reticle.renderOrder = 13;
    reticle.frustumCulled = false;
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    ctx.gfx?.layers?.effects?.add(reticle);
    marker.reticle = reticle;
    return reticle;
  }

  // Seconds left of the fuse, or null when the caller gave no eta.
  function remaining(marker) {
    const eta = marker.meta.eta;
    return Number.isFinite(eta) ? Math.max(0, eta - (clock() - marker.meta.started)) : null;
  }

  function readMeta(meta, kind) {
    const m = meta && typeof meta === "object" ? meta : {};
    return {
      owner: m.owner ?? null,
      eta: Number.isFinite(m.eta) ? m.eta : null,
      started: Number.isFinite(m.started) ? m.started : clock(),
      targetsPlayer: typeof m.targetsPlayer === "boolean" ? m.targetsPlayer : null,
      cls: typeof m.cls === "string" ? m.cls : classOfKind(kind),
    };
  }

  function create(shape, kind, x, z, yaw, spec, meta, extra) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(spec.count * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(spec.count * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(geometry, acquireMaterial());
    mesh.renderOrder = 12;
    mesh.frustumCulled = false;
    mesh.userData.danger = true;
    const info = readMeta(meta, kind);
    const marker = {
      shape,
      kind,
      cls: info.cls,
      clsOverride: typeof meta?.cls === "string" ? meta.cls : null,
      color: kindColor(kind, look.palette, typeof meta?.cls === "string" ? meta.cls : null),
      under: look.palette === "contrast" ? UNDER_COLORS.contrast : UNDER_COLORS.deep,
      x,
      z,
      yaw,
      radius: 0,
      width: 0,
      length: 0,
      progress: 0,
      opacity: OPACITY,
      wireframe: false,
      visible: true,
      mesh,
      fill: null,
      reticle: null,
      spec,
      floor: spec.floor,
      pts: null,
      world: null,
      fillLocal: null,
      meta: info,
      born: clock(),
      fades: FADING.has(kind) || shape === "arc" || shape === "band" || shape === "cell",
      aim: false,
      dead: false,
      ...extra,
    };
    mesh.userData.marker = marker;
    mesh.onBeforeRender = animate;
    if (marker.fades) mesh.material.opacity = 0;
    paint(marker);
    drape(marker, spec.local, geometry.attributes.position, spec.count);
    ctx.gfx?.layers?.effects?.add(mesh);
    markers.add(marker);
    updateWorld(marker);
    return marker;
  }

  // Dark under-strips: every strip under the high-contrast palette, and always for the pale
  // shard and tear kinds.
  const underFor = (kind) => look.palette === "contrast" || UNDER_KINDS.includes(kind);
  const patterned = () => patternsOn(look.palette, look.patterns);

  function build(builder, kind, split = true) {
    const floor = minStrip();
    const shape = createShape(floor);
    builder(shape);
    const spec = compile(shape, underFor(kind), split);
    spec.floor = floor;
    return spec;
  }

  // Straight aim line (or lane when width >= 0.2) from (x, z) along yaw, a point every 0.5 m.
  function line(x, z, yaw = 0, length = 10, width = 0.085, kind = "aim", meta = null) {
    const span = Math.max(0, Number.isFinite(length) ? length : 0);
    const steps = Math.floor(span / LINE_STEP + 1e-6);
    const along = [];
    for (let i = 0; i <= steps; i++) along.push(i * LINE_STEP);
    if (span - steps * LINE_STEP > 0.01) along.push(span); // end exactly on the obstruction
    const pts = new Float32Array(along.length * 2);
    along.forEach((d, i) => (pts[i * 2 + 1] = d));
    const w = width > 0 ? width : 0.085;
    const k = kindOf(kind, "aim");
    const cls = meta?.cls ?? classOfKind(k);
    const spec = build((shape) => pathShape(shape, pts, w, cls, { patterned: patterned(), jagged: false }), k);
    return create("path", k, x, z, yaw, spec, meta, { width: w, length: span, pts, aim: w < THIN && cls === "aim" });
  }

  function area(x, z, radius = 2, kind = "ground", meta = null) {
    const k = kindOf(kind, "ground"),
      r = Number.isFinite(radius) ? Math.max(0.05, radius) : 2,
      cls = meta?.cls ?? classOfKind(k);
    const spec = build((shape) => areaShape(shape, r, k, cls, patterned()), k);
    return create("area", k, x, z, 0, spec, meta, { radius: r });
  }

  // Charge lanes and predicted corridors. Accepts {x, z} points or the original [x, z] pairs.
  function path(points = [], width = 0.3, kind = "charge", meta = null, jagged = null) {
    const list = Array.isArray(points) ? points : [];
    const px = (p) => (Array.isArray(p) ? p[0] : p?.x),
      pz = (p) => (Array.isArray(p) ? p[1] : p?.z);
    const valid = list.filter((p) => Number.isFinite(px(p)) && Number.isFinite(pz(p)));
    const x0 = valid.length ? px(valid[0]) : 0,
      z0 = valid.length ? pz(valid[0]) : 0;
    const pts = new Float32Array(valid.length * 2);
    valid.forEach((p, i) => {
      pts[i * 2] = px(p) - x0;
      pts[i * 2 + 1] = pz(p) - z0;
    });
    let span = 0;
    for (let i = 1; i < valid.length; i++) span += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    const w = width > 0 ? width : 0.3;
    const k = kindOf(kind, "charge");
    const cls = meta?.cls ?? classOfKind(k);
    const crack = jagged ?? !!STYLES[k].jagged;
    const spec = build((shape) => pathShape(shape, pts, w, cls, { patterned: patterned(), jagged: crack }), k);
    return create("path", k, x0, z0, 0, spec, meta, { width: w, length: span, pts, aim: !crack && w < THIN && cls === "aim" });
  }

  // Filled sector (Bellwether sweep, Castellan bash): set(marker, { yaw }) turns it in place.
  function arc(x, z, yaw = 0, radius = 3, halfAngle = Math.PI / 3, kind = "arc", meta = null) {
    const k = kindOf(kind, "arc"),
      r = Number.isFinite(radius) ? Math.max(0.05, radius) : 3,
      h = clamp(Number.isFinite(halfAngle) ? halfAngle : Math.PI / 3, 0.05, Math.PI),
      cls = meta?.cls ?? classOfKind(k);
    const spec = build((shape) => arcShape(shape, r, h, k, cls, patterned()), k);
    return create("arc", k, x, z, Number.isFinite(yaw) ? yaw : 0, spec, meta, { radius: r, halfAngle: h });
  }

  // Expanding ring whose drawn band is the damage; set(marker, { radius }) re-lays it in place.
  // meta.guide (or halfWidth <= 0) draws a static reach guide instead: one ring of the guide
  // width at opacity 0.5.
  function band(x, z, radius = 1, halfWidth = 0.6, kind = "wave", meta = null) {
    const k = kindOf(kind, "wave"),
      r = Number.isFinite(radius) ? Math.max(0, radius) : 1,
      guide = meta?.guide === true || !(halfWidth > 0),
      floor = minStrip();
    const spec = bandSpec(guide, guide ? 0 : halfWidth, guide ? minGuide() : floor, !guide && underFor(k));
    spec.floor = floor;
    layoutBand(spec, r);
    const marker = create("band", k, x, z, 0, spec, meta, { radius: r, width: guide ? 0 : halfWidth, guide });
    if (guide) set(marker, { opacity: GUIDE_OPACITY });
    return marker;
  }

  // Square grid cell (Castellan aurora grid), axis-aligned.
  function cell(x, z, half = 1.5, kind = "lance", meta = null) {
    const k = kindOf(kind, "lance"),
      h = Number.isFinite(half) ? Math.max(0.05, half) : 1.5,
      cls = meta?.cls ?? classOfKind(k);
    const spec = build((shape) => cellShape(shape, h, k, cls, patterned()), k);
    return create("cell", k, x, z, 0, spec, meta, { radius: h, half: h });
  }

  // A path in the fissure style: no rails, a jagged crack down the centre.
  const fissure = (points, width = 0.9, kind = "fissure", meta = null) => path(points, width, kindOf(kind, "fissure"), meta, true);

  // ---- countdown fill ----

  function ensureFill(marker) {
    if (marker.fill) return marker.fill;
    const count = marker.pts ? marker.pts.length / 2 : 0;
    let geometry;
    if (marker.shape === "path") {
      if (count < 2 || marker.length <= 0) return null;
      geometry = pathFillGeometry(count);
    } else if (marker.shape === "cell") geometry = boxFillGeometry();
    else if (marker.shape === "area" || marker.shape === "arc") geometry = polarFillGeometry(marker.shape === "arc");
    else return null;
    const material = acquireMaterial();
    material.wireframe = marker.wireframe;
    const fill = new THREE.Mesh(geometry, material);
    fill.renderOrder = 11;
    fill.frustumCulled = false;
    fill.userData.marker = marker;
    fill.onBeforeRender = animate;
    marker.fillLocal = new Float32Array(geometry.attributes.position.count * 2);
    marker.fill = fill;
    paintFill(marker);
    ctx.gfx?.layers?.effects?.add(fill);
    return fill;
  }

  // Rings of the polar fill up to the fill edge (reach), over the whole disc or the arc's sector.
  function layoutPolarFill(marker) {
    const out = marker.fillLocal,
      reach = marker.radius * marker.progress,
      band = Math.max(marker.floor, 0.14),
      open = marker.shape === "arc",
      S = open ? FILL_SEGS + 1 : FILL_SEGS,
      h = marker.halfAngle ?? Math.PI;
    const ring = (k, r) => {
      for (let j = 0; j < S; j++) {
        const o = (1 + k * S + j) * 2;
        if (open) {
          const a = -h + (2 * h * j) / FILL_SEGS;
          out[o] = Math.sin(a) * r;
          out[o + 1] = Math.cos(a) * r;
        } else {
          out[o] = FILL_SIN[j] * r;
          out[o + 1] = FILL_COS[j] * r;
        }
      }
    };
    out[0] = out[1] = 0;
    for (let k = 0; k < FILL_RINGS; k++) ring(k, (reach * (k + 1)) / FILL_RINGS);
    ring(FILL_RINGS, Math.max(0, reach - band));
    ring(FILL_RINGS + 1, reach);
    return out.length / 2;
  }

  function layoutBoxFill(marker) {
    const out = marker.fillLocal,
      outer = marker.half * marker.progress,
      inner = Math.max(0, outer - Math.max(marker.floor, 0.14));
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let k = 0; k < 4; k++) {
      out[k * 2] = corners[k * 2] * inner;
      out[k * 2 + 1] = corners[k * 2 + 1] * inner;
      out[(4 + k) * 2] = corners[k * 2] * inner;
      out[(4 + k) * 2 + 1] = corners[k * 2 + 1] * inner;
      out[(8 + k) * 2] = corners[k * 2] * outer;
      out[(8 + k) * 2 + 1] = corners[k * 2 + 1] * outer;
    }
    return 12;
  }

  // Writes the ladder up to the cut point at progress * length. Returns k, the segment the cut
  // lies on: pairs 0..k+1 and segments 0..k are live.
  function layoutPathFill(marker) {
    const out = marker.fillLocal,
      pts = marker.pts,
      count = pts.length / 2,
      thin = marker.width < THIN,
      half = thin ? Math.max(marker.width, marker.floor / 2) : Math.max(0.05, marker.width - marker.floor / 2),
      headHalf = thin ? Math.max(0.26, marker.width * 3) : marker.width,
      target = marker.length * marker.progress;
    let travelled = 0,
      k = 0,
      t = 1;
    for (; k < count - 1; k++) {
      const seg = Math.hypot(pts[k * 2 + 2] - pts[k * 2], pts[k * 2 + 3] - pts[k * 2 + 1]);
      if (travelled + seg >= target || k === count - 2) {
        t = seg > 0 ? clamp((target - travelled) / seg, 0, 1) : 1;
        break;
      }
      travelled += seg;
    }
    // Left/right pair for every point up to k, then the interpolated cut point.
    let dirX = 0,
      dirZ = 1;
    const depth = Math.max(HEAD_DEPTH, marker.floor) / 2;
    for (let p = 0; p <= k + 1; p++) {
      const seg = Math.min(p, k),
        sx = pts[seg * 2 + 2] - pts[seg * 2],
        sz = pts[seg * 2 + 3] - pts[seg * 2 + 1],
        d = Math.hypot(sx, sz);
      if (d > 1e-6) {
        dirX = sx / d;
        dirZ = sz / d;
      }
      const cx = p <= k ? pts[p * 2] : pts[k * 2] + sx * t,
        cz = p <= k ? pts[p * 2 + 1] : pts[k * 2 + 1] + sz * t,
        o = (4 + p * 2) * 2;
      out[o] = cx - dirZ * half;
      out[o + 1] = cz + dirX * half;
      out[o + 2] = cx + dirZ * half;
      out[o + 3] = cz - dirX * half;
      if (p === k + 1) {
        out[0] = cx - dirZ * headHalf - dirX * depth;
        out[1] = cz + dirX * headHalf - dirZ * depth;
        out[2] = cx + dirZ * headHalf - dirX * depth;
        out[3] = cz - dirX * headHalf - dirZ * depth;
        out[4] = cx - dirZ * headHalf + dirX * depth;
        out[5] = cz + dirX * headHalf + dirZ * depth;
        out[6] = cx + dirZ * headHalf + dirX * depth;
        out[7] = cz - dirX * headHalf + dirZ * depth;
      }
    }
    return k;
  }

  // A damage band brightens its fill with its countdown (it has no separate fill mesh).
  function brightenBand(marker) {
    const colors = marker.mesh.geometry.attributes.color,
      alpha = BAND_ALPHA + (1 - BAND_ALPHA) * 0.6 * marker.progress;
    for (let v = 0; v < marker.spec.fillCount; v++) colors.array[v * 4 + 3] = alpha;
    colors.needsUpdate = true;
  }

  function refreshFill(marker) {
    if (marker.shape === "band") {
      if (!marker.guide) brightenBand(marker);
      return;
    }
    if (marker.progress <= 0) {
      if (marker.fill) marker.fill.visible = false;
      return;
    }
    const fill = ensureFill(marker);
    if (!fill) return;
    const position = fill.geometry.attributes.position;
    if (marker.shape === "path") {
      const k = layoutPathFill(marker);
      drape(marker, marker.fillLocal, position, 4 + (k + 2) * 2);
      fill.geometry.setDrawRange(0, 6 + (k + 1) * 6);
    } else if (marker.shape === "cell") drape(marker, marker.fillLocal, position, layoutBoxFill(marker));
    else drape(marker, marker.fillLocal, position, layoutPolarFill(marker));
    fill.visible = marker.visible;
  }

  // Aim lines thicken from the width floor to twice it over the windup (in steps).
  function thicken(marker) {
    const factor = 1 + Math.round(marker.progress * THICKEN_STEPS) / THICKEN_STEPS;
    if (factor === marker.spec.factor) return false;
    layout(marker.spec, factor);
    return true;
  }

  // World-space path points (active() rows) for lanes and lines.
  function updateWorld(marker) {
    if (!marker.pts) return;
    if (!marker.world) marker.world = new Float32Array(marker.pts.length);
    const c = Math.cos(marker.yaw),
      s = Math.sin(marker.yaw),
      pts = marker.pts,
      out = marker.world;
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = marker.x + pts[i] * c + pts[i + 1] * s;
      out[i + 1] = marker.z - pts[i] * s + pts[i + 1] * c;
    }
  }

  // ---- public API ----

  function shift(marker, key, value) {
    if (!Number.isFinite(value) || Math.abs(value - marker[key]) <= MOVE_EPSILON) return false;
    marker[key] = value;
    return true;
  }

  function set(marker, options = {}) {
    if (!marker || marker.dead || !options) return marker;
    // Evaluate all three so every changed coordinate is stored before re-draping.
    const movedX = shift(marker, "x", options.x),
      movedZ = shift(marker, "z", options.z),
      turned = shift(marker, "yaw", options.yaw);
    let moved = movedX || movedZ || turned;
    if (marker.shape === "band" && shift(marker, "radius", options.radius)) {
      layoutBand(marker.spec, marker.radius);
      moved = true;
    }
    if (Number.isFinite(options.opacity)) {
      marker.opacity = clamp(options.opacity, 0, 1);
      marker.mesh.material.opacity = marker.opacity;
      if (marker.fill) marker.fill.material.opacity = marker.opacity;
    }
    if (typeof options.wireframe === "boolean" && options.wireframe !== marker.wireframe) {
      marker.wireframe = options.wireframe;
      marker.mesh.material.wireframe = marker.wireframe;
      if (marker.fill) marker.fill.material.wireframe = marker.wireframe;
    }
    if (typeof options.visible === "boolean") {
      marker.visible = options.visible;
      marker.mesh.visible = marker.visible;
      if (marker.fill) marker.fill.visible = marker.visible && marker.progress > 0;
      if (marker.reticle && !marker.visible) marker.reticle.visible = false;
    }
    let grew = false;
    if (Number.isFinite(options.progress)) {
      const p = clamp(options.progress, 0, 1);
      // Small steps are skipped (the fill moves in visible increments); ends always land.
      if (Math.abs(p - marker.progress) >= PROGRESS_EPSILON || (p !== marker.progress && (p === 0 || p === 1))) {
        marker.progress = p;
        grew = true;
        if (marker.aim && thicken(marker)) moved = true;
      }
    }
    if (moved) {
      drape(marker, marker.spec.local, marker.mesh.geometry.attributes.position, marker.spec.count);
      updateWorld(marker);
    }
    if (moved || grew) refreshFill(marker);
    return marker;
  }

  function dispose(mesh, pooled = true) {
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.onBeforeRender = NOOP;
    mesh.userData.marker = null;
    mesh.geometry.dispose();
    if (pooled) releaseMaterial(mesh.material);
    else mesh.material.dispose();
  }

  function remove(marker) {
    if (!marker || marker.dead) return;
    marker.dead = true;
    markers.delete(marker);
    dispose(marker.mesh);
    dispose(marker.fill);
    dispose(marker.reticle, false);
    marker.mesh = marker.fill = marker.reticle = null;
  }

  function clear() {
    for (const marker of markers) remove(marker);
  }

  // Every live marker as a registry row for the radar and the off-screen arrows:
  // [{ marker, kind, cls, shape, x, z, radius, width, path, yaw, eta, remaining, owner,
  // targetsPlayer }]. x/z is the source (a lane's or line's first point) or the footprint
  // centre; radius bounds the footprint. The array and its rows are reused on every call.
  function active() {
    listing.length = 0;
    let i = 0;
    for (const marker of markers) {
      const row = entries[i] ?? (entries[i] = {});
      row.marker = marker;
      row.kind = marker.kind;
      row.cls = marker.cls;
      row.shape = marker.shape;
      row.x = marker.x;
      row.z = marker.z;
      row.radius = marker.shape === "band" ? marker.radius + marker.width : marker.shape === "cell" ? marker.half * Math.SQRT2 : marker.radius;
      row.width = marker.width;
      row.path = marker.world;
      row.yaw = marker.yaw;
      row.eta = marker.meta.eta;
      row.remaining = remaining(marker);
      row.owner = marker.meta.owner;
      row.targetsPlayer = marker.meta.targetsPlayer;
      listing.push(row);
      i++;
    }
    return listing;
  }

  // Recolours every live marker for a palette (patterns apply to markers built from now on).
  function setPalette(name = look.palette, patterns = look.patterns) {
    look.palette = validPalette(name);
    look.patterns = !!patterns;
    setLook({ palette: look.palette, threatEyes: ctx.prefs?.threatEyes });
    for (const marker of markers) {
      marker.color = kindColor(marker.kind, look.palette, marker.clsOverride);
      marker.under = look.palette === "contrast" ? UNDER_COLORS.contrast : UNDER_COLORS.deep;
      paint(marker);
    }
  }

  const syncPrefs = () => setPalette(ctx.prefs?.palette, ctx.prefs?.telegraphPatterns);
  ctx.bus?.on?.("prefs", syncPrefs);
  syncPrefs();

  return {
    line,
    area,
    path,
    arc,
    band,
    cell,
    fissure,
    set,
    remove,
    clear,
    count: () => markers.size,
    active,
    setPalette,
    get palette() {
      return look.palette;
    },
    minStrip,
    minGuide,
  };
}
