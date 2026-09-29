// Run progression: XP level-ups, the reward queue and its card screens (upgrades, major
// weapon mods, the dash trait, Skull Trial rewards and, under KEEPERS, keeper spoils and relic
// choices), decision dialogs (statues, landmarks), card previews, practice builds and the
// build summary. Rewards are run-only; nothing here persists. Cards carry { icon, rarity, tag,
// gold } for the renderer (icon = an ICONS id, IMPROVEMENTS §3.11).
import { WEAPONS } from "../data/weapons.js";
import { UPGRADES, OFFENSE_UPGRADES, CRIT_CAP, MODS, DASH_TRAITS, BALANCE as B, POWERUPS, DROPS, DASH, applyUpgrade, shotStats, createBuild } from "../data/progression.js";
import { RELICS, CURSED_TAG } from "../data/relics.js";
import { OMENS } from "../data/omens.js";
import { keeperDef } from "../data/keepers.js";
import { FLOW } from "../data/stages.js";
import { shuffled } from "../core/rng.js";
import { previewNumber } from "../core/util.js";
import { thornsRate } from "./relics.js";

const DEADEYE = 7;
const PHASE_ARMOR = 3;
const MOD_OFFER = 3;
const TRIAL_HEAL = 35;
const SPOILS_RELICS = 3;
const CACHE_RELICS = 2;
const TRIAL_RELICS = 3;
const MIN_MAX = 40;
const LANDMARK_HEAL = 12; // the Wave-1 landmark recovery (Pilgrim Salts raises it)
const CACHE_KEY = /(^|:)cache:/; // encounters queues elite caches as rewardKey("cache:{stage}:{i}")
const KEEPER_KEY = /(?:^|:)keeper:([a-z]+)/; // keeper spoils: rewardKey("keeper:{id}")

// FIFO of reward events. A key is accepted once per run, so re-triggers (every kill after
// a kill goal, a repeated level) never queue the same reward twice. `opts` travels with the
// event (relic screens: { n, title, context, via }).
export class RewardQueue {
  constructor() {
    this.events = [];
    this.seen = new Set();
  }
  add(key, type, done = null, opts = null) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.events.push({ key, type, done, opts });
    return true;
  }
  next() {
    return this.events.shift() || null;
  }
  peek() {
    return this.events[0] || null;
  }
  get pending() {
    return this.events.length > 0;
  }
}

// Upgrade previews print JS numbers: fractions keep 3 significant digits, others 2 decimals.
const upgradeNumber = (n) => Number(n > 0 && n < 1 ? n.toPrecision(3) : n.toFixed(2));
const pair = (a, b, suffix = "") => `${upgradeNumber(a)}${suffix} → ${upgradeNumber(b)}${suffix}`;
const withTip = (detail, tip) => `${detail} Tip: ${tip}`;

// "Before → after" line for an ordinary upgrade on the equipped weapon `w` (`rules`: the Rules
// Ledger under KEEPERS, so previews match what combat fires).
export function upgradePreview(p, id, w, boons = {}, rules = null) {
  const next = applyUpgrade({ ...p }, id);
  const a = shotStats(p, w, boons, rules);
  const b = shotStats(next, w, boons, rules);
  switch (id) {
    case 0:
      return `${w.label} interval ${pair(a.interval, b.interval, "s")}${boons.rapid ? " · Rapid Fire active" : ""}`;
    case 1:
      return `${w.label} ${w.rocket ? "base blast" : "damage per projectile"} ${pair(a.damage, b.damage)}`;
    case 2:
      return `${w.label} projectiles ${pair(a.count, b.count)}`;
    case 3:
      return `Max integrity ${pair(p.max, next.max)} · Heal ${upgradeNumber(next.hp - p.hp)}`;
    case 4:
      return `Shard reach ${pair(p.magnet, next.magnet, "m")}`;
    case 5:
      return w.rocket ? "Havoc unchanged · +1 penetration for the other four weapons" : `${w.label} extra targets ${pair(a.pierce, b.pierce)}`;
    case 6:
      return `Base speed ${pair(p.speed, next.speed, "m/s")}`;
    case 7:
      return `Critical chance ${pair(p.crit * 100, next.crit * 100, "%")}`;
    case 8:
      return `Recovery ${pair(p.regen, next.regen, " HP/s")}`;
    default:
      return "";
  }
}

