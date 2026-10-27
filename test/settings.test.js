'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkTmp, modeIs600 } = require('./helpers');
const S = require('../lib/settings');

test('defaults: safe out of the box', () => {
  const d = S.normalize({});
  assert.strictEqual(d.version, S.VERSION);
  assert.strictEqual(d.newUsers, 'ignore', 'strangers are ignored by default');
  assert.strictEqual(d.guilds.mode, 'allow-all');
  assert.deepStrictEqual(d.bots.allow, [], 'bots ignored by default');
  assert.strictEqual(d.quietHours.enabled, false);
  assert.strictEqual(d.cooldownSeconds, 15);
  assert.strictEqual(d.dailyCap.max, 200);
});

test('load/save round trip: first load creates the file with mode 600; updates are atomic and normalized', () => {
  const dir = mkTmp(); const f = path.join(dir, 'settings.json');
  const st = new S.SettingsStore(f);
  assert(fs.existsSync(f));
  assert(modeIs600(f), 'file mode 600');
  st.update((d) => { d.cooldownSeconds = 42; d.approved.push({ id: '300000000000000001', label: 'friend' }); d.quietHours = { ...d.quietHours, enabled: true, tz: 'America/Chicago' }; });
  const st2 = new S.SettingsStore(f);
  assert.strictEqual(st2.get().cooldownSeconds, 42);
  assert.deepStrictEqual(st2.get().approved.map((u) => u.id), ['300000000000000001']);
  assert.strictEqual(st2.get().quietHours.tz, 'America/Chicago');
  assert(modeIs600(f), 'file mode 600');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
});

test('normalize clamps and rejects garbage', () => {
  const n = S.normalize({ cooldownSeconds: -5, followupMinutes: 99999, newUsers: 'bogus', guilds: { mode: 'x', allow: ['abc', '400000000000000001', '400000000000000001'] }, quietHours: { enabled: true, start: '25:00', end: '07:00', tz: 'Not/AZone' }, options: { debounceSeconds: 0 }, presence: { text: 'x'.repeat(500), status: 'weird' }, pinnedChannelId: 'nope', dailyCap: { max: 'many' } });
  assert.strictEqual(n.cooldownSeconds, 0); assert.strictEqual(n.followupMinutes, 1440); assert.strictEqual(n.newUsers, 'ignore');
  assert.strictEqual(n.guilds.mode, 'allow-all'); assert.deepStrictEqual(n.guilds.allow, ['400000000000000001']);
  assert.strictEqual(n.quietHours.enabled, false, 'invalid start disables quiet hours'); assert.strictEqual(n.quietHours.tz, 'UTC');
  assert.strictEqual(n.options.debounceSeconds, 1); assert.strictEqual(n.presence.text.length, 128); assert.strictEqual(n.presence.status, 'online');
  assert.strictEqual(n.pinnedChannelId, ''); assert.strictEqual(n.dailyCap.max, 200);
  assert.strictEqual(S.normalize({ quietHours: { enabled: true, start: '08:00', end: '08:00' } }).quietHours.enabled, false, 'start == end is not a valid range');
});

test('migration: v0 (unversioned) file is upgraded and rewritten as v1', () => {
  const dir = mkTmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ approved: ['300000000000000001'], blocked: [{ id: '300000000000000002', username: 'spam' }], strangers: 'wake-as-other', quietStart: '23:00', quietEnd: '06:30', quietTz: 'Europe/Berlin', cooldown: 30, dailyMax: 50 }));
  const logs = [];
  const st = new S.SettingsStore(f, { log: (m) => logs.push(m) });
  const s = st.get();
  assert.strictEqual(s.version, 1);
  assert.strictEqual(s.newUsers, 'wake-as-other');
  assert.deepStrictEqual(s.approved.map((u) => u.id), ['300000000000000001']);
  assert.strictEqual(s.blocked[0].label, 'spam');
  assert.deepStrictEqual([s.quietHours.enabled, s.quietHours.start, s.quietHours.end, s.quietHours.tz], [true, '23:00', '06:30', 'Europe/Berlin']);
  assert.strictEqual(s.cooldownSeconds, 30); assert.strictEqual(s.dailyCap.max, 50);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 1, 'rewritten on disk');
  assert(logs.some((l) => /migrated/.test(l)));
  assert.strictEqual(S.migrate({ version: 1, cooldownSeconds: 3 }).cooldownSeconds, 3, 'v1 passes through untouched');
});

test('corrupt file: backed up and reset to defaults instead of crashing', () => {
  const dir = mkTmp(); const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, '{ not json');
  const st = new S.SettingsStore(f);
  assert.strictEqual(st.get().newUsers, 'ignore');
  assert(fs.readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-')));
});

test('SETTINGS_B64 seeds a missing file only (App Platform ephemeral disk)', () => {
  const dir = mkTmp(); const f = path.join(dir, 'settings.json');
  const b64 = Buffer.from(JSON.stringify({ version: 1, cooldownSeconds: 77, newUsers: 'approved-only' })).toString('base64');
  assert.strictEqual(new S.SettingsStore(f, { seedB64: b64 }).get().cooldownSeconds, 77);
  new S.SettingsStore(f).update((d) => { d.cooldownSeconds = 5; });
  assert.strictEqual(new S.SettingsStore(f, { seedB64: b64 }).get().cooldownSeconds, 5, 'existing file wins over the seed');
  assert.strictEqual(new S.SettingsStore(path.join(dir, 'other.json'), { seedB64: '%%%not base64 json%%%' }).get().newUsers, 'ignore');
});

test('reset returns to defaults; export is plain JSON without secrets', () => {
  const st = new S.SettingsStore(path.join(mkTmp(), 's.json'));
  st.update((d) => { d.cooldownSeconds = 99; });
  assert.strictEqual(JSON.parse(st.exportJson()).cooldownSeconds, 99);
  st.reset();
  assert.strictEqual(st.get().cooldownSeconds, 15);
});

test('time helpers', () => {
  assert.strictEqual(S.parseHHMM('7:05'), 425); assert.strictEqual(S.parseHHMM('24:00'), null); assert.strictEqual(S.parseHHMM('ab'), null);
  assert.strictEqual(S.fmtHHMM(425), '07:05');
  assert(S.validTz('America/Chicago')); assert(!S.validTz('Mars/Olympus')); assert(!S.validTz(''));
});
