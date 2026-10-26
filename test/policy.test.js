'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mkTmp, OWNER } = require('./helpers');
const { SettingsStore } = require('../lib/settings');
const { RuntimeState } = require('../lib/state');
const { Policy, isQuiet, dayKey } = require('../lib/policy');

const APPROVED = '300000000000000001', STRANGER = '300000000000000002', BLOCKED = '300000000000000003', BOT = '400000000000000001';
const NOW = Date.UTC(2026, 9, 24, 15, 0, 0);

function setup(mut) {
  const dir = mkTmp();
  const settings = new SettingsStore(path.join(dir, 's.json'));
  settings.update((d) => {
    d.approved = [{ id: APPROVED }]; d.blocked = [{ id: BLOCKED }]; d.newUsers = 'wake-as-other'; d.cooldownSeconds = 0; d.dailyCap.max = 0;
    if (mut) mut(d);
  });
  const state = new RuntimeState(path.join(dir, 'state.json'));
  return { settings, state, policy: new Policy({ getSettings: () => settings.get(), ownerId: OWNER, state }) };
}
const msg = (o = {}) => ({ authorId: STRANGER, authorIsBot: false, kind: 'mention', guildId: 'g1', channelId: 'c1', ts: NOW, pendingSameUser: false, released: false, ...o });

test('role resolution is by id: owner | approved | other', () => {
  const { policy } = setup();
  assert.strictEqual(policy.roleOf(OWNER), 'owner');
  assert.strictEqual(policy.roleOf(APPROVED), 'approved');
  assert.strictEqual(policy.roleOf(STRANGER), 'other');
  assert.strictEqual(policy.roleOf(BLOCKED), 'other');
});

test('quiet hours: overnight range, timezone and DST (America/Chicago)', () => {
  const q = { enabled: true, start: '22:00', end: '07:00', tz: 'America/Chicago' };
  assert.strictEqual(isQuiet(q, Date.parse('2026-10-26T03:30:00Z')), true, '22:30 CDT');
  assert.strictEqual(isQuiet(q, Date.parse('2026-10-26T11:59:00Z')), true, '06:59 CDT');
  assert.strictEqual(isQuiet(q, Date.parse('2026-10-26T12:00:00Z')), false, '07:00 CDT is the end (exclusive)');
  assert.strictEqual(isQuiet(q, Date.parse('2026-10-26T20:00:00Z')), false, '15:00 CDT');
  assert.strictEqual(isQuiet(q, Date.parse('2026-11-02T03:30:00Z')), false, '21:30 CST after DST ends');
  assert.strictEqual(isQuiet(q, Date.parse('2026-11-02T04:30:00Z')), true, '22:30 CST');
  assert.strictEqual(isQuiet({ ...q, tz: 'UTC' }, Date.parse('2026-10-26T03:30:00Z')), true);
  assert.strictEqual(isQuiet({ ...q, tz: 'Asia/Tokyo' }, Date.parse('2026-10-26T03:30:00Z')), false, '12:30 JST');
});

test('quiet hours: same-day range, disabled, degenerate range', () => {
  const day = { enabled: true, start: '09:00', end: '17:00', tz: 'UTC' };
  assert.strictEqual(isQuiet(day, Date.parse('2026-10-24T09:00:00Z')), true);
  assert.strictEqual(isQuiet(day, Date.parse('2026-10-24T16:59:00Z')), true);
  assert.strictEqual(isQuiet(day, Date.parse('2026-10-24T17:00:00Z')), false);
  assert.strictEqual(isQuiet({ ...day, enabled: false }, Date.parse('2026-10-24T10:00:00Z')), false);
  assert.strictEqual(isQuiet({ ...day, end: '09:00' }, Date.parse('2026-10-24T10:00:00Z')), false);
});

test('quiet hours: non-owner suppressed or held; owner always wakes unless ownerAlways is off', () => {
  const quiet = (mode, ownerAlways = true) => (d) => { d.quietHours = { enabled: true, start: '00:00', end: '23:59', tz: 'UTC', mode, ownerAlways }; };
  let { policy } = setup(quiet('suppress'));
  assert.deepStrictEqual([policy.admit(msg({ authorId: STRANGER }), NOW).action, policy.admit(msg({ authorId: STRANGER }), NOW).reason], ['drop', 'quiet-hours']);
  assert.strictEqual(policy.admit(msg({ authorId: OWNER }), NOW).action, 'wake');
  ({ policy } = setup(quiet('hold')));
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED }), NOW).action, 'hold');
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED, released: true }), NOW).action, 'wake', 'released messages skip the quiet check');
  ({ policy } = setup(quiet('suppress', false)));
  assert.strictEqual(policy.admit(msg({ authorId: OWNER }), NOW).action, 'drop', 'owner is quiet too when ownerAlways=false');
});

test('cooldown: per-user, owner exempt, same-batch messages do not count twice', () => {
  const { policy } = setup((d) => { d.cooldownSeconds = 30; });
  assert.strictEqual(policy.admit(msg(), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg(), NOW + 5000).reason, 'cooldown');
  assert.strictEqual(policy.admit(msg({ pendingSameUser: true }), NOW + 5000).action, 'wake', 'part of the batch already pending');
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED }), NOW + 5000).action, 'wake', 'other users have their own cooldown');
  assert.strictEqual(policy.admit(msg(), NOW + 31000).action, 'wake');
  for (let i = 0; i < 5; i++) assert.strictEqual(policy.admit(msg({ authorId: OWNER }), NOW + i).action, 'wake');
});

