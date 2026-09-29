// Tutorial ("Rift Cloister", spec flow.md §20): seven steps that each advance only on their own
// action, a five-monster combat wave, then the training rift. The player, combat and the
// director report actions through event(); the guide copy follows the current bindings and
// the last-used input device. The toll step (IMPROVEMENTS F2) is optional: a bell tolls
// harmless bands that the player learns to dash through, and it ends by itself after three.
import { WEAPONS } from "../data/weapons.js";
import { FLOW } from "../data/stages.js";
import { keyLabel } from "../input/preferences.js";
import { TAU } from "../core/util.js";

export const TUTORIAL_STEPS = Object.freeze(["move", "dash", "toll", "shoot", "weapon", "combat", "rift"]);
const MOVE_GOAL = 5; // metres walked before the dash step
const WAVE_RADIUS = 11;
const WAVE_SKITTER = 2; // index of the one skitter in the combat wave

// The toll step: the bell stands `ahead` metres toward the Cloister gate; its first toll comes
// `first` seconds into the step, then one every `period`, each warned `warn` seconds ahead. A
// band grows from `from` to `to` metres at `speed` m/s, `half` wide either side; the player's
// body adds `reach`. It deals no damage.
export const TOLL = Object.freeze({ ahead: 12, first: 1.2, period: 3, warn: 0.6, from: 1, to: 14, speed: 6, half: 0.6, reach: 0.45, bands: 3 });
const TOLL_MARK = 2; // radius of the warning marker on the bell
const TOLL_COLOR = "#ffd9b0"; // the "wave" telegraph colour, for the touch flash
const TOLL_FLASH = 0.25;

// The band's radius `age` seconds after its toll.
export const tollRadius = (age) => TOLL.from + age * TOLL.speed;
// True when a player `d` metres from the bell stands in a band of radius r.
export const inTollBand = (r, d) => Math.abs(d - r) < TOLL.half + TOLL.reach;

export function createTutorialState() {
  return {
    step: "move",
    distance: 0,
    kills: 0,
    initialWeapon: 0,
    completed: false,
    finished: false,
    get number() {
      return TUTORIAL_STEPS.indexOf(this.step) + 1;
    },
  };
}

// Returns true when the step changed. The toll step advances on "toll" (a band phased through,
// or the third band gone).
export function advanceTutorial(t, action, value = 0) {
  const before = t.step;
  if (t.step === "move" && action === "move") {
    t.distance += Number(value) || 0;
    if (t.distance >= MOVE_GOAL) t.step = "dash";
  } else if (t.step === "dash" && action === "dash") t.step = "toll";
  else if (t.step === "toll" && action === "toll") t.step = "shoot";
  else if (t.step === "shoot" && action === "shoot") {
    t.initialWeapon = value;
    t.step = "weapon";
  } else if (t.step === "weapon" && action === "weapon" && value !== t.initialWeapon) t.step = "combat";
  else if (t.step === "combat" && action === "kill") {
    t.kills++;
    if (t.kills >= FLOW.TUTORIAL_GOAL) t.step = "rift";
  }
  return t.step !== before;
}

// "3 / 7", tagged OPTIONAL on the toll step.
export const tutorialStepLabel = (t) => `${t.number} / ${TUTORIAL_STEPS.length}${t.step === "toll" ? " · OPTIONAL" : ""}`;

