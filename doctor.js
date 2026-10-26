#!/usr/bin/env node
'use strict';
// `npm run doctor`: validates the setup and prints actionable errors. Never prints secrets.
//   checks: Node version, required values, OWNER_ID, bot token (GET /users/@me), Message Content intent flag,
//           owner id resolves, data dir writable, webhook reachability (POSTs a harmless bridge_test event).
// Flags: --no-webhook (skip the webhook POST), --json (machine-readable). Exit code 0 = all good, 1 = something to fix.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { postWebhook } = require('./lib/payload');

const API = 'https://discord.com/api/v10';
const args = process.argv.slice(2);
const SKIP_WEBHOOK = args.includes('--no-webhook');
const AS_JSON = args.includes('--json');

const cfg = loadConfig();
const secrets = () => [cfg.token, cfg.webhookKey, cfg.webhookUrl].filter((s) => s && s.length > 6);
const scrub = (s) => secrets().reduce((acc, sec) => acc.split(sec).join('[redacted]'), String(s));

const results = [];
function rec(status, name, detail = '', fix = '') { results.push({ status, name, detail: scrub(detail), fix: scrub(fix) }); }

async function discord(p) {
  const res = await fetch(API + p, { headers: { Authorization: `Bot ${cfg.token}`, 'User-Agent': 'grok-discord-bridge-doctor' }, signal: AbortSignal.timeout(15000) });
  let body = null; try { body = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, body };
}