// Mod card detail. `w` is the offered mod's own weapon (WEAPONS[id]), not the equipped one;
// base damage excludes crits and per-target modifiers.
export function modPreview(p, id, w, boons = {}, rules = null) {
  const s = shotStats(p, w, boons, rules);
  const f = previewNumber;
  switch (id) {
    case 0:
      return withTip(
        `First hit/projectile: 2 × ${f(s.damage * B.splinter)} base dmg. Splinters cannot split again.`,
        p.extra > 0
          ? `Your ${s.count} primary rounds can each split.`
          : p.pierce > 0
            ? `Your splinters pierce ${p.pierce} extra targets.`
            : p.damage > 1
              ? "Heavy Rounds strengthens splinters too."
              : "Add Forked Chamber for more splitting rounds.",
      );
    case 1:
      return withTip(
        `${B.stormHits} connected pulls → up to ${B.stormTargets} arcs × ${f(s.damage * B.stormDamage)} non-critical base dmg; ${B.stormRadius}m/hop, cover blocks.`,
        p.extra > 0
          ? `${s.count} shots still give 1 charge/pull.`
          : p.rate > 1 || boons.rapid
            ? `Your ${f(s.interval)}s shot interval helps build charge.`
            : p.damage > 1
              ? "Heavy Rounds strengthens each arc."
              : "Add Overclock to connect pulls faster.",
      );
    case 2:
      return withTip(
        `Primary kill within ${B.graveRange}m → ${B.graveFragments} × ${f(s.damage * B.graveDamage)} base dmg; once/pull.`,
        p.extra > 0
          ? `${s.count} pellets still give one burst/pull.`
          : p.pierce > 0
            ? `Your fragments pierce ${p.pierce} extra targets.`
            : p.damage > 1
              ? "Heavy Rounds strengthens fragments too."
              : "Add Heavy Rounds for stronger fragments.",
      );
    case 3:
      return withTip(
        `${f(s.damage * B.scarDamage)} non-critical base dmg/target every ${B.scarTick}s for ${B.scarLife}s; shared across scars, cover blocks.`,
        p.extra > 0
          ? "Extra rails widen coverage, not tick rate."
          : p.damage > 1
            ? "Heavy Rounds strengthens every scar tick."
            : p.rate > 1 || boons.rapid
              ? "Faster fire adds traces, not faster ticks."
              : "Add Heavy Rounds for stronger scar ticks.",
      );
    case 4:
      return withTip(
        `Pull ordinary foes within ${B.pullRadius}m for ${B.pullLife}s → ${f(s.damage)} base blast dmg, ${w.radius}m radius; one blast/rocket. Bosses resist pull.`,
        p.extra > 0
          ? `Your ${s.count} rockets each pull and blast.`
          : p.crit > 0.1
            ? "Deadeye: one critical roll per blast."
            : p.damage > 1
              ? "Heavy Rounds strengthens each blast."
              : "Add Forked Chamber for more pull/blast sites.",
      );
    default:
      return "";
  }
}

// Dash card detail for trait "echo" | "wake" with the equipped weapon and the run build.
export function dashPreview(p, trait, w, boons = {}, build = {}, rules = null) {
  const mods = build.mods || [];
  const f = previewNumber;
  if (trait === "echo") {
    const s = shotStats(p, w, boons, rules);
    return withTip(
      `${w.label} echo: ${s.count} × ${f(s.damage * B.echoDamage)} base dmg from dash origin. Next volley within ${B.echoWindow}s; once/dash, no mod triggers.`,
      p.extra > 0
        ? "Forked Chamber's extra shots repeat."
        : mods.some((id) => MODS[id]?.weapon === w.label)
          ? "Your mod stays on the primary volley."
          : p.damage > 1
            ? "Heavy Rounds strengthens the echo too."
            : "Add Forked Chamber to repeat more shots.",
    );
  }
  if (trait === "wake")
    return withTip(
      `${B.wakeLife}s trail: ordinary foes move at ${f(B.wakeSlow * 100)}% speed (${f((1 - B.wakeSlow) * 100)}% slow). No stacking; bosses resist.`,
      mods.includes(3)
        ? "Slow foes along your Rift Scars."
        : mods.includes(4)
          ? "Slow foes near your delayed Havoc blast."
          : mods.includes(2)
            ? `Slow foes to keep Graveburst kills within ${B.graveRange}m.`
            : mods.includes(1)
              ? "Slow foes to connect your Storm Needle pulls."
              : w.count > 1
                ? "Slow foes for close Scatter volleys."
                : "Slow pursuers to line up your next volley.",
    );
  return "";
}

