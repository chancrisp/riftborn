// Pure keeper rules (IMPROVEMENTS F1.6, F2-F6), THREE-free so tests drive them directly;
// bosses.js re-exports them for the keeper AI files. Positions are plain { x, z } records and
// every random draw comes from the caller's stream.
import { clamp, wrapAngle, TAU } from "../../core/util.js";
import { KEEPER_ORDER } from "../../data/keepers.js";

// ---- facing and attack choice (F1.6) -------------------------------------------------------

// Turns actor.yaw toward `yaw` by at most rate × dt (rad), the short way round.
export function turnToward(actor, yaw, rate, dt) {
  const step = Math.max(0, rate * dt);
  actor.yaw += clamp(wrapAngle(yaw - actor.yaw), -step, step);
  return actor.yaw;
}

// A row can be picked by weight: in range (min <= d < max), its cooldown key ready
// (e[row.cd] < 0) and its optional `when(e, d)` condition met.
function eligible(row, e, d) {
  return row.weight > 0 && (row.min ?? 0) <= d && d < (row.max ?? Infinity) && (!row.cd || e[row.cd] < 0) && (!row.when || row.when(e, d));
}

// Attack table rows: { id, weight, min = 0, max = Infinity, forced(e, d), cd, when(e, d) }.
// The first row whose forced() holds wins; otherwise one weighted draw from `rng` among the
// eligible rows. null (nothing eligible) keeps the keeper approaching.
export function pickAttack(e, table, d, rng) {
  if (!table?.length) return null;
  for (const row of table) if (row.forced?.(e, d)) return row;
  let total = 0;
  for (const row of table) if (eligible(row, e, d)) total += row.weight;
  if (!(total > 0)) return null;
  let roll = rng() * total,
    last = null;
  for (const row of table) {
    if (!eligible(row, e, d)) continue;
    last = row;
    roll -= row.weight;
    if (roll < 0) return row;
  }
  return last; // float residue on the very last row
}

// ---- phase gates (F1.6) -------------------------------------------------------------------
// A keeper carries e.gates (HP fractions, descending) and e.gatesOpen (how many have opened).
// Only startKeeper sets them, so ORIGINAL bosses never have a floor.

// The HP fraction of the highest gate the keeper has not opened yet, or null.
export function nextGate(e) {
  const gates = e?.gates,
    open = e?.gatesOpen || 0;
  return gates && open < gates.length ? gates[open] : null;
}

// The pending gate once HP has come down to it (the AI then starts the transition it guards).
export function gateDue(e) {
  const g = nextGate(e);
  return g !== null && e.hp <= g * e.max * (1 + 1e-9) ? g : null;
}

export function openGate(e) {
  if (nextGate(e) !== null) e.gatesOpen = (e.gatesOpen || 0) + 1;
}

// HP that damage cannot pass (combat pipeline step 8): the next unopened gate or the Warden's
// shade floor, whichever is higher. A keeper rising from its anti-stall burrow (untargetable)
// takes nothing at all.
export function gateFloor(e) {
  if (!e) return 0;
  if (e.untargetable) return Math.max(0, e.hp);
  const g = nextGate(e);
  return Math.max(g === null ? 0 : g * e.max, e.shadeFloor || 0);
}

// ---- placement ------------------------------------------------------------------------------

// The point `dist` metres from `from` toward `to` (straight along +Z when they coincide).
export function toward(from, to, dist, out = { x: 0, z: 0 }) {
  const dx = to.x - from.x,
    dz = to.z - from.z,
    l = Math.hypot(dx, dz);
  out.x = from.x + (l > 1e-6 ? dx / l : 0) * dist;
  out.z = from.z + (l > 1e-6 ? dz / l : 1) * dist;
  return out;
}

// ---- the Bellwether (F2) --------------------------------------------------------------------

export const TOLL_HALF = 0.6; // band half-width (m)
export const PLAYER_REACH = 0.45; // the player's radius, added to every hit test
const KNELL = Object.freeze([1, 2, 3]);
const KNELL_DEATH = Object.freeze([1, 2, 3, 4.6]);

