'use strict';
// Runs the REAL bot.js in a child process against an in-memory fake discord.js Client and a local fake webhook.
// No network access to Discord. Catches wiring mistakes (undefined references, bad startup order, health file, shutdown).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mkTmp, fakeWebhook, OWNER } = require('./helpers');

test('bot.js end to end with a fake gateway: owner DM wakes the webhook, stranger is ignored, /bridge works for the owner only', async () => {
  const hook = await fakeWebhook(() => 200, 'smoke-key-123456');
  const dir = mkTmp();
  const settingsSeed = Buffer.from(JSON.stringify({ version: 1, options: { debounceSeconds: 1 } })).toString('base64');
  const env = {
    PATH: process.env.PATH, ENV_FILE: path.join(dir, 'none.env'), DATA_DIR: path.join(dir, 'data'), MOCK_OWNER_ID: OWNER,
    DISCORD_BOT_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc', WEBHOOK_URL: hook.cfg.webhookUrl, WEBHOOK_KEY: 'smoke-key-123456', OWNER_ID: OWNER, SETTINGS_B64: settingsSeed,
  };
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'mock-discord.js'), path.join(__dirname, '..', 'bot.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(hook.received.length >= 1 && /MOCK reply to=stranger/.test(out) && /catch-up/.test(out))) await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGTERM');
  let tmo; const ex = await Promise.race([exited, new Promise((r) => { tmo = setTimeout(() => r('timeout'), 8000); })]);
  clearTimeout(tmo);
  if (ex === 'timeout') child.kill('SIGKILL');
  hook.srv.closeAllConnections && hook.srv.closeAllConnections();
  await hook.close();

  assert.notStrictEqual(ex, 'timeout', 'clean shutdown on SIGTERM');
  assert.strictEqual(ex.code, 0, out);
  assert(/MOCK intents=4/.test(out), 'Guilds, GuildMessages, DirectMessages, MessageContent');
  assert(/clientReady: connected as MockBot#0000/.test(out), out);
  assert(/MOCK commands.set count=1 name=bridge/.test(out), 'slash command registered globally on ready');
  assert(/MOCK presence online/.test(out));
  assert(/fresh install\); skipping replay/.test(out), 'fresh install never replays old history');
  assert.strictEqual(hook.received.length, 1, 'exactly one webhook event (stranger ignored by default)');
  const ev = hook.received[0];
  assert.deepStrictEqual([ev.event, ev.kind, ev.author_role, ev.author_is_owner, ev.guild_id, ev.batched], ['discord_message', 'dm', 'owner', true, null, 1]);
  assert.strictEqual(ev.content, 'hello from the owner');
  assert(/MOCK typing/.test(out) && /MOCK react/.test(out), 'typing + 👀 for the owner');
  assert(/MOCK reply to=owner flags=64 .*healthy/.test(out), 'owner /bridge status: ephemeral, healthy');
  assert(/MOCK reply to=stranger flags=64 "Only the bridge owner/.test(out), 'non-owner refused');
  assert(/dropped reason=stranger/.test(out));
  assert(!out.includes('ultra-secret-text-in-smoke-test') && !out.includes('hello from the owner'), 'message text never logged');
  assert(!out.includes('smoke-key-123456') && !out.includes('aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb'), 'secrets never logged');
  const dataDir = env.DATA_DIR;
  assert.strictEqual(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777, 0o600);
  const health = JSON.parse(fs.readFileSync(path.join(dataDir, 'health.json'), 'utf8').toString() || '{}');
  assert.strictEqual(health.connected, true);
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.strictEqual(st.stats.wakes, 1); assert.strictEqual(st.stats.dropped.stranger, 1); assert.strictEqual(st.stats.lastWebhook.ok, true); assert(st.commandsHash.length === 64);
});
