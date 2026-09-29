// Device-local, visual-only progress: the Journal (milestones, codex, keeper records, mastery,
// discoveries, cosmetics) and the run history used for report comparisons. Nothing here may
// ever feed combat, spawning or scoring: meta rewards are badges, dash-trail colours, titles,
// Journal text and run-report lines. Gameplay reaches it only through the record/award
// whitelist (IMPROVEMENTS §1.4).
//
// Profile v2 (F19.5): codex sections, keeper records, titles and the Wave-2 challenges, a
// migration from v1 (personal bests move onto sameRuleset versions), a backup copy before any
// version change or import, a monotonic merge with other tabs, and throttled persistence.
import { KEYS, loadJSON, saveJSON, storageAvailable } from "../core/storage.js";
import { clamp } from "../core/util.js";
import { LANDMARKS, LANDMARK_IDS } from "../data/landmarks.js";
import { ALL_DEFS } from "../data/defs.js";
import { KEEPERS } from "../data/keepers.js";
import { RELICS } from "../data/relics.js";
import { GAMEPLAY_VERSIONS, LEGACY_ORIGINAL, sameRuleset } from "../data/stages.js";
import { AFFIX_CODEX, BESTIARY, HAZARD_CODEX, SHORT_TIPS, causeOf } from "../data/codex.js";
import {
  CHAIN_TARGET,
  CHALLENGES,
  COSMETICS,
  DEFAULT_COSMETICS,
  ELITE_TARGET,
  MASTERY_KILL_TARGET,
  RELIC_TARGET,
  WEAPON_IDS,
  WEAPON_TRAILS,
} from "../data/cosmetics.js";

export { BESTIARY, COSMETICS, MASTERY_KILL_TARGET };

// The original game's profile: read once for the import, never written. (Its settings
// key is migrated by input/preferences.js when preferences load.)
const LEGACY_PROFILE_KEY = "riftborn-profile-v1";

export const PROFILE_VERSION = 2;
const NAME_LIMIT = 16;
const RUN_LIMIT = 50;
const DEFEAT_CAP = 1e7;
const MASTERY_RUN_LIMIT = 256;
// Counters (kills) are batched every 10 s during a run; sightings, unlocks and records within
// a second. A crash loses at most that much progress.
const COUNTER_SAVE_MS = 10000;
const EVENT_SAVE_MS = 1000;
const COMPLETE_SHOWN_MS = 3000; // a completed tracked goal reads COMPLETE this long
const THREE_OR_MORE = 3; // statues (Crowned in Curses), omens (Omen-crowned), shades (Unmade)
// Keepers with a mastery of their own (Unmoved by the Bell, Quenched, Held Fire).
const KEEPER_MASTERY = new Set(["bellwether", "abbot", "castellan"]);

export const MILESTONES = Object.freeze(
  [
    { key: "trial", goal: "Complete a Skull Trial", earned: "Trial complete + Skull badge" },
    { key: "quarry", goal: "Defeat Iron Maw", earned: "Iron Maw defeated" },
    { key: "warden", goal: "Defeat the Warden", earned: "Warden defeated + Ember trail" },
    { key: "keeper:bellwether", goal: "Silence the Bellwether", earned: "Bellwether silenced" },
    { key: "keeper:abbot", goal: "Quench the Cinder Abbot", earned: "Abbot quenched" },
    { key: "keeper:castellan", goal: "Unseal the Castellan", earned: "Castellan unsealed" },
    { key: "unmade", goal: "Unmake the Crown", earned: "Crown unmade" },
  ].map(Object.freeze),
);
const MILESTONE_KEYS = MILESTONES.map((m) => m.key);

// Landmark lore (shown in the Journal once discovered) is shared with the world module.
export { LANDMARKS };

const CHALLENGE_KEYS = Object.freeze(["cleanMaw", "cursedVictory", "keeperBell", "keeperEmber", "keeperAegis", "crownUnmade", "omenVictory"]);
const ENTRY_IDS = Object.freeze(CHALLENGES.map((c) => c.id));
const AFFIX_IDS = Object.freeze(Object.keys(AFFIX_CODEX));
const HAZARD_KINDS = Object.freeze(Object.keys(HAZARD_CODEX));
const RELIC_IDS = Object.freeze(Object.keys(RELICS));
const KEEPER_IDS = Object.freeze(Object.keys(KEEPERS));

const BEST_KEY = /^[a-z0-9-]+:(normal|death)$/;
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const validRunId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const counter = (v, max) => (Number.isSafeInteger(v) ? clamp(v, 0, max) : 0);
const cleanName = (v) => String(v ?? "").trim().slice(0, NAME_LIMIT);
const catalogEntry = (slot, value) => COSMETICS.find((c) => c.slot === slot && c.value === value);
const isRealRun = (run) => !!run && run.kind === "real" && !run.demo && !run.practice && !run.tutorial;
const isMaw = (e) => e.boss === "ironmaw" || e.kind === "ironmaw" || e.miniboss === true;
const isWarden = (e) => e.boss === "warden" || e.kind === "warden";
const eliteIds = (e) => (Array.isArray(e?.elite) ? e.elite : []);
// Iron Maw is recorded under its own entry from the first sighting (the original marked
// "charger" seen at spawn and only listed the Maw after a kill).
const bestiaryKey = (e) => (isMaw(e) ? "ironmaw" : (e.keeper ?? e.kind));
// Personal bests are keyed by ruleset: Wave-1 "reborn-1" records count as "original-1".
const canonVersion = (v) => (LEGACY_ORIGINAL.includes(v) ? GAMEPLAY_VERSIONS.original : v);
const hpLost = ({ amount = 0, absorbed = 0 } = {}) => (typeof absorbed === "number" ? amount - absorbed > 0 : !absorbed && amount > 0);

