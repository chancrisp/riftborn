// Leaderboard panel (#leaderboard, IMPROVEMENTS F15): board tabs ORIGINAL · RIFT · ASSISTED
// over NORMAL · DEATH, the board table (built here, per board), this device's personal
// results, your own rows highlighted and a YOUR BEST footer when none reaches the top. Row
// values are always set as text, never HTML: names and titles are player-reported. The only
// markup assigned is built from this build's own tables (trophy cups, omen chips).
import { BOARD_SUBS, BOARD_TABS, TROPHIES, boardAt, compareRows, isShared } from "../meta/boards.js";
import { payloadMultiplier } from "../meta/logic/plausible.js";
import { GAMEPLAY_VERSIONS } from "../data/stages.js";
import { OMENS } from "../data/omens.js";
import { iconChip } from "./icons.js";

const DATE_FORMAT = Object.freeze({ year: "numeric", month: "short", day: "numeric" });
const LOADING = "Loading scores…";
const UNAVAILABLE = "Remote leaderboard unavailable. Personal results below; Refresh to retry.";
const NO_PERSONAL = "No personal results for this mode.";
const OWN_ROW = "#2e3a2e";
const SVG_NS = "http://www.w3.org/2000/svg";
// The checkbox under the RIFT and ASSISTED tabs (both default on).
const FILTER_TEXT = Object.freeze({ RIFT: "THIS VERSION ONLY", ASSISTED: "THIS RULESET ONLY" });

// Remote ORIGINAL rows may lack the run id (the artifact board stores none), so a run is also
// recognised by when it was played, its score and its name.
const runKey = (s) => `${s.played_at}|${s.score}|${s.name}`;

function formatDate(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, DATE_FORMAT) : "—";
}

const reach = (s) => (s.outcome === "victory" ? "VICTORY" : Number.isInteger(s.stage) ? `STAGE ${s.stage}` : "—");

