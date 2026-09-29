// localStorage can be missing, full, or throw (private mode, blocked site data,
// sandboxed previews). Every access goes through these guards; the game must run
// identically with storage unavailable, just without persistence.
let store = null;
try {
  store = window.localStorage;
  const probe = "__riftborn_probe__";
  store.setItem(probe, "1");
  store.removeItem(probe);
} catch {
  store = null;
}

export const storageAvailable = () => !!store;

export function loadJSON(key, fallback) {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key) {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {}
}

// Storage keys in one place so no two systems collide.
export const KEYS = Object.freeze({
  prefs: "riftborn-reborn-preferences-v1",
  profile: "riftborn-reborn-profile-v1",
  scores: "riftborn-reborn-scores-v1",
  outbox: "riftborn-reborn-score-outbox-v1",
  lastName: "riftborn-reborn-last-name-v1",
  boards: "riftborn-reborn-boards-v1", // RIFT and ASSISTED boards, this device (F15)
  profileBak: "riftborn-reborn-profile-v1-bak", // profile v2 migration backup (F19.5)
});
