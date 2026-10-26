'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkTmp } = require('./helpers');
const { HealthMonitor, statusName, EXIT_UNHEALTHY } = require('../lib/health');
const pins = require('../lib/pins');
const { RuntimeState } = require('../lib/state');
const { splitText, takeFlag } = require('../discord-cli');

test('health monitor: healthy stays ok; 2 consecutive not-READY / bad ping / stale ack / unverified clock jump => exit (75)', () => {
  assert.strictEqual(EXIT_UNHEALTHY, 75); assert.strictEqual(statusName(0), 'READY'); assert.strictEqual(statusName(5), 'DISCONNECTED');
  const T0 = 1e12; const good = (t) => ({ hasClient: true, status: 'READY', ping: 50, ackAt: t - 10000, lastEventAt: t - 5000, readyAt: T0 - 1e6, connectStartedAt: T0 - 1e6, everReady: true });
  let m = new HealthMonitor(); let t = T0;
  for (let i = 0; i < 5; i++) { t += 30000; assert.strictEqual(m.tick(t, good(t)).action, 'ok'); }
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), status: 'RECONNECTING' }).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, good(t)).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), status: 'DISCONNECTED' }).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), status: 'DISCONNECTED' }).action, 'exit');
  for (const bad of [-1, NaN]) {
    m = new HealthMonitor(); t = T0; m.tick(t, good(t));
    t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ping: bad }).action, 'ok');
    t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ping: bad }).action, 'exit');
  }
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ping: -1, readyAt: t - 20000 }).action, 'ok', 'settle window');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ping: -1, readyAt: t - 50000 }).action, 'ok');
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  for (let i = 0; i < 3; i++) { t += 30000; assert.strictEqual(m.tick(t, { hasClient: true, status: 'CONNECTING', ping: -1, ackAt: 0, lastEventAt: 0, readyAt: 0, connectStartedAt: T0, everReady: false }).action, 'ok', 'first-login grace'); }
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ackAt: t - 300000 }).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ackAt: t - 330000 }).action, 'exit', 'stale heartbeat ack');
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  t += 3600000; let r = m.tick(t, { ...good(t), ackAt: t - 3000000, lastEventAt: t - 3000000 });
  assert.strictEqual(r.action, 'ok'); assert(r.notes.some((n) => /clock jumped/.test(n)));
  t += 30000; r = m.tick(t, { ...good(t), ackAt: t - 10000 }); assert(r.notes.some((n) => /verified healthy/.test(n)));
  m = new HealthMonitor(); t = T0; m.tick(t, good(t));
  t += 120000; assert.strictEqual(m.tick(t, { ...good(t), ackAt: t - 100000, lastEventAt: 0 }).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ackAt: t - 130000, lastEventAt: 0 }).action, 'ok');
  t += 30000; assert.strictEqual(m.tick(t, { ...good(t), ackAt: t - 160000, lastEventAt: 0 }).action, 'exit', 'clock jump not verified');
  m = new HealthMonitor(); t = T0;
  for (let i = 0; i < 6; i++) { t += 30000; assert.strictEqual(m.tick(t, { hasClient: false }).action, 'ok'); }
});

test('healthcheck.js (Docker HEALTHCHECK): reads data/health.json freshness', () => {
  const dir = mkTmp(); const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'healthcheck.js')], { env: { PATH: process.env.PATH, DATA_DIR: dir }, encoding: 'utf8' });
  assert.strictEqual(run().status, 1, 'no report yet');
  const f = path.join(dir, 'health.json');
  fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), connected: true, healthy: true, problems: [] })); assert.strictEqual(run().status, 0);
  fs.writeFileSync(f, JSON.stringify({ ts: Date.now() - 300000, connected: true, healthy: true, problems: [] })); assert.strictEqual(run().status, 1, 'stale');
  fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), connected: false, healthy: false, problems: ['ws_status=DISCONNECTED'] })); assert.strictEqual(run().status, 1);
});

