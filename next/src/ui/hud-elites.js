// Elite name plates (IMPROVEMENTS F8): `{AFFIX} {NAME}` in 9 px Crypt with the affix icons, above
// the elite's always-on bar; shown on screen within 20 m, at most 6, nearest first. The HUD's bar
// pass offers each placed elite bar (consider), then commit() assigns the pool. A plate keeps
// its elite while it stays selected, so text and icons are rewritten only when the owner or its
// enraged state changes.
import { AFFIXES } from "../data/affixes.js";
import { iconSvg } from "./icons.js";

export const PLATES = Object.freeze({ max: 6, range: 20, lift: 5 });

// "HASTED WARDED SNIPER", "ENRAGED BOUND LEAPER" (the elites system's title when present).
export function plateTitle(e, title = null) {
  if (title) return title(e);
  const affixes = (e?.elite ?? []).map((id) => AFFIXES[id]?.name ?? String(id).toUpperCase()).join(" ");
  return `${e?.eliteEnraged ? "ENRAGED " : ""}${affixes} ${String(e?.def?.name ?? e?.kind ?? "").toUpperCase()}`.trim();
}

// Picks the nearest `max` candidates ([{ e, dist }], first n used) into the front of the array,
// nearest first (partial selection sort, in place).
export function nearestFirst(list, n, max = PLATES.max) {
  const k = Math.min(n, max);
  for (let i = 0; i < k; i++) {
    let best = i;
    for (let j = i + 1; j < n; j++) if (list[j].dist < list[best].dist) best = j;
    if (best !== i) {
      const t = list[i];
      list[i] = list[best];
      list[best] = t;
    }
  }
  return k;
}

export function createElitePlates(ctx) {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  root.id = "elitePlates";
  root.setAttribute("aria-hidden", "true");
  const plates = [];
  for (let i = 0; i < PLATES.max; i++) {
    const el = doc.createElement("div");
    el.className = "elite-plate";
    el.style.display = "none";
    const icons = doc.createElement("span");
    icons.className = "plate-icons";
    const name = doc.createElement("span");
    el.append(icons, name);
    root.append(el);
    plates.push({ el, icons, name, owner: null, enraged: null, left: NaN, top: NaN, shown: false, keep: false });
  }
  doc.body?.append?.(root);
  const list = [];
  let n = 0;

  function begin() {
    n = 0;
  }

  // An elite whose bar was placed this step at screen (x, y), `dist` metres from the player.
  function consider(e, x, y, dist) {
    if (!(dist <= PLATES.range)) return;
    const c = list[n] ?? (list[n] = { e: null, x: 0, y: 0, dist: 0 });
    c.e = e;
    c.x = x;
    c.y = y;
    c.dist = dist;
    n++;
  }

  function commit() {
    const k = nearestFirst(list, n);
    for (const p of plates) p.keep = false;
    // Plates already showing a selected elite keep it; the rest take free plates.
    for (let i = 0; i < k; i++) {
      const c = list[i];
      let plate = null;
      for (const p of plates) if (p.owner === c.e) plate = p;
      if (plate) place(plate, c);
    }
    for (let i = 0; i < k; i++) {
      const c = list[i];
      let owned = false;
      for (const p of plates) if (p.keep && p.owner === c.e) owned = true;
      if (owned) continue;
      let free = null;
      for (const p of plates) if (!p.keep) (free ??= p);
      if (free) place(free, c);
    }
    for (const p of plates) if (!p.keep) hide(p);
    for (let i = 0; i < n; i++) list[i].e = null;
  }

  function place(p, c) {
    p.keep = true;
    const e = c.e;
    const enraged = !!e.eliteEnraged;
    if (p.owner !== e || p.enraged !== enraged) {
      p.owner = e;
      p.enraged = enraged;
      p.name.textContent = plateTitle(e, ctx.elites?.title);
      let icons = "";
      for (const id of e.elite ?? []) icons += iconSvg(id, 2, AFFIXES[id]?.color);
      p.icons.innerHTML = icons;
      p.el.style.color = AFFIXES[e.elite?.[0]]?.color ?? "";
    }
    const left = Math.round(c.x);
    const top = Math.round(c.y - PLATES.lift);
    if (left !== p.left) p.el.style.left = (p.left = left) + "px";
    if (top !== p.top) p.el.style.top = (p.top = top) + "px";
    if (!p.shown) {
      p.shown = true;
      p.el.style.display = "";
    }
  }

  function hide(p) {
    p.owner = null;
    if (!p.shown) return;
    p.shown = false;
    p.el.style.display = "none";
  }

  function clear() {
    n = 0;
    for (const p of plates) hide(p);
  }

  return { begin, consider, commit, clear, root };
}
