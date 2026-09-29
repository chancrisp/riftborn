// One authored landmark per world. The world places and draws it, encounters grants the
// recovery, and the Journal shows the lore once it is discovered.
const define = (stage, id, name, text) => Object.freeze({ stage, id, name, text, heal: 12, rest: 4 });

export const LANDMARKS = Object.freeze([
  define(
    1,
    "meadow-shrine",
    "Shrine of the Last Rain",
    "The wardens left fresh water here for every traveler, even those fleeing the Crown. A little remains beneath the moss.",
  ),
  define(
    2,
    "quarry-engine",
    "The Silent Tithe Engine",
    "This counterweight lifted stone for the Citadel until the miners refused their final tithe. Its brake is still locked around a worker’s hammer.",
  ),
  define(
    3,
    "caldera-reliquary",
    "Reliquary of the First Ember",
    "The keepers sealed the first rift ember here, believing the mountain could swallow it. Pilgrims left cooling salts beside the seal.",
  ),
  define(
    4,
    "citadel-archive",
    "The Unburned Archive",
    "These stone leaves record the names the Crown ordered erased. The archivists carved them deep enough to outlast the fortress.",
  ),
  define(
    5,
    "void-memorial",
    "Memorial to the Unreturned",
    "Two broken crowns mark the last expedition that tried to close this rift. Between them, someone left a place for the next survivor.",
  ),
]);
export const LANDMARK_IDS = Object.freeze(LANDMARKS.map((l) => l.id));
