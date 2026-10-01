// Small self-contained pages written by scripts/build-pages.mjs:
// - handoffPage: the github.io pages after launch. They move the player's saved data to the new
//   origin (the sending side of the migration contract in site.config.mjs MIGRATION) and leave
//   with location.replace. No external requests: the only code is one inline script, and a meta
//   Content-Security-Policy (GitHub Pages cannot send headers) allows nothing else.
// - redirectPage: a plain move (github.io /riftborn/privacy/ -> https://riftborn.us/privacy/).
// - prelaunchPage: riftborn.us before launch; sends visitors to the game on github.io.
// - notFoundPage: unknown paths on the Cloudflare outputs; back to the game.
// Every page works without JavaScript: it says where Riftborn is and links there.
// The handoff pages that send players to the game's root can carry the social card (SOCIAL_CARD,
// below): people still share the old github.io links, and link previews (Discord, X/Twitter, Slack,
// Facebook, WhatsApp) read the page's HTML without running its script, so the preview a crawler
// builds is the game's own card instead of a bare "has moved" page.
import { scriptHash } from './pages-headers.mjs';

// Plain query strings only (the same rule the Worker applies to sign-in return URLs): ?practice=...
// survives the move, anything else is dropped.
const SAFE_QUERY = '/^\\?[A-Za-z0-9=&_.~%+-]{1,256}$/';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// JSON that is safe inside an inline <script> (no "</script>", no "<!--").
const LINE_BREAKS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const unicodeEscape = char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
const scriptJson = value => JSON.stringify(value).replace(/</g, unicodeEscape).replace(LINE_BREAKS, unicodeEscape);
const hostLabel = url => new URL(url).host;

/**
 * The social card: the Open Graph + Twitter/X tags of the game page (the game repository's
 * riftborn/index.html <head>, checked there by riftborn/tests/social-card.test.mjs) with the same
 * copy and the same image: 1200x630 JPEG served from the game's assets folder, at
 * https://riftborn.us/assets/riftborn-card.jpg. Platforms cache a card by its image URL, so
 * imageVersion is bumped whenever the art changes (the game page's ?v= moves with it).
 * tests/social-card.mjs compares these values with the game build published in live/, so the two
 * cannot drift apart unnoticed.
 */
export const SOCIAL_CARD = Object.freeze({
  title: 'Riftborn – a PS1-style browser shooter',
  // The Riftborn brand colour (rift violet): Discord colours link previews with theme-color.
  themeColor: '#8F5BFF',
  siteName: 'Riftborn',
  description: 'A PS1-style survival shooter you play in your browser. Blast through five fractured worlds, break the Keepers and take down the Rift Warden. Free, no download.',
  imagePath: '/assets/riftborn-card.jpg',
  imageVersion: 1,
  imageWidth: 1200,
  imageHeight: 630,
  imageType: 'image/jpeg',
  imageAlt: 'Riftborn logo, an octagon badge with a red skull and glowing purple eyes beside purple pixel-art RIFTBORN lettering, over a dark game screenshot: a lone survivor fires green bolts into a horde of red monsters around a skull shrine and lava pools. Tagline: PS1-style browser shooter. Footer: Free, no download, play @ riftborn.us.'
});

/**
 * The card's tags for a page that stands for `url` (the game's root, e.g. https://riftborn.us/):
 * the meta description, Open Graph (property=) and Twitter/X (name=) tags, every URL absolute.
 * Meta tags only: nothing here loads anything, so the page's meta CSP (img-src data:) stays as is.
 */