export function normalizeMastery(raw) {
  const source = isObject(raw) ? raw : {};
  const kills = Array.isArray(source.weaponKills) ? source.weaponKills : [];
  const found = Array.isArray(source.discoveries) ? source.discoveries : [];
  const challenges = {};
  for (const key of CHALLENGE_KEYS) challenges[key] = source.challenges?.[key] === true;
  return {
    weaponKills: WEAPON_IDS.map((_, i) => counter(kills[i], MASTERY_KILL_TARGET)),
    discoveries: LANDMARK_IDS.filter((id) => found.includes(id)),
    challenges,
    chainBest: counter(source.chainBest, DEFEAT_CAP),
    eliteKills: counter(source.eliteKills, DEFEAT_CAP),
    tracked: ENTRY_IDS.includes(source.tracked) ? source.tracked : null,
    runIds: Array.isArray(source.runIds) ? [...new Set(source.runIds.filter(validRunId))].slice(0, MASTERY_RUN_LIMIT) : [],
  };
}

// Codex sections (F19.1): affix sightings and defeats, hazards seen, relics taken (runs).
function normalizeCodex(raw) {
  const source = isObject(raw) ? raw : {};
  const affixes = {},
    relics = {};
  for (const id of AFFIX_IDS) {
    const a = source.affixes?.[id];
    if (isObject(a)) affixes[id] = { seen: !!a.seen, defeated: counter(a.defeated, DEFEAT_CAP) };
  }
  for (const id of RELIC_IDS) {
    const n = counter(source.relics?.[id], DEFEAT_CAP);
    if (n > 0) relics[id] = n;
  }
  const hazards = Array.isArray(source.hazards) ? HAZARD_KINDS.filter((k) => source.hazards.includes(k)) : [];
  return { affixes, hazards, relics };
}

// Keeper records (F19.3): { defeated, bestSeconds, untouched } per keeper.
function normalizeKeepers(raw) {
  const out = {};
  for (const id of KEEPER_IDS) {
    const k = isObject(raw) ? raw[id] : null;
    if (!isObject(k)) continue;
    const best = Number.isFinite(k.bestSeconds) && k.bestSeconds > 0 ? k.bestSeconds : null;
    out[id] = { defeated: counter(k.defeated, DEFEAT_CAP), bestSeconds: best, untouched: k.untouched === true };
  }
  return out;
}

const relicsTaken = (p) => Object.keys(p?.codex?.relics ?? {}).length;
const has = (p, key) => Array.isArray(p?.milestones) && p.milestones.includes(key);

// Unlock rule of every cosmetic ("slot:value"); the defaults are always available.
const UNLOCKS = Object.freeze({
  "badge:skull": (p) => has(p, "trial"),
  "badge:iron": (p, m) => m.challenges.cleanMaw,
  "badge:crown": (p, m) => m.challenges.cursedVictory,
  "badge:bell": (p, m) => m.challenges.keeperBell,
  "badge:ember": (p, m) => m.challenges.keeperEmber,
  "badge:aegis": (p, m) => m.challenges.keeperAegis,
  "badge:unmade": (p, m) => m.challenges.crownUnmade,
  "badge:omen": (p, m) => m.challenges.omenVictory,
  "badge:chain": (p, m) => m.chainBest >= CHAIN_TARGET,
  "badge:keeper": (p) => relicsTaken(p) >= RELIC_TARGET,
  "trail:ember": (p) => has(p, "warden"),
  // Legacy rule: any weapon at 75 or World Discoverer (so no v1 aurora holder loses it).
  "trail:aurora": (p, m) => m.weaponKills.some((k) => k >= MASTERY_KILL_TARGET) || m.discoveries.length === LANDMARK_IDS.length,
  ...Object.fromEntries(WEAPON_TRAILS.map((trail, i) => [`trail:${trail}`, (p, m) => m.weaponKills[i] >= MASTERY_KILL_TARGET])),
  "title:wardenbane": (p) => has(p, "warden"),
  "title:cursebearer": (p, m) => m.challenges.cursedVictory,
  "title:unmade": (p, m) => m.challenges.crownUnmade,
  "title:crownbreaker": (p, m) => m.chainBest >= CHAIN_TARGET,
  "title:hunter": (p, m) => m.eliteKills >= ELITE_TARGET,
});

export function cosmeticAvailable(p, slot, value) {
  if (!catalogEntry(slot, value)) return false;
  if (DEFAULT_COSMETICS[slot] === value) return true;
  const rule = UNLOCKS[`${slot}:${value}`];
  return !!rule && !!rule(p, normalizeMastery(p?.mastery));
}

function equipCosmetic(p, slot, value) {
  if (!cosmeticAvailable(p, slot, value)) return false;
  p.cosmetics[slot] = value;
  return true;
}

function freshProfile() {
  return {
    version: PROFILE_VERSION,
    lastUsername: "",
    enemies: {},
    milestones: [],
    cosmetics: { ...DEFAULT_COSMETICS },
    scoreBests: {},
    runs: [],
    mastery: normalizeMastery(),
    codex: normalizeCodex(),
    keepers: {},
  };
}

