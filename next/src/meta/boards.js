// Boards of the Rift (IMPROVEMENTS F15): the board registry, run routing, the v2 payload and the
// local board rules (sort, insert, prune). ORIGINAL boards keep the Wave-1 worker (or the
// artifact `scores` collection); RIFT and ASSISTED boards live in the artifact `runs2`
// collection with a local mirror, or on this device only. THREE-free and DOM-free.
import { FEATS } from "../data/scoring.js";
import { OMENS } from "../data/omens.js";
import { RELICS } from "../data/relics.js";
import { KEEPERS } from "../data/keepers.js";

const desc = (field) => Object.freeze([field, -1]);
const asc = (field) => Object.freeze([field, 1]);
// { id, tab, sub, backend, rank, order, limit }: rows sort by `rank` desc, then `order`.
const board = (id, tab, sub, backend, rank, order, limit) => Object.freeze({ id, tab, sub, backend, rank, order: Object.freeze(order), limit });

export const BOARDS = Object.freeze([
  board("normal", "ORIGINAL", "NORMAL", "worker", "score", [desc("wave"), desc("seconds")], 20),
  board("death", "ORIGINAL", "DEATH", "worker", "score", [desc("wave"), desc("seconds")], 10),
  board("rift-normal", "RIFT", "NORMAL", "runs2", "rift_score", [desc("stage"), asc("seconds")], 20),
  board("rift-death", "RIFT", "DEATH", "runs2", "rift_score", [desc("stage"), asc("seconds")], 20),
  board("assisted-normal", "ASSISTED", "NORMAL", "runs2", "score", [desc("stage")], 20),
  board("assisted-death", "ASSISTED", "DEATH", "runs2", "score", [desc("stage")], 20),
]);

export const BOARD_TABS = Object.freeze(["ORIGINAL", "RIFT", "ASSISTED"]);
export const BOARD_SUBS = Object.freeze(["NORMAL", "DEATH"]);
export const LOCAL_DEPTH = 50; // rows kept per board on this device and read from runs2

export const boardOf = (id) => BOARDS.find((b) => b.id === id) ?? null;
export const boardAt = (tab, sub) => BOARDS.find((b) => b.tab === tab && b.sub === sub) ?? null;
export const isShared = (b) => b?.backend === "runs2";

// Leaderboard trophies (top three): 8 × 8 pixel cups drawn in 2-px blocks (16 px).
const CUP = Object.freeze(["########", "#.####.#", "#.####.#", ".######.", "..####..", "...##...", "..####..", ".######."]);
export const TROPHIES = Object.freeze([
  Object.freeze({ tone: "gold", place: "1st", color: "#d4bc78", rows: CUP }),
  Object.freeze({ tone: "silver", place: "2nd", color: "#b9b7a7", rows: CUP }),
  Object.freeze({ tone: "bronze", place: "3rd", color: "#b0764a", rows: CUP }),
]);

// routeBoards(run, { local }) -> the board ids a finished run reaches (F15 routing):
// demo and tutorial none; practice none, or with &board=local the board it would have reached;
// an assisted run only `assisted-{mode}`; ORIGINAL `{mode}`; KEEPERS `rift-{mode}`, never the
// worker.
export function routeBoards(run, { local = false } = {}) {
  if (!run || run.demo || run.kind === "tutorial" || run.tutorial) return [];
  if (run.practice && !local) return [];
  const mode = run.death ? "death" : "normal";
  if (run.flags?.assisted) return [`assisted-${mode}`];
  return [run.original ? mode : `rift-${mode}`];
}

// Board order: rank desc, then the board's tiebreak fields.
export function compareRows(b) {
  const keys = [[b.rank, -1], ...b.order];
  return (x, y) => {
    for (const [field, dir] of keys) {
      const d = (Number(x?.[field]) || 0) - (Number(y?.[field]) || 0);
      if (d) return dir * d;
    }
    return 0;
  };
}

export const sortRows = (b, rows) => [...rows].sort(compareRows(b));

// A board's local rows with `row` added (replacing a row of the same id), sorted and pruned to
// LOCAL_DEPTH.
export function insertRow(b, rows, row) {
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id !== row.id);
  return sortRows(b, [row, ...kept]).slice(0, LOCAL_DEPTH);
}

const int = (v, min = 0) => Math.max(min, Math.floor(Number(v) || 0));
const known = (table, list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && Object.hasOwn(table, id)))];
const text = (v, limit) => String(v ?? "").trim().slice(0, limit);
const OUTCOMES = Object.freeze(["victory", "defeat", "ended"]);
const SEED_CODE = /^RIFT-\d{4}-[0-9A-F]{4}$/;
const VERSION = /^[a-z0-9-]{1,32}$/;
const TITLE = /^[A-Z ]{1,16}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

// "skewer:3,baited:1" from a { featId: count } map (FEATS order) or an existing feat string.
export function featString(feats) {
  const counts = typeof feats === "string" ? Object.fromEntries(feats.split(",").map((pair) => pair.split(":"))) : (feats ?? {});
  return Object.keys(FEATS)
    .filter((id) => int(counts[id]) > 0)
    .map((id) => `${id}:${int(counts[id])}`)
    .join(",");
}

// The immutable v2 payload of one board record (F15): `id` names the board record, `run_id`
// the run. Unknown omen, relic and keeper ids are dropped; `speed` exists on assisted boards
// only. Returns null without a valid id pair.
export function boardPayload(b, r, id) {
  if (!b || !r || !ID.test(String(id)) || !ID.test(String(r.run_id ?? r.id))) return null;
  const payload = {
    id,
    board: b.id,
    run_id: String(r.run_id ?? r.id),
    name: text(r.name, 16) || "Player",
    title: TITLE.test(String(r.title ?? "")) ? r.title : "",
    ruleset: r.ruleset === "original" ? "original" : "keepers",
    score: int(r.score),
    rift_score: int(r.rift_score),
    kills: int(r.kills),
    wave: int(r.wave, 1),
    seconds: int(r.seconds),
    stage: int(r.stage, 1),
    played_at: Number.isFinite(r.played_at) ? r.played_at : Date.now(),
    death_mode: r.death_mode === true,
    statue_count: int(r.statue_count),
    statue_modifier: int(r.statue_modifier) || 100,
    omens: known(OMENS, r.omens),
    relics: known(RELICS, r.relics),
    keepers: known(KEEPERS, r.keepers),
    chain_best: int(r.chain_best),
    feats: featString(r.feats),
    seed_code: SEED_CODE.test(String(r.seed_code ?? "")) ? r.seed_code : "",
    outcome: OUTCOMES.includes(r.outcome) ? r.outcome : "ended",
    gameplay_version: VERSION.test(String(r.gameplay_version ?? "")) ? r.gameplay_version : "",
    schema: 2,
  };
  if (b.tab === "ASSISTED") payload.speed = Math.min(100, int(r.speed) || 100);
  return payload;
}

// A stored or fetched v2 row worth showing.
export const validRow = (r) => !!r && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string" && Number.isFinite(r.score);