// A toll band of radius r touches a player at distance d from its origin.
export const bandHit = (d, r, half = TOLL_HALF) => Math.abs(d - r) < half + PLAYER_REACH;

// Seconds after the knell begins at which each wave leaves the bell. With the sequential 1.8 s
// dash recharge a player holding 2 charges who dashes through every band always has one ready.
export const knellTimes = (death = false) => (death ? KNELL_DEATH : KNELL);

// The player is sheltered from a toll when the sight line from the wave's origin hit terrain or
// a structure within `reach` metres of them (arches, trunks and ridges all count).
export const sheltered = (hit, player, reach = 6) => !!hit && Math.hypot(hit.x - player.x, hit.z - player.z) <= reach;

// The flock's pincer: `back` metres beyond the player on the far side from the keeper, spread
// along the perpendicular by `offsets`.
export function herdPoints(keeper, player, back, offsets) {
  const dx = keeper.x - player.x,
    dz = keeper.z - player.z,
    l = Math.hypot(dx, dz),
    ux = l > 1e-6 ? dx / l : 0,
    uz = l > 1e-6 ? dz / l : 1;
  return offsets.map((o) => ({ x: player.x - ux * back + uz * o, z: player.z - uz * back - ux * o }));
}

// A crook sweep of `radius` and `half` angle (rad) around `yaw` catches the player.
export function inSweep(x, z, yaw, player, radius, half) {
  const dx = player.x - x,
    dz = player.z - z,
    d = Math.hypot(dx, dz);
  if (d >= radius + PLAYER_REACH) return false;
  return d < 1e-6 || Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) <= half;
}

// ---- Iron Maw (F3) --------------------------------------------------------------------------

const CHARGE_BLOCKED = 0.5; // a charge step that covers less than this share was stopped
const WALL_PROBE = 1.5;
const WALL_RISE = 1.5;

// Quarry walls count as cover: the terrain `probe` metres ahead along (ax, az) stands at least
// `rise` metres above the charger's feet.
export function wallAhead(height, x, z, ax, az, probe = WALL_PROBE, rise = WALL_RISE) {
  return height(x + ax * probe, z + az * probe) - height(x, z) >= rise;
}

// One charge step of `distance` along (ax, az) for `body` (the charger or its prediction probe).
// world: { coverAhead(at, dx, dz, radius), canMove(x, z, nx, nz, r), move(body, dx, dz, r),
// height(x, z) }. Returns "cover" when it slams into solid cover, "wall" (only with `walls`)
// when terrain rejects the step against a quarry wall, else null after moving. Without walls
// this is the Wave-1 rule exactly: terrain never counts.
export function chargeStep(body, ax, az, distance, radius, world, walls = false) {
  if (world.coverAhead(body, ax * distance, az * distance, radius)) return "cover";
  if (walls && !world.canMove(body.x, body.z, body.x + ax * distance, body.z + az * distance, radius) && wallAhead(world.height, body.x, body.z, ax, az))
    return "wall";
  const x0 = body.x,
    z0 = body.z;
  world.move(body, ax * distance, az * distance, radius);
  if (Math.hypot(body.x - x0, body.z - z0) >= distance * CHARGE_BLOCKED) return null;
  // Stopped short: the body's collision radius holds it farther from a cover's footprint than
  // the cover probe reaches (a statue by 0.7 m), so look one body radius further before
  // calling it a miss. Without this most head-on charges into cover never staggered.
  const reach = distance + radius;
  return world.coverAhead(body, ax * reach, az * reach, radius) ? "cover" : null;
}

// The telegraphed lane: the same 60 Hz steps as the real charge, so it bends and ends exactly
// where the charge will. Returns { points: [{x, z}], impact: "cover" | "wall" | null }.
export function simulateCharge(x, z, ax, az, speed, duration, radius, world, walls = false) {
  const probe = { x, z },
    points = [{ x, z }],
    steps = Math.ceil(duration * 60);
  let impact = null;
  for (let i = 0; i < steps && !impact; i++) {
    const x0 = probe.x,
      z0 = probe.z;
    impact = chargeStep(probe, ax, az, speed * Math.min(1 / 60, duration - i / 60), radius, world, walls);
    if (probe.x !== x0 || probe.z !== z0) points.push({ x: probe.x, z: probe.z });
  }
  return { points, impact };
}