function rememberBest(p, run) {
  if (typeof run.death_mode !== "boolean" || !run.gameplay_version) return;
  const key = canonVersion(run.gameplay_version) + ":" + (run.death_mode ? "death" : "normal");
  if (!BEST_KEY.test(key)) return;
  p.scoreBests[key] = Math.max(p.scoreBests[key] || 0, run.score);
}

// Validates anything read from storage (v1 or v2) into a v2 profile; a corrupt profile yields a
// fresh one. Unknown keys are dropped. Order matters: cosmetics are equipped only after
// milestones, mastery and the codex are known. v1 bests of "reborn-1" also count for
// "original-1" (the max of both).
export function normalizeProfile(raw) {
  const p = freshProfile();
  if (!isObject(raw)) return p;
  if (typeof raw.lastUsername === "string") p.lastUsername = cleanName(raw.lastUsername);
  for (const [key, v] of Object.entries(isObject(raw.enemies) ? raw.enemies : {}))
    if (Object.hasOwn(ALL_DEFS, key) && isObject(v)) p.enemies[key] = { seen: !!v.seen, defeated: counter(v.defeated, DEFEAT_CAP) };
  p.milestones = MILESTONE_KEYS.filter((k) => Array.isArray(raw.milestones) && raw.milestones.includes(k));
  p.mastery = normalizeMastery(raw.mastery);
  p.codex = normalizeCodex(raw.codex);
  p.keepers = normalizeKeepers(raw.keepers);
  for (const slot of Object.keys(DEFAULT_COSMETICS)) equipCosmetic(p, slot, raw.cosmetics?.[slot]);
  if (Array.isArray(raw.runs))
    p.runs = raw.runs
      .filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && Number.isFinite(r.score))
      .slice(0, RUN_LIMIT)
      .map((r) => ({ ...r }));
  for (const [key, value] of Object.entries(isObject(raw.scoreBests) ? raw.scoreBests : {})) {
    if (!BEST_KEY.test(key) || !Number.isFinite(value) || value < 0) continue;
    const [version, mode] = key.split(":");
    for (const k of new Set([key, canonVersion(version) + ":" + mode])) p.scoreBests[k] = Math.max(p.scoreBests[k] || 0, value);
  }
  for (const r of p.runs) rememberBest(p, r);
  return p;
}

// Monotonic merge of another copy's progress (another tab, or the legacy profile): counters
// take the max, sets union, challenges OR, keeper bests the min. Choices merge separately.
function mergeProgress(p, other) {
  for (const [key, theirs] of Object.entries(other.enemies)) {
    const mine = p.enemies[key];
    p.enemies[key] = mine ? { seen: mine.seen || theirs.seen, defeated: Math.max(mine.defeated, theirs.defeated) } : { ...theirs };
  }
  p.milestones = MILESTONE_KEYS.filter((k) => p.milestones.includes(k) || other.milestones.includes(k));
  const a = p.mastery,
    b = other.mastery;
  p.mastery = normalizeMastery({
    weaponKills: a.weaponKills.map((n, i) => Math.max(n, b.weaponKills[i])),
    discoveries: [...a.discoveries, ...b.discoveries],
    challenges: Object.fromEntries(CHALLENGE_KEYS.map((k) => [k, a.challenges[k] || b.challenges[k]])),
    chainBest: Math.max(a.chainBest, b.chainBest),
    eliteKills: Math.max(a.eliteKills, b.eliteKills),
    tracked: a.tracked,
    runIds: [...a.runIds, ...b.runIds],
  });
  for (const [id, theirs] of Object.entries(other.codex.affixes)) {
    const mine = p.codex.affixes[id];
    p.codex.affixes[id] = mine ? { seen: mine.seen || theirs.seen, defeated: Math.max(mine.defeated, theirs.defeated) } : { ...theirs };
  }
  p.codex.hazards = HAZARD_KINDS.filter((k) => p.codex.hazards.includes(k) || other.codex.hazards.includes(k));
  for (const [id, n] of Object.entries(other.codex.relics)) p.codex.relics[id] = Math.max(p.codex.relics[id] || 0, n);
  for (const [id, theirs] of Object.entries(other.keepers)) {
    const mine = p.keepers[id];
    const bests = [mine?.bestSeconds, theirs.bestSeconds].filter((s) => s !== null && s !== undefined);
    p.keepers[id] = {
      defeated: Math.max(mine?.defeated || 0, theirs.defeated),
      bestSeconds: bests.length ? Math.min(...bests) : null,
      untouched: !!mine?.untouched || theirs.untouched,
    };
  }
  const runs = new Map();
  for (const r of [...p.runs, ...other.runs]) if (!runs.has(r.id)) runs.set(r.id, r);
  p.runs = [...runs.values()].sort((x, y) => (y.played_at || 0) - (x.played_at || 0)).slice(0, RUN_LIMIT);
  for (const [key, value] of Object.entries(other.scoreBests)) p.scoreBests[key] = Math.max(p.scoreBests[key] || 0, value);
  for (const r of p.runs) rememberBest(p, r);
}

// Two copies of a profile (raw or normalized) merged into a fresh v2 profile. Counters and
// sets merge monotonically, so the result is idempotent and commutative for them; choices
// (cosmetics, tracked goal, name) come from `a`.
export function mergeProfiles(a, b) {
  const p = normalizeProfile(a);
  mergeProgress(p, normalizeProfile(b));
  return p;
}

