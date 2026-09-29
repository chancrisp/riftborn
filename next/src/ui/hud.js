// In-run HUD: mirrors ctx.run into the DOM (spec ui.md §4-5). Every writer remembers the last
// value it wrote, so a steady frame touches nothing; the caches are invalidated whenever a new
// run begins because other systems hide or clear HUD pieces between runs.
// update(dt) refreshes the run readouts (called in play); combat(dt) runs every step in every
// mode and owns everything that must track the camera or hide outside play.
//
// Wave 2 (IMPROVEMENTS P7): the widgets live in small modules created here: the radar
// (radar.js), threat arrows and the hurt ring (hud-threats.js), sound captions
// (hud-captions.js), the chain line, feat cue and relic strip (hud-rift.js, KEEPERS only), elite
// plates (hud-elites.js) and the §3.13 slot table with its overlap check (hud-layout.js). This
// file adds the keeper boss bar (labels, gate ticks, grey floor, node pips), elite bars, dash
// pips 1–4, the Rift score, the omen meter, the cache chip, the FIRE LOCK chip, the toast
// budget and the UI scale.
import { WEAPONS } from "../data/weapons.js";
import { STAGES } from "../data/stages.js";
import { DASH, POWERUPS, BALANCE } from "../data/progression.js";
import { AFFIXES } from "../data/affixes.js";
import { OMENS } from "../data/omens.js";
import { keyLabel } from "../input/preferences.js";
import { clamp, formatInt, formatTime } from "../core/util.js";
import { createRadar } from "./radar.js";
import { iconSvg } from "./icons.js";
import { UI_SCALED, findOverlaps, measureSlots } from "./hud-layout.js";
import { createThreats } from "./hud-threats.js";
import { createCaptions } from "./hud-captions.js";
import { createChainLine, createFeatCue, createRelicStrip } from "./hud-rift.js";
import { createElitePlates, plateTitle } from "./hud-elites.js";
import { createToastBudget } from "./hud-toasts.js";

const TOAST_SECONDS = 2.2;
const TOAST_BACKLOG = 3; // pending toasts kept behind the one on screen
const TOAST_SHARE = 1.1; // an equally urgent toast waiting cuts the current one to this much time
const TOAST_PREEMPT = 0.35; // a more urgent toast replaces a lesser one after this long
const TOAST_STALE = 3; // low-priority news (pickups, surges) that waited this long is dropped
const PRIORITY = Object.freeze({ low: 0, normal: 1, high: 2 });
// Default urgency for the catalogue strings (flow.md §23) when a caller passes none: stage,
// boss and objective news is never dropped; pickups and surges yield to everything else.
const URGENT = [
  /^STAGE \d/,
  /^RIFT PORTAL OPEN/,
  /^TRAINING RIFT OPEN/,
  /^THE RIFT WARDEN/,
  /^WARDEN ENRAGED/,
  /^IRON MAW/,
  /^RIFT (NODES|INTERRUPTED|COLLAPSE)/,
  /^TRIAL COMPLETE/,
];
const MINOR = ["RIFT SURGE", ...Object.values(POWERUPS).map((p) => p.label)];

const CUE_SECONDS = 1.1;
const HIT_MARKER = 0.12;
const CHIP_HOLD = 0.5; // boss chip damage lingers before draining
const CHIP_DRAIN = 0.5; // bar fraction per second
const WARDEN_PHASE = 0.5; // the Warden enrages below half health
const HEAD_HEIGHT = 2.8;
const FEET_HEIGHT = 0.15;
const BAR_HEIGHT = 2.25;
const DARK_BARS = 14; // Omen of Darkness: enemy bars hide beyond this many metres
const MAX_DASH_PIPS = 4;
const MAX_TICKS = 4;
const BOSS_READ_EVERY = 4; // boss bar labels, ticks, floor and pips are re-read every 4th step
// Heal pops (F16.5): heals within 0.3 s merge into one green +N; a green ring and a 2-frame
// flash of the vitals fill greet the first heal of a window.
export const HEAL_POP = Object.freeze({ merge: 0.3, color: "#7bdc8f", ring: "#8fce95", ringSize: 1.2, ringLife: 0.35, flash: "#b8f0c0", frames: 2, lift: 3.1 });
const WARDEN_TICKS = Object.freeze([WARDEN_PHASE]);
const NO_TICKS = Object.freeze([]);
const NONE = Object.freeze([]);
const TUTORIAL_STEPS = Object.freeze(["move", "dash", "shoot", "weapon", "combat", "rift"]);
const STORM_MOD = 1; // MODS index of Storm Needle, which modifies STINGER (slot 1)
const TIMED_BOONS = Object.keys(POWERUPS).filter((k) => POWERUPS[k].duration > 0);
const WEAPON_ACTIONS = WEAPONS.map((_, i) => `weapon${i + 1}`);
const HUD_ROOTS = [
  "header", "#status", "#weapons", "#playerVitals", "#dashPips", "#crosshair", "#waveToast", "#damageNumbers",
  "#portalCompass", "#bossHUD", "#stageObjective", "#trialStatus", "#modStatus", "#powerupStatus",
  "#difficultyMeter", "#interactPrompt", "#trackedGoal", "#buildCue", "#tutorialGuide", "#radar",
  "#threatEdge", "#hurtRing", "#captions", "#featCue", "#relicStrip", "#elitePlates",
];

const round1 = (v) => Math.round(v * 10) / 10;
const sizeOf = (collection) => collection?.size ?? collection?.length ?? 0;
const isWarden = (e) => e.kind === "warden" || e.boss === "warden";
const isMaw = (e) => !!e.miniboss || e.boss === "ironmaw";
// The boss bar's subject: any keeper (KEEPERS only), else the Wave-1 Warden or Iron Maw.
const isBoss = (e) => !!e.keeper || isWarden(e) || isMaw(e);

function healthColor(ratio) {
  if (ratio > 0.65) return "#7bdc8f";
  if (ratio > 0.4) return "#e6cf67";
  if (ratio > 0.2) return "#ec9a54";
  return "#d85d57";
}

// Screen-space angle of the portal with y pointing down; 0 = the glyph's native "right".
function portalBearing(dx, dz, yaw) {
  return Math.atan2(Math.sin(yaw) * dx + Math.cos(yaw) * dz, Math.cos(yaw) * dx - Math.sin(yaw) * dz);
}

