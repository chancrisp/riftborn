// Score submission and leaderboard reads (IMPROVEMENTS F15). A finished run reaches the boards
// route(run) names:
// - ORIGINAL boards ("normal", "death"): payload v1, the original field set. Uploaded to the
//   score Worker through a durable outbox with backoff, or inside a claude.ai artifact to the
//   shared "scores" collection. Every run is also kept in this device's personal table.
// - RIFT and ASSISTED boards: payload v2, one immutable record per board. Always kept in the
//   local board store (KEYS.boards); inside an artifact also uploaded to the "runs2" collection
//   through the same outbox. They never reach the Worker.
// The artifact database connects whenever window.claude.use exists; the Worker is used only
// when a Worker base is configured outside an artifact (its CSP blocks the Worker). Demo,
// tutorial, practice and developer runs are never submitted (practice &board=local keeps a
// local copy in memory).
import { KEYS, loadJSON, saveJSON, storageAvailable } from "../core/storage.js";
import { mulberry32, seedCode } from "../core/rng.js";
import { GAMEPLAY_VERSIONS, sameRuleset, versionOf } from "../data/stages.js";
import { OMENS } from "../data/omens.js";
import { RELICS } from "../data/relics.js";
import { KEEPER_ORDER } from "../data/keepers.js";
import { BOARDS, LOCAL_DEPTH, boardOf, boardPayload, insertRow, isShared, routeBoards, sortRows, validRow } from "./boards.js";
import { plausible } from "./logic/plausible.js";

const LOCAL_KEEP = 20; // personal ORIGINAL results kept per mode
// The artifact boards keep only what could rank, far under the store's 5,000-doc cap.
const SHARED_DEPTH = 50;
const POST_TIMEOUT_MS = 8000;
const READ_TIMEOUT_MS = 10000;
const BOARD_READ_MS = 8000; // RIFT / ASSISTED reads (F15)
const SHARED_WAIT_MS = 12000; // claude.use() itself resolves null after 10 s without a host
const SHARED_RETRY_MS = 600;
const LEASE_MS = 30000;
const SENDS_PER_FLUSH = 8;
const RETRY_EVERY_MS = 15000;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 300000;
const OUTCOMES = Object.freeze(["victory", "defeat", "ended"]);
const RUNS2 = "runs2";
const SYNTHETIC_ROWS = 30;
const SYNTHETIC_NAMES = Object.freeze(["ASH", "VESPER", "MORROW", "KESTREL", "NOX", "HALLOW", "WREN", "CINDER", "TALLOW", "RUNE", "SABLE", "ORRIN"]);

const TEXT = Object.freeze({
  top: (limit, mode) => `TOP ${limit} ${mode.toUpperCase()} · ALL VERSIONS · PLAYER-REPORTED`,
  empty: (mode) => `No ${mode} scores yet.`,
  noModes: "Mode rankings unavailable on this server. Personal results below.",
  unavailable: "Remote leaderboard unavailable. Personal results below; Refresh to retry.",
  noRemote: "Remote leaderboard unavailable. Personal results below.",
  deviceOnly: "This device only",
  sharedDown: "Shared board unavailable · this device only",
  synthetic: "Practice · synthetic rows",
  saved: "Score saved.",
  savedHere: "Score saved on this device.",
  sessionOnly: "Storage unavailable · score lasts this session.",
});

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const modeKey = (mode) => (mode === "death" ? "death" : "normal");
const clone = (v) => JSON.parse(JSON.stringify(v));
const wait = (ms, value) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer?.unref?.();
  });
const validRowV1 = (r) =>
  !!r && typeof r.id === "string" && r.payload?.id === r.id && typeof r.payload.name === "string" && Number.isFinite(r.payload.score);
// Score desc, then wave desc, then seconds desc.
const ranked = (rows) => [...rows].sort((a, b) => b.score - a.score || b.wave - a.wave || b.seconds - a.seconds);
// Personal ORIGINAL results never include a KEEPERS or assisted record of the Journal history.
const originalRecord = (r) => (!r.board || r.board === "normal" || r.board === "death") && r.ruleset !== "keepers";

function timeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms)?.unref?.();
  return controller.signal;
}

// Rejects after `ms` (the pending work is abandoned, never awaited again).
function within(ms, promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      timer?.unref?.();
    }),
  ]);
}

function uuid() {
  const api = globalThis.crypto;
  if (typeof api?.randomUUID === "function") return api.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof api?.getRandomValues === "function") api.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The immutable v1 submission payload: exactly the original API's fields.
function payloadOf(r) {
  if (!isObject(r) || !validId(r.id)) return null;
  const int = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return {
    id: r.id,
    name: String(r.name ?? "").trim().slice(0, 16) || "Player",
    score: int(r.score),
    kills: int(r.kills),
    wave: Math.max(1, int(r.wave)),
    seconds: int(r.seconds),
    stage: Math.max(1, int(r.stage)),
    played_at: Number.isFinite(r.played_at) ? r.played_at : Date.now(),
    death_mode: r.death_mode === true,
    statue_count: int(r.statue_count),
    statue_modifier: int(r.statue_modifier) || 100,
    outcome: OUTCOMES.includes(r.outcome) ? r.outcome : "ended",
    gameplay_version: typeof r.gameplay_version === "string" && r.gameplay_version ? r.gameplay_version : GAMEPLAY_VERSIONS.original,
  };
}

// Shared-collection document: the payload minus its id (the id names the document).
function sharedDoc(p) {
  return {
    name: p.name,
    score: p.score,
    stage: p.stage,
    kills: p.kills,
    wave: p.wave,
    seconds: p.seconds,
    death_mode: p.death_mode,
    statue_count: p.statue_count,
    statue_modifier: p.statue_modifier,
    outcome: p.outcome,
    gameplay_version: p.gameplay_version,
    played_at: p.played_at,
  };
}

function originalBoard(mode, rows) {
  const limit = boardOf(mode).limit;
  const visible = rows.filter((s) => isObject(s) && s.death_mode === (mode === "death")).slice(0, limit);
  return { rows: visible, status: visible.length ? TEXT.top(limit, mode) : TEXT.empty(mode), remote: true };
}

// The board a record belongs to when it is not the current run's: its own `board`, an assisted
// flag, else its ruleset (a KEEPERS record never falls back to the Worker's boards).
function recordBoards(record) {
  if (!isObject(record)) return [];
  if (boardOf(record.board)) return [record.board];
  const mode = record.death_mode === true ? "death" : "normal";
  if (record.assisted === true) return [`assisted-${mode}`];
  const keepers = record.ruleset === "keepers" || (record.ruleset !== "original" && sameRuleset(record.gameplay_version, GAMEPLAY_VERSIONS.keepers));
  return [keepers ? `rift-${mode}` : mode];
}