// Guide text for a step. device: "touch" | "pad" | "keyboard"; weapon: a WEAPONS entry; radar:
// whether the radar is on (the rift step then points at it, F16).
export function tutorialCopy(t, { bindings = {}, device = "keyboard", weapon = WEAPONS[0], radar = false } = {}) {
  const key = (action) => keyLabel(bindings[action]);
  const by = (touch, pad, keyboard) => (device === "touch" ? touch : device === "pad" ? pad : keyboard);
  let title, hint;
  switch (t.step) {
    case "move":
      title = "MOVE";
      hint = by(
        "Use the left stick to move.",
        "Left stick · Move around the courtyard.",
        `${["forward", "left", "back", "right"].map(key).join(" / ")} · Move around the courtyard.`,
      );
      break;
    case "dash":
      title = "DASH";
      hint = by("Tap DASH while moving to evade danger.", "A · Dash while moving to evade danger.", `${key("dash")} · Dash while moving to evade danger.`);
      break;
    case "toll":
      title = "DASH THROUGH THE TOLL";
      hint = "Dash toward the bell as the wave reaches you. Dashing makes you untouchable for a moment.";
      break;
    case "shoot":
      title = "AIM & FIRE";
      hint = by("Right stick to aim. Hold FIRE to shoot.", "Right stick to aim. Right trigger to fire.", `Aim with the mouse. Hold ${key("fire")} to fire.`);
      break;
    case "weapon":
      title = "SWITCH WEAPONS";
      hint = by(
        "Tap a different weapon along the bottom.",
        "Use either bumper to switch weapons.",
        `${key("weapon1")}–${key("weapon5")} or click a weapon slot. Try another weapon.`,
      );
      break;
    case "combat":
      title = `DEFEAT ${FLOW.TUTORIAL_GOAL} ENEMIES`;
      hint = `${t.kills} / ${FLOW.TUTORIAL_GOAL} · Try your weapons. Keep moving; solid stone blocks shots.`;
      break;
    default:
      title = "ENTER THE RIFT";
      hint = `Follow the arrow. Step into the rift to finish.${radar ? " · The radar marks it in violet." : ""}`;
  }
  return { title, hint, weapon: `${weapon.label} · ${weapon.description}` };
}

