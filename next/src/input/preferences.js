// Player preferences: the settings schema, defaults, persistence, key bindings and their
// display labels. Loading repairs the saved object field by field, so one bad value (a corrupt
// binding, an out-of-range slider) falls back on its own instead of resetting everything.
import { KEYS, loadJSON, saveJSON } from "../core/storage.js";
import { clamp } from "../core/util.js";

// The original game's key. Read once to carry settings over; never written.
const LEGACY_KEY = "neon-crypt-preferences-v1";

// Action -> KeyboardEvent.code (or "Mouse<button>"). This order is the Controls list order.
export const DEFAULT_BINDINGS = Object.freeze({
  forward: "KeyW",
  back: "KeyS",
  left: "KeyA",
  right: "KeyD",
  fire: "Mouse0",
  dash: "Space",
  interact: "KeyF",
  orbitLeft: "KeyQ",
  orbitRight: "KeyE",
  orbitDrag: "Mouse2",
  pause: "KeyP",
  weapon1: "Digit1",
  weapon2: "Digit2",
  weapon3: "Digit3",
  weapon4: "Digit4",
  weapon5: "Digit5",
});

export const ACTION_LABELS = Object.freeze({
  forward: "Move forward",
  back: "Move backward",
  left: "Move left",
  right: "Move right",
  fire: "Fire",
  dash: "Phase dash",
  interact: "Interact",
  orbitLeft: "Orbit left",
  orbitRight: "Orbit right",
  orbitDrag: "Drag camera",
  pause: "Pause / resume",
  weapon1: "Assault rifle",
  weapon2: "Stinger SMG",
  weapon3: "Scatter shotgun",
  weapon4: "Lancer railgun",
  weapon5: "Havoc launcher",
});

// Browser/OS keys that must keep working, so they can never be bound.
export const RESERVED_CODES = Object.freeze(["Escape", "MetaLeft", "MetaRight", "F5", "F11", "F12"]);
const RESERVED = new Set(RESERVED_CODES);
// Any KeyboardEvent.code, or one of the three main mouse buttons. Mouse3/4 are the
// browser's back/forward buttons and would navigate away mid-run.
const CODE_PATTERN = /^(?:Mouse[0-2]|(?!Mouse)[A-Za-z][A-Za-z0-9]*)$/;

// The single rule shared by capture and load: a code accepted at capture is never
// rejected on the next load (the original validated only on load and silently reset).
export function isBindable(code) {
  return typeof code === "string" && CODE_PATTERN.test(code) && !RESERVED.has(code);
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Codes tried, in order, for an action whose saved binding is missing or unusable and
// whose default is taken. KeyF first matches the original's Interact migration.
const FALLBACK_CODES = [
  "KeyF",
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (k) => "Key" + k),
  ...Array.from("0123456789", (d) => "Digit" + d),
];

function readBindings(saved) {
  const source = isRecord(saved) ? saved : {};
  const actions = Object.keys(DEFAULT_BINDINGS);
  const chosen = {};
  const taken = new Set();
  // Every valid saved code is claimed first (the earlier action wins a duplicate), so a
  // fallback below can never steal a key the player deliberately bound elsewhere.
  for (const action of actions) {
    const code = source[action];
    if (isBindable(code) && !taken.has(code)) {
      chosen[action] = code;
      taken.add(code);
    }
  }
  for (const action of actions) {
    if (chosen[action]) continue;
    const code = [DEFAULT_BINDINGS[action], ...FALLBACK_CODES].find((c) => !taken.has(c));
    chosen[action] = code;
    taken.add(code);
  }
  return Object.fromEntries(actions.map((action) => [action, chosen[action]]));
}

// ---- settings schema (IMPROVEMENTS F18.1, §3.14) -------------------------------------------
//
// Row: { key, tab: "graphics" | "audio" | "controls" | "access" | null (not in Settings), group,
// type: "bool" | "select" | "range" | "custom", render (custom only), options: [[value, label]],
// min, max, step, default, label, hint, migrate(savedPrefs) -> value }, plus these extras:
//   touch    the default on touch devices, when it differs (autoFire)
//   invert   a bool shown inverted ("Reduce flashes" edits `flashes`)
//   off      a range whose 0 reads "OFF"
//   lock(prefs) -> { value, hint } | null: the row is forced to `value` and disabled
//   read(saved) -> value: the loader of a custom row that holds a value (key bindings)
// Every value row is validated on load and a bad value falls back to its own default.
// `custom` rows place the hand-written controls (bindings capture, TEST SOUND, the audio status
// line); the schema stays authoritative for their key, tab and default. menus.js renders the
// Settings tabs from this table, in row order, with a heading wherever the group changes.
export const SETTINGS_TABS = Object.freeze(["graphics", "audio", "controls", "access"]);

