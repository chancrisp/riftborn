// Menus, panels and modal dialogs: main menu and results, run setup (with the ruleset switch),
// pause (with confirm steps), the schema-driven settings tabs, the generic confirm dialog,
// choice cards, the cinematic caption with its stage and keeper title cards, and the floating
// Death Mode skull. Gameplay state lives in the director; this module renders it and forwards
// intent.
import {
  PREF_SCHEMA,
  SETTINGS_TABS,
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  keyLabel,
  effectivePref,
  assistedPrefs,
} from "../input/preferences.js";
import { WEAPONS } from "../data/weapons.js";
import { KEEPERS } from "../data/keepers.js";
import { SEQUENCES, stageDef } from "../data/stages.js";
import { PALETTES, THREAT_CLASSES } from "../data/palettes.js";
import { FEATS } from "../data/scoring.js";
import { RELICS } from "../data/relics.js";
import { createSkullFlames } from "./skull-flames.js";
import { seedCode } from "../core/rng.js";
import { clamp, formatInt } from "../core/util.js";
import { iconChip, iconKey, RARITY_COLORS } from "./icons.js";

const NAME_LIMIT = 16;
const PANEL_FOCUS = Object.freeze({
  "#runSetup": "#playerName",
  "#settings": "#closeSettings",
  "#leaderboard": "#closeLeaderboard",
  "#profile": "#closeProfile",
});
// Settings tab key -> the DOM name of its #tab / #panel pair.
const TAB_NAMES = Object.freeze({ graphics: "Graphics", audio: "Audio", controls: "Controls", access: "Access" });
const TABS = SETTINGS_TABS.map((key) => TAB_NAMES[key]);
const CARD_KEY = /^(?:Digit|Numpad)([1-9])$/;
const CONTROLLER_HELP = [
  ["Move / aim", "Left / right stick"],
  ["Fire / dash", "Right trigger / A"],
  ["Switch weapon", "Bumpers"],
  ["Interact", "X"],
  ["Pause", "Menu"],
  ["Menus", "D-pad / stick to focus, A confirm, B back. A cycles settings values. On-screen keyboard enters a username."],
];

const RESULT_TITLES = Object.freeze({ victory: ["RIFT", "CONQUERED"], defeat: ["RUN", "SEVERED"], ended: ["RUN", "COMPLETE"] });
const OUTCOME_LABELS = Object.freeze({ victory: "VICTORY", defeat: "DEFEATED", ended: "RUN ENDED" });
const MILESTONE_TEXT = Object.freeze({
  trial: "Trial complete + Skull badge",
  quarry: "Iron Maw defeated",
  warden: "Warden defeated + Ember trail",
  "keeper:bellwether": "Bellwether silenced",
  "keeper:abbot": "Abbot quenched",
  "keeper:castellan": "Castellan unsealed",
  unmade: "Crown unmade",
});
// Short keeper names for the run report ("Keepers broken: Bellwether · Iron Maw · ...").
const KEEPER_NAMES = Object.freeze({ bellwether: "Bellwether", ironmaw: "Iron Maw", abbot: "Abbot", castellan: "Castellan", warden: "Rift Warden" });
const PRACTICE_NOTE = "Practice run · score and Journal progress not saved.";
const WARDEN_HINT = "Keep space for ring gaps; destroy charging nodes before their deadline.";
const FALLBACK_HINT = "Use cover and save a dash for committed attacks.";

// Run setup (F1.1) and the assisted notes (F18.5).
const RULESET_HINTS = Object.freeze({
  keepers: "Keepers, relics, elites and living worlds. Rift Score is ranked.",
  original: "The original campaign, untouched. Original boards only.",
});
const ASSIST_NOTE = "ASSISTED RUN · ASSISTED BOARD";
const ASSIST_TITLE = "THIS RUN WILL BE MARKED ASSISTED";
const ASSIST_TEXT = "Its score goes to the ASSISTED board. Changing back later keeps the mark.";

// Stage and keeper title cards (F20.2): the big line types in at 30 ms a character.
const CARD_CHAR_MS = 30;
const SLAM_SEQUENCES = new Set(["phase", "unmade"]);

// Telegraph palette preview (F17): one 48 px swatch per threat class, in the class colour and,
// with patterns on, the class pattern (charge chevrons, dashed aim, artillery spokes and cross,
// ground double ring and ticks, salvo spokes, boss triple ring; melee is the eye colour).
const SWATCH = 48;
const SWATCH_GROUND = "#10141e";

// Minimal element factory: known properties are assigned, anything else becomes an attribute.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

const show = (node) => node.classList.remove("hidden");
const hide = (node) => node.classList.add("hidden");
const isShown = (node) => !node.classList.contains("hidden");
const listOf = (value) => (Array.isArray(value) ? value : []);
const isTutorialRun = (run) => run?.kind === "tutorial" || !!run?.tutorial;
const isPracticeRun = (run) => run?.kind === "practice" || !!run?.practice;

// Results and pause lines use unpadded minutes ("7:05"); only the HUD clock pads both parts.
function runClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function outcomeOf(summary) {
  const raw = String(summary.outcome ?? "").toLowerCase();
  if (raw.startsWith("victory")) return "victory";
  if (raw.startsWith("defeat")) return "defeat";
  return "ended";
}

