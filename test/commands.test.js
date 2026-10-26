'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mkTmp, mkInteraction, OWNER, BOT_ID } = require('./helpers');
const { SettingsStore } = require('../lib/settings');
const { RuntimeState } = require('../lib/state');
const commands = require('../lib/commands');

const FRIEND = '300000000000000001', OTHER = '300000000000000002';
const G = '600000000000000001', CH = '500000000000000001';

function rig() {
  const dir = mkTmp();
  const settings = new SettingsStore(path.join(dir, 's.json'));
  const state = new RuntimeState(path.join(dir, 'state.json'));
  const changes = []; const left = []; const logs = [];
  const ctx = {
    ownerId: OWNER, botId: BOT_ID, settings, state, log: (m) => logs.push(m),
    getStatus: () => ({ healthy: true, connected: true, problems: [], ws_status: 'READY', ping_ms: 42, guilds: 2, process_uptime_s: 3700, gateway_uptime_s: 3600, reconnects: 1, held: 0 }),
    guilds: () => [{ id: G, name: 'Test Guild' }],
    leaveGuild: async (id) => { left.push(id); return id === G; },
    testWebhook: async () => ({ ok: true, status: 202 }),
    changed: (k) => changes.push(k),
  };
  const run = async (group, sub, opts = {}, userId = OWNER) => { const i = mkInteraction({ userId, group, sub, opts }); await commands.handleInteraction(i, ctx); return i; };
  const text = (i) => i.replies[i.replies.length - 1].content;
  return { settings, state, ctx, run, text, changes, left, logs };
}

test('definition is valid for Discord: limits, required-first, admin-only default, single /bridge command', () => {
  const d = commands.definition();
  assert.strictEqual(d.name, 'bridge'); assert.strictEqual(d.default_member_permissions, '8'); assert(d.options.length <= 25);
  let size = 0;
  const walk = (o, depth) => {
    assert(/^[-_\p{L}\p{N}]{1,32}$/u.test(o.name) && o.name === o.name.toLowerCase(), `bad name ${o.name}`);
    assert(o.description.length >= 1 && o.description.length <= 100, `description length: ${o.name}`);
    size += o.name.length + o.description.length;
    for (const c of o.choices || []) size += c.name.length + String(c.value).length;
    const opts = o.options || [];
    assert(opts.length <= 25, `too many options in ${o.name}`);
    let seenOptional = false;
    for (const x of opts) { if (x.type > 2) { if (!x.required) seenOptional = true; else assert(!seenOptional, `required option after optional in ${o.name}/${x.name}`); } walk(x, depth + 1); }
    if (o.type === 2) { assert(opts.length >= 1); for (const x of opts) assert.strictEqual(x.type, 1, 'groups contain subcommands'); }
  };
  walk(d, 0);
  assert(size < 6000, `definition too large: ${size}`);
  const keys = [];
  for (const o of d.options) { if (o.type === 1) keys.push(o.name); else for (const s of o.options) keys.push(`${o.name}.${s.name}`); }
  for (const k of keys) assert(commands.HANDLERS[k], `no handler for ${k}`);
  for (const k of Object.keys(commands.HANDLERS)) assert(keys.includes(k), `handler without definition: ${k}`);
});

test('owner-only enforcement in code: non-owner gets an ephemeral refusal and nothing changes', async () => {
  const r = rig();
  const i = await r.run('mode', 'new-users', { value: 'wake-as-other' }, OTHER);
  assert.strictEqual(i.replies.length, 1); assert.strictEqual(i.replies[0].flags, 64);
  assert(/Only the bridge owner/.test(i.replies[0].content));
  assert.strictEqual(r.settings.get().newUsers, 'ignore');
  const j = await r.run(null, 'export', {}, OTHER); assert(!j.replies[0].files, 'no export for non-owners');
  assert(r.logs.some((l) => /denied/.test(l)));
  // other command names / non chat-input interactions are ignored
  assert.strictEqual(await commands.handleInteraction({ isChatInputCommand: () => false }, r.ctx), false);
  assert.strictEqual(await commands.handleInteraction({ isChatInputCommand: () => true, commandName: 'other' }, r.ctx), false);
});

