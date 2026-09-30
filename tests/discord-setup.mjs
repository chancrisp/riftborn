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
//   - the API base override is refused in CI and off loopback; a wrong guild count fails clearly.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'discord-setup.mjs');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'discord-setup.yml'), 'utf8').replace(/\r\n/g, '\n');
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
  };
  const calls = [];

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
      if (faults.iconReject || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(body.icon)) return formErr('icon', 'Invalid image data');
      next.icon = `icon${body.icon.length}`;
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
        const page = params.has('after') ? all.filter((msg) => BigInt(msg.id) > BigInt(params.get('after'))).slice(0, limit) : all.slice(-limit);
        return [200, [...page].reverse()]; // newest first, like Discord
      }
      if (sub === '/messages' && method === 'POST') {
        const target = ch(id) ?? state.threads.find((t) => t.id === id);
        if (!target || ![0, 5, 11].includes(target.type)) return err(400, 'Cannot send messages in this channel', 50008);
        if (!body.content || body.content.length > 2000) return formErr('content', 'Must be 2000 or fewer in length.');
        const message = { id: sf(), channel_id: id, author: { id: BOT, username: state.me.username, bot: true }, content: body.content, flags: body.flags ?? 0 };
        state.messages.set(id, [...(state.messages.get(id) ?? []), message]);
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
      const [status, data] = handle(req.method, route, body, url.searchParams);
      send(status, data);
    } catch (error) {
      send(500, { message: `fake crashed: ${error.message}`, code: 0 });
    }
  });

  return {
    state, faults, calls, handle, sf,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/api/v10`))),
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---------------------------------------------------------------------------------------------
// Running the script

const output = [];
function envWith(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CI|GITHUB_ACTIONS|DISCORD_SETUP_.*)$/i.test(key)) delete env[key];
  return { ...env, ...extra };
}
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      output.push(stdout, stderr);
      const count = (kind) => stdout.split('\n').filter((line) => line.startsWith(`::${kind} `)).length;
      // GitHub keeps 50 annotations per job and the job has 11 steps: each step writes exactly one
      // summary notice and at most 4 errors ("all" runs every phase in one process).
      const steps = args[0] === 'all' ? 11 : 1;
      if (args[0] !== 'nonsense') assert.equal(count('notice'), steps, `one summary notice per step for ${args.join(' ')}`);
      assert.ok(count('error') <= 4 * steps, `too many error annotations for ${args.join(' ')}`);
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
  assert.deepEqual(ob.prompts.map((p) => [p.title, p.single_select, p.required]), [['Read the rules?', true, true], ['What should we ping you about?', false, false]], at('onboarding prompts'));
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
  for (const name of ['announcements', 'patch-notes', 'secret-hunt', 'dev-builds']) assert.equal(botMessages(named[name]).length, 1, at(`#${name} posted once`));
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
    assert.ok(!/@everyone|@here|<@&?\d+>/.test(msg.content), at('no pings in posts'));
    if (msg.author.id === BOT) assert.ok(!/password\s*[:=]/i.test(msg.content), at('no password in posts'));
  }
  assert.ok(allMessages.find((msg) => msg.content.includes('https://dev.riftborn.us')), at('dev build post'));
}

