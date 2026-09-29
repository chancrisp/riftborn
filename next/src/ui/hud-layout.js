// HUD layout (IMPROVEMENTS §3.13, F18.6): the slot table as data, the overlap check behind the
// practice CHECK HUD button, and the static HUD roots that zoom with prefs.uiScale.
//
// A slot is an anchor, an offset and a maximum box at UI scale 100; css/hud.css caps every
// element to its box, so if the boxes never intersect neither do the elements. `.ui-scaled`
// zoom multiplies px offsets and sizes; viewport fractions (the vw caps, written in CSS as
// `calc(Nvw / var(--ui-scale))`) stay the same share of the screen.

// Static HUD roots that zoom with the UI scale. World-anchored layers (#damageNumbers,
// #playerVitals, #dashPips, #crosshair, #hurtRing, #threatEdge, #elitePlates) are positioned in
// screen pixels from camera projections, so they never zoom.
export const UI_SCALED = Object.freeze([
  "header",
  "#modeBadge",
  "#status",
  "#weapons",
  "#portalCompass",
  "#bossHUD",
  "#stageObjective",
  "#trialStatus",
  "#modStatus",
  "#powerupStatus",
  "#difficultyMeter",
  "#interactPrompt",
  "#trackedGoal",
  "#buildCue",
  "#tutorialGuide",
  "#waveToast",
]);

// Past this width a scaled-up HUD keeps the Wave-1 centred weapon row; at or below it the row
// moves to the right edge (body.ui-big, css/hud.css) so the status block keeps its room. On
// phones a scaled-up row narrows its slots (58 -> 52 px) so it still fits 390 px.
export const BIG_ROW_MAX = 1440;

// slot(id, anchor, y, x, box): anchor is "top" (full width), "tl", "tc", "tr", "bl", "bc" or
// "br"; y is the offset from the top or bottom edge, x from the side (for "bc"/"tc" slots with
// `from`, the left edge's offset from the screen centre). box: { w, h } px and optional wv, a
// viewport-width cap (the box is min(w, wv) wide, or wv alone when w is absent).
const slot = (id, anchor, y, x, box, big = null) => Object.freeze({ id, anchor, y, x, ...box, big: big && Object.freeze(big) });

export const SLOTS = Object.freeze({
  desktop: Object.freeze([
    slot("header", "top", 0, 0, { wv: 1, h: 60 }),
    slot("#modeBadge", "tc", 70, 0, { w: 340, wv: 0.9, h: 16 }),
    slot("#portalCompass", "tc", 92, 0, { w: 320, h: 50 }),
    slot("#stageObjective", "tc", 151, 0, { w: 340, h: 36 }),
    slot("#bossHUD", "tc", 192, 0, { w: 440, wv: 0.6, h: 30 }),
    slot("#difficultyMeter", "tl", 84, 18, { w: 300, h: 36 }),
    slot("#powerupStatus", "tl", 122, 18, { w: 300, h: 60 }),
    slot("#radar", "tr", 70, 18, { w: 112, h: 112 }),
    slot("#featCue", "tr", 190, 18, { w: 240, h: 40 }),
    slot("#trackedGoal", "tr", 240, 20, { wv: 0.45, h: 40 }),
    slot("#captions", "bl", 224, 28, { w: 320, h: 66 }),
    slot("#modStatus", "bl", 196, 20, { w: 200, h: 20 }),
    slot("#relicStrip", "bl", 136, 28, { w: 236, h: 52 }),
    slot("#status", "bl", 28, 28, { w: 319, h: 98 }),
    slot("#weapons", "bc", 26, 0, { w: 390, h: 68 }, { anchor: "br", x: 24 }),
    slot("#fireLock", "bc", 30, 207, { w: 80, h: 14, from: true }, { anchor: "br", y: 98, x: 24 }),
    slot("#interactPrompt", "bc", 136, 0, { w: 440, h: 36 }),
  ]),
  phone: Object.freeze([
    slot("header", "top", 0, 0, { wv: 1, h: 44 }),
    slot("#radar", "tl", 44, 8, { w: 72, h: 72 }),
    slot("#modeBadge", "tc", 50, 0, { wv: 0.4, h: 16 }),
    slot("#difficultyMeter", "tr", 48, 8, { wv: 0.26, h: 38 }),
    slot("#powerupStatus", "tr", 90, 8, { wv: 0.26, h: 40 }),
    slot("#portalCompass", "tc", 79, 0, { wv: 0.42, h: 48 }),
    slot("#stageObjective", "tc", 132, 0, { wv: 0.6, h: 36 }),
    slot("#bossHUD", "tc", 176, 0, { wv: 0.6, h: 30 }),
    slot("#featCue", "tc", 214, 0, { wv: 0.6, h: 20 }),
    slot("#trackedGoal", "tl", 250, 8, { wv: 0.45, h: 40 }),
    slot("#status", "bl", 98, 16, { w: 234, h: 76 }),
    slot("#relicStrip", "bl", 178, 16, { w: 156, h: 20 }),
    slot("#modStatus", "bl", 202, 16, { w: 200, h: 20 }),
    slot("#captions", "bl", 226, 16, { wv: 0.6, h: 60 }),
    slot("#interactPrompt", "bc", 294, 0, { wv: 0.9, h: 34 }),
    slot("#weapons", "bc", 16, 0, { w: 310, h: 62 }, { w: 280 }),
    slot("#fireLock", "bc", 82, 75, { w: 80, h: 14, from: true }, { x: 60 }),
  ]),
});