test('every owner reply is ephemeral and suppresses mentions', async () => {
  const r = rig();
  for (const [g, s, o] of [[null, 'status', {}], ['allow-user', 'list', {}], ['block', 'list', {}], ['bots', 'list', {}], ['guilds', 'list', {}], ['channels', 'list', {}]]) {
    const i = await r.run(g, s, o);
    assert.strictEqual(i.replies[0].flags, 64, `${g}/${s} ephemeral`); assert.deepStrictEqual(i.replies[0].allowedMentions, { parse: [] });
  }
});

test('status: health, uptime, last wake, counters and current settings', async () => {
  const r = rig();
  r.state.recordWake('dm', Date.UTC(2026, 9, 24, 12, 0, 0)); r.state.countDrop('stranger'); r.state.recordWebhook({ ok: true, status: 200 });
  const t = r.text(await r.run(null, 'status'));
  for (const s of ['healthy', 'READY', '1h 1m', 'last wake: 2026-10-24T12:00:00.000Z (dm)', 'HTTP 200', 'stranger 1', 'new users: ignore', 'cooldown: 15s', 'daily cap: 200', 'quiet hours: off']) assert(t.includes(s), `status missing "${s}"\n${t}`);
});

test('quiet-hours set/off: validation, overnight, mode and owner flag', async () => {
  const r = rig();
  let t = r.text(await r.run('quiet-hours', 'set', { start: '22:00', end: '07:00', tz: 'America/Chicago', mode: 'hold', 'owner-always': false }));
  assert(/overnight/.test(t)); const q = r.settings.get().quietHours;
  assert.deepStrictEqual([q.enabled, q.start, q.end, q.tz, q.mode, q.ownerAlways], [true, '22:00', '07:00', 'America/Chicago', 'hold', false]);
  assert(/⚠️/.test(r.text(await r.run('quiet-hours', 'set', { start: '25:00', end: '07:00', tz: 'UTC' }))));
  assert(/⚠️/.test(r.text(await r.run('quiet-hours', 'set', { start: '08:00', end: '08:00', tz: 'UTC' }))));
  assert(/Unknown timezone/.test(r.text(await r.run('quiet-hours', 'set', { start: '01:00', end: '02:00', tz: 'Mars/Base' }))));
  assert.strictEqual(r.settings.get().quietHours.start, '22:00', 'failed commands change nothing');
  await r.run('quiet-hours', 'off'); assert.strictEqual(r.settings.get().quietHours.enabled, false);
  await r.run('quiet-hours', 'set', { start: '23:30', end: '06:00', tz: 'UTC' });
  assert.strictEqual(r.settings.get().quietHours.mode, 'hold', 'omitted options keep their previous value');
});

test('allow-user / block: add, remove, list; owner and bots refused; block beats approve; pending cleared', async () => {
  const r = rig();
  r.state.notePending(FRIEND, 'friendly');
  await r.run('allow-user', 'add', { user: { id: FRIEND, username: 'friendly', bot: false } });
  assert.deepStrictEqual(r.settings.get().approved.map((u) => [u.id, u.label]), [[FRIEND, 'friendly']]);
  assert.strictEqual(r.state.pending[FRIEND], undefined, 'approving removes them from the pending list');
  assert(r.text(await r.run('allow-user', 'list')).includes(FRIEND));
  await r.run('block', 'add', { 'user-id': FRIEND });
  assert.deepStrictEqual([r.settings.get().approved.length, r.settings.get().blocked.length], [0, 1]);
  await r.run('allow-user', 'add', { 'user-id': FRIEND });
  assert.deepStrictEqual([r.settings.get().approved.length, r.settings.get().blocked.length], [1, 0], 'approving unblocks');
  assert(/that is you/i.test(r.text(await r.run('allow-user', 'add', { 'user-id': OWNER }))));
  assert(/bot/i.test(r.text(await r.run('allow-user', 'add', { user: { id: OTHER, username: 'robo', bot: true } }))));
  assert(/numeric|digits/i.test(r.text(await r.run('block', 'add', { 'user-id': 'abc' }))));
  assert(/Pick a user/.test(r.text(await r.run('block', 'add', {}))));
  await r.run('allow-user', 'remove', { 'user-id': FRIEND }); assert.strictEqual(r.settings.get().approved.length, 0);
  await r.run('block', 'remove', { 'user-id': FRIEND });
  assert(/Blocked \(0\)/.test(r.text(await r.run('block', 'list'))));
});

