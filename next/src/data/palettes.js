// Readable Threats (IMPROVEMENTS F1.5, F17): the threat classes, which telegraph and enemy kinds
// belong to each, the four telegraph palettes, the class patterns, the telegraph width floor,
// the sound captions, threat-eye colours, and the per-stage swatches the colour tests and the
// model palette lint check against. Pure data and pure functions: render/telegraphs.js and
// ui/hud.js re-export what they use, and the tests import it without THREE.
import { AFFIXES } from "./affixes.js";

export const THREAT_CLASSES = Object.freeze(["charge", "aim", "artillery", "ground", "salvo", "boss", "melee"]);
// The six classes a telegraph can have (melee colours only eyes and radar dots).
export const TELEGRAPH_CLASSES = Object.freeze(THREAT_CLASSES.filter((cls) => cls !== "melee"));

const classOf = (rows) => Object.freeze(Object.fromEntries(Object.entries(rows).flatMap(([cls, kinds]) => kinds.map((kind) => [kind, cls]))));

// Telegraph kind -> class.
export const KIND_CLASS = classOf({
  charge: ["charge"],
  aim: ["aim"],
  artillery: ["artillery", "hex", "lance", "tear", "rockfall", "shard"],
  ground: ["ground", "vent", "arc", "fissure", "burrow", "gas", "molten", "beacon"],
  salvo: ["ring"],
  boss: ["boss", "node", "wave", "aegis"],
});

// Enemy kind -> class (threat eyes and radar blips). Every keeper and the Warden are "boss".
export const ENEMY_CLASS = classOf({
  melee: ["runner", "skitter", "revenant", "drowned"],
  salvo: ["gunner", "stormer", "lamplighter"],
  aim: ["sniper"],
  artillery: ["mortar", "hexer"],
  charge: ["charger", "leaper"],
  ground: ["brute", "splitter", "broodmother", "ashworm"],
  boss: ["bellwether", "ironmaw", "abbot", "castellan", "warden"],
});

// Class colours per palette (prefs.palette). `contrast` draws every class white over a black
// under-strip and tells them apart by pattern only.
const everyClass = (color) => Object.freeze(Object.fromEntries(THREAT_CLASSES.map((cls) => [cls, color])));
export const PALETTES = Object.freeze({
  rift: Object.freeze({ charge: "#ff6d63", aim: "#ff4eae", artillery: "#f0b25c", ground: "#e2ba86", salvo: "#c2bbdb", boss: "#c7a4f0", melee: "#d8cfb0" }),
  deutan: Object.freeze({ charge: "#fb5005", aim: "#ddfdde", artillery: "#b166ff", ground: "#ffff09", salvo: "#fdc5ff", boss: "#c7738a", melee: "#d8cfb0" }),
  tritan: Object.freeze({ charge: "#fb4771", aim: "#f0f9e9", artillery: "#6bbef2", ground: "#ab6df5", salvo: "#819533", boss: "#fdd128", melee: "#d8cfb0" }),
  contrast: everyClass("#ffffff"),
});
export const PALETTE_IDS = Object.freeze(Object.keys(PALETTES));

// Under the rift palette every telegraph kind keeps its own colour: the Wave-1 kinds their
// Wave-1 colours (ORIGINAL looks like the original), the Wave-2 kinds their F1.5 colours.
export const KIND_COLORS = Object.freeze({
  charge: "#ff6d63",
  aim: "#ff4eae",
  artillery: "#f0b25c",
  ground: "#e2ba86",
  ring: "#c2bbdb",
  hex: "#e05ad0",
  boss: "#c7a4f0",
  vent: "#ff8c4a",
  node: "#a47cff",
  arc: "#e2865a",
  wave: "#ffd9b0",
  fissure: "#e2ba86",
  lance: "#f0b25c",
  aegis: "#83e7ff",
  burrow: "#e2ba86",
  tear: "#f0e6ff",
  gas: "#d8e86e",
  rockfall: "#f0b25c",
  shard: "#f0e6ff",
  molten: "#e2ba86",
  beacon: "#aef4ff",
});
export const WAVE2_KINDS = Object.freeze(["arc", "wave", "fissure", "lance", "aegis", "burrow", "tear", "gas", "rockfall", "shard", "molten", "beacon"]);

