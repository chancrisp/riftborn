// Monster spawning and AI for the ordinary and Death Mode roster (spec enemies.md §4–§8, §12–§13)
// and the KEEPERS creatures (IMPROVEMENTS F7: Drowned, Ashworm, Lamplighter). This module owns
// run.enemies and every actor's lifecycle: placement and scaling, the arrival rise, hit flash and
// squash, crowd separation, stun, the death collapse and cleanup. Bosses and keepers share the
// record, the per-step prologue and the lifecycle; their state machines live in bosses.js, and
// the elite affixes in elites.js.
//
// ORIGINAL runs take the Wave-1 paths verbatim (uniform pool, Wave-1 speeds, no creatures, no
// elites); every KEEPERS rule below checks run.original first.
import * as THREE from "three";
import { DEATH_TYPES, ENEMY_TYPES, MAX_HOSTILES, WALK_CAP, typeOf, enemyPool } from "../data/enemies.js";
import { defOf } from "../data/defs.js";
import { stageDef } from "../data/stages.js";
import { eyeColor } from "../data/palettes.js";
import { weightedPick } from "../core/rng.js";
import { createMonster, animateCharacter, setFlash, setEyes, collapseModel, disposeModel } from "../render/models.js";
import { swellBelly, poseAshworm, glowLantern, createCageField } from "../render/models-creatures.js";
import { unlitMaterial } from "../render/materials.js";
import { STEP } from "../core/clock.js";
import { clamp } from "../core/util.js";
import { turnToward } from "./logic/keepers.js";
import { windupOf } from "./logic/elites.js";

// Lifecycle.
const SPAWN_GRACE = 0.4; // arrival freeze: visible and hittable, but no movement, attack or contact
const SPAWN_RING = "#bda3ff";
const RISE_DEPTH = 1.6; // an arrival starts this far underground (x its model's height scale)
const RISE_POSES = 6; // held poses over the grace: 15 fps stop-motion
const COLLAPSE_TIME = 0.3;
const HIT_TIME = 0.12; // hit reaction length; combat.hurtEnemy sets e.flash to this
const REDUCED_FLASH = 0.5; // Reduce flashes: one frame at half strength (F17)
const DEFAULT_SQUASH = 0.5;
const BOSS_COOLDOWN = Object.freeze({ warden: 2.5, ironmaw: 1.5 });
const KEEPER_COOLDOWN = 1.5;
const KEEPER_STAGGER = 0.8; // a stun on a keeper becomes this stagger (F1.4d)
const TUTORIAL_STATS = Object.freeze({ hp: 24, speed: 1, damage: 3, score: 0, xp: 0 });
const SPLIT_CHILD_HP = 0.45;
const SPLIT_MIN_STAGE = 3;
const BROOD_CAP = 8; // living skitters on the whole field, not only this mother's brood (original)
const ORIGIN = Object.freeze({ x: 0, z: 0 });
const THREAT_EYES = 2.5; // eye scale when threat eyes are on (F17)
const SUMMON_MARK = Object.freeze({ tube: 0.1, lift: 0.12, scale: 1.25 });

// Movement.
const CONTACT_REACH = 0.48; // player radius 0.45 plus the original's 0.03 slack
const DIRECT_RANGE = 3; // ordinary kinds walk straight at the player inside this
// The original steering eased into every 2 m nav node and staircased along a 4-connected grid,
// so pursuit closed only ~0.48 m per metre of stated speed; the rebuilt look-ahead steering
// closes ~0.91. Flow-field pursuit is paced back so monsters press the player as they did.
const CHASE_PACE = 0.53;
const WAVE_SPEED = 0.025;
const WAVE_SPEED_CAP = 10;
const KITERS = new Set(["gunner", "mortar", "sniper"]);
const KITE_NEAR = 8;
const KITE_FAR = 18;

// Crowd separation (Wave-1): overlapping bodies drift apart, heavier bodies move less, bosses
// and monsters committed to an attack are immovable so their telegraphs stay true.
const SPACING = 0.9; // fraction of the summed radii that counts as touching
const SEPARATION_RATE = 0.35; // share of the overlap resolved per step
const SEPARATION_MAX = 0.06; // metres per step, so a crush never teleports anyone

// Attacks.
const MUZZLE_HEIGHT = 1.47; // x model height scale
const CHEST_HEIGHT = 1.2;
const BLAST_HEIGHT = 0.5; // creature blasts go off this far above the ground (as combat's)
const ARTILLERY_RANGE = 26; // Wave-1 cap for Mortar shells and Hexer crosses
const SALVO_CUE = 0.35; // the cue ring appears once the cooldown is this close to ready
const SALVO_LEAD = 0.25; // and must show at least this long before the volley
const SALVO_TICK = 0.1;
const SALVO_RADIUS = 1.8;
const SALVO = Object.freeze({
  gunner: Object.freeze({ range: KITE_FAR, warn: "warnAim" }),
  stormer: Object.freeze({ range: Infinity, warn: "warnRing" }),
});
const CHARGER_WINDUP = 0.85;
const CHARGE_TIME = 0.68;
const CHARGE_SPEED = 18;
const CHARGE_CONTACT = 24;
const LEAP_WINDUP = 0.75;
const LEAP_TIME = 0.6;
const LEAP_SPEED = 25;
const LEAP_HEIGHT = 3;
const LEAP_RADIUS = 3.6;
const LEAP_TICK = 0.1;
const SNIPE_TIME = 0.95;
const SNIPE_RANGE = 42;
const RUSH_TIME = 0.38;
const RUSH_SPEED = 16;
const BRUTE_SLAM = 0.95;
const DEATH_WINDUP = Object.freeze({ revenant: 0.55, hexer: 1, broodmother: 1.2 });
const HEX_CROSS = Object.freeze([
  [0, 0],
  [-2.5, 0],
  [2.5, 0],
  [0, -2.5],
  [0, 2.5],
]);
const AIM_WIDTH = 0.085;
const MARKER_OPACITY = 0.72;
const FADED = Object.freeze({ opacity: 0.3 });
const WINDUP_RING = "#d75b76";
const LABEL_GREY = "#b4b2a6"; // EXPOSED / INTERRUPTED call-outs

// Enemy rounds (weapon-shaped for combat.projectile).
const SPIT = Object.freeze({ color: "#c1cb6f", damage: 11, speed: 10, range: 26, pierce: 0 });
const SNIPE = Object.freeze({ color: "#cd85a8", damage: 29, speed: 24, range: 42, pierce: 0 });
const STORM = Object.freeze({ color: "#7db3ff", damage: 10, speed: 9, range: 18, pierce: 0 });

// Predicted rush corridors: base speed and duration (x tuning x curse; the Void Wake slow is
// not predicted, as in the original).
const LANES = Object.freeze({
  charger: Object.freeze({ speed: CHARGE_SPEED, duration: CHARGE_TIME }),
  revenant: Object.freeze({ speed: RUSH_SPEED, duration: RUSH_TIME }),
});

// ---- KEEPERS creatures (F7) -------------------------------------------------------------------

const DROWNED = Object.freeze({
  swellAt: 3.0, // it stops and swells inside this distance
  swell: 0.75,
  radius: 3.2,
  player: 20,
  monsters: 55,
  pop: 0.35, // a Drowned killed while walking pops this long after its death
  silt: Object.freeze({ radius: 2.4, life: 4, slow: 0.7 }),
  drip: 0.4,
  color: "#a4b236",
});
const ASHWORM = Object.freeze({
  start: 1.5, // e.cooldown on arrival
  breachAt: 6, // breaches inside this with its cooldown ready...
  burrowMax: 6, // ...or after this long underground
  lead: 0.35, // the breach locks onto where the player is heading
  breach: 1.0,
  travel: 9, // m/s of the mound toward the locked target
  emerge: 0.3, // the arch rises over the breach's last 0.3 s
  radius: 2.2,
  damage: 22,
  surface: 2.4,
  vuln: 1.25,
  turn: 4,
  cueAt: 0.8,
  cue: 0.3,
  cueRadius: 1.2,
  fan: Object.freeze([0, -0.17, 0.17]),
  dive: 0.4,
  diveHittable: 0.2,
  rest: 3.5, // e.cooldown after a dive
  embers: 4, // ember particles per second while burrowed
  wakeStep: 0.5,
  wake: Object.freeze({ color: "#3a2f36", size: 0.6, life: 3 }),
});
const EMBER = Object.freeze({ color: "#ff9a5c", damage: 10, speed: 11, range: 16, pierce: 0 });
const LAMP = Object.freeze({
  start: 1.5,
  near: 10, // kiting band
  far: 20,
  retreat: 0.8,
  allyReach: 9, // walks toward the nearest ally when none is this close
  flare: Object.freeze({ reach: 6, windup: 0.5, radius: 4, damage: 12, cooldown: 6, first: 2 }),
  ward: Object.freeze({ reach: 10, channel: 0.8, targets: 3, shell: 0.35, life: 8, interrupt: 0.25, cooldown: 5, broken: 2.5, cast: 1.0 }),
  oil: Object.freeze({ min: 8, max: 20, windup: 0.6, radius: 1.8, fuse: 1.1, damage: 14, cooldown: 3, peak: 4 }),
  light: "#9fe8ff",
  spark: "#d8faff",
  beamWidth: 0.2,
  cage: 1.4, // cage radius / ally radius
});
const HOME_STAGE = Object.freeze({ drowned: 2, ashworm: 3, lamplighter: 4 }); // ?practice=creatures

