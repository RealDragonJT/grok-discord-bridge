'use strict';
// doctor.js with no bot token: exercises config checks and the webhook probe offline (it never contacts Discord without a token).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { mkTmp, fakeWebhook, OWNER } = require('./helpers');

const run = (env, args = []) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'doctor.js'), ...args], { env: { PATH: process.env.PATH, ENV_FILE: '/nonexistent', DATA_DIR: path.join(mkTmp(), 'd'), ...env }, cwd: mkTmp() });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});

test('doctor: actionable errors for missing values, nothing secret printed, non-zero exit', async () => {
  const r = await run({ WEBHOOK_KEY: 'super-secret-key-9999' }, ['--no-webhook']);
  assert.strictEqual(r.code, 1);
  assert(/\[FAIL\] Configuration: DISCORD_BOT_TOKEN is not set/.test(r.out));
  assert(/\[FAIL\] Configuration: OWNER_ID is not set/.test(r.out));
  assert(/\[SKIP\] Bot token/.test(r.out));
  assert(!r.out.includes('super-secret-key-9999'));
});

test('doctor: webhook probe reports OK, rejected key and unreachable URL with fixes; --json output', async () => {
  const hook = await fakeWebhook(() => 200, 'good-key-123456');
  let r = await run({ WEBHOOK_URL: hook.cfg.webhookUrl, WEBHOOK_KEY: 'good-key-123456', OWNER_ID: OWNER });
  assert(/\[ OK \] Webhook: HTTP 200/.test(r.out), r.out);
  assert.strictEqual(hook.received[0].event, 'bridge_test');
  r = await run({ WEBHOOK_URL: hook.cfg.webhookUrl, WEBHOOK_KEY: 'wrong-key-123456', OWNER_ID: OWNER });
  assert(/\[FAIL\] Webhook: HTTP 401: the key was rejected/.test(r.out) && /fix: Re-copy the key/.test(r.out));
  assert(!r.out.includes('wrong-key-123456'));
  r = await run({ WEBHOOK_URL: 'http://127.0.0.1:9/nope', WEBHOOK_KEY: 'k-123456789', OWNER_ID: OWNER });
  assert(/\[FAIL\] Webhook: no response/.test(r.out));
  r = await run({ WEBHOOK_URL: hook.cfg.webhookUrl, WEBHOOK_KEY: 'good-key-123456', OWNER_ID: OWNER }, ['--json', '--no-webhook']);
  const j = JSON.parse(r.out); assert.strictEqual(j.ok, false); assert(j.results.some((x) => x.name === 'Webhook' && x.status === 'skip'));
  hook.srv.closeAllConnections(); await hook.close();
});