// A read-only ledger view with extra effects folded in, for "before to after" previews.
export function ledgerWith(rules, effects = []) {
  const fold = (key, op, start, combine) => effects.reduce((v, f) => (f.key === key && f.op === op ? combine(v, f.value) : v), start);
  return {
    mul: (key) => fold(key, "mul", rules?.mul?.(key) ?? 1, (a, b) => a * b),
    sum: (key) => fold(key, "add", rules?.sum?.(key) ?? 0, (a, b) => a + b),
    flag: (key) => fold(key, "flag", !!rules?.flag?.(key), (a, b) => a || !!b),
  };
}

const volley = (s) => Math.round(s.count * s.damage);
const percent = (n) => Math.round(n * 100);
const weaponName = (w) => w.label.charAt(0) + w.label.slice(1).toLowerCase();

// The live-number detail line of a relic card (IMPROVEMENTS F9.3), in the Crypt glyphs
// (X for times, "to" for a change). ctx: { p, w (the equipped weapon), boons, rules, dashMax }.
export function relicPreview(id, { p, w, boons = {}, rules = null, dashMax = DASH.max }) {
  const def = RELICS[id];
  if (!def || !p || !w) return "";
  const now = ledgerWith(rules),
    next = ledgerWith(rules, def.effects),
    f = previewNumber,
    before = shotStats(p, w, boons, now),
    after = shotStats(p, w, boons, next),
    gun = weaponName(w),
    max = (delta) => Math.max(MIN_MAX, p.max + delta),
    change = (key, base, unit = "") => `${f(base * now.mul(key))}${unit} to ${f(base * next.mul(key))}${unit}`;
  switch (id) {
    case "lodestone_eye":
      return `Shards drift in from 12m · magnet ${f(p.magnet)}m`;
    case "quarry_bell":
      return `${f(4 * now.mul("boonDuration"))}s of RAPID FIRE per surge`;
    case "pilgrim_salts":
      return `Landmark heal ${LANDMARK_HEAL} to 30 · BONE WARD`;
    case "bone_lantern":
      return `Drop chance ${percent(DROPS.chance * now.mul("dropChance"))}% to ${percent(DROPS.chance * next.mul("dropChance"))}% · Pickups ${change("dropLifetime", DROPS.lifetime, "s")}`;
    case "leaden_heart":
      return `Max integrity ${p.max} to ${max(30)} · Speed ${change("moveSpeed", p.speed, " m/s")}`;
    case "citadel_frost":
      return "Hits under 30% health: 70% speed for 1s";
    case "grave_dirt":
      return "Heal 8 on every level-up";
    case "warden_splinter":
      return `Keeper and elite damage X${f(now.mul("bossDamage"))} to X${f(next.mul("bossDamage"))}`;
    case "tithe_hammer":
      return "A prop you dash into blasts at once";
    case "ash_salts":
      return `Kill heal ${change("killHealMult", FLOW.KILL_HEAL)} · No lava or cinder burns`;
    case "silt_boots":
      return "Damage to slowed monsters X1.2";
    case "hunters_mark":
      return "Molten and Shardborn bursts deal 0";
    case "hollow_crown":
      return `Dash charges ${dashMax} to ${Math.min(4, dashMax + 1)}`;
    case "witch_glass":
      return `${gun} crit burst ${Math.round(2 * before.damage * 0.3)} in 1.6m`;
    case "ferryman_coin":
      return "One lethal hit leaves you at 1 integrity";
    case "stillwater_idol":
      return `${gun} volley ${volley(before)} to ${Math.round(volley(before) * 1.3)} while still`;
    case "ember_reliquary":
      return "Havoc blasts burn 10 every 0.5s for 2.5s";
    case "phase_lung":
      return "Dash through for 40 · up to 0.6s recharge back";
    case "reaper_thread":
      return "Bone nova: 60 in 8m every 40 kills";
    case "glutton_maw":
      return `Shard XP X${f(now.mul("xpMult"))} to X${f(next.mul("xpMult"))} · Max integrity ${p.max} to ${max(-20)}`;
    case "red_hourglass":
      return `Boons ${change("boonDuration", POWERUPS.rapid.duration, "s")} · Damage taken X${f(now.mul("damageTaken"))} to X${f(next.mul("damageTaken"))}`;
    case "crown_thorns":
      return `${gun} volley ${volley(before)} to ${volley(after)} · Bleed ${f(thornsRate(p.max))}/s up close`;
    case "severed_hand":
      return `${gun} volley ${volley(before)} to ${volley(after)}`;
    case "black_candle":
      return "Chain multipliers +0.25 · The ward no longer saves it";
    default:
      return "";
  }
}