// Run-report comparison lines. Older records with an unknown mode or ruleset never form a
// baseline, so the first run of a ruleset and mode gets no lines at all. Wave-1 "reborn-1"
// records are ORIGINAL-ruleset records.
export function compareRun(run, runs, bests = {}) {
  const prior = runs.filter(
    (r) =>
      r.id !== run.id &&
      typeof r.death_mode === "boolean" &&
      r.death_mode === run.death_mode &&
      r.gameplay_version &&
      sameRuleset(r.gameplay_version, run.gameplay_version),
  );
  const savedBest = bests[canonVersion(run.gameplay_version) + ":" + (run.death_mode ? "death" : "normal")];
  if (!prior.length && !Number.isFinite(savedBest)) return [];
  const lines = [];
  if (run.score > Math.max(savedBest || 0, ...prior.map((r) => r.score))) lines.push("PERSONAL BEST");
  const previous = prior[0];
  if (!previous) return lines;
  const sign = (n) => (n >= 0 ? "+" : "");
  const delta = run.score - previous.score;
  const stages = Number.isFinite(run.stage) && Number.isFinite(previous.stage) ? run.stage - previous.stage : NaN;
  lines.push(
    `${sign(delta)}${delta} score${Number.isFinite(stages) ? ` · ${sign(stages)}${stages} stages` : ""} vs previous ${run.death_mode ? "Death" : "Normal"} run`,
  );
  if (run.outcome === "victory" && previous.outcome === "victory" && Number.isFinite(previous.seconds) && run.seconds !== previous.seconds) {
    const d = run.seconds - previous.seconds;
    lines.push(`${Math.abs(d)}s ${d < 0 ? "faster" : "slower"} completion`);
  }
  return lines;
}

// Current progress of each MASTERY & CHALLENGES entry.
function progressOf(p, m, id) {
  const weapon = WEAPON_IDS.indexOf(id.replace(/^weapon-/, ""));
  if (id.startsWith("weapon-") && weapon >= 0) return m.weaponKills[weapon];
  const c = m.challenges;
  switch (id) {
    case "clean-maw":
      return Number(c.cleanMaw);
    case "cursed-victory":
      return Number(c.cursedVictory);
    case "world-discoverer":
      return m.discoveries.length;
    case "keeper-bell":
      return Number(c.keeperBell);
    case "keeper-ember":
      return Number(c.keeperEmber);
    case "keeper-aegis":
      return Number(c.keeperAegis);
    case "crown-unmade":
      return Number(c.crownUnmade);
    case "omen-victory":
      return Number(c.omenVictory);
    case "chain-100":
      return Math.min(m.chainBest, CHAIN_TARGET);
    case "elite-10":
      return Math.min(m.eliteKills, ELITE_TARGET);
    case "codex-relics":
      return relicsTaken(p);
    default:
      return 0;
  }
}

function buildEntries(p) {
  const m = p.mastery;
  return Object.freeze(
    CHALLENGES.map((c) => {
      const rewards = c.rewards.map(([slot, value]) => {
        const item = catalogEntry(slot, value);
        return Object.freeze({ slot, value, label: item.label });
      });
      const current = progressOf(p, m, c.id);
      return Object.freeze({
        id: c.id,
        title: c.title,
        description: c.description,
        current,
        target: c.target,
        complete: current >= c.target,
        reward: rewards[0],
        rewards: Object.freeze(rewards),
        tracked: m.tracked === c.id,
      });
    }),
  );
}

// Run outcome from whatever shape the caller reports: "victory" | "defeat" | "ended".
function outcomeOf(summary, run) {
  const o = String(summary.outcome ?? "").toLowerCase();
  if (summary.victory === true || o === "victory" || (!o && run?.victory)) return "victory";
  if (summary.defeated === true || o === "defeat" || o === "defeated") return "defeat";
  return "ended";
}

const asSource = (v) => (typeof v === "string" ? { id: v } : isObject(v) ? v : null);

// The first-sighting payload of the codex bus event: NEW ENTRY · {NAME} · {SHORT}.
const sighting = (section, key, name) => ({ section, key, name: String(name).toUpperCase(), short: SHORT_TIPS[key] ?? "" });

