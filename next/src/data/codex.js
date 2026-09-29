// Codex of the Fracture (IMPROVEMENTS F19): the bestiary (every kind, creature and keeper, in
// Journal order), the RIFT-TOUCHED and HAZARDS entries, the death causes behind the run
// report's "Cause" and "Next attempt" lines, and the short tips of the NEW ENTRY toast.
// Records and lore only: nothing here is read by gameplay.
import { AFFIXES } from "./affixes.js";
import { PROP_KINDS, ZONE_KINDS } from "./hazards.js";

// { name, hint, lore, home }: `home` is the stage an unseen entry points to ("??? · STAGE"),
// or "DEATH" for the Death Mode kinds. Lore shows only after the first defeat.
const entry = (name, hint, lore, home) => Object.freeze({ name, hint, lore, home });

// Insertion order is Journal order: the original monsters, the Wave-2 creatures, the keepers.
export const BESTIARY = Object.freeze({
  runner: entry("Restless", "Chases directly. Keep moving and use open firing lanes.", "Pilgrims who walked toward the rift and never stopped walking. They remember the road, not why they took it.", 1),
  skitter: entry("Skitter", "Fast, weaving crawler. Standing-height bullets can hit it.", "Rift-spawn that learned to scuttle before it learned to see. It follows the warmth of anything alive.", 1),
  gunner: entry("Spitter", "Keeps its distance and fires a three-shot fan. Strafe across its aim.", "Its gut ferments rift-stone into bile and spits it in threes, the way it once counted coins.", 1),
  charger: entry("Charger", "Warns before a straight rush. Move sideways during the windup.", "A quarry ox the fracture reshaped into a battering ram. It still lowers its head before it runs.", 2),
  brute: entry("Brute", "Slow, tough, with a delayed close slam. Leave its marked circle.", "Grown from the slag heaps of the Caldera, it swings with the slow patience of a mountain.", 3),
  mortar: entry("Mortar", "Targets your predicted position. Change direction after the warning.", "It swallows embers and lobs them where you will be, not where you are. It is rarely wrong twice.", 3),
  sniper: entry("Sniper", "Telegraphs a long shot. Cross its line or break sight with cover.", "A lookout the rift left at its post. It still waits for the one clean shot.", 2),
  leaper: entry("Leaper", "Leaps after a windup and blasts its landing. Keep clear of the marker.", "It crouches in the ash for hours, then covers the length of a street in one bound.", 3),
  splitter: entry("Splitter", "Death releases two weakened crawlers. Save space for the children.", "Two things that were never meant to share one body. Death only gives them back their freedom.", 3),
  stormer: entry("Stormer", "Circles and fires eight radial shots. Use the gaps or solid cover.", "The aurora over the Citadel condensed into something that circles and sings in eight directions.", 4),
  revenant: entry("Revenant", "Death Mode: a brief warned rush. Sidestep, then fire during recovery.", "What the deeper rift returns is never quite what it took. It remembers how to rush, not how to stop.", "DEATH"),
  hexer: entry("Hexer", "Death Mode: five delayed cross blasts. Move beyond the cross.", "A mourner who learned the crossing sigil of the Crown. Every cross it draws is a grave already dug.", "DEATH"),
  broodmother: entry("Broodmother", "Death Mode: summons crawlers. Attack the mother to stop new summons.", "The most patient mother the rift ever made. Her children hatch hungry and already hunting.", "DEATH"),
  drowned: entry("Drowned", "Bursts when close or killed. Pop it at range, ideally inside a crowd.", "It waded into the stream to hide from the Crown's light. The stream kept it, and now it keeps the stream.", 1),
  ashworm: entry("Ashworm", "Burrows toward you and erupts where you are heading. Change direction, then punish it while it is surfaced.", "They swim through the cooling rock the way fish swim through water, and rise wherever the ground grows warm.", 3),
  lamplighter: entry("Lamplighter", "Cages nearby monsters in lantern light. Kill it first, or hit it hard mid-ritual to break the ward.", "The lamplighters still make their rounds of the sealed city, keeping every light and every defender burning.", 4),
  bellwether: entry("The Bellwether", "Wakes when you ring the shrine bell. Dash through its toll waves or hug stone. After the knell it rests the bell. Strike then.", "It led the Meadow folk toward the rift when the Crown fell. It never stopped ringing, and they never stopped following.", 1),
  ironmaw: entry("Iron Maw", "Quarry guardian. Bait a committed charge into solid cover or a quarry wall for 2s of vulnerability.", "The miners chained it to the tithe engine. When the brake locked around a worker's hammer, the chain broke instead.", 2),
  abbot: entry("The Cinder Abbot", "Front crust shrugs off shots. Circle behind it, where the ember core takes double damage, and stay off the cinders.", "The last keeper swallowed the first ember so no pilgrim could carry it out. It still keeps its vigil, burning from the inside.", 3),
  castellan: entry("The Castellan", "When it keeps VIGIL its dome returns every shot from every side: hold fire or flare a beacon. Read the aurora grid, and strike while its shield is down.", "It sealed the gates with the city still inside. It has held the wall so long it forgot which side the enemy was on.", 4),
  warden: entry("Rift Warden", "Alternates rings, blasts and falling shards. Break both nodes to expose it. At the end the rift raises a shade of every keeper you broke.", "It wore the Crown when the worlds broke. Now the Crown wears it.", 5),
});