// Readable player-damage causes. Labels lead with the Bestiary name so the run report can find
// the matching hint; hazard causes keep the original hazard ids (slam, mortar, leap, hex).
const cause = (id, label) => Object.freeze({ id, label });
const SOURCES = Object.freeze({
  runner: Object.freeze({ contact: cause("runner", "Restless claws") }),
  skitter: Object.freeze({ contact: cause("skitter", "Skitter bite") }),
  gunner: Object.freeze({ contact: cause("gunner", "Spitter claws"), shot: cause("gunner", "Spitter bile") }),
  charger: Object.freeze({ contact: cause("charger", "Charger horns"), rush: cause("charger", "Charger rush") }),
  brute: Object.freeze({ contact: cause("brute", "Brute claws"), slam: cause("slam", "Brute slam") }),
  mortar: Object.freeze({ contact: cause("mortar", "Mortar claws"), shell: cause("mortar", "Mortar shell") }),
  sniper: Object.freeze({ contact: cause("sniper", "Sniper claws"), shot: cause("sniper", "Sniper round") }),
  leaper: Object.freeze({ contact: cause("leaper", "Leaper claws"), landing: cause("leap", "Leaper landing") }),
  splitter: Object.freeze({ contact: cause("splitter", "Splitter claws") }),
  stormer: Object.freeze({ contact: cause("stormer", "Stormer claws"), shot: cause("stormer", "Stormer burst") }),
  revenant: Object.freeze({ contact: cause("revenant", "Revenant claws"), rush: cause("revenant", "Revenant rush") }),
  hexer: Object.freeze({ contact: cause("hexer", "Hexer claws"), cross: cause("hex", "Hexer cross") }),
  broodmother: Object.freeze({ contact: cause("broodmother", "Broodmother claws") }),
  drowned: Object.freeze({ contact: cause("drowned", "Drowned grasp"), burst: cause("drowned", "Drowned burst") }),
  ashworm: Object.freeze({ contact: cause("ashworm", "Ashworm bite"), breach: cause("ashworm", "Ashworm breach"), ember: cause("ashworm", "Ashworm ember") }),
  lamplighter: Object.freeze({ contact: cause("lamplighter", "Lamplighter claws"), flare: cause("lamplighter", "Lamplighter flare"), oil: cause("lamplighter", "Lamp oil") }),
});
const FALLBACK_CONTACT = cause("monster", "Monster claws");
const SILT = cause("Silt", "Silt");
// The Drowned's own burst: a death that scores and counts for the stage, with no weapon, drops
// or chain credit (F7).
const SELF_BURST = Object.freeze({ kind: "self", environment: true, weapon: -1 });

const TUTORIAL_DEFS = Object.freeze(
  Object.fromEntries(Object.entries(ENEMY_TYPES).map(([kind, def]) => [kind, Object.freeze({ ...def, ...TUTORIAL_STATS })])),
);

const isBoss = (e) => !!(e.boss || e.miniboss);
const isWarden = (e) => e.boss === "warden" || e.kind === "warden";
const clockOf = (r) => r.elapsed || 0;

// Whether shots, explosions and targeting may touch `e` (a burrowed Ashworm may not, F7).
// Shared with combat.js (scanBodies, explode, targets).
export const isHittable = (e) => !!e && !e.untargetable;

// Whether a death (or any damage) came from the player: a weapon, or a source the player set off
// (props, relic zones, beacon flares, player-caused pops). A Drowned's blast never passes it on:
// the Drowned it pops are not the player's (F7, F11).
export const playerCaused = (source) =>
  !!source && source.kind !== "self" && source.kind !== "drowned" && ((Number.isInteger(source.weapon) && source.weapon >= 0) || source.player === true);

// The walk of every KEEPERS non-keeper monster, capped (IMPROVEMENTS §1.4); slows apply after.
export const cappedWalk = (speed) => Math.min(speed, WALK_CAP);

let summonRingGeometry = null;
const summonRing = () => (summonRingGeometry ??= new THREE.TorusGeometry(1, SUMMON_MARK.tube, 6, 28));