// Where each Wave-2 *damage* kind is drawn (aegis warns and beacon marks an interactable, so
// neither is a damage kind). The rift-palette world test checks each against these stages.
export const KIND_STAGES = Object.freeze({
  arc: Object.freeze([1, 4]), // Bellwether sweep, Castellan bash
  wave: Object.freeze([1, 5]), // Bellwether toll, its shade
  fissure: Object.freeze([3, 5]), // Abbot fissure, its shade
  lance: Object.freeze([4, 5]), // Castellan grid, its shade
  burrow: Object.freeze([3, 5]), // Ashworm breach (Caldera, Void)
  tear: Object.freeze([4, 5]), // reserved: the Wave-3 Unreturned (Void; Citadel in Death Mode)
  gas: Object.freeze([1, 2]), // Drowned swell, marsh gas
  rockfall: Object.freeze([2, 5]), // Maw rockfall, falling crystal
  shard: Object.freeze([2, 3, 4, 5]), // Shardborn elites, Warden crown shards
  molten: Object.freeze([2, 3, 4, 5]), // Molten elites
});

// Dark under-strips: the high-contrast palette's black edge, and the shard/tear under-strip
// that keeps their pale strips readable on the pale Void gems.
export const UNDER_COLORS = Object.freeze({ contrast: "#000000", deep: "#1a1420" });
export const UNDER_KINDS = Object.freeze(["shard", "tear"]);
export const UNDER_WIDEN = 0.08; // an under-strip is this much wider (full width) than its strip
export const TRIAL_MARK = "#dfb276";

export const validPalette = (name) => (Object.hasOwn(PALETTES, name) ? name : "rift");
export const classOfKind = (kind) => KIND_CLASS[kind] ?? "ground";

// The colour a telegraph of `kind` draws in under `palette` (meta.cls overrides the class).
export function kindColor(kind, palette = "rift", cls = null) {
  const name = validPalette(palette);
  if (name === "rift") return KIND_COLORS[kind] ?? PALETTES.rift[cls ?? classOfKind(kind)];
  return PALETTES[name][cls ?? classOfKind(kind)];
}

// Class patterns are optional under rift and always on under the accessible palettes.
export const patternsOn = (palette, pref) => validPalette(palette) !== "rift" || !!pref;

// prefs.threatEyes: "auto" is off under rift (the authored lit eyes) and on elsewhere.
export function threatEyesOn(palette, setting = "auto") {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return validPalette(palette) !== "rift";
}

// The live look, so spawners can ask eyeColor(kind, e) without holding the prefs. The
// telegraph system keeps it in step with prefs.palette and prefs.threatEyes.
const activeLook = { palette: "rift", threatEyes: "auto" };
export function setLook({ palette, threatEyes } = {}) {
  activeLook.palette = validPalette(palette);
  activeLook.threatEyes = threatEyes === "on" || threatEyes === "off" ? threatEyes : "auto";
  return activeLook;
}

// Threat-eye colour for a monster, or null for its authored lit eyes: elites glow in their
// first affix colour, trial-marked monsters in the trial gold, everything else in its class
// colour; keepers and bosses always keep their authored eyes.
export function eyeColor(kind, e = null, look = activeLook) {
  if (!threatEyesOn(look.palette, look.threatEyes)) return null;
  const cls = ENEMY_CLASS[kind];
  if (!cls || cls === "boss" || e?.keeper || e?.boss) return null;
  const affix = Array.isArray(e?.elite) ? AFFIXES[e.elite[0]] : null;
  if (affix) return affix.color;
  if (e?.trialId) return TRIAL_MARK;
  return PALETTES[validPalette(look.palette)][cls];
}

// ---- width floor (F1.5) -------------------------------------------------------------------------

// Internal pixels per ground metre along the depth axis for the fixed rig: 47 degree fov, a
// 40.4 degree pitch, and the camera sqrt(1 + 0.85^2) = 1.312 distances from its target.
const PITCH = (40.4 * Math.PI) / 180;
const HALF_FOV = (23.5 * Math.PI) / 180;
const RIG = 1.312;
export const pxPerMetre = (resH, dist) => (resH * Math.sin(PITCH)) / (2 * RIG * Math.max(1e-3, dist) * Math.tan(HALF_FOV));
// Full width (m) of damage outlines and fills, and of reach and guide strips: 2 internal pixels.
export const stripFloor = (resH, dist) => Math.min(0.6, Math.max(0.3, 2 / pxPerMetre(resH, dist)));
export const guideFloor = (resH, dist) => Math.min(0.6, Math.max(0.4, 2 / pxPerMetre(resH, dist)));

// ---- class patterns (F17) ---------------------------------------------------------------------

