// Mock test for scripts/discord-setup.mjs (run by hand: node tests/discord-setup.mjs; it is not part
// of npm test). Every phase runs as its own process, in the order the workflow runs them, against
// an in-process fake Discord API on 127.0.0.1 that records every call. The fake starts as a fresh
// server (Discord's default #general and General voice, the bot's own role) and throws a bucket
// 429, a global 429 and a 502 along the way. Checked:
//   - the full desired state is reached (roles, order, channels, overwrites, Community,
//     onboarding, AutoMod, settings, icon, posts with the approved texts, bot name);
//   - a second run makes no writes at all (no creates, no duplicate posts);
//   - drift (a deleted channel, a cleared topic, swapped roles, a role let into the owner-only
//     channel) converges back with exactly one create;
//   - the owner-only channel grants no role, and the private categories are private;
//   - a rejected onboarding reports the exact Discord error and the other phases still pass;
//   - no secret appears in any annotation, log line, URL or request body;
//   - the API base override is refused in CI and off loopback; a wrong guild count fails clearly;
//   - the server icon: set from nothing, left alone when there is one (no flag, or the flag off),
//     replaced only when DISCORD_SETUP_REPLACE_ICON asks (one PATCH with the new image, the revision in
//     the audit log reason, old and new hash in the annotation), reported when Discord rejects it or
//     already had the image, and refused in GitHub Actions on any trigger but workflow_dispatch; the
//     workflow passes the flag from the workflow_dispatch input to the settings step only;
//   - release posts (scripts/discord-releases.mjs, run from a copy of the script beside test lists):
//     2.2 already up means nothing is sent; a new version is posted once to #announcements and
//     #patch-notes, crossposted, with exactly its ping role in allowed_mentions; a second run writes
//     nothing; a placeholder (and anything after it) is never posted; a failed crosspost is retried
//     by the next run without a second post, and a long publish rate limit fails fast; a bad list
//     posts nothing; a version older than one already up is never posted;
//   - the live gate: a version is posted only once riftborn.us (the fake's /version.json, through
//     site.config.mjs's RIFTBORN_TEST_LIVE_ORIGIN) serves it or a newer one, compared as numbers; a
//     newer version and everything after it wait with a notice; riftborn.us is asked once per run,
//     only when something is about to be posted, with a cache-busting query and never the token; an
//     unreachable site (503s, a closed port) posts nothing after four tries and is a warning, not an
//     error; a malformed answer (or a redirect, never followed) is an error; versions already live go
//     out as before;
//   - the workflow: a workflow_run trigger on the Pages deploy of main (its name as pages.yml has it),
//     successful deploys only, which runs Discover guild and Release posts and nothing else (never the
//     icon step); push and manual triggers kept; one run at a time (concurrency, never cancelled), and
//     a run whose job is skipped (a failed or cancelled deploy) in a group of its own, so it can never
//     replace a waiting run that would post.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASES } from '../scripts/discord-releases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'discord-setup.mjs');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'discord-setup.yml'), 'utf8').replace(/\r\n/g, '\n');
const PAGES_WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8').replace(/\r\n/g, '\n');
// Fake, assembled from parts so secret scanners don't mistake the test value for a real token.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GfAkE1', 'mock-token-that-must-never-leak-0123456789'].join('.');
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/secret-webhook-token-abcdef';

const bit = (n) => 1n << BigInt(n);
const B = {
  KICK: bit(1), ADMIN: bit(3), ADD_REACTIONS: bit(6), AUDIT_LOG: bit(7), VIEW: bit(10), SEND: bit(11),
  MANAGE_MESSAGES: bit(13), MENTION_EVERYONE: bit(17), MUTE: bit(22), MOVE: bit(24), MANAGE_THREADS: bit(34),
  CREATE_PUBLIC_THREADS: bit(35), SEND_IN_THREADS: bit(38), MODERATE: bit(40), CREATE_EXPRESSIONS: bit(43),
  CREATE_EVENTS: bit(44), PIN: bit(51), BYPASS_SLOWMODE: bit(52),
};
// Roughly what Discord gives @everyone in a new server (including Mention @everyone, Create
// Expressions and Create Events, which the script takes away).
const DEFAULT_EVERYONE = String([0, 6, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 25, 26, 31, 35, 36, 37, 38, 39, 42, 43, 44, 45, 46, 49]
  .reduce((acc, n) => acc | bit(n), 0n));

// ---------------------------------------------------------------------------------------------
// The fake Discord API

const iconHash = (dataUri) => createHash('md5').update(dataUri).digest('hex');