// Rockfall around an impact: `count` points at a random bearing and rand(min, max) metres, drawn
// in that order per point.
export function rockfallPoints(x, z, rng, count = 4, min = 3, max = 7) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU,
      r = min + rng() * (max - min);
    points.push({ x: x + Math.sin(a) * r, z: z + Math.cos(a) * r });
  }
  return points;
}

// After a charge that found nothing: raging (or Death Mode) Iron Maw re-aims once for a second
// charge; otherwise, or after the second, it recovers. An impact always staggers instead.
export const mawAfterSkid = ({ rage = false, death = false, second = false } = {}) => ((rage || death) && !second ? "reaim" : "recover");

// ---- the Cinder Abbot (F4) ------------------------------------------------------------------

export const FISSURE = Object.freeze({ count: 9, spacing: 2, start: 2, step: 0.1, spread: (25 * Math.PI) / 180 });

// The fissure's lines: the yaw locked at windup start, flanked at ±25° in phase 2 and Death Mode.
export const fissureYaws = (yaw, three = false) => (three ? [yaw, yaw - FISSURE.spread, yaw + FISSURE.spread] : [yaw]);

// One fissure line from (x, z) along `yaw`: blast i lies start + i × spacing metres out and lands
// i × step seconds after the windup (every line keeps the same timing).
export function fissureBlasts(x, z, yaw, { count, spacing, start, step } = FISSURE) {
  const ax = Math.sin(yaw),
    az = Math.cos(yaw);
  return Array.from({ length: count }, (_, i) => ({ x: x + ax * (start + i * spacing), z: z + az * (start + i * spacing), t: i * step }));
}

// CENSER RELIGHT: every live zone of `owner` back to its full life at `grow` × its radius.
// Returns [zone, base radius] pairs for restoreZones when the pulse ends.
export function relightZones(zones, owner, grow) {
  const lit = [];
  for (const zone of zones ?? []) {
    if (zone.dead || zone.owner !== owner) continue;
    lit.push([zone, zone.radius]);
    zone.life = zone.max;
    zone.radius *= grow;
  }
  return lit;
}

export function restoreZones(lit) {
  for (const [zone, radius] of lit) zone.radius = radius;
}

// ---- the Castellan (F5) ---------------------------------------------------------------------

// The vigil dome: every bearing is its front, bullets are blocked (and reflected), the rest x0.
export const VIGIL = Object.freeze({ front: 181, frontMult: 0, block: true });
export const GRID = Object.freeze({ cell: 3.2, fuses: Object.freeze([1.4, 2, 2.6]) });
export const REFLECT = Object.freeze({ gap: 0.08, cap: 10, rageCap: 14, share: 0.3, min: 4, max: 14 });

// AURORA GRID strikes on the 3 × 3 world-aligned lattice of `cell`-metre squares centred on
// (cx, cz), in fuse order: wave A (i + j even: the corners and the centre) at 1.4 s, wave B
// (the four edge cells) at 2.0 s and, with three waves, A again at 2.6 s. One wave is A only.
export function gridStrikes(cx, cz, waves = 2, { cell, fuses } = GRID) {
  const strikes = [];
  for (let w = 0; w < waves; w++)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) if (((i + j) & 1) === w % 2) strikes.push({ x: cx + cell * i, z: cz + cell * j, fuse: fuses[w], wave: "ABC"[w] });
  return strikes;
}

// A reflected round deals 30% of the blocked bullet's damage, 4 to 14.
export const reflectDamage = (damage) => clamp(Math.round(REFLECT.share * damage), REFLECT.min, REFLECT.max);

// The reflection limiter on a vigil record { reflections, lastReflect }: at most `cap` per
// vigil and `gap` seconds apart. True (the slot spent) when the bullet blocked at `now` returns.
export function reflectSlot(vigil, now, cap, gap = REFLECT.gap) {
  if (vigil.reflections >= cap || now - vigil.lastReflect < gap) return false;
  vigil.reflections++;
  vigil.lastReflect = now;
  return true;
}

