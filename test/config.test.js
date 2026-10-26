'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkTmp, OWNER } = require('./helpers');
const { loadConfig, parseEnv } = require('../lib/config');

const GOOD = { DISCORD_BOT_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc', WEBHOOK_URL: 'https://example.invalid/hook', WEBHOOK_KEY: 'k-1234567890', OWNER_ID: OWNER };

test('parseEnv: comments, quotes, blank lines', () => {
  assert.deepStrictEqual(parseEnv('# c\nA=1\nB="two words"\n\nC=\'x\'\nbad line\n'), { A: '1', B: 'two words', C: 'x' });
});

test('loadConfig: all four required values; missing ones are listed, with an actionable message each', () => {
  const c = loadConfig({ env: {}, envFile: '/nonexistent' });
  assert.deepStrictEqual(c.missing, ['DISCORD_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_KEY', 'OWNER_ID']);
  assert.strictEqual(c.problems.length, 4);
  assert(c.problems.find((p) => p.startsWith('OWNER_ID')).includes('Developer Mode'));
  assert.deepStrictEqual(loadConfig({ env: GOOD, envFile: '/nonexistent' }).problems, []);
});

test('loadConfig: OWNER_ID is required and validated; placeholders count as missing; http only for localhost', () => {
  assert(loadConfig({ env: { ...GOOD, OWNER_ID: '' }, envFile: '/x' }).missing.includes('OWNER_ID'));
  assert(loadConfig({ env: { ...GOOD, OWNER_ID: 'myname' }, envFile: '/x' }).problems.some((p) => /numeric/.test(p)));
  assert(loadConfig({ env: { ...GOOD, WEBHOOK_KEY: 'your_key_here' }, envFile: '/x' }).missing.includes('WEBHOOK_KEY'));
  assert(loadConfig({ env: { ...GOOD, WEBHOOK_URL: 'http://example.invalid/h' }, envFile: '/x' }).problems.some((p) => /plain http/.test(p)));
  assert.deepStrictEqual(loadConfig({ env: { ...GOOD, WEBHOOK_URL: 'http://127.0.0.1:9/h' }, envFile: '/x' }).problems, []);
  assert(loadConfig({ env: { ...GOOD, WEBHOOK_URL: 'not a url' }, envFile: '/x' }).problems.some((p) => /valid http/.test(p)));
  assert(loadConfig({ env: { ...GOOD, DISCORD_BOT_TOKEN: 'abc' }, envFile: '/x' }).problems.some((p) => /bot token/.test(p)));
});

test('loadConfig: process env wins over .env file; file fills the rest; problems never contain secret values', () => {
  const f = path.join(mkTmp(), '.env');
  fs.writeFileSync(f, `DISCORD_BOT_TOKEN=${GOOD.DISCORD_BOT_TOKEN}\nWEBHOOK_URL=https://file.invalid/h\nWEBHOOK_KEY=file-key-123456\nOWNER_ID=notanumber\n`);
  const c = loadConfig({ env: { WEBHOOK_URL: 'https://env.invalid/h' }, envFile: f });
  assert.strictEqual(c.webhookUrl, 'https://env.invalid/h'); assert.strictEqual(c.webhookKey, 'file-key-123456');
  assert(!c.problems.join(' ').includes('file-key-123456'));
});

test('bot.js refuses to start without OWNER_ID: exit 78, clear message, no secrets printed, never reaches Discord', () => {
  const dir = mkTmp();
  const env = { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'none.env'), DATA_DIR: path.join(dir, 'data'), DISCORD_BOT_TOKEN: GOOD.DISCORD_BOT_TOKEN, WEBHOOK_URL: GOOD.WEBHOOK_URL, WEBHOOK_KEY: GOOD.WEBHOOK_KEY };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bot.js')], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 78);
  assert(/OWNER_ID is not set/.test(r.stderr));
  assert(!r.stderr.includes(GOOD.DISCORD_BOT_TOKEN) && !r.stderr.includes(GOOD.WEBHOOK_KEY));
  assert(!fs.existsSync(path.join(dir, 'data')), 'nothing written before config is valid');
});