function createFakeDiscord() {
  let seq = 1_250_000_000_000_000_000n;
  const sf = () => String(++seq);
  const G = sf(), OWNER = sf(), BOT = sf(), BOT_ROLE = sf();
  const textCat = { id: sf(), guild_id: G, type: 4, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] };
  const voiceCat = { id: sf(), guild_id: G, type: 4, name: 'Voice Channels', position: 1, parent_id: null, permission_overwrites: [] };
  const general = { id: sf(), guild_id: G, type: 0, name: 'general', position: 0, parent_id: textCat.id, topic: null, permission_overwrites: [] };
  const generalVoice = { id: sf(), guild_id: G, type: 2, name: 'General', position: 0, parent_id: voiceCat.id, permission_overwrites: [] };
  const state = {
    ids: { G, OWNER, BOT, BOT_ROLE, general: general.id, generalVoice: generalVoice.id },
    me: { id: BOT, username: 'Riftborn App', bot: true },
    extraGuilds: [],
    guild: {
      id: G, name: 'Riftborn', owner_id: OWNER, icon: null, features: [], verification_level: 0,
      explicit_content_filter: 0, default_message_notifications: 0, system_channel_id: general.id,
      system_channel_flags: 0, rules_channel_id: null, public_updates_channel_id: null, safety_alerts_channel_id: null,
    },
    roles: [
      { id: G, name: '@everyone', position: 0, permissions: DEFAULT_EVERYONE, color: 0, hoist: false, mentionable: false, managed: false },
      { id: BOT_ROLE, name: 'RiftBot', position: 1, permissions: '8', color: 0, hoist: false, mentionable: false, managed: true, tags: { bot_id: BOT } },
    ],
    channels: [textCat, voiceCat, general, generalVoice],
    threads: [],
    members: new Map([[OWNER, { user: { id: OWNER }, roles: [] }], [BOT, { user: { id: BOT }, roles: [BOT_ROLE] }]]),
    messages: new Map(),
    crossposted: new Set(), // message ids Discord has published
    automod: [],
    onboarding: { guild_id: G, prompts: [], default_channel_ids: [], enabled: false, mode: 0 },
  };
  const faults = {
    rateLimit: new Set([`POST /guilds/${G}/channels`]),
    globalRateLimit: new Set(['GET /users/@me/guilds']),
    serverError: new Set([`PATCH /guilds/${G}`]),
    echoSecret: new Set(),
    onboardingReject: false,
    iconReject: false,
    messagesReadDenied: false,
    membersIntentOff: false,
    crosspostRateLimit: new Set(), // channel ids whose next crosspost gets an hour-long 429
  };
  const calls = [];
  // riftborn.us as the live gate sees it: GET /version.json on the same server (no token needed).
  // answer, when set, replaces the normal reply ({ status, body }); calls is cleared per release run,
  // seen keeps every request.
  const site = { version: '2.3.0', answer: null, calls: [], seen: [] };

  const err = (status, message, code = 0, errors) => [status, { message, code, ...(errors ? { errors } : {}) }];
  const formErr = (field, message) => err(400, 'Invalid Form Body', 50035, { [field]: { _errors: [{ code: 'BASE_TYPE_INVALID', message }] } });
  const ch = (id) => state.channels.find((c) => c.id === id);
  const role = (id) => state.roles.find((r) => r.id === id);
  const community = () => state.guild.features.includes('COMMUNITY');
  const normOw = (o) => ({ id: String(o.id), type: Number(o.type), allow: String(BigInt(o.allow ?? 0)), deny: String(BigInt(o.deny ?? 0)) });
  const badOverwrites = (list) => {
    for (const o of list ?? []) {
      if (o.type === 0 && !role(o.id)) return formErr('permission_overwrites', `unknown role ${o.id}`);
      if (o.type === 1 && !state.members.has(o.id)) return formErr('permission_overwrites', `unknown member ${o.id}`);
      if (![0, 1].includes(o.type) || !/^\d+$/.test(String(o.allow)) || !/^\d+$/.test(String(o.deny))) return formErr('permission_overwrites', 'bad overwrite');
    }
    return null;
  };
  const topicLimit = (type) => (type === 15 ? 4096 : 1024);
  const everyoneCan = (c, flag) => {
    let perms = BigInt(role(G).permissions);
    const o = c.permission_overwrites.find((x) => x.id === G);
    if (o) perms = (perms & ~BigInt(o.deny)) | BigInt(o.allow);
    return (perms & B.VIEW) !== 0n && (perms & flag) !== 0n;
  };
  const tagsOut = (tags) => (tags ?? []).map((t) => ({ id: t.id ?? sf(), name: t.name, moderated: Boolean(t.moderated), emoji_id: t.emoji_id ?? null, emoji_name: t.emoji_name ?? null }));

  function createChannel(body) {
    if (!body?.name) return formErr('name', 'required');
    const type = body.type ?? 0;
    if (![0, 2, 4, 5, 15].includes(type)) return formErr('type', 'unsupported type');
    if (type === 5 && !state.guild.features.includes('NEWS')) return err(400, 'Cannot execute action on this channel type', 50024);
    if (type === 15 && !community()) return err(400, 'Cannot execute action on this channel type', 50024);
    if (body.topic && body.topic.length > topicLimit(type)) return formErr('topic', 'too long');
    if (body.parent_id && ch(body.parent_id)?.type !== 4) return formErr('parent_id', 'not a category');
    const bad = badOverwrites(body.permission_overwrites);
    if (bad) return bad;
    const siblings = state.channels.filter((c) => (c.parent_id ?? null) === (body.parent_id ?? null) && (c.type === 4) === (type === 4));
    const channel = {
      id: sf(), guild_id: G, type, name: [0, 5, 15].includes(type) ? body.name.toLowerCase() : body.name,
      position: body.position ?? siblings.reduce((max, c) => Math.max(max, c.position), -1) + 1,
      parent_id: body.parent_id ?? null, permission_overwrites: (body.permission_overwrites ?? []).map(normOw),
    };
    if (type !== 2 && type !== 4) channel.topic = body.topic ?? null;
    if (type === 15) {
      channel.available_tags = tagsOut(body.available_tags);
      channel.default_reaction_emoji = body.default_reaction_emoji ?? null;
    }
    state.channels.push(channel);
    return [201, channel];
  }

  function patchChannel(id, body) {
    const thread = state.threads.find((t) => t.id === id);
    if (thread) {
      if ('flags' in body) thread.flags = body.flags;
      if ('locked' in body) thread.thread_metadata.locked = body.locked;
      return [200, thread];
    }
    const c = ch(id);
    if (!c) return err(404, 'Unknown Channel', 10003);
    if ('type' in body && body.type !== c.type) {
      if (![0, 5].includes(c.type) || ![0, 5].includes(body.type) || !state.guild.features.includes('NEWS')) return err(400, 'Cannot execute action on this channel type', 50024);
    }
    if ('topic' in body && body.topic && body.topic.length > topicLimit(c.type)) return formErr('topic', 'too long');
    if ('parent_id' in body && body.parent_id && ch(body.parent_id)?.type !== 4) return formErr('parent_id', 'not a category');
    const bad = badOverwrites(body.permission_overwrites);
    if (bad) return bad;
    if ('type' in body) c.type = body.type;
    if ('name' in body) c.name = [0, 5, 15].includes(c.type) ? body.name.toLowerCase() : body.name;
    if ('topic' in body) c.topic = body.topic;
    if ('parent_id' in body) c.parent_id = body.parent_id;
    if ('permission_overwrites' in body) c.permission_overwrites = body.permission_overwrites.map(normOw);
    if ('available_tags' in body) c.available_tags = tagsOut(body.available_tags);
    if ('default_reaction_emoji' in body) c.default_reaction_emoji = body.default_reaction_emoji;
    return [200, c];
  }

  // Like Discord: a new role takes position 1 and nothing moves, so positions tie and Discord
  // ranks ties by age (the older role, lower id, ranks higher).
  function createRole(body) {
    const made = { id: sf(), name: body.name ?? 'new role', color: body.color ?? 0, hoist: Boolean(body.hoist), mentionable: Boolean(body.mentionable),
      permissions: String(BigInt(body.permissions ?? '0')), managed: false, position: 1 };
    state.roles.push(made);
    return [200, made];
  }

  function reorderRoles(list) {
    const botPos = role(BOT_ROLE).position;
    for (const item of list) {
      const r = role(item.id);
      if (!r || r.managed || r.id === G || !ranksAbove(role(BOT_ROLE), r) || item.position >= botPos) return err(403, 'Missing Permissions', 50013);
    }
    const moved = new Set(list.map((item) => item.id));
    for (const item of list) role(item.id).position = item.position;
    const others = state.roles.filter((r) => r.id !== G)
      .sort((a, b) => a.position - b.position || (moved.has(b.id) ? 1 : 0) - (moved.has(a.id) ? 1 : 0) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    others.forEach((r, i) => { r.position = i + 1; });
    return [200, state.roles];
  }

  function patchGuild(body) {
    const next = { ...state.guild };
    for (const key of ['verification_level', 'explicit_content_filter', 'default_message_notifications', 'system_channel_id',
      'system_channel_flags', 'rules_channel_id', 'public_updates_channel_id', 'safety_alerts_channel_id']) {
      if (key in body) next[key] = body[key];
    }
    if ('icon' in body) {
      // Discord documents the guild icon as a 1024x1024 PNG, JPEG or GIF: here a PNG that is square,
      // 128 to 1024 px, under 10 MB. The hash is a hash of the image, so the same image gives the same hash.
      if (faults.iconReject || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(body.icon)) return formErr('icon', 'Invalid image data');
      const png = Buffer.from(body.icon.split(',')[1], 'base64');
      const isPng = png.length > 33 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const [w, h] = isPng ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
      if (!isPng || w !== h || w < 128 || w > 1024 || png.length > 10_000_000) return formErr('icon', 'Invalid image data');
      next.icon = iconHash(body.icon);
    }
    if ('features' in body && body.features.includes('COMMUNITY') && !community()) {
      // Discord refuses COMMUNITY unless both channel ids come in the same request (discord-api-docs #6015).
      if (!('rules_channel_id' in body) || !('public_updates_channel_id' in body)) return err(403, 'This feature has been temporarily disabled', 40006);
      const isText = (id) => ch(id)?.type === 0;
      if (!(next.verification_level >= 1) || next.explicit_content_filter !== 2 || !isText(next.rules_channel_id) || !isText(next.public_updates_channel_id)) {
        return err(400, 'Invalid Form Body', 50035, { features: { _errors: [{ code: 'GUILD_COMMUNITY_REQUIREMENTS', message: 'Community requirements not met' }] } });
      }
      next.features = [...new Set([...state.guild.features, 'COMMUNITY', 'NEWS'])];
    }
    if ('safety_alerts_channel_id' in body && !next.features.includes('COMMUNITY')) return formErr('safety_alerts_channel_id', 'needs Community');
    if ('system_channel_id' in body && ch(body.system_channel_id)?.type !== 0) return formErr('system_channel_id', 'not a text channel');
    state.guild = next;
    return [200, { ...next, roles: state.roles }];
  }

  function putOnboarding(body) {
    if (!community()) return err(400, 'Onboarding needs a Community server', 50035);
    if (faults.onboardingReject) {
      return err(400, 'Invalid Form Body', 50035, { default_channel_ids: { _errors: [{ code: 'GUILD_ONBOARDING_DEFAULT_CHANNELS_INVALID', message: 'Default channels do not meet the requirements' }] } });
    }
    const defaults = body.default_channel_ids ?? [];
    if (defaults.length < 7) return formErr('default_channel_ids', 'at least 7 default channels');
    for (const id of defaults) if (!ch(id) || !everyoneCan(ch(id), B.VIEW)) return formErr('default_channel_ids', `channel ${id} is not visible to @everyone`);
    if (defaults.filter((id) => [0, 15].includes(ch(id).type) && everyoneCan(ch(id), B.SEND)).length < 5) return formErr('default_channel_ids', 'at least 5 channels @everyone can send in');
    for (const prompt of body.prompts ?? []) {
      if (!/^\d+$/.test(String(prompt.id)) || !prompt.title || !prompt.options?.length) return formErr('prompts', 'bad prompt');
      for (const option of prompt.options) {
        if (!/^\d+$/.test(String(option.id)) || !option.title) return formErr('prompts', 'bad option');
        if (!(option.role_ids?.length || option.channel_ids?.length)) return formErr('prompts', 'option needs a role or channel');
        if ((option.role_ids ?? []).some((id) => !role(id))) return formErr('prompts', 'unknown role');
      }
    }
    state.onboarding = {
      guild_id: G, enabled: Boolean(body.enabled), mode: body.mode ?? 0, default_channel_ids: [...defaults],
      prompts: (body.prompts ?? []).map((p) => ({
        id: String(p.id), type: p.type ?? 0, title: p.title, single_select: Boolean(p.single_select), required: Boolean(p.required),
        in_onboarding: p.in_onboarding !== false,
        options: p.options.map((o) => ({ id: String(o.id), title: o.title, description: o.description ?? null,
          emoji: { id: null, name: o.emoji_name ?? null, animated: false }, role_ids: o.role_ids ?? [], channel_ids: o.channel_ids ?? [] })),
      })),
    };
    return [200, state.onboarding];
  }

  function handle(method, route, body, params) {
    let m;
    if (route === '/users/@me' && method === 'GET') return [200, state.me];
    if (route === '/users/@me' && method === 'PATCH') { state.me = { ...state.me, username: body.username }; return [200, state.me]; }
    if (route === '/users/@me/guilds' && method === 'GET') return [200, [{ id: G, name: state.guild.name }, ...state.extraGuilds]];
    if ((m = route.match(/^\/guilds\/(\d+)(\/.*)?$/))) {
      if (m[1] !== G) return err(404, 'Unknown Guild', 10004);
      const sub = m[2] ?? '';
      let s;
      if (sub === '' && method === 'GET') return [200, { ...state.guild, roles: state.roles }];
      if (sub === '' && method === 'PATCH') return patchGuild(body);
      if (sub === '/channels' && method === 'GET') return [200, state.channels];
      if (sub === '/channels' && method === 'POST') return createChannel(body);
      if (sub === '/channels' && method === 'PATCH') {
        for (const item of body) { const c = ch(item.id); if (!c) return err(404, 'Unknown Channel', 10003); c.position = item.position; }
        return [204];
      }
      if (sub === '/roles' && method === 'GET') return [200, state.roles];
      if (sub === '/roles' && method === 'POST') return createRole(body);
      if (sub === '/roles' && method === 'PATCH') return reorderRoles(body);
      if ((s = sub.match(/^\/roles\/(\d+)$/)) && method === 'PATCH') {
        const r = role(s[1]);
        if (!r) return err(404, 'Unknown Role', 10011);
        for (const key of ['name', 'color', 'hoist', 'mentionable']) if (key in body) r[key] = body[key];
        if ('permissions' in body) r.permissions = String(BigInt(body.permissions));
        return [200, r];
      }
      if (sub === '/members' && method === 'GET') {
        if (faults.membersIntentOff) return err(403, 'Missing Access', 50001);
        return [200, [...state.members.values()]];
      }
      if ((s = sub.match(/^\/members\/(\d+)$/)) && method === 'GET') {
        const member = state.members.get(s[1]);
        return member ? [200, member] : err(404, 'Unknown Member', 10007);
      }
      if ((s = sub.match(/^\/members\/(\d+)\/roles\/(\d+)$/)) && method === 'PUT') {
        const member = state.members.get(s[1]);
        if (!member || !role(s[2])) return err(404, 'Unknown Member or Role', 10007);
        if (!member.roles.includes(s[2])) member.roles.push(s[2]);
        return [204];
      }
      if (sub === '/onboarding' && method === 'GET') return [200, state.onboarding];
      if (sub === '/onboarding' && method === 'PUT') return putOnboarding(body);
      if (sub === '/auto-moderation/rules' && method === 'GET') {
        if (faults.echoSecret.has('automod')) return err(400, `Invalid token ${TOKEN} for ${WEBHOOK}`, 50001);
        return [200, state.automod];
      }
      if (sub === '/auto-moderation/rules' && method === 'POST') {
        if ([3, 4, 5].includes(body.trigger_type) && state.automod.some((r) => r.trigger_type === body.trigger_type)) return err(400, 'Maximum number of rules of this type reached', 20036);
        for (const action of body.actions ?? []) if (action.type === 2 && !ch(action.metadata?.channel_id)) return formErr('actions', 'unknown alert channel');
        const rule = { id: sf(), guild_id: G, creator_id: BOT, exempt_roles: [], exempt_channels: [], ...body };
        state.automod.push(rule);
        return [200, rule];
      }
      if ((s = sub.match(/^\/auto-moderation\/rules\/(\d+)$/)) && method === 'PATCH') {
        const rule = state.automod.find((r) => r.id === s[1]);
        if (!rule) return err(404, 'Unknown auto moderation rule', 10066);
        // Discord's own rules (made by the AutoMod system user) can be read but not changed.
        if (rule.creator_id !== BOT) return err(404, '404: Not Found');
        Object.assign(rule, body);
        return [200, rule];
      }
      if (sub === '/threads/active' && method === 'GET') return [200, { threads: state.threads.filter((t) => !t.thread_metadata.archived), members: [] }];
      if (sub === '/invites' && method === 'GET') return [200, state.invites ?? []];
    }
    if ((m = route.match(/^\/channels\/(\d+)(\/.*)?$/))) {
      const id = m[1];
      const sub = m[2] ?? '';
      let s2;
      if (sub === '' && method === 'PATCH') return patchChannel(id, body);
      if (sub === '/invites' && method === 'POST') {
        state.invites ??= [];
        const invite = { code: 'rift' + state.invites.length, max_age: body.max_age, max_uses: body.max_uses, temporary: !!body.temporary, inviter: { id: state.me.id }, channel: { id } };
        state.invites.push(invite);
        return [200, invite];
      }
      if (sub === '' && method === 'DELETE') {
        const c = ch(id);
        if (!c) return err(404, 'Unknown Channel', 10003);
        state.channels = state.channels.filter((x) => x.id !== id);
        for (const x of state.channels) if (x.parent_id === id) x.parent_id = null;
        return [200, c];
      }
      if (sub === '/messages' && method === 'GET') {
        if (faults.messagesReadDenied) return err(403, 'Missing Access', 50001);
        const all = state.messages.get(id) ?? []; // oldest first
        const limit = Math.min(100, Number(params.get('limit') ?? 50));
        const page = params.has('after') ? all.filter((msg) => BigInt(msg.id) > BigInt(params.get('after'))).slice(0, limit)
          : params.has('before') ? all.filter((msg) => BigInt(msg.id) < BigInt(params.get('before'))).slice(-limit)
            : all.slice(-limit);
        return [200, [...page].reverse()]; // newest first, like Discord
      }
      if (sub === '/messages' && method === 'POST') {
        const target = ch(id) ?? state.threads.find((t) => t.id === id);
        if (!target || ![0, 5, 11].includes(target.type)) return err(400, 'Cannot send messages in this channel', 50008);
        if (!body.content || body.content.length > 2000) return formErr('content', 'Must be 2000 or fewer in length.');
        // Like Discord: parse "roles" and a roles list are exclusive; with no allowed_mentions every
        // role mention pings (RiftBot is an admin, so even roles nobody else may mention).
        const allowed = body.allowed_mentions;
        if (allowed?.parse?.includes('roles') && allowed?.roles) return formErr('allowed_mentions', 'parse roles and roles are mutually exclusive');
        const pinged = [...body.content.matchAll(/<@&(\d+)>/g)].map((m) => m[1])
          .filter((roleId) => role(roleId) && (!allowed || allowed.parse?.includes('roles') || allowed.roles?.includes(roleId)));
        const message = { id: sf(), channel_id: id, author: { id: BOT, username: state.me.username, bot: true }, content: body.content, flags: body.flags ?? 0,
          allowed_mentions: allowed ?? null, pinged };
        state.messages.set(id, [...(state.messages.get(id) ?? []), message]);
        return [200, message];
      }
      if ((s2 = sub.match(/^\/messages\/(\d+)\/crosspost$/)) && method === 'POST') {
        const c = ch(id);
        const message = (state.messages.get(id) ?? []).find((msg) => msg.id === s2[1]);
        if (!c || !message) return err(404, 'Unknown Message', 10008);
        if (c.type !== 5) return err(400, 'Cannot execute action on this channel type', 50024);
        // Like Discord's hourly publish limit: the bucket headers say it resets in an hour too.
        if (faults.crosspostRateLimit.delete(id)) return [429, { message: 'You are being rate limited.', retry_after: 3600, global: false }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3600' }];
        if (faults.echoSecret.has('crosspost')) return err(400, `Invalid token ${TOKEN} for ${WEBHOOK}`, 50001);
        if (message.flags & 1 || state.crossposted.has(message.id)) return err(400, 'This message has already been crossposted.', 40033);
        message.flags |= 1;
        state.crossposted.add(message.id);
        return [200, message];
      }
      if (sub === '/threads' && method === 'POST') {
        const forum = ch(id);
        if (!forum || forum.type !== 15) return err(400, 'Cannot execute action on this channel type', 50024);
        if (!body.name || !body.message?.content || body.message.content.length > 2000) return formErr('message', 'bad starter message');
        const thread = { id: sf(), guild_id: G, type: 11, parent_id: id, owner_id: BOT, name: body.name, flags: 0,
          thread_metadata: { archived: false, locked: false, auto_archive_duration: 4320 } };
        const message = { id: thread.id, channel_id: thread.id, author: { id: BOT, username: state.me.username, bot: true }, content: body.message.content, flags: body.message.flags ?? 0 };
        state.threads.push(thread);
        state.messages.set(thread.id, [message]);
        return [201, { ...thread, message }];
      }
      if (sub === '/threads/archived/public' && method === 'GET') {
        const limit = Math.min(100, Number(params.get('limit') ?? 50));
        const before = params.get('before');
        const list = state.threads.filter((t) => t.parent_id === id && t.thread_metadata.archived && (!before || t.thread_metadata.archive_timestamp < before))
          .sort((a, b) => b.thread_metadata.archive_timestamp.localeCompare(a.thread_metadata.archive_timestamp));
        return [200, { threads: list.slice(0, limit), members: [], has_more: list.length > limit }];
      }
    }
    return err(404, '404: Not Found', 0);
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    // /moved/version.json always serves the version: where the redirect test points, so following a
    // redirect would show (an extra call, and a post).
    if (url.pathname === '/version.json' || url.pathname === '/moved/version.json') {
      const ask = { method: req.method, path: url.pathname, query: url.search, headers: { ...req.headers } };
      site.calls.push(ask);
      site.seen.push(ask);
      const reply = (url.pathname === '/version.json' && site.answer)
        || { status: 200, body: JSON.stringify({ version: site.version, build: '0123456789', builtAt: '2026-10-01T00:00:00.000Z' }) };
      res.writeHead(reply.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...reply.headers });
      return res.end(reply.body);
    }
    const route = url.pathname.replace(/^\/api\/v10/, '');
    const call = { method: req.method, route, query: url.search, body: raw, reason: req.headers['x-audit-log-reason'] ?? null, status: 0 };
    calls.push(call);
    const send = (status, data, headers = {}) => {
      call.status = status;
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': calls.length % 10 === 0 ? '0' : '4',
        'x-ratelimit-reset-after': '0.02',
        ...headers,
      });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bot ${TOKEN}`) return send(401, { message: '401: Unauthorized', code: 0 });
    if (!String(req.headers['user-agent'] ?? '').startsWith('DiscordBot (')) return send(400, { message: 'Bad user agent', code: 0 });
    const key = `${req.method} ${route}`;
    if (faults.rateLimit.delete(key)) return send(429, { message: 'You are being rate limited.', retry_after: 0.05, global: false }, { 'retry-after': '1' });
    if (faults.globalRateLimit.delete(key)) return send(429, { message: 'You are being rate limited.', retry_after: 0.05, global: true }, { 'x-ratelimit-global': 'true' });
    if (faults.serverError.delete(key)) return send(502, { message: 'Bad Gateway' });
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { return send(400, { message: 'Invalid JSON', code: 50109 }); }
    }
    try {
      const [status, data, headers] = handle(req.method, route, body, url.searchParams);
      send(status, data, headers);
    } catch (error) {
      send(500, { message: `fake crashed: ${error.message}`, code: 0 });
    }
  });

  return {
    state, faults, calls, site, handle, sf,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api/v10`))),
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---------------------------------------------------------------------------------------------
// Running the script