const row = (key, tab, group, type, fallback, label, extra = {}) =>
  Object.freeze({ key, tab, group, type, default: fallback, label, hint: "", ...extra });
const choices = (...pairs) => Object.freeze(pairs.map((pair) => Object.freeze(pair)));
const percent = (key, tab, group, fallback, label, extra = {}) => row(key, tab, group, "range", fallback, label, { min: 0, max: 100, step: 1, ...extra });
const fromBoolean = (key, yes, no) => (saved) => (typeof saved[key] === "boolean" ? (saved[key] ? yes : no) : saved[key]);
const PATTERNS_FORCED = Object.freeze({ value: true, hint: "Always on with this palette." });

export const PREF_SCHEMA = Object.freeze([
  // Run setup (F1.1): chosen on #runSetup, never in Settings.
  row("ruleset", null, null, "select", "keepers", "Ruleset", { options: choices(["keepers", "KEEPERS"], ["original", "ORIGINAL"]) }),

  // GRAPHICS
  row("nightmare", "graphics", "DISPLAY", "bool", false, "Nightmare", { hint: "Storms, dense fog and moonlit darkness." }),
  row("pixelation", "graphics", "DISPLAY", "select", "auto", "Pixelation", {
    options: choices(["auto", "Automatic"], [160, "Very chunky"], [240, "Chunky"], [320, "Classic"], [480, "Fine"], [720, "Ultra fine"]),
  }),
  row("lighting", "graphics", "DISPLAY", "select", "enhanced", "Lighting", {
    options: choices(["enhanced", "Enhanced"], ["classic", "Classic"]),
    hint: "Enhanced adds bounce light, dynamic flashes, glowing sparks and smoke. Classic is the original look.",
  }),
  percent("fog", "graphics", "DISPLAY", 50, "Fog", { step: 5, off: true }),
  percent("playerIndicatorsOpacity", "graphics", "DISPLAY", 100, "Player indicators opacity", {
    step: 5,
    hint: "Health above your head and dash icons below your feet.",
  }),
  row("fpsCap", "graphics", "DISPLAY", "select", 60, "Frame rate limit", {
    options: choices([30, "30 FPS"], [60, "60 FPS"], [120, "120 FPS"], [0, "Unlimited"]),
    hint: "Actual FPS depends on your device and display.",
  }),
  row("crt", "graphics", "DISPLAY", "select", "off", "CRT filter", {
    options: choices(["off", "Off"], ["subtle", "Subtle"], ["full", "Full"]),
    hint: "Phosphor mask, glowing scanlines and a curved glass screen, like an old television.",
    migrate: fromBoolean("crt", "full", "off"),
  }),
  row("radar", "graphics", "HUD", "select", "auto", "Radar", {
    options: choices(["auto", "Auto"], ["full", "Full"], ["threats", "Threats only"], ["off", "Off"]),
    hint: "Auto shows everything you have seen under KEEPERS, and only threats under ORIGINAL.",
    migrate: fromBoolean("radar", "auto", "off"),
  }),
  row("radarRange", "graphics", "HUD", "select", 30, "Radar range", {
    options: choices([24, "24 m"], [30, "30 m"], [40, "40 m"]),
    hint: "Fog and darkness shorten it.",
  }),
  row("portalCompass", "graphics", "HUD", "bool", true, "Portal compass"),

  // AUDIO
  row("muted", "audio", "VOLUME", "bool", false, "Mute all sound"),
  percent("master", "audio", "VOLUME", 100, "Master"),
  percent("music", "audio", "VOLUME", 70, "Music"),
  percent("effects", "audio", "VOLUME", 100, "Effects"),
  row("mono", "audio", "OUTPUT", "bool", false, "Mono audio", { hint: "Plays every sound centred for single-ear listening." }),
  row("testSound", "audio", "OUTPUT", "custom", null, "TEST SOUND", { render: "testSound" }),
  row("audioStatus", "audio", "OUTPUT", "custom", null, "Audio status", { render: "audioStatus" }),

  // CONTROLS
  row("aimAssist", "controls", "AIM AND FIRE", "select", "standard", "Aim assist", {
    options: choices(["standard", "Standard"], ["off", "Off"], ["low", "Low"], ["high", "High"]),
    hint: "Pad and touch only. High marks runs ASSISTED.",
    migrate: fromBoolean("aimAssist", "standard", "off"),
  }),
  row("autoFire", "controls", "AIM AND FIRE", "select", "off", "Auto-fire", {
    options: choices(["off", "Off"], ["aiming", "While aiming"], ["always", "Always"]),
    hint: "Always marks runs ASSISTED. Never fires into a vigil.",
    touch: "aiming",
  }),
  row("fireMode", "controls", "AIM AND FIRE", "select", "hold", "Fire mode", { options: choices(["hold", "Hold"], ["toggle", "Toggle"]) }),
  row("dashToward", "controls", "AIM AND FIRE", "select", "move", "Dash direction", { options: choices(["move", "Movement"], ["aim", "Aim"]) }),
  row("bossFraming", "controls", "CAMERA", "bool", true, "Boss framing", { hint: "Pulls the camera back to keep a keeper on screen." }),
  row("bindings", "controls", "KEYS", "custom", DEFAULT_BINDINGS, "Key bindings", { render: "bindings", read: readBindings }),

  // ACCESS
  row("palette", "access", "THREATS", "select", "rift", "Telegraph colours", {
    options: choices(["rift", "Rift (default)"], ["deutan", "Red-green safe"], ["tritan", "Blue-yellow safe"], ["contrast", "High contrast"]),
  }),
  row("telegraphPatterns", "access", "THREATS", "bool", false, "Telegraph patterns", {
    lock: (prefs) => (prefs.palette && prefs.palette !== "rift" ? PATTERNS_FORCED : null),
  }),
  row("threatEyes", "access", "THREATS", "select", "auto", "Threat eyes", { options: choices(["auto", "Auto"], ["on", "On"], ["off", "Off"]) }),
  row("threatArrows", "access", "THREATS", "bool", true, "Off-screen threat arrows"),
  row("hurtRing", "access", "THREATS", "bool", true, "Damage direction"),
  row("captions", "access", "HEARING", "select", "off", "Sound captions", {
    options: choices(["off", "Off"], ["captions", "Captions"], ["icons", "Direction icons"]),
  }),
  // Stored as `flashes` (true = full flashes), shown inverted as "Reduce flashes", as in Wave 1.
  row("flashes", "access", "COMFORT", "bool", true, "Reduce flashes", {
    invert: true,
    hint: "Softer muzzle, hit and lightning flashes; no blinking HUD.",
  }),
  percent("shake", "access", "COMFORT", 100, "Screen shake", { step: 5, off: true }),
  row("gameSpeed", "access", "ASSIST", "select", 100, "Game speed", {
    options: choices([100, "100%"], [90, "90%"], [80, "80%"], [70, "70%"], [60, "60%"]),
    hint: "Below 100% the run is marked ASSISTED and saved to its own board.",
  }),
  row("uiScale", "access", "ASSIST", "select", 100, "UI scale", { options: choices([100, "100%"], [115, "115%"], [130, "130%"]) }),
]);