// Pure generators returning strip lists [ax, az, bx, bz, half] in the marker's local x/z
// (0 yaw faces +z). Circle patterns decorate the inside of an area's outer ring, clipped to a
// sector of half-angle `sector` (PI = the whole circle); lane and line patterns follow a path of
// local points [x0, z0, x1, z1, ...].
const TAU = Math.PI * 2;
const CHEVRON_EVERY = 1.5;
const DASH_ON = 0.5;
const DASH_OFF = 0.5;

const inSector = (angle, sector) => sector >= Math.PI || Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) <= sector + 1e-9;

function ring(out, r, half, sector, segments = 48) {
  for (let i = 0; i < segments; i++) {
    const a = (i * TAU) / segments,
      b = ((i + 1) * TAU) / segments;
    if (!inSector(a, sector) || !inSector(b, sector)) continue;
    out.push([Math.sin(a) * r, Math.cos(a) * r, Math.sin(b) * r, Math.cos(b) * r, half]);
  }
}

function spokes(out, r, half, count, sector, from, to, turn = 0) {
  for (let i = 0; i < count; i++) {
    const a = turn + (i * TAU) / count;
    if (!inSector(a, sector)) continue;
    const s = Math.sin(a),
      c = Math.cos(a);
    out.push([s * r * from, c * r * from, s * r * to, c * r * to, half]);
  }
}

// Station points every `step` metres along a local polyline: [{ x, z, dx, dz, at }].
function stations(pts, step, offset = step) {
  const out = [];
  let travelled = 0,
    next = offset;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2],
      az = pts[i - 1],
      dx = pts[i] - ax,
      dz = pts[i + 1] - az,
      d = Math.hypot(dx, dz);
    if (d < 1e-6) continue;
    while (next <= travelled + d + 1e-9) {
      const t = (next - travelled) / d;
      out.push({ x: ax + dx * t, z: az + dz * t, dx: dx / d, dz: dz / d, at: next });
      next += step;
    }
    travelled += d;
  }
  return out;
}

// The stretch [from, to] metres of a polyline as strips.
function stretch(out, pts, from, to, half) {
  let travelled = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2],
      az = pts[i - 1],
      dx = pts[i] - ax,
      dz = pts[i + 1] - az,
      d = Math.hypot(dx, dz);
    const a = Math.max(from, travelled),
      b = Math.min(to, travelled + d);
    if (d > 1e-6 && b > a + 1e-6) {
      const t0 = (a - travelled) / d,
        t1 = (b - travelled) / d;
      out.push([ax + dx * t0, az + dz * t0, ax + dx * t1, az + dz * t1, half]);
    }
    travelled += d;
  }
}

export function pathLength(pts) {
  let total = 0;
  for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return total;
}

export const PATTERNS = Object.freeze({
  // Chevrons every 1.5 m pointing along travel (instead of every 8th segment).
  charge: Object.freeze({
    shape: "lane",
    strips({ pts, width }, half) {
      const out = [];
      for (const p of stations(pts, CHEVRON_EVERY)) {
        const nx = -p.dz * width * 0.55,
          nz = p.dx * width * 0.55,
          bx = p.x - p.dx * width * 0.6,
          bz = p.z - p.dz * width * 0.6;
        out.push([bx + nx, bz + nz, p.x, p.z, half], [bx - nx, bz - nz, p.x, p.z, half]);
      }
      return out;
    },
  }),
  // Dashed: 0.5 m on, 0.5 m off.
  aim: Object.freeze({
    shape: "line",
    strips({ pts }, half) {
      const out = [],
        total = pathLength(pts);
      for (let at = 0; at < total - 1e-6; at += DASH_ON + DASH_OFF) stretch(out, pts, at, Math.min(total, at + DASH_ON), half);
      return out;
    },
  }),
  // Four spokes and a centre cross.
  artillery: Object.freeze({
    shape: "circle",
    strips({ radius, sector = Math.PI }, half) {
      const out = [];
      spokes(out, radius, half, 4, sector, 0.3, 0.83);
      const c = Math.min(radius * 0.16, 0.6);
      if (inSector(0, sector)) out.push([0, -c, 0, c, half]);
      out.push([-c, 0, c, 0, half]);
      return out;
    },
  }),
  // A double ring and twelve radial ticks.
  ground: Object.freeze({
    shape: "circle",
    strips({ radius, sector = Math.PI }, half) {
      const out = [];
      ring(out, radius * 0.8, half, sector);
      spokes(out, radius, half, 12, sector, 0.5, 0.66, Math.PI / 12);
      return out;
    },
  }),
  // Eight spokes.
  salvo: Object.freeze({
    shape: "circle",
    strips({ radius, sector = Math.PI }, half) {
      const out = [];
      spokes(out, radius, half, 8, sector, 0.25, 0.83);
      return out;
    },
  }),
  // A triple ring.
  boss: Object.freeze({
    shape: "circle",
    strips({ radius, sector = Math.PI }, half) {
      const out = [];
      ring(out, radius * 0.78, half, sector);
      ring(out, radius * 0.56, half, sector, 32);
      return out;
    },
  }),
});

