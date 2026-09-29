// Swept projectile collision in world space. traceWorld finds the first solid surface
// (terrain or cover) along a segment; hitBody clips a segment to a vertical body cylinder.
// Everything here runs per shot per step, so it allocates only when it reports a hit.
import { EdgeCrossings } from "./terrain.js";

export const pointAt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

const cuts = new EdgeCrossings();
// Clip interval shared by the slab/plane tests below.
let clipLow = 0,
  clipHigh = 1;
function clipSlab(p, d, min, max) {
  if (Math.abs(d) < 1e-10) return p >= min && p <= max;
  let a = (min - p) / d,
    b = (max - p) / d;
  if (a > b) [a, b] = [b, a];
  clipLow = Math.max(clipLow, a);
  clipHigh = Math.min(clipHigh, b);
  return clipLow <= clipHigh;
}

// Entry parameter t in [0, 1] of segment a->b into a vertical cylinder, or null.
export function hitBody(a, b, body) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    ox = a.x - body.x,
    oz = a.z - body.z,
    A = dx * dx + dz * dz,
    C = ox * ox + oz * oz - body.radius * body.radius;
  clipLow = 0;
  clipHigh = 1;
  if (A < 1e-12) {
    if (C > 0) return null;
  } else {
    const B = 2 * (ox * dx + oz * dz),
      D = B * B - 4 * A * C;
    if (D < 0) return null;
    clipLow = Math.max(0, (-B - Math.sqrt(D)) / (2 * A));
    clipHigh = Math.min(1, (-B + Math.sqrt(D)) / (2 * A));
    if (clipLow > clipHigh) return null;
  }
  if (!clipSlab(a.y, b.y - a.y, body.bottom, body.top)) return null;
  return clipLow;
}

// World-space bounding box used to skip covers far from a segment. Conservative for any
// rotation: a circle around the footprint plus the vertical extent.
export function coverBounds(cover) {
  const h = cover.hull;
  let reach, bottom, top;
  if (h) {
    reach = Math.hypot(Math.max(-h.min.x, h.max.x) * cover.sx, Math.max(-h.min.z, h.max.z) * cover.sz);
    bottom = cover.y + h.min.y * cover.sy;
    top = cover.y + h.max.y * cover.sy;
  } else {
    reach =
      cover.shape === "box" ? Math.hypot(cover.sx, cover.sz) / 2 : Math.max(cover.sx, cover.sz) * (roundShape(cover.shape) ? 1 : 0.65);
    bottom = cover.y - cover.sy / 2;
    top = cover.y + cover.sy / 2;
  }
  return { minX: cover.x - reach, maxX: cover.x + reach, minZ: cover.z - reach, maxZ: cover.z + reach, bottom, top };
}
const roundShape = (shape) => shape === "cylinder" || shape === "cone";

// Local coordinates of the segment in the cover's frame (translated, rotated by -rotation).
let px = 0,
  py = 0,
  pz = 0,
  qx = 0,
  qy = 0,
  qz = 0;
function toLocal(a, b, o) {
  const c = Math.cos(o.rotation || 0),
    s = Math.sin(o.rotation || 0),
    ax = a.x - o.x,
    az = a.z - o.z,
    bx = b.x - o.x,
    bz = b.z - o.z;
  px = c * ax - s * az;
  py = a.y - o.y;
  pz = s * ax + c * az;
  qx = c * bx - s * bz;
  qy = b.y - o.y;
  qz = s * bx + c * bz;
}

