#!/usr/bin/env node
// Riftborn Discord server setup, run by RiftBot. Plain Node 20+, no dependencies.
//
//   node scripts/discord-setup.mjs <phase>
//
// Phases, in the order .github/workflows/discord-setup.yml runs them (one workflow step each):
//   discover     the bot is in exactly one guild, "Riftborn", and has Administrator
//   roles        the roles and their order, @everyone hardening, Rift Keeper for the server owner
//   channels     categories, channels, topics, permission overwrites, forum tags and order
//   community    verification, content filter, notifications, rules and updates channels, COMMUNITY
//   news-forums  the channels phase again: announcement channels and forums need Community, so
//                this converts #announcements and #patch-notes and creates the two forums
//                (fails when Community is still off)
//   onboarding   default channels and the onboarding questions
//   automod      keyword preset, spam and mention spam rules
//   settings     system channel and its messages, safety alerts; then the server icon on its own:
//                set when the server has none, and left alone when it has one, unless the run was
//                asked to replace it (DISCORD_SETUP_REPLACE_ICON, below)
//   posts        the welcome, rules and FAQ posts and the other bot posts (each posted once)
//   releases     each version in scripts/discord-releases.mjs, once, and only once riftborn.us
//                serves it (its version.json): the announcement in #announcements and the patch notes
//                in #patch-notes, published to following servers
//   profile      the bot's username
//   invite       the permanent invite to #welcome
//   all          every phase in order (handy locally)
//
// Idempotent: everything is looked up by name, only what is missing is created, settings and
// overwrites are patched only when they differ from the desired state, a post is skipped when the
// bot already posted in that channel, and a release post when the bot's post of that version is
// already there. A second run makes no changes. (The workflow also runs after every deploy of
// riftborn.us, then only discover and releases, so a new version is posted as soon as it is live.)
//
// Every outcome is reported as a GitHub annotation so the result is readable without the logs:
// one ::notice per phase summing it up (a ::warning when riftborn.us could not be read for the
// release posts), and each ::error (2 per phase, then an "N more" line).
// Nothing secret is ever printed: the token and anything that looks like a token or a webhook
// URL is scrubbed from every line.
//
// Env: DISCORD_SETUP_BOT_TOKEN (required, the RiftBot token).
//      DISCORD_SETUP_REPLACE_ICON (optional, "true" or "1": the settings phase uploads the icon of
//      ICON_REVISION even when the server already has one. A one-shot: it is never set by a normal
//      run, only by the workflow_dispatch input "replace_icon" of .github/workflows/discord-setup.yml,
//      and in GitHub Actions any other trigger (a push) is refused. The result is reported in the
//      settings annotation and in the server's audit log reason).
//      DISCORD_SETUP_API_BASE (tests only: an http loopback URL for the fake API in
//      tests/discord-setup.mjs; refused in CI so the token can only ever go to discord.com).
//      RIFTBORN_TEST_LIVE_ORIGIN (tests only, read through site.config.mjs and refused in CI there:
//      the origin whose /version.json the releases phase reads in place of https://riftborn.us).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://riftborn.us, 1.0)';
const AUDIT_REASON = 'Riftborn setup';
const GUILD_NAME = 'Riftborn';
const BOT_NAME = 'RiftBot';

// The server icon. Discord's guild icon is a PNG, JPEG or GIF (GIF only when the server has
// ANIMATED_ICON), documented as 1024x1024: the skull badge is that, a still PNG. Each icon the
// server has worn or will wear is a numbered revision; ICON_REVISION is the one the setup uploads:
//   - to a server with no icon, on any run;
//   - over an icon the server already has, only on a run asked to replace it (see the header).
// To change the icon later: add the file, add its revision here, bump ICON_REVISION, push, then run
// the workflow once with "replace_icon" ticked. Never reuse a revision for a different image.
const ICON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'discord-assets');
const ICONS = {
  1: { file: 'riftborn-portal-512.png', label: 'the Rift Portal' },
  2: { file: 'riftborn-skull-1024.png', label: 'the Riftborn skull badge' },
};
const ICON_REVISION = 2;
const ICON = ICONS[ICON_REVISION];
const ICON_FILE = path.join(ICON_DIR, ICON.file);

// ---------------------------------------------------------------------------------------------
// Discord constants

const bit = (n) => 1n << BigInt(n);
const P = {
  CREATE_INSTANT_INVITE: bit(0), KICK_MEMBERS: bit(1), BAN_MEMBERS: bit(2), ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4), MANAGE_GUILD: bit(5), ADD_REACTIONS: bit(6), VIEW_AUDIT_LOG: bit(7),
  PRIORITY_SPEAKER: bit(8), STREAM: bit(9), VIEW_CHANNEL: bit(10), SEND_MESSAGES: bit(11),
  SEND_TTS_MESSAGES: bit(12), MANAGE_MESSAGES: bit(13), EMBED_LINKS: bit(14), ATTACH_FILES: bit(15),
  READ_MESSAGE_HISTORY: bit(16), MENTION_EVERYONE: bit(17), USE_EXTERNAL_EMOJIS: bit(18),
  VIEW_GUILD_INSIGHTS: bit(19), CONNECT: bit(20), SPEAK: bit(21), MUTE_MEMBERS: bit(22),
  DEAFEN_MEMBERS: bit(23), MOVE_MEMBERS: bit(24), USE_VAD: bit(25), CHANGE_NICKNAME: bit(26),
  MANAGE_NICKNAMES: bit(27), MANAGE_ROLES: bit(28), MANAGE_WEBHOOKS: bit(29),
  MANAGE_GUILD_EXPRESSIONS: bit(30), USE_APPLICATION_COMMANDS: bit(31), REQUEST_TO_SPEAK: bit(32),
  MANAGE_EVENTS: bit(33), MANAGE_THREADS: bit(34), CREATE_PUBLIC_THREADS: bit(35),
  CREATE_PRIVATE_THREADS: bit(36), USE_EXTERNAL_STICKERS: bit(37), SEND_MESSAGES_IN_THREADS: bit(38),
  USE_EMBEDDED_ACTIVITIES: bit(39), MODERATE_MEMBERS: bit(40), VIEW_CREATOR_MONETIZATION_ANALYTICS: bit(41),
  USE_SOUNDBOARD: bit(42), CREATE_GUILD_EXPRESSIONS: bit(43), CREATE_EVENTS: bit(44),
  USE_EXTERNAL_SOUNDS: bit(45), SEND_VOICE_MESSAGES: bit(46), SEND_POLLS: bit(49), USE_EXTERNAL_APPS: bit(50),
  // Split out of MANAGE_MESSAGES on 23 Feb 2026: pinning, and not being held by slowmode.
  PIN_MESSAGES: bit(51), BYPASS_SLOWMODE: bit(52),
};
const perms = (...names) => names.reduce((acc, name) => acc | P[name], 0n);

// What a normal member can do (the Moderator role carries it too, on top of its mod powers).
const MEMBER_PERMS = perms(
  'VIEW_CHANNEL', 'CREATE_INSTANT_INVITE', 'CHANGE_NICKNAME', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS',
  'CREATE_PUBLIC_THREADS', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS',
  'USE_EXTERNAL_STICKERS', 'READ_MESSAGE_HISTORY', 'CONNECT', 'SPEAK', 'STREAM', 'USE_VAD',
  'USE_APPLICATION_COMMANDS', 'USE_EMBEDDED_ACTIVITIES', 'SEND_VOICE_MESSAGES', 'SEND_POLLS',
  'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS', 'REQUEST_TO_SPEAK', 'USE_EXTERNAL_APPS',
);
const MOD_PERMS = MEMBER_PERMS | perms('VIEW_AUDIT_LOG', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'BYPASS_SLOWMODE',
  'MANAGE_THREADS', 'MODERATE_MEMBERS', 'KICK_MEMBERS', 'MUTE_MEMBERS', 'MOVE_MEMBERS');
// Taken off @everyone (what Discord's own Community setup calls "remove moderation permissions").
const EVERYONE_STRIP = perms('ADMINISTRATOR', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_CHANNELS', 'MANAGE_GUILD',
  'VIEW_AUDIT_LOG', 'PRIORITY_SPEAKER', 'MANAGE_MESSAGES', 'MENTION_EVERYONE', 'VIEW_GUILD_INSIGHTS',
  'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'MANAGE_NICKNAMES', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS',
  'MANAGE_GUILD_EXPRESSIONS', 'MANAGE_EVENTS', 'MANAGE_THREADS', 'MODERATE_MEMBERS',
  'VIEW_CREATOR_MONETIZATION_ANALYTICS', 'CREATE_GUILD_EXPRESSIONS', 'CREATE_EVENTS', 'PIN_MESSAGES', 'BYPASS_SLOWMODE');
