// Sound captions (IMPROVEMENTS F17): bus "sound" { name, x, z, src } -> #captions lines, or pips
// on the hurt ring in the "icons" mode. prefs.captions: "off" (default) | "captions" | "icons".
// Lines live 1.8 s of sim time, at most 3; identical lines merge as `SALVO X3`; ` NEAR` marks a
// source under 10 m; a CSS triangle points at the camera-relative bearing. Screen readers get
// the new lines through a polite live region, at most 2 announcements per second.
import { PALETTES, validPalette, captionFor } from "../data/palettes.js";

export const CAPTION = Object.freeze({ life: 1.8, max: 3, near: 10, announceGap: 0.5, lowHp: 0.25 });

// Adds a caption to `lines` ([{ text, cls, count, age, bearing, near }], oldest first, reused in
// place; `spare` recycles dropped records): a live line with the same text merges (count + 1,
// refreshed life, latest bearing); otherwise a new line is appended and the oldest dropped past
// `max`. Returns the line.
export function pushCaption(lines, { text, cls = null, bearing = null, near = false }, spare = [], max = CAPTION.max) {
  let line = null;
  for (const l of lines) if (l.text === text && l.age < CAPTION.life) line = l;
  if (line) line.count++;
  else {
    while (lines.length >= max) spare.push(lines.shift());
    line = spare.pop() ?? {};
    line.text = text;
    line.count = 1;
    lines.push(line);
  }
  line.cls = cls;
  line.age = 0;
  line.bearing = bearing;
  line.near = !!near;
  return line;
}

// Ages the lines by dt and drops expired ones (into `spare`). Returns true when one dropped.
export function tickCaptions(lines, dt, spare = []) {
  let kept = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    line.age += dt;
    // A merged line may outlive older ones, so any line can expire, not only the first.
    if (line.age >= CAPTION.life) spare.push(line);
    else lines[kept++] = line;
  }
  const dropped = kept < lines.length;
  lines.length = kept;
  return dropped;
}

// The text of a line: `SNIPER AIMING`, `SALVO NEAR`, `SALVO X3`, `SALVO NEAR X3`.
export const captionText = (line) => `${line.text}${line.near ? " NEAR" : ""}${line.count > 1 ? ` X${line.count}` : ""}`;

export function createCaptions(ctx, { threats = null, bearingOf = null, onScreen = null } = {}) {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  root.id = "captions";
  root.className = "ui-scaled";
  root.classList.add("hidden");
  root.setAttribute("role", "log");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", "Sound captions");
  const rows = [];
  for (let i = 0; i < CAPTION.max; i++) {
    const el = doc.createElement("div");
    el.className = "caption-line";
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
    const dir = doc.createElement("i");
    dir.className = "caption-dir";
    const label = doc.createElement("span");
    el.append(dir, label);
    root.append(el);
    rows.push({ el, dir, label, shown: false, text: "", deg: NaN, color: "", line: null, count: 0, near: false, word: "" });
  }
  const speaker = doc.createElement("p");
  speaker.className = "sr-caption";
  root.append(speaker);
  doc.body?.append?.(root);

  const lines = [];
  const spare = [];
  const pending = []; // texts waiting for the screen reader
  let lastSpoken = -Infinity;
  let heartHeld = false; // HEARTBEAT is captioned once per low-HP entry
  let shown = false;
  let dirty = true;

  const mode = () => {
    const m = ctx.prefs?.captions;
    return m === "captions" || m === "icons" ? m : "off";
  };
  const palette = () => PALETTES[validPalette(ctx.prefs?.palette)];

  function onSound({ name, x, z, src } = {}) {
    const run = ctx.run;
    const p = run?.player;
    const m = mode();
    if (m === "off" || !p || run.demo || ctx.mode !== "play" || ctx.cinematic) return;
    const row = captionFor(name, src);
    if (!row) return;
    const placed = Number.isFinite(x) && Number.isFinite(z);
    if (row.offscreen && (!placed || onScreen?.(x, z))) return;
    if (row.once) {
      if (heartHeld) return;
      heartHeld = true;
    }
    const bearing = placed ? (bearingOf?.(x - p.x, z - p.z, p) ?? null) : null;
    if (m === "icons") {
      // Screen angle y-down/0-right -> the ring's 0-up clockwise angle.
      if (bearing !== null) threats?.pip(bearing + Math.PI / 2, (row.cls && palette()[row.cls]) || "#ded6be");
      return;
    }
    const near = placed && Math.hypot(x - p.x, z - p.z) < CAPTION.near;
    const line = pushCaption(lines, { text: row.text, cls: row.cls, bearing, near }, spare);
    if (line.count === 1 && pending.length < CAPTION.max) pending.push(row.text);
    dirty = true;
  }

  function render(visible) {
    const on = visible && lines.length > 0;
    if (on !== shown) root.classList.toggle("hidden", !(shown = on));
    if (!dirty) return;
    dirty = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = lines[i];
      if (!line) {
        if (r.shown) {
          r.shown = false;
          r.el.style.display = "none";
        }
        continue;
      }
      if (!r.shown) {
        r.shown = true;
        r.el.style.display = "";
      }
      if (r.word !== line.text || r.count !== line.count || r.near !== line.near) {
        r.word = line.text;
        r.count = line.count;
        r.near = line.near;
        r.label.textContent = captionText(line);
      }
      const deg = line.bearing === null ? NaN : Math.round((line.bearing * 180) / Math.PI);
      if (!(deg === r.deg || (Number.isNaN(deg) && Number.isNaN(r.deg)))) {
        r.deg = deg;
        r.dir.style.visibility = Number.isNaN(deg) ? "hidden" : "";
        if (!Number.isNaN(deg)) r.dir.style.transform = `rotate(${deg}deg)`;
      }
      const color = (line.cls && palette()[line.cls]) || "#ded6be";
      if (color !== r.color) r.dir.style.color = r.color = color;
    }
  }

  // Every step: dt > 0 only on played steps (lines age in sim time); visible = a live run in play.
  function update(dt, visible) {
    const p = ctx.run?.player;
    if (heartHeld && p && p.max > 0 && p.hp / p.max >= CAPTION.lowHp) heartHeld = false;
    if (dt > 0 && lines.length && tickCaptions(lines, dt, spare)) dirty = true;
    if (mode() !== "captions" && lines.length) {
      while (lines.length) spare.push(lines.pop());
      dirty = true;
    }
    render(visible);
    // Screen readers: at most 2 announcements per second, in real time.
    const now = ctx.time?.real ?? 0;
    if (pending.length && now - lastSpoken >= CAPTION.announceGap) {
      lastSpoken = now;
      speaker.textContent = pending.shift();
    }
  }

  function clear() {
    while (lines.length) spare.push(lines.pop());
    pending.length = 0;
    heartHeld = false;
    dirty = true;
    render(false);
  }

  // Overlap check: three sample lines, then the real state again.
  function preview() {
    const saved = lines.splice(0, lines.length);
    const wasShown = shown;
    for (const text of ["SNIPER AIMING", "WARDEN RING", "GROUND RUMBLES"]) pushCaption(lines, { text, cls: "aim", bearing: 0, near: true }, []).count = 3;
    dirty = true;
    render(true);
    return () => {
      lines.length = 0;
      lines.push(...saved);
      dirty = true;
      render(wasShown);
    };
  }

  ctx.bus.on("sound", onSound);
  return { update, clear, preview, onSound, root };
}
