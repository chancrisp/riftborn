// KEEPERS-only HUD widgets: the Rift Chain line inside #status and the #featCue stack
// (IMPROVEMENTS F11), and the #relicStrip (F9.4). Under ORIGINAL, in the demo and outside runs
// they stay hidden. Every widget diffs its writes; timers run in sim time (dt > 0 on played steps).
import { TIERS, FEATS } from "../data/scoring.js";
import { RELICS } from "../data/relics.js";
import { formatInt } from "../core/util.js";
import { iconSvg } from "./icons.js";

export const CHAIN_HUD = Object.freeze({ show: 3, tierFlash: 1, breakFlash: 1.2, breakMin: 10, blinkStep: 0.25 });
const SEVERED = "#cd7767";
const ENDED = "#ded6be";
const FADING = "#9c9a8b";
export const FEAT_CUE = Object.freeze({ slide: 4 / 15, hold: 0.9, max: 2 });
export const RELIC_STRIP = Object.freeze({ perRow: 12, rows: 2, phoneRow: 8, reaperEvery: 40 });

// ---- chain line ---------------------------------------------------------------------------------

// The #chainLine text for a chain { count, tier, fading } (run.rift.chain plus run.rift.fading)
// and the flash on show (null, or { kind: "tier" | "sever" | "end", count, tier }):
// out = { text, color, blink }. A break shows `CHAIN SEVERED · 37` / `CHAIN ENDED · 37`, a tier-up
// its tier name (blinking), past the overtime grace `RIFT UNSTABLE · SCORE FADING`, and from 3
// kills `CHAIN 37 X1.25` in the tier colour.
export function chainLine(chain, flash = null, out = {}) {
  out.blink = false;
  const tier = TIERS[flash?.tier] ?? null;
  if (flash && (flash.kind === "sever" || flash.kind === "end")) {
    out.text = `CHAIN ${flash.kind === "sever" ? "SEVERED" : "ENDED"} · ${flash.count}`;
    out.color = flash.kind === "sever" ? SEVERED : ENDED;
  } else if (flash?.kind === "tier" && tier?.name) {
    out.text = tier.name;
    out.color = tier.color;
    out.blink = true;
  } else if (chain?.fading) {
    out.text = "RIFT UNSTABLE · SCORE FADING";
    out.color = FADING;
  } else if ((chain?.count ?? 0) >= CHAIN_HUD.show) {
    const t = TIERS[chain.tier] ?? TIERS[0];
    out.text = `CHAIN ${chain.count} X${t.mult.toFixed(2)}`;
    out.color = t.color;
  } else {
    out.text = "";
    out.color = "";
  }
  return out;
}

// The flash a "chain" bus event starts, or null: a tier-up always; a break only from 10 kills.
export function chainFlash({ event, count = 0, tier = 0 } = {}, out = {}) {
  if (event === "tier" && tier > 0) return Object.assign(out, { kind: "tier", count, tier, age: 0, life: CHAIN_HUD.tierFlash });
  if ((event === "sever" || event === "end") && count >= CHAIN_HUD.breakMin) return Object.assign(out, { kind: event, count, tier, age: 0, life: CHAIN_HUD.breakFlash });
  return null;
}

