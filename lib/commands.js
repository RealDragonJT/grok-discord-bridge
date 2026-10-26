'use strict';
// /bridge slash commands: the settings UI. Registered globally on startup, owner-only.
// Two layers of protection: default_member_permissions hides the command from non-admins in the client,
// and every interaction is checked against OWNER_ID in code (the real enforcement). All replies are ephemeral.
const { ApplicationCommandOptionType: T, PermissionFlagsBits, ChannelType } = require('discord.js');
const { NEW_USER_MODES, GUILD_MODES, QUIET_MODES, PRESENCE_STATUSES, parseHHMM, fmtHHMM, validTz } = require('./settings');
const { isSnowflake } = require('./util');

const COMMAND_NAME = 'bridge';
const EPHEMERAL = 64; // MessageFlags.Ephemeral
const MAX_REPLY = 1900;

// ---------- definition (JSON sent to Discord) ----------
const opt = (type, name, description, extra = {}) => ({ type, name, description, ...extra });
const str = (name, description, required = false, extra = {}) => opt(T.String, name, description, { required, ...extra });
const int = (name, description, required = false, min, max) => opt(T.Integer, name, description, { required, ...(min !== undefined ? { min_value: min } : {}), ...(max !== undefined ? { max_value: max } : {}) });
const bool = (name, description, required = false) => opt(T.Boolean, name, description, { required });
const user = (name, description, required = false) => opt(T.User, name, description, { required });
const choice = (name, description, values, required = true) => opt(T.String, name, description, { required, choices: values.map((v) => ({ name: v, value: v })) });
const chan = (name, description, required = true) => opt(T.Channel, name, description, { required, channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] });
const sub = (name, description, options = []) => opt(T.Subcommand, name, description, { options });
const group = (name, description, subs) => opt(T.SubcommandGroup, name, description, { options: subs });