export function createProfile(ctx) {
  // Developer scenarios and automated tests never read or write stored progress.
  const persistent = !ctx.env?.debug?.practice && !window.__RIFTBORN_TEST__;
  const stored = persistent ? loadJSON(KEYS.profile, null) : null;
  const data = normalizeProfile(stored);
  let saved = persistent && storageAvailable();
  let synced = choicesOf(data); // choices as last seen in storage: the base of the 3-way merge
  let entries = null; // cached masteryEntries(); the HUD reads it every frame
  let saveTimer = 0,
    saveDue = 0,
    dirty = false;
  let unlocked = availableKeys(); // cosmetics available so far (unlock announcements)
  let complete = completedIds(); // entries complete as of the last progress
  let untrackTimer = 0;

  // Per-run state, reset on every "runStart".
  let baseline = complete;
  let earned = [];
  let maw = { untouched: true, defeated: false };
  let credited = new WeakSet(); // enemies whose kill is already recorded
  let comparison = null; // { id, lines } captured before a record joins the history
  let fights = new Map(); // keeper kind -> { t0, untouched } since its spawn
  let recorded = new Set(); // keeper ids and relic ids already recorded this run
  let shades = 0; // shades the Warden raised this run (The Crown Unmade)

  function choicesOf(p) {
    return { ...p.cosmetics, tracked: p.mastery.tracked, lastUsername: p.lastUsername };
  }

  function completedIds() {
    return new Set(masteryEntries().filter((e) => e.complete).map((e) => e.id));
  }

  function availableKeys() {
    return new Set(COSMETICS.filter((c) => cosmeticAvailable(data, c.slot, c.value)).map((c) => `${c.slot}:${c.value}`));
  }

  // A practice run started with &persist=1 records into this page's throwaway profile (codex
  // toasts can be checked); nothing is ever stored from it.
  const practiceRecording = (run) => !!run?.practice && ctx.practice?.params?.persist === true;

  function enabled() {
    const run = ctx.run;
    return (persistent && isRealRun(run)) || practiceRecording(run);
  }

  // A practice run finished with &board=local keeps its record in memory (YOU highlights).
  const localBoard = (record) => !!ctx.run?.practice && ctx.run.id === record?.id && ctx.practice?.params?.board === "local";

  // A finished run's record may arrive after the attract demo has replaced ctx.run, so
  // eligibility comes from the record: only real runs carry a run id.
  function recordEligible(record) {
    if (!validRunId(record?.id)) return false;
    if (localBoard(record)) return true;
    if (!persistent) return false;
    return !(ctx.run && ctx.run.id === record.id && !isRealRun(ctx.run));
  }

  // Folds another copy of the profile into ours. Choices (cosmetics, tracked goal, name) take
  // the other copy's value only when it changed there and not here.
  function absorb(raw) {
    const other = normalizeProfile(raw);
    mergeProgress(data, other);
    const theirs = choicesOf(other),
      mine = choicesOf(data);
    for (const slot of Object.keys(DEFAULT_COSMETICS))
      if (theirs[slot] !== synced[slot] && mine[slot] === synced[slot]) equipCosmetic(data, slot, theirs[slot]);
    if (theirs.tracked !== synced.tracked && mine.tracked === synced.tracked) data.mastery.tracked = theirs.tracked;
    if (theirs.lastUsername !== synced.lastUsername && mine.lastUsername === synced.lastUsername) data.lastUsername = theirs.lastUsername;
    synced = theirs;
    entries = null;
    unlocked = availableKeys();
    complete = completedIds();
  }

  // Read-merge-write so a second tab's progress is never overwritten. A stored copy of another
  // version is backed up first (the v1 -> v2 migration, or a tab of another build).
  function save() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    dirty = false;
    if (!persistent) return (saved = false);
    const current = loadJSON(KEYS.profile, null);
    if (isObject(current) && current.version !== PROFILE_VERSION) saveJSON(KEYS.profileBak, current);
    if (current) absorb(current);
    saved = saveJSON(KEYS.profile, data);
    if (saved) synced = choicesOf(data);
    return saved;
  }

  // Throttled persistence: a save no later than `delay` ms from now (an earlier one stands).
  function requestSave(delay) {
    dirty = true;
    if (!persistent) return;
    const due = Date.now() + delay;
    if (saveTimer && saveDue <= due) return;
    clearTimeout(saveTimer);
    saveDue = due;
    saveTimer = setTimeout(save, delay);
    saveTimer?.unref?.();
  }

  function flushPending() {
    if (dirty) save();
  }

  // After any progress: announce cosmetics that just became available (bus "unlock"), and let
  // a tracked goal that just completed read COMPLETE for 3 s before it untracks itself.
  function progressed() {
    entries = null;
    const now = availableKeys();
    for (const c of COSMETICS) {
      const key = `${c.slot}:${c.value}`;
      if (now.has(key) && !unlocked.has(key)) ctx.bus.emit("unlock", { slot: c.slot, value: c.value, label: c.label.toUpperCase() });
    }
    unlocked = now;
    const goal = masteryEntries().find((e) => e.tracked);
    if (goal?.complete && !complete.has(goal.id) && !untrackTimer) {
      untrackTimer = setTimeout(() => {
        untrackTimer = 0;
        if (data.mastery.tracked === goal.id) track(null);
      }, COMPLETE_SHOWN_MS);
      untrackTimer?.unref?.();
    }
    complete = completedIds();
  }

  function award(key) {
    if (!enabled() || !MILESTONE_KEYS.includes(key) || data.milestones.includes(key)) return false;
    data.milestones = MILESTONE_KEYS.filter((k) => k === key || data.milestones.includes(k));
    earned.push(key);
    progressed();
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  // Bestiary sighting or defeat. Returns true on the first sighting ever (bus "codex").
  function recordEnemy(kind, defeated = false) {
    if (!enabled() || !BESTIARY[kind]) return false;
    const first = !data.enemies[kind]?.seen;
    const e = data.enemies[kind] || (data.enemies[kind] = { seen: true, defeated: 0 });
    e.seen = true;
    if (defeated) e.defeated = Math.min(DEFEAT_CAP, e.defeated + 1);
    if (first) {
      ctx.bus.emit("codex", sighting("bestiary", kind, BESTIARY[kind].name));
      requestSave(EVENT_SAVE_MS);
    } else if (defeated) requestSave(COUNTER_SAVE_MS);
    return first;
  }

  // RIFT-TOUCHED: an affix seen, or one of its bodies defeated. True on the first sighting.
  function recordAffix(id, defeated = false) {
    if (!enabled() || !AFFIX_CODEX[id]) return false;
    const a = data.codex.affixes[id] || (data.codex.affixes[id] = { seen: false, defeated: 0 });
    const first = !a.seen;
    a.seen = true;
    if (defeated) a.defeated = Math.min(DEFEAT_CAP, a.defeated + 1);
    if (first) ctx.bus.emit("codex", sighting("affix", id, AFFIX_CODEX[id].name));
    requestSave(first ? EVENT_SAVE_MS : COUNTER_SAVE_MS);
    return first;
  }

  // HAZARDS: a hazard kind seen. True on the first sighting.
  function recordHazard(kind) {
    if (!enabled() || !HAZARD_CODEX[kind] || data.codex.hazards.includes(kind)) return false;
    data.codex.hazards = HAZARD_KINDS.filter((k) => k === kind || data.codex.hazards.includes(k));
    ctx.bus.emit("codex", sighting("hazard", kind, HAZARD_CODEX[kind].name));
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  // RELICS: a relic taken (counted once per run). True when this run took it.
  function recordRelic(id) {
    if (!enabled() || !RELICS[id] || recorded.has("relic:" + id)) return false;
    recorded.add("relic:" + id);
    data.codex.relics[id] = Math.min(DEFEAT_CAP, (data.codex.relics[id] || 0) + 1);
    progressed();
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  // Keeper records (F19.3): defeats, the fastest fight and whether one was ever untouched.
  // Counted once per keeper per run, whoever reports it.
  function keeperRecord(id, { seconds, untouched = false } = {}) {
    if (!enabled() || !KEEPERS[id] || recorded.has("keeper:" + id)) return false;
    recorded.add("keeper:" + id);
    const k = data.keepers[id] || (data.keepers[id] = { defeated: 0, bestSeconds: null, untouched: false });
    k.defeated = Math.min(DEFEAT_CAP, k.defeated + 1);
    if (Number.isFinite(seconds) && seconds > 0) k.bestSeconds = k.bestSeconds === null ? seconds : Math.min(k.bestSeconds, seconds);
    k.untouched ||= untouched === true;
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  function recordWeaponKill(slot) {
    if (!enabled() || !Number.isInteger(slot) || slot < 0 || slot >= WEAPON_IDS.length) return false;
    const kills = data.mastery.weaponKills;
    if (kills[slot] >= MASTERY_KILL_TARGET) return false;
    kills[slot]++;
    if (kills[slot] >= MASTERY_KILL_TARGET) progressed();
    else entries = null;
    requestSave(COUNTER_SAVE_MS);
    return true;
  }

  function recordDiscovery(id) {
    const found = data.mastery.discoveries;
    if (!enabled() || !LANDMARK_IDS.includes(id) || found.includes(id)) return false;
    data.mastery.discoveries = LANDMARK_IDS.filter((l) => l === id || found.includes(l));
    progressed();
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  // Challenge credit under an outcome id; each id counts once (a run id, "<run>-maw",
  // "<run>-<keeper>"). Returns true even when no challenge changed.
  function completeMastery(run) {
    const m = data.mastery;
    if (!enabled() || !validRunId(run.id) || m.runIds.includes(run.id)) return false;
    m.runIds.unshift(run.id);
    m.runIds.length = Math.min(m.runIds.length, MASTERY_RUN_LIMIT);
    const c = m.challenges;
    if (run.mawDefeated === true && run.mawUntouched === true) c.cleanMaw = true;
    if (run.victory === true && Number.isSafeInteger(run.statues) && run.statues >= THREE_OR_MORE) c.cursedVictory = true;
    if (run.victory === true && Number.isSafeInteger(run.omens) && run.omens >= THREE_OR_MORE) c.omenVictory = true;
    if (run.victory === true && run.shades >= THREE_OR_MORE && run.shadeHits === 0) c.crownUnmade = true;
    const stats = run.keeperStats;
    if (run.keeper === "bellwether" && stats?.tollHits === 0) c.keeperBell = true;
    if (run.keeper === "abbot" && stats?.total > 0 && stats.rear >= stats.total / 2) c.keeperEmber = true;
    if (run.keeper === "castellan" && stats?.reflectHits === 0) c.keeperAegis = true;
    progressed();
    requestSave(EVENT_SAVE_MS);
    return true;
  }

  const mawUntouched = () => maw.untouched && ctx.run?.flags?.mawUntouched !== false;

  // Untouched by Iron is granted the moment the Maw falls, under "<runId>-maw".
  function mawDefeated() {
    if (maw.defeated) return;
    maw.defeated = true;
    const id = ctx.run?.id;
    if (id) completeMastery({ id: id + "-maw", mawDefeated: true, mawUntouched: mawUntouched() });
    award("quarry");
  }

  // A keeper's mastery (Unmoved by the Bell, Quenched, Held Fire) from its fight stats,
  // once per keeper per run.
  function keeperMastery(keeper, stats) {
    const id = ctx.run?.id;
    if (id && KEEPER_MASTERY.has(keeper)) completeMastery({ id: `${id}-${keeper}`, keeper, keeperStats: stats });
  }

  function track(id) {
    if ((id !== null && !ENTRY_IDS.includes(id)) || data.mastery.tracked === id) return false;
    data.mastery.tracked = id;
    entries = null;
    save();
    return true;
  }

  // Journal goal selection (an entry id or null), or a gameplay mastery event:
  // "quarryStart" (Maw encounter active), "mawHit" (HP lost during it), "mawDefeated"
  // ({ untouched } optional), "keeper" ({ id, keeper, untouched, stats }: a keeper fell).
  function trackMastery(event, payload) {
    if (event === null || ENTRY_IDS.includes(event)) return track(event);
    if (event === "quarryStart") maw.untouched = true;
    else if (event === "mawHit") maw.untouched = false;
    else if (event === "mawDefeated") {
      if (payload?.untouched === false) maw.untouched = false;
      mawDefeated();
    } else if (event === "keeper" && KEEPERS[payload?.keeper]) keeperMastery(payload.keeper, payload.stats);
    else return false;
    return true;
  }

  function masteryEntries() {
    return (entries ||= buildEntries(data));
  }

  // The bestiary in Journal order: { key, name, hint, lore, home, seen, defeated }.
  function bestiary() {
    const out = {};
    for (const [key, b] of Object.entries(BESTIARY)) {
      const e = data.enemies[key];
      out[key] = Object.freeze({ key, ...b, seen: !!e?.seen, defeated: e?.defeated || 0 });
    }
    return Object.freeze(out);
  }

  // Run end: challenge credit plus everything the run report needs from meta.
  function completeRun(summary = {}) {
    const run = ctx.run;
    const outcome = outcomeOf(summary, run);
    const id = summary.id ?? run?.id;
    const best = run?.rift?.chain?.best || 0;
    if (enabled() && best > data.mastery.chainBest) {
      data.mastery.chainBest = Math.min(DEFEAT_CAP, best);
      progressed();
    }
    if (id)
      completeMastery({
        id,
        victory: outcome === "victory",
        statues: summary.statues ?? run?.statueCount,
        omens: summary.omens?.length ?? ctx.omens?.active?.()?.length ?? 0,
        shades,
        shadeHits: run?.flags?.shadeHits ?? 0,
        mawDefeated: summary.mawDefeated ?? maw.defeated,
        mawUntouched: summary.mawUntouched ?? mawUntouched(),
      });
    if (enabled()) save(); // flushes the counters gathered during the run
    const lethal = asSource(summary.lethal ?? run?.stats?.lethal);
    const cause = outcome === "defeat" ? causeOf(lethal) : null;
    return {
      newly: masteryEntries()
        .filter((e) => e.complete && !baseline.has(e.id))
        .map((e) => e.title),
      earned: [...earned],
      milestones: earned.map((k) => MILESTONES.find((m) => m.key === k).earned),
      cause: outcome === "victory" ? "Rift Warden defeated" : outcome === "ended" ? "Voluntary end" : cause.label,
      hint: cause?.hint ?? null,
    };
  }

  function compare(record) {
    if (!recordEligible(record)) return [];
    if (comparison?.id === record.id) return [...comparison.lines];
    return compareRun(record, data.runs, data.scoreBests);
  }

  function rememberRun(record) {
    if (!recordEligible(record) || typeof record.name !== "string" || !Number.isFinite(record.score)) return false;
    // Freeze the comparison first: once the record is stored it would be its own best.
    if (comparison?.id !== record.id) comparison = { id: record.id, lines: compareRun(record, data.runs, data.scoreBests) };
    rememberBest(data, record);
    if (!data.runs.some((r) => r.id === record.id)) {
      data.runs.unshift({ ...record });
      data.runs.length = Math.min(data.runs.length, RUN_LIMIT);
    }
    save();
    return true;
  }

  function applyCosmetics() {
    const badge = data.cosmetics.badge;
    const c = catalogEntry("badge", badge);
    document.querySelector("#profileBadge")?.classList.toggle("hidden", badge !== "skull");
    const label = document.querySelector("#earnedBadge");
    if (!label) return;
    label.textContent = c?.text || "";
    label.style.color = c?.color || "#ded6be";
    label.title = c?.label || "";
  }

  const cosmetics = {
    catalog: COSMETICS,
    get badge() {
      return data.cosmetics.badge;
    },
    get trail() {
      return data.cosmetics.trail;
    },
    // The equipped title as shown under the name on board rows and the results card.
    get title() {
      return catalogEntry("title", data.cosmetics.title)?.text ?? "";
    },
    available: (slot, value) => cosmeticAvailable(data, slot, value),
    // Journal action: always persisted (except in developer mode) and applied at once.
    equip(slot, value) {
      if (!equipCosmetic(data, slot, value)) return false;
      save();
      applyCosmetics();
      return true;
    },
    // Read live on every use so an equip from the pause-menu Journal applies mid-run.
    trailColor: () => catalogEntry("trail", data.cosmetics.trail)?.color || "#81ffff",
  };

  // One-time import of the original game's Journal into this build's key: milestones,
  // cosmetics, mastery, bestiary, discoveries, bests, run history and the last name.
  // Runs only while no profile of this build exists; the legacy key stays untouched. The
  // pre-import state (or the imported copy) is backed up first.
  function importLegacy() {
    if (!persistent) return false;
    const legacy = loadJSON(LEGACY_PROFILE_KEY, null);
    if (!isObject(legacy)) return false;
    saveJSON(KEYS.profileBak, loadJSON(KEYS.profile, null) ?? legacy);
    absorb(legacy);
    baseline = completedIds();
    return save();
  }

  // Developer PREVIEW COSMETICS: unlock and equip the milestone cosmetics in memory
  // only (developer mode never persists).
  function previewCosmetics() {
    if (persistent) return false;
    data.milestones = [...MILESTONE_KEYS];
    equipCosmetic(data, "badge", "skull");
    equipCosmetic(data, "trail", "ember");
    equipCosmetic(data, "title", "wardenbane");
    entries = null;
    unlocked = availableKeys();
    applyCosmetics();
    return true;
  }

  function beginRun(run) {
    baseline = complete = completedIds();
    earned = [];
    maw = { untouched: true, defeated: false };
    credited = new WeakSet();
    comparison = null;
    fights = new Map();
    recorded = new Set();
    shades = 0;
    const name = cleanName(run?.name);
    if (persistent && isRealRun(run) && name && name !== data.lastUsername) {
      data.lastUsername = name;
      save();
    }
  }

  function sighted(e) {
    if (!e) return;
    if (isMaw(e)) maw.untouched = true; // the Maw spawns as its encounter activates
    recordEnemy(bestiaryKey(e));
    for (const id of eliteIds(e)) recordAffix(id);
  }

  function killed(e, source) {
    if (!e || e.fixed || credited.has(e)) return;
    credited.add(e);
    if (!enabled()) return;
    recordEnemy(bestiaryKey(e), true);
    recordWeaponKill(source?.weapon ?? source?.sourceWeapon);
    const affixes = eliteIds(e);
    for (const id of affixes) recordAffix(id, true);
    if (affixes.length) {
      data.mastery.eliteKills = Math.min(DEFEAT_CAP, data.mastery.eliteKills + 1);
      progressed();
    }
    if (isMaw(e)) mawDefeated();
    else if (isWarden(e)) award("warden");
  }

  // Real HP loss spoils every live keeper fight's untouched record (Bone Ward absorption
  // excluded), and Untouched by Iron during the Maw encounter.
  function playerHit(payload) {
    if (!hpLost(payload)) return;
    for (const fight of fights.values()) fight.untouched = false;
    if (ctx.run?.quarryState === "active") maw.untouched = false;
  }

  // Keepers (the Wave-1 Maw and Warden included): records and masteries from the fight, the
  // keeper milestones, and the shades of the Crown Unmade.
  function onBoss({ kind, event, n } = {}) {
    if (!KEEPERS[kind]) return;
    const run = ctx.run;
    if (event === "spawn") {
      fights.set(kind, { t0: run?.elapsed ?? 0, untouched: true });
      if (kind === "ironmaw") maw.untouched = true;
    } else if (event === "shade") shades = Math.max(shades, Number(n) || 0);
    else if (event === "unmade") award("unmade");
    else if (event === "defeat") keeperFell(run, kind);
  }

  function keeperFell(run, kind) {
    const fight = fights.get(kind);
    const live = run?.keeper?.id === kind ? run.keeper : null;
    const seconds = run?.flags?.keeperTimes?.[kind] ?? (fight && run ? run.elapsed - fight.t0 : undefined);
    keeperRecord(kind, { seconds, untouched: (live ?? fight)?.untouched === true });
    if (live?.stats) keeperMastery(kind, live.stats);
    if (kind === "ironmaw") mawDefeated();
    else if (kind === "warden") award("warden");
    else award("keeper:" + kind);
    fights.delete(kind);
  }

  // Crownbreaker progress at the moment a chain reaches a tier.
  function onChain({ event, count } = {}) {
    if (event !== "tier" || !enabled() || !(count > data.mastery.chainBest)) return;
    data.mastery.chainBest = Math.min(DEFEAT_CAP, count);
    progressed();
    requestSave(EVENT_SAVE_MS);
  }

  function onStorage(event) {
    if (!persistent || event.key !== KEYS.profile || !event.newValue) return;
    let raw;
    try {
      raw = JSON.parse(event.newValue);
    } catch {
      return;
    }
    absorb(raw);
    applyCosmetics();
    if (ctx.overlay === "#profile") ctx.journal?.render?.();
  }

  const bus = ctx.bus;
  bus.on("runStart", (p) => beginRun(p?.run ?? ctx.run));
  bus.on("enemySpawn", (p) => sighted(p?.e));
  bus.on("enemyKilled", (p) => killed(p?.e, p?.source));
  bus.on("elite", (p) => p?.event === "spawn" && (p.affixes ?? eliteIds(p.e)).forEach((id) => recordAffix(id)));
  bus.on("relic", (p) => recordRelic(p?.id));
  bus.on("prop", (p) => recordHazard(p?.kind));
  bus.on("playerHit", playerHit);
  bus.on("playerDrain", () => fights.forEach((fight) => (fight.untouched = false)));
  bus.on("boss", onBoss);
  bus.on("chain", onChain);
  bus.on("trial", (p) => p?.state === "complete" && award("trial"));
  bus.on("milestone", (p) => award(p?.key));
  bus.on("discovery", (p) => recordDiscovery(p?.id));
  bus.on("runEnd", (p) => completeRun({ id: p?.run?.id, outcome: p?.outcome }));

  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", flushPending);
  document.addEventListener("visibilitychange", () => document.hidden && flushPending());

  if (persistent && stored === null) importLegacy();
  applyCosmetics();

  return {
    data,
    get saved() {
      return saved;
    },
    persistent,
    enabled,
    save,
    award,
    recordEnemy,
    recordAffix,
    recordHazard,
    recordRelic,
    keeperRecord,
    recordWeaponKill,
    recordDiscovery,
    trackMastery,
    completeRun,
    rememberRun,
    compare,
    cosmetics,
    applyCosmetics,
    bestiary,
    masteryEntries,
    trackedGoal: () => masteryEntries().find((e) => e.tracked) || null,
    get lastName() {
      return data.lastUsername;
    },
    set lastName(value) {
      const name = cleanName(value);
      if (name === data.lastUsername) return;
      data.lastUsername = name;
      save();
    },
    importLegacy,
    previewCosmetics,
  };
}