test('pinned status: newest pin by bot/owner only, sanitized, optional status line, fallback on errors', async () => {
  const mk = (id, authorId, content, ts) => ({ message: { id, author: { id: authorId }, content }, pinnedTimestamp: ts });
  const ids = { botId: '999', ownerId: '42' };
  const items = [mk('p1', '666', 'evil status', 9000), mk('p2', '999', 'older bot status', 1000), mk('p3', '42', '  owner says hi \u0000 there\nstatus: dnd\nignored', 2000), mk('p4', '999', '   \n  ', 3000)];
  const pick = pins.pickPinned(items, ids);
  assert.deepStrictEqual([pick.messageId, pick.text, pick.status], ['p3', 'owner says hi there', 'dnd']);
  assert.strictEqual(pins.pickPinned([mk('x', '666', 'nope', 1)], ids), null, 'strangers\' pins ignored');
  assert.strictEqual(pins.pickPinned(items, { botId: '999', ownerId: '' }).messageId, 'p2');
  assert.strictEqual(pins.parsePinnedContent('a\nstatus: bogus').status, null);
  assert.strictEqual(pins.parsePinnedContent('Line\r\nStatus = Idle').status, 'idle');
  assert.strictEqual(pins.sanitizeText('x'.repeat(300)).length, 128);
  assert(pins.POLL_MS >= 120000);
  let cur = [mk('p1', '999', 'first', 1)]; let fail = null; const logs = []; const changes = [];
  const ps = new pins.PinnedStatus({ fetchPins: async () => { if (fail) throw fail; return cur; }, getIds: () => ids, log: (...a) => logs.push(a.join(' ')), onChange: (v) => changes.push(v && v.text) });
  await ps.poll(); await ps.poll(); assert.deepStrictEqual(changes, ['first']);
  cur = [mk('p1', '999', 'edited\nstatus: idle', 1)]; await ps.poll();
  assert.deepStrictEqual(changes, ['first', 'edited']); assert.strictEqual(ps.current.status, 'idle');
  fail = Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
  await ps.poll(); await ps.poll();
  assert.strictEqual(ps.current, null); assert.strictEqual(logs.filter((l) => /cannot read pins/.test(l)).length, 1);
  assert(!logs.join('\n').includes('edited'), 'pinned text is not logged');
  fail = null; cur = [mk('p9', '999', 'back', 5)]; await ps.poll(); assert.strictEqual(ps.current.text, 'back');
  fail = Object.assign(new Error('boom'), { status: 500 }); await ps.poll(); assert.strictEqual(ps.current.text, 'back', 'transient error keeps last value');
});

test('runtime state: persists counters, mode 600, no message text fields', () => {
  const dir = mkTmp(); const f = path.join(dir, 'state.json');
  const s = new RuntimeState(f); s.recordWake('mention', 1700000000000); s.countDrop('cooldown'); s.notePending('300000000000000001', 'rando', 1700000000000); s.dailyCount = 3; s.day = '2026-10-24'; s.touch(); s.flush();
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  const s2 = new RuntimeState(f);
  assert.deepStrictEqual([s2.stats.wakes, s2.stats.dropped.cooldown, s2.dailyCount, s2.pending['300000000000000001'].count], [1, 1, 3, 1]);
  for (let i = 0; i < 40; i++) s2.notePending(String(300000000000000100 + i), 'u', 1700000000000 + i);
  assert(Object.keys(s2.pending).length <= 25);
});

test('discord-cli helpers: splitText chunks <= 2000 losslessly; flag parsing', () => {
  const t = ('word '.repeat(1000)).trim();
  const parts = splitText(t); assert(parts.length >= 3 && parts.every((p) => p.length <= 2000));
  assert.strictEqual(parts.join(' ').replace(/\s+/g, ' '), t);
  assert.strictEqual(splitText('x'.repeat(4500)).length, 3);
  const a = ['c1', 'hi', '--reply-to', '55', '--no-ping'];
  assert.strictEqual(takeFlag(a, '--reply-to'), '55'); assert.strictEqual(takeFlag(a, '--no-ping', false), true); assert.deepStrictEqual(a, ['c1', 'hi']);
  assert.strictEqual(takeFlag(a, '--silent', false), false);
});

test('discord-cli never prints the token on errors (offline: invalid host is not contacted when token missing)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'discord-cli.js'), 'whoami'], { env: { PATH: process.env.PATH, ENV_FILE: '/nonexistent', HOME: mkTmp() }, cwd: mkTmp(), encoding: 'utf8' });
  assert.strictEqual(r.status, 1); assert(/DISCORD_BOT_TOKEN is not set/.test(r.stderr));
});
