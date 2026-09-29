// Keyboard, mouse, touch and gamepad. Gameplay polls continuous state every step
// (held / move / aimStick / firing / aiming) and receives discrete actions as "input:*" bus
// events, so no other system reads DOM input events or tracks edges. Menus stay native DOM
// (buttons, focus); this module only moves focus and clicks on behalf of pads and arrows.
// Fire is held or toggled (prefs.fireMode, IMPROVEMENTS F18.3); the "aiming" auto-fire reads
// aiming() through ctx.assist, which also keeps assisted fire out of a Castellan vigil.
import { DEFAULT_BINDINGS, assignBinding, isBindable } from "./preferences.js";
import { clamp } from "../core/util.js";

// Touch sticks: full deflection at 40 px of thumb travel, knob drawn at 28 px.
const STICK_RANGE = 40;
const KNOB_TRAVEL = 28;
const TOUCH_MOVE_DEAD = 0.05;
const TOUCH_AIM_OVERRIDE = 0.15; // touch aim wins over the right stick above this
const AIM_FIRE = 0.3; // aim-stick deflection that counts as aiming for "while aiming" auto-fire
// Two-finger tap pause (F18.6): the second finger lands within 0.25 s of the first, both lift
// within 0.35 s of the second, and neither travels more than 14 px.
const TAP_PAIR = 0.25;
const TAP_LIFT = 0.35;
const TAP_SLOP = 14;
// Gamepad, W3C standard mapping.
const PAD_AIM_DEAD = 0.16; // per axis
const PAD_MOVE_DEAD = 0.17; // radial; raw values are used above it
const PAD_NAV_AXIS = 0.55;
const PAD_ENGAGE = 0.5; // a stick pushed this far marks the pad as the device in use
const NAV_DELAY = 0.35; // s before a held menu direction starts repeating
const NAV_REPEAT = 0.14;
const BUTTON = Object.freeze({ a: 0, b: 1, x: 2, lb: 4, rb: 5, rt: 7, start: 9, up: 12, down: 13, left: 14, right: 15 });
// MouseEvent.button -> bit in MouseEvent.buttons (middle and right are swapped there).
const MOUSE_CODES = ["Mouse0", "Mouse1", "Mouse2", "Mouse3", "Mouse4"];
const BUTTON_BITS = [1, 4, 2, 8, 16];

const SEQUENCE_KEYS = new Set(["Escape", "Space", "Enter"]);
const ARROWS = new Map([
  ["ArrowUp", -1],
  ["ArrowLeft", -1],
  ["ArrowDown", 1],
  ["ArrowRight", 1],
]);
const FOCUSABLE = "button, input, select, summary";
const TEXT_FIELDS = "input, textarea, select";
// Presses on these are UI clicks, never gameplay mouse buttons.
const NOT_PLAYFIELD =
  "button, a, input, select, textarea, summary, label, header, nav, [role=dialog], [role=alertdialog], #touch, #devTools";
// Confirm dialogs (END RUN, ABANDON TRIAL) sit above every other menu.
const OPEN_DIALOG = '[role="alertdialog"]:not(.hidden):not([hidden])';
const NAME_KEYS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "SPACE", "DELETE"];
const NAME_LENGTH = 16;

// Menu direction from the D-pad or left stick with key-repeat timing: the first push
// moves at once, a held one repeats after 0.35 s every 0.14 s. Up/left mean "previous",
// down/right "next"; menu navigation is linear, like the original.
export function createPadMenu() {
  let direction = 0;
  let next = 0;
  return {
    directionAt(pad, now) {
      const b = pad.buttons;
      const ax = pad.axes;
      const v = b[BUTTON.up]?.pressed
        ? -1
        : b[BUTTON.down]?.pressed
          ? 1
          : b[BUTTON.left]?.pressed
            ? -1
            : b[BUTTON.right]?.pressed
              ? 1
              : Math.abs(ax[1] || 0) > PAD_NAV_AXIS
                ? Math.sign(ax[1])
                : Math.abs(ax[0] || 0) > PAD_NAV_AXIS
                  ? Math.sign(ax[0])
                  : 0;
      if (!v) {
        direction = 0;
        return 0;
      }
      if (v !== direction) {
        direction = v;
        next = now + NAV_DELAY;
        return v;
      }
      if (now >= next) {
        next = now + NAV_REPEAT;
        return v;
      }
      return 0;
    },
  };
}

