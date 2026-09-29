// Seeded randomness. Gameplay draws from the run's stream so a seed (e.g. the Daily
// Rift) reproduces layouts, spawns and offers. Cosmetic-only jitter may use Math.random.

// LCG matching the original layout generator: same seed -> same world.
export function randomSource(seed) {
  let s = seed >>> 0;
  return (a = 0, b = 1) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return a + ((b - a) * s) / 4294967296;
  };
}

// Higher-quality stream for run-level decisions. Returns a function in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 32-bit hash of a string (daily seeds, stable ids).
export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// Named run streams (IMPROVEMENTS F14.1): one independent generator per name, so a player's
// fire pattern or card picks never shift spawns, elites or relic offers. Streams are created
// on first use and live for the run. Under the ORIGINAL ruleset the director maps every name
// to the single Wave-1 generator instead.
export const STREAM_NAMES = Object.freeze(["spawn", "ai", "combat", "cards", "relics", "drops", "omens", "elites"]);

export function createStreams(seed) {
  const cache = new Map();
  return (name) => {
    let s = cache.get(name);
    if (!s) cache.set(name, (s = mulberry32((seed ^ hashString(name)) >>> 0)));
    return s;
  };
}

// World placement seeds: statues (offset 0, the Wave-1 seed), hazard props, the Crown Dais and
// the shrine bell use randomSource(stageSeed + offset), never a run stream.
export const stageSeed = (seed, stage) => (seed + stage * 107) >>> 0;
export const PLACEMENT_OFFSETS = Object.freeze({ statues: 0, hazards: 4409, dais: 5501, shrineBell: 6311 });

// "RIFT-MMDD-XXXX": the UTC month and day of `date`, then the seed's low 16 bits in hex.
export function seedCode(seed, date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  const hex = ((seed >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `RIFT-${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${hex}`;
}

// Helpers bound to any [0,1) generator.
export function rangeOf(rng) {
  return (a = 0, b = 1) => a + rng() * (b - a);
}
export function pick(rng, list) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}
export function shuffled(items, rng = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function weightedPick(rng, entries) {
  // entries: [[value, weight], ...]
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  let roll = rng() * total;
  for (const [v, w] of entries) {
    roll -= Math.max(0, w);
    if (roll < 0) return v;
  }
  return entries.at(-1)?.[0];
}