function definition() {
  return {
    name: COMMAND_NAME,
    description: 'Manage the Grok Discord bridge (owner only)',
    default_member_permissions: String(PermissionFlagsBits.Administrator),
    contexts: [0, 1], // guilds + DMs with the bot
    options: [
      sub('status', 'Health, uptime, last wake, counters and current settings'),
      sub('test-webhook', 'Send a test event to your webhook and report the HTTP status'),
      sub('export', 'Download the current settings as JSON (no secrets inside)'),
      sub('reset', 'Reset ALL settings to defaults', [bool('confirm', 'Must be true to actually reset', true)]),
      group('quiet-hours', 'Quiet hours for non-owner wakes', [
        sub('set', 'Enable quiet hours (24h HH:MM, IANA timezone, overnight ranges are fine)', [
          str('start', 'Start time, e.g. 22:00', true), str('end', 'End time, e.g. 07:00', true), str('tz', 'IANA timezone, e.g. America/Chicago', true),
          choice('mode', 'suppress = drop messages, hold = deliver them as a batch when quiet hours end', QUIET_MODES, false),
          bool('owner-always', 'true (default): you always wake the agent, even during quiet hours'),
        ]),
        sub('off', 'Disable quiet hours'),
      ]),
      group('allow-user', 'Approved chatters (the agent may chat with them, but not take tasks)', [
        sub('add', 'Approve a user', [user('user', 'The user'), str('user-id', 'Or a raw user id')]),
        sub('remove', 'Remove an approved user', [user('user', 'The user'), str('user-id', 'Or a raw user id')]),
        sub('list', 'List approved users (and strangers seen in approved-only mode)'),
      ]),
      group('block', 'Blocked users (never wake the agent)', [
        sub('add', 'Block a user', [user('user', 'The user'), str('user-id', 'Or a raw user id')]),
        sub('remove', 'Unblock a user', [user('user', 'The user'), str('user-id', 'Or a raw user id')]),
        sub('list', 'List blocked users'),
      ]),
      group('mode', 'Behaviour switches', [
        sub('new-users', 'What happens to people who are neither you nor approved', [choice('value', 'ignore | approved-only | wake-as-other', NEW_USER_MODES)]),
      ]),
      group('guilds', 'Server allow/deny', [
        sub('allow', 'Add a server to the allowlist', [str('guild-id', 'Server id', true)]),
        sub('deny', 'Always ignore non-owner messages from a server', [str('guild-id', 'Server id', true)]),
        sub('forget', 'Remove a server from both lists', [str('guild-id', 'Server id', true)]),
        sub('mode', 'allow-all (default) or allowlist', [choice('value', 'allow-all | allowlist', GUILD_MODES)]),
        sub('list', 'Show server settings and the servers the bot is in'),
        sub('leave', 'Make the bot leave a server', [str('guild-id', 'Server id', true)]),
      ]),
      group('channels', 'Optional per-server channel allowlist (non-owner wakes)', [
        sub('allow', 'Only allow wakes in this channel (and other allowed ones) for that server', [chan('channel', 'Text channel')]),
        sub('deny', 'Remove a channel from its server\'s allowlist', [chan('channel', 'Text channel')]),
        sub('clear', 'Remove the channel allowlist for a server (all channels allowed again)', [str('guild-id', 'Server id', true)]),
        sub('list', 'List channel allowlists'),
      ]),
      group('bots', 'Other bots (ignored by default)', [
        sub('allow', 'Let a bot wake the agent via @mention', [user('user', 'The bot'), str('user-id', 'Or a raw bot id')]),
        sub('deny', 'Stop a bot from waking the agent', [user('user', 'The bot'), str('user-id', 'Or a raw bot id')]),
        sub('list', 'List allowlisted bots and the loop-guard limit'),
        sub('limit', 'Loop guard: max wakes per bot per minute', [int('per-minute', 'Wakes per minute per bot', true, 1, 60)]),
      ]),
      group('cooldown', 'Per-user wake cooldown', [sub('set', 'Seconds between wakes for the same non-owner user (0 = off)', [int('seconds', 'Seconds', true, 0, 86400)])]),
      group('daily-cap', 'Daily wake cap', [sub('set', 'Max non-owner wakes per day (0 = unlimited)', [int('max', 'Wakes per day', true, 0, 100000), str('tz', 'IANA timezone for the day boundary (default UTC)')])]),
      group('followup-window', 'Owner follow-ups without @mention', [sub('set', 'Minutes after the bot posts in a channel that your messages wake the agent (0 = off)', [int('minutes', 'Minutes', true, 0, 1440)])]),
      group('status-text', 'Presence text', [
        sub('set', 'Set the bot\'s custom status text', [str('text', 'Text (max 128 chars)', true), choice('status', 'online | idle | dnd | invisible', PRESENCE_STATUSES, false)]),
        sub('clear', 'Use the default status text'),
      ]),
      group('pinned-channel', 'Status from a pinned message', [
        sub('set', 'Use the newest pin by the bot or you in this channel as the status', [chan('channel', 'Text channel')]),
        sub('clear', 'Stop using a pinned message'),
      ]),
      group('options', 'Misc options', [sub('set', 'Debounce, typing indicator and 👀 reaction', [int('debounce-seconds', 'Quiet seconds before a batch is sent (1-60)', false, 1, 60), bool('typing', 'Show typing for your fresh messages'), bool('react-eyes', 'React 👀 to your fresh messages')])]),
    ],
  };
}

// ---------- handlers ----------
const fmtDur = (s) => { if (s == null) return 'n/a'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return `${d ? `${d}d ` : ''}${h || d ? `${h}h ` : ''}${m}m`; };
const list = (a, n = 15) => (a.length ? a.slice(0, n).join(', ') + (a.length > n ? ` (+${a.length - n} more)` : '') : 'none');
const fmtUser = (u) => `${u.label ? `${u.label} ` : ''}(${u.id})`;
const onOff = (b) => (b ? 'on' : 'off');

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