// A 16 × 16 pixel cup (TROPHIES rows drawn in 2-px blocks) with its place as the label.
function trophy(rank) {
  const t = TROPHIES[rank];
  const doc = globalThis.document;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "rank-cup");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("fill", t.color);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${t.place} place ${t.tone} trophy`);
  svg.style.marginLeft = "7px";
  svg.style.verticalAlign = "middle";
  t.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "#") continue;
      const rect = doc.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      svg.append(rect);
    }
  });
  return svg;
}

function deathMark() {
  const img = globalThis.document.createElement("img");
  img.className = "death-run-mark";
  img.src = "assets/death-skull.png";
  img.width = 24;
  img.height = 24;
  img.alt = "Death Mode";
  img.title = "Death Mode run";
  return img;
}

export function createLeaderboard(ctx) {
  const doc = globalThis.document;
  const $ = (selector) => doc.querySelector(selector);
  let tab = "ORIGINAL"; // kept for the page session, independent of the menu's Death Mode
  let sub = "NORMAL";
  const filters = { RIFT: true, ASSISTED: true };
  let request = 0; // stale-response guard
  let view = null;

  function el(tag, props = {}, children = []) {
    const node = doc.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function cell(text) {
    return el("td", { textContent: text });
  }

  function button(id, text, onClick) {
    const b = el("button", { type: "button", id, textContent: text });
    b.addEventListener("click", onClick);
    return b;
  }

  function table(label, bodyId) {
    const head = el("tr");
    const body = el("tbody", { id: bodyId });
    const node = el("table", {}, [el("thead", {}, [head]), body]);
    node.setAttribute("aria-label", label);
    return { wrap: el("div", { className: "table-scroll" }, [node]), head, body };
  }

  // Replaces the panel's static contents (everything but the header and REFRESH) with the
  // dynamic board view.
  function build() {
    const panel = $("#leaderboard .leaderboard-panel");
    if (!panel) return null;
    const refresh = $("#refreshLeaderboard");
    for (const child of [...panel.children]) if (!child.classList?.contains("panel-head") && child !== refresh) child.remove();
    const tabs = el("div", { className: "ranking-tabs" });
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Board");
    tabs.style.gridTemplateColumns = `repeat(${BOARD_TABS.length}, 1fr)`;
    const subs = el("div", { className: "ranking-tabs" });
    subs.setAttribute("role", "group");
    subs.setAttribute("aria-label", "Ranking mode");
    const v = {
      tabs: BOARD_TABS.map((name) =>
        button(`boardTab${name}`, name, () => {
          tab = name;
          render();
        }),
      ),
      // Wave-1 ids for the mode buttons.
      subs: BOARD_SUBS.map((name) =>
        button(`board${name.toLowerCase()}`, name, () => {
          sub = name;
          render();
        }),
      ),
      filter: el("input", { type: "checkbox", id: "boardFilter" }),
      filterText: el("span"),
      status: el("p", { id: "leaderboardStatus" }),
      board: table("Leaderboard", "leaderboardRows"),
      best: el("p", { id: "boardYourBest", className: "settings-hint" }),
      personalStatus: el("p", { id: "personalStatus" }),
      personal: table("Personal results", "personalRows"),
      details: null,
    };
    v.status.setAttribute("role", "status");
    v.filter.addEventListener("change", () => {
      if (!FILTER_TEXT[tab]) return;
      filters[tab] = !!v.filter.checked;
      render();
    });
    v.filterRow = el("label", { className: "board-filter" }, [v.filter, v.filterText]);
    tabs.append(...v.tabs);
    subs.append(...v.subs);
    v.details = el("details", {}, [el("summary", { textContent: "PERSONAL RESULTS · THIS DEVICE" }), v.personalStatus, v.personal.wrap]);
    const nodes = [tabs, subs, v.filterRow, v.status, v.board.wrap, v.best, v.details];
    for (const node of nodes) {
      if (refresh?.parentNode === panel) panel.insertBefore(node, refresh);
      else panel.append(node);
    }
    refresh?.addEventListener("click", () => render());
    return v;
  }

  function setHead(head, b) {
    const names = ["RANK", "PLAYER", ...(b.tab === "RIFT" ? ["RIFT"] : []), "SCORE", "REACH", "DATE"];
    head.replaceChildren(
      ...names.map((name) => {
        const th = el("th", { textContent: name });
        th.setAttribute("scope", "col");
        return th;
      }),
    );
  }

  // ORIGINAL rows show their version; RIFT and ASSISTED rows also the multiplier of a KEEPERS
  // run, the equipped title, an assisted speed and the unverified flag. Then YOU.
  function metaText(b, s, mine) {
    const parts = ["VERSION " + (s.gameplay_version || "UNRECORDED")];
    if (isShared(b)) {
      if (s.ruleset === "keepers") parts.push("X" + payloadMultiplier(s).toFixed(2));
      if (typeof s.title === "string" && s.title) parts.push(s.title);
      if (Number.isFinite(s.speed) && s.speed < 100) parts.push(`SPEED ${s.speed}%`);
      if (s.unverified) parts.push("UNVERIFIED");
    }
    if (mine) parts.push("YOU");
    return parts.join(" · ");
  }

  function nameCell(b, s, rank, trophies, mine) {
    const name = cell(String(s.name ?? ""));
    if (trophies && rank < TROPHIES.length) name.append(trophy(rank));
    if (s.death_mode === true) name.append(deathMark());
    const meta = el("small", { className: "score-meta", textContent: metaText(b, s, mine) });
    if (isShared(b) && Array.isArray(s.omens))
      for (const id of s.omens) {
        const chip = typeof id === "string" && Object.hasOwn(OMENS, id) ? iconChip(id, { label: OMENS[id].name }) : null;
        if (chip) meta.append(chip);
      }
    name.append(meta);
    return name;
  }

  const isMine = (own, s) => own.has(s.id) || (!!s.run_id && own.has(s.run_id)) || own.has(runKey(s));

  function scoreRow(b, s, rank, { trophies = false, own = null } = {}) {
    const mine = !!own && isMine(own, s);
    const cells = [cell(String(rank + 1)), nameCell(b, s, rank, trophies, mine)];
    if (b.tab === "RIFT") cells.push(cell(Number(s.rift_score ?? 0).toLocaleString()));
    cells.push(cell(Number(s.score).toLocaleString()), cell(reach(s)), cell(formatDate(s.played_at)));
    const tr = el("tr");
    if (mine) {
      tr.className = "own-run";
      for (const td of cells) td.style.background = OWN_ROW;
    }
    tr.append(...cells);
    return tr;
  }

  const board = () => boardAt(tab, sub);

  // This device's runs: the Journal's history plus the personal results of the board.
  function ownRuns(b) {
    const keys = new Set();
    for (const r of ctx.profile?.data?.runs ?? []) if (typeof r?.id === "string") keys.add(r.id);
    for (const r of ctx.scores?.personal?.(b.id, Infinity) ?? []) {
      if (typeof r.id === "string") keys.add(r.id);
      if (typeof r.run_id === "string") keys.add(r.run_id);
      keys.add(runKey(r));
    }
    return keys;
  }

  // RIFT: this gameplay version only; ASSISTED: the ruleset this device plays (both default on).
  function filtered(b, rows) {
    if (b.tab === "RIFT" && filters.RIFT) return rows.filter((r) => r.gameplay_version === GAMEPLAY_VERSIONS.keepers);
    if (b.tab === "ASSISTED" && filters.ASSISTED) return rows.filter((r) => r.ruleset === rulesetShown());
    return rows;
  }

  const rulesetShown = () => (ctx.prefs?.ruleset === "original" ? "original" : "keepers");

  function headline(b, result, count) {
    if (!isShared(b)) return result.status;
    const scope = b.tab === "RIFT" ? (filters.RIFT ? GAMEPLAY_VERSIONS.keepers : "ALL VERSIONS") : filters.ASSISTED ? rulesetShown().toUpperCase() : "BOTH RULESETS";
    const note = result.status || "PLAYER-REPORTED";
    return count ? `TOP ${b.limit} ${b.tab} · ${b.sub} · ${scope} · ${note}` : `No ${b.tab} · ${b.sub} scores yet · ${scope} · ${note}`;
  }

  // YOUR BEST · RANK {r} · {score} when none of your rows made the visible top.
  function yourBest(b, rows, own) {
    if (rows.slice(0, b.limit).some((s) => isMine(own, s))) return "";
    const listed = rows.findIndex((s) => isMine(own, s));
    const mine = filtered(b, ctx.scores?.personal?.(b.id, Infinity) ?? [])[0];
    if (listed < 0 && !mine) return "";
    const best = listed >= 0 ? rows[listed] : mine;
    const order = compareRows(b);
    const rank = listed >= 0 ? String(listed + 1) : `${rows.filter((s) => order(s, best) < 0).length + 1}+`;
    return `YOUR BEST · RANK ${rank} · ${Number(best[b.rank] ?? 0).toLocaleString()}`;
  }

  function syncControls(b) {
    view.tabs.forEach((node, i) => node.setAttribute("aria-pressed", String(BOARD_TABS[i] === tab)));
    view.subs.forEach((node, i) => node.setAttribute("aria-pressed", String(BOARD_SUBS[i] === sub)));
    const text = FILTER_TEXT[b.tab];
    view.filterRow.hidden = !text;
    view.filterText.textContent = text ? " " + text : "";
    view.filter.checked = !!filters[b.tab];
    setHead(view.board.head, b);
    setHead(view.personal.head, b);
  }

  function personalRows(b) {
    const rows = ctx.scores?.personal?.(b.id) ?? [];
    view.personal.body.replaceChildren(...rows.map((s, rank) => scoreRow(b, s, rank)));
    view.personalStatus.textContent = rows.length ? "" : NO_PERSONAL;
    return rows;
  }

  // Called by menus when #leaderboard opens; also by the tabs, the filter and REFRESH. A
  // response for a board that is no longer selected is dropped.
  async function render() {
    view ||= build();
    if (!view) return;
    const id = ++request;
    const b = board();
    syncControls(b);
    view.board.body.replaceChildren();
    view.status.textContent = LOADING;
    view.best.textContent = "";
    const personal = personalRows(b);
    let result;
    try {
      result = await ctx.scores.list(b.id);
    } catch {
      result = { rows: [], status: UNAVAILABLE };
    }
    if (id !== request) return;
    const own = ownRuns(b);
    const rows = filtered(b, result.rows ?? []);
    const top = rows.slice(0, b.limit);
    view.status.textContent = headline(b, result, top.length);
    view.board.body.replaceChildren(...top.map((s, rank) => scoreRow(b, s, rank, { trophies: true, own })));
    view.best.textContent = yourBest(b, rows, own);
    // With no rows to show, surface this device's results instead of a blank table.
    if (!top.length && personal.length) view.details.setAttribute("open", "");
  }

  return {
    render,
    // The selected board id and its NORMAL / DEATH mode.
    get board() {
      return board().id;
    },
    get mode() {
      return sub.toLowerCase();
    },
  };
}