export function createChainLine(ctx, host) {
  const doc = globalThis.document;
  const el = doc.createElement("div");
  el.id = "chainLine";
  el.classList.add("hidden");
  host?.append?.(el);
  const flash = { kind: "", count: 0, tier: 0, age: 0, life: 0 };
  const out = { text: "", color: "", blink: false };
  let active = false; // flash live
  let shown = false;
  const last = { kind: null, count: -1, tier: -1, fading: null, flashCount: -1, flashTier: -1, dim: false, text: null, color: null };

  function onChain(payload) {
    if (!ctx.run?.rift || ctx.run.original || ctx.run.demo) return;
    if (chainFlash(payload, flash)) active = true;
  }

  // Every status refresh; dt > 0 only on played steps.
  function update(dt, run) {
    const r = run?.rift;
    const on = !!r && !run.original && !run.demo;
    if (on !== shown) el.classList.toggle("hidden", !(shown = on));
    if (!on) return;
    if (active && dt > 0 && (flash.age += dt) >= flash.life) active = false;
    const c = r.chain;
    const kind = active ? flash.kind : "";
    // The tier name blinks in 4 stepped frames over its second; steady under Reduce flashes.
    const dim = kind === "tier" && ctx.prefs?.flashes !== false && Math.floor(flash.age / CHAIN_HUD.blinkStep) % 2 === 1;
    if (dim !== last.dim) el.classList.toggle("dim", (last.dim = dim));
    if (
      kind === last.kind &&
      c.count === last.count &&
      c.tier === last.tier &&
      !!r.fading === last.fading &&
      flash.count === last.flashCount &&
      flash.tier === last.flashTier
    )
      return;
    last.kind = kind;
    last.count = c.count;
    last.tier = c.tier;
    last.fading = !!r.fading;
    last.flashCount = flash.count;
    last.flashTier = flash.tier;
    chainLine({ count: c.count, tier: c.tier, fading: r.fading }, active ? flash : null, out);
    if (out.text !== last.text) el.textContent = last.text = out.text;
    if (out.color !== last.color) el.style.color = last.color = out.color;
  }

  function clear() {
    active = false;
    last.kind = null;
    last.text = null;
    last.color = null;
  }

  function preview() {
    const was = { text: el.textContent, color: el.style.color, hidden: el.classList.contains("hidden") };
    el.textContent = "CHAIN 37 X1.25";
    el.classList.remove("hidden");
    return () => {
      el.textContent = was.text;
      el.style.color = was.color;
      el.classList.toggle("hidden", was.hidden);
    };
  }

  ctx.bus.on("chain", onChain);
  return { update, clear, preview, el };
}

// ---- feat cue -----------------------------------------------------------------------------------

// `SKEWER +150`: a cue feat's line (silent feats have none).
export function featText({ id, bonus = 0, cue } = {}) {
  const def = FEATS[id];
  if (!(cue ?? def?.cue)) return "";
  return `${def?.name ?? String(id ?? "").toUpperCase()} +${formatInt(bonus)}`;
}

export function createFeatCue(ctx) {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  root.id = "featCue";
  root.className = "ui-scaled";
  root.classList.add("hidden");
  root.setAttribute("role", "status");
  const rows = [];
  for (let i = 0; i < FEAT_CUE.max; i++) {
    const el = doc.createElement("div");
    el.className = "feat-line";
    el.style.display = "none";
    root.append(el);
    rows.push({ el, serial: -1, shown: false });
  }
  doc.body?.append?.(root);
  const lines = []; // [{ text, age, serial }] oldest first
  let serial = 0;
  let shown = false;
  let dirty = false;

  function onFeat(payload) {
    const run = ctx.run;
    if (!run?.rift || run.original || run.demo || ctx.mode !== "play") return;
    const text = featText(payload);
    if (!text) return;
    const line = lines.length >= FEAT_CUE.max ? lines.shift() : {};
    line.text = text;
    line.age = 0;
    line.serial = ++serial;
    lines.push(line);
    dirty = true;
  }

  function render(visible) {
    const on = visible && lines.length > 0;
    if (on !== shown) root.classList.toggle("hidden", !(shown = on));
    if (!dirty) return;
    dirty = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = lines[i];
      if (!line) {
        if (row.shown) row.el.style.display = "none";
        row.shown = false;
        row.serial = -1;
        continue;
      }
      if (!row.shown) row.el.style.display = "";
      row.shown = true;
      if (row.serial === line.serial) continue;
      const fresh = line.age === 0;
      row.serial = line.serial;
      row.el.textContent = line.text;
      // The 4-frame stepped slide-in restarts only for a new cue, not when one moves up.
      row.el.classList.remove("in");
      if (fresh) {
        void row.el.offsetWidth;
        row.el.classList.add("in");
      }
    }
  }

  function update(dt, visible) {
    if (dt > 0 && lines.length) {
      for (const line of lines) line.age += dt;
      while (lines.length && lines[0].age >= FEAT_CUE.slide + FEAT_CUE.hold) {
        lines.shift();
        dirty = true;
      }
    }
    render(visible);
  }

  function clear() {
    lines.length = 0;
    dirty = true;
    render(false);
  }

  function preview() {
    const saved = lines.splice(0, lines.length, { text: "SKEWER +150", age: 1, serial: ++serial }, { text: "DETONATION +1,250", age: 1, serial: ++serial });
    const wasShown = shown;
    dirty = true;
    render(true);
    return () => {
      lines.length = 0;
      lines.push(...saved);
      dirty = true;
      render(wasShown);
    };
  }

  ctx.bus.on("feat", onFeat);
  return { update, clear, preview, root };
}

// ---- relic strip --------------------------------------------------------------------------------