// The keeper rows of the bestiary, shown in the Journal's KEEPERS section with their records.
export const KEEPER_ENTRIES = Object.freeze(["bellwether", "ironmaw", "abbot", "castellan", "warden"]);

const AFFIX_HINTS = Object.freeze({
  molten: "Bursts on death. Kill it away from you, or next to its friends.",
  warded: "Bone plates soak damage before its body, and regrow if you let it rest.",
  hasted: "Faster steps, shorter cooldowns. Its telegraphs are still honest.",
  shardborn: "Scatters eight shards on death. Stand in a gap or behind cover.",
  hexing: "Marks the ground under you every five seconds. Keep moving.",
  bound: "Two share one wound. When one falls, the other rages.",
});

// RIFT-TOUCHED section: { name, color, hint } per affix, in AFFIXES order.
export const AFFIX_CODEX = Object.freeze(
  Object.fromEntries(Object.entries(AFFIXES).map(([id, a]) => [id, Object.freeze({ name: a.name, color: a.color, hint: AFFIX_HINTS[id] })])),
);

// HAZARDS section: { name, stage, hint, toast } per hazard kind (F10), in stage order.
const hazard = (name, row, hint) => Object.freeze({ name, stage: row.stage, hint, toast: row.toast });
export const HAZARD_CODEX = Object.freeze({
  marsh: hazard("Marsh gas", PROP_KINDS.marsh, "Marsh pods burst when shot. Keep them between you and the horde, not under your feet."),
  charge: hazard("Blasting charge", PROP_KINDS.charge, "Charges chain. Shoot them early, from range."),
  lava: hazard("Lava", ZONE_KINDS.lava, "Molten pools burn on every step. Lure monsters in, stay out."),
  beacon: hazard("Live beacon", PROP_KINDS.beacon, "Shoot a tower rune to flare it. Everything within 14m is stunned, and a vigil breaks."),
  crystal: hazard("Falling crystal", PROP_KINDS.crystal, "A struck spire drops its crystal around its base."),
});

// The instruction half of a hazard's first-encounter toast ("MARSH GAS · SHOOT TO IGNITE").
const instruction = (toast) => toast.split(" · ").slice(1).join(" · ");

// NEW ENTRY toast tips (first sighting ever): NEW ENTRY · {NAME} · {SHORT}. Keys are unique
// across the bestiary, affix and hazard sections.
export const SHORT_TIPS = Object.freeze({
  runner: "KEEP MOVING",
  skitter: "FAST AND WEAVING",
  gunner: "STRAFE ACROSS ITS AIM",
  charger: "SIDESTEP THE RUSH",
  brute: "LEAVE ITS CIRCLE",
  mortar: "CHANGE DIRECTION",
  sniper: "BREAK ITS LINE",
  leaper: "CLEAR THE MARKER",
  splitter: "MIND THE CHILDREN",
  stormer: "USE THE GAPS",
  revenant: "SIDESTEP, THEN FIRE",
  hexer: "MOVE BEYOND THE CROSS",
  broodmother: "KILL THE MOTHER",
  drowned: "POP IT AT RANGE",
  ashworm: "CHANGE DIRECTION",
  lamplighter: "KILL IT FIRST",
  bellwether: "DASH THROUGH THE TOLL",
  ironmaw: "BAIT IT INTO COVER",
  abbot: "CIRCLE BEHIND IT",
  castellan: "HOLD FIRE IN VIGIL",
  warden: "BREAK BOTH NODES",
  ...Object.fromEntries(Object.keys(AFFIXES).map((id) => [id, "RIFT-TOUCHED"])),
  ...Object.fromEntries(Object.entries(HAZARD_CODEX).map(([kind, h]) => [kind, instruction(h.toast)])),
});

// ---- death causes ------------------------------------------------------------------------

const KEEPER_HINTS = Object.freeze({
  bellwether: "Dash toward the Bellwether through the toll wave, or hug stone.",
  ironmaw: "Bait the charge into cover, then step away from where the Maw struck. The rocks follow.",
  abbot: "Circle behind the Abbot and stay off the cinders.",
  castellan: "Hold fire while the dome is up. Read the grid and step into a struck square.",
});
const hintOf = (kind) => BESTIARY[kind].hint;