export function createTutorial(ctx) {
  let prefsVersion = 0;
  // The last rendered view and what it was built from (render() runs every play step).
  let view = null;
  const shown = { step: "", kills: -1, device: "", weapon: -1, prefs: -1 };
  // The toll step's bell while it runs: { x, z, clock, tolls, warning, bands: [{ r, marker, spent }] }.
  let bell = null;

  function begin() {
    const t = createTutorialState();
    if (ctx.run) ctx.run.tutorial = t;
    view = null;
    bell = null;
    return t;
  }

  // action: "move" (metres this step) | "dash" | "toll" | "shoot" (weapon slot) | "weapon"
  // (new slot) | "kill" (the enemy). Counts only while playing.
  function event(action, value = 0) {
    const t = ctx.run?.tutorial;
    if (!t || t.finished || ctx.mode !== "play") return false;
    const changed = advanceTutorial(t, action, value);
    if (changed && t.step === "combat") spawnWave();
    return changed;
  }

  // Five weak monsters around the player (tutorial stats come from ctx.enemies.spawn).
  function spawnWave() {
    const p = ctx.run?.player;
    if (!p) return;
    for (let i = 0; i < FLOW.TUTORIAL_GOAL; i++) {
      const a = (i * TAU) / FLOW.TUTORIAL_GOAL;
      ctx.enemies?.spawn?.(i === WAVE_SKITTER ? "skitter" : "runner", { x: p.x + Math.sin(a) * WAVE_RADIUS, z: p.z + Math.cos(a) * WAVE_RADIUS });
    }
  }

  // ---- the toll step (simulation steps only) ------------------------------------------------

  // The Cloister's bell prop when the world placed one, else a point `ahead` metres from the
  // player toward the gate.
  function placeBell(p) {
    const prop = ctx.world?.shrineBell;
    if (prop) return { x: prop.x, z: prop.z };
    const [gx, gz] = FLOW.TUTORIAL_PORTAL;
    const d = Math.hypot(gx - p.x, gz - p.z) || 1;
    const x = p.x + ((gx - p.x) / d) * TOLL.ahead;
    const z = p.z + ((gz - p.z) / d) * TOLL.ahead;
    return ctx.world?.terrain?.safeNear?.(x, z, 0.5) ?? { x, z };
  }

  function removeBell() {
    if (!bell) return;
    ctx.tele?.remove?.(bell.warning);
    for (const band of bell.bands) ctx.tele?.remove?.(band.marker);
    bell = null;
  }

  function toll() {
    ctx.tele?.remove?.(bell.warning);
    bell.warning = null;
    bell.tolls++;
    ctx.world?.shrineBell?.ring?.();
    ctx.audio?.fx?.("toll", 0.6, bell);
    const marker = ctx.tele?.band?.(bell.x, bell.z, TOLL.from, TOLL.half, "wave", { targetsPlayer: true }) ?? null;
    bell.bands.push({ r: TOLL.from, marker, spent: false });
  }

  // A band reached the player: a dash phases through it and ends the step; otherwise the touch
  // is felt (sound and a flash of the band) but costs nothing.
  function touch(band, p) {
    band.spent = true;
    if (p.dashing > 0) return true;
    ctx.audio?.fx?.("hurt", 1, p);
    ctx.fx?.ring?.(bell.x, bell.z, TOLL_COLOR, band.r, TOLL_FLASH);
    return false;
  }

  // Grows every band; true once the player phased through one.
  function sweepBands(p, dt) {
    const d = Math.hypot(p.x - bell.x, p.z - bell.z);
    let phased = false;
    for (let i = bell.bands.length - 1; i >= 0; i--) {
      const band = bell.bands[i];
      band.r += TOLL.speed * dt;
      if (band.r >= TOLL.to) {
        ctx.tele?.remove?.(band.marker);
        bell.bands.splice(i, 1);
        continue;
      }
      ctx.tele?.set?.(band.marker, { radius: band.r });
      if (!band.spent && inTollBand(band.r, d) && touch(band, p)) phased = true;
    }
    return phased;
  }

  function update(dt) {
    const t = ctx.run?.tutorial;
    const p = ctx.run?.player;
    if (!t || t.finished || !p) return;
    if (t.step !== "toll") {
      removeBell();
      return;
    }
    bell ??= { ...placeBell(p), clock: 0, tolls: 0, warning: null, bands: [] };
    bell.clock += dt;
    const due = TOLL.first + bell.tolls * TOLL.period;
    if (bell.tolls < TOLL.bands && !bell.warning && bell.clock >= due - TOLL.warn) {
      bell.warning = ctx.tele?.area?.(bell.x, bell.z, TOLL_MARK, "wave", { eta: TOLL.warn, targetsPlayer: true }) ?? null;
      ctx.audio?.fx?.("warnRing", 1, bell);
    }
    if (bell.tolls < TOLL.bands && bell.clock >= due) toll();
    const phased = sweepBands(p, dt);
    if (phased || (bell.tolls >= TOLL.bands && !bell.bands.length)) {
      removeBell();
      event("toll");
    }
  }

  const deviceCopy = () => {
    const device = ctx.input?.device;
    return device === "pad" || device === "touch" ? device : "keyboard";
  };

  // The HUD view { title, hint, weapon, step }; rebuilt only when something it shows changed.
  function render() {
    const run = ctx.run;
    const t = run?.tutorial;
    if (!t) return null;
    const device = deviceCopy();
    if (view && shown.step === t.step && shown.kills === t.kills && shown.device === device && shown.weapon === run.weapon && shown.prefs === prefsVersion)
      return view;
    Object.assign(shown, { step: t.step, kills: t.kills, device, weapon: run.weapon, prefs: prefsVersion });
    const copy = tutorialCopy(t, { bindings: ctx.prefs?.bindings, device, weapon: WEAPONS[run.weapon] ?? WEAPONS[0], radar: ctx.prefs?.radar !== "off" });
    view = { ...copy, step: tutorialStepLabel(t) };
    return view;
  }

  // Entering the rift (completed), EXIT TUTORIAL or death: back to the menu, no score.
  function finish(completed) {
    const run = ctx.run;
    const t = run?.tutorial;
    if (!t || t.finished) return;
    t.finished = true;
    t.completed = !!completed;
    removeBell();
    const summary = { tutorial: true, completed: t.completed };
    const outcome = t.completed ? "victory" : run.player?.hp > 0 ? "quit" : "defeat";
    ctx.bus.emit("runEnd", { run, outcome, summary });
    ctx.director?.returnToMenu?.(summary);
  }

  // Rebinding and the radar setting change the copy.
  ctx.bus.on("prefs", () => prefsVersion++);

  return { begin, event, update, render, finish };
}