export function socialTags(url, card = SOCIAL_CARD) {
  const page = new URL(url);
  if (!/^https?:$/.test(page.protocol) || page.pathname !== '/' || page.search || page.hash) throw new Error(`socialTags: ${url} is not the root of a host`);
  const image = new URL(`${card.imagePath}?v=${card.imageVersion}`, page).href;
  const meta = (attribute, key, content) => `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;
  return [
    meta('name', 'description', card.description),
    meta('name', 'theme-color', card.themeColor),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', card.siteName),
    meta('property', 'og:url', page.href),
    meta('property', 'og:title', card.title),
    meta('property', 'og:description', card.description),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', card.imageType),
    meta('property', 'og:image:width', card.imageWidth),
    meta('property', 'og:image:height', card.imageHeight),
    meta('property', 'og:image:alt', card.imageAlt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', card.title),
    meta('name', 'twitter:description', card.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', card.imageAlt)
  ].join('\n') + '\n';
}

const STYLE = `html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#15151e;color:#ece7ca;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{max-width:30em}h1{margin:0 0 8px;font:400 22px/1.3 "Courier New",monospace;letter-spacing:.08em;color:#d4bc78}p{margin:0 0 8px;color:#c9c4a8}
a{color:#b8c49a}a:hover,a:focus-visible{color:#d4bc78}`;

// social: the root URL this page stands for (https://riftborn.us/) to add the social card, or null.
function page({ title, heading, body, script, canonical, social = null, robots = 'noindex' }) {
  const hash = script ? scriptHash(script) : null;
  const csp = ["default-src 'none'", hash ? `script-src ${hash}` : "script-src 'none'", "style-src 'unsafe-inline'", 'img-src data:', "base-uri 'none'", "form-action 'none'"].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="${robots}">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">\n` : ''}${social ? socialTags(social) : ''}<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
${script ? `<script>${script}</script>\n` : ''}</body>
</html>
`;
}

/**
 * The github.io handoff page. target: where this page moves the player (e.g. https://riftborn.us/,
 * https://riftborn.us/classic/, https://dev.riftborn.us/). migration: site.config.mjs MIGRATION.
 * social: add the social card (SOCIAL_CARD) for `target`, which must then be the game's root. Only
 * the pages that stand for the public game get it: not the classic edition (another game, another
 * card) and never the password-gated test build.
 */
export function handoffPage({ target, migration, social = false }) {
  const config = {
    target,
    from: migration.from,
    param: migration.param,
    version: migration.version,
    prefix: migration.prefix,
    exclude: migration.exclude,
    extra: migration.extra,
    never: migration.never,
    priority: migration.priority,
    maxValue: migration.maxValueBytes,
    maxTotal: migration.maxTotalBytes,
    maxKeys: migration.maxKeys,
    maxUrl: migration.maxFragmentChars,
    marker: migration.marker
  };
  // ES5 on purpose: this page must work on every browser a player might still have. Nothing is
  // logged. The saved data travels in the URL fragment, which browsers never send to a server.
  const script = `(function () {
"use strict";
var C = ${scriptJson(config)};
var link = document.getElementById("rbTo");
var note = document.getElementById("rbNote");
var query = ${SAFE_QUERY}.test(location.search) ? location.search : "";
var base = C.target + query;
if (link) link.href = base;
var hops = null;
try {
  hops = JSON.parse(sessionStorage.getItem("riftborn-handoff-hops") || "null");
  if (!hops || typeof hops.n !== "number" || Date.now() - hops.t > 60000) hops = { n: 0, t: Date.now() };
  hops.n++;
  sessionStorage.setItem("riftborn-handoff-hops", JSON.stringify(hops));
} catch (e) { hops = null; }
// Sent here again and again within a minute (the new site is not ready yet): stop, keep the link.
var looping = !!(hops && hops.n > 3);
function allowed(key) {
  if (typeof key !== "string" || !key || key.length > 128) return false;
  if (C.never.indexOf(key) !== -1) return false;
  if (C.extra.indexOf(key) !== -1) return true;
  return key.indexOf(C.prefix) === 0 && C.exclude.indexOf(key) === -1;
}
function utf8Length(text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
function rank(key) {
  var i = C.priority.indexOf(key);
  return i === -1 ? C.priority.length : i;
}
var names = [];
try {
  for (var i = 0; i < localStorage.length; i++) {
    var name = localStorage.key(i);
    if (allowed(name)) names.push(name);
  }
} catch (e) { names = []; }
names.sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0); });
function collect(budget) {
  var keys = {}, count = 0, total = 0;
  for (var i = 0; i < names.length && count < C.maxKeys; i++) {
    var value = null;
    try { value = localStorage.getItem(names[i]); } catch (e) { value = null; }
    if (typeof value !== "string") continue;
    var size = utf8Length(value);
    if (size > C.maxValue) continue;
    var add = size + utf8Length(names[i]);
    if (total + add > budget) continue;
    keys[names[i]] = value;
    count++;
    total += add;
  }
  return { keys: keys, count: count };
}
function b64url(binary) {
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
function bytesToBinary(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 32768) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return out;
}
function utf8Binary(text) {
  if (typeof TextEncoder === "function") return bytesToBinary(new TextEncoder().encode(text));
  return unescape(encodeURIComponent(text));
}
function payloadJson(budget) {
  var picked = collect(budget);
  return { json: JSON.stringify({ v: C.version, from: C.from, at: Date.now(), keys: picked.keys }), count: picked.count };
}
function plain(json) { return "j." + b64url(utf8Binary(json)); }
function compressed(json) {
  var stream = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer().then(function (buffer) { return "z." + b64url(bytesToBinary(new Uint8Array(buffer))); });
}
var sent = false;
function send(payload, count) {
  if (sent) return;
  sent = true;
  var url = base + (payload ? "#" + C.param + "=" + payload : "");
  if (link) link.href = url;
  try { localStorage.setItem(C.marker, JSON.stringify({ at: Date.now(), to: C.target, keys: count })); } catch (e) {}
  if (looping) {
    if (note) note.textContent = "Open riftborn.us with the link above to keep playing. Your progress is safe on this device.";
    return;
  }
  try { location.replace(url); } catch (e) { location.href = url; }
}
// Uncompressed (synchronous): shrinks the budget until the URL fits; the least important keys stay behind.
function sendPlain() {
  var budget = C.maxTotal;
  for (var tries = 0; tries < 6; tries++) {
    var built = payloadJson(budget);
    var payload = plain(built.json);
    if (payload.length <= C.maxUrl) return send(payload, built.count);
    budget = Math.floor(budget * (C.maxUrl / payload.length) * 0.9);
  }
  send("", 0);
}
function sendCompressed(budget, tries) {
  var built = payloadJson(budget);
  return compressed(built.json).then(function (payload) {
    if (payload.length <= C.maxUrl) return send(payload, built.count);
    if (tries >= 5) return send("", 0);
    return sendCompressed(Math.floor(budget * (C.maxUrl / payload.length) * 0.9), tries + 1);
  });
}
var canCompress = false;
try {
  canCompress = typeof CompressionStream === "function" && typeof Promise === "function" && typeof Blob === "function" &&
    typeof Response === "function" && typeof TextEncoder === "function" && !!new CompressionStream("deflate-raw");
} catch (e) { canCompress = false; }
if (!canCompress) { sendPlain(); return; }
var timer = setTimeout(function () { if (!sent) sendPlain(); }, 4000);
try {
  sendCompressed(C.maxTotal, 0).then(function () { clearTimeout(timer); }, function () { clearTimeout(timer); if (!sent) sendPlain(); });
} catch (e) { clearTimeout(timer); sendPlain(); }
})();`;
  const label = hostLabel(target);
  return page({
    title: `Riftborn has moved to ${label}`,
    heading: 'RIFTBORN HAS MOVED',
    body: `<p>Riftborn has moved to <a id="rbTo" href="${escapeHtml(target)}">${escapeHtml(label)}</a>.</p>
<p id="rbNote">Taking your progress with you&hellip;</p>
<noscript><p>Open the link above to keep playing.</p></noscript>`,
    script,
    canonical: target,
    social: social ? target : null
  });
}

/** A plain move to another URL (no data). */
export function redirectPage({ target, title = 'Riftborn has moved' }) {
  const script = `(function () { location.replace(${scriptJson(target)}); })();`;
  return page({
    title,
    heading: 'RIFTBORN HAS MOVED',
    body: `<p>This page is now at <a href="${escapeHtml(target)}">${escapeHtml(target.replace(/^https?:\/\//, ''))}</a>.</p>`,
    script,
    canonical: target
  });
}

/** riftborn.us before launch: the game is still on GitHub Pages. legacyUrl ends in /riftborn/. */
export function prelaunchPage({ legacyUrl, param }) {
  const script = `(function () {
var game = ${scriptJson(legacyUrl)};
var dest = game + (/^\\/classic(\\/|$)/.test(location.pathname) ? "classic/" : "") + (${SAFE_QUERY}.test(location.search) ? location.search : "");
var link = document.getElementById("rbTo");
if (link) link.href = dest;
// Data handed over from the old site while this one is not live yet: never bounce back (no loop).
// A reload once riftborn.us is live brings the progress in.
if (String(location.hash).indexOf(${scriptJson(param + '=')}) !== -1) {
  var note = document.getElementById("rbNote");
  if (note) note.textContent = "Riftborn is moving here right now. Reload this page in a minute to continue with your progress.";
  return;
}
location.replace(dest);
})();`;
  return page({
    title: 'Riftborn',
    heading: 'RIFTBORN',
    body: `<p>Riftborn is coming to riftborn.us soon. Until then, play at <a id="rbTo" href="${escapeHtml(legacyUrl)}">${escapeHtml(legacyUrl.replace(/^https?:\/\//, ''))}</a>.</p>
<p id="rbNote"></p>`,
    script
  });
}

/** Unknown paths on a Cloudflare output: back to the game at the root of this host. */
export function notFoundPage() {
  const script = '(function () { location.replace("/"); })();';
  return page({
    title: 'Riftborn: page not found',
    heading: 'PAGE NOT FOUND',
    body: '<p><a href="/">Play Riftborn</a></p>',
    script
  });
}

/**
 * The receiving side of the hand-over for the classic edition (https://riftborn.us/classic/, the
 * target of the old /riftborn/classic/ address). build-pages.mjs puts `style` and `script` first in
 * the classic page's <head> and replaces its game module with classicLoaderScript(), because the
 * classic game reads localStorage as soon as its module loads: the import must land first.
 * - The #rb_migrate= fragment leaves the address bar at once (history.replaceState), never kept in
 *   history, bookmarks or shared links; it waits in this tab's sessionStorage (the game's pending
 *   key), so a reload before it lands can't lose it.
 * - Decoded and checked exactly like the rebuilt game (src/meta/migration.js): same payload kinds,
 *   keys, caps and limits (MIGRATION, MIGRATION.receive). A malformed payload is ignored without a
 *   word; nothing is logged.
 * - The same trust rule as the rebuilt game: anyone can write a riftborn.us/classic/#rb_migrate=
 *   link, so a hand-over lands here only when the browser says it came from the old address
 *   (document.referrer's origin is https://chancrisp.github.io; the hand-over page's referrer
 *   policy is strict-origin). This page has no question to ask, so any other hand-over writes
 *   nothing at all here.
 * - Only the classic edition's own saves (MIGRATION.extra: its profile and preferences) are taken
 *   here: a key this device lacks is set, a key it has keeps its value. The rebuilt game's keys
 *   (the Journal, runs, boards, the score and feedback outboxes, its flags) are never written by
 *   this page, trusted or not. After a trusted hand-over the payload stays pending in this tab for
 *   the rebuilt game on this same origin, whose importer applies its own rules (profile.js's
 *   monotonic merge and so on) when the player opens it from here. An untrusted payload is dropped
 *   at once, so it can never be picked up later by a page load that looks trusted.
 * - The "moved" toast shows once per device (the game's done key, which only stops a second toast)
 *   and only after a trusted hand-over. Importing again is harmless.
 * hosts: the host names that accept a hand-over (riftborn.us and local test servers).
 */
export function classicImportScript({ migration, hosts }) {
  const receive = migration.receive;
  const config = {
    fragment: '#' + migration.param + '=',
    version: migration.version,
    from: migration.from,
    // The origin a trusted hand-over comes from (the game's MIGRATION_REFERRER_ORIGIN).
    trusted: 'https://' + migration.from,
    prefix: migration.prefix,
    exclude: migration.exclude,
    extra: migration.extra,
    never: migration.never,
    hosts,
    key: receive.keyPattern,
    maxValue: receive.maxValueChars,
    maxTotal: receive.maxTotalChars,
    maxKeys: migration.maxKeys,
    maxPayload: receive.maxPayloadChars,
    maxJson: receive.maxJsonBytes,
    pendingKey: receive.pendingKey,
    doneKey: receive.doneKey,
    profile: receive.profileKey,
    toast: migration.toast,
    toastMs: receive.toastMs,
    waitMs: receive.waitMs
  };
  // ES5 and no async/await on purpose (like the handoff page): an old browser skips it cleanly.
  const script = `(function () {
"use strict";
var C = ${scriptJson(config)};
var w = window, tab = null, local = null, payload = null;
try { tab = w.sessionStorage; } catch (e) { tab = null; }
var hash = String(location.hash || "");
if (hash.slice(0, C.fragment.length) === C.fragment) {
  try { history.replaceState(history.state, "", location.pathname + location.search); } catch (e) {}
  payload = hash.slice(C.fragment.length);
  if (!payload || payload.length > C.maxPayload) payload = null;
  else { try { if (tab) tab.setItem(C.pendingKey, payload); } catch (e) {} }
} else {
  try { payload = tab ? tab.getItem(C.pendingKey) : null; } catch (e) { payload = null; }
}
if (payload === null) return;
function forget() { try { if (tab) tab.removeItem(C.pendingKey); } catch (e) {} }
try { local = w.localStorage; } catch (e) { local = null; }
if (!payload || !local || C.hosts.indexOf(String(location.hostname)) === -1 || typeof Promise !== "function" ||
    typeof Uint8Array !== "function" || typeof TextDecoder !== "function") { forget(); return; }
var KEY = new RegExp(C.key);
function isObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function bytesOf(text) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  var b = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!b || b.length % 4 === 1) return null;
  while (b.length % 4) b += "=";
  var bin = atob(b), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function inflate(bytes) {
  var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  var chunks = [], size = 0;
  function next() {
    return reader.read().then(function (step) {
      if (step.done) {
        var out = new Uint8Array(size), at = 0;
        for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].byteLength; }
        return out;
      }
      size += step.value.byteLength;
      if (size > C.maxJson) { try { reader.cancel().then(null, function () {}); } catch (e) {} return null; }
      chunks.push(step.value);
      return next();
    });
  }
  return next();
}
function decode(text) {
  return new Promise(function (resolve) {
    var kind = text.slice(0, 2), bytes = text.length >= 3 ? bytesOf(text.slice(2)) : null;
    if (!bytes) return resolve(null);
    if (kind === "j.") return resolve(bytes);
    if (kind !== "z." || typeof DecompressionStream !== "function" || typeof Blob !== "function") return resolve(null);
    resolve(inflate(bytes));
  }).then(function (bytes) {
    if (!bytes || bytes.byteLength > C.maxJson) return null;
    var data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isObject(data) && data.v === C.version && data.from === C.from && isObject(data.keys) ? data : null;
  }).then(null, function () { return null; });
}
function allowed(key) {
  if (typeof key !== "string" || !KEY.test(key) || C.never.indexOf(key) !== -1) return false;
  if (C.extra.indexOf(key) !== -1) return true;
  return key.indexOf(C.prefix) === 0 && key.length > C.prefix.length && C.exclude.indexOf(key) === -1;
}
function fromOldAddress() {
  try { return typeof URL === "function" && new URL(String(document.referrer || "")).origin === C.trusted; } catch (e) { return false; }
}
// Caps are counted over every allowed key in the game's order (the Journal first), so a classic
// save is kept or dropped exactly as the rebuilt game's importer would. Only classic saves are
// written, and only for a trusted hand-over; anything else is left for the rebuilt game (held).
function apply(data, trusted) {
  var r = { set: 0, kept: 0, held: false }, total = 0, accepted = 0;
  var names = Object.keys(data.keys).sort(function (a, b) { return (b === C.profile) - (a === C.profile); });
  for (var i = 0; i < names.length; i++) {
    var key = names[i], value = data.keys[key];
    if (!allowed(key) || typeof value !== "string" || value.length > C.maxValue) continue;
    if (accepted >= C.maxKeys || total + value.length > C.maxTotal) continue;
    accepted++;
    total += value.length;
    if (!trusted || C.extra.indexOf(key) === -1) { r.held = true; continue; }
    try {
      if (local.getItem(key) === null) { local.setItem(key, value); r.set++; }
      else r.kept++;
    } catch (e) { r.held = true; }
  }
  return r;
}
function moved() {
  try {
    if (local.getItem(C.doneKey) !== null) return;
    local.setItem(C.doneKey, JSON.stringify({ at: Date.now(), from: C.from }));
  } catch (e) { return; }
  function show() {
    var el = document.createElement("div");
    el.className = "moved-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = C.toast;
    document.body.appendChild(el);
    setTimeout(function () { el.className += " moved-toast-out"; }, C.toastMs);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, C.toastMs + 500);
  }
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
}
var late = false;
var work = decode(payload).then(function (data) {
  if (late) return;
  if (!data) { forget(); return; }
  var trusted = fromOldAddress();
  var r = apply(data, trusted);
  // Only a trusted hand-over's leftovers wait in this tab for the rebuilt game: an untrusted payload
  // is dropped here, so a later trusted page load in this tab can't pick it up as trusted.
  if (!trusted || !r.held) forget();
  if (r.set || r.kept) moved();
}).then(null, function () {});
w.RIFTBORN_CLASSIC_IMPORT = new Promise(function (resolve) {
  var timer = setTimeout(function () { late = true; resolve(); }, C.waitMs);
  work.then(function () { clearTimeout(timer); resolve(); });
});
})();`;
  const style = '.moved-toast{position:fixed;left:50%;bottom:max(34px,env(safe-area-inset-bottom));z-index:9999;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 16px;transform:translateX(-50%);font:13px/1.5 "Crypt Pixel","Courier New",monospace;letter-spacing:.06em;text-align:center;color:#ece7ca;background:#15151e;border:2px solid #4b4b63;pointer-events:none;transition:opacity .4s}.moved-toast.moved-toast-out{opacity:0}';
  return { style, script };
}

/** Starts the classic game module (src, e.g. "game.js?v=22") once the classic import is done. */
export function classicLoaderScript({ src }) {
  return `(function () {
var started = false;
function start() {
  if (started) return;
  started = true;
  var s = document.createElement("script");
  s.type = "module";
  s.src = ${scriptJson(src)};
  document.body.appendChild(s);
}
var wait = window.RIFTBORN_CLASSIC_IMPORT;
if (wait && typeof wait.then === "function") wait.then(start, start); else start();
})();`;
}