export function createScores(ctx) {
  const base = String(window.RIFTBORN_SCORE_API_BASE || "")
    .trim()
    .replace(/\/+$/, "");
  // Hosting matrix (F15): the artifact database whenever window.claude.use exists; the Worker
  // only outside an artifact.
  const artifactHost = typeof window.claude?.use === "function";
  const useWorker = !!base && !artifactHost;
  const devMode = !!ctx.env?.debug?.practice || !!window.__RIFTBORN_TEST__;
  const owner = globalThis.crypto?.randomUUID?.() || String(Math.random());

  let shared = null; // the artifact's db namespace once granted
  const sharedReady = artifactHost ? connectShared() : null;

  // Durable outbox. Rows: { id, payload, target: "worker" | "artifact", attempts, nextAt,
  // status, leaseUntil, leaseOwner, error }. Storage failures fall back to this page's memory.
  let memoryQueue = [];
  let storageFailed = false;
  let uploaded = 0; // this page's confirmed uploads
  let syncing = null,
    again = false,
    retryAgain = false,
    forceStatus = false;

  const sessionRuns = { normal: [], death: [] }; // this page's ORIGINAL runs, in case storage fails
  const sessionBoards = {}; // this page's RIFT / ASSISTED rows (the only copy in developer mode)
  const syntheticBoards = {}; // practice `leaderboard`: stand-ins for the shared boards
  let status = "";
  let shown = null; // last text this module wrote to #scoreSave

  async function connectShared() {
    try {
      shared = (await Promise.race([window.claude.use("db"), wait(SHARED_WAIT_MS, null)])) || null;
    } catch {
      shared = null;
    }
    return shared;
  }

  // Only the status this module computes is written, and only when it changes (or for a
  // fresh submission), so the periodic retry never wipes another run's save notice.
  function setStatus(text, pendingRows, force = false) {
    status = text;
    if (force || text !== shown) {
      const line = document.querySelector("#scoreSave");
      if (line) line.textContent = text;
      shown = text;
    }
    document.querySelector("#retryScore")?.classList.toggle("hidden", !pendingRows);
  }

  // A practice run finished with &board=local: its board copy and Journal record stay in
  // memory, so the YOU highlight can be checked.
  function localPractice(runId) {
    const run = ctx.run;
    return !!run?.practice && !!runId && run.id === runId && ctx.practice?.params?.board === "local";
  }

  // Only real runs carry an id; runs shorter than 1 s are never recorded.
  function eligible(payload) {
    const run = ctx.run;
    const sameRun = run && run.id === payload.id;
    if (devMode || payload.seconds < 1) return false;
    return !(sameRun && (run.kind !== "real" || run.demo || run.practice || run.tutorial));
  }

  // ---- this device: ORIGINAL personal results ----
  // KEYS.scores = { normal: [...], death: [...] }, best LOCAL_KEEP runs per mode.
  function storedScores() {
    const all = devMode ? null : loadJSON(KEYS.scores, null);
    const rows = (mode) => (isObject(all) && Array.isArray(all[mode]) ? all[mode] : []);
    return { normal: rows("normal"), death: rows("death") };
  }

  function keepLocal(payload, memoryOnly) {
    const mode = payload.death_mode ? "death" : "normal";
    const add = (rows) => ranked([payload, ...rows.filter((r) => r?.id !== payload.id)]).slice(0, LOCAL_KEEP);
    sessionRuns[mode] = add(sessionRuns[mode]);
    if (memoryOnly) return true;
    const boards = storedScores();
    boards[mode] = add(boards[mode]);
    return saveJSON(KEYS.scores, boards);
  }

  // ---- this device: RIFT / ASSISTED boards ----
  // KEYS.boards = { boardId: rows }, each the top LOCAL_DEPTH rows.
  function storedBoards() {
    const all = devMode ? null : loadJSON(KEYS.boards, null);
    return isObject(all) ? all : {};
  }

  function localRows(b) {
    const byId = new Map();
    const stored = storedBoards()[b.id];
    for (const r of [...(sessionBoards[b.id] ?? []), ...(Array.isArray(stored) ? stored : [])]) if (validRow(r) && !byId.has(r.id)) byId.set(r.id, r);
    return sortRows(b, [...byId.values()]).slice(0, LOCAL_DEPTH);
  }

  function keepBoardRow(b, row, memoryOnly) {
    sessionBoards[b.id] = insertRow(b, sessionBoards[b.id], row);
    if (memoryOnly || devMode) return true;
    const all = storedBoards();
    all[b.id] = insertRow(b, (Array.isArray(all[b.id]) ? all[b.id] : []).filter(validRow), row);
    return saveJSON(KEYS.boards, all);
  }

  // One board record per (board, run): a repeated submission reuses the stored id, else the
  // record's own (a director-built v2 record carries one), else a new one.
  const boardRecordId = (b, runId, own) => localRows(b).find((r) => r.run_id === runId)?.id ?? (validId(own) ? own : uuid());

  // Personal results: ORIGINAL boards read this device's kept runs plus the Journal's run
  // history; RIFT and ASSISTED boards read the local board store.
  function personal(boardId, limit) {
    const b = boardOf(boardId) ?? boardOf(modeKey(boardId));
    if (isShared(b)) return localRows(b).slice(0, limit ?? b.limit);
    const key = b.id,
      death = key === "death",
      byId = new Map();
    for (const r of [...storedScores()[key], ...sessionRuns[key], ...(ctx.profile?.data?.runs ?? [])])
      if (isObject(r) && r.death_mode === death && typeof r.id === "string" && Number.isFinite(r.score) && originalRecord(r) && !byId.has(r.id))
        byId.set(r.id, r);
    return ranked([...byId.values()]).slice(0, limit ?? b.limit);
  }

  // ---- outbox ----
  function readQueue() {
    if (!storageAvailable()) throw new Error("Score storage unavailable");
    const rows = loadJSON(KEYS.outbox, []);
    return Array.isArray(rows) ? rows.filter(isObject) : [];
  }

  // Read-modify-write in one synchronous block, so tabs never interleave inside it.
  function changeQueue(fn) {
    const rows = readQueue();
    const result = fn(rows);
    if (!saveJSON(KEYS.outbox, rows)) throw new Error("Score storage failed");
    return result;
  }

  function queued() {
    let rows = [];
    try {
      rows = readQueue();
    } catch {
      storageFailed = true;
    }
    return [...rows, ...memoryQueue.filter((m) => !rows.some((r) => r.id === m.id))];
  }

  function enqueue(payload, target) {
    const row = { id: payload.id, payload: clone(payload), target, attempts: 0, nextAt: 0, status: "pending", leaseUntil: 0 };
    try {
      changeQueue((rows) => {
        if (!rows.some((r) => r.id === row.id)) rows.push(row);
      });
    } catch {
      if (!memoryQueue.some((r) => r.id === row.id)) memoryQueue.push(row);
      storageFailed = true;
    }
  }

  // Rows from before targets existed are Worker rows. A row waits while its backend is absent
  // on this host.
  const targetOf = (r) => (r.target === "artifact" ? "artifact" : "worker");
  const reachable = (r) => (targetOf(r) === "artifact" ? artifactHost : useWorker);

  // Manual retry: failed rows too, but never one another tab is sending right now.
  function resetForRetry() {
    const now = Date.now();
    const reset = (rows) => {
      for (const r of rows)
        if (validRowV1(r) && !(r.leaseUntil > now)) {
          r.status = "pending";
          r.nextAt = 0;
        }
    };
    reset(memoryQueue);
    try {
      changeQueue(reset);
    } catch {
      storageFailed = true;
    }
  }

  // Leases the first sendable row for 30 s so other tabs skip it.
  function claim(rows) {
    const now = Date.now();
    for (const r of rows) {
      if (!validRowV1(r)) {
        r.status = "failed";
        r.error = "Unreadable saved run";
        continue;
      }
      if (!Number.isFinite(r.nextAt)) r.nextAt = 0;
      if (!Number.isFinite(r.leaseUntil)) r.leaseUntil = 0;
    }
    const row = rows.find((r) => validRowV1(r) && reachable(r) && r.status !== "failed" && !(r.nextAt > now) && !(r.leaseUntil > now));
    if (!row) return null;
    row.leaseOwner = owner;
    row.leaseUntil = now + LEASE_MS;
    row.attempts = Math.min(1e6, (Number.isSafeInteger(row.attempts) && row.attempts >= 0 ? row.attempts : 0) + 1);
    return clone(row);
  }

  // Applies a send result if this page still holds the lease. True = uploaded. A board that
  // refused the row for good (`drop`, a read-only artifact viewer) leaves the local copy as
  // the record.
  function settle(rows, id, result) {
    const index = rows.findIndex((r) => r.id === id && r.leaseOwner === owner);
    if (index < 0) return false;
    const { response, offline } = result;
    if (response?.ok || response?.drop) {
      rows.splice(index, 1);
      return !!response.ok;
    }
    const r = rows[index];
    const code = response?.status || 0;
    r.leaseUntil = 0;
    r.leaseOwner = null;
    // 4xx (except timeout/rate limit) means the server rejected the run: no auto-retry.
    r.status = code >= 400 && code < 500 && code !== 408 && code !== 429 ? "failed" : "pending";
    r.nextAt = Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, r.attempts - 1));
    r.error = offline ? "Connection unavailable" : `Server response ${code}`;
    return false;
  }

  async function postWorker(payload) {
    try {
      const response = await fetch(`${base}/api/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: timeoutSignal(POST_TIMEOUT_MS),
      });
      return { response, offline: false };
    } catch {
      return { response: null, offline: true };
    }
  }

  // runs2 write: doc id = record id. The store's transient "unavailable" is retried with
  // backoff; any other rejection is final.
  async function putShared(payload) {
    const store = await sharedReady;
    if (!store) return { response: null, offline: true };
    try {
      await sharedCall(() => store.collection(RUNS2).doc(payload.id).set(clone(payload)));
      return { response: { ok: true }, offline: false };
    } catch (err) {
      return err?.code === "unavailable" ? { response: null, offline: true } : { response: { drop: true }, offline: false };
    }
  }

  const deliver = (row) => (targetOf(row) === "artifact" ? putShared(clone(row.payload)) : postWorker(clone(row.payload)));

  async function flush() {
    let inaccessible = false;
    if (memoryQueue.length) {
      const moving = [...memoryQueue];
      try {
        changeQueue((rows) => {
          for (const r of moving) if (!rows.some((x) => x.id === r.id)) rows.push(clone(r));
        });
        memoryQueue = memoryQueue.filter((r) => !moving.includes(r));
      } catch {
        inaccessible = true;
      }
    }
    for (let i = 0; i < SENDS_PER_FLUSH; i++) {
      let row = null,
        inMemory = false;
      try {
        row = changeQueue(claim);
      } catch {
        inaccessible = true;
      }
      // Readable but full storage must not strand the memory queue.
      if (!row) {
        row = claim(memoryQueue);
        inMemory = !!row;
      }
      if (!row) break;
      const result = await deliver(row);
      const apply = (rows) => settle(rows, row.id, result);
      if (inMemory) {
        if (apply(memoryQueue)) uploaded++;
      } else {
        // If this acknowledgement cannot be written the lease simply expires and the
        // run is re-sent; both backends treat the repeated id as the same record.
        try {
          if (changeQueue(apply)) uploaded++;
        } catch {
          inaccessible = true;
        }
      }
    }
    storageFailed = inaccessible || memoryQueue.length > 0;
  }

  function queueStatus(rows) {
    const n = rows.length;
    if (n) {
      const failed = rows.some((r) => r.status === "failed");
      const detail = failed
        ? n > 1 ? " score uploads failed. Retry saving." : " score upload failed. Retry saving."
        : n > 1 ? " scores pending. Retrying automatically." : " score pending. Retrying automatically.";
      return (storageFailed ? "Storage unavailable — keep this tab open. " : "") + n + detail;
    }
    if (uploaded) return TEXT.saved + (storageFailed ? " Local retry storage unavailable." : "");
    return storageFailed ? "Score storage unavailable. Keep this tab open." : "";
  }

  // Single flight: a call made while a sync runs is queued behind it, never dropped.
  function sync(manual = false) {
    retryAgain ||= manual;
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          again = false;
          if (retryAgain) resetForRetry();
          retryAgain = false;
          await flush();
          const rows = queued().filter(reachable);
          setStatus(queueStatus(rows), rows.length, forceStatus);
          forceStatus = false;
        } while (again);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  // ---- artifact collections ----
  // The store's transient "unavailable" deserves exactly one retry after a short random
  // delay; every other rejection (read-only viewer, quota, bad query) is final.
  async function sharedCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== "unavailable") throw err;
      await wait(SHARED_RETRY_MS * (1 + Math.random()));
      return fn();
    }
  }

  async function topShared(store, death) {
    const query = store.collection("scores").where("death_mode", "==", death).orderBy("score", "desc").limit(SHARED_DEPTH);
    const snap = await sharedCall(() => query.get());
    return snap.docs.map((d) => d.data()).filter(isObject);
  }

  // True when the run is on the shared ORIGINAL board. A rejected write (read-only viewer,
  // quota, transient) leaves the device copy as the record.
  async function submitShared(payload) {
    const store = await sharedReady;
    if (!store) return false;
    try {
      const top = await topShared(store, payload.death_mode);
      if (top.some((s) => s.played_at === payload.played_at && s.name === payload.name && s.score === payload.score)) return true;
      if (top.length >= SHARED_DEPTH && !(payload.score > top[top.length - 1].score)) return false;
      // Named by the run id (a valid document id) so a repeated submission rewrites the
      // same document instead of adding a duplicate, as add() would.
      const doc = store.collection("scores").doc(payload.id);
      await sharedCall(() => doc.set(sharedDoc(payload)));
      return true;
    } catch {
      return false;
    }
  }

  async function readRuns2(b) {
    const store = await within(BOARD_READ_MS, sharedReady);
    if (!store) throw new Error("No shared board");
    const query = store.collection(RUNS2).where("board", "==", b.id).orderBy(b.rank, "desc").limit(LOCAL_DEPTH);
    const snap = await within(BOARD_READ_MS, sharedCall(() => query.get()));
    return snap.docs.map((d) => d.data()).filter(validRow);
  }

  // ---- submission ----

  // What the Journal keeps of a finished run (its comparisons and YOU highlights).
  function remember(record, extra) {
    ctx.profile?.rememberRun?.({ ...record, ...extra });
  }

  // ORIGINAL boards: payload v1, as Wave 1 (Worker outbox, or the shared "scores" collection).
  async function submitOriginal(record) {
    const payload = payloadOf(record);
    if (!payload) return { ok: false, pending: pendingCount() };
    const local = localPractice(payload.id);
    if (!local && !eligible(payload)) return { ok: false, pending: pendingCount() };
    remember(payload, { board: payload.death_mode ? "death" : "normal", ruleset: "original" });
    const kept = keepLocal(payload, local);
    if (local) return { ok: kept, pending: 0 };
    if (useWorker) {
      enqueue(payload, "worker"); // durable before any network work
      forceStatus = true;
      await sync();
      const rows = queued();
      return { ok: !rows.some((r) => r.id === payload.id), pending: rows.length };
    }
    setStatus(kept ? TEXT.savedHere : TEXT.sessionOnly, 0, true);
    if (await submitShared(payload)) {
      setStatus(TEXT.saved, 0, true);
      return { ok: true, pending: 0 };
    }
    return { ok: kept, pending: 0 };
  }

  // The v2 fields a record lacks, read from the run it belongs to.
  function runFields(run) {
    if (!run) return {};
    return {
      ruleset: run.ruleset,
      rift_score: run.rift?.score ?? 0,
      chain_best: run.rift?.chain?.best ?? 0,
      feats: run.rift?.feats ?? {},
      omens: [...(ctx.omens?.active?.() ?? [])],
      relics: (ctx.relics?.owned?.() ?? []).map((r) => r.id),
      keepers: [...(run.flags?.keepersBroken ?? [])],
      seed_code: seedCode(run.seed),
      speed: run.flags?.assistSpeed ?? 100,
      assisted: !!run.flags?.assisted,
      gameplay_version: versionOf(run),
      title: ctx.profile?.cosmetics?.title ?? "",
    };
  }

  // RIFT and ASSISTED boards: payload v2, kept locally; inside an artifact also queued for
  // runs2 unless the plausibility guard fails (then it stays here, flagged unverified). The
  // record is a run record (id = the run) or a v2 board record (run_id = the run).
  async function submitBoard(b, record) {
    const runId = record?.run_id ?? record?.id;
    if (!validId(runId)) return { ok: false, pending: pendingCount(), board: b.id };
    const run = ctx.run?.id === runId ? ctx.run : null;
    const filled = { ...runFields(run), ...record, run_id: runId };
    const local = localPractice(runId);
    const payload = boardPayload(b, filled, boardRecordId(b, runId, record.run_id ? record.id : null));
    if (!payload || (!local && !eligible({ ...payload, id: payload.run_id }))) return { ok: false, pending: pendingCount(), board: b.id };
    remember(payload, { id: payload.run_id });
    const verified = plausible(payload);
    const kept = keepBoardRow(b, verified ? payload : { ...payload, unverified: true }, local);
    if (!local && verified && artifactHost) {
      enqueue(payload, "artifact");
      forceStatus = true;
      await sync();
    } else if (!local) setStatus(kept ? TEXT.savedHere : TEXT.sessionOnly, 0, true);
    const rows = queued();
    return { ok: kept, pending: rows.length, board: b.id, ...(await rankOf(b, payload.id)) };
  }

  // { rank, of } of a record on its board, read once after the submission.
  async function rankOf(b, id) {
    const { rows } = await list(b.id);
    const index = rows.findIndex((r) => r.id === id);
    return index < 0 ? { rank: null, of: rows.length } : { rank: index + 1, of: rows.length };
  }

  // submit(record, boardId?) -> Promise<{ ok, pending, board?, rank?, of? }>. The board is the
  // argument, else the record's own `board` (v2 records), else every board of route(ctx.run)
  // for the current run's record, else the board the record's ruleset names.
  async function submit(record, boardId) {
    const current = !boardOf(record?.board) && !!record?.id && ctx.run?.id === record.id;
    const ids = boardId ? [boardId] : current ? route(ctx.run) : recordBoards(record);
    let result = { ok: false, pending: pendingCount() };
    for (const id of ids) {
      const b = boardOf(id);
      if (b) result = isShared(b) ? await submitBoard(b, record) : await submitOriginal(record);
    }
    return result;
  }

  // ---- reads ----

  async function listWorker(mode) {
    const r = await fetch(`${base}/api/scores?mode=${mode}&version=all`, { cache: "no-store", signal: timeoutSignal(READ_TIMEOUT_MS) });
    if (!r.ok) throw new Error("Leaderboard unavailable");
    const data = await r.json();
    if (!Array.isArray(data?.scores)) throw new Error("Invalid scores");
    // Old servers cannot filter by mode: show no remote rows rather than mixed ones.
    if (data.capabilities?.modeFilter !== true) return { rows: [], status: TEXT.noModes, remote: false };
    return originalBoard(mode, data.scores);
  }

  async function listOriginal(mode) {
    if (syntheticBoards[mode]) return { rows: syntheticBoards[mode], status: TEXT.synthetic, remote: false };
    try {
      if (useWorker) return await listWorker(mode);
      const store = await sharedReady;
      if (!store) return { rows: [], status: TEXT.noRemote, remote: false };
      return originalBoard(mode, await topShared(store, mode === "death"));
    } catch {
      return { rows: [], status: TEXT.unavailable, remote: false };
    }
  }

  // RIFT / ASSISTED: runs2 merged with this device's rows (pending and unverified ones show
  // here only), or this device alone. `status` is the backend note ("" on a shared board).
  async function listBoard(b) {
    const local = localRows(b);
    const merge = (remote) => {
      const byId = new Map(remote.map((r) => [r.id, r]));
      for (const r of local) if (!byId.has(r.id)) byId.set(r.id, r);
      return sortRows(b, [...byId.values()]).slice(0, LOCAL_DEPTH);
    };
    if (syntheticBoards[b.id]) return { rows: merge(syntheticBoards[b.id]), status: TEXT.synthetic, remote: false };
    if (!artifactHost) return { rows: local, status: TEXT.deviceOnly, remote: false };
    try {
      return { rows: merge(await readRuns2(b)), status: "", remote: true };
    } catch {
      return { rows: local, status: TEXT.sharedDown, remote: false };
    }
  }

  // list(boardId) -> Promise<{ rows, status, remote }> (up to 50 rows, board order). The
  // Wave-1 mode names "normal" and "death" are the ORIGINAL board ids.
  function list(boardId) {
    const b = boardOf(boardId) ?? boardOf(modeKey(boardId));
    return isShared(b) ? listBoard(b) : listOriginal(b.id);
  }

  function pendingCount() {
    return useWorker || artifactHost ? queued().filter(reachable).length : 0;
  }

  function retry() {
    return (useWorker || artifactHost) && !devMode ? sync(true) : Promise.resolve();
  }

  // route(run) -> the board ids a finished run reaches (F15 routing).
  function route(run) {
    return routeBoards(run, { local: !!run?.practice && ctx.practice?.params?.board === "local" });
  }

  // ---- practice ----

  // `leaderboard`: 30 synthetic rows per board in memory (seeded, never stored), one of this
  // device's own runs ranked below the top 20 on each shared board (the YOUR BEST footer),
  // and the panel opened.
  function fillSynthetic(seed) {
    const rng = mulberry32(seed >>> 0);
    const omenIds = Object.keys(OMENS),
      relicIds = Object.keys(RELICS);
    const some = (ids, n) => ids.filter(() => rng() < n / ids.length);
    for (const b of BOARDS) {
      const rows = [];
      for (let i = 0; i < SYNTHETIC_ROWS; i++) {
        const stage = 1 + Math.floor(rng() * 5),
          kills = 40 + Math.floor(rng() * 240),
          score = kills * (120 + Math.floor(rng() * 180)),
          statues = Math.floor(rng() * 8);
        const row = {
          id: uuid(),
          run_id: uuid(),
          name: SYNTHETIC_NAMES[Math.floor(rng() * SYNTHETIC_NAMES.length)],
          title: rng() < 0.4 ? "WARDENBANE" : "",
          ruleset: b.tab === "ORIGINAL" || (b.tab === "ASSISTED" && rng() < 0.3) ? "original" : "keepers",
          score,
          rift_score: Math.floor(score * (1.1 + rng() * 0.6) * (1 + statues / 10)),
          kills,
          wave: 1 + Math.floor(rng() * 14),
          seconds: stage * 60 + Math.floor(rng() * 400),
          stage,
          played_at: Date.now() - Math.floor(rng() * 30) * 86400000,
          death_mode: b.sub === "DEATH",
          statue_count: statues,
          statue_modifier: 100 + statues * 5,
          omens: some(omenIds, 2),
          relics: some(relicIds, 3),
          keepers: KEEPER_ORDER.slice(0, Math.max(0, stage - 1)),
          chain_best: Math.floor(rng() * kills),
          outcome: stage === 5 && rng() < 0.5 ? "victory" : "defeat",
          speed: b.tab === "ASSISTED" ? [100, 90, 80, 70][Math.floor(rng() * 4)] : undefined,
        };
        row.gameplay_version = row.ruleset === "original" ? GAMEPLAY_VERSIONS.original : GAMEPLAY_VERSIONS.keepers;
        rows.push(b.tab === "ORIGINAL" ? row : boardPayload(b, row, row.id));
      }
      syntheticBoards[b.id] = sortRows(b, rows);
      if (isShared(b)) {
        const last = syntheticBoards[b.id][SYNTHETIC_ROWS - 4];
        const own = boardPayload(b, { ...last, run_id: uuid(), name: "Developer" }, uuid());
        sessionBoards[b.id] = insertRow(b, sessionBoards[b.id], own);
      }
    }
  }

  ctx.bus.on("practice", ({ register } = {}) =>
    register?.("leaderboard", (c) => {
      fillSynthetic(c.run?.seed ?? 0);
      ctx.menus?.openPanel?.("#leaderboard");
    }),
  );

  document.querySelector("#retryScore")?.addEventListener("click", () => retry());
  if ((useWorker || artifactHost) && !devMode) {
    window.addEventListener("online", () => sync());
    setInterval(() => document.hidden || sync(), RETRY_EVERY_MS)?.unref?.();
    sync(); // runs left over from an earlier visit
  }

  return {
    get backend() {
      return useWorker ? "worker" : shared ? "artifact" : "local";
    },
    get pending() {
      return pendingCount();
    },
    get status() {
      return status;
    },
    submit,
    list,
    personal,
    retry,
    route,
  };
}