const ROWS = new Map(PREF_SCHEMA.map((r) => [r.key, r]));
// Rows that hold a preference value (every custom row except the pure controls).
const VALUE_ROWS = PREF_SCHEMA.filter((r) => r.type !== "custom" || r.read);

// The schema row of a preference key, or null.
export const prefRow = (key) => ROWS.get(key) ?? null;

// The default of a row on this device: touch devices take the row's `touch` default.
export const defaultFor = (r, touch = false) => (touch && r.touch !== undefined ? r.touch : r.default);

// The value a row really runs with: a locked row reports its forced value (telegraph patterns
// are always on under the accessible palettes).
export function effectivePref(prefs, key) {
  const r = ROWS.get(key);
  return r?.lock?.(prefs ?? {})?.value ?? prefs?.[key];
}

// Whether `value` is valid for a value row (the same test the loader applies).
export function validPref(key, value) {
  const r = ROWS.get(key);
  if (!r || r.type === "custom") return false;
  if (r.type === "bool") return typeof value === "boolean";
  if (r.type === "range") return Number.isFinite(value) && value >= r.min && value <= r.max;
  return r.options.some(([option]) => option === value);
}

// The assists that mark a run ASSISTED (F18.5): game speed under 100%, auto-fire "always" and
// aim assist "high". Returns the pref keys that hold an assisted value.
export function assistedPrefs(prefs) {
  const kinds = [];
  if (Number(prefs?.gameSpeed) < 100) kinds.push("gameSpeed");
  if (prefs?.autoFire === "always") kinds.push("autoFire");
  if (prefs?.aimAssist === "high") kinds.push("aimAssist");
  return kinds;
}