function settingsSummary(s) {
  const q = s.quietHours;
  return [
    `new users: ${s.newUsers} | approved: ${s.approved.length} | blocked: ${s.blocked.length}`,
    `quiet hours: ${q.enabled ? `${q.start}-${q.end} ${q.tz}, ${q.mode}, owner ${q.ownerAlways ? 'always wakes' : 'also quiet'}` : 'off'}`,
    `guilds: ${s.guilds.mode} (allow ${s.guilds.allow.length}, deny ${s.guilds.deny.length}) | channel allowlists: ${Object.keys(s.channels).length} server(s)`,
    `bots: ${s.bots.allow.length} allowlisted, max ${s.bots.maxWakesPerMinute}/min each`,
    `cooldown: ${s.cooldownSeconds}s | daily cap: ${s.dailyCap.max || 'unlimited'} (${s.dailyCap.tz}) | follow-up window: ${s.followupMinutes ? `${s.followupMinutes} min` : 'off'}`,
    `debounce: ${s.options.debounceSeconds}s | typing: ${onOff(s.options.typing)} | 👀: ${onOff(s.options.reactEyes)}`,
    `status text: ${s.presence.text ? `custom (${s.presence.status})` : 'default'} | pinned-status channel: ${s.pinnedChannelId || 'off'}`,
  ];
}

function targetId(o, ctx, { allowBot = false } = {}) {
  const u = o.getUser('user');
  const raw = (o.getString('user-id') || '').trim();
  const id = u ? u.id : raw;
  if (!id) fail('Pick a user, or pass user-id.');
  if (!isSnowflake(id)) fail('That does not look like a Discord user id (digits only).');
  if (id === ctx.ownerId) fail('That is you (the owner); the owner always has full access.');
  if (ctx.botId && id === ctx.botId) fail('That is this bridge\'s own bot.');
  if (u && u.bot && !allowBot) fail('That is a bot. Bots are managed with /bridge bots allow.');
  return { id, label: u ? String(u.username || '').slice(0, 64) : '' };
}