// [labels, hint]: every player-damage label the game can report. A label is the source's
// `label` (falling back to its `id`) and names exactly one row.
const group = (labels, hint) => Object.freeze({ labels: Object.freeze(labels), hint });
export const CAUSE_GROUPS = Object.freeze([
  group(["Bellwether", "Bellwether toll", "Bellwether crook"], KEEPER_HINTS.bellwether),
  group(["Iron Maw", "Iron Maw charge", "Maw rockfall"], KEEPER_HINTS.ironmaw),
  group(["Cinder Abbot", "Abbot slam", "Censer burst", "Fissure", "Cinders"], KEEPER_HINTS.abbot),
  group(["Castellan", "Castellan bash", "Aurora grid", "Aegis reflection"], KEEPER_HINTS.castellan),
  group(
    ["Rift Warden", "Warden ring", "Warden blast", "Warden node collapse", "Rift collapse", "Crown shard"],
    "Shards fall in a spiral outward from you. Cut across it, and break both nodes.",
  ),
  group(["Shade of the Bellwether"], KEEPER_HINTS.bellwether),
  group(["Shade of Iron Maw"], KEEPER_HINTS.ironmaw),
  group(["Shade of the Cinder Abbot"], KEEPER_HINTS.abbot),
  group(["Shade of the Castellan"], KEEPER_HINTS.castellan),
  group(["Drowned burst"], "Never let a Drowned reach you. It bursts at three metres."),
  group(["Ashworm breach", "Ashworm ember"], "The breach targets where you are going. Change direction."),
  group(["Lamplighter flare", "Lamp oil"], "Kill Lamplighters from range, and first."),
  group([AFFIXES.molten.death.source], AFFIX_HINTS.molten),
  group([AFFIXES.shardborn.death.source], AFFIX_HINTS.shardborn),
  group([AFFIXES.hexing.source], AFFIX_HINTS.hexing),
  group([PROP_KINDS.marsh.blast.source], HAZARD_CODEX.marsh.hint),
  group([PROP_KINDS.charge.blast.source], HAZARD_CODEX.charge.hint),
  group([ZONE_KINDS.lava.source], HAZARD_CODEX.lava.hint),
  group([PROP_KINDS.crystal.blast.source], HAZARD_CODEX.crystal.hint),
  group(["Restless claws"], hintOf("runner")),
  group(["Skitter bite"], hintOf("skitter")),
  group(["Spitter claws", "Spitter bile"], hintOf("gunner")),
  group(["Charger horns", "Charger rush"], hintOf("charger")),
  group(["Brute claws", "Brute slam"], hintOf("brute")),
  group(["Mortar claws", "Mortar shell"], hintOf("mortar")),
  group(["Sniper claws", "Sniper round"], hintOf("sniper")),
  group(["Leaper claws", "Leaper landing"], hintOf("leaper")),
  group(["Splitter claws"], hintOf("splitter")),
  group(["Stormer claws", "Stormer burst"], hintOf("stormer")),
  group(["Revenant claws", "Revenant rush"], hintOf("revenant")),
  group(["Hexer claws", "Hexer cross"], hintOf("hexer")),
  group(["Broodmother claws"], hintOf("broodmother")),
  group(["Trial vent"], "Vents flare after a warning glow. Fight the marked hunt away from the lit ground."),
  group(["Burning ground"], "Burning ground hurts on every step. Leave it at once."),
]);

export const DEATH_CAUSES = Object.freeze(
  Object.fromEntries(CAUSE_GROUPS.flatMap(({ labels, hint }) => labels.map((label) => [label, Object.freeze({ label, hint })]))),
);

export const UNKNOWN_CAUSE = Object.freeze({ label: "Unknown source", hint: "Use cover and save a dash for committed attacks." });

// Hazard ids of the original monsters' attacks (a bare-id source reads as its owner's hint).
const HAZARD_OWNERS = Object.freeze({ slam: "brute", mortar: "mortar", leap: "leaper", hex: "hexer" });

// { label, hint } for a player-damage source ({ id, label } or a bare id): the cause row of its
// label, then of its id, then the bestiary hint of the monster it names, else the unknown row.
export function causeOf(source) {
  const src = typeof source === "string" ? { id: source } : (source ?? {});
  const id = src.id == null ? "" : String(src.id);
  const label = src.label == null || src.label === "" ? id : String(src.label);
  const row = DEATH_CAUSES[label] ?? DEATH_CAUSES[id];
  if (row) return row;
  const kind = BESTIARY[id] ? id : HAZARD_OWNERS[id];
  const named = kind ? BESTIARY[kind] : Object.values(BESTIARY).find((b) => label && label.startsWith(b.name));
  if (named) return { label: label || named.name, hint: named.hint };
  return { label: label || UNKNOWN_CAUSE.label, hint: UNKNOWN_CAUSE.hint };
}
