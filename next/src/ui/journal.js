// Journal panel (#profile > #journalBody): milestones, appearance (badge, dash trail, title),
// mastery goals, discoveries and the Codex of the Fracture (IMPROVEMENTS F19): the bestiary
// with unseen rows and lore, and the KEEPERS, RIFT-TOUCHED, HAZARDS and RELICS sections. The
// markup is built once and refreshed in place, so focus, gamepad navigation and the <details>
// open state survive every re-render.
import { stageDef } from "../data/stages.js";
import { AFFIX_CODEX, HAZARD_CODEX, KEEPER_ENTRIES } from "../data/codex.js";
import { RELICS } from "../data/relics.js";
import { COSMETICS, LANDMARKS, MILESTONES } from "../meta/profile.js";
import { iconChip } from "./icons.js";

// [button id, slot, value, text] for the two fixed appearance rows.
const APPEARANCE_ROWS = Object.freeze([
  ["Badge", ["badgeNone", "badge", "none", "NONE"], ["badgeSkull", "badge", "skull", "SKULL"]],
  ["Dash trail", ["trailNormal", "trail", "normal", "NORMAL"], ["trailEmber", "trail", "ember", "EMBER"]],
]);
const FIXED = new Set(APPEARANCE_ROWS.flatMap(([, ...options]) => options.map(([, slot, value]) => `${slot}:${value}`)));
const EXTRA_COSMETICS = Object.freeze(COSMETICS.filter((c) => c.slot !== "title" && !FIXED.has(`${c.slot}:${c.value}`)));
const TITLES = Object.freeze(COSMETICS.filter((c) => c.slot === "title"));
const LOCKED_HINT = "Complete its Journal challenge to unlock.";
const RELIC_IDS = Object.freeze(Object.keys(RELICS));

const where = (home) => (home === "DEATH" ? "DEATH MODE" : stageDef(home).name);
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter(Boolean));
  return node;
}

// One codex row: a bold heading line, then plain lines (hint, lore).
const row = (heading, lines = [], chips = []) =>
  el("p", {}, [el("strong", {}, [...chips, document.createTextNode(heading)]), ...lines.filter(Boolean).map((text) => el("span", { textContent: text }))]);

function untouchedMark() {
  const img = el("img", { className: "death-run-mark", src: "assets/death-skull.png", width: 16, height: 16, alt: "Defeated untouched" });
  img.title = "Defeated untouched";
  return img;
}

