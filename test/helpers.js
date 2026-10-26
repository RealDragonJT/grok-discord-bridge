'use strict';
// Shared test helpers: hermetic env, temp dirs, mock Discord messages / interactions, fake webhook server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Config may fall back to process.env, so clear anything that could leak in from the calling shell.
for (const k of ['DISCORD_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_KEY', 'OWNER_ID', 'DATA_DIR', 'SETTINGS_B64', 'ENV_FILE']) delete process.env[k];

const OWNER = '100000000000000001';
const BOT_ID = '999999999999999999';
// File modes are not enforced on Windows; assert them only where the OS supports it.
const modeIs600 = (file) => (process.platform === 'win32' ? true : (fs.statSync(file).mode & 0o777) === 0o600);
const mkTmp = (p = 'gdb-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const mkMap = (arr) => new Map(arr.map((x) => [x.id, x]));

function mockMsg({ id, authorId = '200000000000000001', username = 'someone', bot = false, content = 'hi', guild = true, guildId = 'g1', channelId = 'c1', atts = [], mention = true, ts = Date.UTC(2026, 9, 24, 12, 0, 0), replyTo = null, webhookId = null }) {
  return {
    id, channelId, guildId: guild ? guildId : null, guild: guild ? { id: guildId, name: 'Test Guild' } : null,
    channel: { id: channelId, name: 'general', type: guild ? 0 : 1, sendTyping: async () => {}, },
    author: { id: authorId, username, bot }, content, webhookId,
    attachments: mkMap(atts.map((a, i) => ({ id: String(i), ...a }))),
    mentions: { users: mkMap([{ id: BOT_ID, username: 'TestBot' }, { id: '222', username: 'bob' }]), channels: new Map(), roles: new Map(), has: (id) => mention && id === BOT_ID },
    reference: replyTo ? { messageId: replyTo } : null,
    createdAt: new Date(ts), createdTimestamp: ts,
    react: async () => {},
  };
}

// Fake webhook: records bodies; `script` can return a status per call number.
async function fakeWebhook(statusFor = () => 200, key = 'test-key') {
  const received = []; const headers = []; let calls = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      calls++;
      headers.push(req.headers);
      if (req.headers.authorization !== `Bearer ${key}` || req.method !== 'POST') { res.writeHead(401); return res.end(); }
      const st = statusFor(calls);
      if (st === 200) received.push(JSON.parse(b));
      res.writeHead(st); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, received, headers, calls: () => calls, cfg: { webhookUrl: `http://127.0.0.1:${srv.address().port}/hook`, webhookKey: key }, close: () => new Promise((r) => srv.close(r)) };
}

function mkInteraction({ userId = OWNER, group = null, sub, opts = {} }) {
  const replies = [];
  const get = (n) => (opts[n] === undefined ? null : opts[n]);
  const i = {
    user: { id: userId }, commandName: 'bridge', deferred: false, replies,
    isChatInputCommand: () => true,
    options: { getSubcommandGroup: () => group, getSubcommand: () => sub, getString: get, getInteger: get, getBoolean: get, getUser: get, getChannel: get },
    async reply(b) { replies.push({ kind: 'reply', ...b }); },
    async deferReply(b) { i.deferred = true; replies.push({ kind: 'defer', ...b }); },
    async editReply(b) { replies.push({ kind: 'edit', ...b }); },
  };
  return i;
}

module.exports = { modeIs600, OWNER, BOT_ID, mkTmp, mkMap, mockMsg, fakeWebhook, mkInteraction };