test('mode new-users: all three modes; invalid value rejected', async () => {
  const r = rig();
  for (const m of ['approved-only', 'wake-as-other', 'ignore']) { await r.run('mode', 'new-users', { value: m }); assert.strictEqual(r.settings.get().newUsers, m); }
  assert(/⚠️/.test(r.text(await r.run('mode', 'new-users', { value: 'everyone' })))); assert.strictEqual(r.settings.get().newUsers, 'ignore');
});

test('guilds: allow/deny/forget/mode/list/leave', async () => {
  const r = rig();
  await r.run('guilds', 'allow', { 'guild-id': G }); assert.deepStrictEqual(r.settings.get().guilds.allow, [G]);
  await r.run('guilds', 'deny', { 'guild-id': G }); assert.deepStrictEqual([r.settings.get().guilds.allow, r.settings.get().guilds.deny], [[], [G]]);
  await r.run('guilds', 'allow', { 'guild-id': G }); assert.deepStrictEqual([r.settings.get().guilds.allow, r.settings.get().guilds.deny], [[G], []]);
  await r.run('guilds', 'mode', { value: 'allowlist' }); assert.strictEqual(r.settings.get().guilds.mode, 'allowlist');
  assert(r.text(await r.run('guilds', 'list')).includes('Test Guild'));
  await r.run('guilds', 'forget', { 'guild-id': G }); assert.deepStrictEqual(r.settings.get().guilds.allow, []);
  assert(/numeric/.test(r.text(await r.run('guilds', 'allow', { 'guild-id': 'nope' }))));
  assert(/Left server/.test(r.text(await r.run('guilds', 'leave', { 'guild-id': G })))); assert.deepStrictEqual(r.left, [G]);
  assert(/not in server/.test(r.text(await r.run('guilds', 'leave', { 'guild-id': '600000000000000002' }))));
});

test('channels: allow/deny/clear/list per guild', async () => {
  const r = rig();
  const ch = (id) => ({ id, guildId: G });
  await r.run('channels', 'allow', { channel: ch(CH) }); await r.run('channels', 'allow', { channel: ch('500000000000000002') });
  assert.deepStrictEqual(r.settings.get().channels[G], [CH, '500000000000000002']);
  assert(r.text(await r.run('channels', 'list')).includes(`<#${CH}>`));
  await r.run('channels', 'deny', { channel: ch(CH) }); assert.deepStrictEqual(r.settings.get().channels[G], ['500000000000000002']);
  await r.run('channels', 'clear', { 'guild-id': G }); assert.deepStrictEqual(r.settings.get().channels, {});
  assert(/Pick a server text channel/.test(r.text(await r.run('channels', 'allow', { channel: { id: CH, guildId: null } }))));
});

test('bots: allow/deny/list/limit', async () => {
  const r = rig();
  await r.run('bots', 'allow', { user: { id: OTHER, username: 'helper', bot: true } }); assert.deepStrictEqual(r.settings.get().bots.allow, [OTHER]);
  await r.run('bots', 'limit', { 'per-minute': 5 }); assert.strictEqual(r.settings.get().bots.maxWakesPerMinute, 5);
  assert(r.text(await r.run('bots', 'list')).includes(OTHER));
  await r.run('bots', 'deny', { 'user-id': OTHER }); assert.deepStrictEqual(r.settings.get().bots.allow, []);
  assert(/own bot/.test(r.text(await r.run('bots', 'allow', { 'user-id': BOT_ID }))));
});