// "SKEWER 3 · PHASED 7" from { id: count }.
function featText(feats) {
  return Object.entries(feats ?? {})
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${FEATS[id]?.name ?? id.toUpperCase()} ${n}`)
    .join(" · ");
}

// Ledger sources, relic ids or { id, label } rows -> [{ id, label }].
function namedRows(rows) {
  return listOf(rows).map((row) => {
    const id = typeof row === "string" ? row : row?.id;
    const key = iconKey(id);
    return { id: key ?? id, label: row?.label ?? RELICS[key]?.name ?? String(id ?? "") };
  });
}

// ---- palette preview pixels ------------------------------------------------------------------

// Plots every pixel whose distance from the centre lies in [inner, outer).
function ring(g, cx, cy, inner, outer) {
  const r = Math.ceil(outer);
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x + 0.5, y + 0.5);
      if (d >= inner && d < outer) g.fillRect(cx + x, cy + y, 1, 1);
    }
}

// n radial strokes of width w between radii r0 and r1, starting at angle a0.
function spokes(g, cx, cy, n, r0, r1, w, a0 = 0) {
  for (let i = 0; i < n; i++) {
    const a = a0 + (i * Math.PI * 2) / n;
    for (let r = r0; r <= r1; r += 0.5) g.fillRect(Math.round(cx + Math.sin(a) * r - w / 2), Math.round(cy - Math.cos(a) * r - w / 2), w, w);
  }
}

// One class swatch: the marker shape at 0.3 fill with 2 px edges, and its pattern when on.
// The contrast palette draws each stroke white over a black under-stroke.
function drawSwatch(g, cls, color, patterns, contrast) {
  const c = SWATCH / 2;
  g.globalAlpha = 1;
  g.fillStyle = SWATCH_GROUND;
  g.fillRect(0, 0, SWATCH, SWATCH);
  const stroke = (draw) => {
    if (contrast) {
      g.fillStyle = "#000000";
      draw(1);
    }
    g.fillStyle = color;
    draw(0);
  };
  if (cls === "melee") {
    stroke((grow) => {
      g.fillRect(14 - grow, 20 - grow, 6 + grow * 2, 6 + grow * 2);
      g.fillRect(28 - grow, 20 - grow, 6 + grow * 2, 6 + grow * 2);
    });
    return;
  }
  if (cls === "charge" || cls === "aim") {
    const half = cls === "charge" ? 7 : 2;
    g.globalAlpha = 0.3;
    g.fillStyle = color;
    if (cls === "charge") g.fillRect(c - half, 4, half * 2, SWATCH - 8);
    g.globalAlpha = 1;
    stroke((grow) => {
      if (cls === "charge") {
        g.fillRect(c - half - grow, 4, 2 + grow * 2, SWATCH - 8);
        g.fillRect(c + half - 2 - grow, 4, 2 + grow * 2, SWATCH - 8);
        // Chevrons pointing along the lane.
        if (patterns)
          for (let y = 10; y < SWATCH - 8; y += 9)
            for (let k = 0; k < 5; k++) {
              g.fillRect(c - 5 + k - grow, y + 4 - k, 2 + grow, 2 + grow);
              g.fillRect(c + 3 - k - grow, y + 4 - k, 2 + grow, 2 + grow);
            }
      } else {
        const dash = patterns ? 4 : SWATCH;
        for (let y = 4; y < SWATCH - 4; y += dash * 2) g.fillRect(c - 1 - grow, y, 2 + grow * 2, Math.min(dash, SWATCH - 4 - y));
      }
    });
    return;
  }
  g.globalAlpha = 0.3;
  g.fillStyle = color;
  ring(g, c, c, 0, 18);
  g.globalAlpha = 1;
  stroke((grow) => {
    ring(g, c, c, 16 - grow, 18 + grow);
    if (!patterns) return;
    if (cls === "artillery") {
      spokes(g, c, c, 4, 4, 15, 2 + grow, Math.PI / 4);
      g.fillRect(c - 4 - grow, c - 1 - grow, 8 + grow * 2, 2 + grow * 2);
      g.fillRect(c - 1 - grow, c - 4 - grow, 2 + grow * 2, 8 + grow * 2);
    } else if (cls === "ground") {
      ring(g, c, c, 11 - grow, 13 + grow);
      spokes(g, c, c, 12, 13, 16, 1 + grow);
    } else if (cls === "salvo") spokes(g, c, c, 8, 3, 15, 2 + grow);
    else if (cls === "boss") {
      ring(g, c, c, 11 - grow, 13 + grow);
      ring(g, c, c, 6 - grow, 8 + grow);
    }
  });
}

export function createMenus(ctx) {
  // Missing markup degrades to a detached element so no handler can throw.
  const $ = (selector, tag = "div") => document.querySelector(selector) ?? document.createElement(tag);
  const dom = {
    body: document.body,
    root: document.documentElement,
    menu: $("#menu", "main"),
    skull: $("#deathSkull", "button"),
    title: $(".menu-card h1", "h1"),
    edition: $(".menu-card .edition"),
    runSummary: $("#runSummary", "p"),
    runReport: $("#runReport", "details"),
    runDetails: $("#runDetails"),
    start: $("#start", "button"),
    tutorial: $("#tutorial", "button"),
    mainMenu: $("#mainMenu", "button"),
    scoreSave: $("#scoreSave", "p"),
    retryScore: $("#retryScore", "button"),
    loadNote: $("#loadNote", "small"),
    modeBadge: $("#modeBadge"),
    runForm: $("#runForm", "form"),
    usernameTitle: $("#usernameTitle", "h2"),
    playerName: $("#playerName", "input"),
    practiceRun: $("#practiceRun", "input"),
    usernameError: $("#usernameError", "p"),
    rulesetKeepers: $("#rulesetKeepers", "button"),
    rulesetOriginal: $("#rulesetOriginal", "button"),
    rulesetHint: $("#rulesetHint", "small"),
    assistNote: $("#assistNote", "p"),
    choice: $("#choice", "section"),
    choiceTitle: $("#choiceTitle", "h2"),
    choiceContext: $("#choiceContext", "p"),
    cards: $("#cards"),
    pauseMenu: $("#pauseMenu", "section"),
    pauseCard: $("#pauseMenu .pause-card"),
    pauseStats: $("#pauseStats", "p"),
    buildSummary: $("#buildSummary", "p"),
    resume: $("#resume", "button"),
    abandon: $("#abandonTrial", "button"),
    endRun: $("#endRun", "button"),
    quitRun: $("#quitRun", "button"),
    sequence: $("#sequence", "section"),
    sequenceTitle: $("#sequenceTitle", "h2"),
    sequenceText: $("#sequenceText", "p"),
    sequenceSkip: $("#sequenceSkip", "button"),
    stageCard: $("#stageCard"),
    stageCardSmall: $("#stageCardSmall", "small"),
    stageCardBig: $("#stageCardBig", "strong"),
    sound: $("#sound", "button"),
  };
  const controls = new Map(); // pref key -> { row, control, output, hint }
  const bindButtons = new Map(); // action -> rebinding button
  const swatches = []; // palette preview canvases, one per threat class

  let overlayReturn = null;
  let bindingAction = null;
  let activeChoice = null;
  let confirming = null;
  let pendingConfirm = null; // { resolve, focus } while the generic confirm dialog is open
  let flames = null; // the skull's eye flames (skull-flames.js)
  let quitToTitle = false; // QUIT TO MENU: the ended run's results open straight onto the title
  let skullTime = 0;
  const skullHold = { hover: false, focus: false }; // either one freezes the drift
  let skullLeft = null;
  let skullTop = null;
  let cardTimer = 0;
  let cardSequence = null; // the cinematic whose title card is showing
  let heldCard = null; // a card asked for during a transition, shown once it ends

  const personalBest = h("div", { id: "personalBest", className: "personal-best hidden" }, "PERSONAL BEST");
  const resultsTitle = h("div", { id: "resultsTitle", className: "results-title hidden" });
  dom.edition.after(personalBest, resultsTitle);
  const assistLine = h("p", { id: "assistLine", className: "assist-line hidden" });
  const rankLine = h("p", { id: "rankLine", className: "rank-line hidden", role: "status" });
  dom.runSummary.after(assistLine, rankLine);
  const confirmText = h("p", { id: "pauseConfirmText" });
  const confirmAccept = h("button", { type: "button", id: "confirmAccept", className: "secondary danger" });
  const confirmCancel = h("button", { type: "button", id: "confirmCancel", className: "secondary" }, "CANCEL");
  // An alertdialog: input.js makes it the pad/arrow/Tab navigation root while it is open.
  const confirmBox = h(
    "div",
    {
      id: "pauseConfirm",
      className: "pause-confirm hidden",
      role: "alertdialog",
      "aria-modal": "true",
      "aria-labelledby": "pauseConfirmText",
    },
    confirmText,
    h("div", { className: "menu-links" }, confirmAccept, confirmCancel),
  );
  dom.pauseCard.append(confirmBox);

  // Wave-1 controls that are not a value row keep their hand-written renderers
  // (declared before buildSettings() runs below).
  const CUSTOM_ROWS = {
    testSound() {
      const button = h("button", { type: "button", id: "testSound", className: "secondary" }, "TEST SOUND");
      button.addEventListener("click", testSound);
      return [button];
    },
    audioStatus() {
      return [h("p", { id: "audioStatus", className: "settings-hint", role: "status" })];
    },
    bindings() {
      const reset = h("button", { type: "button", id: "resetBindings", className: "secondary" }, "RESET KEYS");
      reset.addEventListener("click", resetBindings);
      const help = h(
        "details",
        { className: "controller-help" },
        h("summary", {}, "CONTROLLER"),
        h("dl", {}, ...CONTROLLER_HELP.flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, text)])),
      );
      return [h("p", { className: "settings-hint" }, "Select a key to rebind. Esc cancels."), h("div", { id: "bindings" }), h("p", { id: "bindStatus", role: "status" }), reset, help];
    },
  };

  const dialog = buildConfirmDialog();
  const settingsDom = buildSettings();

  function sfx(name) {
    try {
      ctx.audio?.fx?.(name);
    } catch (err) {
      console.error("[menus] sound failed", err);
    }
  }

  // ---- preferences ---------------------------------------------------------------------

  const soundSilent = () => {
    const p = ctx.prefs;
    return p.muted || p.master === 0 || (p.music === 0 && p.effects === 0);
  };

  function unlockAudio() {
    try {
      ctx.audio?.unlock?.();
    } catch (err) {
      console.error("[menus] audio unlock failed", err);
    }
  }

  // Persist and announce. Every consumer reacts to "prefs" (audio buses, render size and
  // lighting, HUD indicator opacity and key labels, and syncSettings below), so a change made
  // anywhere (these controls, rebinding, a legacy import) takes the same single path.
  function commit() {
    try {
      ctx.savePrefs?.();
    } catch (err) {
      console.error("[menus] saving preferences failed", err);
    }
    ctx.bus?.emit("prefs", { prefs: ctx.prefs });
  }

  // The value a control shows, read back into the row's type.
  function controlValue(row, control) {
    if (row.type === "bool") return row.invert ? !control.checked : control.checked;
    if (row.type === "range") return clamp(Math.round(Number(control.value)) || 0, row.min, row.max);
    return row.options[control.selectedIndex]?.[0] ?? row.default;
  }

  // A live run that is not yet marked assisted (F18.5): switching one of its assists to an
  // assisted value asks first. Reverting never clears the mark, so a marked run never asks.
  function needsAssistConfirm(key, value) {
    const run = ctx.run;
    if (!run || run.demo || run.over || isTutorialRun(run) || run.flags?.assisted === true) return false;
    return assistedPrefs({ ...ctx.prefs, [key]: value }).includes(key) && !assistedPrefs(ctx.prefs).includes(key);
  }

  async function changeSetting(row, control) {
    const value = controlValue(row, control);
    if (needsAssistConfirm(row.key, value) && !(await confirm(ASSIST_TITLE, ASSIST_TEXT))) {
      syncSettings();
      return;
    }
    ctx.prefs[row.key] = value;
    if (row.key === "master" && value > 0) ctx.prefs.muted = false;
    // Unmuting is itself the gesture that may start audio (the unlock listener skips muted clicks).
    if (row.key === "muted" && !value) unlockAudio();
    commit();
  }

  function syncControl({ row, control, output, hint }) {
    const lock = row.lock?.(ctx.prefs) ?? null;
    const value = lock ? lock.value : ctx.prefs[row.key];
    if (row.type === "bool") control.checked = row.invert ? !value : !!value;
    else if (row.type === "select") control.selectedIndex = Math.max(0, row.options.findIndex(([option]) => option === value));
    else {
      control.value = String(value);
      output.textContent = row.off && !Number(value) ? "OFF" : `${value}%`;
    }
    control.disabled = !!lock;
    if (hint) {
      hint.textContent = lock?.hint ?? row.hint;
      hint.classList.toggle("hidden", !hint.textContent);
    }
  }

  function syncSettings() {
    for (const entry of controls.values()) syncControl(entry);
    drawPalettePreview();
    if (bindButtons.size) renderBindings();
    dom.sound.textContent = soundSilent() ? "SOUND OFF" : "SOUND ON";
    dom.body.classList.toggle("nightmare", !!ctx.prefs.nightmare);
    const crt = ctx.prefs.crt === true ? "full" : ctx.prefs.crt;
    dom.body.classList.toggle("crt", crt === "subtle" || crt === "full");
    dom.body.classList.toggle("crt-subtle", crt === "subtle");
    // UI scale (F18.6): every .ui-scaled root zooms by --ui-scale.
    dom.root.style.setProperty("--ui-scale", String((Number(ctx.prefs.uiScale) || 100) / 100));
    syncRunSetup();
  }

  function toggleSound() {
    if (soundSilent()) {
      const p = ctx.prefs;
      p.muted = false;
      if (p.master === 0) p.master = 100;
      if (p.music === 0 && p.effects === 0) {
        p.music = 70;
        p.effects = 100;
      }
      unlockAudio();
    } else ctx.prefs.muted = true;
    commit();
  }

  function showAudioStatus() {
    const status = ctx.audio?.status;
    if (typeof status === "string" && status) settingsDom.audioStatus.textContent = status;
  }

  // The engine checks mute/levels itself; its promise settles once `status` is final
  // (the resume() behind it is asynchronous).
  function testSound() {
    let pending;
    try {
      pending = ctx.audio?.test?.();
    } catch (err) {
      console.error("[menus] test sound failed", err);
    }
    showAudioStatus();
    Promise.resolve(pending).then(showAudioStatus, showAudioStatus);
  }

  // ---- settings panel (rendered from PREF_SCHEMA, F18.1) --------------------------------

  function settingRow(row) {
    const id = `pref-${row.key}`;
    const hint = row.hint || row.lock ? h("p", { id: `${id}-hint`, className: "settings-hint" }, row.hint) : null;
    let control;
    let output = null;
    if (row.type === "bool") control = h("input", { id, type: "checkbox" });
    else if (row.type === "select") control = h("select", { id }, ...row.options.map(([value, text]) => h("option", { value: String(value) }, text)));
    else control = h("input", { id, type: "range", min: String(row.min), max: String(row.max), step: String(row.step ?? 1) });
    if (hint) control.setAttribute("aria-describedby", hint.id);
    control.addEventListener(row.type === "range" ? "input" : "change", () => changeSetting(row, control));

    let line;
    if (row.type === "bool") line = h("label", { className: "setting-row mute-row", for: id }, row.label, control);
    else if (row.type === "select") line = h("div", { className: "setting-row" }, h("label", { for: id }, row.label), control);
    else {
      output = h("output", { id: `${id}-value`, for: id });
      line = h("div", { className: "setting-row" }, h("label", { for: id }, row.label), h("div", { className: "setting-range" }, output, control));
    }
    controls.set(row.key, { row, control, output, hint });
    const nodes = hint ? [line, hint] : [line];
    if (row.key === "palette") nodes.push(buildPalettePreview());
    return nodes;
  }

  function buildPalettePreview() {
    const strip = h("div", { className: "palette-preview", "aria-hidden": "true" });
    for (const cls of THREAT_CLASSES) {
      const canvas = h("canvas", { className: "palette-swatch", width: SWATCH, height: SWATCH, title: cls });
      swatches.push({ cls, canvas });
      strip.append(canvas);
    }
    return strip;
  }

  function drawPalettePreview() {
    const name = ctx.prefs.palette in PALETTES ? ctx.prefs.palette : "rift";
    const patterns = !!effectivePref(ctx.prefs, "telegraphPatterns");
    for (const { cls, canvas } of swatches) {
      const g = canvas.getContext?.("2d");
      if (g) drawSwatch(g, cls, PALETTES[name][cls], patterns, name === "contrast");
    }
  }

  // Every tab from the schema, in row order, with a heading wherever the group changes.
  function buildSettings() {
    const built = {};
    for (const tab of SETTINGS_TABS) {
      const nodes = [];
      let group = null;
      for (const row of PREF_SCHEMA) {
        if (row.tab !== tab) continue;
        if (row.group && row.group !== group) nodes.push(h("h3", { className: "settings-group" }, row.group));
        group = row.group;
        const made = row.type === "custom" ? CUSTOM_ROWS[row.render]() : settingRow(row);
        for (const node of made) if (node.id) built[node.id] = node;
        nodes.push(...made);
      }
      $("#panel" + TAB_NAMES[tab]).replaceChildren(...nodes);
    }
    return { audioStatus: built.audioStatus ?? h("p"), bindings: built.bindings ?? h("div"), bindStatus: built.bindStatus ?? h("p") };
  }

  // The selected tab lives in the DOM (aria-selected), so it persists between openings.
  function selectSettingsTab(name, focus = false) {
    stopListening();
    for (const tab of TABS) {
      const active = tab === name;
      const button = $("#tab" + tab, "button");
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      $("#panel" + tab).hidden = !active;
    }
    if (focus) $("#tab" + name, "button").focus();
    if (name === "Controls") renderBindings();
  }

  // ---- key rebinding -------------------------------------------------------------------

  const actionLabel = (action) => ACTION_LABELS[action] ?? action;

  function renderBindings() {
    if (!bindButtons.size) {
      for (const [action, label] of Object.entries(ACTION_LABELS)) {
        const button = h("button", { type: "button", "aria-label": `Change ${label} binding` });
        button.addEventListener("click", () => listen(action));
        bindButtons.set(action, button);
        settingsDom.bindings.append(h("div", { className: "bind-row" }, h("span", {}, label), button));
      }
    }
    for (const [action, button] of bindButtons)
      button.textContent = bindingAction === action ? "PRESS A KEY…" : keyLabel(ctx.prefs.bindings?.[action]);
  }

  // input.js owns the capture: it validates the code (same rule as the loader), applies the
  // conflict swap, saves and emits "prefs"; this side only presents the outcome.
  function listen(action) {
    bindingAction = action;
    renderBindings();
    settingsDom.bindStatus.textContent = "Press a key or mouse button. Escape cancels.";
    ctx.input?.startCapture?.(action, onCaptured);
  }

  function onCaptured({ action, status, code, swapped }) {
    if (status === "reserved") {
      settingsDom.bindStatus.textContent = "That key is reserved. Choose another key.";
      return; // still listening
    }
    bindingAction = null;
    renderBindings();
    settingsDom.bindStatus.textContent =
      status === "bound"
        ? `${actionLabel(action)} set to ${keyLabel(code)}` + (swapped ? ` · Swapped with ${actionLabel(swapped)}` : "")
        : "Rebinding cancelled.";
  }

  function stopListening(message) {
    if (!bindingAction) return;
    bindingAction = null;
    ctx.input?.cancelCapture?.();
    renderBindings();
    if (message) settingsDom.bindStatus.textContent = message;
  }

  function resetBindings() {
    ctx.prefs.bindings = { ...DEFAULT_BINDINGS };
    stopListening();
    commit();
    settingsDom.bindStatus.textContent = "Default controls restored.";
  }

  // ---- confirm dialog (menus.confirm, F18.5) ------------------------------------------------

  function buildConfirmDialog() {
    const title = h("h2", { id: "confirmTitle" });
    const text = h("p", { id: "confirmText" });
    const ok = h("button", { type: "button", id: "confirmOk", className: "secondary danger" }, "CONFIRM");
    const cancel = h("button", { type: "button", id: "confirmNo", className: "secondary" }, "CANCEL");
    const section = h(
      "section",
      { id: "confirmDialog", className: "modal hidden", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "confirmTitle", "aria-describedby": "confirmText" },
      h("div", { className: "confirm-panel ui-scaled" }, title, text, h("div", { className: "menu-links" }, ok, cancel)),
    );
    ok.addEventListener("click", () => settleConfirm(true));
    cancel.addEventListener("click", () => settleConfirm(false));
    dom.body.append(section);
    return { section, title, text, cancel };
  }

  // confirm(title, text) -> Promise<bool>: CONFIRM resolves true; CANCEL, Esc and pad B false.
  // A newer request answers the open one with false.
  function confirm(title, text = "") {
    settleConfirm(false);
    return new Promise((resolve) => {
      pendingConfirm = { resolve, focus: document.activeElement };
      dialog.title.textContent = String(title ?? "");
      dialog.text.textContent = String(text ?? "");
      show(dialog.section);
      sfx("uiOpen");
      dialog.cancel.focus();
    });
  }

  function settleConfirm(answer) {
    const open = pendingConfirm;
    if (!open) return;
    pendingConfirm = null;
    hide(dialog.section);
    sfx(answer ? "uiConfirm" : "uiBack");
    open.focus?.focus?.();
    open.resolve(answer);
  }

  // ---- panels --------------------------------------------------------------------------

  function openPanel(id) {
    if (!(id in PANEL_FOCUS)) return;
    sfx("uiOpen");
    if (ctx.mode === "play") ctx.director?.pause?.();
    if (ctx.overlay && ctx.overlay !== id) hide($(ctx.overlay));
    overlayReturn = ctx.mode;
    ctx.overlay = id;
    ctx.input?.clear?.();
    dom.body.classList.add("menu-open");
    show($(id));
    dom.menu.inert = true;
    dom.pauseMenu.inert = true;
    if (id === "#runSetup") {
      dom.playerName.value = String(ctx.profile?.lastName ?? "").trim().slice(0, NAME_LIMIT);
      dom.usernameError.textContent = "";
      dom.playerName.setAttribute("aria-invalid", "false");
      syncRunSetup();
    } else if (id === "#settings") syncSettings();
    else if (id === "#profile") ctx.journal?.render?.();
    else ctx.leaderboard?.render?.();
    $(PANEL_FOCUS[id], "input").focus();
  }

  function closePanel() {
    sfx("uiBack"); // the original plays it even when nothing is open
    if (!ctx.overlay) return;
    hide($(ctx.overlay));
    ctx.overlay = null;
    stopListening();
    dom.menu.inert = false;
    dom.pauseMenu.inert = false;
    ctx.input?.clear?.();
    (overlayReturn === "pause" ? dom.resume : dom.start).focus();
  }

  // The ruleset switch (F1.1) and the assisted note (F18.5) of the run-setup panel.
  function syncRunSetup() {
    const ruleset = ctx.prefs.ruleset === "original" ? "original" : "keepers";
    dom.rulesetKeepers.setAttribute("aria-pressed", String(ruleset === "keepers"));
    dom.rulesetOriginal.setAttribute("aria-pressed", String(ruleset === "original"));
    dom.rulesetHint.textContent = RULESET_HINTS[ruleset];
    dom.assistNote.textContent = ASSIST_NOTE;
    dom.assistNote.classList.toggle("hidden", !assistedPrefs(ctx.prefs).length);
  }

  function chooseRuleset(ruleset) {
    if (ctx.prefs.ruleset === ruleset) return;
    sfx("uiConfirm");
    ctx.prefs.ruleset = ruleset;
    commit();
  }

  function submitRun(event) {
    event.preventDefault();
    const name = dom.playerName.value.trim().slice(0, NAME_LIMIT);
    if (!name) {
      dom.usernameError.textContent = "Enter a username.";
      sfx("uiError");
      dom.playerName.setAttribute("aria-invalid", "true");
      dom.playerName.focus();
      return;
    }
    const practice = dom.practiceRun.checked;
    closePanel();
    // Only scored runs remember the name, matching the Journal's no-practice-writes rule.
    if (!practice && !ctx.env?.debug?.practice && ctx.profile) ctx.profile.lastName = name;
    ctx.director?.start?.({ practice, name });
  }

  function startTutorial() {
    if (ctx.menuDeath) ctx.director?.setDeathMode?.(false);
    ctx.director?.start?.({ tutorial: true });
  }

  // ---- main menu and results -----------------------------------------------------------

  function setTitle(first, accent, brand) {
    dom.title.classList.toggle("brand-title", brand);
    dom.title.replaceChildren(first, ...(brand ? [] : [h("br")]), h("span", {}, accent));
  }

  // Without a summary the card keeps whatever it shows (the results persist behind the
  // restarted demo until the next run ends), unless the run that just ended was the tutorial.
  // Every return to the menu (boot, death, victory, END RUN, QUIT, tutorial exit) lands in
  // normal mode; the director restarts the attract demo right after, so it picks that up.
  function showMenu(summary) {
    show(dom.menu);
    dom.menu.inert = !!ctx.overlay;
    if (ctx.menuDeath) ctx.menuDeath = false;
    setDeathMode(false);
    const run = ctx.run;
    if (summary?.tutorial) showTutorialEnd(summary.completed === true || summary.tutorial?.completed === true);
    else if (summary) showResults(summary, run ?? {});
    else if (isTutorialRun(run)) showTutorialEnd(run.tutorial?.completed === true);
    if (quitToTitle && summary) showTitle(false);
    quitToTitle = false;
  }

  function hideMenu() {
    hide(dom.menu);
    dom.runReport.open = false;
    hide(dom.runReport);
    flames?.setLit?.(false);
  }

  // MAIN MENU on the results card: back to the plain title (START RUN, TUTORIAL, …). A failed
  // score save keeps its notice and RETRY button.
  function showTitle(focus = true) {
    setTitle("RIFT", "BORN", true);
    dom.edition.textContent = "";
    dom.runSummary.textContent = "";
    hide(personalBest);
    clearResultLines();
    dom.runReport.open = false;
    hide(dom.runReport);
    dom.runDetails.replaceChildren();
    if (!isShown(dom.retryScore)) dom.scoreSave.textContent = "";
    setResultsView(false);
    dom.start.textContent = "START RUN";
    if (focus) dom.start.focus();
  }

  function setResultsView(on) {
    dom.menu.classList.toggle("results-view", on);
    dom.mainMenu.classList.toggle("hidden", !on);
    dom.tutorial.classList.toggle("hidden", on);
  }

  function clearResultLines() {
    for (const node of [resultsTitle, assistLine, rankLine]) {
      node.textContent = "";
      hide(node);
    }
  }

  function showTutorialEnd(completed) {
    setTitle("RIFT", "BORN", true);
    dom.edition.textContent = "";
    dom.runSummary.textContent = completed ? "TUTORIAL COMPLETE" : "";
    dom.scoreSave.textContent = "";
    hide(personalBest);
    clearResultLines();
    hide(dom.retryScore);
    hide(dom.runReport);
    setResultsView(false);
    dom.start.textContent = "START RUN";
    dom.start.focus();
  }

  function setLine(node, text) {
    node.textContent = text;
    node.classList.toggle("hidden", !text);
  }

  function showResults(summary, run) {
    const outcome = outcomeOf(summary);
    const seconds = summary.seconds ?? summary.elapsed ?? run.elapsed ?? 0;
    const comparisons = listOf(summary.comparisons);
    setTitle(...RESULT_TITLES[outcome], false);
    dom.edition.textContent = `STAGE ${summary.stage ?? run.stage ?? 1} · ${formatInt(summary.score ?? run.score)} SCORE`;
    dom.runSummary.textContent = `${summary.kills ?? run.kills ?? 0} KILLS · ${runClock(seconds)}`;
    personalBest.classList.toggle("hidden", !(summary.personalBest === true || comparisons.includes("PERSONAL BEST")));
    clearResultLines();
    // The equipped title (F19.4) under the player's name.
    const title = summary.title ?? ctx.profile?.cosmetics?.title ?? null;
    const name = summary.name ?? run.name;
    setLine(resultsTitle, title && name ? `${name} · ${title}` : "");
    setLine(assistLine, assistText(summary, run));
    renderReport(summary, run, outcome, seconds, comparisons);
    // A scored run's save line belongs to ctx.scores (written before or after this call);
    // every other run clears the previous run's notice or shows the practice note.
    const practice = summary.practice ?? isPracticeRun(run);
    const scored = !practice && !ctx.env?.debug?.practice && seconds >= 1;
    if (practice) dom.scoreSave.textContent = PRACTICE_NOTE;
    else if (!scored) dom.scoreSave.textContent = "";
    setResultsView(true);
    dom.start.textContent = "PLAY AGAIN";
    dom.start.focus();
  }

  // "ASSISTED RUN · SPEED 80%" or "ASSISTED RUN" (F18.5), or "" for an unassisted run.
  function assistText(summary, run) {
    const assisted = summary.assisted ?? run.flags?.assisted;
    if (!assisted) return "";
    const speed = Number(summary.assistSpeed ?? run.flags?.assistSpeed);
    return speed > 0 && speed < 100 ? `ASSISTED RUN · SPEED ${speed}%` : "ASSISTED RUN";
  }

  // The rank line (F15), written once the finished run's board has been fetched:
  // showRank({ label: "RIFT", rank: 3, total: 41 }) -> "RIFT RANK 3 OF 41"; null clears it.
  function showRank(spec) {
    const rank = Number(spec?.rank);
    const total = Number(spec?.total);
    setLine(rankLine, rank > 0 && total >= rank ? `${String(spec.label ?? "RIFT").toUpperCase()} RANK ${rank} OF ${total}` : "");
  }

  function causeText(summary, run, outcome) {
    if (summary.cause) return summary.cause;
    if (outcome === "victory") return "Rift Warden defeated";
    if (outcome === "ended") return "Voluntary end";
    const lethal = run.stats?.lethal;
    return lethal?.label || lethal?.id || "Unknown source";
  }

  function hintText(summary, run) {
    if (summary.hint) return summary.hint;
    return /^warden./.test(String(run.stats?.lethal?.id ?? "")) ? WARDEN_HINT : FALLBACK_HINT;
  }

  // The KEEPERS report lines (F19.3): Rift Score parts, chain and feats, keepers broken.
  function keepersLines(summary, run) {
    const lines = [];
    const rift = summary.rift ?? run.rift;
    if (rift) {
      lines.push(`RIFT ${formatInt(rift.score)} · Kill ${formatInt(rift.killPart)} · Chain ${formatInt(rift.chainPart)} · Feats ${formatInt(rift.featPart)}`);
      const best = summary.chainBest ?? run.stats?.chainBest ?? rift.chain?.best ?? 0;
      const feats = featText(summary.feats ?? run.stats?.feats ?? rift.feats);
      lines.push(`Best chain ${best}` + (feats ? ` · Feats: ${feats}` : ""));
    }
    const broken = listOf(summary.keepersBroken ?? run.flags?.keepersBroken);
    if (broken.length) lines.push("Keepers broken: " + broken.map((id) => KEEPER_NAMES[id] ?? KEEPERS[id]?.name ?? id).join(" · "));
    return lines;
  }

  // "Relics: Witch Glass · Ferryman's Coin" with a chip before each name.
  function relicsLine(summary) {
    const relics = namedRows(summary.relics ?? ctx.rules?.list?.("relic"));
    if (!relics.length) return null;
    const line = h("p", { className: "report-relics" }, "Relics: ");
    relics.forEach(({ id, label }, i) => {
      const chip = iconChip(id, { scale: 2 });
      if (chip) line.append(chip);
      line.append(label + (i < relics.length - 1 ? " · " : ""));
    });
    return line;
  }

  function renderReport(summary, run, outcome, seconds, comparisons) {
    const original = summary.original ?? run.original ?? true;
    const damage = listOf(summary.damage ?? run.stats?.damage);
    const statues = summary.statues ?? run.statueCount ?? 0;
    const trials = summary.trials ?? run.trialCount ?? 0;
    const modifier = summary.modifier ?? 100 + (run.difficultyBonus ?? 0);
    // Accepts profile.completeRun()'s shape (newly / milestones) as well as the report's own.
    const mastery = listOf(summary.mastery ?? summary.newly)
      .map((entry) => (typeof entry === "string" ? entry : entry?.title))
      .filter(Boolean);
    const earned = listOf(summary.milestones ?? summary.earned);
    const text = [
      ...comparisons,
      `${OUTCOME_LABELS[outcome]} · STAGE ${summary.stage ?? run.stage ?? 1} · ${runClock(seconds)}`,
      summary.build ?? ctx.progression?.buildText?.(false) ?? "",
      "Damage dealt: " + WEAPONS.map((w, i) => `${w.label} ${formatInt(damage[i])}`).join(" · "),
      ...(original ? [] : keepersLines(summary, run)),
    ];
    const lines = text.map((line) => h("p", {}, line));
    const relics = original ? null : relicsLine(summary);
    if (relics) lines.push(relics);
    let tail;
    if (original) tail = [`${statues} statues · ${trials} trials · Statue curse ${modifier}%`];
    else {
      const omens = listOf(summary.omens ?? ctx.rules?.list?.("omen")).length;
      const m = Number(summary.multiplier ?? ctx.scoring?.multiplier?.() ?? 1);
      tail = [`${statues} statues · ${omens} omens · ${trials} trials · Curse ${modifier}% · Score X${m.toFixed(2)}`];
    }
    const seed = summary.seedCode ?? (Number.isFinite(run.seed) ? seedCode(run.seed) : "");
    if (seed) tail.push(`Seed ${seed}`);
    tail.push(`Cause: ${causeText(summary, run, outcome)}`);
    if (outcome === "defeat") tail.push(`Next attempt: ${hintText(summary, run)}`);
    if (mastery.length) tail.push(`Mastery: ${mastery.join(" · ")}`);
    if (earned.length) tail.push("New: " + earned.map((key) => MILESTONE_TEXT[key] ?? key).join(" · "));
    lines.push(...tail.map((line) => h("p", {}, line)));
    dom.runDetails.replaceChildren(...lines);
    dom.runReport.open = false;
    show(dom.runReport);
  }

  function setReady() {
    dom.start.disabled = false;
    dom.tutorial.disabled = false;
    dom.start.textContent = "START RUN";
    dom.loadNote.textContent = "";
  }

  function setDeathMode(enabled) {
    const on = !!enabled;
    dom.body.classList.toggle("death-mode", on);
    dom.modeBadge.textContent = on ? "DEATH MODE" : "";
    dom.skull.setAttribute("aria-pressed", String(on));
    dom.skull.setAttribute("aria-label", on ? "Death Mode selected. Return to normal mode" : "Enter Death Mode");
    dom.usernameTitle.textContent = on ? "DEATH MODE" : "NEW RUN";
    flames?.setLit?.(on && isShown(dom.menu));
  }

  // Slow elliptical drift (~27 s period); frozen while hovered/focused so it can be clicked.
  function updateSkull(dt) {
    if ((ctx.mode !== "menu" && ctx.mode !== "dead") || ctx.overlay) return;
    if (!ctx.env?.reduced && !skullHold.hover && !skullHold.focus) skullTime += dt;
    const phase = skullTime * 0.23 + 0.8;
    const left = Math.round(12 + (0.5 + 0.39 * Math.sin(phase)) * Math.max(0, innerWidth - 104));
    const top = Math.round(12 + (0.5 + 0.38 * Math.cos(phase)) * Math.max(0, innerHeight - 104));
    if (left !== skullLeft) {
      skullLeft = left;
      dom.skull.style.left = `${left}px`;
    }
    if (top !== skullTop) {
      skullTop = top;
      dom.skull.style.top = `${top}px`;
    }
  }

  // ---- pause menu ----------------------------------------------------------------------

  // The pause build summary gains the run's relics, omens and feats (F9.4, F11, F12).
  function pauseSummary(run) {
    const lines = [ctx.progression?.buildText?.(true) ?? ""];
    if (run && !run.original) {
      const relics = listOf(ctx.rules?.list?.("relic")).map((s) => s.label);
      const omens = listOf(ctx.rules?.list?.("omen")).map((s) => s.label);
      const feats = featText(run.stats?.feats ?? run.rift?.feats);
      if (relics.length) lines.push(`Relics: ${relics.join(" · ")}`);
      if (omens.length) lines.push(`Omens: ${omens.join(" · ")}`);
      if (feats) lines.push(`Feats: ${feats}`);
    }
    return lines.filter(Boolean).join("\n");
  }

  function showPause() {
    const run = ctx.run;
    resetConfirm();
    quitToTitle = false;
    dom.abandon.classList.toggle("hidden", run?.trial?.state !== "active");
    // The tutorial's EXIT TUTORIAL already returns to the menu.
    dom.quitRun.classList.toggle("hidden", isTutorialRun(run));
    dom.endRun.textContent = isTutorialRun(run) ? "EXIT TUTORIAL" : isPracticeRun(run) ? "END PRACTICE RUN" : "END RUN & SAVE SCORE";
    dom.buildSummary.textContent = pauseSummary(run);
    dom.pauseStats.textContent = run
      ? `STAGE ${run.stage} · ${formatInt(run.score)} SCORE · ${runClock(run.elapsed)}` + (Number.isFinite(run.seed) ? `\nSEED ${seedCode(run.seed)}` : "")
      : "";
    show(dom.pauseMenu);
    dom.resume.focus();
  }

  function hidePause() {
    resetConfirm();
    hide(dom.pauseMenu);
  }

  function confirmCopy(kind, run) {
    if (kind === "abandon") return ["ABANDON THE TRIAL? THE CURSE REMAINS.", "ABANDON TRIAL"];
    if (kind === "quit")
      return isPracticeRun(run)
        ? ["QUIT TO THE MAIN MENU? PRACTICE RUNS ARE NOT SAVED.", "QUIT TO MENU"]
        : ["QUIT TO THE MAIN MENU? THE RUN ENDS HERE AND ITS SCORE IS SAVED.", "END RUN & QUIT"];
    if (isTutorialRun(run)) return ["LEAVE THE TUTORIAL?", "EXIT TUTORIAL"];
    if (isPracticeRun(run)) return ["END THIS PRACTICE RUN?", "END PRACTICE RUN"];
    return ["END THIS RUN AND SAVE YOUR SCORE?", "END RUN"];
  }

  // Irreversible pause actions take a second, deliberate press; CANCEL holds the focus.
  function askConfirm(kind) {
    const [question, accept] = confirmCopy(kind, ctx.run);
    confirming = kind;
    confirmText.textContent = question;
    confirmAccept.textContent = accept;
    dom.pauseCard.classList.add("confirming");
    show(confirmBox);
    confirmCancel.focus();
  }

  function resetConfirm(refocus = false) {
    if (!confirming) return;
    const origin = { end: dom.endRun, quit: dom.quitRun }[confirming] ?? dom.abandon;
    confirming = null;
    dom.pauseCard.classList.remove("confirming");
    hide(confirmBox);
    if (refocus) (isShown(origin) ? origin : dom.resume).focus();
  }

  function acceptConfirm() {
    const kind = confirming;
    resetConfirm();
    if (kind === "end") endRun();
    else if (kind === "quit") {
      // END RUN semantics (scored unless practice), landing on the plain title menu.
      quitToTitle = true;
      endRun();
    } else if (kind === "abandon") abandonTrial();
  }

  function endRun() {
    ctx.director?.finishRun?.(false);
    if (ctx.mode !== "pause") hidePause();
  }

  // Abandoning a trial releases a waiting keeper (F1.3): with the kill goal met, the portal
  // step runs again in play so the keeper can start; pause returns if no cinematic began.
  function abandonTrial() {
    const run = ctx.run;
    const keeperWaiting = run?.keeperState === "waiting" && run.stageKills >= run.stageGoal;
    ctx.encounters?.abandonTrial?.();
    hide(dom.abandon);
    if (keeperWaiting) {
      ctx.director?.setMode?.("play");
      ctx.director?.activatePortal?.();
      if (ctx.mode === "play") ctx.director?.setMode?.("pause");
    }
    if (ctx.mode === "pause") dom.resume.focus();
    else hidePause();
  }

  // ---- choice cards --------------------------------------------------------------------

  // A weapon slot (card.weapon, or an integer icon) shows that weapon's sprite; an icon id
  // (relic, omen, upgrade, mod, trait) a 24 px bitmap chip with a rarity border; any other
  // string icon a symbol glyph. Cursed tags read in the cursed red; gold cards get a gold bevel.
  function renderCard(spec, card, index) {
    const rarity = card.rarity in RARITY_COLORS ? card.rarity : null;
    const classes = ["card"];
    if (rarity) classes.push(`rarity-${rarity}`);
    if (card.gold) classes.push("gold");
    const button = h("button", { type: "button", className: classes.join(" ") });
    const weapon = Number.isInteger(card.weapon) ? card.weapon : card.icon;
    const chip = typeof card.icon === "string" ? iconChip(card.icon, { scale: 3 }) : null;
    if (Number.isInteger(weapon) && weapon >= 0 && weapon < WEAPONS.length)
      button.append(h("span", { className: `weapon-sprite sprite-${weapon}`, "aria-hidden": "true" }));
    else if (chip) {
      chip.classList.add("card-chip");
      if (rarity) chip.classList.add(`rarity-${rarity}`);
      button.append(chip);
    } else if (typeof card.icon === "string" && card.icon) button.append(h("span", { className: "card-icon", "aria-hidden": "true" }, card.icon));
    button.append(h("strong", {}, String(card.title ?? "").toUpperCase()));
    if (card.tag) button.append(h("span", { className: rarity === "cursed" ? "card-tag cursed" : "card-tag" }, card.tag));
    if (card.text) button.append(h("p", {}, card.text));
    if (card.detail) button.append(h("small", { className: "upgrade-comparison" }, card.detail));
    if (index < 9) button.append(h("span", { className: "card-key", "aria-hidden": "true" }, String(index + 1)));
    button.addEventListener("click", () => {
      if (activeChoice !== spec) return; // one pick per dialog, however many cards are pressed
      sfx("uiCardPick");
      hideChoice();
      ctx.input?.clear?.();
      card.onPick?.();
    });
    return button;
  }

  function choice(spec) {
    activeChoice = spec;
    dom.choiceTitle.textContent = spec.title ?? "CHOOSE AN UPGRADE";
    dom.choiceContext.textContent = spec.context ?? "";
    dom.cards.replaceChildren(...listOf(spec.cards).map((card, i) => renderCard(spec, card, i)));
    ctx.input?.clear?.();
    show(dom.choice);
    dom.cards.querySelector(".card")?.focus();
    sfx("level");
  }

  function hideChoice() {
    activeChoice = null;
    hide(dom.choice);
    dom.cards.replaceChildren();
  }

  // Decision dialogs (statue, landmark) can be dismissed; their last card is always "Leave".
  const isDecision = () => !!activeChoice && (activeChoice.preview === true || ctx.run?.activeReward?.preview === true);
  const leaveDecision = () => dom.cards.lastElementChild?.click();

  function pickCardByKey(event) {
    if (!activeChoice || ctx.overlay || pendingConfirm || !isShown(dom.choice)) return;
    const match = CARD_KEY.exec(event.code);
    const card = match && dom.cards.children[Number(match[1]) - 1];
    if (!card) return;
    // The pick resumes play; the same digit must not reach input.js as a weapon switch.
    event.preventDefault();
    event.stopPropagation();
    card.click();
  }

  // ---- cinematic caption and title cards (F20.2) ---------------------------------------

  // The title card of a sequence: STAGE n over the world name, a keeper's title over its
  // epithet, or the Crown's slams. Other sequences (victory, dais) have none.
  function cardFor(seq) {
    const kind = seq?.kind;
    if (!kind) return null;
    if (kind === "stage" || kind === "opening") {
      const stage = ctx.run?.stage ?? 1;
      return { small: `STAGE ${stage}`, big: stageDef(stage).name };
    }
    if (SLAM_SEQUENCES.has(kind)) return { small: KEEPERS.warden.title, big: SEQUENCES[kind].title, slam: true };
    const keeper = Object.values(KEEPERS).find((def) => def.sequence === kind);
    return keeper ? { small: keeper.title, big: keeper.epithet } : null;
  }

  function stopCard() {
    clearTimeout(cardTimer);
    cardTimer = 0;
  }

  // stageCard({ small, big, slam }) shows a title card (null hides it). The big line types in
  // a character every 30 ms (with a tick), the gold rule wipes in over 0.3 s in 6 steps, and a
  // slam scales from 1.6 to 1 over 2 frames. Reduced motion shows it at once. Asked for during
  // a transition, it waits until the screen is clear.
  function stageCard(spec) {
    stopCard();
    heldCard = null;
    const card = dom.stageCard;
    card.classList.remove("revealing", "slam");
    if (!spec?.big) {
      hide(card);
      return;
    }
    if (ctx.transition?.active?.()) {
      hide(card);
      heldCard = spec;
      return;
    }
    const big = String(spec.big);
    dom.stageCardSmall.textContent = String(spec.small ?? "");
    card.classList.toggle("slam", !!spec.slam);
    show(card);
    card.classList.add("revealing");
    if (ctx.env?.reduced || spec.slam) {
      dom.stageCardBig.textContent = big;
      return;
    }
    let shown = 0;
    const type = () => {
      shown++;
      dom.stageCardBig.textContent = big.slice(0, shown);
      if (big[shown - 1] !== " ") sfx("uiTick");
      cardTimer = shown < big.length ? setTimeout(type, CARD_CHAR_MS) : 0;
    };
    dom.stageCardBig.textContent = "";
    type();
  }

  function sequence(spec) {
    if (!spec) {
      hide(dom.sequence);
      cardSequence = null;
      stageCard(null);
      return;
    }
    dom.sequenceTitle.textContent = spec.title ?? "";
    dom.sequenceText.textContent = spec.text ?? "";
    dom.sequenceSkip.textContent = spec.skipLabel || "SKIP";
    show(dom.sequence);
    if (document.activeElement !== dom.sequenceSkip) dom.sequenceSkip.focus();
    // A caption re-shown for the same cinematic (pause, continue) keeps its card as it is.
    const seq = ctx.cinematic;
    if (seq && seq !== cardSequence) {
      cardSequence = seq;
      stageCard(cardFor(seq));
    }
  }

  // The skip button resumes a paused cinematic, otherwise skips it.
  function sequenceAction() {
    if (ctx.cinematic?.paused) ctx.director?.togglePause?.();
    else ctx.director?.skipSequence?.();
  }

  // ---- escape / back -------------------------------------------------------------------

  const onMenu = () => ctx.mode === "menu" || ctx.mode === "dead";

  // Escape and gamepad B peel one layer per press: nothing during a transition → answer the
  // confirm dialog with CANCEL → skip the cinematic → leave a decision → stop rebinding (pad
  // only; input.js consumes Escape while capturing) → close the panel → back out of a pause
  // confirm → leave Death Mode (only with no panel open, so cancelling run setup keeps the
  // chosen mode) → pause / resume. A real reward choice ignores it.
  function back() {
    if (ctx.transition?.active?.()) return;
    if (pendingConfirm) settleConfirm(false);
    else if (ctx.cinematic) ctx.director?.skipSequence?.();
    else if (isDecision()) leaveDecision();
    else if (bindingAction) stopListening("Rebinding cancelled.");
    else if (ctx.overlay) closePanel();
    else if (confirming) resetConfirm(true);
    else if (onMenu()) {
      if (ctx.menuDeath) ctx.director?.setDeathMode?.(false);
    } else if (ctx.mode === "play") ctx.director?.pause?.();
    else if (ctx.mode === "pause") ctx.director?.resume?.();
  }

  // ---- wiring --------------------------------------------------------------------------

  const click = (selector, handler) => $(selector, "button").addEventListener("click", handler);

  dom.start.addEventListener("click", () => openPanel("#runSetup"));
  dom.tutorial.addEventListener("click", startTutorial);
  click("#menuSettings", () => openPanel("#settings"));
  click("#menuLeaderboard", () => openPanel("#leaderboard"));
  click("#menuProfile", () => openPanel("#profile"));
  for (const id of ["#closeSettings", "#closeLeaderboard", "#closeProfile", "#cancelRun"]) click(id, closePanel);
  dom.runForm.addEventListener("submit", submitRun);
  dom.rulesetKeepers.addEventListener("click", () => chooseRuleset("keepers"));
  dom.rulesetOriginal.addEventListener("click", () => chooseRuleset("original"));

  dom.resume.addEventListener("click", () => ctx.director?.resume?.());
  click("#pauseSettings", () => openPanel("#settings"));
  click("#pauseLeaderboard", () => openPanel("#leaderboard"));
  click("#pauseProfile", () => openPanel("#profile"));
  dom.abandon.addEventListener("click", () => askConfirm("abandon"));
  dom.endRun.addEventListener("click", () => askConfirm("end"));
  dom.quitRun.addEventListener("click", () => askConfirm("quit"));
  dom.mainMenu.addEventListener("click", () => showTitle());
  confirmAccept.addEventListener("click", acceptConfirm);
  confirmCancel.addEventListener("click", () => resetConfirm(true));

  dom.sound.addEventListener("click", toggleSound);
  click("#pause", () => ctx.director?.pause?.());
  dom.sequenceSkip.addEventListener("click", sequenceAction);

  TABS.forEach((name, index) => {
    const tab = $("#tab" + name, "button");
    tab.addEventListener("click", () => selectSettingsTab(name));
    tab.addEventListener("keydown", (event) => {
      const moves = { ArrowRight: index + 1, ArrowLeft: index + TABS.length - 1, Home: 0, End: TABS.length - 1 };
      if (!(event.code in moves)) return;
      event.preventDefault();
      selectSettingsTab(TABS[moves[event.code] % TABS.length], true);
    });
  });

  dom.skull.addEventListener("click", () => ctx.director?.setDeathMode?.(!ctx.menuDeath));
  const holdSkull = (key, held) => () => {
    skullHold[key] = held;
  };
  dom.skull.addEventListener("pointerenter", holdSkull("hover", true));
  dom.skull.addEventListener("pointerleave", holdSkull("hover", false));
  // A mouse click also focuses the button; only keyboard/pad focus should stop the drift,
  // otherwise the skull stays frozen after the cursor leaves until something else is clicked.
  dom.skull.addEventListener("focus", () => {
    skullHold.focus = dom.skull.matches?.(":focus-visible") ?? false;
  });
  dom.skull.addEventListener("blur", holdSkull("focus", false));
  if (typeof document.createElement === "function") flames = createSkullFlames(ctx, dom.skull);

  document.addEventListener("keydown", (event) => {
    if (!event.repeat) pickCardByKey(event);
  });

  // input.js reports Escape and pad B as one event (tagged with the device).
  ctx.bus?.on("input:escape", back);
  // Space/Enter during a cinematic (input.js prevents their native button activation).
  ctx.bus?.on("input:confirm", () => {
    if (ctx.cinematic) sequenceAction();
  });
  ctx.bus?.on("prefs", syncSettings);
  // A title card held back by a transition reveals once the director leaves "transition".
  ctx.bus?.on("modeChange", ({ prev } = {}) => {
    if (prev === "transition" && heldCard && ctx.cinematic) stageCard(heldCard);
  });

  syncSettings();

  return {
    get overlay() {
      return ctx.overlay;
    },
    openPanel,
    closePanel,
    showMenu,
    hideMenu,
    setReady,
    showPause,
    hidePause,
    choice,
    hideChoice,
    sequence,
    stageCard,
    setDeathMode,
    updateSkull,
    syncSettings,
    back,
    confirm,
    showRank,
  };
}