// GARRISON sniper posts among nodes [{ x, z, h }]: the highest `min`–`max` m from the player,
// at least `gap` m apart; short of `count`, the other nodes in range fill in, highest first.
export function garrisonPosts(nodes, px, pz, { count = 2, min = 14, max = 22, gap = 6 } = {}) {
  const within = (n) => {
    const d = Math.hypot(n.x - px, n.z - pz);
    return d >= min && d <= max;
  };
  const inRange = nodes.filter(within).sort((a, b) => b.h - a.h);
  const posts = [];
  for (const n of inRange) if (posts.length < count && posts.every((q) => Math.hypot(q.x - n.x, q.z - n.z) >= gap)) posts.push(n);
  for (const n of inRange) if (posts.length < count && !posts.includes(n)) posts.push(n);
  return posts;
}

// ---- the Rift Warden (F6) ------------------------------------------------------------------

// Phases 1 and 2: ring, blast, ring, CROWN SHARDS, repeating.
export const WARDEN_ROTATION = Object.freeze(["ring", "blast", "ring", "shards"]);
export const wardenStrike = (index) => WARDEN_ROTATION[((index % 4) + 4) % 4];

// Crown shards spiral out from the player: point i at bearing a0 + 1.05 i and radius 0, 1.6,
// 2.6, ... (0.6 + i), each with its own fuse 1.0 + 0.12 i.
export function shardPoints(px, pz, a0, count) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = a0 + i * 1.05,
      r = i === 0 ? 0 : 0.6 + i;
    points.push({ x: px + Math.sin(t) * r, z: pz + Math.cos(t) * r, fuse: 1 + 0.12 * i });
  }
  return points;
}

// The Warden's blast trio: the target point and one each side, across the aim (ax, az).
export function blastPoints(tx, tz, ax, az, spacing) {
  return [-1, 0, 1].map((side) => ({ x: tx + az * side * spacing, z: tz - ax * side * spacing }));
}

// The keepers the Warden raises as shades: every broken keeper, in KEEPER_ORDER.
export const shadeList = (broken = []) => KEEPER_ORDER.filter((id) => broken.includes(id));

// Until all n shades have resolved the Warden cannot drop below this (r resolved so far); after
// the last one it can die. No shades, no floor.
export function shadeFloor(max, resolved, n) {
  if (!(n > 0) || resolved >= n) return 0;
  return Math.max(1, max * 0.25 * (1 - (resolved + 1) / n));
}

// The four camera-relative bearings shades rise from, cycling with the shade index k:
// camera-left, camera-right, away from the camera, toward it. The camera sits at
// (sin yaw, cos yaw) from its target, so "toward" is that vector.
export function shadeBearing(k, camYaw, out = { x: 0, z: 0 }) {
  const s = Math.sin(camYaw),
    c = Math.cos(camYaw);
  switch (((k % 4) + 4) % 4) {
    case 0:
      out.x = -c;
      out.z = s;
      break;
    case 1:
      out.x = c;
      out.z = -s;
      break;
    case 2:
      out.x = -s;
      out.z = -c;
      break;
    default:
      out.x = s;
      out.z = c;
  }
  return out;
}

// The Warden lands on the dais centre, or `gap` metres from it opposite a player standing
// closer than that.
export function daisLanding(center, player, gap = 4, out = { x: 0, z: 0 }) {
  const dx = center.x - player.x,
    dz = center.z - player.z,
    d = Math.hypot(dx, dz);
  if (d >= gap) {
    out.x = center.x;
    out.z = center.z;
    return out;
  }
  out.x = center.x + (d > 1e-6 ? dx / d : 0) * gap;
  out.z = center.z + (d > 1e-6 ? dz / d : 1) * gap;
  return out;
}

// Crown spike i of `count` orbiting (cx, cz) at `radius`, the ring turned to `angle`.
export function crownPoint(angle, i, count, radius, cx, cz, out = { x: 0, z: 0 }) {
  const a = angle + (i * TAU) / count;
  out.x = cx + Math.sin(a) * radius;
  out.z = cz + Math.cos(a) * radius;
  return out;
}