function toastRank(priority, text) {
  if (typeof priority === "number" && Number.isFinite(priority)) return priority;
  if (typeof priority === "string" && priority in PRIORITY) return PRIORITY[priority];
  if (URGENT.some((pattern) => pattern.test(text))) return PRIORITY.high;
  if (MINOR.some((prefix) => text.startsWith(prefix))) return PRIORITY.low;
  return PRIORITY.normal;
}

// "{n} / 6" from a step number, a step name ("move"...) or ready-made text.
function tutorialStepText(step) {
  if (typeof step === "number") return `${step} / ${TUTORIAL_STEPS.length}`;
  const index = TUTORIAL_STEPS.indexOf(step);
  return index >= 0 ? `${index + 1} / ${TUTORIAL_STEPS.length}` : String(step ?? "");
}

// The difficulty meter line: `CURSE 115% · X1.45` under KEEPERS (X is the Rift multiplier M),
// the Wave-1 `Statue curse: 115%` under ORIGINAL.
export function meterText(bonus, multiplier, original = false) {
  return original ? `Statue curse: ${100 + bonus}%` : `CURSE ${100 + bonus}% · X${(Number(multiplier) || 1).toFixed(2)}`;
}

export function createHud(ctx) {
  const $ = (selector) => document.querySelector(selector);
  const slots = [];

  // One DOM property plus the last value written to it. `write` formats the value, so callers
  // can pass cheap primitives (numbers) and strings are only built when something changed.
  function slot(el, write) {
    const s = {
      last: undefined,
      set(value) {
        if (!el || value === s.last) return;
        s.last = value;
        write(el, value);
      },
    };
    slots.push(s);
    return s;
  }
  const text = (el, format = String) => slot(el, (node, v) => (node.textContent = format(v)));
  const flag = (el, name) => slot(el, (node, on) => node.classList.toggle(name, on));
  const style = (el, prop, unit = "") => slot(el, (node, v) => (node.style[prop] = v + unit));
  const span = (className) => {
    const el = document.createElement("span");
    el.className = className;
    return el;
  };

  // UI scale (F18.6): the static HUD roots zoom with --ui-scale, as the Wave-2 widgets do.
  for (const selector of UI_SCALED) $(selector)?.classList.add("ui-scaled");

  const els = {
    crosshair: $("#crosshair"),
    toast: $("#waveToast"),
    weapons: $("#weapons"),
    numbers: $("#damageNumbers"),
    vitals: $("#playerVitals"),
    pips: $("#dashPips"),
    shield: $("#shieldBar"),
    compass: $("#portalCompass"),
    boss: $("#bossHUD"),
    interact: $("#interactPrompt"),
    guide: $("#tutorialGuide"),
    meter: $("#difficultyMeter"),
    powerups: $("#powerupStatus"),
  };
  const boss = createBossParts(els.boss, $("#bossFill")?.parentElement);
  const meter = splitMeter(els.meter);
  const powerups = splitPowerups(els.powerups);
  const fireLock = createFireLock();

  // A new run is bound (and the per-run state reset) before any widget hears its events, so the
  // reset never eats a run's first caption, hit, chain or feat.
  for (const type of ["sound", "playerHit", "chain", "feat"]) ctx.bus.on(type, () => bindRun());

  // #radar (F16.1): it reads prefs.radar / radarRange itself and hides outside runs, in
  // sequences, menus and the demo.
  const radar = createRadar(ctx);
  const groundAt = (x, z) => {
    const h = ctx.world?.height?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const threats = createThreats(ctx, { groundAt });
  const captions = createCaptions(ctx, { threats, bearingOf: threats.compassBearing, onScreen: sourceOnScreen });
  const chain = createChainLine(ctx, $("#status .vitals") ?? $("#status"));
  const featCue = createFeatCue(ctx);
  const relicStrip = createRelicStrip(ctx);
  const plates = createElitePlates(ctx);
  const budget = createToastBudget();

  const dom = {
    sector: text($("#sector")),
    clock: text($("#clock"), formatTime),
    hostiles: text($("#hostiles"), (n) => `${n} HOSTILES`),
    level: text($("#level")),
    healthText: text($("#healthText")),
    healthBar: style($("#healthBar"), "width", "%"),
    shieldBar: style(els.shield, "width", "%"),
    shieldHidden: flag(els.shield, "hidden"),
    xpBar: style($("#xpBar"), "width", "%"),
    // The key is the rounded score doubled, plus 1 for the Rift score (F11: `12,400 RIFT`).
    score: text($("#score"), (k) => `${formatInt(Math.floor(k / 2))} ${k % 2 ? "RIFT" : "SCORE"}`),
    dashStatus: text($("#dashStatus")),
    vitalsNumber: text($("#playerHealthNumber")),
    vitalsFill: style($("#playerHealthFill"), "width", "%"),
    vitalsColor: style($("#playerHealthFill"), "backgroundColor"),
    dashPips: createDashPips(els.pips),
    vitalsLeft: style(els.vitals, "left", "px"),
    vitalsTop: style(els.vitals, "top", "px"),
    pipsLeft: style(els.pips, "left", "px"),
    pipsTop: style(els.pips, "top", "px"),
    vitalsOpacity: style(els.vitals, "opacity"),
    pipsOpacity: style(els.pips, "opacity"),
    crosshair: style(els.crosshair, "display"),
    confirmed: flag(els.crosshair, "confirmed"),
    compassHidden: flag(els.compass, "hidden"),
    compassAngle: slot($(".compass-arrow"), (node, deg) => (node.style.transform = `rotate(${deg}deg)`)),
    portalLabel: text($("#portalLabel")),
    portalDistance: text($("#portalDistance")),
    bossHidden: flag(els.boss, "hidden"),
    bossVigil: flag(els.boss, "vigil"),
    bossPhase: text($("#bossPhase")),
    bossFill: style($("#bossFill"), "width", "%"),
    bossChip: style($("#bossChip"), "width", "%"),
    bossFloor: style(boss?.floor, "width", "%"),
    bossPipsHidden: flag(boss?.pips, "hidden"),
    bossNodes: (boss?.nodes ?? []).map((node) => flag(node, "broken")),
    bossDeadline: style(boss?.deadline, "width", "%"),
    objective: text($("#stageObjective")),
    difficultyHidden: flag(els.meter, "hidden"),
    difficultyTitle: slot(els.meter, (node, v) => (node.title = v)),
    trial: text($("#trialStatus")),
    mod: text($("#modStatus"), (n) => (n < 0 ? "" : `STORM NEEDLE ${n} / ${BALANCE.stormHits}`)),
    powerups: text(powerups?.line),
    powerupsHidden: flag(els.powerups, "hidden"),
    cache: text(powerups?.cache, (n) => (n > 0 ? `CACHE · ${n}` : "")),
    cacheHidden: flag(powerups?.cache, "hidden"),
    fireLockHidden: flag(fireLock, "hidden"),
    interact: text(els.interact),
    interactHidden: flag(els.interact, "hidden"),
    interactTouchHidden: flag($("#interactTouch"), "hidden"),
    goal: text($("#trackedGoal")),
    goalHidden: flag($("#trackedGoal"), "hidden"),
    cue: text($("#buildCue")),
    guideHidden: flag(els.guide, "hidden"),
    guideTitle: text($("#tutorialTitle")),
    guideStep: text($("#tutorialStep")),
    guideHint: text($("#tutorialHint")),
    guideWeapon: text($("#tutorialWeapon")),
  };

  let boundRun = null;
  let updateStamp = -1;
  let combatStamp = -1;
  let hitMarker = 0;
  let cueLife = 0;
  let selectedWeapon = -1;
  const weaponSlots = []; // { button, num, code }
  const screen = { x: 0, y: 0, visible: false }; // reused camera projection result

  // Toasts: one on screen plus a short priority-ordered backlog, timed in simulation seconds.
  let toastNow = null; // { text, priority, duration, wait }
  let toastAge = 0;
  const toastQueue = [];

  // Enemy bars keyed by the enemy object; created on first damage, swept when it leaves the run.
  const bars = new Map();
  const spareBars = [];
  let barSweep = 0;
  const chip = { target: null, value: 1, delay: -1 };
  // Boss bar reads (label, ticks, floor, pips) are throttled; these hold the last ones.
  const bossRead = { target: null, step: 0, ticks: NO_TICKS };
  // The difficulty meter's last line and omen list.
  const meterState = { bonus: NaN, m: NaN, original: null, omens: null };
  // The open heal-pop window: HP gathered, sim seconds left, vitals flash frames left.
  const healPop = { amount: 0, wait: 0, flash: 0 };

  const playing = () => ctx.mode === "play" && !ctx.cinematic && !ctx.overlay;

  // Boss bar parts (F1.6): up to 4 gate ticks and the grey floor segment share the track's grid
  // cell; the Warden's node pips (two gems and the deadline) sit on the label row.
  function createBossParts(root, track) {
    if (!root || !track) return null;
    const floor = document.createElement("i");
    floor.className = "boss-floor";
    floor.setAttribute("aria-hidden", "true");
    track.append(floor);
    const ticks = [];
    for (let i = 0; i < MAX_TICKS; i++) {
      const tick = document.createElement("i");
      tick.className = "boss-tick";
      tick.setAttribute("aria-hidden", "true");
      tick.style.display = "none";
      track.append(tick);
      ticks.push({ el: tick, at: NaN, shown: false, passed: false });
    }
    const pips = span("boss-pips");
    pips.classList.add("hidden");
    pips.setAttribute("aria-hidden", "true");
    const nodes = [span("boss-node"), span("boss-node")];
    const clock = span("boss-deadline");
    const deadline = document.createElement("i");
    clock.append(deadline);
    pips.append(nodes[0], nodes[1], clock);
    root.append(pips);
    return { floor, ticks, pips, nodes, deadline };
  }

  // #difficultyMeter becomes a text span plus the omen chips (F12).
  function splitMeter(root) {
    if (!root) return null;
    const label = span("meter-text");
    const chips = span("omen-chips");
    root.replaceChildren(label, chips);
    return { label, chips };
  }

  // #powerupStatus becomes the timed-boon line plus the `CACHE · n` chip (F8).
  function splitPowerups(root) {
    if (!root) return null;
    const line = span("boon-line");
    const cache = span("cache-chip");
    cache.classList.add("hidden");
    root.replaceChildren(line, cache);
    return { line, cache };
  }

  // FIRE LOCK (F18.3): beside the weapon row, shown while a toggle-fire latch is on.
  function createFireLock() {
    const el = document.createElement("span");
    el.id = "fireLock";
    el.classList.add("hidden");
    el.setAttribute("role", "status");
    el.textContent = "FIRE LOCK";
    return el;
  }

  // Dash pips 1–4 (F9.4): the page has two; the HUD adds the rest, hidden until dashMax() grows.
  function createDashPips(root) {
    if (!root) return [];
    const list = [...(root.querySelectorAll?.(".dash-pip") ?? [])];
    while (list.length < MAX_DASH_PIPS) {
      const pip = span("dash-pip");
      pip.append(document.createElement("i"));
      root.append(pip);
      list.push(pip);
    }
    return list.map((pip) => ({
      fill: style(pip.querySelector?.("i") ?? pip.firstChild, "height", "%"),
      hidden: flag(pip, "hidden"),
    }));
  }

  // Per-run state belongs to exactly one run object: a new ctx.run resets it whichever system
  // (director start, demo restart, tutorial) created it and in whatever order they call us.
  function bindRun() {
    const run = ctx.run;
    if (run !== boundRun) {
      boundRun = run;
      resetForRun(run);
    }
    return run;
  }

  function resetForRun(run) {
    toastQueue.length = 0;
    budget.clear();
    hideToast();
    clear();
    captions.clear();
    featCue.clear();
    // Rows the previous run left behind must not flash before the first refresh of this one.
    dom.difficultyHidden.set(true);
    dom.trial.set("");
    dom.mod.set(-1);
    dom.powerups.set("");
    dom.cache.set(0);
    dom.cacheHidden.set(true);
    dom.powerupsHidden.set(true);
    dom.goalHidden.set(true);
    dom.shieldHidden.set(true);
    meterState.omens = null;
    meterState.bonus = NaN;
    healPop.amount = healPop.flash = 0;
    if (!run?.tutorial) dom.guideHidden.set(true);
    selectWeapon(run?.weapon ?? 0);
  }

  // Toasts.

  function toast(message, { priority, duration } = {}) {
    const run = bindRun();
    if (!run || run.demo || !message) return;
    const content = String(message);
    // The toast budget (§1.4): explicit priority-1 news shares one slot per 4 s of sim time.
    if (priority === 1 && !budget.offer(content, { priority, duration })) return;
    enqueueToast(content, priority, duration);
  }

  function enqueueToast(content, priority, duration) {
    const entry = {
      text: content,
      priority: toastRank(priority, content),
      duration: Number.isFinite(duration) && duration > 0 ? duration : TOAST_SECONDS,
      wait: 0,
    };
    if (toastNow?.text === entry.text) {
      // Repeats (a second pickup, the Maw "awaits" line on every kill) refresh instead of stacking.
      toastNow.priority = Math.max(toastNow.priority, entry.priority);
      toastNow.duration = Math.max(toastNow.duration - toastAge, entry.duration);
      toastAge = 0;
      slideIn();
      return;
    }
    const queued = toastQueue.find((t) => t.text === entry.text);
    if (queued) {
      queued.priority = Math.max(queued.priority, entry.priority);
      queued.duration = Math.max(queued.duration, entry.duration);
      queued.wait = 0;
      return;
    }
    const at = toastQueue.findIndex((t) => t.priority < entry.priority);
    toastQueue.splice(at < 0 ? toastQueue.length : at, 0, entry);
    trimToasts();
  }

  // Over the backlog, drop the oldest of the least urgent entries; high priority always stays.
  function trimToasts() {
    while (toastQueue.length > TOAST_BACKLOG) {
      let victim = -1;
      for (let i = 0; i < toastQueue.length; i++) {
        if (toastQueue[i].priority >= PRIORITY.high) continue;
        if (victim < 0 || toastQueue[i].priority < toastQueue[victim].priority) victim = i;
      }
      if (victim < 0) return;
      toastQueue.splice(victim, 1);
    }
  }

  function tickToasts(dt) {
    const released = budget.tick(dt);
    if (released) enqueueToast(released.message, released.options?.priority, released.options?.duration);
    for (let i = toastQueue.length - 1; i >= 0; i--) {
      const waiting = toastQueue[i];
      waiting.wait += dt;
      if (waiting.priority <= PRIORITY.low && waiting.wait > TOAST_STALE) toastQueue.splice(i, 1);
    }
    if (toastNow) {
      toastAge += dt;
      if (toastAge >= toastLimit()) hideToast();
    }
    if (!toastNow && toastQueue.length) showToast(toastQueue.shift());
  }

  // Screen time of the current toast given what waits behind it; lesser news never cuts it short.
  function toastLimit() {
    const next = toastQueue[0];
    if (!next || next.priority < toastNow.priority) return toastNow.duration;
    return Math.min(toastNow.duration, next.priority > toastNow.priority ? TOAST_PREEMPT : TOAST_SHARE);
  }

  function showToast(entry) {
    toastNow = entry;
    toastAge = 0;
    if (els.toast) els.toast.textContent = entry.text;
    slideIn();
  }

  function hideToast() {
    toastNow = null;
    toastAge = 0;
    els.toast?.classList.remove("show");
  }

  // The stepped slide-in lives in CSS keyframes on `.show`; re-adding the class restarts it.
  function slideIn() {
    const el = els.toast;
    if (!el || !toastNow) return;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  // Small public setters.

  function cue(message) {
    const run = bindRun();
    const value = message && !run?.demo ? String(message) : "";
    dom.cue.set(value);
    cueLife = value ? CUE_SECONDS : 0;
  }

  function setInteract(message) {
    const run = bindRun();
    const value = message && !run?.demo ? String(message) : "";
    dom.interact.set(value);
    dom.interactHidden.set(!value);
    dom.interactTouchHidden.set(!value);
  }

  function tutorial(view) {
    bindRun();
    if (!view) {
      dom.guideHidden.set(true);
      return;
    }
    dom.guideStep.set(tutorialStepText(view.step ?? ctx.run?.tutorial?.number));
    dom.guideTitle.set(String(view.title ?? ""));
    dom.guideHint.set(String(view.hint ?? ""));
    dom.guideWeapon.set(String(view.weapon ?? ""));
    dom.guideHidden.set(false);
  }

  function confirmHit() {
    hitMarker = HIT_MARKER;
  }

  function setVisible(visible) {
    for (const selector of HUD_ROOTS) {
      const el = $(selector);
      if (el) el.style.visibility = visible ? "" : "hidden";
    }
  }

  // Weapon bar.

  function buildWeaponBar() {
    if (!els.weapons) return;
    weaponSlots.length = 0;
    els.weapons.replaceChildren(...WEAPONS.map(weaponButton), fireLock);
    selectedWeapon = -1;
    selectWeapon(ctx.run?.weapon ?? 0);
    syncKeyLabels();
  }

  function weaponButton(w, i) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "weapon";
    button.style.setProperty("--rarity", w.color);
    button.title = `${i + 1}: ${w.label} — ${w.description}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", "false");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);
    const sprite = document.createElement("img");
    sprite.className = "weapon-sprite";
    sprite.src = w.sprite;
    sprite.alt = "";
    sprite.draggable = false;
    sprite.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = w.label;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = w.kind;
    button.append(num, sprite, name, kind);
    button.addEventListener("click", () => ctx.player?.equip?.(i));
    // A mouse click must not leave focus on the slot, or Space/Enter would re-press it mid-run.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    weaponSlots.push({ button, num, code: undefined });
    return button;
  }

  function selectWeapon(index) {
    if (!Number.isInteger(index) || index === selectedWeapon) return;
    selectedWeapon = index;
    for (let i = 0; i < weaponSlots.length; i++) {
      const active = i === index;
      weaponSlots[i].button.classList.toggle("active", active);
      weaponSlots[i].button.setAttribute("aria-pressed", String(active));
    }
  }

  // Slot numbers show the bound key (refreshHelp in the original), so rebinding relabels them.
  function syncKeyLabels() {
    const bindings = ctx.prefs?.bindings;
    for (let i = 0; i < weaponSlots.length; i++) {
      const code = bindings?.[WEAPON_ACTIONS[i]];
      if (code === weaponSlots[i].code) continue;
      weaponSlots[i].code = code;
      weaponSlots[i].num.textContent = code ? keyLabel(code) : String(i + 1);
    }
  }

  function syncPreferences() {
    const percent = Number(ctx.prefs?.playerIndicatorsOpacity);
    const opacity = Number.isFinite(percent) ? clamp(percent, 0, 100) / 100 : 1;
    dom.vitalsOpacity.set(opacity);
    dom.pipsOpacity.set(opacity);
    // A scaled-up HUD moves the weapon row to the right edge on narrower screens (hud.css).
    document.body?.classList?.toggle("ui-big", (Number(ctx.prefs?.uiScale) || 100) > 100);
    syncKeyLabels();
  }

  // Update: run readouts.

  function update(dt) {
    const run = bindRun();
    if (!run || run.demo || !run.player) return;
    // Timers advance once per simulation step: the director refreshes every play step, and
    // extra refreshes (dash, pickups, stage entry) may come in the same step or without a dt.
    let timerDt = 0;
    if (dt > 0 && ctx.time.sim !== updateStamp) {
      updateStamp = ctx.time.sim;
      if (playing()) {
        advanceTimers(dt);
        timerDt = dt;
      }
    }
    writeStatus(run.player, run);
    chain.update(timerDt, run);
    writeHeader(run);
    selectWeapon(run.weapon);
    writeCompass(run, run.player);
    writeEncounterRows(run);
    writeTrackedGoal(run);
    if (run.tutorial) {
      const view = ctx.tutorial?.render?.();
      if (view) tutorial(view);
    } else dom.guideHidden.set(true);
  }

  function advanceTimers(dt) {
    tickToasts(dt);
    if (cueLife > 0) {
      cueLife -= dt;
      if (cueLife <= 0) cue("");
    }
  }

  const dashMaxOf = () => clamp(ctx.player?.dashMax?.() ?? DASH.max, 1, MAX_DASH_PIPS);

  function writeStatus(p, run) {
    const max = p.max || 1;
    const hp = Math.max(0, p.hp);
    dom.level.set(p.level);
    dom.healthText.set(`${Math.ceil(hp)} / ${p.max}`);
    dom.healthBar.set(round1(clamp(hp / max, 0, 1) * 100));
    dom.xpBar.set(round1(clamp((100 * p.xp) / (p.next || 1), 0, 100)));
    // KEEPERS reads the Rift Score (`12,400 RIFT`); the base score shows in pause and results.
    const rift = run.rift && !run.original;
    dom.score.set(Math.round((rift ? run.rift.score : run.score) || 0) * 2 + (rift ? 1 : 0));
    // Bone Ward: the shield points ride on the health track as their own band.
    const shield = run.boons?.ward > 0 ? run.boons.shield || 0 : 0;
    dom.shieldHidden.set(shield <= 0);
    dom.shieldBar.set(round1(clamp((100 * shield) / max, 0, 100)));
    const charges = p.dashCharges;
    const dashes = dashMaxOf();
    const cd = Math.max(0, p.dashCD || 0);
    dom.dashStatus.set(charges < dashes ? `${charges} / ${dashes} DASHES · ${cd.toFixed(1)}s` : `${charges} / ${dashes} DASHES READY`);
  }

  function writeHeader(run) {
    dom.sector.set(run.tutorial ? "TUTORIAL · RIFT CLOISTER" : `STAGE ${run.stage} · ${STAGES[run.stage - 1]?.name || "VOID"}`);
    dom.clock.set(Math.floor(run.elapsed || 0));
    let hostiles = 0;
    for (const e of run.enemies) if (e.hp > 0) hostiles++;
    dom.hostiles.set(hostiles);
  }

  // The GRAPHICS row prefs.portalCompass (F16) can switch the compass off.
  function writeCompass(run, p) {
    const portal = ctx.world?.portal;
    const shown =
      !!portal &&
      ctx.prefs?.portalCompass !== false &&
      ctx.mode === "play" &&
      run.stage < STAGES.length &&
      (!run.tutorial || run.tutorial.step === "rift");
    dom.compassHidden.set(!shown);
    if (!shown) return;
    const dx = portal.x - p.x;
    const dz = portal.z - p.z;
    const eye = ctx.gfx?.camera?.position;
    const viewYaw = eye ? Math.atan2(eye.x - p.x, eye.z - p.z) : ctx.cam?.yaw || 0;
    dom.compassAngle.set(round1((portalBearing(dx, dz, viewYaw) * 180) / Math.PI));
    dom.portalLabel.set(portalLabel(run));
    dom.portalDistance.set(
      run.portalActive
        ? `${Math.round(Math.hypot(dx, dz))}m · ${run.tutorial ? "ENTER TO FINISH" : "ENTER TO DESCEND"}`
        : `${run.stageKills} / ${run.stageGoal} KILLS TO OPEN`,
    );
  }

  function portalLabel(run) {
    if (run.quarryState === "waiting") return "COMPLETE OR ABANDON TRIAL";
    if (run.stage === 2 && run.quarryState === "active") return "DEFEAT IRON MAW";
    return run.portalActive ? "RIFT PORTAL OPEN" : "RIFT PORTAL LOCKED";
  }

  function writeEncounterRows(run) {
    writeMeter(run);
    dom.trial.set(trialLine(run));
    dom.mod.set(run.build?.mods?.includes(STORM_MOD) && run.weapon === STORM_MOD ? run.build.charge || 0 : -1);
    const line = powerupLine(run.boons);
    const caches = run.original ? 0 : run.cachesPending || 0;
    dom.powerups.set(line);
    dom.cache.set(caches);
    dom.cacheHidden.set(caches <= 0);
    dom.powerupsHidden.set(!line && caches <= 0);
  }

  // The curse meter (F12): shown while the curse is up or an omen is active; under KEEPERS it
  // carries M and the omen chips, whose tooltip lists each omen and its twist.
  function writeMeter(run) {
    const bonus = run.difficultyBonus || 0;
    const original = !!run.original;
    const omens = original ? NONE : (run.omens ?? NONE);
    const shown = bonus > 0 || omens.length > 0;
    dom.difficultyHidden.set(!shown);
    if (!shown || !meter) return;
    const m = original ? 1 : (ctx.scoring?.multiplier?.() ?? 1);
    if (bonus !== meterState.bonus || m !== meterState.m || original !== meterState.original) {
      meterState.bonus = bonus;
      meterState.m = m;
      meterState.original = original;
      meter.label.textContent = meterText(bonus, m, original);
    }
    if (omens !== meterState.omens) {
      meterState.omens = omens;
      let chips = "";
      for (const id of omens) chips += iconSvg(id, 2);
      meter.chips.innerHTML = chips;
      dom.difficultyTitle.set(omens.map((id) => (OMENS[id] ? `${OMENS[id].name} · ${OMENS[id].text}` : id)).join("\n"));
    }
  }

  function trialLine(run) {
    const trial = run.trial;
    if (trial?.state !== "active") return "";
    let line = `SKULL TRIAL · ${sizeOf(trial.roster)} MARKED HOSTILES`;
    if (run.stage === 4) {
      let anchors = 0;
      for (const o of run.objects) if (o.kind === "anchor" && o.owner === trial.id && o.hp > 0 && !o.dead) anchors++;
      line += ` · ${anchors} ANCHORS · 20% PROTECTION EACH`;
    }
    return `${line} · PAUSE TO ABANDON`;
  }

  function powerupLine(boons) {
    let line = "";
    if (!boons) return line;
    for (const kind of TIMED_BOONS) {
      if (!(boons[kind] > 0)) continue;
      line += `${line ? " · " : ""}${POWERUPS[kind].label} ${Math.ceil(boons[kind])}s`;
    }
    return line;
  }

  // The profile caches its mastery entries, so reading the tracked one every refresh is cheap.
  function writeTrackedGoal(run) {
    const tracked = run.tutorial ? null : ctx.profile?.data?.mastery?.tracked;
    let goal = null;
    if (tracked) {
      for (const entry of ctx.profile.masteryEntries?.() ?? []) if (entry.id === tracked) goal = entry;
    }
    dom.goal.set(goal ? `${goal.title} · ${goal.current} / ${goal.target}` : "");
    dom.goalHidden.set(!goal || ctx.mode !== "play");
  }

  // Combat: every step, every mode.

  function combat(dt) {
    const run = bindRun();
    const fresh = ctx.time.sim !== combatStamp;
    if (fresh) {
      combatStamp = ctx.time.sim;
      if (dt > 0) hitMarker = Math.max(0, hitMarker - dt);
    }
    const live = !!run && !run.demo && !!run.player;
    const inPlay = live && playing();
    const simDt = fresh && dt > 0 && playing() ? dt : 0;
    if (fresh && healPop.flash > 0) healPop.flash--;
    if (healPop.amount > 0 && (healPop.wait -= simDt) <= 0) popHeal(run);
    // The radar shows or hides itself every step but only advances on played steps, so it
    // freezes with the game; the Wave-2 widgets follow the same rule.
    radar.update(simDt);
    threats.update(simDt, inPlay);
    captions.update(simDt, inPlay);
    featCue.update(simDt, inPlay);
    relicStrip.update(run, live && ctx.mode !== "menu" && ctx.mode !== "dead" && ctx.mode !== "sequence" && ctx.mode !== "transition");
    dom.fireLockHidden.set(!(inPlay && ctx.input?.fireLatched === true));
    if (!live) {
      hideCombat();
      return;
    }
    const onField = ctx.mode === "play";
    const mouseAim = !!ctx.input?.mouse?.moved && (ctx.input.device ?? "mouse") === "mouse";
    dom.crosshair.set(onField && mouseAim ? "block" : "none");
    dom.confirmed.set(hitMarker > 0);
    const subject = updateBars(run, onField);
    updateBoss(subject, onField, dt > 0 && playing() ? dt : 0);
    const summoning = run.stage === STAGES.length && !run.bossSpawned && !run.tutorial;
    dom.objective.set(
      summoning ? `${Math.min(run.stageKills, run.stageGoal)} / ${run.stageGoal} KILLS TO SUMMON THE WARDEN` : "",
    );
    writeIndicators(run.player);
    placeIndicators(run.player);
  }

  function hideCombat() {
    removeBars();
    plates.clear();
    chip.target = null;
    dom.bossHidden.set(true);
    dom.bossVigil.set(false);
    dom.crosshair.set("none");
    dom.objective.set("");
  }

  // Enemy bars: shown when damaged, and always for a rift-touched elite (fill in its first affix
  // colour, with a name plate). The Omen of Darkness hides bars beyond 14 m. Returns the boss
  // (first living keeper, Warden or Iron Maw) found on the same pass.
  function updateBars(run, inPlay) {
    const sweep = ++barSweep;
    const canProject = !!ctx.cam?.project;
    const p = run.player;
    const dark = !run.original && !!ctx.rules?.flag?.("darkBars");
    let subject = null;
    plates.begin();
    for (const e of run.enemies) {
      if (!subject && e.hp > 0 && isBoss(e)) subject = e;
      let bar = bars.get(e);
      if (bar) bar.sweep = sweep;
      const elite = !run.original && !!e.elite;
      if (!inPlay || !canProject || !(e.hp > 0 && (e.hp < e.max || elite))) {
        if (bar) showBar(bar, false);
        continue;
      }
      const dist = dark || elite ? Math.hypot(e.x - p.x, e.z - p.z) : 0;
      if (dark && dist > DARK_BARS) {
        if (bar) showBar(bar, false);
        continue;
      }
      const lift = (e.model?.g?.scale?.y ?? 1) * BAR_HEIGHT;
      const at = ctx.cam.project(e.x, groundAt(e.x, e.z) + lift, e.z, screen);
      if (!at.visible) {
        if (bar) showBar(bar, false);
        continue;
      }
      if (!bar) {
        bar = takeBar();
        if (!bar) continue;
        bar.sweep = sweep;
        bars.set(e, bar);
      }
      const x = Math.round(at.x);
      const y = Math.round(at.y);
      placeBar(bar, x, y, round1(clamp((e.hp / e.max) * 100, 0, 100)), elite ? (AFFIXES[e.elite[0]]?.color ?? "") : "");
      showBar(bar, true);
      if (elite) plates.consider(e, x, y, dist);
    }
    bars.forEach(dropUnswept);
    plates.commit();
    return subject;
  }

  // Map.forEach callback: bars whose enemy left the run this step go back to the pool.
  function dropUnswept(bar, e) {
    if (bar.sweep === barSweep) return;
    bars.delete(e);
    releaseBar(bar);
  }

  function takeBar() {
    const bar = spareBars.pop() ?? createBar();
    if (bar) els.numbers.append(bar.el);
    return bar;
  }

  function createBar() {
    if (!els.numbers) return null;
    const el = document.createElement("div");
    el.className = "enemy-health";
    el.style.display = "none";
    const fill = document.createElement("i");
    el.append(fill);
    return { el, fill, shown: false, left: NaN, top: NaN, width: NaN, color: "", sweep: 0 };
  }

  function releaseBar(bar) {
    showBar(bar, false);
    bar.el.remove();
    spareBars.push(bar);
  }

  function placeBar(bar, left, top, width, color) {
    if (left !== bar.left) bar.el.style.left = (bar.left = left) + "px";
    if (top !== bar.top) bar.el.style.top = (bar.top = top) + "px";
    if (width !== bar.width) bar.fill.style.width = (bar.width = width) + "%";
    if (color !== bar.color) {
      bar.fill.style.background = bar.color = color;
      bar.el.classList.toggle("elite", !!color);
    }
  }

  function showBar(bar, shown) {
    if (shown === bar.shown) return;
    bar.shown = shown;
    bar.el.style.display = shown ? "block" : "none";
  }

  function removeBars() {
    bars.forEach(releaseBar);
    bars.clear();
  }

  function updateBoss(subject, inPlay, dt) {
    dom.bossHidden.set(!subject || !inPlay);
    // The Castellan's vigil (F5): the bar's border pulses cyan from its windup to vigilEnd.
    dom.bossVigil.set(!!subject?.vigil);
    if (!subject) {
      chip.target = null;
      bossRead.target = null;
      return;
    }
    const ratio = clamp(subject.hp / subject.max, 0, 1);
    advanceChip(subject, ratio, dt);
    dom.bossFill.set(round1(ratio * 100));
    dom.bossChip.set(round1(chip.value * 100));
    // Labels, gate ticks, the grey floor and node pips come from the bosses system (F1.6),
    // re-read every 4th step or when the subject changes.
    if (bossRead.target !== subject || ++bossRead.step >= BOSS_READ_EVERY) {
      bossRead.target = subject;
      bossRead.step = 0;
      dom.bossPhase.set(ctx.bosses?.label ? ctx.bosses.label(subject) : bossLabel(subject));
      bossRead.ticks = ctx.bosses?.ticks ? (ctx.bosses.ticks(subject) ?? NO_TICKS) : isWarden(subject) && !subject.enraged ? WARDEN_TICKS : NO_TICKS;
      const floor = Number(ctx.bosses?.floor?.(subject)) || 0;
      dom.bossFloor.set(round1(clamp(floor / (subject.max || 1), 0, 1) * 100));
      writePips(ctx.bosses?.pips?.(subject) ?? null);
    }
    writeTicks(bossRead.ticks, ratio);
  }

  // Gate ticks at their HP fractions; a tick the bar has fallen past dims.
  function writeTicks(ticks, ratio) {
    if (!boss) return;
    for (let i = 0; i < boss.ticks.length; i++) {
      const t = boss.ticks[i];
      const at = i < ticks.length ? Number(ticks[i]) : NaN;
      const shown = at > 0 && at < 1;
      if (shown !== t.shown) t.el.style.display = (t.shown = shown) ? "" : "none";
      if (!shown) continue;
      if (at !== t.at) t.el.style.left = `calc(1px + (100% - 4px) * ${(t.at = at)})`;
      const passed = ratio < at;
      if (passed !== t.passed) t.el.classList.toggle("passed", (t.passed = passed));
    }
  }

  // [node 1 alive, node 2 alive, share of the deadline left] or null (F6).
  function writePips(pips) {
    dom.bossPipsHidden.set(!pips);
    if (!pips) return;
    for (let i = 0; i < dom.bossNodes.length; i++) dom.bossNodes[i].set(!pips[i]);
    dom.bossDeadline.set(Math.round(clamp(Number(pips[2]) || 0, 0, 1) * 100));
  }

  // Chip damage: the ghost bar holds where a burst started, then drains down to the real fill.
  function advanceChip(subject, ratio, dt) {
    if (chip.target !== subject || ratio >= chip.value) {
      chip.target = subject;
      chip.value = ratio;
      chip.delay = -1;
      return;
    }
    if (chip.delay < 0) chip.delay = CHIP_HOLD;
    if (chip.delay > 0) {
      chip.delay = Math.max(0, chip.delay - dt);
      return;
    }
    chip.value = Math.max(ratio, chip.value - CHIP_DRAIN * dt);
    if (chip.value <= ratio) chip.delay = -1;
  }

  // Fallback labels when no bosses system is present (the bosses system names every state).
  function bossLabel(subject) {
    if (isMaw(subject)) return subject.state === "stagger" ? "IRON MAW · STAGGERED" : "IRON MAW";
    const charge = activeNodeCharge(subject);
    if (charge) return `RIFT NODES ${charge.nodes ? sizeOf(charge.nodes) : liveNodes()} · ${Math.ceil(charge.remaining)}s`;
    if (subject.recovery > 0) return "WARDEN · EXPOSED";
    if (subject.enraged) return "ENRAGED";
    return isWarden(subject) ? "RIFT WARDEN" : String(subject.def?.name ?? "").toUpperCase();
  }

  // The Warden's node event ({ nodes, remaining }), from the bosses system or the boss itself.
  function activeNodeCharge(subject) {
    const source = ctx.bosses?.nodeCharge;
    const charge = typeof source === "function" ? ctx.bosses.nodeCharge() : (source ?? subject.nodeCharge);
    return Number.isFinite(charge?.remaining) ? charge : null;
  }

  function liveNodes() {
    let count = 0;
    for (const o of ctx.run?.objects || []) if (o.kind === "node" && o.hp > 0 && !o.dead) count++;
    return count;
  }

  // The indicators around the hero stay visible under pause, cards and cinematics, so unlike the
  // status block they refresh every step (a new run's opening sequence shows fresh values).
  function writeIndicators(p) {
    const hp = Math.max(0, p.hp);
    const ratio = clamp(hp / (p.max || 1), 0, 1);
    dom.vitalsNumber.set(Math.ceil(hp));
    dom.vitalsFill.set(round1(ratio * 100));
    dom.vitalsColor.set(healPop.flash > 0 ? HEAL_POP.flash : healthColor(ratio));
    const cd = Math.max(0, p.dashCD || 0);
    const max = dashMaxOf();
    for (let i = 0; i < dom.dashPips.length; i++) {
      const pip = dom.dashPips[i];
      pip.hidden.set(i >= max);
      const fill = i < p.dashCharges ? 100 : i === p.dashCharges ? 100 * (1 - cd / DASH.cooldown) : 0;
      pip.fill.set(Math.round(clamp(fill, 0, 100)));
    }
  }

  // Vitals ride 2.8 m above the hero's feet; dash pips sit just above the ground under them.
  function placeIndicators(p) {
    if (!ctx.cam?.project) return;
    const ground = groundAt(p.x, p.z);
    const head = ctx.cam.project(p.x, ground + HEAD_HEIGHT, p.z, screen);
    dom.vitalsLeft.set(Math.round(head.x));
    dom.vitalsTop.set(Math.round(head.y));
    const feet = ctx.cam.project(p.x, ground + FEET_HEIGHT, p.z, screen);
    dom.pipsLeft.set(Math.round(feet.x));
    dom.pipsTop.set(Math.round(feet.y));
  }

  // Heal pops (F16.5), silent in the demo: the first heal of a window rings and flashes, the
  // window's total pops when it closes.
  function onHeal({ amount = 0 } = {}) {
    const run = bindRun();
    const p = run?.player;
    if (!p || run.demo || !(amount > 0)) return;
    if (healPop.amount <= 0) {
      healPop.wait = HEAL_POP.merge;
      healPop.flash = HEAL_POP.frames;
      ctx.fx?.ring?.(p.x, p.z, HEAL_POP.ring, HEAL_POP.ringSize, HEAL_POP.ringLife);
    }
    healPop.amount += amount;
  }

  function popHeal(run) {
    const p = run?.player;
    const amount = Math.round(healPop.amount);
    healPop.amount = 0;
    if (!p || run.demo || amount <= 0) return;
    ctx.fx?.number?.(p.x, groundAt(p.x, p.z) + HEAL_POP.lift, p.z, amount, { color: HEAL_POP.color, text: `+${amount}` });
  }

  // A sound source on screen (captions of `explosion` only name off-screen blasts).
  function sourceOnScreen(x, z) {
    return !!ctx.cam?.project && ctx.cam.project(x, groundAt(x, z) + 1, z, screen).visible;
  }

  // Transient per-stage visuals. Queued toasts survive (a stage change toasts before it clears);
  // they are dropped only when a different run begins.
  function clear() {
    removeBars();
    plates.clear();
    chip.target = null;
    bossRead.target = null;
    hitMarker = 0;
    cue("");
    setInteract(null);
    dom.bossHidden.set(true);
    dom.bossVigil.set(false);
    dom.bossPipsHidden.set(true);
    writeTicks(NO_TICKS, 1);
    dom.compassHidden.set(true);
    dom.objective.set("");
    dom.confirmed.set(false);
    radar.clear();
    threats.clear();
    chain.clear();
    relicStrip.clear();
    for (const s of slots) s.last = undefined;
  }

  // ---- layout check (§3.13) ----

  // Shows every slot element with sample content in two states (stage play, and a keeper fight
  // with the boss bar and objective), measures them and restores the page, all in one call so
  // nothing is painted in between. Returns the overlapping pairs [{ state, a, b }].
  function checkLayout() {
    const found = [];
    for (const state of ["play", "keeper"]) {
      const undo = preview(state);
      for (const [a, b] of findOverlaps(measureSlots())) found.push({ state, a, b });
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    }
    return found;
  }

  function preview(state) {
    const undo = [captions.preview(), featCue.preview(), relicStrip.preview(), chain.preview()];
    const show = (el, sample) => {
      if (!el) return;
      const was = { hidden: el.classList.contains("hidden"), text: el.textContent };
      el.classList.remove("hidden");
      if (sample !== undefined) el.textContent = sample;
      undo.push(() => {
        if (sample !== undefined) el.textContent = was.text;
        el.classList.toggle("hidden", was.hidden);
      });
    };
    show(fireLock);
    show($("#radar"));
    show(els.compass);
    show(els.meter);
    show(meter?.label, "CURSE 115% · X1.45");
    show(els.powerups);
    show(powerups?.line, "SPEED 12s · RAPID FIRE 8s");
    show(powerups?.cache, "CACHE · 2");
    show($("#trackedGoal"), "WARDEN SLAYER · 3 / 5");
    show($("#modStatus"), `STORM NEEDLE 3 / ${BALANCE.stormHits}`);
    show(els.interact, "E · SKULL OMEN · +5% CURSE · +10% SCORE");
    if (state === "keeper") {
      show(els.boss);
      show($("#bossPhase"), "RIFT WARDEN · UNMADE · SHADE 2 / 4");
      show($("#stageObjective"), "12 / 20 KILLS TO SUMMON THE WARDEN");
    }
    return undo;
  }

  // The HUD lives for the whole page session, so these listeners are never removed. The
  // crosshair's position follows the mouse in input.js (window-wide); the HUD owns its
  // visibility and hit marker.
  ctx.bus.on("weapon", (event) => selectWeapon(event?.index));
  ctx.bus.on("enemyHit", confirmHit);
  ctx.bus.on("objectHit", confirmHit);
  ctx.bus.on("playerHit", threats.onHit);
  ctx.bus.on("playerHeal", onHeal);
  ctx.bus.on("sequence", (event) => (event?.active ? cue("") : slideIn()));
  ctx.bus.on("stageEnter", () => cue(""));
  ctx.bus.on("runEnd", () => cue(""));
  ctx.bus.on("prefs", syncPreferences);
  // Priority-1 news within the toast budget: elite arrivals (F8), first sightings (F19) and
  // unlocks (F19.4).
  ctx.bus.on("elite", (event) => {
    if (event?.event === "spawn" && event.e) toast(`A RIFT-TOUCHED ${plateTitle(event.e, ctx.elites?.title)} STIRS`, { priority: 1 });
  });
  ctx.bus.on("codex", (event) => {
    if (event?.name) toast(`NEW ENTRY · ${event.name}${event.short ? ` · ${event.short}` : ""}`, { priority: 1 });
  });
  ctx.bus.on("unlock", (event) => {
    if (event?.label) toast(`UNLOCKED · ${event.label}`, { priority: 1 });
  });

  buildWeaponBar();
  syncPreferences();

  return { buildWeaponBar, update, combat, toast, cue, setInteract, tutorial, setVisible, clear, confirmHit, checkLayout };
}