const output = [];
function envWith(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CI|GITHUB_ACTIONS|GITHUB_EVENT_NAME|DISCORD_SETUP_.*|RIFTBORN_.*)$/i.test(key)) delete env[key];
  return { ...env, ...extra };
}
// A run that hangs (a rate limit gate pushed far ahead, say) is killed and fails instead.
function run(args, env, script = SCRIPT, timeout = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      output.push(stdout, stderr);
      assert.ok(!signal, `${args.join(' ')} hung and was killed after ${timeout / 1000} s`);
      const count = (kind) => stdout.split('\n').filter((line) => line.startsWith(`::${kind} `)).length;
      // GitHub keeps 50 annotations per job and the job has 12 steps: each step writes exactly one
      // summary (a notice, or a warning) and at most 3 errors, 48 in all ("all" runs every phase in
      // one process).
      const steps = args[0] === 'all' ? 12 : 1;
      if (args[0] !== 'nonsense') assert.equal(count('notice') + count('warning'), steps, `one summary per step for ${args.join(' ')}`);
      assert.ok(count('error') <= 3 * steps, `too many error annotations for ${args.join(' ')}`);
      resolve({ code, stdout, stderr, text: `${stdout}${stderr}` });
    });
  });
}
async function runAll(phases, env, label) {
  for (const phase of phases) {
    const result = await run([phase], env);
    if (process.env.VERBOSE) console.log(`[${label}] ${phase}\n${result.stdout.trimEnd()}`);
    assert.equal(result.code, 0, `${label}: phase ${phase} failed\n${result.text}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The desired state

const APPROVED = {
  welcome: `**Welcome to Riftborn** 🌋
A free PS1-style survival shooter you play right in your browser. Five broken worlds, one way home.
▶️ **Play:** https://riftborn.us
🧭 Read <#rules>, then pick your pings in *Channels & Roles*.
📣 News in <#announcements> and <#patch-notes> · 🐞 bugs in <#bug-reports> · 💡 ideas in <#suggestions> · 🏆 brag in <#leaderboard-brags>
See you in the rift.`,
  rules: `**Rules**
1. Be kind: no harassment, hate speech, slurs or personal attacks.
2. Keep it safe for everyone: no NSFW, gore or shock content.
3. No spam, self-promo or unsolicited DMs.
4. Secret and code spoilers only in <#secret-hunt>.
5. No cheats or leaderboard exploits; report exploits privately to a mod.
6. Use the right channel, so bug reports actually get fixed.
7. Follow Discord's Terms of Service and Community Guidelines.
Mods may remove messages or members that break these rules.`,
  faq: `**Is it free?** Yes. Play at https://riftborn.us on desktop or phone.
**Do I need an account?** No, you can play as a guest. Sign in with Google, Discord or GitHub to keep your progress on every device. No email or real name is ever stored.
**I played at the old chancrisp.github.io address, is my progress gone?** No. Open your old link once and it moves your progress over automatically.
**Controllers?** Keyboard and mouse, gamepad and touch all work.
**Found a bug?** Post in <#bug-reports> with your device and browser, or use FEEDBACK on the game's main menu.
**Secret characters?** There are a few… clues go in <#secret-hunt>. No spoilers elsewhere!
**Privacy:** https://riftborn.us/privacy/`,
};

const LAYOUT = [
  ['📜 START HERE', 'readonly', [['welcome', 0], ['rules', 0], ['faq', 0]]],
  ['📣 NEWS', 'news', [['announcements', 5], ['patch-notes', 5], ['sneak-peeks', 0]]],
  ['💬 COMMUNITY', 'public', [['general', 0], ['introductions', 0], ['screenshots-and-clips', 0], ['fan-art', 0], ['off-topic', 0]]],
  ['🎮 THE RIFT', 'public', [['builds-and-strategy', 0], ['leaderboard-brags', 0], ['secret-hunt', 0]]],
  ['🛠️ FEEDBACK', 'public', [['bug-reports', 15], ['suggestions', 15]]],
  ['🧪 TESTERS', 'testers', [['tester-chat', 0], ['dev-builds', 0]]],
  ['🔒 STAFF', 'staff', [['mod-chat', 0], ['mod-log', 0]]],
  ['🔒 OWNER ONLY', 'owner', [['game-feedback', 0]]],
  ['🔊 VOICE', 'public', [['Lobby', 2], ['Co-op', 2]]],
];

function assertDesiredState(fake, label) {
  const s = fake.state;
  const { G, OWNER, BOT, BOT_ROLE } = s.ids;
  const at = (what) => `${label}: ${what}`;
  const byPos = (a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

  // Roles
  const roleNamed = (name) => {
    const list = s.roles.filter((r) => r.name === name);
    assert.equal(list.length, 1, at(`exactly one role ${name}`));
    return list[0];
  };
  const [keeper, mod, tester, rifter, newsPing, patchPing, eventPing] = ['Rift Keeper', 'Moderator', 'Tester', 'Rifter', 'News pings', 'Patch pings', 'Event pings'].map(roleNamed);
  assert.deepEqual([keeper.color, keeper.hoist, keeper.permissions], [0xff7a1a, true, String(B.ADMIN)], at('Rift Keeper'));
  assert.deepEqual([mod.color, mod.hoist, tester.color, tester.hoist, rifter.color, rifter.hoist], [0x9b5cff, true, 0x3ad6c5, true, 0xe8c170, false], at('role colours and hoist'));
  const modPerms = BigInt(mod.permissions);
  for (const flag of ['AUDIT_LOG', 'MANAGE_MESSAGES', 'PIN', 'BYPASS_SLOWMODE', 'MANAGE_THREADS', 'MODERATE', 'KICK', 'MUTE', 'MOVE', 'VIEW', 'SEND']) assert.ok(modPerms & B[flag], at(`Moderator has ${flag}`));
  assert.equal(modPerms & B.ADMIN, 0n, at('Moderator is not an admin'));
  for (const r of [tester, rifter, newsPing, patchPing, eventPing]) assert.equal(r.permissions, '0', at(`${r.name} has no permissions`));
  for (const r of [newsPing, patchPing, eventPing]) assert.equal(r.color, 0, at(`${r.name} has no colour`));
  const ladder = [role(s, BOT_ROLE), keeper, mod, tester, rifter, newsPing, patchPing, eventPing];
  for (let i = 1; i < ladder.length; i += 1) assert.ok(ranksAbove(ladder[i - 1], ladder[i]), at(`${ladder[i - 1].name} above ${ladder[i].name}`));
  assert.ok(s.members.get(OWNER).roles.includes(keeper.id), at('owner has Rift Keeper'));
  assert.deepEqual([...s.members].filter(([, m]) => m.roles.includes(keeper.id)).map(([id]) => id), [OWNER], at('only the owner has Rift Keeper'));
  const everyonePerms = BigInt(role(s, G).permissions);
  assert.equal(everyonePerms & (B.MENTION_EVERYONE | B.ADMIN | B.MANAGE_MESSAGES | B.CREATE_EXPRESSIONS | B.CREATE_EVENTS | B.PIN | B.BYPASS_SLOWMODE), 0n, at('@everyone hardened'));
  assert.ok(everyonePerms & B.VIEW && everyonePerms & B.SEND, at('@everyone can still talk'));

  // Channels
  const categories = s.channels.filter((c) => c.type === 4).sort(byPos);
  assert.deepEqual(categories.map((c) => c.name), LAYOUT.map(([name]) => name), at('categories in order, defaults removed'));
  assert.equal(s.channels.length, LAYOUT.reduce((n, [, , list]) => n + 1 + list.length, 0), at('no extra or duplicate channels'));
  const named = {};
  for (const [catName, access, list] of LAYOUT) {
    const category = categories.find((c) => c.name === catName);
    const children = s.channels.filter((c) => c.parent_id === category.id).sort(byPos);
    assert.deepEqual(children.map((c) => [c.name, c.type]), list, at(`${catName} channels and types in order`));
    for (const c of [category, ...children]) {
      named[c.name] = c;
      const ow = (id) => c.permission_overwrites.find((o) => o.id === id);
      const allows = (o, flag) => Boolean(o) && (BigInt(o.allow) & flag) !== 0n;
      const denies = (o, flag) => Boolean(o) && (BigInt(o.deny) & flag) !== 0n;
      if ([0, 5, 15].includes(c.type)) assert.ok(typeof c.topic === 'string' && c.topic.length > 10, at(`#${c.name} has a topic`));
      if (access === 'readonly') assert.ok(denies(ow(G), B.SEND) && denies(ow(G), B.ADD_REACTIONS) && denies(ow(G), B.CREATE_PUBLIC_THREADS), at(`${c.name} is read-only`));
      if (access === 'news') assert.ok(denies(ow(G), B.SEND) && !denies(ow(G), B.ADD_REACTIONS), at(`${c.name}: read and react only`));
      if (['readonly', 'news'].includes(access)) assert.ok(allows(ow(keeper.id), B.SEND), at(`${c.name}: Rift Keeper posts`));
      if (access === 'public') assert.ok(!denies(ow(G), B.VIEW) && !denies(ow(G), B.SEND), at(`${c.name} is public`));
      if (['testers', 'staff', 'owner'].includes(access)) {
        assert.ok(denies(ow(G), B.VIEW), at(`${c.name} hidden from @everyone`));
        assert.ok(allows(ow(BOT), B.VIEW | B.SEND) && ow(BOT).type === 1, at(`${c.name}: the bot can post`));
        assert.equal(canView(s, c, []), false, at(`${c.name}: a plain member cannot see it`));
        assert.equal(canView(s, c, [rifter.id, newsPing.id]), false, at(`${c.name}: Rifter cannot see it`));
      }
      if (access === 'testers') assert.ok(canView(s, c, [tester.id]) && canView(s, c, [mod.id]), at(`${c.name}: Tester and Moderator see it`));
      if (access === 'staff') assert.ok(canView(s, c, [mod.id]) && !canView(s, c, [tester.id]), at(`${c.name}: Moderator only`));
      if (access === 'owner') {
        assert.ok(c.permission_overwrites.every((o) => o.id === G || (o.type === 1 && o.id === BOT) || !(BigInt(o.allow) & B.VIEW)), at(`${c.name}: no role or member but the bot is let in`));
        for (const r of s.roles.filter((x) => x.id !== G && !x.managed && x.id !== keeper.id)) assert.equal(canView(s, c, [r.id]), false, at(`${c.name}: ${r.name} cannot see it`));
      }
    }
  }
  assert.equal(named.general.id, s.ids.general, at('Discord\'s #general is reused'));
  assert.equal(named.Lobby.id, s.ids.generalVoice, at('Discord\'s General voice is reused as Lobby'));
  const tagNames = (c) => c.available_tags.map((t) => `${t.name}${t.moderated ? '*' : ''}`).sort();
  assert.deepEqual(tagNames(named['bug-reports']), ['confirmed*', 'controller', 'desktop', 'fixed*', 'needs info*', 'phone'], at('bug report tags'));
  assert.deepEqual(tagNames(named.suggestions), ['done*', 'not planned*', 'planned*', 'under review*'], at('suggestion tags'));
  assert.equal(named.suggestions.default_reaction_emoji?.emoji_name, '👍', at('suggestions default reaction'));

  // Server
  const g = s.guild;
  assert.ok(g.features.includes('COMMUNITY'), at('Community on'));
  assert.deepEqual([g.verification_level, g.explicit_content_filter, g.default_message_notifications], [2, 2, 1], at('verification, filter, notifications'));
  assert.deepEqual([g.rules_channel_id, g.public_updates_channel_id, g.safety_alerts_channel_id], [named.rules.id, named['mod-log'].id, named['mod-log'].id], at('rules and updates channels'));
  assert.deepEqual([g.system_channel_id, g.system_channel_flags], [named.general.id, 6], at('system channel with join messages only'));
  assert.ok(g.icon, at('icon set'));
  assert.equal(s.me.username, 'RiftBot', at('bot username'));

  // Onboarding
  const ob = s.onboarding;
  assert.equal(ob.enabled, true, at('onboarding on'));
  const publicIds = LAYOUT.filter(([, access]) => ['readonly', 'news', 'public'].includes(access)).flatMap(([, , list]) => list.map(([name]) => named[name].id));
  assert.deepEqual([...ob.default_channel_ids].sort(), [...publicIds].sort(), at('default channels are the public ones'));
  assert.deepEqual(ob.prompts.map((p) => [p.title, p.single_select, p.required]), [['Read the rules?', true, false], ['What should we ping you about?', false, false]], at('onboarding prompts'));
  assert.deepEqual(ob.prompts[0].options.map((o) => [o.title, o.role_ids]), [["I've read #rules", [rifter.id]]], at('rules prompt grants Rifter'));
  assert.deepEqual(ob.prompts[1].options.map((o) => o.role_ids[0]), [newsPing.id, patchPing.id, eventPing.id], at('ping prompt'));

  // AutoMod
  const rules = Object.fromEntries(s.automod.map((r) => [r.trigger_type, r]));
  assert.equal(s.automod.length, 3, at('three AutoMod rules'));
  assert.deepEqual(rules[4].trigger_metadata.presets, [1, 2, 3], at('keyword presets'));
  assert.deepEqual([rules[5].trigger_metadata.mention_total_limit, rules[5].trigger_metadata.mention_raid_protection_enabled], [6, true], at('mention spam limit'));
  assert.ok(rules[5].actions.some((a) => a.type === 2 && a.metadata.channel_id === named['mod-log'].id), at('mention spam alerts #mod-log'));
  for (const r of s.automod) assert.ok(r.enabled && r.actions.some((a) => a.type === 1), at(`${r.name} blocks`));

  // Posts
  const mention = (text) => text.replace(/<#([a-z-]+)>/g, (_, name) => `<#${named[name].id}>`);
  const botMessages = (c) => (s.messages.get(c.id) ?? []).filter((msg) => msg.author.id === BOT);
  for (const name of ['welcome', 'rules', 'faq']) {
    assert.deepEqual(botMessages(named[name]).map((msg) => msg.content), [mention(APPROVED[name])], at(`#${name} has the approved post, once`));
  }
  for (const name of ['secret-hunt', 'dev-builds']) assert.equal(botMessages(named[name]).length, 1, at(`#${name} posted once`));
  // The News channels hold the release posts a fresh server gets from scripts/discord-releases.mjs:
  // each live version not marked posted, up to the first placeholder, once, crossposted. Live means
  // no newer than the fake riftborn.us serves (the live gate): a listed release waits until then.
  const link = (text) => text.replace(/\{#([a-z0-9-]+)\}/g, (_, name) => `<#${named[name].id}>`);
  const notNewer = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return true;
  };
  const live = releasesDue(RELEASES).filter((rel) => !rel.posted && notNewer(rel.version, fake.site.version));
  for (const [name, key, pingRole, flags] of [['announcements', 'announcement', newsPing, 0], ['patch-notes', 'patchNotes', patchPing, 4]]) {
    assert.deepEqual(botMessages(named[name]).map((msg) => [msg.content, msg.flags, msg.pinged]),
      live.map((rel) => [`${rel.ping?.[key] ? `<@&${pingRole.id}>\n` : ''}${link(rel[key])}`, flags | 1, rel.ping?.[key] ? [pingRole.id] : []]),
      at(`#${name} holds the live release posts, once each, crossposted`));
  }
  // A release post may ping its channel's one role, on its own first line; nothing else pings.
  const pingOf = { [named.announcements.id]: newsPing.id, [named['patch-notes'].id]: patchPing.id };
  for (const name of ['sneak-peeks', 'general', 'introductions', 'leaderboard-brags', 'builds-and-strategy', 'tester-chat', 'mod-chat', 'mod-log', 'game-feedback']) {
    assert.equal(botMessages(named[name]).length, 0, at(`#${name} has no bot post`));
  }
  for (const [forum, title] of [['bug-reports', 'How to report a bug'], ['suggestions', 'How to suggest an idea']]) {
    const threads = s.threads.filter((t) => t.parent_id === named[forum].id && t.owner_id === BOT);
    assert.deepEqual(threads.map((t) => [t.name, Boolean(t.flags & 2), t.thread_metadata.locked]), [[title, true, true]], at(`#${forum} starter post, once, pinned and locked`));
  }
  const allMessages = [...s.messages.values()].flat();
  for (const msg of allMessages) {
    assert.ok(msg.content.length <= 2000, at('message within 2000 characters'));
    const ownPing = `<@&${pingOf[msg.channel_id]}>\n`;
    const rest = pingOf[msg.channel_id] && msg.content.startsWith(ownPing) ? msg.content.slice(ownPing.length) : msg.content;
    assert.ok(!/@everyone|@here|<@&?\d+>/.test(rest), at('no pings in posts, but a release post\'s own role'));
    if (msg.author.id === BOT) assert.ok(!/password\s*[:=]/i.test(msg.content), at('no password in posts'));
  }
  assert.ok(allMessages.find((msg) => msg.content.includes('https://dev.riftborn.us')), at('dev build post'));
}

function role(s, id) { return s.roles.find((r) => r.id === id); }

// The release entries the script may post: everything before the first placeholder.
function releasesDue(list) {
  const block = list.findIndex((rel) => rel.announcement == null && rel.patchNotes == null);
  return block < 0 ? list : list.slice(0, block);
}

// Discord's role ranking: higher position first, and on a tie the older role (lower id).
function ranksAbove(a, b) { return a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id)); }

// What Discord does when the owner drags a role: every position spread out, the ranking kept.
function spreadRoles(s) {
  const ranked = s.roles.filter((r) => r.id !== s.ids.G).sort((a, b) => (ranksAbove(a, b) ? 1 : -1));
  ranked.forEach((r, i) => { r.position = i + 1; });
}
function canView(s, channel, roleIds) {
  let perms = BigInt(role(s, s.ids.G).permissions);
  for (const id of roleIds) perms |= BigInt(role(s, id).permissions);
  if (perms & B.ADMIN) return true;
  const everyone = channel.permission_overwrites.find((o) => o.id === s.ids.G);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of channel.permission_overwrites) if (o.type === 0 && roleIds.includes(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
  perms = (perms & ~deny) | allow;
  return (perms & B.VIEW) !== 0n;
}

// ---------------------------------------------------------------------------------------------
// The test

const phases = [...WORKFLOW.matchAll(/run: node scripts\/discord-setup\.mjs ([a-z-]+)/g)].map((m) => m[1]);
assert.deepEqual(phases, ['discover', 'roles', 'channels', 'community', 'news-forums', 'onboarding', 'automod', 'settings', 'posts', 'releases', 'profile', 'invite'], 'workflow phases and order');
assert.match(WORKFLOW, /\n {6}- name: Release posts\n {8}if: .+\n {8}run: node scripts\/discord-setup\.mjs releases\n {8}env:\n {10}DISCORD_SETUP_BOT_TOKEN: \$\{\{ secrets\.DISCORD_SETUP_BOT_TOKEN \}\}\n {6}- name: Bot profile\n/, 'the Release posts step runs after Posts with the step-level token');
assert.match(WORKFLOW, /permissions:\n {2}contents: read\n/, 'workflow permissions');
assert.doesNotMatch(WORKFLOW, /environment:/, 'workflow uses no environment');
const tokenLines = WORKFLOW.split('\n').filter((line) => line.includes('secrets.DISCORD_SETUP_BOT_TOKEN'));
assert.equal(tokenLines.length, phases.length, 'workflow token from secrets, once per setup step');
assert.ok(tokenLines.every((line) => line === '          DISCORD_SETUP_BOT_TOKEN: ${{ secrets.DISCORD_SETUP_BOT_TOKEN }}'), 'token is step-level only');
assert.equal((WORKFLOW.match(/run: node scripts\/discord-setup\.mjs [a-z-]+\n {8}env:\n {10}DISCORD_SETUP_BOT_TOKEN:/g) ?? []).length, phases.length, 'each setup step gets the token');
assert.doesNotMatch(WORKFLOW, /\n {4}env:/, 'no job-level env: checkout and setup-node never see the token');
assert.match(WORKFLOW, /workflow_dispatch:/, 'workflow can be run by hand');
for (const p of ['.github/workflows/discord-setup.yml', 'scripts/discord-setup.mjs', 'scripts/discord-releases.mjs']) assert.ok(WORKFLOW.includes(`- '${p}'`), `workflow runs on changes to ${p}`);

// The release list. 2.2.0 went out with the setup posts on 30 Sep 2026: it is marked posted, and its
// texts are byte for byte the ones posted (that is how it is recognised). Every filled-in entry
// starts with the bold first lines RiftBot finds it by and fits in a Discord message.
const shortV = (version) => version.replace(/\.0$/, '');
const RELEASE_MARK = { announcement: (v) => `**Riftborn ${shortV(v)} · `, patchNotes: (v) => `**v${shortV(v)} · ` };
assert.equal(RELEASES[0].version, '2.2.0', 'the release list starts at 2.2.0');
assert.equal(RELEASES[0].posted, true, '2.2.0 is marked posted, never sent again');
assert.equal(createHash('sha256').update(`${RELEASES[0].announcement}\n\n${RELEASES[0].patchNotes}`).digest('hex'),
  '6eb89b450b261913bcc1b018e9fa4ba310ccaa04ce9a7ae47c0c076874647224', 'the 2.2.0 texts are exactly the ones posted');
assert.ok(RELEASES.some((rel) => rel.version === '2.3.0'), '2.3.0 is listed');
for (const [i, rel] of RELEASES.entries()) {
  assert.match(rel.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `${rel.version}: MAJOR.MINOR.PATCH`);
  if (i) {
    const [a, b] = [RELEASES[i - 1].version, rel.version].map((v) => v.split('.').map(Number));
    assert.ok(b[0] > a[0] || (b[0] === a[0] && (b[1] > a[1] || (b[1] === a[1] && b[2] > a[2]))), `${rel.version} is newer than the entry above it`);
  }
  assert.equal(rel.announcement == null, rel.patchNotes == null, `${rel.version}: both texts or neither (a placeholder)`);
  for (const key of ['announcement', 'patchNotes']) {
    if (rel[key] == null) continue;
    assert.ok(rel[key].startsWith(RELEASE_MARK[key](rel.version)), `${rel.version}: ${key} starts with "${RELEASE_MARK[key](rel.version)}"`);
    assert.ok(rel[key].length + 60 <= 2000, `${rel.version}: ${key} fits in a Discord message`);
  }
}
// The triggers: a push that changes the Discord files, the end of each deploy of riftborn.us, and a run
// by hand. The deploy is named exactly as pages.yml names itself (GitHub matches the name), on main.
const ON = WORKFLOW.match(/\non:\n((?: {2}.*\n|\n)+)/)[1];
assert.deepEqual([...ON.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['push', 'workflow_run', 'workflow_dispatch'], 'the triggers');
const PAGES_NAME = PAGES_WORKFLOW.match(/^name: (.+)$/m)[1].trim();
assert.equal(PAGES_NAME, 'Build and deploy Riftborn to GitHub Pages and Cloudflare Pages', 'the deploy workflow\'s name');
assert.ok(ON.includes(`\n  workflow_run:\n    workflows: [${PAGES_NAME}]\n    types: [completed]\n    branches: [main]\n`), 'runs when the deploy of main completes');
assert.match(WORKFLOW, /\n {4}if: github\.ref == 'refs\/heads\/main' && \(github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success'\)\n/,
  'main only, and after a deploy only when it succeeded');
// Every step runs after Discover even when an earlier one fails; a workflow_run run is Discover guild
// and Release posts only (the settings step, and with it the icon, never runs then).
const stepIf = Object.fromEntries([...WORKFLOW.matchAll(/\n {6}- name: .+\n(?: {8}id: .+\n)?(?: {8}if: (.+)\n)? {8}run: node scripts\/discord-setup\.mjs ([a-z-]+)\n/g)].map((m) => [m[2], m[1] ?? '']));
assert.deepEqual(Object.keys(stepIf), phases, 'every setup step has its condition read');
for (const phase of phases) {
  const want = phase === 'discover' ? ''
    : phase === 'releases' ? "${{ !cancelled() && steps.discover.outcome == 'success' }}"
      : "${{ !cancelled() && steps.discover.outcome == 'success' && github.event_name != 'workflow_run' }}";
  assert.equal(stepIf[phase], want, `${phase}: ${phase === 'discover' ? 'runs on every trigger' : phase === 'releases' ? 'runs on every trigger once Discover succeeded' : 'skipped on workflow_run'}`);
}
// One Discord run at a time, and a running one is never cancelled (it may be mid-post). GitHub keeps
// one waiting run per group and a newer one replaces it, so a run whose job is skipped (a failed or
// cancelled deploy, a manual run off main) gets a group of its own: the group repeats the job's
// condition exactly, and is checked here by evaluating it (GitHub's && and || work as JavaScript's).
const JOB_IF = WORKFLOW.match(/\n {4}if: (github\.ref == .+)\n/)[1];
const GROUP = `\${{ ${JOB_IF} && 'discord-setup' || format('discord-setup-skipped-{0}', github.run_id) }}`;
assert.ok(WORKFLOW.includes(`\nconcurrency:\n  # The job's own condition (below): runs that will do something share discord-setup, and a run whose\n  # job is skipped gets a group of its own, so it can never replace a waiting run that would post.\n  group: ${GROUP}\n  cancel-in-progress: false\n`),
  "one run at a time, never cancelled, the group following the job's condition");
assert.equal((WORKFLOW.match(/^\s*concurrency:/gm) ?? []).length, 1, 'one concurrency setting, for the whole workflow');
const groupOf = new Function('github', 'format', `return ${GROUP.slice(4, -3).replace(/ == /g, ' === ').replace(/ != /g, ' !== ')};`);
const fmt = (pattern, ...args) => pattern.replace(/\{(\d+)\}/g, (_, i) => String(args[i]));
const groupFor = (event_name, conclusion, ref = 'refs/heads/main') => groupOf({ ref, event_name, run_id: 4242, event: conclusion ? { workflow_run: { conclusion } } : {} }, fmt);
assert.equal(groupFor('push'), 'discord-setup', 'a push to main shares the group');
assert.equal(groupFor('workflow_dispatch'), 'discord-setup', 'a manual run on main shares the group');
assert.equal(groupFor('workflow_run', 'success'), 'discord-setup', 'the run after a successful deploy shares the group');
for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
  assert.equal(groupFor('workflow_run', conclusion), 'discord-setup-skipped-4242', `after a deploy that ended ${conclusion}: a group of its own`);
}
assert.equal(groupFor('workflow_dispatch', null, 'refs/heads/dev'), 'discord-setup-skipped-4242', 'a manual run off main: a group of its own');

// The icon the workflow replaces on request: a one-shot workflow_dispatch input, handed to the settings
// step only through an env var, and never interpolated into a shell command.
assert.match(WORKFLOW, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}replace_icon:\n(?: {8}description: .+\n)? {8}type: boolean\n {8}default: false\n/, 'replace_icon is an unticked boolean workflow_dispatch input');
assert.equal((ON.match(/^ +inputs:/gm) ?? []).length, 1, 'only workflow_dispatch has inputs (push and workflow_run have none)');
const replaceLines = WORKFLOW.split('\n').filter((line) => line.includes('DISCORD_SETUP_REPLACE_ICON:'));
assert.deepEqual(replaceLines, ["          DISCORD_SETUP_REPLACE_ICON: ${{ github.event_name == 'workflow_dispatch' && inputs.replace_icon && 'true' || '' }}"], 'one env line carries the flag, empty unless a manual run ticked it');
assert.match(WORKFLOW, /run: node scripts\/discord-setup\.mjs settings\n {8}env:\n {10}DISCORD_SETUP_BOT_TOKEN: .+\n(?: {10}#.*\n)? {10}DISCORD_SETUP_REPLACE_ICON:/, 'only the settings step gets the flag');
assert.equal((WORKFLOW.match(/\$\{\{[^}]*\binputs\./g) ?? []).length, 1, 'the input is read in exactly one place');
assert.ok(!WORKFLOW.split('\n').some((line) => /\brun:/.test(line) && line.includes('${{')), 'no expression is ever interpolated into a run: command');

// The icon files: the skull badge is the approved logo-v3 avatar (1024 px, never redrawn), the Rift
// Portal is the icon the server wears today. Both are real PNGs Discord accepts as a server icon.
const ICON_DIR = path.join(ROOT, 'scripts', 'discord-assets');
const ICON_NEW = readFileSync(path.join(ICON_DIR, 'riftborn-skull-1024.png'));
const ICON_OLD = readFileSync(path.join(ICON_DIR, 'riftborn-portal-512.png'));
const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
for (const [name, buf, side] of [['riftborn-skull-1024.png', ICON_NEW, 1024], ['riftborn-portal-512.png', ICON_OLD, 512]]) {
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.subarray(12, 16).toString() === 'IHDR', `${name} is a PNG`);
  assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [side, side], `${name} is ${side} x ${side}`);
  assert.ok(buf.length < 1_000_000, `${name} is far under Discord's size limit`);
}
assert.equal(createHash('sha256').update(ICON_NEW).digest('hex'), '606420da5aa4e9f969c0c25d6e372f3479f9cd13dec32782e171bc016597008d',
  'riftborn-skull-1024.png is byte for byte the approved brand/logo-v3/final/avatar-1024.png');
assert.match(readFileSync(SCRIPT, 'utf8'), /\nconst ICON_REVISION = 2;\n/, 'the script uploads icon revision 2 (the skull badge)');

const fake = createFakeDiscord();
const base = await fake.start();
// riftborn.us is the fake too (site.config.mjs's test override), so no run ever asks the real site.
const SITE = base.replace(/\/api\/v10$/, '');
const env = envWith({ DISCORD_SETUP_BOT_TOKEN: TOKEN, DISCORD_SETUP_API_BASE: base, RIFTBORN_TEST_LIVE_ORIGIN: SITE });
const G = fake.state.ids.G;
const writes = () => fake.calls.filter((c) => c.method !== 'GET' && c.status < 400);
let releaseDir = null; // the script copy the release posts run from (7b)

try {
  // 1. A fresh server.
  await runAll(phases, env, 'run 1');
  assertDesiredState(fake, 'run 1');
  const firstIcon = writes().filter((c) => c.method === 'PATCH' && c.route === `/guilds/${G}` && 'icon' in JSON.parse(c.body));
  assert.equal(firstIcon.length, 1, 'run 1: the icon is uploaded once, to a server with none');
  assert.deepEqual(Object.keys(JSON.parse(firstIcon[0].body)), ['icon'], 'run 1: the icon goes on its own');
  assert.equal(JSON.parse(firstIcon[0].body).icon, dataUri(ICON_NEW), 'run 1: the icon is the skull badge, unchanged');
  assert.equal(fake.state.guild.icon, iconHash(dataUri(ICON_NEW)), 'run 1: the server wears the skull badge');
  assert.ok(fake.calls.some((c) => c.status === 429 && c.method === 'POST' && c.route === `/guilds/${G}/channels`), 'bucket 429 happened');
  assert.ok(fake.calls.some((c) => c.status === 429 && c.route === '/users/@me/guilds'), 'global 429 happened');
  assert.ok(fake.calls.some((c) => c.status === 502 && c.route === `/guilds/${G}`), '502 happened');
  assert.equal(fake.faults.rateLimit.size + fake.faults.globalRateLimit.size + fake.faults.serverError.size, 0, 'every fault was hit');
  for (const c of fake.calls.filter((x) => x.method !== 'GET')) assert.equal(c.reason, 'Riftborn setup', `audit log reason on ${c.method} ${c.route}`);
  for (const c of fake.calls.filter((x) => x.method === 'POST' && /\/(messages|threads)$/.test(x.route))) {
    const body = JSON.parse(c.body);
    const msg = body.message ?? body;
    const roles = [...msg.content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
    assert.deepEqual(msg.allowed_mentions, roles.length ? { parse: [], roles } : { parse: [] }, 'posts ping nobody, or exactly the release ping role');
  }
  assert.match(output.join('\n'), /::notice title=Roles::.*@everyone lost MENTION_EVERYONE, CREATE_GUILD_EXPRESSIONS, CREATE_EVENTS \(was \d+, now \d+\)/, 'roles notice names what @everyone lost');
  const run1Writes = writes().length;

  // 2. A second run changes nothing.
  fake.calls.length = 0;
  await runAll(phases, env, 'run 2');
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], 'run 2 makes no writes');
  assertDesiredState(fake, 'run 2');

  // 3. Drift converges: a deleted channel, a cleared topic, swapped roles, a role let into #game-feedback.
  const s = fake.state;
  const byName = (name) => s.channels.find((c) => c.name === name);
  const [testerRole, modRole] = ['Tester', 'Moderator'].map((name) => s.roles.find((r) => r.name === name));
  spreadRoles(s); // the owner dragged a role in Server Settings: Discord spread the positions out
  [testerRole.position, modRole.position] = [modRole.position, testerRole.position];
  const [, helper] = fake.handle('POST', `/guilds/${G}/roles`, { name: 'Helper', permissions: '0' });
  byName('game-feedback').permission_overwrites.push({ id: helper.id, type: 0, allow: String(B.VIEW | B.SEND), deny: '0' });
  byName('general').topic = null;
  s.channels = s.channels.filter((c) => c.name !== 'fan-art');
  fake.calls.length = 0;
  await runAll(phases, env, 'run 3 (drift)');
  const creates = writes().filter((c) => c.method === 'POST');
  assert.deepEqual(creates.map((c) => [c.route, JSON.parse(c.body).name]), [[`/guilds/${G}/channels`, 'fan-art']], 'drift: only #fan-art is created');
  assert.ok(writes().some((c) => c.method === 'PATCH' && c.route === `/guilds/${G}/roles`), 'drift: roles reordered');
  assertDesiredState(fake, 'run 3');
  assert.ok(s.roles.some((r) => r.name === 'Helper'), 'roles the script does not own are left alone');

  // 3b. Tied positions (every role made through the API sits at position 1): the bot's older role
  // ranks above them, so a server in creation order passes with no writes. A role remade later
  // (newer id) sorts last, and the bot cannot spread tied positions: it asks the owner to drag.
  const saved = s.roles.map((r) => [r, r.position, r.id]);
  for (const r of s.roles) if (r.id !== G) r.position = 1;
  s.roles.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const helperRole = s.roles.find((r) => r.name === 'Helper');
  s.roles = s.roles.filter((r) => r !== helperRole);
  fake.calls.length = 0;
  const tied = await run(['discover', 'roles'], env);
  assert.equal(tied.code, 0, `tied positions in creation order\n${tied.text}`);
  assert.match(tied.stdout, /its role ranks 1 of 8 from the top/, 'discover reports the rank, not the raw position');
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], 'tied and in order: no writes');
  const oldTesterId = testerRole.id;
  testerRole.id = fake.sf();
  const remade = await run(['roles'], env);
  assert.equal(remade.code, 1, 'a remade role out of order with tied positions fails');
  assert.match(remade.stdout, /::error title=Roles::the Riftborn roles are out of order: drag them into order under RiftBot \(Rift Keeper, Moderator, Tester, Rifter, News pings, Patch pings, Event pings\)/, 'asks the owner to drag');
  assert.doesNotMatch(remade.stdout, /must be above/, 'the bot is not blamed');
  assert.ok(!writes().some((c) => c.method === 'PATCH' && c.route === `/guilds/${G}/roles`), 'no reorder attempted');
  testerRole.id = oldTesterId;
  s.roles.push(helperRole);
  for (const [r, position] of saved) r.position = position;

  // 4. A rejected onboarding reports Discord's error; the other phases still pass.
  s.onboarding.enabled = false;
  fake.faults.onboardingReject = true;
  const rejected = await run(['onboarding'], env);
  assert.equal(rejected.code, 1, 'onboarding step fails');
  assert.match(rejected.stdout, /::error title=Onboarding::save onboarding: HTTP 400, code 50035: Invalid Form Body \(default_channel_ids: GUILD_ONBOARDING_DEFAULT_CHANNELS_INVALID/, 'exact Discord error reported');
  for (const phase of ['automod', 'settings', 'posts', 'profile']) assert.equal((await run([phase], env)).code, 0, `${phase} still passes`);
  fake.faults.onboardingReject = false;
  assert.equal((await run(['onboarding'], env)).code, 0, 'onboarding passes once Discord accepts it');

  // 4b. Community off again (the ids are still set): the News and forum channels step fails instead
  // of passing green, and Community comes back in one request with both ids.
  s.guild.features = s.guild.features.filter((f) => f !== 'COMMUNITY');
  const newsOff = await run(['news-forums'], env);
  assert.equal(newsOff.code, 1, 'news-forums fails while Community is off');
  assert.match(newsOff.stdout, /::error title=News and forum channels::Community is off/, 'news-forums says why');
  assert.equal((await run(['community'], env)).code, 0, 'Community turns on with the ids already set');
  assert.ok(s.guild.features.includes('COMMUNITY'), 'Community back on');

  // 4c. A rejected icon does not hold back the other settings.
  s.guild.icon = null;
  s.guild.system_channel_flags = 0;
  fake.faults.iconReject = true;
  const iconFail = await run(['settings'], env);
  assert.equal(iconFail.code, 1, 'settings step fails on a rejected icon');
  assert.match(iconFail.stdout, /::error title=Server settings and icon::set server icon: HTTP 400, code 50035/, 'icon error reported');
  assert.deepEqual([s.guild.system_channel_flags, s.guild.icon], [6, null], 'settings applied without the icon');
  fake.faults.iconReject = false;
  assert.equal((await run(['settings'], env)).code, 0, 'icon set on the next run');
  assert.ok(s.guild.icon, 'icon set');
  assert.equal(s.guild.icon, iconHash(dataUri(ICON_NEW)), 'the icon set from nothing is the skull badge');

  // 4c2. The icon on a server that already has one (here the Rift Portal it wears today).
  const replaceEnv = (flag) => envWith({ DISCORD_SETUP_BOT_TOKEN: TOKEN, DISCORD_SETUP_API_BASE: base, DISCORD_SETUP_REPLACE_ICON: flag });
  const hashOld = iconHash(dataUri(ICON_OLD));
  const hashNew = iconHash(dataUri(ICON_NEW));
  const iconWrites = () => writes().filter((c) => c.method === 'PATCH' && c.route === `/guilds/${G}` && 'icon' in JSON.parse(c.body));
  // No flag, or the flag off: left exactly as it is, nothing written.
  for (const flag of [undefined, '', 'false', '0', 'FALSE']) {
    s.guild.icon = hashOld;
    fake.calls.length = 0;
    const kept = await run(['settings'], flag === undefined ? env : replaceEnv(flag));
    assert.equal(kept.code, 0, `icon present, flag ${JSON.stringify(flag)}\n${kept.text}`);
    assert.match(kept.stdout, /::notice title=Server settings and icon::server settings unchanged; icon already set \(left as it is\); /, `flag ${JSON.stringify(flag)}: the icon is left as it is`);
    assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], `flag ${JSON.stringify(flag)}: nothing written`);
    assert.equal(s.guild.icon, hashOld, `flag ${JSON.stringify(flag)}: the icon is unchanged`);
  }
  // The flag on another phase does nothing to the icon.
  fake.calls.length = 0;
  assert.equal((await run(['profile'], replaceEnv('true'))).code, 0, 'the flag is ignored by other phases');
  assert.deepEqual(iconWrites(), [], 'other phases never touch the icon');
  // Flag on: exactly one PATCH, with the new image alone, and the revision in the audit log reason.
  for (const flag of ['true', '1']) {
    s.guild.icon = hashOld;
    fake.calls.length = 0;
    const replaced = await run(['settings'], replaceEnv(flag));
    assert.equal(replaced.code, 0, `replace with flag ${flag}\n${replaced.text}`);
    assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [`PATCH /guilds/${G}`], `flag ${flag}: one write`);
    const [patch] = writes();
    assert.deepEqual(JSON.parse(patch.body), { icon: dataUri(ICON_NEW) }, `flag ${flag}: the new image, and nothing else`);
    assert.equal(patch.reason, 'Riftborn setup: replace server icon with revision 2 (riftborn-skull-1024.png)', `flag ${flag}: audit log reason names the revision`);
    assert.equal(s.guild.icon, hashNew, `flag ${flag}: the server wears the skull badge`);
    assert.ok(replaced.stdout.includes(`::notice title=Server settings and icon::server settings unchanged; icon replaced with the Riftborn skull badge (revision 2, riftborn-skull-1024.png): was hash ${hashOld}, now https://cdn.discordapp.com/icons/${G}/${hashNew}.png; `), `flag ${flag}: the annotation says what was replaced`);
    assert.doesNotMatch(replaced.stdout, /::error/, `flag ${flag}: no error`);
  }
  // Flag on and Discord already has this image (same hash): reported, nothing claimed as changed.
  fake.calls.length = 0;
  const same = await run(['settings'], replaceEnv('true'));
  assert.equal(same.code, 0, `replace with the same image\n${same.text}`);
  assert.match(same.stdout, new RegExp(`icon replace requested: Discord already had this image, nothing changed \\(the Riftborn skull badge \\(revision 2, riftborn-skull-1024\\.png\\), hash ${hashNew}\\)`), 'same image reported');
  assert.equal(s.guild.icon, hashNew, 'same image: icon unchanged');
  // The next normal run leaves the new icon alone.
  fake.calls.length = 0;
  assert.equal((await run(['settings'], env)).code, 0, 'normal run after the replace');
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], 'normal run after the replace: no writes');
  // Rejected by Discord: the old icon stays, the error is reported, the other settings still apply.
  s.guild.icon = hashOld;
  s.guild.system_channel_flags = 0;
  fake.faults.iconReject = true;
  const noReplace = await run(['settings'], replaceEnv('true'));
  fake.faults.iconReject = false;
  assert.equal(noReplace.code, 1, 'a rejected replace fails the step');
  assert.match(noReplace.stdout, /::error title=Server settings and icon::replace server icon: HTTP 400, code 50035: Invalid Form Body \(icon: BASE_TYPE_INVALID Invalid image data\)/, 'replace error reported');
  assert.match(noReplace.stdout, /::notice title=Server settings and icon::server settings updated \(system_channel_flags\); icon not replaced \(the current icon is kept\); /, 'summary says the icon was kept');
  assert.deepEqual([s.guild.system_channel_flags, s.guild.icon], [6, hashOld], 'rejected replace: settings applied, icon kept');
  // Flag on but the server has no icon: it is simply set (and the note says so).
  s.guild.icon = null;
  fake.calls.length = 0;
  const bare = await run(['settings'], replaceEnv('true'));
  assert.equal(bare.code, 0, `replace on a server with no icon\n${bare.text}`);
  assert.equal(s.guild.icon, hashNew, 'no icon + flag: the skull badge is set');
  assert.match(bare.stdout, /icon set to the Riftborn skull badge \(revision 2, riftborn-skull-1024\.png\) \(replace was requested, the server had no icon\)/, 'no icon + flag: noted');
  assert.equal(writes()[0].reason, 'Riftborn setup', 'setting a first icon keeps the plain audit log reason');
  // The flag is refused before any request: an unknown value, and any GitHub Actions trigger but a manual run.
  const sentBefore = fake.calls.length;
  const junk = await run(['settings'], replaceEnv('yes'));
  assert.equal(junk.code, 1, 'an unknown flag value is an error');
  assert.match(junk.stdout, /::error title=Server settings and icon::DISCORD_SETUP_REPLACE_ICON must be "true" or "1" \(or empty\): the icon was not touched/, 'unknown value explained');
  for (const event of ['push', 'workflow_run', 'schedule', '']) {
    const refused = await run(['settings'], envWith({ GITHUB_ACTIONS: 'true', ...(event ? { GITHUB_EVENT_NAME: event } : {}), DISCORD_SETUP_REPLACE_ICON: 'true' }));
    assert.equal(refused.code, 1, `a ${event || 'no-event'} run cannot replace the icon`);
    assert.match(refused.stdout, /::error title=Server settings and icon::the server icon is replaced only by a manual run of the workflow \(workflow_dispatch with "replace_icon" ticked\), not by /, `${event || 'no-event'}: refused with the reason`);
    assert.doesNotMatch(refused.stdout, /BOT_TOKEN is not set/, `${event || 'no-event'}: refused before anything else`);
  }
  // A manual run passes that check (and then stops at the missing token: no request is ever sent here).
  const manual = await run(['settings'], envWith({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', DISCORD_SETUP_REPLACE_ICON: 'true' }));
  assert.equal(manual.code, 1);
  assert.match(manual.stdout, /::error title=Server settings and icon::DISCORD_SETUP_BOT_TOKEN is not set/, 'workflow_dispatch passes the trigger check');
  assert.equal(fake.calls.length, sentBefore, 'refused flag runs send nothing');
  s.guild.system_channel_flags = 6;

  // 4d. Busy channels: 60 member messages after the bot's posts, and the bug-report guide archived
  // behind 120 newer archived posts. No second copy is posted.
  const MEMBER = fake.sf();
  for (const name of ['secret-hunt', 'dev-builds']) {
    const id = byName(name).id;
    for (let i = 0; i < 60; i += 1) s.messages.set(id, [...s.messages.get(id), { id: fake.sf(), channel_id: id, author: { id: MEMBER }, content: `clue ${i}`, flags: 0 }]);
  }
  const bugForum = byName('bug-reports').id;
  const guide = s.threads.find((t) => t.parent_id === bugForum && t.owner_id === s.ids.BOT);
  Object.assign(guide.thread_metadata, { archived: true, archive_timestamp: '2026-01-01T00:00:00.000Z' });
  for (let i = 0; i < 120; i += 1) {
    s.threads.push({ id: fake.sf(), guild_id: G, type: 11, parent_id: bugForum, owner_id: MEMBER, name: `bug ${i}`, flags: 0,
      thread_metadata: { archived: true, locked: false, archive_timestamp: new Date(Date.UTC(2026, 1, 1) + i * 60_000).toISOString() } });
  }
  fake.calls.length = 0;
  assert.equal((await run(['posts'], env)).code, 0, 'posts pass on busy channels');
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], 'busy channels: no second post');
  assert.ok(fake.calls.filter((c) => c.route === `/channels/${bugForum}/threads/archived/public`).length >= 2, 'archived posts paged');

  // 4e. Many errors in one step: 2 shown, then one "N more" line.
  fake.faults.messagesReadDenied = true;
  const noRead = await run(['posts'], env);
  fake.faults.messagesReadDenied = false;
  assert.equal(noRead.code, 1);
  const errorLines = noRead.stdout.split('\n').filter((line) => line.startsWith('::error '));
  assert.equal(errorLines.length, 3, 'two errors and a "more" line');
  assert.match(errorLines[2], /::error title=Posts::3 more errors in the step log/, 'the rest are counted');
  assert.match(noRead.stdout, /::notice title=Posts::posts: 0 posted, 2 already there/, 'summary still written on failure');

  // 5. "all" on a finished server: no writes.
  fake.calls.length = 0;
  const all = await run(['all'], env);
  assert.equal(all.code, 0, `all\n${all.text}`);
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], '"all" on a finished server makes no writes');
  assertDesiredState(fake, 'final');

  // 6. Secrets in a Discord error are scrubbed from annotations.
  fake.faults.echoSecret.add('automod');
  const echoed = await run(['automod'], env);
  fake.faults.echoSecret.clear();
  assert.equal(echoed.code, 1);
  assert.match(echoed.stdout, /::error title=AutoMod::HTTP 400, code 50001: Invalid token \*\*\* for \[webhook url\]/, 'secret scrubbed from the error');

  // 6b. Discord's own Block Mention Spam rule can be read but not changed (PATCH 404) or replaced
  // (one per server): the step leaves it as it is, says so, and passes.
  const mentionAt = s.automod.findIndex((r) => r.trigger_type === 5);
  const ourMention = s.automod[mentionAt];
  s.automod[mentionAt] = { id: fake.sf(), guild_id: G, creator_id: fake.sf(), name: 'Block Mention Spam', event_type: 1, trigger_type: 5, enabled: true,
    trigger_metadata: { mention_total_limit: 20, mention_raid_protection_enabled: true }, actions: [{ type: 1, metadata: {} }], exempt_roles: [], exempt_channels: [] };
  fake.calls.length = 0;
  const systemRule = await run(['automod'], env);
  assert.equal(systemRule.code, 0, `Discord's own mention spam rule\n${systemRule.text}`);
  assert.match(systemRule.stdout, /::notice title=AutoMod::AutoMod: 0 created, 0 updated, 2 unchanged \(words preset and spam\)\. Discord's own "Block Mention Spam" rule is on, limit 20, raid protection on, no alert channel\. Bots cannot change it/, 'says it was left as Discord made it');
  assert.doesNotMatch(systemRule.stdout, /::error/, 'no error for the system rule');
  assert.equal(s.automod[mentionAt].trigger_metadata.mention_total_limit, 20, 'the system rule is unchanged');
  assert.deepEqual(writes().map((c) => `${c.method} ${c.route}`), [], 'nothing written');
  s.automod[mentionAt] = ourMention;

  // 6c. Join messages: the settings step says where they go and, as counts only, who is still on the
  // onboarding questions (Discord posts "Glad you're here" once a member finishes them).
  const FRIEND = fake.sf(), EARLIER = fake.sf();
  s.members.set(EARLIER, { user: { id: EARLIER }, roles: [], flags: 2, joined_at: '2026-09-30T18:00:00.000Z' });
  s.members.set(FRIEND, { user: { id: FRIEND }, roles: [], flags: 8, joined_at: '2026-09-30T20:00:00.000Z' });
  const generalId = byName('general').id;
  s.messages.set(generalId, [...(s.messages.get(generalId) ?? []), { id: fake.sf(), type: 7, author: { id: EARLIER }, content: '' }]);
  const joinsRun = await run(['settings'], env);
  assert.equal(joinsRun.code, 0, `settings with members\n${joinsRun.text}`);
  assert.match(joinsRun.stdout, /join messages on in #general \(1 in its last \d+ messages\); 3 people: 1 finished onboarding, 1 still answering its questions, 1 joined without it; newest member still answering the onboarding questions, no join message yet/, 'join report');
  assert.ok(!joinsRun.stdout.includes(FRIEND) && !joinsRun.stdout.includes(EARLIER), 'no member ids in the report');
  fake.faults.membersIntentOff = true;
  const noIntent = await run(['settings'], env);
  fake.faults.membersIntentOff = false;
  assert.equal(noIntent.code, 0, 'a missing intent is not a failure');
  assert.match(noIntent.stdout, /member onboarding states unreadable \(HTTP 403, code 50001: Missing Access\): turn on Server Members Intent/, 'says how to see member states');
  s.members.delete(FRIEND);
  s.members.delete(EARLIER);
  s.messages.set(generalId, s.messages.get(generalId).filter((m) => m.type !== 7));

  // 7. Guards.
  let calls = fake.calls.length;
  const noToken = await run(['discover'], envWith({ DISCORD_SETUP_API_BASE: base }));
  assert.equal(noToken.code, 1);
  assert.match(noToken.stdout, /::error title=Discover guild::DISCORD_SETUP_BOT_TOKEN is not set/);
  for (const ci of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const refused = await run(['discover'], envWith({ ...ci, DISCORD_SETUP_BOT_TOKEN: TOKEN, DISCORD_SETUP_API_BASE: base }));
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /refused in CI/);
  }
  const offLoopback = await run(['discover'], envWith({ DISCORD_SETUP_BOT_TOKEN: TOKEN, DISCORD_SETUP_API_BASE: 'http://example.com/api/v10' }));
  assert.equal(offLoopback.code, 1);
  assert.match(offLoopback.stdout, /loopback/);
  assert.equal(fake.calls.length, calls, 'refused runs send nothing');
  s.extraGuilds.push({ id: '42', name: 'Another server' });
  const twoGuilds = await run(['discover'], env);
  assert.equal(twoGuilds.code, 1);
  assert.match(twoGuilds.stdout, /::error title=Discover guild::expected the bot in exactly one guild \("Riftborn"\), found 2/);
  s.extraGuilds.length = 0;
  s.guild.name = 'Something else';
  const wrongName = await run(['posts'], env);
  assert.equal(wrongName.code, 1);
  assert.match(wrongName.stdout, /expected "Riftborn"/);
  s.guild.name = 'Riftborn';
  assert.equal((await run(['nonsense'], env)).code, 2, 'unknown phase');

  // 7b. Release posts, run from a copy of the script beside a test list of releases. The News
  // channels start as on the live server: RiftBot's 2.2 posts (made by the posts phase, never
  // crossposted), the announcement behind 150 newer Rift Keeper messages. The copy sits in the
  // repository's layout (scripts/ beside the site config it reads the live host from). riftborn.us
  // serves 2.3.4 until 7c, so every version here is live already (2.3.4 itself the equal case).
  releaseDir = mkdtempSync(path.join(os.tmpdir(), 'riftborn-releases-'));
  mkdirSync(path.join(releaseDir, 'scripts'));
  const COPY = path.join(releaseDir, 'scripts', 'discord-setup.mjs');
  cpSync(SCRIPT, COPY);
  for (const file of ['site.config.mjs', 'site.hosts.mjs']) cpSync(path.join(ROOT, file), path.join(releaseDir, file));
  fake.site.version = '2.3.4';
  const releases = (list, runEnv = env) => {
    writeFileSync(path.join(releaseDir, 'scripts', 'discord-releases.mjs'), typeof list === 'string' ? list : `export const RELEASES = ${JSON.stringify(list, null, 2)};\n`);
    fake.calls.length = 0;
    fake.site.calls.length = 0;
    return run(['releases'], runEnv, COPY, 30_000);
  };
  const ann = byName('announcements');
  const pn = byName('patch-notes');
  const linkNews = (text) => text.replace(/\{#([a-z0-9-]+)\}/g, (_, name) => `<#${byName(name).id}>`);
  const botPost = (c, content, flags) => ({ id: fake.sf(), channel_id: c.id, author: { id: s.ids.BOT, bot: true }, content, flags, pinged: [] });
  const keeperPost = (c, i) => ({ id: fake.sf(), channel_id: c.id, author: { id: s.ids.OWNER }, content: `Keeper note ${i}`, flags: 0, pinged: [] });
  const [r22] = RELEASES;
  const seedNews = () => {
    s.messages.set(ann.id, [botPost(ann, linkNews(r22.announcement), 0), ...Array.from({ length: 150 }, (_, i) => keeperPost(ann, i))]);
    s.messages.set(pn.id, [botPost(pn, linkNews(r22.patchNotes), 4)]);
  };
  const PATCH = s.roles.find((r) => r.name === 'Patch pings').id;
  const NEWS = s.roles.find((r) => r.name === 'News pings').id;
  const entry = (version, title, ping = { announcement: false, patchNotes: true }) => ({
    version, ping,
    announcement: `**Riftborn ${shortV(version)} · ${title}** 🌋\nBigger worlds to get lost in. Highlights in {#patch-notes}, full notes in-game. ▶️ https://riftborn.us`,
    patchNotes: `**v${shortV(version)} · ${title}** (1 Oct 2026)\n- **Bigger worlds:** every world is larger.\n\nFull notes in-game: **PATCH NOTES** on the main menu.`,
  });
  const placeholder = (version) => ({ version, ping: { announcement: false, patchNotes: true }, announcement: null, patchNotes: null });
  // The step's summary, a notice (or a warning, when riftborn.us could not be read), and which it was.
  const summaryLine = (result) => result.stdout.split('\n').map((line) => line.match(/^::(notice|warning) title=Release posts::(.*)$/)).find(Boolean);
  const notice = (result) => summaryLine(result)?.[2];
  const level = (result) => summaryLine(result)?.[1];
  const newsWrites = () => writes().map((c) => `${c.method} ${c.route}`);
  const botNews = (c) => s.messages.get(c.id).filter((msg) => msg.author.id === s.ids.BOT);
  const PLACEHOLDER_NOTE = 'a placeholder in scripts/discord-releases.mjs';

  // 2.2 up and 2.3 a placeholder: nothing is sent, and the history is paged to find 2.2.
  seedNews();
  const waiting = await releases([r22, placeholder('2.3.0')]);
  assert.equal(waiting.code, 0, `2.2 up, 2.3 a placeholder\n${waiting.text}`);
  assert.equal(notice(waiting), `releases: 2.2.0 already posted; 2.3.0 waits for its texts (${PLACEHOLDER_NOTE})`, 'placeholder notice');
  assert.deepEqual(newsWrites(), [], 'placeholder: nothing written');
  assert.ok(fake.calls.filter((c) => c.route === `/channels/${ann.id}/messages`).length >= 2, 'the announcement history is paged');
  // The real list never sends 2.2 again (whatever state its 2.3.0 entry is in).
  fake.calls.length = 0;
  const realList = await run(['releases'], env);
  assert.equal(realList.code, 0, `the real release list\n${realList.text}`);
  assert.match(notice(realList), /^releases: 2\.2\.0 already posted/, 'the real list recognises 2.2');
  assert.ok(writes().every((c) => !/\*\*(Riftborn 2\.2|v2\.2) ·/.test(c.body)), 'the real list never sends 2.2 again');

  // A new 2.3: posted once to each channel, crossposted, Patch pings pinged and nothing else.
  seedNews();
  const list23 = [r22, entry('2.3.0', 'Bigger Worlds')];
  const posted = await releases(list23);
  assert.equal(posted.code, 0, `2.3 posted\n${posted.text}`);
  assert.equal(notice(posted), 'releases: 2.2.0 already posted; 2.3.0 posted to #announcements and #patch-notes (crossposted, pinged Patch pings)', '2.3 notice');
  const [a23, p23] = [botNews(ann).at(-1), botNews(pn).at(-1)];
  assert.deepEqual(newsWrites(), [`POST /channels/${ann.id}/messages`, `POST /channels/${ann.id}/messages/${a23.id}/crosspost`,
    `POST /channels/${pn.id}/messages`, `POST /channels/${pn.id}/messages/${p23.id}/crosspost`], '2.3: one post and one crosspost per channel');
  const bodies = writes().filter((c) => c.route.endsWith('/messages')).map((c) => JSON.parse(c.body));
  assert.deepEqual(bodies[0], { content: linkNews(list23[1].announcement), allowed_mentions: { parse: [] } }, 'announcement: no ping, link previews kept');
  assert.deepEqual(bodies[1], { content: `<@&${PATCH}>\n${linkNews(list23[1].patchNotes)}`, allowed_mentions: { parse: [], roles: [PATCH] }, flags: 4 }, 'patch notes: Patch pings only, previews off');
  assert.deepEqual([a23.pinged, a23.flags, p23.pinged, p23.flags], [[], 1, [PATCH], 5], 'as Discord sees them: pings and crossposts');
  assert.deepEqual([botNews(ann).length, botNews(pn).length], [2, 2], 'one new post per channel');
  assert.deepEqual([botNews(ann)[0].flags, botNews(pn)[0].flags], [0, 4], '2.2 is not crossposted after the fact');

  // A second run writes nothing.
  const again = await releases(list23);
  assert.equal(again.code, 0, `second run\n${again.text}`);
  assert.equal(notice(again), 'releases: 2.2.0 and 2.3.0 already posted', 'second run notice');
  assert.deepEqual(newsWrites(), [], 'second run: no writes');
  assert.equal(fake.site.calls.length, 0, 'nothing to post: riftborn.us is not asked');

  // 2.3.1 pings both roles (and its marker never matches 2.3's post); a placeholder 2.4.0 holds back
  // itself and the 2.4.1 after it.
  const list231 = [...list23, entry('2.3.1', 'Hotfix', { announcement: true, patchNotes: true }), placeholder('2.4.0'), entry('2.4.1', 'Later')];
  const both = await releases(list231);
  assert.equal(both.code, 0, `2.3.1\n${both.text}`);
  assert.equal(notice(both), `releases: 2.2.0 and 2.3.0 already posted; 2.3.1 posted to #announcements and #patch-notes (crossposted, pinged News pings and Patch pings); 2.4.0 waits for its texts (${PLACEHOLDER_NOTE}); 2.4.1 waits for 2.4.0`, '2.3.1 notice');
  assert.equal(writes().length, 4, '2.3.1: two posts, two crossposts');
  assert.deepEqual(writes().filter((c) => c.route.endsWith('/messages')).map((c) => JSON.parse(c.body).allowed_mentions),
    [{ parse: [], roles: [NEWS] }, { parse: [], roles: [PATCH] }], 'each ping can reach its one role only');
  assert.deepEqual([botNews(ann).at(-1).pinged, botNews(pn).at(-1).pinged], [[NEWS], [PATCH]], 'News pings in #announcements, Patch pings in #patch-notes');
  assert.ok(![...s.messages.values()].flat().some((msg) => /\*\*(Riftborn |v)2\.4/.test(msg.content)), 'a placeholder and what follows it are never posted');

  // Crossposts that fail (an hour-long rate limit, not waited out; an error that echoes secrets) fail
  // the step after posting; the next run crossposts them without posting again.
  const list232 = [...list231.slice(0, 3), entry('2.3.2', 'Fixes', { announcement: false, patchNotes: false })];
  fake.faults.crosspostRateLimit.add(ann.id);
  fake.faults.echoSecret.add('crosspost');
  const started = Date.now();
  const flaky = await releases(list232);
  fake.faults.echoSecret.clear();
  assert.equal(flaky.code, 1, 'failed crossposts fail the step');
  assert.ok(Date.now() - started < 30_000, 'an hour-long publish rate limit is not waited out');
  assert.match(flaky.stdout, /::error title=Release posts::crosspost 2\.3\.2 in #announcements: HTTP 429: You are being rate limited\. \(retry after 3600 s\) \(the next run crossposts it\)/, 'rate limit reported');
  assert.match(flaky.stdout, /::error title=Release posts::crosspost 2\.3\.2 in #patch-notes: HTTP 400, code 50001: Invalid token \*\*\* for \[webhook url\]/, 'secret scrubbed from the crosspost error');
  assert.equal(notice(flaky), 'releases: 2.2.0, 2.3.0 and 2.3.1 already posted; 2.3.2 posted to #announcements and #patch-notes (not crossposted, no pings)', 'not crossposted notice');
  const retried = await releases(list232);
  assert.equal(retried.code, 0, `crosspost retry\n${retried.text}`);
  assert.deepEqual(newsWrites(), [`POST /channels/${ann.id}/messages/${botNews(ann).at(-1).id}/crosspost`, `POST /channels/${pn.id}/messages/${botNews(pn).at(-1).id}/crosspost`], 'the next run crossposts, without a second post');
  assert.equal(notice(retried), 'releases: 2.2.0, 2.3.0 and 2.3.1 already posted; 2.3.2 already in #announcements and #patch-notes, crossposted now in #announcements and #patch-notes', 'retry notice');
  // Discord says it is already crossposted (40033): not an error.
  botNews(ann).at(-1).flags &= ~1;
  const twice = await releases(list232);
  botNews(ann).at(-1).flags |= 1;
  assert.equal(twice.code, 0, `already crossposted\n${twice.text}`);
  assert.ok(fake.calls.some((c) => c.route.endsWith('/crosspost') && c.status === 400), 'Discord answered 40033');
  assert.deepEqual(newsWrites(), [], 'already crossposted: nothing written');

  // A version older than one already up is never posted (the channels read in order).
  const late = await releases([r22, entry('2.2.5', 'Between'), ...list232.slice(1)]);
  assert.equal(late.code, 0, `older version\n${late.text}`);
  assert.deepEqual(newsWrites(), [], 'older version: nothing written');
  assert.equal(notice(late), 'releases: 2.2.0 already posted; 2.2.5 not posted to #announcements and #patch-notes, where the newer 2.3.2 is already up (versions go out in order); 2.3.0, 2.3.1 and 2.3.2 already posted', 'older version notice');

  // A broken list posts nothing and reads nothing.
  for (const [bad, why] of [
    ['export const RELEASES = [', /scripts\/discord-releases\.mjs could not be loaded: SyntaxError/],
    [[r22, { ...entry('2.3.3', 'Half'), patchNotes: null }], /2\.3\.3: fill in both announcement and patchNotes/],
    [[r22, { ...entry('2.3.3', 'Wrong'), announcement: '**Riftborn 2.3.3: Wrong** oops' }], /2\.3\.3: announcement must start with "\*\*Riftborn 2\.3\.3 · "/],
    [[r22, entry('2.3.0', 'A'), entry('2.2.9', 'B')], /2\.2\.9 must be newer than 2\.3\.0 above it/],
    [[r22, { ...entry('2.3.3', 'Typo'), patchnotes: 'x' }], /2\.3\.3: unknown field patchnotes/],
    [[r22, { ...entry('2.3.3', 'Pings'), ping: { patchnotes: true } }], /2\.3\.3: unknown ping patchnotes/],
    [[r22, entry('2.3.3', 'x'.repeat(1990))], /2\.3\.3: announcement is about \d+ characters once posted \(Discord allows 2000\)/],
    [[{ ...placeholder('2.3.0'), posted: true }], /2\.3\.0: an entry marked posted needs both texts/],
    [[r22, { ...entry('2.3.3', 'Link'), patchNotes: '**v2.3.3 · Link** (1 Oct 2026)\nSee {#patchnotes} and {#mod-chat}.' }], /2\.3\.3: patchNotes links \{#patchnotes\}, \{#mod-chat\}, which is not a public channel/],
    [[r22, { ...entry('2.3.3', 'Loud'), announcement: '**Riftborn 2.3.3 · Loud** @everyone it is out' }], /2\.3\.3: announcement must not mention anyone/],
    [[r22, entry('2.03.0', 'Zero')], /2\.03\.0: version must be MAJOR\.MINOR\.PATCH/],
  ]) {
    const result = await releases(bad);
    assert.equal(result.code, 1, `a broken list fails: ${why}\n${result.text}`);
    assert.match(result.stdout, new RegExp(`::error title=Release posts::(?:scripts/discord-releases\\.mjs: )?${why.source}`), `reported: ${why}`);
    assert.ok(!fake.calls.some((c) => c.route.startsWith('/channels/')), `a broken list reads and posts nothing: ${why}`);
  }

  // A busy channel with no release post among its newest 500 messages: nothing is guessed.
  const annSaved = s.messages.get(ann.id);
  s.messages.set(ann.id, Array.from({ length: 510 }, (_, i) => keeperPost(ann, i)));
  const lost = await releases(list232);
  s.messages.set(ann.id, annSaved);
  assert.equal(lost.code, 1, 'no release post in sight fails');
  assert.match(lost.stdout, /::error title=Release posts::2\.3\.0 not posted to #announcements: none of its last 500 messages is a release post/, 'says why');
  assert.deepEqual(newsWrites(), [], 'nothing posted on a guess');

  // A version whose ping role is missing goes out in neither channel: both messages are built first.
  const savedRoles = s.roles;
  s.roles = s.roles.filter((r) => r.id !== PATCH);
  const list233 = [...list232, entry('2.3.3', 'Roles', { announcement: false, patchNotes: true })];
  const noRole = await releases(list233);
  s.roles = savedRoles;
  assert.equal(noRole.code, 1, `a missing ping role fails the step\n${noRole.text}`);
  assert.match(noRole.stdout, /::error title=Release posts::2\.3\.3 not posted: its #patch-notes post pings Patch pings, and that role is missing/, 'says why');
  assert.deepEqual(newsWrites(), [], 'a missing ping role: nothing posted in either channel');
  assert.equal(notice(noRole), 'releases: 2.2.0, 2.3.0, 2.3.1 and 2.3.2 already posted; 2.3.3 not posted to #announcements and #patch-notes (see the errors)', 'missing role notice');

  // A post that fails in one channel (a 502, never replayed): the version after it waits there only,
  // and the next run posts both in that channel and nothing in the other.
  const list234 = [...list233, entry('2.3.4', 'More', { announcement: false, patchNotes: false })];
  fake.faults.serverError.add(`POST /channels/${pn.id}/messages`);
  const half = await releases(list234);
  assert.equal(half.code, 1, `a failed post fails the step\n${half.text}`);
  assert.equal(fake.faults.serverError.size, 0, 'the patch notes post hit the 502');
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.route === `/channels/${pn.id}/messages`).length, 1, 'a failed post is never replayed');
  assert.equal(notice(half), 'releases: 2.2.0, 2.3.0, 2.3.1 and 2.3.2 already posted; 2.3.3 posted to #announcements (crossposted, no pings), not posted to #patch-notes (see the errors); '
    + '2.3.4 posted to #announcements (crossposted, no pings), held back in #patch-notes until the version before it is posted', 'one channel failed notice');
  const rest = await releases(list234);
  assert.equal(rest.code, 0, `the failed channel catches up\n${rest.text}`);
  const [p233, p234] = botNews(pn).slice(-2);
  assert.deepEqual(newsWrites(), [`POST /channels/${pn.id}/messages`, `POST /channels/${pn.id}/messages/${p233.id}/crosspost`,
    `POST /channels/${pn.id}/messages`, `POST /channels/${pn.id}/messages/${p234.id}/crosspost`], 'the next run posts 2.3.3 and 2.3.4 in #patch-notes only, in order');
  assert.deepEqual([p233.content.startsWith(`<@&${PATCH}>\n**v2.3.3 · `), p234.content.startsWith('**v2.3.4 · ')], [true, true], 'the right texts, in order');
  // An older version left uncrossposted is never crossposted later, behind the newer one.
  p233.flags &= ~1;
  const stale = await releases(list234);
  p233.flags |= 1;
  assert.equal(stale.code, 0, `older uncrossposted version\n${stale.text}`);
  assert.ok(!fake.calls.some((c) => c.route.endsWith('/crosspost')), 'an older uncrossposted version is left alone');

  // 7c. The live gate. The channels start again from 2.2 only, and riftborn.us serves 2.3.0 (today).
  // The release push carries 2.4.0's entry before the deploy has put 2.4.0 live.
  seedNews();
  fake.site.version = '2.3.0';
  const LIVE = new URL(SITE).host;
  const posts24 = () => [...s.messages.values()].flat().filter((msg) => /\*\*(Riftborn |v)2\.4 ·/.test(msg.content));
  const list24 = [r22, entry('2.3.0', 'Bigger Worlds'), entry('2.4.0', 'Next', { announcement: true, patchNotes: true })];
  const early = await releases(list24);
  assert.equal(early.code, 0, `2.4.0 before it is live\n${early.text}`);
  assert.equal(notice(early), `releases: 2.2.0 already posted; 2.3.0 posted to #announcements and #patch-notes (crossposted, pinged Patch pings); 2.4.0 waits for ${LIVE} to serve it (live is 2.3.0)`,
    'the live version (equal) goes out, the newer one waits for riftborn.us');
  assert.equal(newsWrites().length, 4, 'only 2.3.0 is written: a post and a crosspost per channel');
  assert.deepEqual(posts24(), [], '2.4.0 is not posted while riftborn.us serves 2.3.0');
  assert.equal(level(early), 'notice', 'a version waiting for the deploy is a notice');
  assert.equal(fake.site.calls.length, 1, 'riftborn.us is asked once per run');
  const [ask] = fake.site.calls;
  assert.equal(ask.method, 'GET', 'a GET');
  assert.match(ask.query, /^\?t=\d+$/, 'with a cache-busting query');
  assert.equal(ask.headers['cache-control'], 'no-cache', 'asking for a fresh answer');
  assert.equal(ask.headers.authorization, undefined, 'never with the bot token');

  // Still 2.3.0 live, and a 2.4.1 behind 2.4.0: both wait, nothing is written.
  const list241 = [...list24, entry('2.4.1', 'Hotfix')];
  const still = await releases(list241);
  assert.equal(still.code, 0, `still 2.3.0 live\n${still.text}`);
  assert.equal(notice(still), `releases: 2.2.0 and 2.3.0 already posted; 2.4.0 and 2.4.1 wait for ${LIVE} to serve them (live is 2.3.0)`, 'a version and the ones after it wait');
  assert.deepEqual(newsWrites(), [], 'nothing written while they wait');

  // riftborn.us does not answer (503s, then a closed port), even though it would serve 2.4.0: nothing
  // is posted, four tries, and it is a warning, not an error.
  fake.site.version = '2.4.0';
  fake.site.answer = { status: 503, body: 'Service Unavailable' };
  const down = await releases(list241);
  fake.site.answer = null;
  assert.equal(down.code, 0, `riftborn.us down is not a failure\n${down.text}`);
  assert.doesNotMatch(down.stdout, /^::error/m, 'riftborn.us down: no error annotation');
  assert.equal(level(down), 'warning', 'riftborn.us down: the summary is a warning');
  assert.equal(notice(down), `releases: 2.2.0 and 2.3.0 already posted; 2.4.0 and 2.4.1 wait: ${LIVE}/version.json could not be read (HTTP 503, 4 tries), so nothing new was posted; `
    + 'the next run checks again (the next deploy of main, or Run workflow by hand)', 'riftborn.us down: says so');
  assert.equal(fake.site.calls.length, 4, 'riftborn.us down: four tries');
  assert.deepEqual(newsWrites(), [], 'riftborn.us down: nothing written');
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadOrigin = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  const unreachable = await releases(list241, { ...env, RIFTBORN_TEST_LIVE_ORIGIN: deadOrigin });
  assert.equal(unreachable.code, 0, `riftborn.us unreachable is not a failure\n${unreachable.text}`);
  assert.doesNotMatch(unreachable.stdout, /^::error/m, 'unreachable: no error annotation');
  assert.equal(level(unreachable), 'warning', 'unreachable: the summary is a warning');
  assert.match(notice(unreachable), /; 2\.4\.0 and 2\.4\.1 wait: 127\.0\.0\.1:\d+\/version\.json could not be read \(network error \(ECONNREFUSED\), 4 tries\), so nothing new was posted;/, 'unreachable: says why');
  assert.deepEqual(newsWrites(), [], 'unreachable: nothing written');

  // A malformed answer is an error (reported once, no retry) and posts nothing.
  for (const [answer, why] of [
    [{ status: 200, body: 'not json' }, 'answered without a MAJOR.MINOR.PATCH version ("not json")'],
    [{ status: 200, body: '<!doctype html><title>Riftborn</title>' }, 'answered without a MAJOR.MINOR.PATCH version ("<!doctype html><title>Riftborn</title>")'],
    [{ status: 200, body: '{"version":"2.4"}' }, 'answered without a MAJOR.MINOR.PATCH version ("{\\"version\\":\\"2.4\\"}")'],
    [{ status: 200, body: '{"version":"v2.4.0"}' }, 'answered without a MAJOR.MINOR.PATCH version'],
    [{ status: 200, body: '{"version":2.4}' }, 'answered without a MAJOR.MINOR.PATCH version'],
    [{ status: 200, body: '{"build":"0123456789"}' }, 'answered without a MAJOR.MINOR.PATCH version'],
    [{ status: 404, body: 'Not Found' }, 'answered HTTP 404, not its version'],
    // A redirect is not followed, even to a place that serves the version (2.4.0 would be posted).
    [{ status: 301, body: '', headers: { location: `${SITE}/moved/version.json` } }, 'answered HTTP 301, not its version'],
  ]) {
    fake.site.answer = answer;
    const bad = await releases(list241);
    fake.site.answer = null;
    assert.equal(bad.code, 1, `a malformed answer fails the step: ${answer.body}\n${bad.text}`);
    const errors = bad.stdout.split('\n').filter((line) => line.startsWith('::error '));
    assert.equal(errors.length, 1, `reported once: ${answer.body}`);
    assert.ok(errors[0].startsWith(`::error title=Release posts::${SITE}/version.json ${why}`), `says what came back: ${errors[0]}`);
    assert.equal(fake.site.calls.length, 1, `an answer is not retried: ${answer.body}`);
    assert.deepEqual(newsWrites(), [], `a malformed answer: nothing written: ${answer.body}`);
    assert.equal(notice(bad), 'releases: 2.2.0 and 2.3.0 already posted; 2.4.0 not posted to #announcements and #patch-notes (see the errors); '
      + '2.4.1 held back in #announcements and #patch-notes until the version before it is posted', `a malformed answer: notice: ${answer.body}`);
  }

  // The deploy is done and riftborn.us serves 2.4.0: posted once, crossposted, both pings; 2.4.1
  // still waits. The next run writes nothing.
  const golive = await releases(list241);
  assert.equal(golive.code, 0, `2.4.0 live\n${golive.text}`);
  assert.equal(notice(golive), `releases: 2.2.0 and 2.3.0 already posted; 2.4.0 posted to #announcements and #patch-notes (crossposted, pinged News pings and Patch pings); 2.4.1 waits for ${LIVE} to serve it (live is 2.4.0)`, '2.4.0 live: posted');
  const [a24, p24] = [botNews(ann).at(-1), botNews(pn).at(-1)];
  assert.deepEqual(newsWrites(), [`POST /channels/${ann.id}/messages`, `POST /channels/${ann.id}/messages/${a24.id}/crosspost`,
    `POST /channels/${pn.id}/messages`, `POST /channels/${pn.id}/messages/${p24.id}/crosspost`], '2.4.0 live: one post and one crosspost per channel');
  assert.deepEqual([a24.content, p24.content], [`<@&${NEWS}>\n${linkNews(list24[2].announcement)}`, `<@&${PATCH}>\n${linkNews(list24[2].patchNotes)}`], '2.4.0 live: its texts');
  const afterLive = await releases(list241);
  assert.equal(afterLive.code, 0, `after 2.4.0\n${afterLive.text}`);
  assert.equal(notice(afterLive), `releases: 2.2.0, 2.3.0 and 2.4.0 already posted; 2.4.1 waits for ${LIVE} to serve it (live is 2.4.0)`, 'after 2.4.0: notice');
  assert.deepEqual(newsWrites(), [], 'after 2.4.0: nothing written');
  assert.equal(posts24().length, 2, '2.4.0 once per channel');

  // Versions compare as numbers, not text: with 2.9.5 live, 2.4.1 and 2.9.0 go out and 2.10.0 waits;
  // with 2.10.0 live, it goes out.
  const list210 = [...list241, entry('2.9.0', 'Nine'), entry('2.10.0', 'Ten')];
  fake.site.version = '2.9.5';
  const nine = await releases(list210);
  assert.equal(nine.code, 0, `2.9.5 live\n${nine.text}`);
  assert.equal(notice(nine), 'releases: 2.2.0, 2.3.0 and 2.4.0 already posted; 2.4.1 posted to #announcements and #patch-notes (crossposted, pinged Patch pings); '
    + `2.9.0 posted to #announcements and #patch-notes (crossposted, pinged Patch pings); 2.10.0 waits for ${LIVE} to serve it (live is 2.9.5)`, '2.9.5 live: 2.10.0 is newer');
  fake.site.version = '2.10.0';
  const ten = await releases(list210);
  assert.equal(ten.code, 0, `2.10.0 live\n${ten.text}`);
  assert.equal(notice(ten), 'releases: 2.2.0, 2.3.0, 2.4.0, 2.4.1 and 2.9.0 already posted; 2.10.0 posted to #announcements and #patch-notes (crossposted, pinged Patch pings)', '2.10.0 live: posted');

  // A rollback after a version went out in one channel only: the other channel waits for it to be
  // live again, and nothing is written.
  s.messages.set(pn.id, s.messages.get(pn.id).filter((msg) => !msg.content.includes('**v2.10 · ')));
  fake.site.version = '2.9.5';
  const rolledBack = await releases(list210);
  assert.equal(rolledBack.code, 0, `rolled back\n${rolledBack.text}`);
  assert.equal(notice(rolledBack), `releases: 2.2.0, 2.3.0, 2.4.0, 2.4.1 and 2.9.0 already posted; 2.10.0 already in #announcements, waits in #patch-notes for ${LIVE} to serve it (live is 2.9.5)`, 'rolled back: notice');
  assert.deepEqual(newsWrites(), [], 'rolled back: nothing written');

  // 8. No secret anywhere: output, URLs, request bodies; and riftborn.us never gets the token.
  assert.ok(fake.site.seen.length > 0 && fake.site.seen.every((c) => c.headers.authorization === undefined && !JSON.stringify(c.headers).includes(TOKEN)), 'riftborn.us never sees the token');
  const haystack = [...output, ...fake.calls.flatMap((c) => [c.route, c.query, c.body]), ...fake.site.seen.map((c) => c.query)].join('\n');
  assert.ok(!haystack.includes(TOKEN), 'the token never appears in output or request bodies');
  assert.ok(!haystack.includes('secret-webhook-token'), 'webhook URLs never appear');

  console.log(`discord-setup mock: ok (run 1: ${run1Writes} writes; run 2 and "all": 0 writes; drift: ${creates.length} create; `
    + `${fake.state.channels.length} channels, ${fake.state.roles.length} roles, ${[...fake.state.messages.values()].flat().filter((msg) => msg.author.id === fake.state.ids.BOT).length} bot posts)`);
} finally {
  await fake.stop();
  if (releaseDir) rmSync(releaseDir, { recursive: true, force: true });
}