export function createJournal(ctx) {
  const root = document.querySelector("#journalBody");
  let view = null;

  function button(id, text, onClick) {
    const b = el("button", { type: "button", id, textContent: text });
    b.addEventListener("click", onClick);
    return b;
  }

  function equip(slot, value) {
    ctx.profile?.cosmetics?.equip?.(slot, value);
    render();
  }

  function cosmeticButtons(list, idOf, textOf, cosmetics) {
    return list.map((c) => {
      const b = button(idOf(c), textOf(c), () => equip(c.slot, c.value));
      cosmetics.push({ button: b, slot: c.slot, value: c.value, label: c.label, extra: true });
      return b;
    });
  }

  function section(title, id, open = false) {
    const rows = el("div", { id });
    return { rows, node: el("details", { open }, [el("summary", { textContent: title }), rows]) };
  }

  function build() {
    const cosmetics = [];
    const rows = APPEARANCE_ROWS.map(([label, ...options]) =>
      el("div", { className: "cosmetic-row" }, [
        el("span", { textContent: label }),
        ...options.map(([id, slot, value, text]) => {
          const b = button(id, text, () => equip(slot, value));
          cosmetics.push({ button: b, slot, value, extra: false });
          return b;
        }),
      ]),
    );
    const extras = el(
      "div",
      { id: "extraCosmetics", className: "extra-cosmetics" },
      cosmeticButtons(EXTRA_COSMETICS, (c) => "cosmetic-" + c.value, (c) => c.label.toUpperCase(), cosmetics),
    );
    const titles = el("div", { id: "titleCosmetics", className: "extra-cosmetics" }, cosmeticButtons(TITLES, (c) => "title-" + c.value, (c) => c.text, cosmetics));
    const mastery = new Map();
    const masteryRows = el(
      "div",
      { id: "masteryRows" },
      (ctx.profile?.masteryEntries?.() ?? []).map((entry) => {
        const title = el("strong");
        const copy = el("p");
        const track = button("track-" + entry.id, "TRACK", () => {
          ctx.profile.trackMastery(ctx.profile.data.mastery.tracked === entry.id ? null : entry.id);
          render();
        });
        mastery.set(entry.id, { title, copy, track });
        return el("div", { className: "mastery-row" }, [title, copy, track]);
      }),
    );
    const discoveries = LANDMARKS.map(() => el("p"));
    // The codex sections sit inside #bestiaryRows so they share its row style.
    const monsters = el("div", { id: "monsterRows" });
    const keepers = section("KEEPERS", "keeperRows");
    const affixes = section("RIFT-TOUCHED", "affixRows");
    const hazards = section("HAZARDS", "hazardRows");
    const relics = section("RELICS", "relicRows");
    const v = {
      progress: el("p", { id: "profileProgress" }),
      cosmetics,
      mastery,
      discoveries,
      storage: el("p", { id: "profileStorage", className: "settings-hint" }),
      monsters,
      keepers: keepers.rows,
      affixes: affixes.rows,
      hazards: hazards.rows,
      relics: relics.rows,
    };
    root.replaceChildren(
      v.progress,
      el("h3", { textContent: "APPEARANCE" }),
      ...rows,
      extras,
      el("p", { className: "settings-hint", textContent: "Title · shown under your name on boards and results." }),
      titles,
      el("details", { open: true }, [el("summary", { textContent: "MASTERY & CHALLENGES" }), masteryRows]),
      el("details", {}, [el("summary", { textContent: "DISCOVERIES" }), el("div", { id: "discoveryRows" }, discoveries)]),
      v.storage,
      el("h3", { textContent: "BESTIARY" }),
      el("div", { id: "bestiaryRows" }, [monsters, keepers.node, affixes.node, hazards.node, relics.node]),
    );
    return v;
  }

  function renderProgress(data) {
    view.progress.textContent = MILESTONES.map((m) => (data.milestones.includes(m.key) ? "DONE · " : "LOCKED · ") + m.goal).join("\n");
  }

  function renderCosmetics(profile) {
    for (const c of view.cosmetics) {
      const available = profile.cosmetics.available(c.slot, c.value);
      c.button.disabled = !available;
      c.button.setAttribute("aria-pressed", String(profile.data.cosmetics[c.slot] === c.value));
      if (c.extra) c.button.title = available ? "Equip " + c.label : LOCKED_HINT;
    }
  }

  function renderMastery(profile) {
    for (const entry of profile.masteryEntries()) {
      const row = view.mastery.get(entry.id);
      if (!row) continue;
      row.title.textContent = entry.title + " · " + (entry.complete ? "COMPLETE" : entry.current + " / " + entry.target);
      row.copy.textContent = entry.description + " Reward: " + entry.rewards.map((r) => r.label).join(" + ") + ".";
      row.track.textContent = entry.tracked ? "UNTRACK" : "TRACK";
      row.track.setAttribute("aria-pressed", String(entry.tracked));
    }
  }

  function renderDiscoveries(data) {
    LANDMARKS.forEach((site, i) => {
      view.discoveries[i].textContent = data.mastery.discoveries.includes(site.id)
        ? site.name + " — " + site.text
        : "Undiscovered · " + stageDef(site.stage).name;
    });
  }

  // Developer scenarios and the test harness never persist the profile.
  function renderStorage(profile) {
    view.storage.textContent = !profile.persistent
      ? "Practice · progress is not saved."
      : profile.saved
        ? "Saved on this device."
        : "Storage unavailable · progress lasts this session.";
  }

  // Every entry shows: unseen ones as ??? with the world they belong to, lore after the first
  // defeat. Keepers add their records: defeats, the fastest fight, an untouched skull.
  function renderBestiary(profile) {
    const entries = profile.bestiary();
    const records = profile.data.keepers ?? {};
    const monsters = [],
      keepers = [];
    for (const b of Object.values(entries)) {
      const isKeeper = KEEPER_ENTRIES.includes(b.key);
      if (!b.seen) {
        (isKeeper ? keepers : monsters).push(row(`??? · ${where(b.home)}`));
        continue;
      }
      const lore = b.defeated > 0 ? b.lore : null;
      if (!isKeeper) {
        monsters.push(row(`${b.name} · ${b.defeated} defeated`, [b.hint, lore]));
        continue;
      }
      const record = records[b.key];
      const defeated = Math.max(record?.defeated ?? 0, b.defeated);
      const best = record?.bestSeconds ? ` · best ${clock(record.bestSeconds)}` : "";
      keepers.push(row(`${b.name} · defeated ${defeated}${best}`, [b.hint, lore], record?.untouched ? [untouchedMark()] : []));
    }
    view.monsters.replaceChildren(...monsters);
    view.keepers.replaceChildren(...keepers);
  }

  function renderCodex(profile) {
    const codex = profile.data.codex ?? { affixes: {}, hazards: [], relics: {} };
    view.affixes.replaceChildren(
      ...Object.entries(AFFIX_CODEX).map(([id, a]) => {
        const seen = codex.affixes[id];
        if (!seen?.seen) return row("??? · RIFT-TOUCHED");
        return row(`${a.name} · ${seen.defeated} defeated`, [a.hint], [iconChip(id, { color: a.color, label: a.name })]);
      }),
    );
    view.hazards.replaceChildren(
      ...Object.entries(HAZARD_CODEX).map(([kind, h]) =>
        codex.hazards.includes(kind) ? row(`${h.name} · ${stageDef(h.stage).name}`, [h.hint]) : row(`??? · ${stageDef(h.stage).name}`),
      ),
    );
    const taken = RELIC_IDS.filter((id) => codex.relics[id] > 0);
    view.relics.replaceChildren(
      row(`Relics ${taken.length} / ${RELIC_IDS.length}`),
      ...RELIC_IDS.map((id) =>
        codex.relics[id] > 0 ? row(`${RELICS[id].name} · taken ${codex.relics[id]}`, [RELICS[id].text], [iconChip(id, { label: RELICS[id].name })]) : row("???"),
      ),
    );
  }

  // Called by menus when #profile opens, after every Journal action, and when another
  // tab changes the profile while the panel is open.
  function render() {
    const profile = ctx.profile;
    if (!root || !profile?.data) return;
    view ||= build();
    renderProgress(profile.data);
    renderCosmetics(profile);
    renderMastery(profile);
    renderDiscoveries(profile.data);
    renderStorage(profile);
    renderBestiary(profile);
    renderCodex(profile);
  }

  return { render };
}