// Permission bits used for the invite URL
const P = { VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, READ_MESSAGE_HISTORY: 1n << 16n, ADD_REACTIONS: 1n << 6n, ATTACH_FILES: 1n << 15n, PIN_MESSAGES: 1n << 51n };
const inviteUrl = (appId, extras = false) => {
  let perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS;
  if (extras) perms |= P.ATTACH_FILES | P.PIN_MESSAGES;
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${perms}`;
};

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) rec('ok', 'Node.js', `v${process.versions.node}`); else rec('fail', 'Node.js', `v${process.versions.node}`, 'Install Node 22 (or at least 20), or use Docker.');

  const names = ['DISCORD_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_KEY', 'OWNER_ID'];
  const fileUsed = fs.existsSync(cfg.envFile) ? `.env found (${path.basename(cfg.envFile)})` : 'no .env file (using process environment only)';
  const missingOrBad = cfg.problems;
  if (!missingOrBad.length) rec('ok', 'Configuration', `all of ${names.join(', ')} are set; ${fileUsed}`);
  for (const p of missingOrBad) rec('fail', 'Configuration', p);

  if (cfg.token && !missingOrBad.some((p) => p.startsWith('DISCORD_BOT_TOKEN does not'))) {
    try {
      const me = await discord('/users/@me');
      if (me.status === 200 && me.body && me.body.bot) {
        rec('ok', 'Bot token', `valid; logs in as bot "${me.body.username}" (id ${me.body.id})`);
        const app = await discord('/applications/@me');
        if (app.status === 200 && app.body) {
          const flags = BigInt(app.body.flags_new !== undefined ? app.body.flags_new : app.body.flags || 0);
          const content = (flags & (1n << 18n)) || (flags & (1n << 19n));
          if (content) rec('ok', 'Message Content intent', 'enabled');
          else rec('fail', 'Message Content intent', 'not enabled: the bridge cannot read message text', 'Developer Portal > your application > Bot > Privileged Gateway Intents > enable "Message Content Intent" > Save Changes.');
          rec('info', 'Invite URL', `${inviteUrl(app.body.id)}  (add ATTACH_FILES + PIN_MESSAGES with: ${inviteUrl(app.body.id, true)})`);
        } else rec('warn', 'Application info', `could not read application flags (HTTP ${app.status}); check the intent manually`);
        const gl = await discord('/users/@me/guilds?limit=200');
        if (gl.status === 200) {
          if (gl.body.length) rec('ok', 'Servers', `the bot is in ${gl.body.length} server(s)`);
          else rec('warn', 'Servers', 'the bot is not in any server yet (to receive DMs you must share a server with it)', 'Open the invite URL above and add the bot to a server you own.');
        }
        if (cfg.ownerId && /^\d{15,25}$/.test(cfg.ownerId)) {
          const ow = await discord(`/users/${cfg.ownerId}`);
          if (ow.status === 200) rec('ok', 'OWNER_ID', `resolves to an existing ${ow.body.bot ? 'BOT (wrong: use a human account)' : 'user account'}`);
          else if (ow.status === 404) rec('fail', 'OWNER_ID', 'no Discord user has this id', 'Developer Mode > right-click your own name > Copy User ID.');
          else rec('warn', 'OWNER_ID', `could not verify (HTTP ${ow.status})`);
        }
      } else if (me.status === 401) rec('fail', 'Bot token', 'Discord rejected the token (HTTP 401)', 'Developer Portal > Bot > Reset Token, copy the new token into DISCORD_BOT_TOKEN.');
      else rec('fail', 'Bot token', `unexpected response from Discord (HTTP ${me.status})`, 'Check your network / try again; discord.com must be reachable.');
    } catch (e) { rec('fail', 'Discord API', `could not reach discord.com (${e.name})`, 'This machine needs outbound HTTPS to discord.com.'); }
  } else if (!cfg.token) rec('skip', 'Bot token', 'skipped (not set)');

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const probe = path.join(cfg.dataDir, '.write-test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    rec('ok', 'Data directory', `${cfg.dataDir} is writable`);
  } catch (e) { rec('fail', 'Data directory', `${cfg.dataDir} is not writable (${e.code || e.name})`, 'With Docker run: mkdir -p data && chown 1000:1000 data'); }

  if (SKIP_WEBHOOK) rec('skip', 'Webhook', 'skipped (--no-webhook)');
  else if (cfg.webhookUrl && cfg.webhookKey && !missingOrBad.some((p) => p.startsWith('WEBHOOK_URL'))) {
    const r = await postWebhook({ event: 'bridge_test', content_trust: 'untrusted', note: 'Test event from `npm run doctor`. No action needed.', timestamp: new Date().toISOString() }, cfg, () => {}, { attempts: 1 });
    if (r.ok) rec('ok', 'Webhook', `HTTP ${r.status}: accepted (your routine was triggered once by a harmless bridge_test event)`);
    else if (r.status === 401 || r.status === 403) rec('fail', 'Webhook', `HTTP ${r.status}: the key was rejected`, 'Re-copy the key shown with the webhook trigger in your Grok Bot routine into WEBHOOK_KEY.');
    else if (r.status === 404) rec('fail', 'Webhook', 'HTTP 404: URL not found', 'Re-copy the webhook URL from the routine into WEBHOOK_URL (is the routine still enabled?).');
    else if (r.status === 0) rec('fail', 'Webhook', `no response (${r.error || 'network error'})`, 'Check the URL and that this machine can make outbound HTTPS requests.');
    else rec('fail', 'Webhook', `HTTP ${r.status}`, 'The routine endpoint answered with an error; open the routine in Grok Bot and check it is enabled.');
  } else rec('skip', 'Webhook', 'skipped (WEBHOOK_URL / WEBHOOK_KEY not usable yet)');

  const failed = results.some((r) => r.status === 'fail');
  if (AS_JSON) console.log(JSON.stringify({ ok: !failed, results }, null, 2));
  else {
    const icon = { ok: '[ OK ]', fail: '[FAIL]', warn: '[WARN]', info: '[INFO]', skip: '[SKIP]' };
    for (const r of results) {
      console.log(`${icon[r.status]} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
      if (r.fix) console.log(`       fix: ${r.fix}`);
    }
    console.log(failed ? '\nSome checks failed. Fix them and run `npm run doctor` again.' : '\nAll required checks passed. Start the bridge, then try `/bridge status` in Discord.');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(scrub(`doctor crashed: ${e.message}`)); process.exit(1); });