// One schema row's value from a saved object: migrated, then validated against the row.
function readRow(r, saved, touch) {
  const value = r.migrate ? r.migrate(saved) : saved[r.key];
  if (r.read) return r.read(value);
  if (r.type === "range") return Number.isFinite(value) ? clamp(value, r.min, r.max) : r.default;
  return validPref(r.key, value) ? value : defaultFor(r, touch);
}

// Canonical field names are the original's. `mute` and `indicators` (the contract's
// shorthand) are non-enumerable aliases, so they work but are never saved twice.
const ALIASES = [
  ["mute", "muted"],
  ["indicators", "playerIndicatorsOpacity"],
];

function withAliases(prefs) {
  for (const [alias, field] of ALIASES)
    Object.defineProperty(prefs, alias, {
      get: () => prefs[field],
      set: (value) => {
        prefs[field] = value;
      },
      enumerable: false,
      configurable: true,
    });
  return prefs;
}

// Desktop defaults of every value row (touch devices differ only where a row says so).
export const DEFAULT_PREFS = Object.freeze(withAliases(Object.fromEntries(VALUE_ROWS.map((r) => [r.key, r.default]))));

// Settings a newer build (or another module) added keep their saved value even though
// this loader does not know them; only plain JSON scalars are carried over.
function unknownFields(saved) {
  const extra = {};
  for (const [key, value] of Object.entries(saved)) {
    if (key in DEFAULT_PREFS) continue;
    if (typeof value === "boolean" || typeof value === "string" || Number.isFinite(value)) extra[key] = value;
  }
  return extra;
}

// The same pointer test main.js uses for env.touch; the loader runs before env exists.
function touchDevice() {
  try {
    return !!globalThis.matchMedia?.("(pointer:coarse)")?.matches || (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

// A repaired preferences object from any saved value (a record, garbage or nothing).
export function readPreferences(saved, { touch = false } = {}) {
  const p = isRecord(saved) ? saved : {};
  return withAliases({ ...unknownFields(p), ...Object.fromEntries(VALUE_ROWS.map((r) => [r.key, readRow(r, p, touch)])) });
}

// Live preferences for this page. First launch of the rebuild carries the original
// game's settings over (same field names) and stores them under the new key at once,
// so the import happens exactly once.
export function loadPreferences() {
  const touch = touchDevice();
  const saved = loadJSON(KEYS.prefs, null);
  if (isRecord(saved)) return readPreferences(saved, { touch });
  const legacy = loadJSON(LEGACY_KEY, null);
  const prefs = readPreferences(legacy, { touch });
  if (isRecord(legacy)) savePreferences(prefs);
  return prefs;
}

// Returns false when storage is unavailable or full; the game keeps running either way.
export function savePreferences(prefs) {
  return saveJSON(KEYS.prefs, prefs);
}

const LABELS = new Map([
  ["Mouse0", "Left mouse"],
  ["Mouse1", "Middle mouse"],
  ["Mouse2", "Right mouse"],
  ["Space", "Space"],
  ["Escape", "Esc"],
]);

// Short human-readable label for a saved code: "KeyW" -> "W", "ArrowUp" -> "Arrow Up".
export function keyLabel(code) {
  const text = String(code ?? "");
  return LABELS.get(text) ?? text.replace(/^Key|^Digit/, "").replace("Arrow", "Arrow ");
}

// Conflict swap: binding a code another action uses hands that action the old code.
// Accepts the prefs object (contract) or a bare bindings map (the original's form).
// Returns the displaced action, or undefined.
export function assignBinding(prefs, action, code) {
  const holder = prefs && typeof prefs.bindings === "object" && prefs.bindings ? prefs : null;
  if (holder && Object.isFrozen(holder.bindings)) holder.bindings = { ...holder.bindings };
  const bindings = holder ? holder.bindings : prefs;
  const other = Object.keys(bindings).find((k) => k !== action && bindings[k] === code);
  if (other) bindings[other] = bindings[action];
  bindings[action] = code;
  return other;
}
