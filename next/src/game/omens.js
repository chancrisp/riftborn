// Skull Omens (ctx.omens, IMPROVEMENTS F12): under KEEPERS a challenge-only statue offers one
// named omen (a Rules Ledger source worth its Rift Score bonus) beside the bare curse. Each
// statue's omen is drawn once, at stage build, from stream("omens"); omens last the run, at most
// once each. Nothing here runs, or draws, under ORIGINAL, in the demo or in the tutorial.
import { OMENS, OMEN_TEXT, omenSource } from "../data/omens.js";
import { pick } from "../core/rng.js";

const GLASS_FLOOR = 50; // an omen never takes max integrity below this (F12, F9.1)
const NONE = Object.freeze([]);
const PRACTICE_STATUES = Object.freeze([
  [6, 5],
  [-6, 5],
  [0, -7],
]);

const eligible = (run) => !!run && !run.original && !run.demo && run.kind !== "tutorial";
const isWarden = (e) => e?.boss === "warden" || e?.kind === "warden";

export function createOmens(ctx) {
  const draws = new WeakMap(); // statue -> omen id | null

  const active = () => ctx.run?.omens ?? NONE;
  const isActive = (id) => active().includes(id);

  // Offer rules at this moment: Blood never doubles a chainBreakOnWard source (Black Candle),
  // Glass never takes max integrity below 50.
  function excluded(id) {
    const o = OMENS[id];
    if (o.effects.some((e) => e.key === "chainBreakOnWard") && ctx.rules?.flag?.("chainBreakOnWard")) return true;
    const loss = o.effects.find((e) => e.key === "maxHp")?.value ?? 0;
    const max = ctx.run?.player?.max;
    return loss < 0 && Number.isFinite(max) && max + loss < GLASS_FLOOR;
  }

  const offerable = (id) => !!OMENS[id] && !isActive(id) && !excluded(id);

  // Statues are inert while a keeper stands or the Warden lives (F1.3).
  function silent(run) {
    const boss = ctx.bosses?.current?.();
    return run.keeperState === "active" || !!boss?.keeper || isWarden(boss);
  }

  // One draw per statue from stream("omens"), never repeating an omen another statue of the
  // stage already holds.
  function drawFor(statue, stageDraws) {
    if (draws.has(statue)) return;
    const pool = Object.keys(OMENS).filter((id) => offerable(id) && !stageDraws.includes(id));
    const id = pool.length ? pick(ctx.run.stream("omens"), pool) : null;
    draws.set(statue, id);
    if (id) stageDraws.push(id);
  }

  const challengeStatues = () => (ctx.world?.statues?.list ?? []).filter((s) => !s.rewarded);

  function onStageBuilt() {
    const run = ctx.run;
    if (!eligible(run)) return;
    const stageDraws = [];
    for (const statue of challengeStatues()) drawFor(statue, stageDraws);
  }

  // The KEEPERS statue dialog (encounters.js shows it with menus.choice under OMEN_TEXT.title):
  //   [{ kind: "omen", omen, title, text, icon, tag, toast }?, { kind: "curse", ... }, { kind: "leave", ... }]
  // Accepting "omen" or "curse" runs the statue's curse; "omen" also calls activate(omen,
  // "statue"); `toast` is the line to show once it applied. Returns null while the skull is
  // silent (toast OMEN_TEXT.silent), and [] where no omen dialog applies (ORIGINAL, the trial
  // statue, a used statue).
  function dialogCards(statue) {
    const run = ctx.run;
    if (!eligible(run) || !statue) return [];
    if (silent(run)) return null;
    if (statue.used || statue.rewarded) return [];
    // A statue placed after the build (practice) draws on first use.
    drawFor(
      statue,
      challengeStatues()
        .map((s) => draws.get(s))
        .filter(Boolean),
    );
    const cards = [];
    const id = draws.get(statue);
    if (id && offerable(id)) {
      const o = OMENS[id];
      cards.push({ kind: "omen", omen: id, title: o.name, text: OMEN_TEXT.omenText(o), icon: id, tag: "OMEN", toast: OMEN_TEXT.omenToast(o) });
    }
    cards.push(
      { kind: "curse", title: OMEN_TEXT.bareTitle, text: OMEN_TEXT.bareText, toast: OMEN_TEXT.bareToast },
      { kind: "leave", title: OMEN_TEXT.leaveTitle, text: OMEN_TEXT.leaveText },
    );
    return cards;
  }

  // Pushes the ledger source "omen:{id}" (effects plus its scoreMult bonus) for the rest of the
  // run. False when it is unknown, already active or the ruleset has no omens.
  function activate(id, via = "statue") {
    const run = ctx.run;
    if (!eligible(run) || !OMENS[id] || isActive(id)) return false;
    run.omens = Object.freeze([...active(), id]);
    ctx.rules?.push?.(omenSource(id));
    ctx.player?.recomputeMax?.();
    ctx.bus.emit("omen", { id, via });
    return true;
  }

  // Practice: challenge statues around the spawn (&stage=N, default the Quarry).
  function registerScenarios({ register } = {}) {
    register?.(
      "omens",
      (c, params, h) => {
        for (const [x, z] of PRACTICE_STATUES) h.placeStatue(x, z, "curse");
      },
      { stage: 2 },
    );
  }

  ctx.bus.on("stageBuilt", onStageBuilt);
  ctx.bus.on("practice", registerScenarios);

  return {
    dialogCards,
    activate,
    // active() -> the active omen ids, in the order taken (a frozen list; do not mutate).
    active,
    // available() -> ids not yet taken this run.
    available: () => Object.keys(OMENS).filter((id) => !isActive(id)),
  };
}