test('cooldown, daily-cap, followup-window, options', async () => {
  const r = rig();
  await r.run('cooldown', 'set', { seconds: 60 }); assert.strictEqual(r.settings.get().cooldownSeconds, 60);
  await r.run('daily-cap', 'set', { max: 25, tz: 'America/Chicago' }); assert.deepStrictEqual(r.settings.get().dailyCap, { max: 25, tz: 'America/Chicago' });
  assert(/Unknown timezone/.test(r.text(await r.run('daily-cap', 'set', { max: 5, tz: 'Nope/Nope' })))); assert.strictEqual(r.settings.get().dailyCap.max, 25);
  await r.run('followup-window', 'set', { minutes: 0 }); assert.strictEqual(r.settings.get().followupMinutes, 0);
  await r.run('followup-window', 'set', { minutes: 15 }); assert.strictEqual(r.settings.get().followupMinutes, 15);
  await r.run('options', 'set', { 'debounce-seconds': 9, 'react-eyes': false }); assert.deepStrictEqual(r.settings.get().options, { debounceSeconds: 9, reactEyes: false, typing: true });
  assert(/at least one/.test(r.text(await r.run('options', 'set', {}))));
});

test('status-text and pinned-channel: set/clear notify the runtime; text sanitized', async () => {
  const r = rig();
  await r.run('status-text', 'set', { text: '  hello\nthere\u0000  ', status: 'dnd' });
  assert.deepStrictEqual([r.settings.get().presence.text, r.settings.get().presence.status], ['hello there', 'dnd']);
  assert.deepStrictEqual(r.changes.pop(), ['presence']);
  await r.run('status-text', 'clear'); assert.strictEqual(r.settings.get().presence.text, '');
  await r.run('pinned-channel', 'set', { channel: { id: CH, guildId: G } }); assert.strictEqual(r.settings.get().pinnedChannelId, CH);
  assert.deepStrictEqual(r.changes.pop(), ['pinnedChannelId']);
  await r.run('pinned-channel', 'clear'); assert.strictEqual(r.settings.get().pinnedChannelId, '');
});

test('test-webhook reports the HTTP status (deferred reply), with hints for failures', async () => {
  const r = rig();
  let i = await r.run(null, 'test-webhook');
  assert.deepStrictEqual(i.replies.map((x) => x.kind), ['defer', 'edit']); assert.strictEqual(i.replies[0].flags, 64);
  assert(/HTTP 202/.test(i.replies[1].content));
  r.ctx.testWebhook = async () => ({ ok: false, status: 401 });
  i = await r.run(null, 'test-webhook'); assert(/HTTP 401/.test(i.replies[1].content) && /key was rejected/.test(i.replies[1].content));
  r.ctx.testWebhook = async () => ({ ok: false, status: 0 });
  i = await r.run(null, 'test-webhook'); assert(/No response/.test(i.replies[1].content));
});

test('export attaches settings.json without secrets; reset needs confirm', async () => {
  const r = rig();
  await r.run('cooldown', 'set', { seconds: 77 });
  const i = await r.run(null, 'export');
  const f = i.replies[0].files[0]; assert.strictEqual(f.name, 'settings.json');
  const j = JSON.parse(f.attachment.toString()); assert.strictEqual(j.cooldownSeconds, 77);
  assert(!/token|key|webhook/i.test(f.attachment.toString().replace(/"quietHours|"dailyCap/g, '')), 'no secret-like fields in export');
  assert(/confirm:true/.test(r.text(await r.run(null, 'reset', { confirm: false })))); assert.strictEqual(r.settings.get().cooldownSeconds, 77);
  await r.run(null, 'reset', { confirm: true }); assert.strictEqual(r.settings.get().cooldownSeconds, 15);
  assert.deepStrictEqual(r.changes.pop(), ['*']);
});

test('unexpected errors give a generic message (no stack or secret leak) and are logged', async () => {
  const r = rig();
  r.ctx.getStatus = () => { throw new Error('boom internal'); };
  const t = r.text(await r.run(null, 'status'));
  assert(/Something went wrong/.test(t)); assert(!/boom internal/.test(t));
  assert(r.logs.some((l) => /error/.test(l)));
});