function role(s, id) { return s.roles.find((r) => r.id === id); }

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
assert.deepEqual(phases, ['discover', 'roles', 'channels', 'community', 'news-forums', 'onboarding', 'automod', 'settings', 'posts', 'profile', 'invite'], 'workflow phases and order');
assert.match(WORKFLOW, /permissions:\n {2}contents: read\n/, 'workflow permissions');
assert.doesNotMatch(WORKFLOW, /environment:/, 'workflow uses no environment');
const tokenLines = WORKFLOW.split('\n').filter((line) => line.includes('secrets.DISCORD_SETUP_BOT_TOKEN'));
assert.equal(tokenLines.length, phases.length, 'workflow token from secrets, once per setup step');
assert.ok(tokenLines.every((line) => line === '          DISCORD_SETUP_BOT_TOKEN: ${{ secrets.DISCORD_SETUP_BOT_TOKEN }}'), 'token is step-level only');
assert.equal((WORKFLOW.match(/run: node scripts\/discord-setup\.mjs [a-z-]+\n {8}env:\n {10}DISCORD_SETUP_BOT_TOKEN:/g) ?? []).length, phases.length, 'each setup step gets the token');
assert.doesNotMatch(WORKFLOW, /\n {4}env:/, 'no job-level env: checkout and setup-node never see the token');
assert.match(WORKFLOW, /workflow_dispatch:/, 'workflow can be run by hand');
for (const p of ['.github/workflows/discord-setup.yml', 'scripts/discord-setup.mjs']) assert.ok(WORKFLOW.includes(`- '${p}'`), `workflow runs on changes to ${p}`);
assert.equal((WORKFLOW.match(/if: \$\{\{ !cancelled\(\) && steps\.discover\.outcome == 'success' \}\}/g) ?? []).length, phases.length - 1, 'later steps run even when an earlier one fails');

const fake = createFakeDiscord();
const base = await fake.start();
const env = envWith({ DISCORD_SETUP_BOT_TOKEN: TOKEN, DISCORD_SETUP_API_BASE: base });
const G = fake.state.ids.G;
const writes = () => fake.calls.filter((c) => c.method !== 'GET' && c.status < 400);

try {
  // 1. A fresh server.
  await runAll(phases, env, 'run 1');
  assertDesiredState(fake, 'run 1');
  assert.ok(fake.calls.some((c) => c.status === 429 && c.method === 'POST' && c.route === `/guilds/${G}/channels`), 'bucket 429 happened');
  assert.ok(fake.calls.some((c) => c.status === 429 && c.route === '/users/@me/guilds'), 'global 429 happened');
  assert.ok(fake.calls.some((c) => c.status === 502 && c.route === `/guilds/${G}`), '502 happened');
  assert.equal(fake.faults.rateLimit.size + fake.faults.globalRateLimit.size + fake.faults.serverError.size, 0, 'every fault was hit');
  for (const c of fake.calls.filter((x) => x.method !== 'GET')) assert.equal(c.reason, 'Riftborn setup', `audit log reason on ${c.method} ${c.route}`);
  for (const c of fake.calls.filter((x) => x.method === 'POST' && /\/(messages|threads)$/.test(x.route))) {
    const body = JSON.parse(c.body);
    assert.deepEqual((body.message ?? body).allowed_mentions, { parse: [] }, 'posts never ping');
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

  // 4e. Many errors in one step: 3 shown, then one "N more" line.
  fake.faults.messagesReadDenied = true;
  const noRead = await run(['posts'], env);
  fake.faults.messagesReadDenied = false;
  assert.equal(noRead.code, 1);
  const errorLines = noRead.stdout.split('\n').filter((line) => line.startsWith('::error '));
  assert.equal(errorLines.length, 4, 'three errors and a "more" line');
  assert.match(errorLines[3], /::error title=Posts::4 more errors in the step log/, 'the rest are counted');
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

  // 8. No secret anywhere: output, URLs, request bodies.
  const haystack = [...output, ...fake.calls.flatMap((c) => [c.route, c.query, c.body])].join('\n');
  assert.ok(!haystack.includes(TOKEN), 'the token never appears in output or request bodies');
  assert.ok(!haystack.includes('secret-webhook-token'), 'webhook URLs never appear');

  console.log(`discord-setup mock: ok (run 1: ${run1Writes} writes; run 2 and "all": 0 writes; drift: ${creates.length} create; `
    + `${fake.state.channels.length} channels, ${fake.state.roles.length} roles, ${[...fake.state.messages.values()].flat().filter((msg) => msg.author.id === fake.state.ids.BOT).length} bot posts)`);
} finally {
  await fake.stop();
}