// ---- sound captions (F17) ---------------------------------------------------------------------

// name -> { text, bySrc: { src: text }, cls (null: no class colour), offscreen (captioned only
// when its source is off screen), once (once per low-HP entry) }.
const caption = (text, cls, bySrc = {}, flags = {}) =>
  Object.freeze({ text, cls, bySrc: Object.freeze(bySrc), offscreen: !!flags.offscreen, once: !!flags.once });

export const CAPTIONS = Object.freeze({
  warnCharge: caption("CHARGE", "charge", { ironmaw: "IRON MAW CHARGING" }),
  warnAim: caption("SNIPER AIMING", "aim", { warden: "WARDEN AIMING" }),
  warnGround: caption("GROUND SLAM", "ground", { leaper: "LEAP", vent: "VENT ERUPTING", ashworm: "BREACH" }),
  warnRing: caption("SALVO", "salvo", { warden: "WARDEN RING", bellwether: "TOLL RISING" }),
  mortar: caption("MORTAR LAUNCH", "artillery"),
  toll: caption("THE BELL TOLLS", "boss"),
  vigilHum: caption("VIGIL", "boss"),
  garrisonBell: caption("THE GARRISON ANSWERS", "boss"),
  rumble: caption("GROUND RUMBLES", "ground"),
  gurgle: caption("DROWNED SWELLING", "ground"),
  wardChime: caption("WARD RITUAL", "salvo"),
  eliteSpawn: caption("RIFT-TOUCHED", "boss"),
  fuse: caption("FUSE HISSING", "artillery"),
  beaconFlare: caption("BEACON FLARE", "ground"),
  voiceBrute: caption("BRUTE ROARS", "ground"),
  voiceStorm: caption("STORMER HUMS", "salvo"),
  voiceHex: caption("HEXER CHANTS", "artillery"),
  voiceBrood: caption("BROOD SHRIEK", "ground"),
  explosion: caption("EXPLOSION", "ground", {}, { offscreen: true }),
  thunder: caption("THUNDER", null),
  stingerPortal: caption("RIFT HUMS", null),
  heartbeat: caption("HEARTBEAT", null, {}, { once: true }),
  bossIntro: caption("THE RIFT STIRS", "boss"),
  shield: caption("WARD ABSORBS", null),
});

// The caption row for a sound, its text chosen by the emitter kind, or null (not captioned).
export function captionFor(name, src = null) {
  const row = Object.hasOwn(CAPTIONS, name) ? CAPTIONS[name] : null;
  if (!row) return null;
  const text = src != null && Object.hasOwn(row.bySrc, src) ? row.bySrc[src] : row.text;
  return { text, cls: row.cls, offscreen: row.offscreen, once: row.once };
}

// ---- stage swatches ---------------------------------------------------------------------------

// Per stage: ground low and high, look-alikes (telegraph test) and prop colours (model lint).
const swatch = (ground, lookAlikes, props) => Object.freeze({ ground: Object.freeze(ground), lookAlikes: Object.freeze(lookAlikes), props: Object.freeze(props) });
export const STAGE_SWATCHES = Object.freeze({
  1: swatch(["#497c57", "#75915f"], ["#bac1a0"], ["#a5aba0", "#529076", "#327464", "#66503d"]),
  2: swatch(["#424c66", "#687992"], ["#b3b0a1"], ["#546078", "#8e9baf", "#c7a66d", "#354556"]),
  3: swatch(["#372d40", "#6d3948"], ["#b77561", "#ff7744", "#2a1e22"], ["#8f4039", "#443748", "#f19a58"]),
  4: swatch(["#273958", "#546d91"], ["#a5bcd1", "#83e7ff"], ["#405978", "#b4cddd", "#6e91b0"]),
  5: swatch(["#241e48", "#503b76"], ["#9e83b6", "#ba80ef", "#54437a"], ["#35294e"]),
});
