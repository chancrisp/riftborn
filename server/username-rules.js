// Riftborn account usernames (v2.2): the ONE rule set shared by the game (live checks while
// typing) and the Worker (the authority). The Worker keeps a byte-identical copy at
// site/server/username-rules.js; a test there compares the two when both are present.
// Plain data + pure functions only: no imports, no DOM, no Node APIs.
//
//   checkUsername(name) -> { ok: true, name } | { ok: false, reason, detail }
//     reason: "invalid" (detail "length" | "chars") or "reserved" (detail "reserved" | "profanity")
//   usernameKey(name)   -> the case-folded form used for uniqueness ("Rifter" == "rifter")

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

// Names nobody may take (compared case-insensitively, whole name).
export const RESERVED_USERNAMES = Object.freeze([
  "admin", "administrator", "anonymous", "dev", "developer", "guest", "mod", "moderator",
  "null", "official", "owner", "riftborn", "root", "staff", "support", "system", "undefined",
  "you", "warden", "the-warden", "rift-warden",
]);
// Prefixes reserved for names the game generates itself (anonymised rows after a deletion).
export const RESERVED_PREFIXES = Object.freeze(["exile-", "exile_", "riftborn-", "riftborn_"]);

// Deliberately small: blocks the obvious, avoids flagging innocent names (no short substrings
// like "ass" that hit "Cassie" or "bass"). Matched against the folded form (see fold()).
const BLOCKED_SUBSTRINGS = Object.freeze([
  "fuck", "shit", "cunt", "bitch", "whore", "slut", "nigg", "fagg", "retard", "hitler", "kike",
  "tranny", "wank", "porn", "pussy", "vagina",
]);
// Blocked only as the whole folded name: these also occur inside innocent names
// ("Dickens", "Hancock", "therapist", "torpedo", "spice"), so they are not substring-matched.
const BLOCKED_WHOLE = Object.freeze([
  "ass", "asshole", "chink", "cock", "cum", "dick", "dyke", "fag", "kkk", "nazi", "nazis",
  "pedo", "penis", "rape", "rapist", "sex", "spic", "twat",
]);

const LEET = Object.freeze({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", $: "s", "@": "a" });

// Lowercase, leetspeak folded, separators dropped: "F_u-C|<" and "Fuck" meet here.
export function fold(name) {
  return String(name)
    .toLowerCase()
    .replace(/[0-9$@]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, "");
}

export const usernameKey = (name) => String(name).trim().toLowerCase();

export function checkUsername(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return { ok: false, reason: "invalid", detail: "length" };
  if (!USERNAME_PATTERN.test(name)) return { ok: false, reason: "invalid", detail: "chars" };
  const key = usernameKey(name);
  if (RESERVED_USERNAMES.includes(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
    return { ok: false, reason: "reserved", detail: "reserved" };
  }
  const folded = fold(name);
  if (BLOCKED_WHOLE.includes(folded) || BLOCKED_SUBSTRINGS.some((w) => folded.includes(w))) {
    return { ok: false, reason: "reserved", detail: "profanity" };
  }
  return { ok: true, name };
}