const permNames = (value) => Object.entries(P).filter(([, flag]) => value & flag).map(([name]) => name);
// Channel overwrites.
const POSTING = perms('SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'ADD_REACTIONS');
const READONLY_DENY = perms('SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'ADD_REACTIONS');
const NEWS_DENY = perms('SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS');
const BOT_ALLOW = perms('VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'READ_MESSAGE_HISTORY',
  'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_MESSAGES',
  'MANAGE_THREADS', 'MANAGE_WEBHOOKS');

const T = { TEXT: 0, VOICE: 2, CATEGORY: 4, NEWS: 5, STAGE: 13, FORUM: 15 };
const TYPE_GROUP = { [T.TEXT]: [T.TEXT, T.NEWS], [T.NEWS]: [T.TEXT, T.NEWS], [T.VOICE]: [T.VOICE, T.STAGE], [T.CATEGORY]: [T.CATEGORY], [T.FORUM]: [T.FORUM] };
const OW_ROLE = 0, OW_MEMBER = 1;
const THREAD_PINNED = 2;
const CROSSPOSTED = 1, SUPPRESS_EMBEDS = 4; // message flags
const ALREADY_CROSSPOSTED = 40033; // Discord's error code for publishing a message twice
const SYS_SUPPRESS_JOIN = 1, SYS_SUPPRESS_BOOSTS = 2, SYS_SUPPRESS_SETUP_TIPS = 4;
const VERIFICATION_MEDIUM = 2, FILTER_ALL_MEMBERS = 2, NOTIFY_ONLY_MENTIONS = 1;

// ---------------------------------------------------------------------------------------------
// The desired server

// Ping roles are not mentionable by everyone: Rift Keeper (Administrator) and RiftBot can always
// ping them, and leaving them closed stops any member from pinging everyone who opted in.
// Set this to true if members should be able to @mention them too.
const PING_ROLES_MENTIONABLE = false;

// Top of the hierarchy first; all of them sit below RiftBot's own role.
const ROLES = [
  { key: 'keeper', name: 'Rift Keeper', color: 0xff7a1a, hoist: true, mentionable: false, permissions: P.ADMINISTRATOR },
  { key: 'mod', name: 'Moderator', color: 0x9b5cff, hoist: true, mentionable: false, permissions: MOD_PERMS },
  { key: 'tester', name: 'Tester', color: 0x3ad6c5, hoist: true, mentionable: false, permissions: 0n },
  { key: 'rifter', name: 'Rifter', color: 0xe8c170, hoist: false, mentionable: false, permissions: 0n },
  { key: 'newsPing', name: 'News pings', color: 0, hoist: false, mentionable: PING_ROLES_MENTIONABLE, permissions: 0n },
  { key: 'patchPing', name: 'Patch pings', color: 0, hoist: false, mentionable: PING_ROLES_MENTIONABLE, permissions: 0n },
  { key: 'eventPing', name: 'Event pings', color: 0, hoist: false, mentionable: PING_ROLES_MENTIONABLE, permissions: 0n },
];

const BUG_GUIDELINES = 'One bug per post, with a short title that says what went wrong. Include your device, browser, '
  + 'what happened, what you expected, the steps to make it happen again, and a screenshot or clip if you can. '
  + 'Tag it phone, desktop or controller. Search first: if it is already posted, add a thumbs up and your details there. '
  + 'Exploits and leaderboard cheats go privately to a mod, never here.';
const IDEA_GUIDELINES = 'One idea per post, with a title that sums it up. Say what you would add or change and why it '
  + 'would be fun. Search first, and give ideas you like a thumbs up instead of posting them again. Mods tag posts '
  + 'under review, planned, done or not planned. Be kind about other people\'s ideas.';

// access: readonly (everyone reads, only Rift Keeper and the bot post), news (same, but everyone
// can react), public (the server's normal permissions), testers / staff / owner (private).
const LAYOUT = [
  { name: '📜 START HERE', access: 'readonly', channels: [
    { name: 'welcome', type: T.TEXT, topic: 'Start here: what Riftborn is and where everything lives. Play free at https://riftborn.us' },
    { name: 'rules', type: T.TEXT, topic: 'The rules of the rift. Read them, then jump in.' },
    { name: 'faq', type: T.TEXT, topic: 'Quick answers about accounts, progress, controllers and bugs.' },
  ] },
  { name: '📣 NEWS', access: 'news', channels: [
    { name: 'announcements', type: T.NEWS, topic: 'Big news from the rift. Follow this channel to get it in your own server.' },
    { name: 'patch-notes', type: T.NEWS, topic: 'What changed in each update. The full notes are in-game: PATCH NOTES on the main menu.' },
    { name: 'sneak-peeks', type: T.TEXT, topic: 'First looks at what is coming through the rift.' },
  ] },
  { name: '💬 COMMUNITY', access: 'public', channels: [
    { name: 'general', type: T.TEXT, topic: 'Talk about anything Riftborn. Be kind and keep secrets spoiler-free.' },
    { name: 'introductions', type: T.TEXT, topic: 'New here? Say hi and tell us your favourite world, weapon or character.' },
    { name: 'screenshots-and-clips', type: T.TEXT, topic: 'Your best runs, wildest deaths and prettiest views.' },
    { name: 'fan-art', type: T.TEXT, topic: 'Drawings, pixel art and anything fan-made. Always credit the artist.' },
    { name: 'off-topic', type: T.TEXT, topic: 'Anything that is not about the rift. Keep it friendly.' },
  ] },
  { name: '🎮 THE RIFT', access: 'public', channels: [
    { name: 'builds-and-strategy', type: T.TEXT, topic: 'Loadouts, dash tricks, keeper fights and how to go further.' },
    { name: 'leaderboard-brags', type: T.TEXT, topic: 'Post your scores and personal bests. Screenshots or it did not happen.' },
    { name: 'secret-hunt', type: T.TEXT, topic: 'Hunting secrets? Clues, theories and spoilers are welcome here, and only here.' },
  ] },
  { name: '🛠️ FEEDBACK', access: 'public', channels: [
    { name: 'bug-reports', type: T.FORUM, topic: BUG_GUIDELINES, reaction: '👍', tags: [
      { name: 'needs info', moderated: true, emoji: '❓' },
      { name: 'confirmed', moderated: true, emoji: '✅' },
      { name: 'fixed', moderated: true, emoji: '🔧' },
      { name: 'phone', emoji: '📱' },
      { name: 'desktop', emoji: '💻' },
      { name: 'controller', emoji: '🎮' },
    ] },
    { name: 'suggestions', type: T.FORUM, topic: IDEA_GUIDELINES, reaction: '👍', tags: [
      { name: 'under review', moderated: true, emoji: '👀' },
      { name: 'planned', moderated: true, emoji: '📌' },
      { name: 'done', moderated: true, emoji: '🎉' },
      { name: 'not planned', moderated: true, emoji: '❌' },
    ] },
  ] },
  { name: '🧪 TESTERS', access: 'testers', channels: [
    { name: 'tester-chat', type: T.TEXT, topic: 'Private tester chat. Unreleased features and test build talk stay in here.' },
    { name: 'dev-builds', type: T.TEXT, topic: 'Test build info: https://dev.riftborn.us (the password is shared privately, never posted).' },
  ] },
  { name: '🔒 STAFF', access: 'staff', channels: [
    { name: 'mod-chat', type: T.TEXT, topic: 'Staff only: moderation talk and decisions.' },
    { name: 'mod-log', type: T.TEXT, topic: 'Staff only: AutoMod alerts and Discord community updates.' },
  ] },
  { name: '🔒 OWNER ONLY', access: 'owner', channels: [
    { name: 'game-feedback', type: T.TEXT, topic: 'Owner only: feedback sent from the FEEDBACK button in the game lands here.' },
  ] },
  { name: '🔊 VOICE', access: 'public', channels: [
    { name: 'Lobby', type: T.VOICE, reuse: 'General' },
    { name: 'Co-op', type: T.VOICE },
  ] },
];
const DEFAULT_CATEGORIES = ['Text Channels', 'Voice Channels'];
const PUBLIC_ACCESS = new Set(['readonly', 'news', 'public']);

// {#name} becomes a real channel mention when posted.
const WELCOME = `**Welcome to Riftborn** 🌋
A free PS1-style survival shooter you play right in your browser. Five broken worlds, one way home.
▶️ **Play:** https://riftborn.us
🧭 Read {#rules}, then pick your pings in *Channels & Roles*.
📣 News in {#announcements} and {#patch-notes} · 🐞 bugs in {#bug-reports} · 💡 ideas in {#suggestions} · 🏆 brag in {#leaderboard-brags}
See you in the rift.`;

const RULES = `**Rules**
1. Be kind: no harassment, hate speech, slurs or personal attacks.
2. Keep it safe for everyone: no NSFW, gore or shock content.
3. No spam, self-promo or unsolicited DMs.
4. Secret and code spoilers only in {#secret-hunt}.
5. No cheats or leaderboard exploits; report exploits privately to a mod.
6. Use the right channel, so bug reports actually get fixed.
7. Follow Discord's Terms of Service and Community Guidelines.
Mods may remove messages or members that break these rules.`;

const FAQ = `**Is it free?** Yes. Play at https://riftborn.us on desktop or phone.
**Do I need an account?** No, you can play as a guest. Sign in with Google, Discord or GitHub to keep your progress on every device. No email or real name is ever stored.
**I played at the old chancrisp.github.io address, is my progress gone?** No. Open your old link once and it moves your progress over automatically.
**Controllers?** Keyboard and mouse, gamepad and touch all work.
**Found a bug?** Post in {#bug-reports} with your device and browser, or use FEEDBACK on the game's main menu.
**Secret characters?** There are a few… clues go in {#secret-hunt}. No spoilers elsewhere!
**Privacy:** https://riftborn.us/privacy/`;

// The 2.2 announcement and patch notes, and every version since, are in scripts/discord-releases.mjs
// (the releases phase).

const SECRET_HUNT = `**Welcome to the secret hunt** 🔍
Riftborn hides a few secrets. Share theories, clues and finds here.
Spoilers are fine in this channel, and only here. Wrap big reveals in ||spoiler tags|| so others can still hunt for themselves.
Leaderboard exploits and cheats are not secrets: report those privately to a mod.
Happy hunting, Rifters.`;

const DEV_BUILDS = `**Tester builds** 🧪
Upcoming updates are tested at https://dev.riftborn.us before they go live.
🔑 The password is shared with you privately by the developer. Never post it anywhere, including here.
**What to test:** what's new in the latest build, plus your normal runs on your own devices (phone, desktop, controller). Watch for crashes, broken layouts, sign-in or sync hiccups, and anything that feels off.
**Where to report:** anything in an unreleased feature goes in {#tester-chat} so it stays private, with your device, browser, what happened and the steps. Bugs you also see on https://riftborn.us can go in {#bug-reports}.
Test builds change often and can break. Please keep what you see here private until it ships.`;

const BUG_GUIDE = `**How to report a bug** 🐞
One bug per post, with a short title that says what went wrong.
Please include:
- **Device:** phone, tablet or desktop (and the model for phones)
- **Browser:** Chrome, Safari, Firefox, Edge or other, and the version if you know it
- **What happened**, and what you expected instead
- **Steps:** how to make it happen again
- **A screenshot or clip** if you can
Add the **phone**, **desktop** or **controller** tag. Mods mark posts **needs info**, **confirmed** or **fixed**.
Seen it already? Add a 👍 and your details to that post instead of starting a new one.
Found an exploit or a way to cheat the leaderboard? Don't post it here: message a mod privately.
You can also send feedback from the game itself: **FEEDBACK** on the main menu.`;

const IDEA_GUIDE = `**How to suggest an idea** 💡
- **One idea per post**, with a title that sums it up
- **What:** the weapon, world, mode, character, cosmetic or tweak you'd like
- **Why it'd be fun:** what it adds to a run
- Sketches and mock-ups are welcome
Search first, and add a 👍 to ideas you like instead of posting them again. Mods tag posts **under review**, **planned**, **done** or **not planned**.
Not every idea makes it into the game, but they all help shape it.`;

// embeds: keep the link preview (only the welcome). #announcements and #patch-notes belong to the
// releases phase.
const POSTS = [
  { channel: 'welcome', content: WELCOME, embeds: true },
  { channel: 'rules', content: RULES },
  { channel: 'faq', content: FAQ },
  { channel: 'secret-hunt', content: SECRET_HUNT },
  { channel: 'dev-builds', content: DEV_BUILDS },
  { channel: 'bug-reports', thread: 'How to report a bug', content: BUG_GUIDE },
  { channel: 'suggestions', thread: 'How to suggest an idea', content: IDEA_GUIDE },
];

const BLOCK = { type: 1, metadata: { custom_message: 'RiftBot blocked this message. Keep it friendly and check the rules.' } };
const automodRules = (modLogId) => [
  { name: 'RiftBot: blocked words', event_type: 1, trigger_type: 4,
    trigger_metadata: { presets: [1, 2, 3], allow_list: [] }, actions: [BLOCK] },
  { name: 'RiftBot: spam', event_type: 1, trigger_type: 3, trigger_metadata: {}, actions: [BLOCK] },
  { name: 'RiftBot: mention spam', event_type: 1, trigger_type: 5,
    trigger_metadata: { mention_total_limit: 6, mention_raid_protection_enabled: true },
    actions: [BLOCK, ...(modLogId ? [{ type: 2, metadata: { channel_id: modLogId } }] : [])] },
];

// ---------------------------------------------------------------------------------------------
// Reporting: GitHub annotations, scrubbed

// GitHub keeps at most 50 annotations per job. Each of the 12 steps emits one summary (a notice, or
// a warning) and at most 2 errors plus one "N more errors" line: 4 per step, 48 per job.
const MAX_ERRORS = 2;
const TOKEN = (process.env.DISCORD_SETUP_BOT_TOKEN || '').trim();

function scrub(text, max = 400) {
  let s = String(text);
  if (TOKEN.length >= 8) s = s.split(TOKEN).join('***');
  s = s.replace(/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\S*/gi, '[webhook url]');
  s = s.replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g, '***'); // anything shaped like a bot token
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
const escData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function makeReporter(title) {
  const t = escProp(title);
  const notes = [];
  let errors = 0;
  let warned = false;
  return {
    // Notices are gathered into the step's one summary annotation, written by finish().
    notice: (text) => { const line = scrub(text); notes.push(line); console.log(`notice: ${line}`); },
    // Like notice, and the summary annotation becomes a ::warning (the step still passes).
    warn: (text) => { warned = true; const line = scrub(text); notes.push(line); console.log(`warning: ${line}`); },
    error: (text) => {
      errors += 1;
      const line = scrub(text);
      console.log(errors <= MAX_ERRORS ? `::error title=${t}::${escData(line)}` : `error: ${line}`);
    },
    log: (text) => console.log(`  ${scrub(text)}`),
    finish() {
      if (errors > MAX_ERRORS) console.log(`::error title=${t}::${errors - MAX_ERRORS} more error${errors - MAX_ERRORS === 1 ? '' : 's'} in the step log`);
      const summary = notes.length ? notes.join('; ') : errors ? `failed with ${errors} error${errors === 1 ? '' : 's'}` : 'done';
      console.log(`::${warned ? 'warning' : 'notice'} title=${t}::${escData(scrub(summary, 1000))}`);
      return errors ? 1 : 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Discord REST client: rate limits, retries, audit log reason

class DiscordError extends Error {
  constructor(status, data, fallback) {
    const details = flattenErrors(data?.errors);
    const code = data?.code ? `, code ${data.code}` : '';
    const message = data?.message || fallback || 'request failed';
    super(`HTTP ${status}${code}: ${message}${details.length ? ` (${details.join('; ')})` : ''}`);
    this.status = status;
    this.code = data?.code;
  }
}
class SetupError extends Error {}

function flattenErrors(obj, at = '', out = []) {
  if (!obj || typeof obj !== 'object' || out.length >= 3) return out;
  if (Array.isArray(obj._errors)) {
    for (const e of obj._errors) if (out.length < 3) out.push(`${at || 'body'}: ${e.code ? `${e.code} ` : ''}${e.message ?? ''}`.trim());
  }
  for (const [key, value] of Object.entries(obj)) if (key !== '_errors') flattenErrors(value, at ? `${at}.${key}` : key, out);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const stats = { requests: 0, rateLimited: 0, retried: 0 };
let apiBase = DISCORD_API;
let replaceIcon = false; // set per phase by runPhase from DISCORD_SETUP_REPLACE_ICON
let gateUntil = 0; // global pause (a global 429, or a bucket with no requests left)

// maxWait: the longest rate limit wait (ms) worth sitting out; a longer one fails the request instead
// (publishing has an hourly limit, and the job would time out waiting for it).
async function api(method, route, { body, query, reason, maxWait = Infinity } = {}) {
  const url = `${apiBase}${route}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const headers = { Authorization: `Bot ${TOKEN}`, 'User-Agent': USER_AGENT };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-Audit-Log-Reason'] = reason ?? AUDIT_REASON; // ASCII only: it is a header
  // A POST that failed with a 5xx may still have created something, so it is never replayed: the
  // error is reported and the next run finds (or creates) the thing by name.
  const replayable = method !== 'POST';
  for (let attemptNo = 1; ; attemptNo += 1) {
    await sleep(gateUntil - Date.now());
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (replayable && attemptNo < 4) { stats.retried += 1; await sleep(1000 * attemptNo); continue; }
      throw new DiscordError(0, null, `network error (${err?.cause?.code || err?.name || 'fetch failed'})`);
    }
    stats.requests += 1;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
    // A bucket reset longer than this caller will wait (publishing's hourly limit) must not pause the
    // requests after it: that bucket's own next request gets a 429 and fails at once instead.
    if (remaining === '0' && resetAfter > 0 && resetAfter * 1000 <= maxWait) gateUntil = Math.max(gateUntil, Date.now() + resetAfter * 1000 + 50);
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      stats.rateLimited += 1;
      if (attemptNo >= 8) throw new DiscordError(429, data, 'still rate limited after 8 tries');
      const retryAfter = Number(data.retry_after ?? res.headers.get('retry-after') ?? 1);
      const waitSeconds = Number.isFinite(retryAfter) ? retryAfter : 1;
      if (waitSeconds * 1000 > maxWait) {
        throw new DiscordError(429, { ...data, message: `${data.message || 'rate limited'} (retry after ${Math.ceil(waitSeconds)} s)` });
      }
      const until = Date.now() + waitSeconds * 1000 + 100;
      if (data.global || res.headers.get('x-ratelimit-global')) gateUntil = Math.max(gateUntil, until);
      await sleep(until - Date.now());
      continue;
    }
    if (res.status >= 500 && replayable && attemptNo < 4) {
      await res.arrayBuffer().catch(() => {});
      stats.retried += 1;
      await sleep(500 * 2 ** (attemptNo - 1));
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new DiscordError(res.status, data, res.status === 401 ? 'the bot token was rejected' : res.statusText);
    return data;
  }
}

const FAIL = Symbol('failed');
const describe = (err) => (err instanceof DiscordError || err instanceof SetupError ? err.message : `${err?.name || 'Error'}: ${err?.message || err}`);
async function attempt(r, label, fn) {
  try {
    return await fn();
  } catch (err) {
    r.error(`${label}: ${describe(err)}`);
    return FAIL;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const norm = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const idCmp = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0) || idCmp(a.id, b.id);
// Discord ranks roles by position, and equal positions by age: the older role (lower id) ranks
// higher. Roles made through the API all start at position 1, so ties are normal.
const ranksAbove = (a, b) => a.position > b.position || (a.position === b.position && idCmp(a.id, b.id) < 0);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedJson = (list) => JSON.stringify([...(list ?? [])].map(String).sort());

function findChannel(channels, name, type, parentId) {
  const group = TYPE_GROUP[type] ?? [type];
  const matches = channels.filter((c) => group.includes(c.type) && norm(c.name) === norm(name));
  return matches.find((c) => c.parent_id === parentId) ?? matches[0] ?? null;
}
function findRole(roles, name) {
  return roles.find((role) => !role.managed && role.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
}
function roleIds(roles) {
  const out = {};
  for (const spec of ROLES) out[spec.key] = findRole(roles, spec.name)?.id ?? null;
  return out;
}
function channelByName(channels, name) {
  for (const cat of LAYOUT) {
    const spec = cat.channels.find((c) => c.name === name);
    if (spec) return findChannel(channels, name, spec.type);
  }
  return null;
}

function overwritesFor(access, who) {
  const list = [];
  const role = (id, allow, deny = 0n) => { if (id) list.push({ id, type: OW_ROLE, allow, deny }); };
  const bot = () => list.push({ id: who.bot, type: OW_MEMBER, allow: BOT_ALLOW, deny: 0n });
  switch (access) {
    case 'readonly': role(who.everyone, 0n, READONLY_DENY); role(who.keeper, POSTING); bot(); break;
    case 'news': role(who.everyone, 0n, NEWS_DENY); role(who.keeper, POSTING); bot(); break;
    case 'testers': role(who.everyone, 0n, P.VIEW_CHANNEL); role(who.tester, P.VIEW_CHANNEL); role(who.mod, P.VIEW_CHANNEL); bot(); break;
    case 'staff': role(who.everyone, 0n, P.VIEW_CHANNEL); role(who.mod, P.VIEW_CHANNEL); bot(); break;
    case 'owner': role(who.everyone, 0n, P.VIEW_CHANNEL); bot(); break; // no role is ever granted
    default: break; // public: the server's normal permissions
  }
  return list.map(owJson);
}
const owJson = (o) => ({ id: String(o.id), type: Number(o.type), allow: String(BigInt(o.allow ?? 0)), deny: String(BigInt(o.deny ?? 0)) });
const owKey = (list) => JSON.stringify((list ?? []).map(owJson).sort((a, b) => idCmp(a.id, b.id)));

// Overwrites for ids this script manages are set exactly; others (added by hand) are kept, except
// on the owner-only channels, where nobody but the bot may be let in.
function mergeOverwrites(existing, desired, managedIds, access) {
  const keep = (existing ?? []).filter((o) => !managedIds.has(String(o.id))
    && !(access === 'owner' && (BigInt(o.allow ?? 0) & P.VIEW_CHANNEL)));
  return [...keep.map(owJson), ...desired];
}

function mergeTags(existing, desired) {
  const out = [];
  let changed = false;
  for (const tag of desired) {
    const want = { name: tag.name, moderated: Boolean(tag.moderated), emoji_id: null, emoji_name: tag.emoji ?? null };
    const found = (existing ?? []).find((t) => t.name.toLowerCase() === tag.name.toLowerCase());
    if (!found) { out.push(want); changed = true; continue; }
    out.push({ id: found.id, ...want });
    if (found.name !== want.name || Boolean(found.moderated) !== want.moderated
      || (found.emoji_name ?? null) !== want.emoji_name || found.emoji_id) changed = true;
  }
  for (const tag of existing ?? []) {
    if (!desired.some((d) => d.name.toLowerCase() === tag.name.toLowerCase())) out.push(tag);
  }
  return changed ? out : null;
}

let snowflakeSeq = 0n;
const newSnowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) | (snowflakeSeq++ & 0xfffn));

// ---------------------------------------------------------------------------------------------
// Context (every phase starts from a fresh look at the server)

async function loadContext() {
  const me = await api('GET', '/users/@me');
  const guilds = await api('GET', '/users/@me/guilds');
  if (!Array.isArray(guilds) || guilds.length !== 1) {
    const names = Array.isArray(guilds) ? guilds.slice(0, 5).map((g) => `"${g.name}"`).join(', ') : '';
    throw new SetupError(`expected the bot in exactly one guild ("${GUILD_NAME}"), found ${Array.isArray(guilds) ? guilds.length : 0}${names ? `: ${names}` : ''}`);
  }
  if (guilds[0].name !== GUILD_NAME) throw new SetupError(`the bot's only guild is "${guilds[0].name}", expected "${GUILD_NAME}"`);
  const guild = await api('GET', `/guilds/${guilds[0].id}`);
  const channels = await api('GET', `/guilds/${guild.id}/channels`);
  const botRole = guild.roles.find((role) => role.managed && role.tags?.bot_id === me.id) ?? null;
  return { me, guild, gid: guild.id, roles: guild.roles, channels, botRole };
}

// ---------------------------------------------------------------------------------------------
// Phases

async function phaseDiscover(r, ctx) {
  const { guild, me, botRole, channels, roles } = ctx;
  const community = guild.features.includes('COMMUNITY') ? 'on' : 'off';
  r.notice(`guild "${guild.name}" (${guild.id}): ${channels.length} channels, ${roles.length} roles, Community ${community}`);
  if (!botRole) r.error('the bot has no role of its own in the guild: invite it again with the bot scope and Administrator');
  else if (!(BigInt(botRole.permissions) & P.ADMINISTRATOR)) r.error(`the bot's role "${botRole.name}" lacks Administrator: invite it again with Administrator`);
  else {
    const rank = roles.filter((role) => role.id !== botRole.id && ranksAbove(role, botRole)).length + 1;
    r.notice(`bot ${me.username} is in the guild with Administrator (its role ranks ${rank} of ${roles.length - 1} from the top)`);
  }
}

async function phaseRoles(r, ctx) {
  const { gid, guild } = ctx;
  let roles = ctx.roles;
  const n = { created: 0, updated: 0, same: 0 };
  for (const spec of ROLES) {
    const want = { name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable, permissions: String(spec.permissions) };
    const found = findRole(roles, spec.name);
    if (!found) {
      const made = await attempt(r, `create role ${spec.name}`, () => api('POST', `/guilds/${gid}/roles`, { body: want }));
      if (made !== FAIL) { roles = [...roles, made]; n.created += 1; r.log(`+ role ${spec.name}`); }
      continue;
    }
    const patch = {};
    if (found.name !== spec.name) patch.name = spec.name;
    if ((found.color ?? 0) !== spec.color) patch.color = spec.color;
    if (Boolean(found.hoist) !== spec.hoist) patch.hoist = spec.hoist;
    if (Boolean(found.mentionable) !== spec.mentionable) patch.mentionable = spec.mentionable;
    if (BigInt(found.permissions) !== spec.permissions) patch.permissions = String(spec.permissions);
    if (!Object.keys(patch).length) { n.same += 1; continue; }
    const done = await attempt(r, `update role ${spec.name}`, () => api('PATCH', `/guilds/${gid}/roles/${found.id}`, { body: patch }));
    if (done !== FAIL) { n.updated += 1; r.log(`~ role ${spec.name}: ${Object.keys(patch).join(', ')}`); }
  }

  // Order: Rift Keeper > Moderator > Tester > Rifter > ping roles, all below the bot's role.
  roles = await api('GET', `/guilds/${gid}/roles`);
  const botRole = roles.find((role) => role.managed && role.tags?.bot_id === ctx.me.id);
  const ours = ROLES.map((spec) => findRole(roles, spec.name));
  let order = 'order unchanged';
  if (ours.every(Boolean)) {
    const current = [...ours].sort((a, b) => b.position - a.position || idCmp(a.id, b.id)).map((role) => role.id);
    const inOrder = sameList(current, ours.map((role) => role.id));
    const belowBot = !botRole || ours.every((role) => ranksAbove(botRole, role));
    if (!belowBot) {
      r.error(`${botRole.name}'s role must be above the Riftborn roles: drag it to the top in Server Settings > Roles, then run again`);
    } else if (!inOrder && botRole && botRole.position <= ours.length) {
      // The bot can only move roles below its own, and with its role this low the only free
      // positions are ties that Discord orders by age: the owner's drag spreads the positions out.
      r.error(`the Riftborn roles are out of order: drag them into order under ${botRole.name} (${ROLES.map((spec) => spec.name).join(', ')}) in Server Settings > Roles, then run again`);
    } else if (!inOrder) {
      const body = [...ours].reverse().map((role, i) => ({ id: role.id, position: i + 1 }));
      const done = await attempt(r, 'reorder roles', () => api('PATCH', `/guilds/${gid}/roles`, { body }));
      if (done !== FAIL) order = 'reordered';
    }
  } else {
    order = 'order not checked (roles missing)';
  }

  // @everyone keeps member permissions but no moderation powers or @everyone pings.
  const everyone = roles.find((role) => role.id === gid);
  let everyoneNote = '@everyone ok';
  if (everyone) {
    const before = BigInt(everyone.permissions);
    const hardened = before & ~EVERYONE_STRIP;
    if (hardened !== before) {
      const stripped = permNames(before & EVERYONE_STRIP).join(', ');
      const done = await attempt(r, `harden @everyone (remove ${stripped})`, () => api('PATCH', `/guilds/${gid}/roles/${gid}`, { body: { permissions: String(hardened) } }));
      if (done !== FAIL) everyoneNote = `@everyone lost ${stripped} (was ${before}, now ${hardened})`;
    }
  }

  // The server owner wears Rift Keeper.
  const keeper = findRole(roles, 'Rift Keeper');
  let ownerNote = 'owner role not checked';
  if (keeper) {
    const member = await attempt(r, 'look up the server owner', () => api('GET', `/guilds/${gid}/members/${guild.owner_id}`));
    if (member !== FAIL && member) {
      if (member.roles.includes(keeper.id)) ownerNote = 'owner has Rift Keeper';
      else {
        const done = await attempt(r, 'give the owner Rift Keeper', () => api('PUT', `/guilds/${gid}/members/${guild.owner_id}/roles/${keeper.id}`));
        if (done !== FAIL) ownerNote = 'owner given Rift Keeper';
      }
    }
  }
  r.notice(`roles: ${n.created} created, ${n.updated} updated, ${n.same} unchanged; ${order}; ${ownerNote}; ${everyoneNote}`);
}

async function phaseChannels(r, ctx) {
  const { gid, me, guild } = ctx;
  const channels = [...ctx.channels];
  const community = guild.features.includes('COMMUNITY');
  const hasNews = community || guild.features.includes('NEWS');
  const ids = roleIds(ctx.roles);
  const missingRoles = ROLES.filter((spec) => ['keeper', 'mod', 'tester'].includes(spec.key) && !ids[spec.key]).map((spec) => spec.name);
  if (missingRoles.length) r.error(`roles not found: ${missingRoles.join(', ')}. Run the Roles step first; private channels stay hidden from everyone meanwhile`);
  const who = { everyone: gid, bot: me.id, keeper: ids.keeper, mod: ids.mod, tester: ids.tester };
  const managed = new Set([gid, me.id, ...Object.values(ids).filter(Boolean)]);
  const n = { created: 0, updated: 0, same: 0 };
  const deferred = [];
  const textForNow = [];
  const put = (channel) => {
    const i = channels.findIndex((c) => c.id === channel.id);
    if (i >= 0) channels[i] = channel; else channels.push(channel);
  };
  const patchChannel = async (channel, patch, label) => {
    if (!Object.keys(patch).length) { n.same += 1; return channel; }
    const done = await attempt(r, `update ${label}`, () => api('PATCH', `/channels/${channel.id}`, { body: patch }));
    if (done === FAIL) return channel;
    n.updated += 1;
    r.log(`~ ${label}: ${Object.keys(patch).join(', ')}`);
    const next = done && done.id ? done : { ...channel, ...patch };
    put(next);
    return next;
  };

  const placed = []; // [category, [children]] for ordering
  for (const [catIndex, cat] of LAYOUT.entries()) {
    const overwrites = overwritesFor(cat.access, who);
    let category = findChannel(channels, cat.name, T.CATEGORY);
    if (!category) {
      const made = await attempt(r, `create category ${cat.name}`, () => api('POST', `/guilds/${gid}/channels`, {
        body: { name: cat.name, type: T.CATEGORY, position: catIndex, permission_overwrites: overwrites },
      }));
      if (made === FAIL) continue; // its channels wait for the next run
      category = made; put(made); n.created += 1; r.log(`+ category ${cat.name}`);
    } else {
      const merged = mergeOverwrites(category.permission_overwrites, overwrites, managed, cat.access);
      category = await patchChannel(category, owKey(merged) === owKey(category.permission_overwrites) ? {} : { permission_overwrites: merged }, `category ${cat.name}`);
    }
    const children = [];
    for (const spec of cat.channels) {
      if (spec.type === T.FORUM && !community) { deferred.push(`#${spec.name}`); continue; }
      const wantType = spec.type === T.NEWS && !hasNews ? T.TEXT : spec.type;
      if (wantType !== spec.type) textForNow.push(`#${spec.name}`);
      let channel = findChannel(channels, spec.name, spec.type, category.id)
        ?? (spec.reuse ? findChannel(channels, spec.reuse, spec.type) : null);
      const label = spec.type === T.VOICE ? spec.name : `#${spec.name}`;
      if (!channel) {
        const body = { name: spec.name, type: wantType, parent_id: category.id, permission_overwrites: overwrites };
        if (spec.topic !== undefined) body.topic = spec.topic;
        if (spec.type === T.FORUM) {
          body.available_tags = mergeTags([], spec.tags);
          if (spec.reaction) body.default_reaction_emoji = { emoji_id: null, emoji_name: spec.reaction };
        }
        const made = await attempt(r, `create ${label}`, () => api('POST', `/guilds/${gid}/channels`, { body }));
        if (made === FAIL) continue;
        put(made); n.created += 1; r.log(`+ ${label}`);
        children.push(made);
        continue;
      }
      if (channel.type !== wantType && [T.TEXT, T.NEWS].includes(channel.type) && [T.TEXT, T.NEWS].includes(wantType)) {
        const done = await attempt(r, `convert ${label}`, () => api('PATCH', `/channels/${channel.id}`, { body: { type: wantType } }));
        if (done !== FAIL) {
          channel = done && done.id ? done : { ...channel, type: wantType };
          put(channel); n.updated += 1;
          r.log(`~ ${label}: ${wantType === T.NEWS ? 'now an announcement channel' : 'now a text channel'}`);
        }
      }
      const patch = {};
      if (norm(channel.name) !== norm(spec.name)) patch.name = spec.name;
      if (channel.parent_id !== category.id) patch.parent_id = category.id;
      if (spec.topic !== undefined && (channel.topic ?? '') !== spec.topic) patch.topic = spec.topic;
      const merged = mergeOverwrites(channel.permission_overwrites, overwrites, managed, cat.access);
      if (owKey(merged) !== owKey(channel.permission_overwrites)) patch.permission_overwrites = merged;
      if (spec.type === T.FORUM) {
        const tags = mergeTags(channel.available_tags, spec.tags);
        if (tags) patch.available_tags = tags;
        if (spec.reaction && (channel.default_reaction_emoji?.emoji_name ?? null) !== spec.reaction) {
          patch.default_reaction_emoji = { emoji_id: null, emoji_name: spec.reaction };
        }
      }
      children.push(await patchChannel(channel, patch, label));
    }
    placed.push([category, children]);
  }

  // Order: categories as in the layout, channels in each category as listed.
  const positions = [];
  const latest = (c) => channels.find((x) => x.id === c.id) ?? c;
  const catIds = placed.map(([category]) => category.id);
  const catNow = channels.filter((c) => c.type === T.CATEGORY && catIds.includes(c.id)).sort(byPosition).map((c) => c.id);
  if (!sameList(catNow, catIds)) catIds.forEach((id, position) => positions.push({ id, position }));
  for (const [category, children] of placed) {
    const want = children.map((c) => latest(c).id);
    const now = channels.filter((c) => c.parent_id === category.id && want.includes(c.id)).sort(byPosition).map((c) => c.id);
    if (!sameList(now, want)) want.forEach((id, position) => positions.push({ id, position }));
  }
  let orderNote = 'order unchanged';
  if (positions.length) {
    const done = await attempt(r, 'order channels', () => api('PATCH', `/guilds/${gid}/channels`, { body: positions }));
    if (done !== FAIL) orderNote = `order set for ${positions.length} channels`;
  }

  // Discord's default categories go once they are empty.
  const removed = [];
  const notes = [];
  for (const name of DEFAULT_CATEGORIES) {
    const cat = channels.find((c) => c.type === T.CATEGORY && norm(c.name) === norm(name));
    if (!cat) continue;
    if (channels.some((c) => c.parent_id === cat.id)) { notes.push(`left the "${name}" category: it still has channels`); continue; }
    const done = await attempt(r, `delete the empty "${name}" category`, () => api('DELETE', `/channels/${cat.id}`));
    if (done !== FAIL) removed.push(name);
  }

  if (removed.length) notes.push(`removed empty ${removed.join(' and ')}`);
  if (deferred.length) notes.push(`${deferred.join(' and ')} wait for Community (the News and forum channels step creates them)`);
  if (textForNow.length) notes.push(`${textForNow.join(' and ')} are text channels until Community is on`);
  r.notice([`channels: ${n.created} created, ${n.updated} updated, ${n.same} unchanged`, orderNote, ...notes].join('; '));
}

// The channels phase again, once Community is on. With Community off it would only redo the
// channels step, so it fails instead of passing green with nothing done.
async function phaseNewsForums(r, ctx) {
  if (!ctx.guild.features.includes('COMMUNITY')) {
    r.error('Community is off: announcement channels and forums cannot be made until the Community step succeeds');
    return;
  }
  await phaseChannels(r, ctx);
}

async function phaseCommunity(r, ctx) {
  const { gid, guild, channels } = ctx;
  const rules = channelByName(channels, 'rules');
  const modLog = channelByName(channels, 'mod-log');
  const body = {};
  if (guild.verification_level !== VERIFICATION_MEDIUM) body.verification_level = VERIFICATION_MEDIUM;
  if (guild.explicit_content_filter !== FILTER_ALL_MEMBERS) body.explicit_content_filter = FILTER_ALL_MEMBERS;
  if (guild.default_message_notifications !== NOTIFY_ONLY_MENTIONS) body.default_message_notifications = NOTIFY_ONLY_MENTIONS;
  if (rules && guild.rules_channel_id !== rules.id) body.rules_channel_id = rules.id;
  if (modLog && guild.public_updates_channel_id !== modLog.id) body.public_updates_channel_id = modLog.id;
  const enabling = !guild.features.includes('COMMUNITY');
  if (enabling) {
    if (!rules || !modLog) {
      r.error(`Community needs #rules and #mod-log, missing: ${[!rules && '#rules', !modLog && '#mod-log'].filter(Boolean).join(', ')}. Run the channels step first`);
      return;
    }
    // Discord refuses COMMUNITY (403, code 40006) unless both ids are in the same request, even
    // when the server already has them set.
    body.rules_channel_id = rules.id;
    body.public_updates_channel_id = modLog.id;
    body.features = [...new Set([...guild.features, 'COMMUNITY'])];
  }
  if (!Object.keys(body).length) { r.notice('Community already on with #rules and #mod-log, medium verification, full content filter'); return; }
  const done = await attempt(r, enabling ? 'enable Community' : 'update Community settings', () => api('PATCH', `/guilds/${gid}`, { body }));
  if (done === FAIL) return;
  r.notice(enabling
    ? 'Community on: rules #rules, updates #mod-log, verification medium, content filter all members, notifications mentions only'
    : `Community settings updated: ${Object.keys(body).join(', ')}`);
}

async function phaseOnboarding(r, ctx) {
  const { gid, guild, channels } = ctx;
  if (!guild.features.includes('COMMUNITY')) { r.error('onboarding needs Community: the Community step has not succeeded yet'); return; }
  const ids = roleIds(ctx.roles);
  const missing = ['rifter', 'newsPing', 'patchPing', 'eventPing'].filter((key) => !ids[key]);
  if (missing.length) { r.error(`onboarding roles missing (${missing.join(', ')}): run the Roles step first`); return; }
  const current = await api('GET', `/guilds/${gid}/onboarding`);

  const defaults = [];
  for (const cat of LAYOUT) {
    if (!PUBLIC_ACCESS.has(cat.access)) continue;
    for (const spec of cat.channels) {
      const channel = findChannel(channels, spec.name, spec.type);
      if (channel) defaults.push(channel.id);
    }
  }
  const desiredPrompts = [
    // Optional (the owner's choice): Discord posts the join message only once a member finishes the
    // onboarding questions, so a required question left new members stuck without a welcome.
    { title: 'Read the rules?', single_select: true, required: false, options: [
      { title: "I've read #rules", description: 'Be kind, keep it safe, and keep spoilers in #secret-hunt.', emoji: '✅', role_ids: [ids.rifter] },
    ] },
    { title: 'What should we ping you about?', single_select: false, required: false, options: [
      { title: 'News pings', description: 'Big announcements', emoji: '📣', role_ids: [ids.newsPing] },
      { title: 'Patch pings', description: 'New updates and patch notes', emoji: '🔧', role_ids: [ids.patchPing] },
      { title: 'Event pings', description: 'Events, challenges and community nights', emoji: '🎉', role_ids: [ids.eventPing] },
    ] },
    // "How do you play?" (PC / Phone / Controller) is left out: Discord needs every option to give a
    // role or a channel, and there are no per-platform roles or channels for it to give.
  ];
  const oldPrompts = current?.prompts ?? [];
  const prompts = desiredPrompts.map((want) => {
    const old = oldPrompts.find((p) => p.title === want.title);
    return {
      id: old?.id ?? newSnowflake(), type: 0, title: want.title, single_select: want.single_select,
      required: want.required, in_onboarding: true,
      options: want.options.map((option) => {
        const oldOption = old?.options?.find((o) => o.title === option.title);
        return { id: oldOption?.id ?? newSnowflake(), title: option.title, description: option.description,
          emoji_name: option.emoji, role_ids: option.role_ids, channel_ids: [] };
      }),
    };
  });

  const promptKey = (list) => JSON.stringify((list ?? []).map((p) => [p.title, Boolean(p.single_select), Boolean(p.required),
    p.in_onboarding !== false, (p.options ?? []).map((o) => [o.title, o.description ?? '', o.emoji?.name ?? o.emoji_name ?? null,
      sortedJson(o.role_ids), sortedJson(o.channel_ids)])]));
  const same = current && current.enabled === true && (current.mode ?? 0) === 0
    && sortedJson(current.default_channel_ids) === sortedJson(defaults)
    && promptKey(current.prompts) === promptKey(prompts);
  if (same) { r.notice(`onboarding already on: ${defaults.length} default channels, ${prompts.length} questions`); return; }
  const done = await attempt(r, 'save onboarding', () => api('PUT', `/guilds/${gid}/onboarding`, {
    body: { prompts, default_channel_ids: defaults, enabled: true, mode: 0 },
  }));
  if (done !== FAIL) r.notice(`onboarding on: ${defaults.length} default channels, questions "Read the rules?" (Rifter) and "What should we ping you about?"`);
}

async function phaseAutomod(r, ctx) {
  const { gid, channels } = ctx;
  const modLog = channelByName(channels, 'mod-log');
  if (!modLog) r.error('#mod-log not found: the mention spam alert has nowhere to go until the channels step succeeds');
  const existing = await api('GET', `/guilds/${gid}/auto-moderation/rules`);
  const n = { created: 0, updated: 0, same: 0, discord: [] };
  const actionsKey = (list) => (list ?? []).map((a) => `${a.type}:${a.metadata?.channel_id ?? ''}:${a.metadata?.custom_message ?? ''}`).sort().join('|');
  for (const want of automodRules(modLog?.id)) {
    const body = { ...want, enabled: true, exempt_roles: [], exempt_channels: [] };
    const found = existing.find((rule) => rule.trigger_type === want.trigger_type);
    if (!found) {
      const made = await attempt(r, `create AutoMod rule ${want.name}`, () => api('POST', `/guilds/${gid}/auto-moderation/rules`, { body }));
      if (made !== FAIL) { n.created += 1; r.log(`+ ${want.name}`); }
      continue;
    }
    const metaSame = Object.entries(want.trigger_metadata).every(([key, value]) => (Array.isArray(value)
      ? sortedJson(value) === sortedJson(found.trigger_metadata?.[key])
      : value === found.trigger_metadata?.[key]));
    const same = found.name === want.name && found.enabled === true && found.event_type === want.event_type && metaSame
      && actionsKey(found.actions) === actionsKey(want.actions)
      && sortedJson(found.exempt_roles) === '[]' && sortedJson(found.exempt_channels) === '[]';
    if (same) { n.same += 1; continue; }
    const { trigger_type: _ignored, ...patch } = body;
    try {
      await api('PATCH', `/guilds/${gid}/auto-moderation/rules/${found.id}`, { body: patch });
      n.updated += 1;
      r.log(`~ ${want.name}`);
    } catch (err) {
      // Discord makes its own "Block Mention Spam" rule on some servers (creator: the AutoMod system
      // user). Bots can read it but PATCH answers 404, and a server holds only one mention spam rule,
      // so it cannot be replaced either: leave it as Discord made it and say how to change it by hand.
      if (err?.status !== 404 || !found.creator_id || found.creator_id === ctx.me.id) {
        r.error(`update AutoMod rule ${want.name}: ${describe(err)}`);
        continue;
      }
      n.discord.push(found);
    }
  }
  const kept = n.discord.map((rule) => {
    const meta = rule.trigger_metadata ?? {};
    const limit = meta.mention_total_limit ? `, limit ${meta.mention_total_limit}` : '';
    const raid = meta.mention_raid_protection_enabled === undefined ? '' : `, raid protection ${meta.mention_raid_protection_enabled ? 'on' : 'off'}`;
    const alerts = (rule.actions ?? []).some((a) => a.type === 2) ? ', alerts on' : ', no alert channel';
    return `Discord's own "${rule.name}" rule is ${rule.enabled ? 'on' : 'off'}${limit}${raid}${alerts}. Bots cannot change it, so it was left as it is (to send its alerts to #mod-log: Server Settings > AutoMod > ${rule.name})`;
  });
  const managed = n.discord.length ? 'words preset and spam' : 'words preset, spam, mention spam 6 + raid protection with alerts in #mod-log';
  r.notice(`AutoMod: ${n.created} created, ${n.updated} updated, ${n.same} unchanged (${managed})${kept.length ? `. ${kept.join('. ')}` : ''}`);
}

async function phaseSettings(r, ctx) {
  const { gid, guild, channels } = ctx;
  const general = channelByName(channels, 'general');
  const modLog = channelByName(channels, 'mod-log');
  const body = {};
  if (guild.verification_level !== VERIFICATION_MEDIUM) body.verification_level = VERIFICATION_MEDIUM;
  if (guild.explicit_content_filter !== FILTER_ALL_MEMBERS) body.explicit_content_filter = FILTER_ALL_MEMBERS;
  if (guild.default_message_notifications !== NOTIFY_ONLY_MENTIONS) body.default_message_notifications = NOTIFY_ONLY_MENTIONS;
  if (general && guild.system_channel_id !== general.id) body.system_channel_id = general.id;
  if (!general) r.error('#general not found: the system channel is left as it is');
  const flags = (Number(guild.system_channel_flags ?? 0) & ~SYS_SUPPRESS_JOIN) | SYS_SUPPRESS_BOOSTS | SYS_SUPPRESS_SETUP_TIPS;
  if (flags !== Number(guild.system_channel_flags ?? 0)) body.system_channel_flags = flags;
  if (guild.features.includes('COMMUNITY') && modLog && guild.safety_alerts_channel_id !== modLog.id) body.safety_alerts_channel_id = modLog.id;
  let settingsNote = 'server settings unchanged';
  if (Object.keys(body).length) {
    const done = await attempt(r, 'update server settings', () => api('PATCH', `/guilds/${gid}`, { body }));
    settingsNote = done === FAIL ? 'server settings not updated' : `server settings updated (${Object.keys(body).join(', ')})`;
  }
  // The icon goes on its own, so a rejected image never holds back the settings above.
  const iconNote = await iconStep(r, ctx);
  const joinNote = await joinReport(ctx, general, flags);
  r.notice(`${settingsNote}; ${iconNote}; ${joinNote}`);
}

// A server with no icon gets ICON_REVISION's. A server with one keeps it, unless this run was asked
// to replace it (replaceIcon, see resolveReplaceIcon): then the same image is uploaded over it, with
// the revision in the audit log reason and old and new icon hash in the annotation. Discord never
// says which image an icon is, so "replace" always uploads: that is why it is never the default.
async function iconStep(r, ctx) {
  const { gid, guild } = ctx;
  const had = guild.icon || null;
  if (had && !replaceIcon) return 'icon already set (left as it is)';
  let image = null;
  try {
    image = `data:image/png;base64,${(await readFile(ICON_FILE)).toString('base64')}`;
  } catch (err) {
    r.error(`could not read the icon file scripts/discord-assets/${ICON.file}: ${err.code || err.message}`);
  }
  if (!image) return had ? 'icon not replaced (the icon file is unreadable, the current icon is kept)' : 'icon not set';
  const what = `${ICON.label} (revision ${ICON_REVISION}, ${ICON.file})`;
  if (!had) {
    const done = await attempt(r, 'set server icon', () => api('PATCH', `/guilds/${gid}`, { body: { icon: image } }));
    return done === FAIL ? 'icon not set' : `icon set to ${what}${replaceIcon ? ' (replace was requested, the server had no icon)' : ''}`;
  }
  const reason = `${AUDIT_REASON}: replace server icon with revision ${ICON_REVISION} (${ICON.file})`;
  const done = await attempt(r, 'replace server icon', () => api('PATCH', `/guilds/${gid}`, { body: { icon: image }, reason }));
  if (done === FAIL) return 'icon not replaced (the current icon is kept)';
  const now = done?.icon || null;
  if (now && now === had) return `icon replace requested: Discord already had this image, nothing changed (${what}, hash ${had})`;
  return `icon replaced with ${what}: was hash ${had}, now ${now ? `https://cdn.discordapp.com/icons/${gid}/${now}.png` : 'a new hash (Discord did not return it)'}`;
}

// Join messages ("Glad you're here, ...") go to the system channel, and Discord posts one only when
// a new member is fully in: with Onboarding on, once they finish its questions. Counts only, never
// names or ids: these annotations are public.
const MEMBER_COMPLETED_ONBOARDING = 2, MEMBER_STARTED_ONBOARDING = 8;
async function joinReport(ctx, general, flags) {
  if (!general) return 'join messages: no #general';
  const parts = [`join messages ${flags & SYS_SUPPRESS_JOIN ? 'off' : 'on'} in #general`];
  let joins = null;
  try {
    const recent = await api('GET', `/channels/${general.id}/messages`, { query: { limit: '100' } });
    joins = recent.filter((m) => m.type === 7);
    parts[0] += ` (${joins.length} in its last ${recent.length} messages)`;
  } catch (err) {
    parts[0] += ` (recent messages unreadable: ${describe(err)})`;
  }
  try {
    const members = (await api('GET', `/guilds/${ctx.gid}/members`, { query: { limit: '1000' } }))
      .filter((m) => !m.user?.bot && m.user?.id !== ctx.me.id);
    const onboarding = (m) => (m.flags & MEMBER_COMPLETED_ONBOARDING ? 'finished' : m.flags & MEMBER_STARTED_ONBOARDING ? 'answering' : 'before');
    const count = (state) => members.filter((m) => onboarding(m) === state).length;
    parts.push(`${members.length} ${members.length === 1 ? 'person' : 'people'}: ${count('finished')} finished onboarding, ${count('answering')} still answering its questions, ${count('before')} joined without it`);
    const newest = [...members].sort((a, b) => String(b.joined_at ?? '').localeCompare(String(a.joined_at ?? '')))[0];
    if (newest) {
      const state = { finished: 'finished onboarding', answering: 'still answering the onboarding questions', before: 'joined without onboarding' }[onboarding(newest)];
      const posted = joins?.some((m) => m.author?.id === newest.user?.id);
      parts.push(`newest member ${state}, ${joins === null ? 'join message unknown' : posted ? 'join message posted' : 'no join message yet'}`);
    }
  } catch (err) {
    parts.push(`member onboarding states unreadable (${describe(err)}): turn on Server Members Intent under Bot in the Discord Developer Portal to see them`);
  }
  return parts.join('; ');
}

// {#name} becomes a real channel mention; missing lists the names that have no channel yet.
function linkChannels(text, channels) {
  const missing = [];
  const content = text.replace(/\{#([a-z0-9-]+)\}/g, (_, name) => {
    const target = channelByName(channels, name);
    if (!target) { missing.push(name); return `#${name}`; }
    return `<#${target.id}>`;
  });
  return { content, missing };
}

async function phasePosts(r, ctx) {
  const { gid, me, channels } = ctx;
  const n = { posted: 0, skipped: 0 };
  let activeThreads = null;
  for (const post of POSTS) {
    const channel = channelByName(channels, post.channel);
    if (!channel) { r.error(`#${post.channel} not found: its post waits for the channels steps`); continue; }
    const { content, missing } = linkChannels(post.content, channels);
    if (missing.length) { r.error(`#${post.channel} post held back: it links #${missing.join(', #')}, which does not exist yet`); continue; }
    if (content.length > 2000) { r.error(`#${post.channel} post is ${content.length} characters (Discord allows 2000)`); continue; }
    const message = { content, allowed_mentions: { parse: [] }, ...(post.embeds ? {} : { flags: SUPPRESS_EMBEDS }) };

    if (post.thread) {
      if (activeThreads === null) {
        const got = await attempt(r, 'list active threads', () => api('GET', `/guilds/${gid}/threads/active`));
        if (got === FAIL) continue;
        activeThreads = got?.threads ?? [];
      }
      const isMine = (t) => t.parent_id === channel.id && t.owner_id === me.id && norm(t.name) === norm(post.thread);
      let mine = activeThreads.find(isMine);
      // Archived posts come newest first, 100 a page: page back until the bot's post turns up.
      let before = null;
      for (let page = 0; !mine && page < 50; page += 1) {
        const query = { limit: '100', ...(before ? { before } : {}) };
        const archived = await attempt(r, `list archived posts in #${post.channel}`, () => api('GET', `/channels/${channel.id}/threads/archived/public`, { query }));
        if (archived === FAIL) { mine = FAIL; break; }
        const threads = archived?.threads ?? [];
        mine = threads.find(isMine);
        before = threads.at(-1)?.thread_metadata?.archive_timestamp;
        if (!archived?.has_more || !before) break;
      }
      if (mine === FAIL) continue;
      if (mine) {
        n.skipped += 1;
        if (!mine.thread_metadata?.archived && !((mine.flags ?? 0) & THREAD_PINNED)) {
          await attempt(r, `pin "${post.thread}"`, () => api('PATCH', `/channels/${mine.id}`, { body: { flags: (mine.flags ?? 0) | THREAD_PINNED, locked: true } }));
        }
        continue;
      }
      const thread = await attempt(r, `post "${post.thread}" in #${post.channel}`, () => api('POST', `/channels/${channel.id}/threads`, { body: { name: post.thread, message } }));
      if (thread === FAIL) continue;
      n.posted += 1; r.log(`+ "${post.thread}" in #${post.channel}`);
      await attempt(r, `pin "${post.thread}"`, () => api('PATCH', `/channels/${thread.id}`, { body: { flags: THREAD_PINNED, locked: true } }));
      continue;
    }

    // The bot posts right after it makes a channel, so its post is among the oldest messages; the
    // newest are read too, in case it posted after members had already started talking.
    const oldest = await attempt(r, `read #${post.channel}`, () => api('GET', `/channels/${channel.id}/messages`, { query: { after: '0', limit: '100' } }));
    if (oldest === FAIL) continue;
    const newest = (oldest ?? []).length < 100 ? [] // the oldest 100 were the whole channel
      : await attempt(r, `read #${post.channel}`, () => api('GET', `/channels/${channel.id}/messages`, { query: { limit: '100' } }));
    if (newest === FAIL) continue;
    if ([...(oldest ?? []), ...(newest ?? [])].some((m) => m.author?.id === me.id)) { n.skipped += 1; continue; }
    const sent = await attempt(r, `post in #${post.channel}`, () => api('POST', `/channels/${channel.id}/messages`, { body: message }));
    if (sent !== FAIL) { n.posted += 1; r.log(`+ post in #${post.channel}`); }
  }
  r.notice(`posts: ${n.posted} posted, ${n.skipped} already there`);
}

// ---------------------------------------------------------------------------------------------
// Release posts: the versions in scripts/discord-releases.mjs (its header says how to add one)

const RELEASES_FILE = 'scripts/discord-releases.mjs';
const RELEASE_FIELDS = ['version', 'posted', 'ping', 'announcement', 'patchNotes'];
// Where each text goes, the bold first line a version is recognised by, and the role its ping pings.
const RELEASE_CHANNELS = [
  { key: 'announcement', channel: 'announcements', marker: (v) => `**Riftborn ${v} ·`, ping: 'newsPing', embeds: true },
  { key: 'patchNotes', channel: 'patch-notes', marker: (v) => `**v${v} ·`, ping: 'patchPing', embeds: false },
];
const RELEASE_HISTORY_PAGES = 5; // the newest 500 messages of each channel are searched
const PUBLISH_MAX_WAIT = 60_000; // a longer publish rate limit is left to the next run
const LINK_LENGTH = 23, PING_LENGTH = 25; // "<#id>" and "<@&id>\n" once posted, ids up to 20 digits

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shortVersion = (version) => version.replace(/\.0$/, ''); // 2.3.0 -> 2.3, 2.3.1 stays
const markerOf = (spec, version) => spec.marker(shortVersion(version));
const newerVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
};
const withoutPing = (content) => String(content ?? '').replace(/^(?:\s*<@&\d+>)+\s*/, '');
const roleName = (key) => ROLES.find((spec) => spec.key === key).name;
const isPlaceholder = (rel) => rel.announcement == null && rel.patchNotes == null;
// The channels a release text may link: the public ones (release posts reach following servers too).
const RELEASE_LINKABLE = new Set(LAYOUT.filter((cat) => PUBLIC_ACCESS.has(cat.access)).flatMap((cat) => cat.channels.map((c) => c.name)));
const listOf = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// Everything wrong with the release list, checked before anything is read or posted.
function checkReleases(list) {
  if (!Array.isArray(list)) return ['it must export RELEASES, a list'];
  const problems = [];
  let previous = null;
  let unposted = false;
  list.forEach((rel, n) => {
    if (!rel || typeof rel !== 'object' || Array.isArray(rel)) { problems.push(`entry ${n + 1} is not an entry`); return; }
    const at = typeof rel.version === 'string' ? rel.version : `entry ${n + 1}`;
    const unknown = Object.keys(rel).filter((key) => !RELEASE_FIELDS.includes(key));
    if (unknown.length) problems.push(`${at}: unknown ${unknown.length === 1 ? 'field' : 'fields'} ${unknown.join(', ')} (the fields are ${RELEASE_FIELDS.join(', ')})`);
    if (typeof rel.version !== 'string' || !VERSION_RE.test(rel.version)) { problems.push(`${at}: version must be MAJOR.MINOR.PATCH, like 2.3.0`); return; }
    if (previous && !newerVersion(rel.version, previous)) problems.push(`${at} must be newer than ${previous} above it (oldest first, each version once)`);
    previous = rel.version;
    if (rel.posted !== undefined && typeof rel.posted !== 'boolean') problems.push(`${at}: posted must be true or false`);
    const ping = rel.ping ?? {};
    if (typeof ping !== 'object' || Array.isArray(ping)) {
      problems.push(`${at}: ping must be { announcement: true or false, patchNotes: true or false }`);
    } else {
      for (const [key, value] of Object.entries(ping)) {
        if (!RELEASE_CHANNELS.some((spec) => spec.key === key)) problems.push(`${at}: unknown ping ${key} (use announcement and patchNotes)`);
        else if (typeof value !== 'boolean') problems.push(`${at}: ping.${key} must be true or false`);
      }
    }
    const filled = RELEASE_CHANNELS.filter((spec) => rel[spec.key] != null).length;
    if (filled === 1) problems.push(`${at}: fill in both announcement and patchNotes (or leave both null for a placeholder)`);
    if (rel.posted && filled < 2) problems.push(`${at}: an entry marked posted needs both texts, which are how it is recognised`);
    if (rel.posted && unposted) problems.push(`${at}: entries marked posted come before all the others`);
    if (!rel.posted) unposted = true;
    for (const spec of RELEASE_CHANNELS) {
      const text = rel[spec.key];
      if (text == null) continue;
      if (typeof text !== 'string' || !text.trim()) { problems.push(`${at}: ${spec.key} must be text (or null)`); continue; }
      const marker = markerOf(spec, rel.version);
      if (!text.startsWith(`${marker} `)) problems.push(`${at}: ${spec.key} must start with "${marker} " (the first line RiftBot recognises it by)`);
      const badLinks = [...new Set([...text.matchAll(/\{#([^}]*)\}/g)].map((m) => m[1]).filter((name) => !RELEASE_LINKABLE.has(name)))];
      if (badLinks.length) problems.push(`${at}: ${spec.key} links {#${badLinks.join('}, {#')}}, which is not a public channel (like {#patch-notes})`);
      if (/@everyone|@here|<@/.test(text)) problems.push(`${at}: ${spec.key} must not mention anyone (@everyone, @here or <@...>): pings are set with ping`);
      const length = text.replace(/\{#[a-z0-9-]+\}/g, 'x'.repeat(LINK_LENGTH)).length + (ping?.[spec.key] === true ? PING_LENGTH : 0);
      if (length > 2000) problems.push(`${at}: ${spec.key} is about ${length} characters once posted (Discord allows 2000)`);
    }
  });
  return problems;
}

// A channel's newest messages, newest first: up to `pages` pages of 100, and whether that was all.
async function readHistory(channelId, pages) {
  const messages = [];
  let before = null;
  for (let page = 0; page < pages; page += 1) {
    const got = await api('GET', `/channels/${channelId}/messages`, { query: { limit: '100', ...(before ? { before } : {}) } });
    const batch = Array.isArray(got) ? got : [];
    messages.push(...batch);
    if (batch.length < 100) return { messages, complete: true };
    before = batch.reduce((oldest, m) => (idCmp(m.id, oldest) < 0 ? m.id : oldest), batch[0].id);
  }
  return { messages, complete: false };
}

// Publishes (crossposts) a message in an announcement channel, so servers following it get a copy.
async function publish(r, channel, message, what) {
  try {
    await api('POST', `/channels/${channel.id}/messages/${message.id}/crosspost`, { maxWait: PUBLISH_MAX_WAIT });
    return 'done';
  } catch (err) {
    if (err?.code === ALREADY_CROSSPOSTED) return 'done';
    r.error(`crosspost ${what}: ${describe(err)} (the next run crossposts it)`);
    return 'failed';
  }
}

// A version's two messages, ready to send, or what stops them (problems).
function buildRelease(rel, channels, ids) {
  const messages = {};
  const problems = [];
  for (const spec of RELEASE_CHANNELS) {
    const label = `its #${spec.channel} post`;
    const roleId = rel.ping?.[spec.key] ? ids[spec.ping] : null;
    if (rel.ping?.[spec.key] && !roleId) { problems.push(`${label} pings ${roleName(spec.ping)}, and that role is missing (the Roles step makes it)`); continue; }
    const { content: linked, missing } = linkChannels(rel[spec.key], channels);
    if (missing.length) { problems.push(`${label} links #${missing.join(', #')}, which does not exist yet`); continue; }
    const content = roleId ? `<@&${roleId}>\n${linked}` : linked;
    if (content.length > 2000) { problems.push(`${label} is ${content.length} characters (Discord allows 2000)`); continue; }
    // The ping can reach its one role and nobody else; announcements keep the riftborn.us card.
    const body = { content, allowed_mentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] }, ...(spec.embeds ? {} : { flags: SUPPRESS_EMBEDS }) };
    messages[spec.key] = { body, pinged: roleId ? roleName(spec.ping) : null };
  }
  return { messages, problems };
}

// The live gate: a version is posted only once riftborn.us serves it (or a newer one), as its
// version.json says (the file the game polls for updates; never cached, and asked with a
// cache-busting query anyway). So a version's entry goes to main in the same push as live/: that
// push's run usually still finds the old version live and leaves the new one waiting, and the run
// after the Pages deploy (the workflow's workflow_run trigger) posts it. The host is the live origin of
// site.config.mjs (its RIFTBORN_TEST_LIVE_ORIGIN points the tests at the fake and is refused in CI).
// Asked at most once per run, only when a version is about to be posted (a run with nothing new asks
// nothing), and never with the bot token or through a redirect (a 3xx is an answer without a
// version, as cloudflare-pages-verify.mjs treats it). A site that cannot be reached holds new versions
// back with a warning (the step stays green), for the next run to post; an answer without a
// MAJOR.MINOR.PATCH version is an error.
const LIVE_TIMEOUT = 10_000;
const LIVE_RETRY_WAITS = [2000, 5000, 10_000]; // before the 2nd, 3rd and 4th tries: about 17 s in all
const LIVE_TRIES = LIVE_RETRY_WAITS.length + 1;

// { host, version }, { host, unreachable }, or { failed } once the error is reported.
async function readLive(r) {
  let origin;
  try {
    const { resolveSiteConfig } = await import(new URL('../site.config.mjs', import.meta.url).href);
    origin = resolveSiteConfig(process.env).live;
  } catch (err) {
    r.error(`the live site could not be read from site.config.mjs (${describe(err)}): nothing new posted`);
    return { failed: true };
  }
  const url = `${origin}/version.json`;
  const host = new URL(origin).host;
  let why = '';
  for (let tryNo = 1; tryNo <= LIVE_TRIES; tryNo += 1) {
    if (tryNo > 1) await sleep(LIVE_RETRY_WAITS[tryNo - 2]);
    let status, text;
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(LIVE_TIMEOUT) });
      status = res.status;
      text = await res.text();
    } catch (err) {
      why = `network error (${err?.cause?.code || err?.name || 'fetch failed'})`;
      continue;
    }
    if (status >= 500 || status === 429) { why = `HTTP ${status}`; continue; }
    if (status !== 200) { r.error(`${url} answered HTTP ${status}, not its version: nothing new posted`); return { failed: true }; }
    let version;
    try { version = JSON.parse(text)?.version; } catch { version = undefined; }
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      r.error(`${url} answered without a MAJOR.MINOR.PATCH version (${JSON.stringify(text.trim().slice(0, 60))}): nothing new posted`);
      return { failed: true };
    }
    r.log(`${url} serves ${version}`);
    return { host, version };
  }
  r.log(`${url} could not be read: ${why} after ${LIVE_TRIES} tries`);
  return { host, unreachable: `${why}, ${LIVE_TRIES} tries` };
}

// Why the live gate holds a version back (null when it may go out), from readLive's answer.
function liveHold(rel, live) {
  if (live.failed) return { status: 'failed' };
  if (live.unreachable) return { status: 'unverified', host: live.host, why: live.unreachable };
  if (newerVersion(rel.version, live.version)) return { status: 'unreleased', host: live.host, live: live.version };
  return null;
}

// Each version once, oldest first, up to the first placeholder and only once riftborn.us serves it
// (the live gate, above): its announcement in #announcements and its patch notes in #patch-notes,
// each skipped when RiftBot's post of that version is already in the channel (found by its bold
// first line), then crossposted. Entries marked posted are only recognised. In each channel a
// version that could not be posted holds back the ones after it, and a version older than one
// already there is never posted, so the channels always read in order.
async function phaseReleases(r, ctx) {
  const { channels, me } = ctx;
  let releases;
  try {
    ({ RELEASES: releases } = await import(new URL('./discord-releases.mjs', import.meta.url).href));
  } catch (err) {
    r.error(`${RELEASES_FILE} could not be loaded: ${describe(err)}`);
    return;
  }
  const problems = checkReleases(releases);
  if (problems.length) {
    for (const problem of problems) r.error(`${RELEASES_FILE}: ${problem}`);
    r.notice(`releases: nothing posted until ${RELEASES_FILE} is fixed`);
    return;
  }
  if (!releases.length) { r.notice('releases: none listed'); return; }
  const block = releases.findIndex(isPlaceholder);
  const due = block < 0 ? releases : releases.slice(0, block);
  const ids = roleIds(ctx.roles);
  // Both of a version's messages are built before anything is posted, so a missing ping role or
  // linked channel holds the version back in both channels instead of letting one of them go out.
  const built = due.map((rel) => (rel.posted ? null : buildRelease(rel, channels, ids)));
  const reported = new Set();
  const results = due.map(() => []);
  let live = null; // what riftborn.us serves, read once the first version is about to be posted
  for (const spec of due.length ? RELEASE_CHANNELS : []) {
    const label = `#${spec.channel}`;
    const mark = (i, status, extra = {}) => results[i].push({ label, status, ...extra });
    const channel = channelByName(channels, spec.channel);
    if (!channel) { r.error(`${label} not found: release posts wait for the channels steps`); due.forEach((_, i) => mark(i, 'failed')); continue; }
    const history = await attempt(r, `read ${label}`, () => readHistory(channel.id, RELEASE_HISTORY_PAGES));
    if (history === FAIL) { due.forEach((_, i) => mark(i, 'failed')); continue; }
    const mine = history.messages.filter((m) => m.author?.id === me.id);
    const found = releases.map((rel) => mine.find((m) => withoutPing(m.content).startsWith(markerOf(spec, rel.version))) ?? null);
    // Anything posted after the newest version found is newer still, so it is in the history read.
    const newest = found.reduce((last, m, i) => (m ? i : last), -1);
    const isNews = channel.type === T.NEWS;
    let stopped = false;
    let gated = null; // the live gate held a version back here: the later ones wait for the same reason
    for (const [i, rel] of due.entries()) {
      const what = `${rel.version} in ${label}`;
      if (found[i]) {
        // The newest version here, posted by an earlier run that could not crosspost it: crosspost it
        // now. An older one is left alone, so following servers never get stale news ahead of new.
        const unpublished = isNews && i === newest && !rel.posted && !((found[i].flags ?? 0) & CROSSPOSTED);
        mark(i, 'there', unpublished ? { crosspost: await publish(r, channel, found[i], what) } : {});
        continue;
      }
      if (rel.posted) { mark(i, 'marked', { complete: history.complete }); continue; }
      if (i < newest) { mark(i, 'older', { newer: releases[newest].version }); continue; }
      if (gated) { mark(i, gated.status, gated); continue; }
      if (stopped) { mark(i, 'held'); continue; }
      stopped = true; // until this version is posted, the ones after it wait
      if (newest < 0 && !history.complete) {
        r.error(`${rel.version} not posted to ${label}: none of its last ${history.messages.length} messages is a release post, and an older one may be further up (check the channel by hand)`);
        mark(i, 'failed');
        continue;
      }
      const { messages, problems: blockers } = built[i];
      if (blockers.length) {
        if (!reported.has(i)) { reported.add(i); for (const blocker of blockers) r.error(`${rel.version} not posted: ${blocker}`); }
        mark(i, 'failed');
        continue;
      }
      // Last, just before posting: is this version live on riftborn.us yet?
      live ??= await readLive(r);
      const hold = liveHold(rel, live);
      if (hold) {
        if (hold.status !== 'failed') gated = hold;
        mark(i, hold.status, hold);
        continue;
      }
      const { body, pinged } = messages[spec.key];
      const sent = await attempt(r, `post ${what}`, () => api('POST', `/channels/${channel.id}/messages`, { body }));
      if (sent === FAIL) { mark(i, 'failed'); continue; }
      stopped = false;
      r.log(`+ ${what}`);
      mark(i, 'posted', { crosspost: isNews ? await publish(r, channel, sent, what) : 'n/a', pinged });
    }
  }
  // riftborn.us could not be read: the step stays green, but its summary is a warning, so a release
  // left waiting for the next run stands out.
  const unread = results.some((list) => list.some((x) => x.status === 'unverified'));
  r[unread ? 'warn' : 'notice'](`releases: ${releaseSummary(releases, due, results, block)}`);
}

function releaseSummary(releases, due, results, block) {
  const parts = [];
  const quiet = []; // versions already in every channel, with nothing done this run
  const held = []; // versions the live gate held back in every channel, for the same reason
  let hold = null;
  const flush = () => {
    if (quiet.length) parts.push(`${listOf(quiet.splice(0))} already posted`);
    if (held.length) parts.push(liveNote(held.splice(0), hold));
  };
  due.forEach((rel, i) => {
    const list = results[i];
    if (list.length && list.every((x) => x.status === 'there' && !x.crosspost)) {
      if (held.length) flush();
      quiet.push(rel.version);
      return;
    }
    if (list.length && ['unreleased', 'unverified'].includes(list[0].status) && list.every((x) => x.status === list[0].status)) {
      if (quiet.length || (held.length && hold.status !== list[0].status)) flush();
      hold = list[0];
      held.push(rel.version);
      return;
    }
    flush();
    parts.push(`${rel.version} ${releaseNote(list)}`);
  });
  flush();
  if (block >= 0) {
    const waiting = releases[block].version;
    parts.push(`${waiting} waits for its texts (a placeholder in ${RELEASES_FILE})`);
    const later = releases.slice(block + 1).map((rel) => rel.version);
    if (later.length) parts.push(`${listOf(later)} ${later.length === 1 ? 'waits' : 'wait'} for ${waiting}`);
  }
  return parts.join('; ');
}

// "2.4.0 waits for riftborn.us to serve it (live is 2.3.0)", or why riftborn.us could not say.
function liveNote(versions, hold) {
  const [verb, them] = versions.length === 1 ? ['waits', 'it'] : ['wait', 'them'];
  if (hold.status === 'unreleased') return `${listOf(versions)} ${verb} for ${hold.host} to serve ${them} (live is ${hold.live})`;
  return `${listOf(versions)} ${verb}: ${hold.host}/version.json could not be read (${hold.why}), so nothing new was posted; `
    + `the next run checks again (the next deploy of main, or Run workflow by hand)`;
}

function releaseNote(list) {
  const labels = (items) => listOf(items.map((x) => x.label));
  const where = (status) => list.filter((x) => x.status === status);
  const notes = [];
  const posted = where('posted');
  if (posted.length) {
    const crossed = posted.filter((x) => x.crosspost === 'done');
    const plain = posted.filter((x) => x.crosspost === 'n/a');
    const details = [crossed.length === posted.length ? 'crossposted' : crossed.length ? `crossposted in ${labels(crossed)} only` : 'not crossposted'];
    if (plain.length) details.push(`${labels(plain)} ${plain.length === 1 ? 'is not an announcement channel' : 'are not announcement channels'}`);
    const pinged = posted.filter((x) => x.pinged).map((x) => x.pinged);
    details.push(pinged.length ? `pinged ${listOf(pinged)}` : 'no pings');
    notes.push(`posted to ${labels(posted)} (${details.join(', ')})`);
  }
  const there = where('there');
  if (there.length) {
    const now = there.filter((x) => x.crosspost === 'done');
    const still = there.filter((x) => x.crosspost === 'failed');
    notes.push(`already in ${labels(there)}${now.length ? `, crossposted now in ${labels(now)}` : ''}${still.length ? `, still not crossposted in ${labels(still)}` : ''}`);
  }
  const marked = where('marked');
  if (marked.length) notes.push(`marked as posted but not found in ${marked.every((x) => x.complete) ? '' : 'the recent messages of '}${labels(marked)} (never sent again)`);
  const older = where('older');
  if (older.length) notes.push(`not posted to ${labels(older)}, where the newer ${listOf([...new Set(older.map((x) => x.newer))])} is already up (versions go out in order)`);
  const failed = where('failed');
  if (failed.length) notes.push(`not posted to ${labels(failed)} (see the errors)`);
  const held = where('held');
  if (held.length) notes.push(`held back in ${labels(held)} until the version before it is posted`);
  const unreleased = where('unreleased');
  if (unreleased.length) notes.push(`waits in ${labels(unreleased)} for ${unreleased[0].host} to serve it (live is ${unreleased[0].live})`);
  const unverified = where('unverified');
  if (unverified.length) notes.push(`waits in ${labels(unverified)}: ${unverified[0].host}/version.json could not be read (${unverified[0].why})`);
  return notes.join(', ');
}

async function phaseProfile(r, ctx) {
  if (ctx.me.username === BOT_NAME) { r.notice(`bot username already ${BOT_NAME}`); return; }
  const done = await attempt(r, `rename the bot to ${BOT_NAME}`, () => api('PATCH', '/users/@me', { body: { username: BOT_NAME } }));
  if (done !== FAIL) r.notice(`bot username set to ${BOT_NAME}`);
}

// A permanent invite to #welcome for the game's DISCORD button: reuse the bot's own permanent
// invite if there is one, else create it. Invite codes are public, so the link goes in the notice.
async function phaseInvite(r, ctx) {
  const { gid, channels, me } = ctx;
  const welcome = channels.find((c) => c.type === 0 && c.name === 'welcome');
  if (!welcome) { r.error('#welcome not found: run the channels step first'); return; }
  const invites = await attempt(r, 'list invites', () => api('GET', `/guilds/${gid}/invites`));
  if (invites === FAIL) return;
  let invite = (Array.isArray(invites) ? invites : []).find((i) => i?.inviter?.id === me.id && i?.channel?.id === welcome.id && !i.max_age && !i.max_uses && !i.temporary);
  if (!invite) {
    invite = await attempt(r, 'create the permanent invite', () => api('POST', `/channels/${welcome.id}/invites`, { body: { max_age: 0, max_uses: 0, temporary: false, unique: false } }));
    if (invite === FAIL) return;
  }
  if (!invite?.code) { r.error('Discord returned no invite code'); return; }
  r.notice(`permanent invite: https://discord.gg/${invite.code}`);
}

const PHASES = {
  discover: ['Discover guild', phaseDiscover],
  roles: ['Roles', phaseRoles],
  channels: ['Categories and channels', phaseChannels],
  community: ['Community', phaseCommunity],
  'news-forums': ['News and forum channels', phaseNewsForums],
  onboarding: ['Onboarding', phaseOnboarding],
  automod: ['AutoMod', phaseAutomod],
  settings: ['Server settings and icon', phaseSettings],
  posts: ['Posts', phasePosts],
  releases: ['Release posts', phaseReleases],
  profile: ['Bot profile', phaseProfile],
  invite: ['Invite link', phaseInvite],
};

// ---------------------------------------------------------------------------------------------
// Entry

const inCI = () => ['CI', 'GITHUB_ACTIONS'].some((key) => { const v = (process.env[key] || '').toLowerCase(); return v && v !== 'false' && v !== '0'; });

// DISCORD_SETUP_REPLACE_ICON: only "true" or "1" turn it on; empty, "false" and "0" are off, anything
// else is an error. In GitHub Actions only a manual run (workflow_dispatch) may replace the icon, so
// a push can never do it, whatever the workflow file passes in. Checked before any request is sent.
// Returns true, false, or null when the run must stop.
function resolveReplaceIcon(r) {
  const value = (process.env.DISCORD_SETUP_REPLACE_ICON || '').trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value !== 'true' && value !== '1') {
    r.error('DISCORD_SETUP_REPLACE_ICON must be "true" or "1" (or empty): the icon was not touched');
    return null;
  }
  const event = process.env.GITHUB_EVENT_NAME || '';
  if (inCI() && event !== 'workflow_dispatch') {
    r.error(`the server icon is replaced only by a manual run of the workflow (workflow_dispatch with "replace_icon" ticked), not by ${event ? `"${event}"` : 'an unknown trigger'}: the icon was not touched`);
    return null;
  }
  return true;
}

function resolveApiBase(r) {
  const override = (process.env.DISCORD_SETUP_API_BASE || '').trim();
  if (!override) return DISCORD_API;
  if (inCI()) { r.error('DISCORD_SETUP_API_BASE is for local tests and is refused in CI'); return null; }
  let url;
  try { url = new URL(override); } catch { url = null; }
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    r.error('DISCORD_SETUP_API_BASE must be an http URL on a loopback address (127.0.0.1, localhost or [::1])');
    return null;
  }
  return override.replace(/\/+$/, '');
}

async function runPhase(name) {
  const [title, run] = PHASES[name];
  const r = makeReporter(title);
  console.log(`== ${title}`);
  const base = resolveApiBase(r);
  if (!base) return r.finish();
  apiBase = base;
  const replace = name === 'settings' ? resolveReplaceIcon(r) : false;
  if (replace === null) return r.finish();
  replaceIcon = replace;
  if (!TOKEN) { r.error('DISCORD_SETUP_BOT_TOKEN is not set'); return r.finish(); }
  if (/\s/.test(TOKEN)) { r.error('DISCORD_SETUP_BOT_TOKEN contains whitespace'); return r.finish(); }
  try {
    const ctx = await loadContext();
    await run(r, ctx);
  } catch (err) {
    r.error(describe(err));
  }
  r.log(`${stats.requests} requests, ${stats.rateLimited} rate limit waits, ${stats.retried} retries`);
  return r.finish();
}

async function main() {
  const name = process.argv[2];
  if (name === 'all') {
    let code = 0;
    for (const phase of Object.keys(PHASES)) {
      const result = await runPhase(phase);
      code = Math.max(code, result);
      if (phase === 'discover' && result) break;
    }
    return code;
  }
  if (!PHASES[name]) {
    console.log(`::error title=Discord setup::unknown phase "${escData(String(name ?? ''))}" (use one of: ${Object.keys(PHASES).join(', ')}, all)`);
    return 2;
  }
  return runPhase(name);
}

main().then((code) => process.exit(code), (err) => {
  console.log(`::error title=Discord setup::${escData(scrub(describe(err)))}`);
  process.exit(1);
});