const HANDLERS = {
  async status(ctx) {
    const st = ctx.getStatus ? ctx.getStatus() : {};
    const rs = ctx.state; const s = ctx.settings.get();
    const dropped = Object.entries(rs.stats.dropped).map(([k, v]) => `${k} ${v}`);
    const lw = rs.stats.lastWebhook;
    return [
      '**Bridge status**',
      '```',
      `health: ${st.healthy ? 'healthy' : 'UNHEALTHY'}${st.problems && st.problems.length ? ` (${st.problems.join('; ')})` : ''}`,
      `gateway: ${st.ws_status || 'n/a'}, ping ${st.ping_ms == null ? 'n/a' : `${st.ping_ms}ms`}, servers ${st.guilds == null ? 'n/a' : st.guilds}`,
      `process uptime: ${fmtDur(st.process_uptime_s)} | gateway uptime: ${fmtDur(st.gateway_uptime_s)} | reconnects ${st.reconnects || 0}`,
      `last wake: ${rs.stats.lastWakeAt ? `${rs.stats.lastWakeAt} (${rs.stats.lastWakeKind})` : 'never'}`,
      `last webhook: ${lw ? `${lw.ok ? 'OK' : 'FAILED'} HTTP ${lw.status} at ${lw.at}` : 'none yet'}`,
      `wakes since ${rs.stats.since.slice(0, 10)}: ${rs.stats.wakes} | non-owner wakes today: ${rs.dailyCount}`,
      `dropped: ${dropped.length ? dropped.join(', ') : 'nothing'}`,
      `held for quiet hours now: ${st.held || 0} | strangers seen (approved-only): ${Object.keys(rs.pending).length}`,
      '',
      ...settingsSummary(s),
      '```',
    ].join('\n');
  },

  async 'test-webhook'(ctx, i) {
    await i.deferReply({ flags: EPHEMERAL });
    const r = await ctx.testWebhook();
    const hint = r.ok ? '' : r.status === 401 || r.status === 403 ? ' The key was rejected: re-copy WEBHOOK_KEY from the routine.' : r.status === 404 ? ' Not found: re-copy WEBHOOK_URL from the routine.' : r.status === 0 ? ' No response (network error or timeout).' : '';
    return { edit: true, content: r.ok ? `Webhook accepted the test event (HTTP ${r.status}). Your routine should have been triggered.` : `Webhook test failed: HTTP ${r.status}.${hint}` };
  },

  async export(ctx) {
    return { content: 'Current settings (contains ids only, no secrets). Keep it private anyway.', files: [{ attachment: Buffer.from(ctx.settings.exportJson() + '\n'), name: 'settings.json' }] };
  },

  async reset(ctx, i) {
    if (!i.options.getBoolean('confirm')) return 'Nothing changed. Run again with confirm:true to reset all settings to defaults.';
    ctx.settings.reset();
    ctx.state.pending = {}; ctx.state.touch();
    ctx.changed(['*']);
    return 'All settings were reset to defaults.';
  },

  'quiet-hours.set'(ctx, i) {
    const o = i.options;
    const start = o.getString('start'), end = o.getString('end'), tz = o.getString('tz');
    const sm = parseHHMM(start), em = parseHHMM(end);
    if (sm === null || em === null) fail('Times must be 24-hour HH:MM, e.g. 22:00 and 07:00.');
    if (sm === em) fail('Start and end must differ.');
    if (!validTz(tz)) fail('Unknown timezone. Use an IANA name such as America/Chicago, Europe/Berlin or UTC.');
    const mode = o.getString('mode'); const oa = o.getBoolean('owner-always');
    const s = ctx.settings.update((d) => {
      d.quietHours = { ...d.quietHours, enabled: true, start: fmtHHMM(sm), end: fmtHHMM(em), tz };
      if (mode) d.quietHours.mode = mode;
      if (oa !== null && oa !== undefined) d.quietHours.ownerAlways = oa;
    });
    const q = s.quietHours;
    return `Quiet hours on: ${q.start}-${q.end} ${q.tz}${sm > em ? ' (overnight)' : ''}. Non-owner messages are ${q.mode === 'hold' ? 'held and delivered as a batch afterwards' : 'dropped'}; ${q.ownerAlways ? 'you still wake the agent.' : 'you are held/dropped too.'}`;
  },
  'quiet-hours.off'(ctx) { ctx.settings.update((d) => { d.quietHours.enabled = false; }); return 'Quiet hours are off.'; },

  'allow-user.add'(ctx, i) {
    const t = targetId(i.options, ctx);
    ctx.settings.update((d) => {
      d.blocked = d.blocked.filter((u) => u.id !== t.id);
      d.approved = d.approved.filter((u) => u.id !== t.id).concat({ id: t.id, label: t.label, addedAt: new Date().toISOString() });
    });
    ctx.state.clearPending(t.id);
    return `Approved ${fmtUser(t)}. The agent may chat with them but must not take tasks from them.`;
  },
  'allow-user.remove'(ctx, i) {
    const t = targetId(i.options, ctx);
    const had = ctx.settings.get().approved.some((u) => u.id === t.id);
    ctx.settings.update((d) => { d.approved = d.approved.filter((u) => u.id !== t.id); });
    return had ? `Removed ${t.id} from approved users.` : `${t.id} was not approved.`;
  },
  'allow-user.list'(ctx) {
    const s = ctx.settings.get();
    const pend = Object.entries(ctx.state.pending).map(([id, e]) => `${e.username || '?'} (${id}) x${e.count}`);
    return `Approved (${s.approved.length}): ${list(s.approved.map(fmtUser))}\nStrangers seen in approved-only mode (${pend.length}): ${list(pend)}`;
  },

  'block.add'(ctx, i) {
    const t = targetId(i.options, ctx);
    ctx.settings.update((d) => {
      d.approved = d.approved.filter((u) => u.id !== t.id);
      d.blocked = d.blocked.filter((u) => u.id !== t.id).concat({ id: t.id, label: t.label, addedAt: new Date().toISOString() });
    });
    ctx.state.clearPending(t.id);
    return `Blocked ${fmtUser(t)}. Their messages never wake the agent.`;
  },
  'block.remove'(ctx, i) {
    const t = targetId(i.options, ctx);
    const had = ctx.settings.get().blocked.some((u) => u.id === t.id);
    ctx.settings.update((d) => { d.blocked = d.blocked.filter((u) => u.id !== t.id); });
    return had ? `Unblocked ${t.id}.` : `${t.id} was not blocked.`;
  },
  'block.list'(ctx) { const s = ctx.settings.get(); return `Blocked (${s.blocked.length}): ${list(s.blocked.map(fmtUser))}`; },

  'mode.new-users'(ctx, i) {
    const v = i.options.getString('value');
    if (!NEW_USER_MODES.includes(v)) fail(`Mode must be one of: ${NEW_USER_MODES.join(', ')}.`);
    ctx.settings.update((d) => { d.newUsers = v; });
    return { ignore: 'New users are now ignored silently (no wake, no cost).', 'approved-only': 'Only you and approved users wake the agent. Strangers are dropped but remembered (see /bridge allow-user list) so you can approve them.', 'wake-as-other': 'Strangers now wake the agent with author_role "other" (subject to cooldown, cap and quiet hours). The agent should tell you and not reply.' }[v];
  },

  'guilds.allow'(ctx, i) { const id = guildArg(i); ctx.settings.update((d) => { d.guilds.deny = d.guilds.deny.filter((x) => x !== id); if (!d.guilds.allow.includes(id)) d.guilds.allow.push(id); }); return `Server ${id} is on the allowlist (active when guild mode is "allowlist").`; },
  'guilds.deny'(ctx, i) { const id = guildArg(i); ctx.settings.update((d) => { d.guilds.allow = d.guilds.allow.filter((x) => x !== id); if (!d.guilds.deny.includes(id)) d.guilds.deny.push(id); }); return `Server ${id} is denied: non-owner messages there are ignored in any mode.`; },
  'guilds.forget'(ctx, i) { const id = guildArg(i); ctx.settings.update((d) => { d.guilds.allow = d.guilds.allow.filter((x) => x !== id); d.guilds.deny = d.guilds.deny.filter((x) => x !== id); }); return `Server ${id} removed from both lists.`; },
  'guilds.mode'(ctx, i) {
    const v = i.options.getString('value');
    if (!GUILD_MODES.includes(v)) fail(`Mode must be one of: ${GUILD_MODES.join(', ')}.`);
    ctx.settings.update((d) => { d.guilds.mode = v; });
    return v === 'allowlist' ? 'Guild mode: allowlist. Only allowlisted servers wake the agent for non-owners (you are exempt).' : 'Guild mode: allow-all (except denied servers).';
  },
  'guilds.list'(ctx) {
    const g = ctx.settings.get().guilds;
    const inn = (ctx.guilds ? ctx.guilds() : []).map((x) => `${x.name} (${x.id})`);
    return `Mode: ${g.mode}\nAllow: ${list(g.allow)}\nDeny: ${list(g.deny)}\nBot is in (${inn.length}): ${list(inn)}`;
  },
  async 'guilds.leave'(ctx, i) {
    const id = guildArg(i);
    if (!ctx.leaveGuild) fail('Leaving servers is not available right now.');
    const r = await ctx.leaveGuild(id);
    return r ? `Left server ${id}.` : `The bot is not in server ${id} (or leaving failed).`;
  },

  'channels.allow'(ctx, i) {
    const c = i.options.getChannel('channel');
    if (!c || !c.guildId) fail('Pick a server text channel.');
    ctx.settings.update((d) => { d.channels[c.guildId] = [...new Set([...(d.channels[c.guildId] || []), c.id])]; });
    return `Non-owner wakes in server ${c.guildId} are now limited to ${ctx.settings.get().channels[c.guildId].length} channel(s), including <#${c.id}>.`;
  },
  'channels.deny'(ctx, i) {
    const c = i.options.getChannel('channel');
    if (!c || !c.guildId) fail('Pick a server text channel.');
    ctx.settings.update((d) => { d.channels[c.guildId] = (d.channels[c.guildId] || []).filter((x) => x !== c.id); });
    return `Removed <#${c.id}> from the allowlist. If the server's list is now empty, all its channels are allowed again.`;
  },
  'channels.clear'(ctx, i) { const id = guildArg(i); ctx.settings.update((d) => { delete d.channels[id]; }); return `Channel allowlist for server ${id} cleared (all channels allowed).`; },
  'channels.list'(ctx) {
    const ch = ctx.settings.get().channels; const e = Object.entries(ch);
    return e.length ? e.map(([g, l]) => `Server ${g}: ${l.map((c) => `<#${c}>`).join(' ')}`).join('\n') : 'No channel allowlists: every channel in an allowed server can wake the agent.';
  },

  'bots.allow'(ctx, i) {
    const t = targetId(i.options, ctx, { allowBot: true });
    ctx.settings.update((d) => { if (!d.bots.allow.includes(t.id)) d.bots.allow.push(t.id); });
    return `Bot ${t.label ? `${t.label} ` : ''}(${t.id}) may now wake the agent via @mention in servers (max ${ctx.settings.get().bots.maxWakesPerMinute}/min).`;
  },
  'bots.deny'(ctx, i) { const t = targetId(i.options, ctx, { allowBot: true }); ctx.settings.update((d) => { d.bots.allow = d.bots.allow.filter((x) => x !== t.id); }); return `Bot ${t.id} no longer wakes the agent.`; },
  'bots.list'(ctx) { const b = ctx.settings.get().bots; return `Allowlisted bots (${b.allow.length}): ${list(b.allow)}\nLoop guard: max ${b.maxWakesPerMinute} wake(s) per bot per minute.`; },
  'bots.limit'(ctx, i) { const n = i.options.getInteger('per-minute'); ctx.settings.update((d) => { d.bots.maxWakesPerMinute = n; }); return `Loop guard: at most ${ctx.settings.get().bots.maxWakesPerMinute} wake(s) per bot per minute.`; },

  'cooldown.set'(ctx, i) { const n = i.options.getInteger('seconds'); ctx.settings.update((d) => { d.cooldownSeconds = n; }); return n ? `Per-user cooldown: ${ctx.settings.get().cooldownSeconds}s (you are exempt).` : 'Per-user cooldown is off.'; },
  'daily-cap.set'(ctx, i) {
    const n = i.options.getInteger('max'); const tz = i.options.getString('tz');
    if (tz && !validTz(tz)) fail('Unknown timezone. Use an IANA name such as America/Chicago or UTC.');
    ctx.settings.update((d) => { d.dailyCap.max = n; if (tz) d.dailyCap.tz = tz; });
    const c = ctx.settings.get().dailyCap;
    return c.max ? `Daily cap: ${c.max} non-owner wakes per day (${c.tz} day boundary). You are exempt. When it is hit I will DM you once per day.` : 'Daily cap is off (unlimited).';
  },
  'followup-window.set'(ctx, i) { const n = i.options.getInteger('minutes'); ctx.settings.update((d) => { d.followupMinutes = n; }); return n ? `Follow-up window: ${ctx.settings.get().followupMinutes} min. After the bot posts in a channel, your messages there wake the agent without an @mention.` : 'Follow-up window is off.'; },

  'status-text.set'(ctx, i) {
    const text = String(i.options.getString('text') || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 128);
    if (!text) fail('Status text cannot be empty (use /bridge status-text clear).');
    const st = i.options.getString('status');
    ctx.settings.update((d) => { d.presence.text = text; if (st) d.presence.status = st; });
    ctx.changed(['presence']);
    return `Status text set (${ctx.settings.get().presence.status}). A pinned message, if configured, still takes precedence.`;
  },
  'status-text.clear'(ctx) { ctx.settings.update((d) => { d.presence.text = ''; }); ctx.changed(['presence']); return 'Status text cleared (default text).'; },
  'pinned-channel.set'(ctx, i) {
    const c = i.options.getChannel('channel');
    if (!c || !isSnowflake(c.id)) fail('Pick a text channel.');
    ctx.settings.update((d) => { d.pinnedChannelId = c.id; });
    ctx.changed(['pinnedChannelId']);
    return `Status now follows the newest pin by the bot or you in <#${c.id}> (checked every 2 min; needs View Channel + Read Message History). First line = text; optional second line "status: idle|dnd|online|invisible".`;
  },
  'pinned-channel.clear'(ctx) { ctx.settings.update((d) => { d.pinnedChannelId = ''; }); ctx.changed(['pinnedChannelId']); return 'Pinned-message status is off.'; },

  'options.set'(ctx, i) {
    const o = i.options; const ds = o.getInteger('debounce-seconds'); const ty = o.getBoolean('typing'); const re = o.getBoolean('react-eyes');
    if ((ds === null || ds === undefined) && (ty === null || ty === undefined) && (re === null || re === undefined)) fail('Pass at least one option.');
    ctx.settings.update((d) => { if (ds !== null && ds !== undefined) d.options.debounceSeconds = ds; if (ty !== null && ty !== undefined) d.options.typing = ty; if (re !== null && re !== undefined) d.options.reactEyes = re; });
    const x = ctx.settings.get().options;
    return `Options: debounce ${x.debounceSeconds}s, typing ${onOff(x.typing)}, 👀 ${onOff(x.reactEyes)}.`;
  },
};

function guildArg(i) {
  const id = String(i.options.getString('guild-id') || '').trim();
  if (!isSnowflake(id)) fail('guild-id must be a numeric server id (Developer Mode > right-click the server > Copy Server ID).');
  return id;
}

// ctx: { ownerId, botId, settings, state, log, getStatus?, testWebhook?, leaveGuild?, guilds?, onChange? }
// Returns true when the interaction was a /bridge command (handled or denied).
async function handleInteraction(interaction, ctx) {
  if (!interaction.isChatInputCommand || !interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== COMMAND_NAME) return false;
  const log = ctx.log || (() => {});
  if (!interaction.user || interaction.user.id !== ctx.ownerId) {
    log(`/bridge denied for non-owner user=${interaction.user && interaction.user.id}`);
    try { await interaction.reply({ content: 'Only the bridge owner can use this command.', flags: EPHEMERAL }); } catch (_) { /* ignore */ }
    return true;
  }
  const grp = interaction.options.getSubcommandGroup(false);
  const subName = interaction.options.getSubcommand();
  const key = grp ? `${grp}.${subName}` : subName;
  const handler = HANDLERS[key];
  const changed = ctx.changed || ((k) => ctx.onChange && ctx.onChange(k));
  let out;
  try {
    if (!handler) fail(`Unknown command: ${key}`);
    out = await handler({ ...ctx, changed }, interaction);
    log(`/bridge ${key.replace('.', ' ')} ok`);
  } catch (e) {
    out = e instanceof UserError ? `⚠️ ${e.message}` : '⚠️ Something went wrong. Check the bridge logs.';
    if (!(e instanceof UserError)) log(`/bridge ${key} error ${e.name}: ${String(e.message).slice(0, 120)}`);
  }
  const body = typeof out === 'string' ? { content: out } : { ...out };
  if (body.content && body.content.length > MAX_REPLY) body.content = body.content.slice(0, MAX_REPLY) + '…';
  body.allowedMentions = { parse: [] };
  const edit = body.edit; delete body.edit;
  try {
    if (edit || interaction.deferred) await interaction.editReply(body);
    else await interaction.reply({ ...body, flags: EPHEMERAL });
  } catch (e) { log(`/bridge reply failed ${e.code || e.name}`); }
  return true;
}

module.exports = { COMMAND_NAME, EPHEMERAL, definition, handleInteraction, HANDLERS, settingsSummary };