// Three lines: ordinary upgrades, mods, dash; under KEEPERS a Relics and an Omens line follow
// when any are held. `details` (pause menu) adds each description on its own line; the run
// report uses the compact " · " form.
export function describeBuild(build, details = false, extras = {}) {
  const join = details ? "\n" : " · ";
  const ordinary = Object.entries(build.ordinary)
    .map(([name, n]) => name + (n > 1 ? ` ×${n}` : "") + (details ? ` — ${UPGRADES.find((u) => u.name === name)?.text || ""}` : ""))
    .join(join);
  const mods = build.mods.map((i) => `${MODS[i].weapon} · ${MODS[i].name}` + (details ? ` — ${MODS[i].text}` : "")).join(join);
  const dash = DASH_TRAITS.find((d) => d.id === build.dash);
  const lines = [ordinary || "No ordinary upgrades", mods || "No major mods", dash ? dash.name + (details ? ` — ${dash.text}` : "") : "Phase Dash"];
  const relics = (extras.relics ?? []).map((id) => RELICS[id]?.name).filter(Boolean);
  const omens = (extras.omens ?? []).map((id) => OMENS[id]?.name).filter(Boolean);
  if (relics.length) lines.push(`Relics: ${relics.join(" · ")}`);
  if (omens.length) lines.push(`Omens: ${omens.join(" · ")}`);
  return lines.join("\n");
}

const firstOf = (pool, rng) => shuffled(pool, rng)[0];
const cardsStream = (run) => run.stream?.("cards") ?? run.rng;
const upgradeIdOf = (u) => (Number.isInteger(u) ? u : UPGRADES.find((row) => row.name.toLowerCase() === String(u).toLowerCase())?.id);

