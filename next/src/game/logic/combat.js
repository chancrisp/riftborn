// Pure combat rules (IMPROVEMENTS F1.4), THREE-free so tests drive them directly; combat.js
// re-exports them.
import { clamp } from "../../core/util.js";

// Hostile rounds without a colour of their own (the Wave-1 sniper round).
export const HOSTILE_ROUND = "#cd85a8";

// Explosions centred this close to their target carry no direction of their own (F1.4a).
export const BLAST_CENTRED = 0.3;
// Insta Kill's multiplier on boss-like enemies, and the cap of steps 1-5 on keepers and bosses.
export const EXECUTE_MULT = 1.5;
export const KEEPER_CAP = 3;

// Enemies that take ledger bossDamage and Insta Kill's capped multiplier (pipeline steps 4-5).
export const bossLike = (e) => !!(e?.boss || e?.keeper || e?.elite || e?.trialElite);

// A guarded enemy's live guard: its own override (null = lowered) or its def's.
export const guardOf = (e) => (e?.guard !== undefined ? e.guard : (e?.def?.guard ?? null));

// Arc for the angle (degrees) between the enemy's facing and the hit's direction. Boundaries
// are strict: with front 55, 55.0 is "side"; front 181 makes every angle "front".
export function arcOf(angle, g) {
  if (angle < g.front) return "front";
  if (g.rear !== undefined && angle > g.rear) return "rear";
  return "side";
}

export function arcMult(g, arc) {
  if (!g) return 1;
  if (arc === "front") return g.frontMult;
  if (arc === "rear") return g.rearMult ?? 1;
  return 1;
}

// A player shot other than a rocket: the only damage a blocking guard stops and reflects.
// Shots carry `shot` (their own id, IMPROVEMENTS §3.10) on every hit they deal.
export const isBullet = (source) => source?.shot !== undefined && !source.rocket && !source.enemy;

// Unit xz vector from `e` toward where a hit came from, written into `out` (F1.4a): the blast
// centre for explosions, the reverse of a shot's flight (source.dir), else the player's
// position. A blast centred on its target (every Witch Glass burst) and every directionless
// source (mods, zones, relics, reflections) use the player's bearing, so they flank only when
// the player flanks. A source on top of the enemy reads as its facing.
export function hitDirection(e, source, blast, player, out) {
  const b = blast ?? source?.blast ?? null;
  let dx, dz;
  if (b && Math.hypot(b.x - e.x, b.z - e.z) > BLAST_CENTRED) {
    dx = b.x - e.x;
    dz = b.z - e.z;
  } else if (!b && source?.dir) {
    dx = source.dir.x;
    dz = source.dir.z;
  } else {
    dx = (player?.x ?? e.x) - e.x;
    dz = (player?.z ?? e.z) - e.z;
  }
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) {
    out.x = Math.sin(e.yaw || 0);
    out.z = Math.cos(e.yaw || 0);
  } else {
    out.x = dx / length;
    out.z = dz / length;
  }
  return out;
}

// Degrees between a facing yaw and a unit direction (0 = straight into the face).
export function hitAngle(yaw, dir) {
  return (Math.acos(clamp(dir.x * Math.sin(yaw) + dir.z * Math.cos(yaw), -1, 1)) * 180) / Math.PI;
}

const direction = { x: 0, z: 0 };

// { arc, angle } of a hit on `e`, written into `out`. Without a live guard the arc is "side"
// (multiplier 1). A Rift Scar laid by a shot that this guard blocked keeps striking its front,
// whatever the bearing (the scar exemption). An unblocked source (blockedBy null or absent)
// never matches, even on an enemy without an id.
export function classifyHit(e, source, blast, player, out) {
  const g = guardOf(e);
  out.angle = hitAngle(e.yaw || 0, hitDirection(e, source, blast, player, direction));
  if (!g) out.arc = "side";
  else out.arc = source?.blockedBy != null && source.blockedBy === e.id ? "front" : arcOf(out.angle, g);
  return out;
}

// Insta Kill applies to weapon damage only: never to relics, zones or the environment (F1.4b).
export const executes = (boons, source) =>
  (boons?.execution ?? 0) > 0 && source?.weapon >= 0 && !source.relic && !source.environment && !source.zone;

// Strips the float noise of a multiplied hit (0.35 × 1.5 is 0.52499…), so the values the design
// states land exactly: 100 into the Abbot's crust under Insta Kill is 52.5, not 52.49999….
// The executed amount (HP plus shell) is never snapped, so an execution always kills.
const snap = (x) => Math.round(x * 1e9) / 1e9;

// Pipeline steps 1-5 (F1.4b): guard m1, anchors m2, window v and ledger m4, then Insta Kill.
// Boss-like enemies take max(v, 1.5) under Insta Kill, capped at x3 on keepers and bosses;
// anything else is executed outright (its HP plus any shell).
export function scaledHit(damage, m1, m2, v, m4, exec, e) {
  if (bossLike(e)) {
    let mult = m1 * m2 * Math.max(v, exec ? EXECUTE_MULT : 1) * m4;
    if (e.keeper || e.boss) mult = Math.min(mult, KEEPER_CAP);
    return snap(damage * mult);
  }
  const scaled = snap(damage * m1 * m2 * v * m4);
  return exec ? Math.max(scaled, e.hp + (e.shell || 0)) : scaled;
}

// Whether the point (dx, dz) from a box's centre lies in the yawed box (sx, sz half-extents
// along its local x and z) grown by `pad`.
export function insideBox(dx, dz, sx, sz, yaw = 0, pad = 0) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return Math.abs(dx * c - dz * s) <= sx + pad && Math.abs(dx * s + dz * c) <= sz + pad;
}

// Whether a body of radius `pad` at (x, z) stands in a zone's footprint (F1.4c).
export function insideZone(zone, x, z, pad) {
  const dx = x - zone.x,
    dz = z - zone.z;
  if (zone.shape === "box") return insideBox(dx, dz, zone.sx, zone.sz, zone.yaw, pad);
  const reach = zone.radius + pad;
  return dx * dx + dz * dz < reach * reach;
}

// The zone to evict at the cap (F1.4c): the oldest trail zone, else the oldest friendly
// (relic) zone, else the oldest. Zones are kept in creation order.
export function evictionIndex(zones) {
  let friendly = -1;
  for (let i = 0; i < zones.length; i++) {
    if (zones[i].trail) return i;
    if (friendly < 0 && zones[i].friendly) friendly = i;
  }
  return Math.max(0, friendly);
}

// A player-damage source that knows where it came from (IMPROVEMENTS F16.4): an object keeps
// the fields the cause and its listeners read (id, kind, label, affix, hammer); a bare id
// becomes { id }. The position is (x, z) unless the source already has one.
const PLACED_KEYS = Object.freeze(["id", "kind", "label", "affix", "hammer"]);

export function placedSource(source, x, z) {
  if (source && typeof source === "object") {
    if (Number.isFinite(source.x) && Number.isFinite(source.z)) return source;
    const out = { x, z };
    for (const key of PLACED_KEYS) if (source[key] !== undefined) out[key] = source[key];
    return out;
  }
  return source == null || source === "" ? { x, z } : { id: String(source), x, z };
}