// How many relic chips fit and whether the last slot is a `+{n}` chip: 12 per row and 2 rows on
// desktop, one row of 8 on phones.
export function relicSlots(count, phone = false) {
  const room = phone ? RELIC_STRIP.phoneRow : RELIC_STRIP.perRow * RELIC_STRIP.rows;
  if (count <= room) return { chips: count, more: 0 };
  return { chips: room - 1, more: count - (room - 1) };
}

export function createRelicStrip(ctx) {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  root.id = "relicStrip";
  root.className = "ui-scaled";
  root.classList.add("hidden");
  root.setAttribute("aria-label", "Relics");
  const more = doc.createElement("span");
  more.className = "relic-chip relic-more";
  more.style.display = "none";
  root.append(more);
  doc.body?.append?.(root);
  const phone = globalThis.matchMedia?.("(max-width: 700px)") ?? null;
  const chips = []; // { el, id, spent, active, count, counter }
  const last = { count: -1, ferryman: null, stillwater: null, reaper: -1, phone: null, run: null };
  let shown = false;

  function chip(i) {
    let c = chips[i];
    if (!c) {
      const el = doc.createElement("span");
      el.className = "relic-chip";
      root.insertBefore(el, more);
      chips[i] = c = { el, id: "", spent: false, active: false, count: -1, counter: null, shown: true };
    }
    return c;
  }

  function write(run) {
    const relics = run.relics ?? [];
    const state = run.relicState ?? {};
    const { chips: n, more: extra } = relicSlots(relics.length, !!phone?.matches);
    for (let i = 0; i < n; i++) {
      const c = chip(i);
      const id = relics[i].id;
      if (!c.shown) c.el.style.display = "";
      c.shown = true;
      if (c.id !== id) {
        c.id = id;
        const def = RELICS[id];
        c.el.innerHTML = iconSvg(id, 2);
        c.el.title = def ? `${def.name} · ${def.text}` : id;
        c.el.setAttribute("aria-label", c.el.title);
        c.counter = null;
        c.count = -1;
      }
      const spent = id === "ferryman_coin" && state.ferryman === "spent";
      if (spent !== c.spent) c.el.classList.toggle("spent", (c.spent = spent));
      const active = id === "stillwater_idol" && !!state.stillwater;
      if (active !== c.active) c.el.classList.toggle("active", (c.active = active));
      if (id === "reaper_thread") {
        const count = state.reaper ?? 0;
        if (!c.counter) {
          c.counter = doc.createElement("b");
          c.counter.className = "relic-count";
          c.el.append(c.counter);
        }
        if (count !== c.count) c.counter.textContent = `${(c.count = count)}/${RELIC_STRIP.reaperEvery}`;
      }
    }
    for (let i = n; i < chips.length; i++) {
      if (chips[i].shown) chips[i].el.style.display = "none";
      chips[i].shown = false;
    }
    more.style.display = extra > 0 ? "" : "none";
    if (extra > 0) more.textContent = `+${extra}`;
  }

  // Every step: shown during a KEEPERS run with relics (the CSS hide lists cover menus,
  // sequences and transitions).
  function update(run, visible) {
    const on = visible && !!run && !run.original && !run.demo && (run.relics?.length ?? 0) > 0;
    if (on !== shown) root.classList.toggle("hidden", !(shown = on));
    if (!on) return;
    const state = run.relicState ?? {};
    const small = !!phone?.matches;
    if (
      last.run === run &&
      last.count === run.relics.length &&
      last.ferryman === state.ferryman &&
      last.stillwater === !!state.stillwater &&
      last.reaper === (state.reaper ?? 0) &&
      last.phone === small
    )
      return;
    last.run = run;
    last.count = run.relics.length;
    last.ferryman = state.ferryman;
    last.stillwater = !!state.stillwater;
    last.reaper = state.reaper ?? 0;
    last.phone = small;
    write(run);
  }

  function clear() {
    last.run = null;
  }

  // Overlap check: the fullest strip (every chip slot filled).
  function preview() {
    const wasShown = shown;
    const ids = Object.keys(RELICS);
    const sample = { relics: ids.map((id) => ({ id })), relicState: { reaper: 12 } };
    write(sample);
    root.classList.remove("hidden");
    return () => {
      last.run = null;
      shown = wasShown;
      root.classList.toggle("hidden", !wasShown);
      if (ctx.run) write(ctx.run);
    };
  }

  return { update, clear, preview, root };
}
