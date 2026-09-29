// Interface sounds by delegation: one set of document listeners gives every button, tab,
// checkbox, range, select and choice card in the menus, settings, pause, run setup,
// leaderboard and journal its hover/focus tick, click, toggle, slider step and tab sound, so
// the menu code needs no per-control wiring. A click whose handler already played an
// interface cue (uiOpen, uiBack, uiConfirm, uiCardPick...) adds no generic click on top.
// Pause and resume answer the "modeChange" bus event.

const CONTROL = "button, [role='tab'], input, select, a[href], summary, .card";
const FOCUS_AFTER_POINTER = 400; // ms: a focus that follows a press is the press, not a move
const FOCUS_AFTER_CUE = 80; // ms: a focus a cue just caused (a panel opening) stays quiet
const BACK = /^(back|close|cancel|done|return)\b/i;

const matches = (el, selector) => typeof el?.matches === "function" && el.matches(selector);
const controlOf = (target) => (typeof target?.closest === "function" ? target.closest(CONTROL) : null);
const disabled = (el) => el.disabled === true || el.getAttribute?.("aria-disabled") === "true";
const isCard = (el) => matches(el, ".card");
const isTab = (el) => matches(el, "[role='tab'], .ranking-tabs button, .settings-tabs button");

// cue(name, pitch) plays an interface sound; cues() counts the event-level interface cues
// requested so far and lastCue() says when (performance-clock ms) the latest one was.
export function installUiSounds(doc, bus, { cue, cues, lastCue, now = () => Date.now() }) {
  if (!doc?.addEventListener) return;
  let hovered = null,
    pressedAt = -Infinity,
    clickMark = 0;

  const listen = (type, fn, capture = false) =>
    doc.addEventListener(
      type,
      (event) => {
        try {
          fn(event);
        } catch {
          // Interface sounds are decoration: never break a menu.
        }
      },
      { capture, passive: true },
    );

  listen("pointerover", (event) => {
    const el = controlOf(event.target);
    if (el === hovered) return;
    hovered = el;
    if (el && !disabled(el)) cue(isCard(el) ? "uiCardHover" : "uiHover");
  });
  listen("pointerdown", () => {
    pressedAt = now();
  }, true);
  // Keyboard and gamepad focus moves (input.js focuses on behalf of pads and arrows).
  listen("focusin", (event) => {
    const el = controlOf(event.target);
    if (!el || now() - pressedAt < FOCUS_AFTER_POINTER || now() - lastCue() < FOCUS_AFTER_CUE) return;
    cue(isCard(el) ? "uiCardHover" : "uiMove");
  });

  // Capture marks the cue count; the bubbling pass plays a generic sound only if no handler did.
  listen("click", () => {
    clickMark = cues();
  }, true);
  listen("click", (event) => {
    const el = controlOf(event.target);
    if (!el || disabled(el) || cues() !== clickMark) return;
    if (matches(el, "input, select")) return; // change/input events speak for these
    if (isTab(el)) cue("uiTab");
    else if (isCard(el)) cue("uiCardPick");
    else if (BACK.test(String(el.textContent ?? "").trim()) || matches(el, ".back, .close, [data-back]")) cue("uiClose");
    else if (el.hasAttribute?.("aria-pressed")) cue(el.getAttribute("aria-pressed") === "true" ? "uiToggleOn" : "uiCycle");
    else cue("uiClick");
  });
  listen("change", (event) => {
    const el = event.target;
    if (matches(el, "input[type='checkbox'], input[type='radio']")) cue(el.checked ? "uiToggleOn" : "uiToggleOff");
    else if (matches(el, "select")) cue("uiCycle");
  });
  // Slider steps rise in pitch with the value.
  listen("input", (event) => {
    const el = event.target;
    if (!matches(el, "input[type='range']")) return;
    const min = Number(el.min) || 0,
      max = Number(el.max) || 100,
      t = max > min ? (Number(el.value) - min) / (max - min) : 0.5;
    cue("uiSlider", 0.7 + 0.8 * Math.min(1, Math.max(0, t)));
  });

  bus?.on?.("modeChange", ({ mode, prev } = {}) => {
    if (mode === "pause" && prev === "play") cue("uiPause");
    else if (mode === "play" && prev === "pause") cue("uiResume");
  });
}