export function createInput(ctx) {
  const $ = (selector) => document.querySelector(selector);
  const dom = {
    sequence: $("#sequence"),
    choice: $("#choice"),
    pauseMenu: $("#pauseMenu"),
    menu: $("#menu"),
    crosshair: $("#crosshair"),
    touch: $("#touch"),
    nameKeyboard: $("#nameKeyboard"),
    playerName: $("#playerName"),
  };

  const keys = new Set(); // held KeyboardEvent codes and "MouseN" (only recorded in play)
  const mouse = { x: 0, y: 0, moved: false, down: false, orbit: false };
  const pad = {
    connected: false,
    blocked: false, // getGamepads() threw (permissions policy); stop asking
    move: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
    fire: false,
    fireLocked: false, // set by clear(): a trigger held through a menu must be released once
    active: -1, // index of the pad with the most recent input (not always pad 0)
  };
  const padStates = new Map(); // gamepad index -> { prev: button states, deflected } per pad
  const padMenu = createPadMenu();
  const moveStick = createStick("#moveStick");
  const aimStick = createStick("#aimStick");
  const moveOut = { x: 0, y: 0 };
  const aimOut = { x: 0, y: 0 };
  let touchFire = false;
  let device = ctx.env?.mobile ? "touch" : "mouse";
  let capture = null; // { action, onDone } while a binding is being captured
  let swallowClick = false; // the click that ends a captured mouse press must not reach the UI
  let rumbleLevel = 0;
  let rumbleUntil = 0;
  let latched = false; // toggle fire: on from one fire press to the next
  const taps = new Map(); // touch pointerId -> { x, y, t, moved } (two-finger pause)
  let tapPair = null; // { t, left } while two touching fingers may still be a pause tap

  const emit = (type, payload) => ctx.bus.emit(type, payload);
  const bindings = () => ctx.prefs?.bindings ?? DEFAULT_BINDINGS;
  const gameplayOpen = () => ctx.mode === "play" && !ctx.overlay;
  const toggleFire = () => ctx.prefs?.fireMode === "toggle";
  const seconds = () => performance.now() / 1000;

  // A fire press (bound key or mouse button, pad trigger, touch FIRE): in toggle mode it flips
  // the latch; in hold mode the held state is read directly.
  function pressFire() {
    if (toggleFire()) latched = !latched;
  }

  // Releases a latched toggle (vigil, prefs change). Returns true when a latch was on.
  function releaseFireLatch() {
    const was = latched;
    latched = false;
    return was;
  }

  function held(action) {
    const code = bindings()[action];
    return code ? keys.has(code) : false;
  }

  function isBound(code) {
    const b = bindings();
    for (const action in b) if (b[action] === code) return true;
    return false;
  }

  // Discrete key/mouse actions. Pause works in play and pause; the rest only in live play.
  function trigger(code) {
    const b = bindings();
    if (code === b.pause) {
      emit("input:pause");
      return;
    }
    if (!gameplayOpen()) return;
    if (code === b.fire) pressFire();
    if (code === b.dash) emit("input:dash");
    if (code === b.interact) emit("input:interact");
    for (let i = 1; i <= 5; i++) if (code === b["weapon" + i]) emit("input:weapon", { index: i - 1 });
  }

  // Touch buttons deliver gameplay actions only while a run is live and unobstructed.
  function touchAction(type) {
    if (gameplayOpen()) emit(type);
  }

  // Last-used device drives prompts and the crosshair (body.pad-mode / body.touch-mode).
  function applyDeviceClass() {
    document.body?.classList.toggle("pad-mode", device === "pad");
    document.body?.classList.toggle("touch-mode", device === "touch");
  }

  function setDevice(next) {
    if (next === device) return;
    device = next;
    applyDeviceClass();
    emit("input:device", { device });
  }

  // ---- menus: focus navigation shared by pads and arrow keys ----

  function openDialog() {
    const dialog = $(OPEN_DIALOG);
    return dialog?.getClientRects().length ? dialog : null;
  }

  // The container whose controls pads/arrows navigate, most modal first.
  function menuRoot() {
    if (ctx.cinematic) return dom.sequence;
    const dialog = openDialog();
    if (dialog) return dialog;
    if (ctx.overlay) return $(ctx.overlay);
    if (ctx.mode === "upgrade") return dom.choice;
    if (ctx.mode === "pause") return dom.pauseMenu;
    if (ctx.mode === "menu" || ctx.mode === "dead") return dom.menu;
    return null;
  }

  // The Tab trap covers every modal context except the main menu, as in the original.
  function trapRoot() {
    const root = menuRoot();
    return root === dom.menu ? null : root;
  }

  function focusables(root, tabbable = false) {
    const list = [];
    if (!root) return list;
    for (const el of root.querySelectorAll(FOCUSABLE)) {
      if (el.disabled || el.closest("[hidden], .hidden, [inert]") || !el.getClientRects().length) continue;
      if (tabbable && el.tabIndex === -1) continue;
      list.push(el);
    }
    return list;
  }

  function focus(el) {
    // focusVisible keeps the ring on for pad users where supported (no keyboard event preceded it).
    el?.focus({ focusVisible: true });
  }

  // Linear wrap-around. With nothing focused, "next" starts at the first control and
  // "previous" at the last (the original landed on the second-to-last).
  function moveFocus(items, dir) {
    const n = items.length;
    if (!n) return;
    const i = items.indexOf(document.activeElement);
    focus(items[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n]);
  }

  // Pad A: act on the focused control the way a pointer or keyboard would.
  function activate(items) {
    const el = document.activeElement;
    if (!items.includes(el)) {
      focus(items[0]);
      return;
    }
    if (el.tagName === "INPUT" && el.type === "text") openNameKeyboard();
    else if (el.tagName === "SELECT") {
      if (!el.options.length) return;
      el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
      notifyChanged(el);
    } else if (el.type === "range") {
      const step = Number(el.step) || 5;
      const min = el.min === "" ? 0 : Number(el.min);
      const max = el.max === "" ? 100 : Number(el.max);
      const value = Number(el.value) + step;
      el.value = String(value > max ? min : value);
      notifyChanged(el);
    } else el.click();
  }

  // Mirror a native edit: both events, bubbling, so any settings listener reacts.
  function notifyChanged(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function openNameKeyboard() {
    const details = dom.nameKeyboard?.closest("details");
    if (details) details.open = true;
    focus(dom.nameKeyboard?.querySelector("button"));
  }

  // Tab / Shift+Tab wrap inside the open modal; focus that escaped it is pulled back in.
  function trapFocus(e) {
    if (e.defaultPrevented) return; // a menu-level trap already wrapped this Tab
    const root = trapRoot();
    const list = focusables(root, true);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!root.contains(active)) {
      e.preventDefault();
      focus(e.shiftKey ? last : first);
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      focus(last);
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      focus(first);
    }
  }

  // Arrow keys step through menu controls like the pad does. Form fields never get here
  // (they keep their native arrows) and the settings tab strip keeps Left/Right.
  function navigateMenu(e) {
    const dir = ARROWS.get(e.code);
    if (!dir) return false;
    if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && e.target?.closest?.('[role="tablist"]')) return false;
    const root = menuRoot();
    if (!root) return false;
    e.preventDefault();
    moveFocus(focusables(root), dir);
    return true;
  }

  // Gamepad-friendly username entry; native typing still works alongside it.
  function buildNameKeyboard() {
    const board = dom.nameKeyboard;
    if (!board || board.childElementCount) return;
    for (const label of NAME_KEYS) {
      const key = document.createElement("button");
      key.type = "button";
      key.textContent = label;
      if (label.length > 1) key.classList.add("wide");
      key.addEventListener("click", () => typeName(label));
      board.append(key);
    }
  }

  function typeName(label) {
    const field = dom.playerName;
    if (!field) return;
    const text = label === "DELETE" ? field.value.slice(0, -1) : field.value + (label === "SPACE" ? " " : label);
    field.value = text.slice(0, NAME_LENGTH);
  }

  // ---- rebinding capture ----

  // Capture only lives while Settings is open, so a panel closed mid-listen can never
  // swallow the next gameplay key.
  function listening() {
    if (capture && ctx.overlay !== "#settings") capture = null;
    return !!capture;
  }

  // startCapture(action, onDone): this module validates and applies the code (assignBinding,
  //   save, "prefs") and reports { action, status: "bound" | "reserved" | "cancelled", code,
  //   swapped }. A reserved code keeps listening; Escape cancels.
  // startCapture(onCode): every captured code, Escape included, goes to onCode(code); the
  //   caller validates and applies it and returns false to keep listening.
  function startCapture(action, onDone) {
    capture =
      typeof action === "function"
        ? { onCode: action }
        : { action, onDone: typeof onDone === "function" ? onDone : null };
  }

  // Silent: switching settings tabs or closing the panel just stops listening.
  function cancelCapture() {
    capture = null;
  }

  function captureInput(code, repeat) {
    if (!code || (repeat && code !== "Escape")) return; // virtual keyboards may send no code
    const { onCode, action, onDone } = capture;
    if (onCode) {
      if (onCode(code) !== false && capture?.onCode === onCode) capture = null;
      return;
    }
    if (code === "Escape") {
      capture = null;
      onDone?.({ action, status: "cancelled" });
      return;
    }
    if (!isBindable(code)) {
      onDone?.({ action, status: "reserved", code });
      return;
    }
    capture = null;
    const swapped = assignBinding(ctx.prefs, action, code);
    ctx.savePrefs?.();
    emit("prefs", { prefs: ctx.prefs });
    onDone?.({ action, status: "bound", code, swapped });
  }

  // ---- keyboard ----

  function onKeyDown(e) {
    swallowClick = false;
    setDevice("mouse");
    const code = e.code;
    if (code === "Tab" && !listening()) trapFocus(e);
    const b = bindings();
    if (ctx.cinematic && code === b.pause && code !== "Escape") {
      e.preventDefault();
      if (!e.repeat) emit("input:pause");
      return;
    }
    if (ctx.cinematic && SEQUENCE_KEYS.has(code)) {
      e.preventDefault();
      if (e.repeat) return;
      if (code === "Escape") emit("input:escape", { device: "keyboard" });
      else emit("input:confirm");
      return;
    }
    if (listening()) {
      e.preventDefault();
      captureInput(code, e.repeat);
      return;
    }
    if (code === "Escape") {
      e.preventDefault();
      // Auto-repeat would toggle pause on and off while Esc is held.
      if (!e.repeat) emit("input:escape", { device: "keyboard" });
      return;
    }
    if (e.target?.matches?.(TEXT_FIELDS)) return;
    if (navigateMenu(e)) return;
    if (ctx.mode !== "play" && ctx.mode !== "pause") return;
    if (isBound(code)) e.preventDefault(); // no page scroll on Space/arrows
    if (ctx.mode === "play" && code) keys.add(code);
    if (!e.repeat) trigger(code);
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  // ---- mouse ----

  function onPlayfield(target) {
    return target === ctx.canvas || !target?.closest?.(NOT_PLAYFIELD);
  }

  function pressMouse(button) {
    const code = MOUSE_CODES[button];
    if (!code || keys.has(code)) return;
    keys.add(code);
    mouse.down = true;
    mouse.orbit = held("orbitDrag");
    trigger(code);
  }

  function releaseMouse(button) {
    if (!keys.delete(MOUSE_CODES[button])) return;
    mouse.down = MOUSE_CODES.some((code) => keys.has(code));
    mouse.orbit = held("orbitDrag");
  }

  // Pointer Events report extra buttons pressed or released while another is held as
  // pointermove, and a release outside the window never arrives, so the held set is
  // reconciled with the live `buttons` mask (the original could get stuck firing).
  function releaseMissing(mask) {
    for (let b = 0; b < BUTTON_BITS.length; b++) if (!(mask & BUTTON_BITS[b])) releaseMouse(b);
  }

  function onPointerDown(e) {
    if (e.pointerType !== "mouse" || ctx.mode !== "play" || ctx.overlay || !onPlayfield(e.target)) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.moved = true;
    pressMouse(e.button);
    try {
      ctx.canvas?.setPointerCapture(e.pointerId);
    } catch {
      // The pointer can already be gone (released between dispatch and capture).
    }
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) setDevice("mouse");
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    // Moving over the menus does not arm mouse aim; the playfield does (as on the canvas).
    if (ctx.mode === "play" || e.target === ctx.canvas) mouse.moved = true;
    if (dom.crosshair) {
      dom.crosshair.style.left = e.clientX + "px";
      dom.crosshair.style.top = e.clientY + "px";
    }
    if (e.button >= 0 && (e.buttons & BUTTON_BITS[e.button]) && gameplayOpen() && onPlayfield(e.target))
      pressMouse(e.button);
    releaseMissing(e.buttons);
  }

  // ---- touch ----

  function createStick(selector) {
    const el = $(selector);
    if (el) el.style.touchAction = "none";
    return { el, knob: el?.querySelector("span") ?? null, vec: { x: 0, y: 0 }, id: null, cx: 0, cy: 0 };
  }

  // A thumb landing on a stick uses it; one landing on the open playfield (the canvas or
  // the bare touch layer) takes that side's stick: left half moves, right half aims.
  function stickFor(e) {
    const own = e.target?.closest?.(".stick");
    if (own) return own === moveStick.el ? moveStick : own === aimStick.el ? aimStick : null;
    if ((e.target !== ctx.canvas && e.target !== dom.touch) || !gameplayOpen()) return null;
    return e.clientX < innerWidth / 2 ? moveStick : aimStick;
  }

  // Floating stick: the base jumps under the thumb, so deflection starts at zero wherever
  // it lands. A new finger takes the stick over, which also recovers from a lost pointerup.
  function pressStick(stick, e) {
    stick.id = e.pointerId;
    stick.cx = e.clientX;
    stick.cy = e.clientY;
    centreStick(stick);
    const el = stick.el;
    if (!el) return;
    el.style.translate = "";
    const r = el.getBoundingClientRect();
    if (r.width) el.style.translate = `${e.clientX - (r.left + r.width / 2)}px ${e.clientY - (r.top + r.height / 2)}px`;
    el.classList.add("active");
  }

  function dragStick(stick, e) {
    const x = (e.clientX - stick.cx) / STICK_RANGE;
    const y = (e.clientY - stick.cy) / STICK_RANGE;
    const l = Math.max(1, Math.hypot(x, y));
    stick.vec.x = x / l;
    stick.vec.y = y / l;
    drawKnob(stick);
  }

  function centreStick(stick) {
    stick.vec.x = 0;
    stick.vec.y = 0;
    drawKnob(stick);
  }

  function releaseStick(stick) {
    stick.id = null;
    centreStick(stick);
    if (!stick.el) return;
    stick.el.style.translate = "";
    stick.el.classList.remove("active");
  }

  function drawKnob(stick) {
    if (!stick.knob) return;
    const { x, y } = stick.vec;
    stick.knob.style.translate = x || y ? `${x * KNOB_TRAVEL}px ${y * KNOB_TRAVEL}px` : "";
  }

  function releaseTouch(id) {
    if (moveStick.id === id) releaseStick(moveStick);
    if (aimStick.id === id) releaseStick(aimStick);
  }

  function bindTouchButtons() {
    const fire = $("#fireTouch");
    fire?.addEventListener("pointerdown", (e) => {
      if (ctx.mode !== "play") return;
      touchFire = true;
      if (!ctx.overlay) pressFire();
      try {
        fire.setPointerCapture(e.pointerId);
      } catch {
        // Already released; the pointerup below still clears the flag.
      }
      e.preventDefault();
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      fire?.addEventListener(type, () => {
        touchFire = false;
      });
    // Dash fires on press, not on click-release: it is a reaction button.
    $("#dashTouch")?.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      touchAction("input:dash");
    });
    $("#interactTouch")?.addEventListener("click", () => touchAction("input:interact"));
    $("#pauseTouch")?.addEventListener("click", () => emit("input:pause"));
  }

  // ---- pointer routing (window) ----

  // Capture phase: every press updates the device, even ones a UI handler later stops;
  // touch presses may start a stick.
  function onAnyPointerDown(e) {
    if (e.pointerType === "mouse") {
      setDevice("mouse");
      return;
    }
    setDevice("touch");
    const stick = stickFor(e);
    if (stick || e.target === dom.touch) touchDown(e);
    if (!stick) return;
    pressStick(stick, e);
    e.preventDefault();
  }

  // ---- two-finger tap pause (F18.6) ----

  // Only touches on the playfield or a stick take part, so FIRE or DASH held under one thumb
  // never pairs with a stick tap.
  function touchDown(e) {
    const t = seconds();
    taps.set(e.pointerId, { x: e.clientX, y: e.clientY, t, moved: false });
    if (taps.size !== 2) {
      tapPair = null;
      return;
    }
    let first = Infinity;
    for (const tap of taps.values()) first = Math.min(first, tap.t);
    tapPair = t - first <= TAP_PAIR ? { t, left: 2 } : null;
  }

  function touchMoved(e) {
    const tap = taps.get(e.pointerId);
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) tap.moved = true;
  }

  function touchUp(e) {
    const tap = taps.get(e.pointerId);
    taps.delete(e.pointerId);
    if (!tapPair || !tap) return;
    if (tap.moved || seconds() - tapPair.t > TAP_LIFT) tapPair = null;
    else if (--tapPair.left === 0) {
      tapPair = null;
      if (gameplayOpen()) emit("input:pause");
    }
  }

  // Document capture phase, before any UI handler: while rebinding, any non-touch press
  // anywhere becomes the binding, and the click it produces is swallowed.
  function onCapturePointerDown(e) {
    swallowClick = false;
    if (e.pointerType === "touch" || !listening()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowClick = e.button === 0; // only the primary button produces a click
    captureInput(MOUSE_CODES[e.button] ?? "Mouse" + e.button, false);
  }

  function onClickCapture(e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onPointerMove(e) {
    if (e.pointerType === "mouse") {
      onMouseMove(e);
      return;
    }
    touchMoved(e);
    if (moveStick.id === e.pointerId) dragStick(moveStick, e);
    else if (aimStick.id === e.pointerId) dragStick(aimStick, e);
  }

  function onPointerUp(e) {
    if (e.pointerType !== "mouse") {
      touchUp(e);
      releaseTouch(e.pointerId);
      return;
    }
    releaseMouse(e.button);
    releaseMissing(e.buttons);
  }

  function onPointerCancel(e) {
    if (e.pointerType !== "mouse") {
      taps.delete(e.pointerId);
      tapPair = null;
      releaseTouch(e.pointerId);
    }
    if (e.target === ctx.canvas) clear();
  }

  // ---- focus loss ----

  // Keys released while unfocused never send keyup, and touches are lost: drop it all,
  // then let the director pause the run or the cinematic.
  function loseFocus(reason) {
    clear();
    releaseStick(moveStick);
    releaseStick(aimStick);
    emit("input:blur", { reason });
  }

  // ---- gamepad ----

  // The browser's pad array, or null when pads cannot be read.
  function readPads() {
    if (pad.blocked) return null;
    try {
      return navigator.getGamepads?.() ?? null;
    } catch {
      pad.blocked = true; // e.g. a sandboxed frame without the gamepad permission
      return null;
    }
  }

  function padState(index) {
    let state = padStates.get(index);
    if (!state) {
      state = { prev: [], deflected: false };
      padStates.set(index, state);
    }
    return state;
  }

  const rising = (p, i) => !!p.buttons[i]?.pressed && !padState(p.index).prev[i];
  const deadzone = (v) => (Math.abs(v || 0) > PAD_AIM_DEAD ? v : 0);

  // A fresh button press or a stick leaving its rest zone means the player picked this pad up.
  function padEngaged(p) {
    const state = padState(p.index);
    let pressed = false;
    for (let i = 0; i < p.buttons.length && !pressed; i++) pressed = rising(p, i);
    let deflected = false;
    for (let i = 0; i < 4 && i < p.axes.length; i++) if (Math.abs(p.axes[i]) > PAD_ENGAGE) deflected = true;
    const pushed = deflected && !state.deflected;
    state.deflected = deflected;
    return pressed || pushed;
  }

  function remember(p) {
    const prev = padState(p.index).prev;
    const buttons = p.buttons;
    for (let i = 0; i < buttons.length; i++) prev[i] = !!buttons[i]?.pressed;
    prev.length = buttons.length;
  }

  // The pad in use: the one with the most recent input, else the first connected. Every
  // connected pad's edges are tracked, so picking another pad up switches at once.
  function activePad(pads) {
    let chosen = null;
    let first = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p?.connected) continue;
      first ??= p;
      if (padEngaged(p)) {
        pad.active = p.index;
        setDevice("pad");
      }
      if (p.index === pad.active) chosen = p;
    }
    chosen ??= first;
    if (chosen) pad.active = chosen.index;
    return chosen;
  }

  function menuPad(p, root, seconds) {
    const dir = padMenu.directionAt(p, seconds);
    const confirm = rising(p, BUTTON.a);
    if (dir || confirm) {
      const items = focusables(root);
      if (dir) moveFocus(items, dir);
      if (confirm) activate(items);
    }
    if (rising(p, BUTTON.b)) emit("input:escape", { device: "pad" });
    if (rising(p, BUTTON.start) && (ctx.mode === "pause" || ctx.cinematic)) emit("input:pause");
  }

  function playPad(p) {
    pad.aim.x = deadzone(p.axes[2]);
    pad.aim.y = deadzone(p.axes[3]);
    const trigger = !!p.buttons[BUTTON.rt]?.pressed;
    if (!trigger) pad.fireLocked = false;
    pad.fire = trigger && !pad.fireLocked;
    if (rising(p, BUTTON.rt)) pressFire();
    if (rising(p, BUTTON.a)) emit("input:dash");
    if (rising(p, BUTTON.x)) emit("input:interact");
    if (rising(p, BUTTON.lb)) emit("input:cycleWeapon", { dir: -1 });
    if (rising(p, BUTTON.rb)) emit("input:cycleWeapon", { dir: 1 });
    if (rising(p, BUTTON.start)) emit("input:pause");
  }

  function forgetPad() {
    pad.connected = false;
    pad.active = -1;
    pad.move.x = pad.move.y = 0;
    padStates.clear();
  }

  // Once per rendered frame (main.js). Menus get focus navigation; live play gets aim,
  // trigger and button actions; the left stick is always sampled for move().
  function poll(now = performance.now()) {
    pad.aim.x = pad.aim.y = 0;
    pad.fire = false;
    const pads = readPads();
    const p = pads && activePad(pads);
    if (!p) {
      if (pad.connected) forgetPad();
      return;
    }
    pad.connected = true;
    pad.move.x = p.axes[0] || 0;
    pad.move.y = p.axes[1] || 0;
    const root = menuRoot();
    if (root) menuPad(p, root, now / 1000);
    else if (ctx.mode === "play") playPad(p);
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) remember(pads[i]);
  }

  // Losing the pad in use mid-run pauses, like a focus loss (it never toggles).
  function onPadDisconnected(e) {
    const index = e.gamepad?.index;
    padStates.delete(index);
    if (index !== pad.active) return;
    pad.active = -1;
    pad.move.x = pad.move.y = 0;
    if (device === "pad" && ctx.mode === "play") loseFocus("gamepad");
  }

  // Vibration for the pad in use. Scaled by the screen-shake setting (the one comfort
  // control for physical feedback); a weaker request never cuts a stronger one short.
  function rumble(strength, ms) {
    if (device !== "pad" || ctx.run?.demo) return;
    const level = clamp(strength, 0, 1) * clamp((ctx.prefs?.shake ?? 100) / 100, 0, 1);
    const duration = clamp(ms, 0, 5000);
    const now = performance.now();
    if (!(level > 0) || !(duration > 0) || (now < rumbleUntil && level < rumbleLevel)) return;
    const pads = readPads();
    let actuator = null;
    for (let i = 0; pads && i < pads.length; i++) if (pads[i]?.connected && pads[i].index === pad.active) actuator = pads[i].vibrationActuator;
    if (!actuator?.playEffect) return;
    rumbleLevel = level;
    rumbleUntil = now + duration;
    try {
      actuator
        .playEffect("dual-rumble", { startDelay: 0, duration, strongMagnitude: level, weakMagnitude: level * 0.6 })
        ?.catch?.(() => {});
    } catch {
      // Unsupported effect type on this controller.
    }
  }

  // ---- combined state read by gameplay ----

  // Screen-space movement (x right, y down = toward the camera), |v| <= 1. Later sources
  // override earlier ones: keys, then the touch stick, then the left stick.
  function move() {
    let x = (held("right") ? 1 : 0) - (held("left") ? 1 : 0);
    let y = (held("back") ? 1 : 0) - (held("forward") ? 1 : 0);
    const touch = moveStick.vec;
    if (Math.hypot(touch.x, touch.y) > TOUCH_MOVE_DEAD) {
      x = touch.x;
      y = touch.y;
    }
    if (Math.hypot(pad.move.x, pad.move.y) > PAD_MOVE_DEAD) {
      x = pad.move.x;
      y = pad.move.y;
    }
    const l = Math.max(1, Math.hypot(x, y));
    moveOut.x = x / l;
    moveOut.y = y / l;
    return moveOut;
  }

  function aimStickValue() {
    const touch = aimStick.vec;
    const source = Math.hypot(touch.x, touch.y) > TOUCH_AIM_OVERRIDE ? touch : pad.aim;
    aimOut.x = source.x;
    aimOut.y = source.y;
    return aimOut;
  }

  // Manual fire (F18.3): the bound key or button, the pad trigger or touch FIRE while held, or
  // the latch in toggle mode. Held fire is never suppressed; assisted fire is ctx.assist's.
  function firing() {
    if (toggleFire()) return latched;
    return held("fire") || touchFire || pad.fire;
  }

  // The aim stick (touch or pad) deflected past the aiming threshold: what "while aiming"
  // auto-fire reads (ctx.assist decides whether to fire, and never fires into a vigil).
  function aiming() {
    const stick = aimStickValue();
    return Math.hypot(stick.x, stick.y) > AIM_FIRE;
  }

  // Release everything held (ui.md §8.8), the fire toggle included: pause, menus, cards,
  // sequences and transitions all come through here. mouse.moved persists: mouse aim stays armed.
  function clear() {
    keys.clear();
    mouse.down = false;
    mouse.orbit = false;
    touchFire = false;
    latched = false;
    pad.fire = false;
    pad.fireLocked = true;
    centreStick(moveStick);
    centreStick(aimStick);
  }

  // ---- wiring ----

  buildNameKeyboard();
  bindTouchButtons();
  applyDeviceClass();
  if (ctx.canvas) ctx.canvas.style.touchAction = "none";
  addEventListener("keydown", onKeyDown);
  addEventListener("keyup", onKeyUp);
  addEventListener("pointerdown", onAnyPointerDown, true);
  document.addEventListener("pointerdown", onCapturePointerDown, true);
  document.addEventListener("click", onClickCapture, true);
  addEventListener("pointerdown", onPointerDown);
  addEventListener("pointermove", onPointerMove);
  addEventListener("pointerup", onPointerUp);
  addEventListener("pointercancel", onPointerCancel);
  ctx.canvas?.addEventListener("contextmenu", (e) => e.preventDefault());
  // Right-click must be bindable in Settings without opening the browser menu.
  document.addEventListener("contextmenu", (e) => {
    if (listening() || ctx.overlay === "#settings") e.preventDefault();
  });
  addEventListener("blur", () => loseFocus("blur"));
  addEventListener("gamepaddisconnected", onPadDisconnected);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) loseFocus("hidden");
  });
  // A transition (F20) drops every held input at each phase; hold fire never keeps a latch.
  ctx.bus.on("transition", clear);
  ctx.bus.on("prefs", () => {
    if (!toggleFire()) latched = false;
  });

  return {
    held,
    move,
    aimStick: aimStickValue,
    firing,
    aiming,
    mouse,
    get device() {
      return device;
    },
    get padConnected() {
      return pad.connected;
    },
    get capturing() {
      return listening();
    },
    // True while a toggle-fire latch is on (the HUD's FIRE LOCK chip).
    get fireLatched() {
      return latched;
    },
    clear,
    poll,
    rumble,
    startCapture,
    cancelCapture,
    stopCapture: cancelCapture,
    releaseFireLatch,
  };
}