// Entry parameter of a->b into one cover (inflated by r), or null.
function hitCover(a, b, o, r) {
  toLocal(a, b, o);
  clipLow = 0;
  clipHigh = 1;
  const hull = o.hull;
  if (hull) {
    if (
      !clipSlab(px, qx - px, hull.min.x * o.sx - r, hull.max.x * o.sx + r) ||
      !clipSlab(py, qy - py, hull.min.y * o.sy - r, hull.max.y * o.sy + r) ||
      !clipSlab(pz, qz - pz, hull.min.z * o.sz - r, hull.max.z * o.sz + r)
    )
      return null;
    // Clip against the true convex faces (tapered crowns, crystal tips); scaled normals are n/s.
    const planes = hull.planes;
    for (let i = 0; i < planes.length; i++) {
      const face = planes[i],
        nx = face.x / o.sx,
        ny = face.y / o.sy,
        nz = face.z / o.sz,
        pad = r * Math.hypot(nx, ny, nz),
        from = px * nx + py * ny + pz * nz - face.w - pad,
        to = qx * nx + qy * ny + qz * nz - face.w - pad;
      if (from > 0 && to > 0) return null;
      if (from <= 0 && to <= 0) continue;
      const t = from / (from - to);
      if (from > 0) clipLow = Math.max(clipLow, t);
      else clipHigh = Math.min(clipHigh, t);
      if (clipLow > clipHigh) return null;
    }
    return clipLow;
  }
  if (o.shape === "cylinder" || o.shape === "cone" || o.shape === "gem" || o.shape === "ico") {
    const radius = Math.max(o.sx, o.sz) * (roundShape(o.shape) ? 1 : 0.65) + r;
    return hitLocalCylinder(radius, -o.sy / 2 - r, o.sy / 2 + r);
  }
  if (
    !clipSlab(px, qx - px, -o.sx / 2 - r, o.sx / 2 + r) ||
    !clipSlab(py, qy - py, -o.sy / 2 - r, o.sy / 2 + r) ||
    !clipSlab(pz, qz - pz, -o.sz / 2 - r, o.sz / 2 + r)
  )
    return null;
  return clipLow;
}
// hitBody on the local segment against a cylinder at the cover origin.
function hitLocalCylinder(radius, bottom, top) {
  const dx = qx - px,
    dz = qz - pz,
    A = dx * dx + dz * dz,
    C = px * px + pz * pz - radius * radius;
  clipLow = 0;
  clipHigh = 1;
  if (A < 1e-12) {
    if (C > 0) return null;
  } else {
    const B = 2 * (px * dx + pz * dz),
      D = B * B - 4 * A * C;
    if (D < 0) return null;
    clipLow = Math.max(0, (-B - Math.sqrt(D)) / (2 * A));
    clipHigh = Math.min(1, (-B + Math.sqrt(D)) / (2 * A));
    if (clipLow > clipHigh) return null;
  }
  if (!clipSlab(py, qy - py, bottom, top)) return null;
  return clipLow;
}

// Nearest cover entry before `limit` (Infinity for none); the cover it entered is left in
// coverHit (null for none).
let coverHitT = Infinity,
  coverHit = null;
function nearestCover(a, b, covers, r, limit) {
  const minX = Math.min(a.x, b.x) - r,
    maxX = Math.max(a.x, b.x) + r,
    minZ = Math.min(a.z, b.z) - r,
    maxZ = Math.max(a.z, b.z) + r,
    minY = Math.min(a.y, b.y) - r,
    maxY = Math.max(a.y, b.y) + r;
  coverHitT = limit;
  coverHit = null;
  for (let i = 0; i < covers.length; i++) {
    const cover = covers[i],
      box = cover.bounds || (cover.bounds = coverBounds(cover));
    if (box.maxX < minX || box.minX > maxX || box.maxZ < minZ || box.minZ > maxZ || box.top < minY || box.bottom > maxY)
      continue;
    const hit = hitCover(a, b, cover, r);
    if (hit !== null && hit < coverHitT) {
      coverHitT = hit;
      coverHit = cover;
    }
  }
  return coverHitT;
}

// First solid surface along a->b: `world` = { height(x, z), covers }. The heightfield is
// piecewise planar between grid and diagonal lines, so the segment is split there and a fast
// round can never skip a narrow ridge. Returns { t, kind: "terrain"|"structure", x, y, z, cover }
// or null; `cover` is the cover entered (a prop's cover carries `prop`, IMPROVEMENTS F10), null
// for terrain.
export function traceWorld(a, b, world, r = 0.04) {
  let prev = a.y - world.height(a.x, a.z) - r;
  if (prev <= 0) return { t: 0, kind: "terrain", x: a.x, y: a.y, z: a.z, cover: null };
  let t = Infinity,
    last = 0;
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z;
  cuts.reset(a.x, a.z, b.x, b.z);
  for (;;) {
    const at = cuts.next();
    if (at > last) {
      const x = a.x + dx * at,
        z = a.z + dz * at,
        clear = a.y + dy * at - world.height(x, z) - r;
      if (clear <= 0) {
        t = last + ((at - last) * prev) / (prev - clear);
        break;
      }
      last = at;
      prev = clear;
    }
    if (at >= 1) break;
  }
  const covers = world.covers;
  const structure = covers?.length ? nearestCover(a, b, covers, r, t) : t;
  if (!Number.isFinite(structure)) return null;
  const onCover = structure < t;
  return { t: structure, kind: onCover ? "structure" : "terrain", ...pointAt(a, b, structure), cover: onCover ? coverHit : null };
}

// Covers only (terrain ignored), e.g. Iron Maw's charge lane test. Same result shape.
export function traceCovers(a, b, covers, r = 0.04) {
  const t = nearestCover(a, b, covers, r, Infinity);
  return Number.isFinite(t) ? { t, kind: "structure", ...pointAt(a, b, t), cover: coverHit } : null;
}