export function createProgression(ctx) {
  const setMode = (mode) => ctx.director?.setMode?.(mode);
  // The Rules Ledger applies to KEEPERS runs only; ORIGINAL previews keep the Wave-1 numbers.
  const ledger = (run) => (run.original ? null : (ctx.rules ?? null));
  let decisionSerial = 0;

  // Level-up check once per play step (at most one level per step), then drain the queue.
  function update() {
    const run = ctx.run;
    const p = run?.player;
    if (!p) return;
    if (!run.tutorial && p.xp >= p.next) levelUp(run, p);
    showNext();
  }

  function levelUp(run, p) {
    p.xp -= p.next;
    p.level += 1;
    p.next = Math.floor(p.next * 1.3 + 3);
    ctx.bus.emit("levelUp", { level: p.level });
    // The attract demo never opens cards (nor touches the menu user's input): it takes a
    // random upgrade on the spot.
    if (run.demo) {
      applyUpgrade(p, Math.floor(cardsStream(run)() * UPGRADES.length));
      return;
    }
    ctx.input?.clear?.();
    queue(`xp:${p.level}`, "ordinary");
    showNext();
  }

  // queue(key, type, done, opts): opts ride along to the reward screen (relic screens:
  // { n, title, context, via }).
  function queue(key, type, done = null, opts = null) {
    return !!ctx.run?.rewards?.add(key, type, done, opts);
  }

  // Wave-1: a level-up card never lands on a boss's entrance; it waits out the hold the
  // director sets when the Iron Maw / Warden cinematic ends.
  const heldForEntrance = (run, event) => event.type === "ordinary" && event.key.startsWith("xp:") && run.entranceHold > 0;

  function showNext() {
    const run = ctx.run;
    if (!run?.rewards || run.activeReward || ctx.overlay || run.demo || run.tutorial || ctx.mode !== "play") return false;
    const head = run.rewards.peek();
    if (!head || heldForEntrance(run, head)) return false;
    const event = run.rewards.next();
    run.activeReward = event;
    ctx.input?.clear?.();
    setMode("upgrade");
    const offer = offerFor(event, run);
    ctx.menus?.choice?.({
      title: offer.title,
      context: offer.context ?? contextLine(run),
      cards: offer.cards.map((card) => presentCard(card, () => pick(event, card))),
    });
    ctx.hud?.update?.();
    return true;
  }

  // Each card works once (menus guards the dialog).
  function pick(event, card) {
    const run = ctx.run;
    if (!run || run.activeReward !== event) return;
    card.apply();
    event.done?.();
    ctx.bus.emit("reward", { type: event.type, id: card.id });
    resumeAfterChoice(run);
  }

  // Shared exit for rewards and decisions: back to play, then on to the next queued reward,
  // so chained rewards open back to back.
  function resumeAfterChoice(run) {
    run.activeReward = null;
    if (ctx.mode === "upgrade") setMode("play");
    ctx.input?.clear?.();
    showNext();
    ctx.hud?.update?.();
  }

  // What the renderer gets: text, the weapon sprite (mods), and the chip data (IMPROVEMENTS
  // F9.3, §3.11): icon (an ICONS id), rarity (relics), tag and gold (a card that leads to
  // relics).
  function presentCard(card, onPick) {
    return {
      title: card.title,
      text: card.text,
      detail: card.detail,
      weapon: card.weapon,
      icon: card.icon ?? null,
      rarity: card.rarity ?? null,
      tag: card.tag ?? null,
      gold: !!card.gold,
      onPick,
    };
  }

  function offerFor(event, run) {
    if (event.type === "major") {
      const mods = modOffer(run);
      return mods.length
        ? { title: "MAJOR WEAPON MOD", cards: mods.map((id) => modCard(id, run)) }
        : { title: "ALL MODS OWNED · UPGRADE", cards: ordinaryOptions() };
    }
    if (event.type === "dash") return { title: "CHOOSE YOUR DASH", cards: DASH_TRAITS.map((trait) => dashCard(trait, run)) };
    if (event.type === "trial") return { title: "SKULL TRIAL · CHOOSE A REWARD", cards: trialCards(event, run) };
    if (event.type === "spoils") return spoilsOffer(event, run);
    if (event.type === "relic") return relicOffer(event, run);
    return { title: "CHOOSE AN UPGRADE", cards: ordinaryOptions() };
  }

  // One offense pick, one survival/movement pick and one other distinct pick, shuffled, on the
  // "cards" stream.
  function ordinaryOptions() {
    const run = ctx.run;
    const rng = cardsStream(run);
    const available = availableUpgrades(run.player);
    const first = firstOf(available.filter((id) => OFFENSE_UPGRADES.includes(id)), rng);
    const second = firstOf(available.filter((id) => !OFFENSE_UPGRADES.includes(id)), rng);
    const third = firstOf(available.filter((id) => id !== first && id !== second), rng);
    return shuffled([first, second, third], rng).map((id) => upgradeCard(id, run));
  }

  const availableUpgrades = (p) => UPGRADES.map((u) => u.id).filter((id) => id !== DEADEYE || p.crit < CRIT_CAP - 1e-9);

  function upgradeCard(id, run) {
    const u = UPGRADES[id];
    return {
      id,
      title: u.name,
      text: u.text,
      icon: `upgrade:${id}`,
      detail: upgradePreview(run.player, id, WEAPONS[run.weapon] ?? WEAPONS[0], run.boons, ledger(run)),
      apply: () => applyOrdinary(run, id),
    };
  }

  // An ordinary upgrade as a card applies it. Phase armor raises the base max, so KEEPERS max
  // integrity is recomputed over the ledger, and its heal is reported.
  function applyOrdinary(run, id) {
    const p = run.player,
      before = p.hp,
      u = UPGRADES[id];
    applyUpgrade(p, id);
    run.build.ordinary[u.name] = (run.build.ordinary[u.name] || 0) + 1;
    if (id !== PHASE_ARMOR) return;
    if (!run.original) ctx.player?.recomputeMax?.();
    if (p.hp > before) ctx.bus.emit("playerHeal", { amount: p.hp - before, reason: "upgrade" });
  }

  const unownedMods = (run) => MODS.map((m) => m.id).filter((id) => !run.build.mods.includes(id));
  const modOffer = (run) => shuffled(unownedMods(run), cardsStream(run)).slice(0, MOD_OFFER);

  function modCard(id, run) {
    const mod = MODS[id];
    return {
      id,
      title: mod.name,
      text: mod.weapon,
      weapon: id,
      icon: `mod:${id}`,
      detail: modPreview(run.player, id, WEAPONS[id], run.boons, ledger(run)),
      apply() {
        run.build.mods.push(id);
      },
    };
  }

  function dashCard(trait, run) {
    return {
      id: trait.id,
      title: trait.name,
      text: trait.blurb,
      icon: `trait:${trait.id}`,
      detail: dashPreview(run.player, trait.id, WEAPONS[run.weapon] ?? WEAPONS[0], run.boons, run.build, ledger(run)),
      apply() {
        run.build.dash = trait.id;
      },
    };
  }

  // The mod and upgrade options queue a follow-up screen that claims the trial when picked.
  // KEEPERS adds the Reliquary (a relic choice) as a fourth card.
  function trialCards(event, run) {
    const claim = () => run.trial?.claim?.();
    const hasMods = unownedMods(run).length > 0;
    const cards = [];
    if (hasMods)
      cards.push({
        id: "mod",
        title: "Major weapon mod",
        text: "Choose one of up to three unowned modifications.",
        apply: () => queue(`${event.key}:mod`, "major", claim),
      });
    cards.push({
      id: "upgrade",
      title: hasMods ? "Ordinary upgrade" : "All mods owned · ordinary upgrade",
      text: "Choose one of three ordinary run upgrades.",
      apply: () => queue(`${event.key}:upgrade`, "ordinary", claim),
    });
    if (!run.original)
      cards.push({
        id: "reliquary",
        title: "Reliquary",
        text: "Choose one of three relics.",
        gold: true,
        apply: () => queue(`${event.key}:relic`, "relic", claim, { n: TRIAL_RELICS, context: "SKULL TRIAL", via: "trial" }),
      });
    cards.push(mendCard(TRIAL_HEAL, "trial", claim));
    return cards;
  }

  // Mend & Bone Ward: heal and a 30-point ward (the trial's third card, the keeper spoils' last).
  function mendCard(heal, reason, done = null) {
    return {
      id: "mend",
      title: "Mend & Bone Ward",
      text: "Heal 35 and gain a 30-point ward for 10s.",
      apply() {
        ctx.player?.heal?.(heal, reason);
        ctx.encounters?.collectBoon?.("ward");
        done?.();
      },
    };
  }

  // Up to n relic cards on the "relics" stream; ordinary upgrade cards fill what the
  // Reliquary cannot. Returns { cards, short } (short: some were filled).
  function relicCards(run, n, via) {
    const ids = ctx.relics?.offer?.(n, via) ?? [];
    const cards = ids.map((id) => relicCard(id, run, via));
    const missing = n - cards.length;
    if (missing > 0) cards.push(...ordinaryOptions().slice(0, missing));
    return { cards, short: missing > 0 };
  }

  function relicCard(id, run, via) {
    const def = RELICS[id];
    return {
      id,
      title: def.name,
      text: def.text,
      icon: id,
      rarity: def.rarity,
      tag: def.rarity === "cursed" ? CURSED_TAG : null,
      detail: relicPreview(id, {
        p: run.player,
        w: WEAPONS[run.weapon] ?? WEAPONS[0],
        boons: run.boons,
        rules: ledger(run),
        dashMax: ctx.player?.dashMax?.() ?? DASH.max,
      }),
      apply: () => ctx.relics?.grant?.(id, via),
    };
  }

  // Keeper spoils (IMPROVEMENTS F1.3): three relic cards and Mend & Bone Ward, one screen.
  function spoilsOffer(event, run) {
    const title = keeperDef(KEEPER_KEY.exec(event.key)?.[1])?.title ?? "THE KEEPER";
    const { cards, short } = relicCards(run, SPOILS_RELICS, "spoils");
    cards.push(mendCard(TRIAL_HEAL, "spoils"));
    return { title: "KEEPER SPOILS · CHOOSE ONE", context: `${title} IS BROKEN${short ? " · RELIQUARY EMPTY" : ""}`, cards };
  }

  // A relic choice (IMPROVEMENTS F9.3): the trial Reliquary (3 cards) or an elite's Relic Cache
  // (2 cards, RIFT-TOUCHED CACHE). opts { n, title, context, via } override the defaults.
  function relicOffer(event, run) {
    const cache = CACHE_KEY.test(event.key),
      opts = event.opts ?? {},
      n = opts.n ?? (cache ? CACHE_RELICS : TRIAL_RELICS),
      via = opts.via ?? (cache ? "cache" : "reward");
    const { cards, short } = relicCards(run, n, via);
    const context = opts.context ?? (cache ? "A RIFT-TOUCHED ELITE FELL" : "");
    return {
      title: opts.title ?? (cache ? "RIFT-TOUCHED CACHE" : "RELIC · CHOOSE ONE"),
      context: short ? [context, "RELIQUARY EMPTY"].filter(Boolean).join(" · ") : context,
      cards,
    };
  }

  function contextLine(run) {
    const w = run.weapon;
    return [
      WEAPONS[w]?.label,
      run.build.mods.includes(w) ? MODS[w].name : null,
      DASH_TRAITS.find((d) => d.id === run.build.dash)?.name,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Statue and landmark dialogs (spec flow.md §12.2). options = [{ title, text, detail?,
  // onPick? }]; the last one must be "Leave" (Escape / pad B picks it). Returns false when a
  // choice is already open or the run is not in play.
  function decision(title, options) {
    const run = ctx.run;
    if (!run || run.activeReward || ctx.mode !== "play") return false;
    const event = { key: `decision:${decisionSerial++}`, type: "decision", preview: true };
    run.activeReward = event;
    ctx.input?.clear?.();
    setMode("upgrade");
    ctx.menus?.choice?.({
      title,
      context: "",
      preview: true,
      cards: options.map((option) => presentCard(option, () => decide(event, option))),
    });
    ctx.hud?.update?.();
    return true;
  }

  function decide(event, option) {
    const run = ctx.run;
    if (!run || run.activeReward !== event) return;
    option.onPick?.();
    resumeAfterChoice(run);
  }

  function buildText(details = false) {
    const run = ctx.run;
    return describeBuild(run?.build ?? createBuild(), details, {
      relics: run?.relics?.map((r) => r.id),
      omens: ctx.omens?.active?.(),
    });
  }

  // Practice builds (IMPROVEMENTS §3.0.3): { level, upgrades, mods, relics } at once. The level
  // rises along the XP curve; upgrades (ids or names) apply in order like picked cards, and
  // when omitted one upgrade per level gained is drawn from `streamName`; mods are weapon-mod
  // ids; relics are granted as in play (KEEPERS). Returns true when a build was applied.
  function grantBuild({ level, upgrades = null, mods = [], relics = [] } = {}, streamName = "cards") {
    const run = ctx.run,
      p = run?.player;
    if (!p) return false;
    const gained = Math.max(0, Math.floor(level ?? p.level) - p.level);
    for (let i = 0; i < gained; i++) {
      p.level += 1;
      p.next = Math.floor(p.next * 1.3 + 3);
    }
    if (upgrades) {
      for (const u of upgrades) if (UPGRADES[upgradeIdOf(u)]) applyOrdinary(run, upgradeIdOf(u));
    } else {
      const rng = run.stream?.(streamName) ?? run.rng;
      for (let i = 0; i < gained; i++) applyOrdinary(run, firstOf(availableUpgrades(p), rng));
    }
    for (const id of mods) if (MODS[id] && !run.build.mods.includes(id)) run.build.mods.push(id);
    for (const id of relics) ctx.relics?.grant?.(id, "practice");
    ctx.hud?.update?.();
    return true;
  }

  // Run start: the old run's open card goes away with it.
  function clear() {
    ctx.menus?.hideChoice?.();
    if (ctx.run) ctx.run.activeReward = null;
  }

  return {
    update,
    queue,
    showNext,
    ordinaryOptions,
    decision,
    buildText,
    clear,
    grantBuild,
    get pending() {
      return !!ctx.run?.rewards?.pending;
    },
  };
}