export function createEnemies(ctx) {
  // Every actor spawned here and not yet freed: the living, the collapsing, and a slain Warden
  // kept for its victory sequence.
  const tracked = [];
  const fuses = []; // delayed creature blasts (Drowned pops, elite death bursts)
  const caged = []; // monsters under a Lamplighter ward
  const cageDraw = []; // reused { x, z, radius } rows for the cage field
  let cages = null;
  const steerOut = { x: 0, z: 0 };
  const lanePoint = { x: 0, z: 0 };
  const traceFrom = { x: 0, y: 0, z: 0 };
  const traceTo = { x: 0, y: 0, z: 0 };
  const losFrom = { x: 0, y: 0, z: 0 };
  const losTo = { x: 0, y: 0, z: 0 };
  const beamFrom = { x: 0, y: 0, z: 0 };
  const beamTo = { x: 0, y: 0, z: 0 };
  const viewPoint = { x: 0, y: 0, visible: false };
  const soundAt = { x: 0, z: 0, src: null };
  const progressOpts = { progress: 0 };
  const moveOpts = { x: 0, z: 0, opacity: MARKER_OPACITY };

  const terrain = () => ctx.world?.terrain ?? null;
  const ground = (x, z) => ctx.world?.height?.(x, z) ?? 0;
  const keepers = (r) => !!r && !r.original;
  const voice = (e) => ctx.audio?.voice?.(e);
  const hurtPlayer = (amount, source) => ctx.player?.hurt?.(amount, source);
  // Spawn cells the camera cannot see are preferred (world §6.6 polish).
  const onScreen = (x, z) => !!ctx.cam?.project && ctx.cam.project(x, ground(x, z) + 1, z, viewPoint).visible;
  // The AI pass may continue only while its run is current and still simulating (as the
  // director's own gate): a player death or a cinematic stops it mid-list.
  const playing = (r) => ctx.run === r && !r.over && (ctx.mode === "play" || (r.demo && !ctx.demo?.finished));

  // Panned, captioned effect at an actor or point; `src` names the emitter for captions (F17).
  function sfx(name, at, volume = 1, src = at?.kind ?? null) {
    soundAt.x = at?.x ?? 0;
    soundAt.z = at?.z ?? 0;
    soundAt.src = src;
    ctx.audio?.fx?.(name, volume, soundAt);
  }

  // Named run streams (F14.1): placement and kind picks draw "spawn", AI jitter "ai". Under
  // ORIGINAL every name is the Wave-1 generator, so the draws keep their Wave-1 order.
  function stream(name) {
    const r = ctx.run;
    const random = r?.stream?.(name) ?? r?.rng;
    return typeof random === "function" ? random : Math.random;
  }
  const roll = (a, b) => a + stream("ai")() * (b - a);

  function difficultyScale() {
    const direct = ctx.director?.difficultyScale?.();
    return Number.isFinite(direct) ? direct : 1 + (ctx.run?.difficultyBonus || 0) / 100;
  }
  function spawnHpFactor(r) {
    const direct = ctx.director?.spawnHpFactor?.();
    if (Number.isFinite(direct)) return direct;
    return (1 + ((r.stage || 1) - 1) * 0.22 + Math.min((r.wave || 1) - 1, 20) * 0.05) * difficultyScale();
  }
  function speedScale() {
    const direct = ctx.director?.speedScale?.();
    return Number.isFinite(direct) ? direct : 1;
  }
  // Shared by every enemy movement: Death Mode tuning and the curse (ORIGINAL: the full curse
  // bonus; KEEPERS: the capped speed term, §1.4).
  const threat = () => (ctx.run?.tuning?.speed ?? 1) * (keepers(ctx.run) ? speedScale() : difficultyScale());
  // Contact, slam and leap landing damage under the ledger (Omen of Teeth).
  const contactMul = (r) => (keepers(r) ? (ctx.rules?.mul?.("enemyContact") ?? 1) : 1);
  // Movement slow: Void Wake alone under ORIGINAL; wake, zones and frost under KEEPERS.
  const slow = (e) => (keepers(ctx.run) ? slowMul(e) : (ctx.mods?.slow?.(e) ?? 1));

  function walkSpeed(e, r) {
    const wave = clamp((r.wave || 1) - 1, 0, WAVE_SPEED_CAP);
    let speed;
    if (keepers(r)) {
      const walk = e.def.speed * threat() * (ctx.rules?.mul?.("enemySpeed") ?? 1) * (e.walkMul ?? 1) * (1 + wave * WAVE_SPEED);
      speed = cappedWalk(walk) * slow(e);
    } else speed = e.def.speed * threat() * slow(e) * (1 + wave * WAVE_SPEED);
    if (e.kind === "runner") speed *= 0.8 + 0.2 * Math.sin(clockOf(r) * 5 + e.phase); // lurch 0.6..1.0
    return speed;
  }

  // Elite multipliers (F8) apply wherever an AI resets its cooldown or starts a windup.
  function setCooldown(e, seconds) {
    e.cooldown = e.cooldownMul ? seconds * e.cooldownMul : seconds;
  }
  function windup(e, seconds) {
    e.windupLen = windupOf(seconds, e.windupMul);
    return e.windupLen;
  }

  // A cause with the attacker's position, so the hurt ring can point at it (F16.4).
  const sourceAt = (base, x, z) => ({ id: base.id, label: base.label, x, z });

  // ---- spawning ---------------------------------------------------------------------------------

  // Tutorial stand-ins, keepers from data/keepers.js (via defOf), the Wave-1 kinds as typeOf
  // (so "warden"/"ironmaw" keep their Wave-1 stats outside keeper spawns), then the creatures.
  function defFor(kind, r, keeper) {
    if (r.tutorial && TUTORIAL_DEFS[kind]) return TUTORIAL_DEFS[kind];
    return keeper ? defOf(kind) : (typeOf(kind) ?? defOf(kind));
  }

  // ORIGINAL keeps the Wave-1 uniform pick; KEEPERS draws the weighted pool with its creatures.
  function pickKind(r) {
    const random = stream("spawn");
    const entries = enemyPool(stageDef(r.stage).pool, !!r.death, r.stage || 1, { original: !keepers(r), stageKills: r.stageKills || 0 });
    if (!keepers(r)) return entries[Math.min(entries.length - 1, Math.floor(random() * entries.length))][0];
    return weightedPick(random, entries);
  }

  function nextId(r) {
    if (!Number.isFinite(r.nextId)) r.nextId = 1;
    return r.nextId++;
  }

  // Descendants (splitter children, brood summons) of a marked trial monster join its roster.
  function inheritTrial(parent, child) {
    const trial = ctx.run?.trial;
    if (!trial || trial.state !== "active" || !parent.trialId || parent.trialId !== trial.id) return;
    child.trialId = trial.id;
    trial.descendant?.(parent.id, child.id);
  }

  function keeperHp(kind, def) {
    const hp = ctx.bosses?.keeperHp?.(kind);
    return Number.isFinite(hp) && hp > 0 ? hp : def.hp * (ctx.director?.hpScale?.() ?? difficultyScale());
  }

  // A keeper's summons wear a torus in the keeper's mark colour at their feet.
  function markSummon(e, color) {
    const mark = new THREE.Mesh(summonRing(), unlitMaterial(color));
    mark.position.y = SUMMON_MARK.lift;
    mark.scale.setScalar(SUMMON_MARK.scale);
    mark.rotation.x = Math.PI / 2;
    (e.model.parts?.torusSlot ?? e.model.g).add(mark);
  }

  // Threat eyes (F17): the class, affix or trial colour from the palette at x2.5, or the authored
  // eyes when threat eyes are off.
  function paintEyes(e, restore = false) {
    const color = eyeColor(e.kind, e);
    if (color || restore) setEyes(e.model, color, color ? THREAT_EYES : 1);
  }

  // kind: any ENEMY_TYPES/DEATH_TYPES/EXTRA_TYPES kind, "warden", "ironmaw" or a keeper id (random
  // from the stage pool when omitted). near: {x, z} snapped to the nearest walkable nav node;
  // otherwise an ambient cell 17–26 m from the player, off screen when possible. opts:
  //   hpScale = 1        HP multiplier
  //   parent             a parent's trial membership passes to the child before anything else
  //   keeper             a keeper (F1.3): keeper stats and HP, no arrival freeze, run by bosses.js
  //   ambient, surge     a director spawn: it may roll an elite (F8)
  //   summonedBy         the summoning keeper's id (never elite; scored as a summon, F11)
  //   mark               a torus colour for summons
  //   bypassCap          summons that ignore the keeper's live cap (the cap lives with callers)
  //   elite, partner     a given elite roll { affixes, extra } (practice, a BOUND partner)
  function spawn(kind = null, near = null, opts = {}) {
    const r = ctx.run,
      t = terrain();
    if (!r || !t) return null;
    if (!Array.isArray(r.enemies)) r.enemies = [];
    const { hpScale = 1, parent = null, keeper = false, ambient = false, surge = false, summonedBy = null, mark = null, elite = null, partner = null } = opts || {};
    kind ||= pickKind(r);
    const def = defFor(kind, r, keeper);
    if (!def) return null;
    const player = r.player ?? ORIGIN;
    const at = near ? t.safeNear(near.x, near.z, def.radius) : t.spawn(player.x, player.z, def.radius, stream("spawn"), onScreen);
    if (!at) return null;
    const boss = keeper || kind === "warden" || kind === "ironmaw" ? kind : null;
    const hp = keeper ? keeperHp(kind, def) : def.hp * (boss === "ironmaw" ? difficultyScale() : spawnHpFactor(r)) * hpScale;
    const startCooldown = roll(1, 2.5);
    const phase = roll(0, 10);
    const model = createMonster(kind, { death: !!r.death });
    const grace = boss ? 0 : SPAWN_GRACE;
    const e = {
      id: nextId(r),
      kind,
      def,
      x: at.x,
      z: at.z,
      y: 0,
      vx: 0,
      vz: 0,
      yaw: Math.atan2(player.x - at.x, player.z - at.z),
      hp,
      max: hp,
      radius: def.radius,
      state: "approach",
      timer: 0,
      cooldown: keeper ? (BOSS_COOLDOWN[kind] ?? KEEPER_COOLDOWN) : boss ? BOSS_COOLDOWN[boss] : startCooldown,
      phase,
      model,
      boss,
      keeper: keeper ? kind : null,
      miniboss: boss === "ironmaw",
      fixed: false,
      trialId: null,
      trialElite: false,
      summonedBy,
      grace,
      graceLen: grace,
      flash: 0,
      squash: DEFAULT_SQUASH,
      marker: null,
      dead: false,
      lastSource: null,
      // Wave-2 state: stun (F1.4d), burrowing (F7), ward shells (F7, F8).
      stunned: 0,
      untargetable: false,
      walk: 0,
      // AI working state (committed attack direction, aim point, cue clocks).
      ax: 0,
      az: 1,
      tx: 0,
      tz: 0,
      attackPitch: 0,
      windupLen: 0,
      cueElapsed: 0,
      cueTick: 0,
      landingTick: 0,
      attackIndex: 0,
      enraged: false,
      recovery: 0,
      // Lifecycle bookkeeping.
      shadow: null,
      removed: false,
      deathHandled: false,
      dying: -1,
      sepX: 0,
      sepZ: 0,
    };
    ctx.gfx?.layers?.actors?.add(model.g);
    r.enemies.push(e);
    tracked.push(e);
    if (parent) inheritTrial(parent, e);
    if (mark) markSummon(e, mark);
    CREATURES[kind]?.onSpawn(e);
    // Elites (F8): an ambient spawn may roll one; a given roll (practice, a BOUND partner) is
    // applied as it is. Both stay out of keeper spawns and summons.
    if (!keeper && !summonedBy) {
      const rolled = elite ?? (ambient ? ctx.elites?.roll?.(kind, { ambient, surge }) : null);
      if (rolled) ctx.elites?.apply?.(e, rolled, partner);
    }
    paintEyes(e);
    model.g.position.set(e.x, ground(e.x, e.z) - (e.grace > 0 ? riseDepth(e) : 0), e.z);
    model.g.rotation.y = e.yaw;
    CREATURES[kind]?.animate?.(e, clockOf(r) + e.phase, 0); // the Ashworm arrives as its mound
    e.shadow = ctx.fx?.shadow?.(model.g, e.def.radius) ?? null;
    ctx.fx?.ring?.(e.x, e.z, SPAWN_RING, 1.5, 0.45);
    if (e.grace > 0) ctx.fx?.burst?.(e.x, 0.2, e.z, SPAWN_RING, 5, 1.6);
    ctx.bus?.emit("enemySpawn", { e });
    return e;
  }

  // ---- telegraphs -------------------------------------------------------------------------------

  // Telegraph registry meta (F16.2): the owner, its windup and when it started.
  const meta = (e, eta) => ({ owner: e.id, eta, started: clockOf(ctx.run ?? {}), targetsPlayer: true });

  function liveMarker(e) {
    if (e.marker?.dead) e.marker = null; // cleared wholesale (e.g. tele.clear() at a sequence)
    return !!e.marker;
  }

  function clearWarning(e) {
    if (!e?.marker) return;
    ctx.tele?.remove?.(e.marker);
    e.marker = null;
  }

  function setProgress(e, value) {
    if (!liveMarker(e)) return;
    progressOpts.progress = clamp(value, 0, 1);
    ctx.tele.set(e.marker, progressOpts);
  }

  // Moving a marker also restores its full opacity, as the original's per-tick rebuild did.
  function moveMarker(e, x, z) {
    moveOpts.x = x;
    moveOpts.z = z;
    ctx.tele?.set?.(e.marker, moveOpts);
  }

  function fadeMarker(e) {
    if (liveMarker(e)) ctx.tele.set(e.marker, FADED);
  }

  // An area marker owned by `e` (replacing any other it had).
  function warnArea(e, x, z, radius, kind, eta) {
    clearWarning(e);
    e.marker = ctx.tele?.area?.(x, z, radius, kind, meta(e, eta)) ?? null;
  }

  // Runs the real movement solver in fixed steps along (ax, az), so a drawn corridor bends and
  // slides along terrain exactly as the rush will. `points` (optional) collects [x, z] pairs.
  // Returns the end point (shared, valid until the next call).
  function trackLane(e, speed, duration, points = null) {
    const p = lanePoint,
      t = terrain();
    p.x = e.x;
    p.z = e.z;
    points?.push([p.x, p.z]);
    if (!t) return p;
    const steps = Math.ceil(duration / STEP - 1e-6);
    for (let i = 0; i < steps; i++) {
      const dt = Math.min(STEP, duration - i * STEP);
      t.move(p, e.ax * speed * dt, e.az * speed * dt, e.radius);
      points?.push([p.x, p.z]);
    }
    return p;
  }

  // Sniper line: locks the shot pitch at the player's chest and shortens the drawn line to the
  // first terrain or cover hit along the real 3D shot.
  function sniperSpan(e, length) {
    const p = ctx.run?.player ?? ORIGIN,
      y = ground(e.x, e.z) + MUZZLE_HEIGHT * e.model.g.scale.y;
    e.attackPitch = Math.atan2(ground(p.x, p.z) + CHEST_HEIGHT - y, Math.hypot(p.x - e.x, p.z - e.z));
    const c = Math.cos(e.attackPitch);
    traceFrom.x = e.x;
    traceFrom.y = y;
    traceFrom.z = e.z;
    traceTo.x = e.x + e.ax * length * c;
    traceTo.y = y + length * Math.sin(e.attackPitch);
    traceTo.z = e.z + e.az * length * c;
    return length * c * (ctx.world?.trace?.(traceFrom, traceTo)?.t ?? 1);
  }

  // The original warnLine: a rush corridor for rushing kinds (length ignored), otherwise a thin
  // aim line of `length` metres along (ax, az).
  function warnLine(e, length) {
    clearWarning(e);
    const lane = LANES[e.kind];
    if (lane) {
      const points = [];
      trackLane(e, lane.speed * threat(), lane.duration, points);
      e.marker = ctx.tele?.path?.(points, e.radius, "charge", meta(e, e.windupLen)) ?? null;
      sfx("warnCharge", e);
    } else {
      const span = e.kind === "sniper" ? sniperSpan(e, length) : length;
      e.marker = ctx.tele?.line?.(e.x, e.z, Math.atan2(e.ax, e.az), span, AIM_WIDTH, "aim", meta(e, e.windupLen)) ?? null;
      sfx("warnAim", e);
    }
  }

  // Leaper landing circle at the end of the predicted leap; moved (not rebuilt) on re-prediction.
  function warnLanding(e, duration = LEAP_TIME) {
    const end = trackLane(e, LEAP_SPEED * threat() * slow(e), duration);
    if (liveMarker(e)) moveMarker(e, end.x, end.z);
    else e.marker = ctx.tele?.area?.(end.x, end.z, LEAP_RADIUS, "leap", meta(e, e.windupLen + LEAP_TIME)) ?? null;
  }

  // ---- attacks ----------------------------------------------------------------------------------

  function lockAim(e, nx, nz) {
    e.ax = nx;
    e.az = nz;
  }

  // Enemy rounds leave from the monster's muzzle height (or `y`); combat aims them at the
  // player's chest unless a pitch is given. The cause carries the firing position.
  function shoot(e, yaw, weapon, base, pitch, y) {
    const opts = { emitter: e, source: sourceAt(base, e.x, e.z), y: y ?? ground(e.x, e.z) + MUZZLE_HEIGHT * e.model.g.scale.y };
    if (pitch !== undefined) opts.pitch = pitch;
    ctx.combat?.projectile?.(e.x, e.z, yaw, weapon, true, opts);
  }

  // Delayed ground blast owned by the monster's trial (for cleanup), carrying a readable cause
  // centred on the blast.
  function hazard(e, x, z, radius, damage, delay, kind, base) {
    ctx.combat?.hazard?.(x, z, radius, damage, delay, kind, e.trialId ?? null, sourceAt(base, x, z));
  }

  // One attack check per kind, in the approach state (spec §6).
  const ATTACKS = {
    // Telegraphed straight rush.
    charger(e, d, nx, nz) {
      if (!(d < 12 && d > 3 && e.cooldown < 0)) return;
      e.state = "windup";
      e.timer = windup(e, CHARGER_WINDUP);
      lockAim(e, nx, nz);
      e.yaw = Math.atan2(nx, nz);
      ctx.fx?.ring?.(e.x, e.z, "#ff5656", 2, e.timer);
      warnLine(e, 12);
    },
    // Delayed close slam; stands still until it lands.
    brute(e, d, nx, nz, r) {
      if (!(d < 3.8 && e.cooldown < 0)) return;
      voice(e);
      const delay = windup(e, BRUTE_SLAM);
      hazard(e, e.x, e.z, 4.2, 25 * contactMul(r), delay, "slam", SOURCES.brute.slam);
      setCooldown(e, 3.5);
      e.timer = delay;
    },
    // Artillery at the player's predicted position.
    mortar(e, d, nx, nz, r) {
      if (!(e.cooldown < 0 && d < ARTILLERY_RANGE)) return;
      const p = r.player;
      hazard(e, p.x + (p.vx || 0) * 0.25, p.z + (p.vz || 0) * 0.25, 2.5, 21, 1.35, "mortar", SOURCES.mortar.shell);
      setCooldown(e, 3.1);
      sfx("mortar", e);
    },
    // Three-shot fan after the salvo cue.
    gunner(e, d, nx, nz) {
      if (!(d < KITE_FAR && e.cooldown < 0 && e.cueElapsed >= SALVO_LEAD)) return;
      voice(e);
      const yaw = Math.atan2(nx, nz);
      for (let i = -1; i <= 1; i++) shoot(e, yaw + i * 0.17, SPIT, SOURCES.gunner.shot);
      setCooldown(e, 1.8);
      clearWarning(e);
      ctx.fx?.burst?.(e.x, 1.3, e.z, "#ffe484", 6, 1);
    },
    // Long telegraphed shot along a locked line.
    sniper(e, d, nx, nz) {
      if (!(d > 8 && d < 32 && e.cooldown < 0)) return;
      e.state = "snipe";
      e.timer = windup(e, SNIPE_TIME);
      lockAim(e, nx, nz);
      warnLine(e, SNIPE_RANGE);
    },
    // Eight radial shots, fired level (Wave-1) so off-axis shots neither dive nor overfly.
    stormer(e, d, nx, nz, r) {
      if (!(e.cooldown < 0 && e.cueElapsed >= SALVO_LEAD)) return;
      voice(e);
      const spin = clockOf(r) * 0.15;
      for (let i = 0; i < 8; i++) shoot(e, (i * Math.PI) / 4 + spin, STORM, SOURCES.stormer.shot, 0);
      setCooldown(e, 3.8);
      clearWarning(e);
      ctx.fx?.burst?.(e.x, 1.4, e.z, "#9fcbff", 13, 2);
    },
    // Windup, arcing leap and a landing blast.
    leaper(e, d, nx, nz) {
      if (!(d < 15 && e.cooldown < 0)) return;
      e.state = "windup";
      e.timer = windup(e, LEAP_WINDUP);
      lockAim(e, nx, nz);
      warnLanding(e);
      sfx("warnGround", e);
    },
  };

  // Gunner/Stormer cue ring: shown while the volley is imminent, following the monster on 0.1 s
  // ticks, its fill counting down to the volley.
  function salvoCue(e, dt, d, salvo) {
    if (e.cooldown > SALVO_CUE || d >= salvo.range) {
      clearWarning(e);
      e.cueElapsed = 0;
      e.cueTick = 0;
      return;
    }
    e.cueElapsed += dt;
    e.cueTick -= dt;
    if (e.cueTick <= 0) {
      e.cueTick = SALVO_TICK;
      if (liveMarker(e)) moveMarker(e, e.x, e.z);
      else {
        e.marker = ctx.tele?.area?.(e.x, e.z, SALVO_RADIUS, "ring", meta(e, SALVO_CUE)) ?? null;
        sfx(salvo.warn, e);
      }
    }
    const remaining = Math.max(SALVO_LEAD - e.cueElapsed, e.cooldown, 0);
    setProgress(e, e.cueElapsed / (e.cueElapsed + remaining));
  }

  // ---- movement ---------------------------------------------------------------------------------

  // Flow-field direction for agent `e` toward (tx, tz), paced beyond DIRECT_RANGE (see
  // CHASE_PACE). Returns a shared vector, valid until the next call.
  function steer(e, tx, tz) {
    const out = steerOut,
      t = terrain();
    if (!t) {
      out.x = out.z = 0;
      return out;
    }
    t.steer(e.x, e.z, tx, tz, e, out);
    const pace = Math.hypot(tx - e.x, tz - e.z) > DIRECT_RANGE ? CHASE_PACE : 1;
    out.x *= pace;
    out.z *= pace;
    return out;
  }

  function toward(nx, nz) {
    steerOut.x = nx;
    steerOut.z = nz;
    return steerOut;
  }

  function advance(e, t, distance) {
    t.move(e, e.ax * distance, e.az * distance, e.radius);
  }

  // Kiting band (F7 kite(e, lo, hi, retreatMul)): back off inside `lo`, hold to `hi`, close in
  // beyond it. Returns the walk factor along the bearing to the player.
  const kite = (d, lo, hi, retreat) => (d < lo ? -retreat : d < hi ? 0 : 1);

  // Walks `e` by `dir` along the bearing (nx, nz) to (tx, tz): the flow field when closing in from
  // beyond DIRECT_RANGE, straight otherwise. Returns the walk-animation speed.
  function walk(e, t, dt, speed, tx, tz, nx, nz, d, dir) {
    if (dir === 0) return 0;
    const v = dir > 0 && d > DIRECT_RANGE ? steer(e, tx, tz) : toward(nx, nz);
    t.move(e, v.x * dir * speed * dt, v.z * dir * speed * dt, e.radius);
    return Math.abs(dir);
  }

  // ---- ordinary kinds ---------------------------------------------------------------------------

  function snipe(e, dt) {
    e.timer -= dt;
    setProgress(e, 1 - e.timer / e.windupLen);
    if (e.timer > 0) return;
    voice(e);
    shoot(e, Math.atan2(e.ax, e.az), SNIPE, SOURCES.sniper.shot, e.attackPitch);
    e.state = "approach";
    setCooldown(e, 2.6);
    clearWarning(e);
  }

  // Charger and Leaper windup: stands still and jitters while the countdown fills (the charge
  // lane toward the rush, the landing circle toward the landing).
  function brace(e, dt, r) {
    const leaper = e.kind === "leaper",
      body = e.model.body;
    e.timer -= dt;
    body.rotation.z = e.model.lean + Math.sin(clockOf(r) * 40) * 0.035;
    setProgress(e, leaper ? (e.windupLen - e.timer) / (e.windupLen + LEAP_TIME) : 1 - e.timer / e.windupLen);
    if (e.timer > 0) return;
    body.rotation.z = e.model.lean; // the original left the Leaper's jitter tilt behind
    fadeMarker(e);
    e.state = leaper ? "leap" : "charge";
    e.timer = leaper ? LEAP_TIME : CHARGE_TIME;
    sfx("charge", e);
  }

  function charge(e, dt, t) {
    advance(e, t, CHARGE_SPEED * threat() * slow(e) * dt);
    e.timer -= dt;
    if (Math.random() < 0.4) ctx.fx?.burst?.(e.x, 0.5, e.z, "#ffb171", 2, 1); // cosmetic dust
    if (e.timer <= 0) {
      e.state = "approach";
      setCooldown(e, 3.5);
      clearWarning(e);
    }
    return 2;
  }

  function leap(e, dt, t, r) {
    advance(e, t, LEAP_SPEED * threat() * slow(e) * dt);
    e.timer -= dt;
    e.landingTick -= dt;
    if (e.landingTick <= 0) {
      e.landingTick = LEAP_TICK;
      warnLanding(e, Math.max(0, e.timer));
    }
    setProgress(e, 1 - e.timer / (e.windupLen + LEAP_TIME));
    if (e.timer <= 0) {
      clearWarning(e);
      hazard(e, e.x, e.z, LEAP_RADIUS, e.def.damage * 1.3 * contactMul(r), 0.35, "leap", SOURCES.leaper.landing);
      e.state = "approach";
      setCooldown(e, 3.5);
    }
    return 2;
  }

  // Attack check, then (unless an attack holds it) the kind's approach: kiting band, Skitter
  // weave, Stormer orbit. Returns the walk-animation speed.
  function approach(e, dt, r, t, d, nx, nz, speed) {
    const salvo = SALVO[e.kind];
    if (salvo) salvoCue(e, dt, d, salvo);
    ATTACKS[e.kind]?.(e, d, nx, nz, r);
    e.timer = Math.max(0, e.timer - dt);
    if (e.timer > 0) return 0;
    let dir = KITERS.has(e.kind) ? kite(d, KITE_NEAR, KITE_FAR, 0.7) : 1,
      strafe = 0;
    if (e.kind === "skitter" && d < 9) strafe = Math.sin(clockOf(r) * 3 + e.phase) * 0.9;
    else if (e.kind === "stormer" && d < 12) strafe = 0.65;
    if (e.kind === "stormer" && d < KITE_NEAR) dir = 0.15;
    e.yaw = Math.atan2(nx, nz);
    if (dir === 0 && strafe === 0) return 0;
    // Straight at the player when retreating or close; otherwise the flow field. The weave and
    // orbit are added unnormalised, as in the original.
    const v = dir > 0 && d > DIRECT_RANGE ? steer(e, r.player.x, r.player.z) : toward(nx, nz);
    t.move(e, (v.x * dir - nz * strafe) * speed * dt, (v.z * dir + nx * strafe) * speed * dt, e.radius);
    return Math.abs(dir);
  }

  function stepOrdinary(e, dt, r, t, d, nx, nz, speed) {
    let moving = 0;
    if (e.state === "snipe") snipe(e, dt);
    else if (e.state === "windup") brace(e, dt, r);
    else if (e.state === "charge") moving = charge(e, dt, t);
    else if (e.state === "leap") moving = leap(e, dt, t, r);
    else moving = approach(e, dt, r, t, d, nx, nz, speed);
    // Contact uses the distance measured before this step's movement (original).
    if (d < e.radius + CONTACT_REACH) hurtPlayer((e.state === "charge" ? CHARGE_CONTACT : e.def.damage) * contactMul(r), contactSource(e));
    e.y = e.state === "leap" ? Math.sin(clamp(e.timer / LEAP_TIME, 0, 1) * Math.PI) * LEAP_HEIGHT : 0;
    pose(e, r, moving);
  }

  // ---- Death Mode kinds (spec §8.0) -------------------------------------------------------------

  function inAttackRange(e, d) {
    if (e.kind === "revenant") return d < 13;
    if (e.kind === "hexer") return d < ARTILLERY_RANGE;
    return true;
  }

  function beginDeathWindup(e, r, nx, nz) {
    const p = r.player;
    voice(e);
    e.state = "deathWindup";
    e.timer = windup(e, DEATH_WINDUP[e.kind]);
    lockAim(e, nx, nz);
    e.tx = p.x + (p.vx || 0) * 0.3;
    e.tz = p.z + (p.vz || 0) * 0.3;
    if (e.kind === "revenant") warnLine(e, 9);
    else ctx.fx?.ring?.(e.x, e.z, WINDUP_RING, e.kind === "hexer" ? 2 : 3, e.timer);
  }

  function summonBrood(e, r) {
    let alive = 0;
    const list = r.enemies;
    for (let i = 0; i < list.length; i++) if (list[i].kind === "skitter" && list[i].hp > 0 && !list[i].removed) alive++;
    const count = Math.min(3, BROOD_CAP - alive);
    for (let i = 0; i < count && live() < MAX_HOSTILES; i++) spawn("skitter", { x: e.x + (i - 1) * 2, z: e.z + 2 }, { parent: e });
  }

  function resolveDeathWindup(e, r) {
    if (e.kind === "revenant") {
      e.state = "deathRush";
      e.timer = RUSH_TIME;
      fadeMarker(e);
      return;
    }
    if (e.kind === "hexer") {
      for (const [ox, oz] of HEX_CROSS) hazard(e, e.tx + ox, e.tz + oz, 1.65, 18, 0.75, "hex", SOURCES.hexer.cross);
      setCooldown(e, 3.8);
    } else {
      summonBrood(e, r);
      setCooldown(e, 6);
    }
    e.state = "approach";
    clearWarning(e);
  }

  // Revenant always chases; the Hexer backs off inside 7 m and orbits inside 14 m; the
  // Broodmother stops dead inside 6 m. Advancing uses the flow field at any distance.
  function deathApproach(e, dt, r, t, d, nx, nz, speed) {
    const dir = e.kind === "hexer" ? (d < 7 ? -0.65 : d < 14 ? 0 : 1) : e.kind === "broodmother" ? (d < 6 ? 0 : 1) : 1,
      side = e.kind === "hexer" && d < 14 ? 0.55 : 0;
    if (dir === 0 && side === 0) return;
    const v = dir > 0 ? steer(e, r.player.x, r.player.z) : toward(nx, nz);
    t.move(e, (v.x * dir - nz * side) * speed * dt, (v.z * dir + nx * side) * speed * dt, e.radius);
  }

  function stepDeathKind(e, dt, r, t, d, nx, nz, speed) {
    const p = r.player;
    if (e.state === "deathWindup") {
      e.timer -= dt;
      if (e.kind === "revenant") setProgress(e, 1 - e.timer / e.windupLen);
      if (e.timer <= 0) resolveDeathWindup(e, r);
    } else if (e.state === "deathRush") {
      advance(e, t, RUSH_SPEED * threat() * slow(e) * dt);
      e.timer -= dt;
      if (e.timer <= 0) {
        e.state = "approach";
        setCooldown(e, 1.6);
        clearWarning(e);
      }
    } else if (e.cooldown <= 0 && inAttackRange(e, d)) {
      beginDeathWindup(e, r, nx, nz);
    } else {
      deathApproach(e, dt, r, t, d, nx, nz, speed);
    }
    // Contact re-measures after the move; facing tracks the player every frame (no lock).
    if (Math.hypot(p.x - e.x, p.z - e.z) < e.radius + CONTACT_REACH) hurtPlayer(e.def.damage * contactMul(r), contactSource(e));
    e.y = 0;
    e.yaw = Math.atan2(nx, nz);
    pose(e, r, e.state === "deathWindup" ? 0 : 1);
  }

  // ---- creature blasts and fuses ----------------------------------------------------------------

  // True when a blast at (x, y, z) reaches the nearest point of the monster's body with a clear
  // line (ridges and cover block splash, as for combat's explosions).
  function reaches(e, x, y, z, radius) {
    const b = ctx.combat?.bodyBounds?.(e);
    if (!b) return Math.hypot(e.x - x, e.z - z) < radius + (e.def?.radius ?? 0.5);
    losTo.x = b.x;
    losTo.y = clamp(y, b.bottom, b.top);
    losTo.z = b.z;
    if (Math.hypot(losTo.x - x, losTo.y - y, losTo.z - z) >= radius + b.radius) return false;
    losFrom.x = x;
    losFrom.y = y + 0.08;
    losFrom.z = z;
    return !ctx.world?.trace?.(losFrom, losTo, 0);
  }

  // A creature's blast (Drowned pops, Molten bursts): `playerDamage` to the player through
  // combat's enemy explosion (which draws it), `monsterDamage` as friendly fire to every hittable
  // monster in reach, and the same raw damage to hazard props in reach (F10). opts: { cause
  // (player-damage cause), kind (the blast's kind), player (the player set it off), self (the
  // body that burst, spared) }.
  function blast(x, z, radius, playerDamage, monsterDamage, { cause: base, kind, player = false, self = null } = {}) {
    const r = ctx.run;
    if (!r) return;
    ctx.combat?.explode?.(x, z, radius, playerDamage, true, undefined, { source: base });
    const y = ground(x, z) + BLAST_HEIGHT;
    const source = { weapon: -1, kind, environment: true, friendlyFire: true, player: !!player, blast: { x, z } };
    const list = r.enemies ?? [];
    for (let i = 0, n = list.length; i < n; i++) {
      const e = list[i];
      if (e === self || e.dead || e.removed || e.fixed || !(e.hp > 0) || !isHittable(e) || !reaches(e, x, y, z, radius)) continue;
      ctx.combat?.hurtEnemy?.(e, monsterDamage, false, source);
    }
    for (const v of ctx.hazards?.hitVolumes?.() ?? []) if (Math.hypot(v.x - x, v.z - z) < radius + (v.r ?? 0)) ctx.hazards.hurtProp?.(v.o, monsterDamage, source);
  }

  // A delayed blast with its area marker filling as the fuse burns (sim time). `fire` runs when
  // it ends, unless the stage, the run or a cinematic drops it first.
  function fuse(x, z, radius, delay, kind, fire, owner = null) {
    const marker = ctx.tele?.area?.(x, z, radius, kind, { owner, eta: delay, started: clockOf(ctx.run ?? {}), targetsPlayer: true }) ?? null;
    const record = { t: delay, max: delay, marker, fire };
    fuses.push(record);
    return record;
  }

  // Burns every fuse; returns true when at least one went off.
  function tickFuses(dt) {
    if (!fuses.length) return false;
    let fired = false;
    for (let i = 0; i < fuses.length; i++) {
      const f = fuses[i];
      f.t -= dt;
      if (f.t > 0) {
        if (f.marker && !f.marker.dead) {
          progressOpts.progress = clamp(1 - f.t / f.max, 0, 1);
          ctx.tele?.set?.(f.marker, progressOpts);
        }
        continue;
      }
      ctx.tele?.remove?.(f.marker);
      f.marker = null;
      f.fire();
      fired = true;
    }
    let kept = 0;
    for (let i = 0; i < fuses.length; i++) if (fuses[i].t > 0) fuses[kept++] = fuses[i];
    fuses.length = kept;
    return fired;
  }

  function dropFuses() {
    for (const f of fuses) ctx.tele?.remove?.(f.marker);
    fuses.length = 0;
  }

  // ---- the Drowned ------------------------------------------------------------------------------

  // Burst of a Drowned at (x, z): 20 to the player, 55 to monsters, props set off, and a patch of
  // silt that slows everyone standing in it for 4 s.
  function drownedBurst(x, z, player, self = null) {
    blast(x, z, DROWNED.radius, DROWNED.player, DROWNED.monsters, { cause: sourceAt(SOURCES.drowned.burst, x, z), kind: "drowned", player, self });
    ctx.fx?.burst?.(x, 1, z, DROWNED.color, 16, 4);
    ctx.combat?.zone?.(x, z, DROWNED.silt.radius, { life: DROWNED.silt.life, slow: DROWNED.silt.slow, visual: "silt", source: SILT });
  }

  // ---- the Ashworm ------------------------------------------------------------------------------

  function beginBreach(e, r) {
    const p = r.player;
    e.state = "breach";
    e.timer = windup(e, ASHWORM.breach);
    e.tx = p.x + (p.vx || 0) * ASHWORM.lead;
    e.tz = p.z + (p.vz || 0) * ASHWORM.lead;
    warnArea(e, e.tx, e.tz, ASHWORM.radius, "burrow", e.timer);
    sfx("warnGround", e);
    sfx("rumble", e, 0.5);
    voice(e);
  }

  function resolveBreach(e, t) {
    clearWarning(e);
    ctx.combat?.explode?.(e.tx, e.tz, ASHWORM.radius, ASHWORM.damage, true, undefined, { source: sourceAt(SOURCES.ashworm.breach, e.tx, e.tz) });
    const at = t.safeNear(e.tx, e.tz, e.radius);
    e.x = at.x;
    e.z = at.z;
    e.state = "surface";
    e.timer = 0;
    e.rise = 1;
    e.untargetable = false;
    e.vuln = ASHWORM.vuln;
    e.salvo = "ready";
    e.hpSeen = e.hp;
    e.exposed = false;
  }

  // Burrowed: follows the flow field under its mound (untargetable, no contact), trailing embers
  // and a wake; breaches when close with its cooldown ready, or after 6 s underground.
  function wormBurrow(e, dt, r, t, d, nx, nz, speed) {
    e.timer += dt;
    if ((d < ASHWORM.breachAt && e.cooldown < 0) || e.timer >= ASHWORM.burrowMax) {
      beginBreach(e, r);
      return 0;
    }
    const x0 = e.x,
      z0 = e.z,
      moving = walk(e, t, dt, speed, r.player.x, r.player.z, nx, nz, d, 1);
    const moved = Math.hypot(e.x - x0, e.z - z0);
    if (moved > 1e-4) e.yaw = Math.atan2(e.x - x0, e.z - z0);
    e.trail += moved;
    if (e.trail >= ASHWORM.wakeStep) {
      e.trail = 0;
      ctx.fx?.decal?.(e.x, e.z, ASHWORM.wake.color, ASHWORM.wake.size, ASHWORM.wake.life);
    }
    e.emberT -= dt;
    if (e.emberT <= 0) {
      e.emberT = 1 / ASHWORM.embers;
      ctx.fx?.burst?.(e.x, 0.3, e.z, EMBER.color, 1, 1.2);
    }
    return moving;
  }

  // Breach: the mound runs at the locked target (up to 9 m/s) while the ring fills; the arch
  // breaks the surface over the last 0.3 s; then the ground erupts and it stands there.
  function wormBreach(e, dt, r, t) {
    e.timer -= dt;
    const dx = e.tx - e.x,
      dz = e.tz - e.z,
      gap = Math.hypot(dx, dz),
      step = Math.min(gap, ASHWORM.travel * dt);
    if (gap > 1e-3) {
      t.move(e, (dx / gap) * step, (dz / gap) * step, e.radius);
      e.yaw = Math.atan2(dx, dz);
    }
    e.rise = clamp(1 - e.timer / ASHWORM.emerge, 0, 1);
    setProgress(e, 1 - e.timer / e.windupLen);
    if (e.timer <= 0) resolveBreach(e, t);
    return 0;
  }

  // Surfaced for 2.4 s: exposed (x1.25), turning at 4 rad/s; at 0.8 s a 0.3 s cue, then a fan
  // of three embers, fired level at chest height.
  function wormSurface(e, dt, r, t, d, nx, nz) {
    e.timer += dt;
    turnToward(e, Math.atan2(nx, nz), ASHWORM.turn, dt);
    if (!e.exposed && e.hp < e.hpSeen) {
      e.exposed = true;
      ctx.fx?.label?.(e.x, ground(e.x, e.z) + 3, e.z, "EXPOSED", LABEL_GREY);
    }
    if (e.salvo === "ready" && e.timer >= ASHWORM.cueAt) {
      e.salvo = "cue";
      e.cueElapsed = 0;
      e.windupLen = windup(e, ASHWORM.cue);
      warnArea(e, e.x, e.z, ASHWORM.cueRadius, "ring", e.windupLen);
      sfx("warnAim", e);
    } else if (e.salvo === "cue") {
      e.cueElapsed += dt;
      setProgress(e, e.cueElapsed / e.windupLen);
      if (e.cueElapsed >= e.windupLen) {
        e.salvo = "spent";
        clearWarning(e);
        const y = ground(e.x, e.z) + CHEST_HEIGHT;
        for (const offset of ASHWORM.fan) shoot(e, e.yaw + offset, EMBER, SOURCES.ashworm.ember, 0, y);
      }
    }
    if (e.timer >= ASHWORM.surface) {
      clearWarning(e);
      e.state = "dive";
      e.timer = 0;
    }
    return 0;
  }

  // Dive: sinks over 0.4 s, hittable for the first 0.2 s, then burrows with a 3.5 s cooldown.
  function wormDive(e, dt) {
    e.timer += dt;
    e.rise = clamp(1 - e.timer / ASHWORM.dive, 0, 1);
    if (e.timer >= ASHWORM.diveHittable && !e.untargetable) {
      e.untargetable = true;
      e.vuln = 1;
    }
    if (e.timer >= ASHWORM.dive) {
      e.state = "burrow";
      e.timer = 0;
      e.rise = 0;
      setCooldown(e, ASHWORM.rest);
    }
    return 0;
  }

  // ---- the Lamplighter --------------------------------------------------------------------------

  // Monsters a ward may cage: no bosses or keepers, no shell, no WARDED elite, no Lamplighter,
  // nothing underground.
  const wardable = (a) =>
    !a.removed && !a.dead && a.hp > 0 && !a.fixed && !isBoss(a) && !a.keeper && !(a.shell > 0) && !a.elite?.includes("warded") && a.kind !== "lamplighter" && isHittable(a);

  // Up to 3 wardable allies within reach, highest current HP first (into e.wardTargets).
  function wardTargets(e, list) {
    const out = (e.wardTargets ??= []);
    out.length = 0;
    const reach = LAMP.ward.reach;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === e || !wardable(a) || Math.hypot(a.x - e.x, a.z - e.z) > reach) continue;
      out.push(a);
    }
    out.sort((a, b) => b.hp - a.hp);
    if (out.length > LAMP.ward.targets) out.length = LAMP.ward.targets;
    return out;
  }

  // Nearest other live monster (the Lamplighter keeps close to its allies); its distance is
  // left in allyDistance.
  let allyDistance = Infinity;
  function nearestAlly(e, list) {
    let best = null;
    allyDistance = Infinity;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === e || a.removed || a.dead || !(a.hp > 0) || a.fixed) continue;
      const d = Math.hypot(a.x - e.x, a.z - e.z);
      if (d < allyDistance) {
        best = a;
        allyDistance = d;
      }
    }
    return best;
  }

  function lanternPoint(e, out) {
    out.x = e.x;
    out.y = ground(e.x, e.z) + 2.4 * e.model.g.scale.y;
    out.z = e.z;
    return out;
  }

  function endChannel(e) {
    if (e.beams) {
      for (const beam of e.beams) beam?.remove?.();
      e.beams.length = 0;
    }
    clearWarning(e);
    e.state = "approach";
  }

  function beginFlare(e) {
    e.state = "flare";
    e.timer = windup(e, LAMP.flare.windup);
    warnArea(e, e.x, e.z, LAMP.flare.radius, "ring", e.timer);
    sfx("warnRing", e);
  }

  function beginChannel(e, targets) {
    e.state = "channel";
    e.timer = windup(e, LAMP.ward.channel);
    e.channelHp = e.hp;
    e.beams = e.beams ?? [];
    lanternPoint(e, beamFrom);
    for (const a of targets) {
      beamTo.x = a.x;
      beamTo.y = ground(a.x, a.z) + CHEST_HEIGHT;
      beamTo.z = a.z;
      e.beams.push(ctx.fx?.line?.(beamFrom, beamTo, LAMP.light, 0, LAMP.beamWidth) ?? null);
    }
    e.channelTargets = [...targets];
    warnArea(e, e.x, e.z, LAMP.ward.cast, "ring", e.timer);
    sfx("wardChime", e);
    voice(e);
  }

  function beginOil(e) {
    e.state = "oil";
    e.timer = windup(e, LAMP.oil.windup);
  }

  // The channel: beams follow their targets (a fallen target's beam drops); enough damage breaks
  // it (INTERRUPTED); otherwise every surviving target is caged.
  function channel(e, dt) {
    e.timer -= dt;
    setProgress(e, 1 - e.timer / e.windupLen);
    if (e.channelHp - e.hp >= LAMP.ward.interrupt * e.max) {
      endChannel(e);
      setCooldown(e, LAMP.ward.broken);
      ctx.fx?.label?.(e.x, ground(e.x, e.z) + 3.2, e.z, "INTERRUPTED", LABEL_GREY);
      return;
    }
    lanternPoint(e, beamFrom);
    for (let i = 0; i < e.channelTargets.length; i++) {
      const a = e.channelTargets[i],
        beam = e.beams[i];
      if (!beam) continue;
      if (a.dead || a.removed || !(a.hp > 0)) {
        beam.remove?.();
        e.beams[i] = null;
        continue;
      }
      beamTo.x = a.x;
      beamTo.y = ground(a.x, a.z) + CHEST_HEIGHT;
      beamTo.z = a.z;
      beam.update?.(beamFrom, beamTo);
    }
    if (e.timer > 0) return;
    for (let i = 0; i < e.channelTargets.length; i++) if (e.beams[i] && wardable(e.channelTargets[i])) ward(e.channelTargets[i]);
    endChannel(e);
    setCooldown(e, LAMP.ward.cooldown);
  }

  // Lobs lamp oil where the player stands: a 1.1 s fuse under an artillery marker.
  function throwOil(e, r) {
    const p = r.player;
    hazard(e, p.x, p.z, LAMP.oil.radius, LAMP.oil.damage, LAMP.oil.fuse, "artillery", SOURCES.lamplighter.oil);
    // The arc visual keeps its end points for its whole flight, so they are its own.
    ctx.fx?.lob?.(lanternPoint(e, {}), { x: p.x, y: ground(p.x, p.z), z: p.z }, LAMP.light, LAMP.oil.peak, LAMP.oil.fuse);
    sfx("mortar", e);
    setCooldown(e, LAMP.oil.cooldown);
    e.state = "approach";
  }

  // Priority each step: FLARE > WARD > OIL; otherwise it kites at 10-20 m near its allies, or
  // walks to the nearest ally when none is within 9 m.
  function lampApproach(e, dt, r, t, d, nx, nz, speed) {
    const list = r.enemies;
    if (d < LAMP.flare.reach && e.flareCD < 0) {
      beginFlare(e);
      return 0;
    }
    if (e.cooldown < 0) {
      const targets = wardTargets(e, list);
      if (targets.length) {
        beginChannel(e, targets);
        return 0;
      }
      if (d > LAMP.oil.min && d < LAMP.oil.max) {
        beginOil(e);
        return 0;
      }
    }
    e.yaw = Math.atan2(nx, nz);
    const ally = nearestAlly(e, list),
      gap = allyDistance;
    if (ally && gap > LAMP.allyReach) return walk(e, t, dt, speed, ally.x, ally.z, (ally.x - e.x) / gap, (ally.z - e.z) / gap, gap, 1);
    return walk(e, t, dt, speed, r.player.x, r.player.z, nx, nz, d, kite(d, LAMP.near, LAMP.far, LAMP.retreat));
  }

  // ---- ward cages ---------------------------------------------------------------------------------

  // A Lamplighter's ward: a shell of 35% of the ally's max HP for 8 s, drawn as a cage of lantern
  // light. Combat's damage pipeline spends the shell first.
  function ward(a) {
    a.shell = a.shellMax = LAMP.ward.shell * a.max;
    a.shellLife = LAMP.ward.life;
    a.shellSeen = a.shell;
    a.wardCage = true;
    if (!caged.includes(a)) caged.push(a);
  }

  function unward(a) {
    a.wardCage = false;
    a.shell = 0;
    a.shellMax = 0;
    a.shellLife = 0;
    const i = caged.indexOf(a);
    if (i >= 0) caged.splice(i, 1);
  }

  function cageField() {
    const layer = ctx.gfx?.layers?.effects;
    if (!cages && layer) {
      cages = createCageField();
      layer.add(cages.group);
    }
    return cages;
  }

  // Cages expire after 8 s or when their shell is spent; hits on a shell throw pale sparks.
  function tickWards(dt, r) {
    if (!caged.length && !cages) return;
    for (let i = caged.length - 1; i >= 0; i--) {
      const a = caged[i];
      a.shellLife -= dt;
      if (a.shell < a.shellSeen - 1e-6) ctx.fx?.burst?.(a.x, CHEST_HEIGHT, a.z, LAMP.spark, 4, 2);
      a.shellSeen = a.shell;
      if (a.shellLife <= 0 || !(a.shell > 0) || a.dead || a.removed || !(a.hp > 0)) unward(a);
    }
    const field = cageField();
    if (!field) return;
    cageDraw.length = caged.length;
    for (let i = 0; i < caged.length; i++) {
      const a = caged[i];
      const row = (cageDraw[i] ??= { x: 0, z: 0, radius: 0 });
      row.x = a.x;
      row.z = a.z;
      row.radius = (a.def?.radius ?? 0.5) * LAMP.cage;
    }
    field.draw(cageDraw, ground, ctx.tele?.minStrip?.() ?? 0.3, clockOf(r));
  }

  // ---- creature registry (F7) -------------------------------------------------------------------

  // AI[kind] = { onSpawn(e), update(e, dt, r, t, d, nx, nz, speed) -> walk-animation speed,
  // contact(e) -> may it touch, onDeath(e, source), interrupt(e) (a stun), animate(e, time, speed) }.
  const CREATURES = {
    drowned: {
      onSpawn(e) {
        e.cooldown = 0;
        e.dripT = DROWNED.drip;
      },
      update(e, dt, r, t, d, nx, nz, speed) {
        e.dripT -= dt;
        if (e.dripT <= 0) {
          e.dripT = DROWNED.drip;
          ctx.fx?.burst?.(e.x, 1.1, e.z, DROWNED.color, 1, 0.4);
        }
        if (e.state === "swell") {
          e.timer -= dt;
          swellBelly(e.model, 1 - e.timer / e.windupLen);
          setProgress(e, 1 - e.timer / e.windupLen);
          // The swell ends in its own burst: a death that bursts at once (onDeath).
          if (e.timer <= 0) ctx.combat?.hurtEnemy?.(e, e.hp + (e.shell || 0) + 1, false, SELF_BURST);
          return 0;
        }
        if (d < DROWNED.swellAt) {
          e.state = "swell";
          e.timer = windup(e, DROWNED.swell);
          warnArea(e, e.x, e.z, DROWNED.radius, "gas", e.timer);
          sfx("gurgle", e);
          voice(e);
          return 0;
        }
        e.yaw = Math.atan2(nx, nz);
        return walk(e, t, dt, speed, r.player.x, r.player.z, nx, nz, d, 1);
      },
      // Swelling it bursts at once (its marker is already up); walking it pops 0.35 s later
      // under a gas marker. Either way the blast is the player's only if the death was.
      onDeath(e, source) {
        const player = playerCaused(source),
          { x, z } = e;
        if (e.state === "swell") drownedBurst(x, z, player, e);
        else fuse(x, z, DROWNED.radius, DROWNED.pop, "gas", () => drownedBurst(x, z, player), e.id);
      },
      interrupt(e) {
        e.state = "approach";
        swellBelly(e.model, 0);
      },
    },

    ashworm: {
      onSpawn(e) {
        e.state = "burrow";
        e.untargetable = true;
        e.cooldown = ASHWORM.start;
        e.timer = 0;
        e.rise = 0;
        e.trail = 0;
        e.emberT = 0;
        e.salvo = "spent";
      },
      update(e, dt, r, t, d, nx, nz, speed) {
        if (e.state === "breach") return wormBreach(e, dt, r, t);
        if (e.state === "surface") return wormSurface(e, dt, r, t, d, nx, nz);
        if (e.state === "dive") return wormDive(e, dt);
        return wormBurrow(e, dt, r, t, d, nx, nz, speed);
      },
      contact: (e) => e.state === "surface",
      // A surfaced worm loses the salvo it was cueing.
      interrupt(e) {
        if (e.salvo === "cue") e.salvo = "spent";
      },
      animate(e, time) {
        poseAshworm(e.model, time, e.rise);
      },
    },

    lamplighter: {
      onSpawn(e) {
        e.flareCD = LAMP.flare.first;
        e.cooldown = LAMP.start;
      },
      update(e, dt, r, t, d, nx, nz, speed) {
        e.flareCD -= dt;
        if (e.state === "flare") {
          e.timer -= dt;
          setProgress(e, 1 - e.timer / e.windupLen);
          if (e.timer > 0) return 0;
          clearWarning(e);
          ctx.combat?.explode?.(e.x, e.z, LAMP.flare.radius, LAMP.flare.damage, true, undefined, { source: sourceAt(SOURCES.lamplighter.flare, e.x, e.z) });
          e.flareCD = e.cooldownMul ? LAMP.flare.cooldown * e.cooldownMul : LAMP.flare.cooldown;
          e.state = "approach";
          return 0;
        }
        if (e.state === "channel") {
          channel(e, dt);
          return 0;
        }
        if (e.state === "oil") {
          e.timer -= dt;
          if (e.timer <= 0) throwOil(e, r);
          return 0;
        }
        return lampApproach(e, dt, r, t, d, nx, nz, speed);
      },
      onDeath: endChannel,
      interrupt: endChannel,
      animate(e, time, speed) {
        animateCharacter(e.model, time, speed);
        glowLantern(e.model, time, e.state === "channel");
      },
    },
  };

  function stepCreature(e, ai, dt, r, t, d, nx, nz, speed) {
    const moving = ai.update(e, dt, r, t, d, nx, nz, speed);
    if (e.dead || e.removed) return; // a swell ends in the Drowned's own death
    if (d < e.radius + CONTACT_REACH && (ai.contact?.(e) ?? true))
      hurtPlayer(e.def.damage * contactMul(r), sourceAt(SOURCES[e.kind]?.contact ?? FALLBACK_CONTACT, e.x, e.z));
    e.y = 0;
    pose(e, r, moving);
  }

  // ---- stun (F1.4d) -----------------------------------------------------------------------------

  // Cancels whatever the monster was committed to, so a stun never lets an attack land without
  // its telegraph; cooldowns stay where they were.
  function interrupt(e) {
    clearWarning(e);
    const ai = CREATURES[e.kind];
    if (ai?.interrupt) ai.interrupt(e);
    else if (e.state !== "approach") {
      e.state = "approach";
      e.timer = 0;
    }
    e.y = 0;
    e.cueElapsed = 0;
    e.cueTick = 0;
    if (e.model?.body) e.model.body.rotation.z = e.model.lean;
  }

  // stun(e, seconds): no movement, attacks or contact, animation held, telegraph cleared and
  // cooldowns frozen for `seconds` (the longest stun wins). Keepers stagger instead; the Warden,
  // shades and burrowed monsters shrug it off.
  function stun(e, seconds) {
    if (!e || e.dead || e.removed || e.fixed || !(e.hp > 0) || !(seconds > 0)) return;
    if (isWarden(e) || e.shade) return;
    if (e.keeper || isBoss(e)) {
      ctx.bosses?.stagger?.(e, KEEPER_STAGGER);
      return;
    }
    if (!isHittable(e)) return;
    if (!(e.stunned > 0)) interrupt(e);
    e.stunned = Math.max(e.stunned || 0, seconds);
    ctx.bus?.emit("stun", { e, seconds });
  }

  // ---- slows (F1.4c) ----------------------------------------------------------------------------

  function inZone(zone, x, z, r) {
    const dx = x - zone.x,
      dz = z - zone.z;
    if (zone.shape === "box") {
      const c = Math.cos(zone.yaw || 0),
        s = Math.sin(zone.yaw || 0);
      return Math.abs(dx * c - dz * s) < (zone.sx || 0) + r && Math.abs(dx * s + dz * c) < (zone.sz || 0) + r;
    }
    return Math.hypot(dx, dz) < (zone.radius || 0) + r;
  }

  function zoneSlow(e, list, slowest) {
    if (!Array.isArray(list)) return slowest;
    const r = e.def?.radius ?? e.radius ?? 0.5;
    for (let i = 0; i < list.length; i++) {
      const zone = list[i];
      if (!zone || zone.dead || !(zone.slow < slowest) || zone.life <= 0 || zone.immune?.includes(e.kind)) continue;
      if (inZone(zone, e.x, e.z, r)) slowest = zone.slow;
    }
    return slowest;
  }

  // Walking multiplier from Void Wake (0.6), slowing zones and Citadel Frost: the strongest wins.
  // Keepers and bosses are never slowed.
  function slowMul(e) {
    if (!e || e.keeper || isBoss(e)) return 1;
    let m = Math.min(ctx.mods?.slow?.(e) ?? 1, ctx.relics?.slowOf?.(e) ?? 1);
    const zones = ctx.combat?.zones?.();
    m = zoneSlow(e, zones, m);
    const world = ctx.run?.worldZones;
    if (world !== zones) m = zoneSlow(e, world, m);
    return m;
  }

  // ---- per-step actor work ----------------------------------------------------------------------

  function contactSource(e) {
    const set = SOURCES[e.kind];
    const base = (e.state === "charge" || e.state === "deathRush") && set?.rush ? set.rush : (set?.contact ?? FALLBACK_CONTACT);
    return sourceAt(base, e.x, e.z);
  }

  function animate(e, time, speed) {
    const custom = CREATURES[e.kind]?.animate;
    if (custom) custom(e, time, speed);
    else animateCharacter(e.model, time, speed);
  }

  function pose(e, r, moving) {
    const { g, body } = e.model;
    g.position.set(e.x, ground(e.x, e.z) + e.y, e.z);
    g.rotation.y = e.yaw;
    animate(e, clockOf(r) + e.phase, moving);
    const k = ctx.env?.reduced ? 0 : e.flash;
    body.scale.set(1 + k * e.squash * 0.4, 1 - k * 0.25, 1);
  }

  function riseDepth(e) {
    const shown = Math.floor(clamp(1 - e.grace / (e.graceLen || SPAWN_GRACE), 0, 1) * RISE_POSES) / RISE_POSES,
      left = 1 - shown;
    return RISE_DEPTH * e.model.g.scale.y * left * left;
  }

  // Arrival (Wave-1): the monster climbs out of the ground in held poses during its grace.
  function rise(e, dt, r) {
    // Snap float residue so a 0.4 s grace is exactly 24 steps and the last pose stands on the ground.
    e.grace = e.grace - dt > 1e-6 ? e.grace - dt : 0;
    e.model.g.position.set(e.x, ground(e.x, e.z) - riseDepth(e), e.z);
    e.model.g.rotation.y = e.yaw;
    animate(e, clockOf(r) + e.phase, 0);
  }

  function stepMonster(e, dt, r, t) {
    // Stunned: frozen in place and pose, its clocks held.
    if (e.stunned > 0) {
      e.stunned = Math.max(0, e.stunned - dt);
      e.model.g.position.set(e.x, ground(e.x, e.z) + e.y, e.z);
      return;
    }
    e.cooldown -= dt;
    const p = r.player,
      dx = p.x - e.x,
      dz = p.z - e.z,
      d = Math.max(1e-4, Math.hypot(dx, dz)),
      speed = walkSpeed(e, r),
      ai = CREATURES[e.kind];
    e.walk = speed; // this step's final walk speed (m/s), for the HUD and tests
    if (ai) stepCreature(e, ai, dt, r, t, d, dx / d, dz / d, speed);
    else if (DEATH_TYPES[e.kind]) stepDeathKind(e, dt, r, t, d, dx / d, dz / d, speed);
    else stepOrdinary(e, dt, r, t, d, dx / d, dz / d, speed);
  }

  // Hit flash level; with Reduce flashes a hit shows for one frame at half strength (F17).
  function flashAmount(e) {
    if (ctx.prefs?.flashes !== false) return e.flash / HIT_TIME;
    return e.flash > HIT_TIME - 1.5 * STEP ? REDUCED_FLASH : 0;
  }

  // The shared prologue (spec §5.1): every actor's hit flash ticks here; bosses then hand over
  // to bosses.js, which owns their cooldown, movement and pose; ordinary arrivals rise through
  // their grace, then the kind's state machine runs; elites then run their affixes.
  function step(e, dt, r, t) {
    e.flash = Math.max(0, e.flash - dt);
    setFlash(e.model, flashAmount(e));
    const x0 = e.x,
      z0 = e.z;
    if (isBoss(e)) ctx.bosses?.update?.(e, dt);
    else if (e.grace > 0) rise(e, dt, r);
    else stepMonster(e, dt, r, t);
    if (e.elite && !e.dead) ctx.elites?.tick?.(e, dt);
    e.vx = (e.x - x0) / dt;
    e.vz = (e.z - z0) / dt;
  }

  // Rising arrivals are still underground, airborne leapers pass over the crowd and burrowed
  // monsters pass under it.
  const crowding = (e) => !e.removed && e.hp > 0 && !(e.grace > 0) && e.state !== "leap" && !e.untargetable;
  const anchored = (e) => isBoss(e) || e.state !== "approach";

  function separate(list, t) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      list[i].sepX = 0;
      list[i].sepZ = 0;
    }
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!crowding(a)) continue;
      const wa = anchored(a) ? 0 : 1 / (a.radius * a.radius);
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (!crowding(b)) continue;
        const wb = anchored(b) ? 0 : 1 / (b.radius * b.radius);
        if (wa + wb === 0) continue;
        const reach = (a.radius + b.radius) * SPACING,
          dx = b.x - a.x,
          dz = b.z - a.z;
        if (dx >= reach || dx <= -reach || dz >= reach || dz <= -reach) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= reach * reach) continue;
        // Inverse-mass (radius²) split; coincident bodies part along a per-monster direction.
        const d = Math.sqrt(d2),
          ux = d > 1e-4 ? dx / d : Math.sin(a.phase),
          uz = d > 1e-4 ? dz / d : Math.cos(a.phase),
          push = ((reach - d) * SEPARATION_RATE) / (wa + wb);
        a.sepX -= ux * push * wa;
        a.sepZ -= uz * push * wa;
        b.sepX += ux * push * wb;
        b.sepZ += uz * push * wb;
      }
    }
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (e.sepX === 0 && e.sepZ === 0) continue;
      const m = Math.hypot(e.sepX, e.sepZ),
        k = m > SEPARATION_MAX ? SEPARATION_MAX / m : 1;
      t.move(e, e.sepX * k, e.sepZ * k, e.radius);
      e.model.g.position.x = e.x;
      e.model.g.position.z = e.z;
    }
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  // A monster taken off the field leaves run.enemies at once, by reassignment so a caller
  // iterating the old array (a boss arrival or trial abandon loop) is not disturbed.
  function detach(e) {
    const r = ctx.run;
    if (r?.enemies?.includes(e)) r.enemies = r.enemies.filter((other) => other !== e);
  }

  // The slain and the removed leave run.enemies here, in place, like the original's per-step
  // filter. Only called between systems (update start, the director's sweep after combat),
  // where nobody else is iterating the list.
  function compact() {
    const list = ctx.run?.enemies;
    if (!Array.isArray(list)) return;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.removed && !e.dead && e.hp > 0) list[n++] = e;
    }
    list.length = n;
  }

  // Frees everything the actor owns: telegraph, beams, cage, blob shadow, model. Idempotent.
  function release(e) {
    clearWarning(e);
    if (e.beams?.length) endChannel(e);
    if (e.wardCage) unward(e);
    if (e.shadow) {
      ctx.fx?.removeShadow?.(e.shadow);
      e.shadow = null;
    }
    disposeModel(e.model);
    e.removed = true;
    e.dead = true;
    e.dying = -1;
    const i = tracked.indexOf(e);
    if (i >= 0) tracked.splice(i, 1);
  }

  // A slain monster collapses into the ground (Wave-1) before it is freed. It stays listed
  // (hp <= 0) until the director's dead-drop or the next compaction, so a kill never reshuffles
  // the list under combat's hit sweep.
  function fall(e) {
    if (e.removed) return;
    e.removed = true;
    e.dead = true;
    clearWarning(e);
    if (!e.model || !tracked.includes(e)) {
      release(e);
      return;
    }
    e.y = e.model.g.position.y - ground(e.x, e.z); // a Leaper slain mid-air comes down from here
    e.dying = 0;
  }

  function collapse(e, dt) {
    e.dying += dt;
    e.flash = Math.max(0, e.flash - dt);
    setFlash(e.model, flashAmount(e));
    const k = Math.min(1, e.dying / COLLAPSE_TIME);
    collapseModel(e.model, k);
    // Airborne bodies drop to the ground; one slain while still rising crumbles where it is.
    e.model.g.position.y = ground(e.x, e.z) + (e.y > 0 ? e.y * (1 - k) : e.y);
    if (k >= 1) release(e);
  }

  // Takes a monster off the field now, whatever its state: alive (boss arrivals, trial abandon),
  // mid-collapse, or the slain Warden after its victory sequence. Idempotent.
  function remove(e) {
    if (!e) return;
    detach(e);
    release(e);
  }

  // Collapses advance; anything that died without passing through onDeath is freed at once
  // (a slain Warden stays for its victory sequence); then the list is compacted.
  function reap(dt) {
    for (let i = tracked.length - 1; i >= 0; i--) {
      const e = tracked[i];
      if (e.dying >= 0) collapse(e, dt);
      else if (!e.removed && !isWarden(e) && (e.dead || !(e.hp > 0))) release(e);
    }
    compact();
  }

  function split(e) {
    voice(e);
    for (let i = 0; i < 2 && live() < MAX_HOSTILES; i++)
      spawn("skitter", { x: e.x + roll(-2, 2), z: e.z + roll(-2, 2) }, { hpScale: SPLIT_CHILD_HP, parent: e });
  }

  // Kind-specific death effects, called by combat on lethal damage before trial bookkeeping and
  // the kill event: splitter children (already on the trial roster when they appear), creature
  // and elite death effects, boss deaths, then the collapse. The slain Warden stays on the
  // field for its victory sequence.
  function onDeath(e, source) {
    if (!e || e.deathHandled) return;
    e.deathHandled = true;
    if (isBoss(e)) ctx.bosses?.onDeath?.(e, source);
    else {
      if (e.kind === "splitter" && (ctx.run?.stage || 1) >= SPLIT_MIN_STAGE) split(e);
      CREATURES[e.kind]?.onDeath?.(e, source);
      if (e.elite) ctx.elites?.onDeath?.(e, source);
    }
    if (e.wardCage) unward(e);
    if (!isWarden(e)) fall(e);
  }

  // The fixed-step AI pass: collapses and creature fuses first, then every actor, then crowd
  // separation and ward cages. Stops as soon as an action ends play (player death, a sequence
  // starting), like the original.
  function update(dt) {
    if (!(dt > 0)) return;
    reap(dt);
    const r = ctx.run,
      t = terrain();
    if (!r?.player || !t || !Array.isArray(r.enemies)) return;
    if (tickFuses(dt) && !playing(r)) return;
    const list = r.enemies;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed || !(e.hp > 0)) continue;
      step(e, dt, r, t);
      if (!playing(r)) return;
    }
    separate(r.enemies, t);
    tickWards(dt, r);
  }

  function live() {
    const list = ctx.run?.enemies;
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.hp > 0 && !e.removed && !e.fixed) n++;
    }
    return n;
  }

  // Nearest live, hittable monster (burrowed ones are out of reach), optionally filtered.
  function nearest(x, z, filter = null) {
    const list = ctx.run?.enemies;
    if (!list) return null;
    let best = null,
      bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!(e.hp > 0) || e.removed || e.fixed || !isHittable(e) || (filter && !filter(e))) continue;
      const d = (e.x - x) ** 2 + (e.z - z) ** 2;
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  // Statue curse: every living monster's HP and max HP scale with the new difficulty.
  function rescale(ratio) {
    const list = ctx.run?.enemies;
    if (!list || !(ratio > 0) || !Number.isFinite(ratio)) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!(e.hp > 0) || e.removed) continue;
      e.hp *= ratio;
      e.max *= ratio;
    }
  }

  function clear() {
    dropFuses();
    while (tracked.length) release(tracked[tracked.length - 1]);
    caged.length = 0;
    cages?.clear();
    if (Array.isArray(ctx.run?.enemies)) ctx.run.enemies.length = 0;
  }

  // A cinematic clears every telegraph; the actors keep their state (spec §4.3).
  function clearWarnings() {
    for (let i = 0; i < tracked.length; i++) clearWarning(tracked[i]);
  }

  // A new run never inherits the previous run's actors, even if nobody cleared them.
  ctx.bus?.on("runStart", () => {
    const list = ctx.run?.enemies ?? [];
    for (let i = tracked.length - 1; i >= 0; i--) if (!list.includes(tracked[i])) release(tracked[i]);
    dropFuses();
  });
  // Pending creature blasts are hazards: a cinematic drops them with combat's (F7).
  ctx.bus?.on("sequence", (event) => {
    if (event?.active) dropFuses();
  });
  // Palette or threat-eye changes recolour every live monster's eyes (F17).
  ctx.bus?.on("prefs", () => {
    for (let i = 0; i < tracked.length; i++) if (!tracked[i].removed) paintEyes(tracked[i], true);
  });
  // ?practice=creatures&kind=drowned|ashworm|lamplighter: three of the kind at 14 m on its home
  // stage (read from the page's parameters at registration), mortal.
  ctx.bus?.on("practice", ({ register }) => {
    const wanted = ctx.env?.debug?.params?.kind;
    register(
      "creatures",
      (c, params, h) => h.spawnRing(HOME_STAGE[params.kind] ? params.kind : "drowned", 3, 14),
      { stage: HOME_STAGE[wanted] ?? HOME_STAGE.drowned, mortal: true },
    );
  });

  return {
    spawn,
    update,
    onDeath,
    remove,
    live,
    nearest,
    rescale,
    clear,
    // Additions for the director: the per-step dead-drop after combat (the slain leave
    // run.enemies and start collapsing) and the cinematic telegraph wipe.
    sweep: () => reap(0),
    clearWarnings,
    // Wave-2 (IMPROVEMENTS F1.4d, F1.4c, F7).
    stun,
    slowMul,
    isHittable,
    // Creature and elite death effects (elites.js): a friendly-fire blast and a delayed one.
    blast,
    fuse,
  };
}
