// Icon chips (IMPROVEMENTS §3.11): the 8 × 8 bitmaps of data/icons.js as crisp inline SVG. Each
// lit run of a row becomes one <rect>, drawn at ×2 (16 px) or ×3 (24 px) with
// shape-rendering="crispEdges", so chips stay pixel-exact at any UI scale. Relic, omen, affix,
// upgrade, mod and dash-trait chips never use font glyphs.
import { ICONS } from "../data/icons.js";
import { RELICS } from "../data/relics.js";
import { AFFIXES } from "../data/affixes.js";
import { OMENS } from "../data/omens.js";
import { WEAPONS } from "../data/weapons.js";

// Relic card borders and chips by rarity (F9.3).
export const RARITY_COLORS = Object.freeze({ common: "#ded6be", rare: "#91cfff", cursed: "#cd7767" });
const OMEN_COLOR = "#bc565a";
// The Wave-1 card colours: the upgrade glyph gold, each mod its weapon's colour, and the dash
// traits the Rift Echo ghost cyan and the Void Wake trail grey.
const UPGRADE_COLOR = "#c7b77b";
const TRAIT_COLORS = Object.freeze({ echo: "#81ffff", wake: "#9dacc7" });
const FALLBACK_COLOR = "#ded6be";
const HEX = /^#[0-9a-f]{3,8}$/i;

const cache = new Map(); // "id|scale|color" -> svg markup

// The ICONS key for an id. Ledger sources and codex rows name relics and omens with a kind
// prefix ("relic:witch_glass", "omen:iron"); the bitmaps use the bare id.
export function iconKey(id) {
  const text = String(id ?? "");
  if (text in ICONS) return text;
  const bare = text.slice(text.indexOf(":") + 1);
  return bare in ICONS ? bare : null;
}

// The chip colour of an id: rarity for relics, the affix colour, omen red, or the Wave-1 card
// colours for upgrades, mods and dash traits.
export function iconColor(id) {
  const key = iconKey(id);
  if (!key) return FALLBACK_COLOR;
  if (RELICS[key]) return RARITY_COLORS[RELICS[key].rarity] ?? FALLBACK_COLOR;
  if (AFFIXES[key]) return AFFIXES[key].color;
  if (OMENS[key]) return OMEN_COLOR;
  if (key.startsWith("upgrade:")) return UPGRADE_COLOR;
  if (key.startsWith("mod:")) return WEAPONS[Number(key.slice(4))]?.color ?? UPGRADE_COLOR;
  if (key.startsWith("trait:")) return TRAIT_COLORS[key.slice(6)] ?? FALLBACK_COLOR;
  return FALLBACK_COLOR;
}

// <rect>s for one bitmap, with horizontal runs merged per row.
function rects(rows) {
  let out = "";
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (row[end] === "#") end++;
      out += `<rect x="${x}" y="${y}" width="${end - x}" height="1"/>`;
      x = end;
    }
  }
  return out;
}

// iconSvg(id, scale = 2, color = iconColor(id)) -> one <svg> string, or "" for an unknown id.
// The markup is built from the bitmap table and a validated colour only, so it is safe to
// assign with innerHTML.
export function iconSvg(id, scale = 2, color) {
  const key = iconKey(id);
  if (!key) return "";
  const size = 8 * (scale === 3 ? 3 : 2);
  const fill = HEX.test(String(color)) ? color : iconColor(key);
  const cacheKey = `${key}|${size}|${fill}`;
  let svg = cache.get(cacheKey);
  if (!svg) {
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" class="icon-svg" width="${size}" height="${size}" viewBox="0 0 8 8" ` +
      `shape-rendering="crispEdges" fill="${fill}" aria-hidden="true" focusable="false">${rects(ICONS[key])}</svg>`;
    cache.set(cacheKey, svg);
  }
  return svg;
}

// A chip element: <span class="icon-chip"> holding the SVG, labelled for screen readers (the
// Wave-1 Unicode icon fields and names stay only as labels). Returns null for an unknown id.
export function iconChip(id, { scale = 2, color, label = "" } = {}) {
  const svg = iconSvg(id, scale, color);
  const doc = globalThis.document;
  if (!svg || !doc) return null;
  const chip = doc.createElement("span");
  chip.className = `icon-chip icon-x${scale === 3 ? 3 : 2}`;
  chip.innerHTML = svg;
  if (label) {
    chip.setAttribute("role", "img");
    chip.setAttribute("aria-label", label);
    chip.title = label;
  } else chip.setAttribute("aria-hidden", "true");
  return chip;
}