// The slot boxes of a layout ("desktop" | "phone") for a vw × vh screen at a UI scale (1, 1.15,
// 1.3), as [{ id, left, top, right, bottom }] in screen px.
export function slotBoxes(layout, vw, vh, scale = 1) {
  const big = scale > 1 && (layout === "phone" || vw <= BIG_ROW_MAX);
  return (SLOTS[layout] ?? []).map((s) => {
    const o = big && s.big ? { ...s, ...s.big } : s;
    const px = o.w === undefined ? Infinity : o.w * scale;
    const w = Math.min(px, o.wv === undefined ? Infinity : o.wv * vw);
    const h = o.h * scale;
    const y = o.y * scale;
    const x = o.x * scale;
    let left;
    if (o.anchor === "top") left = 0;
    else if (o.anchor[1] === "l") left = x;
    else if (o.anchor[1] === "r") left = vw - x - w;
    else left = o.from ? vw / 2 + x : vw / 2 - w / 2;
    const top = o.anchor === "top" || o.anchor[0] === "t" ? y : vh - y - h;
    return { id: s.id, left, top, right: left + w, bottom: top + h };
  });
}

// Pairs of boxes that share area (touching edges do not count; empty boxes never overlap), as
// [[idA, idB], ...] in table order.
export function findOverlaps(boxes) {
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (!(a.right > a.left && a.bottom > a.top)) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (!(b.right > b.left && b.bottom > b.top)) continue;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push([a.id, b.id]);
    }
  }
  return out;
}

// The live boxes of the slot elements that are laid out and visible. The header is measured by
// its three children: its own box is a transparent full-width strip with padding.
export function measureSlots(doc = globalThis.document, view = globalThis) {
  const boxes = [];
  const layout = (view.innerWidth ?? 1280) <= 700 ? "phone" : "desktop";
  for (const s of SLOTS[layout]) {
    const els = s.id === "header" ? [...(doc?.querySelectorAll?.("header > *") ?? [])] : [doc?.querySelector?.(s.id)];
    for (const el of els) {
      if (!el || !shown(el, view)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxes.push({ id: s.id === "header" ? `header .${el.className || el.tagName}` : s.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return boxes;
}

function shown(el, view) {
  if (el.closest?.(".hidden")) return false;
  const style = view.getComputedStyle?.(el);
  return !style || (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0");
}