test('daily cap: counts non-owner wakes, owner exempt, owner told once per day, resets next day (tz aware)', () => {
  const { policy, state } = setup((d) => { d.dailyCap = { max: 2, tz: 'UTC' }; });
  assert.strictEqual(policy.admit(msg({ authorId: STRANGER }), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED }), NOW).action, 'wake');
  const a = policy.admit(msg({ authorId: STRANGER }), NOW); const b = policy.admit(msg({ authorId: APPROVED }), NOW);
  assert.deepStrictEqual([a.reason, a.notifyCap], ['daily-cap', true]);
  assert.deepStrictEqual([b.reason, b.notifyCap], ['daily-cap', false], 'owner is only notified once');
  assert.strictEqual(policy.admit(msg({ authorId: OWNER }), NOW).action, 'wake', 'owner exempt');
  assert.strictEqual(state.dailyCount, 2);
  const tomorrow = NOW + 24 * 3600 * 1000;
  assert.strictEqual(policy.admit(msg({ authorId: STRANGER }), tomorrow).action, 'wake', 'new day');
  assert.strictEqual(dayKey(Date.parse('2026-10-24T03:00:00Z'), 'America/Chicago'), '2026-10-23');
  assert.strictEqual(dayKey(Date.parse('2026-10-24T03:00:00Z'), 'UTC'), '2026-10-24');
});

test('guild allow/deny, allowlist mode, and per-guild channel allowlist (owner exempt, DMs unaffected)', () => {
  const G1 = '600000000000000001', G2 = '600000000000000002', G9 = '600000000000000009';
  let { policy } = setup((d) => { d.guilds.deny = [G9]; });
  assert.strictEqual(policy.admit(msg({ guildId: G9 }), NOW).reason, 'guild');
  assert.strictEqual(policy.admit(msg({ guildId: G1 }), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg({ guildId: G9, authorId: OWNER }), NOW).action, 'wake', 'owner exempt');
  ({ policy } = setup((d) => { d.guilds.mode = 'allowlist'; d.guilds.allow = [G1]; }));
  assert.strictEqual(policy.admit(msg({ guildId: G2 }), NOW).reason, 'guild');
  assert.strictEqual(policy.admit(msg({ guildId: G1 }), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg({ guildId: null, kind: 'dm', channelId: 'd1' }), NOW).action, 'wake', 'DMs have no guild');
  ({ policy } = setup((d) => { d.channels = { '123456789012345678': ['500000000000000001'] }; }));
  const g = '123456789012345678';
  assert.strictEqual(policy.admit(msg({ guildId: g, channelId: '500000000000000002' }), NOW).reason, 'channel');
  assert.strictEqual(policy.admit(msg({ guildId: g, channelId: '500000000000000001' }), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg({ guildId: 'other', channelId: 'x' }), NOW).action, 'wake', 'no allowlist for that guild');
  assert.strictEqual(policy.admit(msg({ guildId: g, channelId: '500000000000000002', authorId: OWNER }), NOW).action, 'wake');
});

test('bots: ignored by default; allowlisted bots may @mention in guilds; loop guard caps wakes per minute', () => {
  let { policy } = setup();
  assert.strictEqual(policy.admit(msg({ authorId: BOT, authorIsBot: true }), NOW).reason, 'bot');
  ({ policy } = setup((d) => { d.bots = { allow: [BOT], maxWakesPerMinute: 2 }; }));
  const bm = (o = {}) => msg({ authorId: BOT, authorIsBot: true, ...o });
  assert.strictEqual(policy.admit(bm(), NOW).action, 'wake');
  assert.strictEqual(policy.admit(bm(), NOW + 1000).action, 'wake');
  assert.strictEqual(policy.admit(bm(), NOW + 2000).reason, 'bot-loop-guard', 'third ping within a minute is dropped (no ping-pong)');
  assert.strictEqual(policy.admit(bm(), NOW + 61000).action, 'wake', 'window slides');
  assert.strictEqual(policy.admit(bm({ kind: 'dm', guildId: null }), NOW + 200000).reason, 'bot', 'bots never wake via DM');
  assert.strictEqual(policy.admit(bm({ kind: 'followup' }), NOW + 300000).reason, 'bot');
  assert.strictEqual(policy.admit(msg({ authorId: '400000000000000002', authorIsBot: true }), NOW).reason, 'bot', 'non-allowlisted bot');
  assert.strictEqual(policy.roleOf(BOT), 'other');
});

test('new-users modes: ignore | approved-only (tracks pending) | wake-as-other; approved and owner unaffected', () => {
  let { policy } = setup((d) => { d.newUsers = 'ignore'; });
  assert.strictEqual(policy.admit(msg(), NOW).reason, 'stranger');
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED }), NOW).action, 'wake');
  assert.strictEqual(policy.admit(msg({ authorId: OWNER }), NOW).action, 'wake');
  ({ policy } = setup((d) => { d.newUsers = 'approved-only'; }));
  const r = policy.admit(msg(), NOW); assert.deepStrictEqual([r.reason, r.pending], ['stranger', true]);
  ({ policy } = setup((d) => { d.newUsers = 'wake-as-other'; }));
  const w = policy.admit(msg(), NOW); assert.deepStrictEqual([w.action, w.role], ['wake', 'other']);
});

test('blocked users never wake; blocking beats approval; followups are owner-only', () => {
  const { policy } = setup((d) => { d.approved.push({ id: BLOCKED }); });
  assert.strictEqual(policy.admit(msg({ authorId: BLOCKED }), NOW).reason, 'blocked');
  assert.strictEqual(policy.admit(msg({ authorId: BLOCKED, kind: 'dm', guildId: null }), NOW).reason, 'blocked');
  assert.strictEqual(policy.admit(msg({ authorId: APPROVED, kind: 'followup' }), NOW).reason, 'followup-not-owner');
  assert.strictEqual(policy.admit(msg({ authorId: OWNER, kind: 'followup' }), NOW).action, 'wake');
});
