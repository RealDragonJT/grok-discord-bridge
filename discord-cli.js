#!/usr/bin/env node
'use strict';
// REST helper for the agent: read history, send, react, DM, typing, list channels, find users.
// Uses the bot token from DISCORD_BOT_TOKEN (env) or a .env file (ENV_FILE, ./.env, or next to this script). Never prints the token.
// Works from any machine that can reach discord.com: it does not need the bridge to be running.
const fs = require('fs');
const path = require('path');
const API = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/grok-discord-bridge, 1.0)';

function loadToken() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN.trim();
  const files = [process.env.ENV_FILE, path.join(process.cwd(), '.env'), path.join(__dirname, '.env')].filter(Boolean);
  for (const f of files) {
    try {
      const m = /^\s*DISCORD_BOT_TOKEN\s*=\s*(.*)\s*$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch (_) { /* try next */ }
  }
  return '';
}
const token = loadToken();

function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }
const scrub = (s) => (token ? String(s).split(token).join('[redacted]') : String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, attempt = 0) {
  if (!token) die('DISCORD_BOT_TOKEN is not set (env var or .env file)');
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bot ${token}`, 'User-Agent': UA, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429 && attempt < 4) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil(((j.retry_after || 1) + 0.2) * 1000));
    return api(method, p, body, attempt + 1);
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) die(scrub(`HTTP ${res.status} ${method} ${p.split('?')[0]}: ${data && data.message ? data.message : text}${data && data.code ? ` (code ${data.code})` : ''}`));
  return data;
}

const fmtTime = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')}Z`;

// Split >2000 chars on newline/space boundaries, hard-split as a last resort.
function splitText(text, max = 2000) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

// flags: SUPPRESS_NOTIFICATIONS = 1 << 12. allowed_mentions: users only (never @everyone/@here/roles) unless --no-ping.
async function sendMessage(channelId, text, { replyTo, noPing, silent, file } = {}) {
  const chunks = splitText(text);
  const ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      content: chunks[i],
      allowed_mentions: { parse: noPing ? [] : ['users'], replied_user: !noPing },
      ...(silent ? { flags: 4096 } : {}),
    };
    if (replyTo && i === 0) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
    let m;
    if (file && i === chunks.length - 1) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ ...body, attachments: [{ id: 0, filename: path.basename(file) }] }));
      fd.append('files[0]', new Blob([fs.readFileSync(file)]), path.basename(file));
      m = await api('POST', `/channels/${channelId}/messages`, fd);
    } else m = await api('POST', `/channels/${channelId}/messages`, body);
    ids.push(m.id);
  }
  return ids;
}

async function readStdinIfDash(t) {
  if (t !== '-') return t;
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

// pull `--flag value` / `--flag` out of args
function takeFlag(args, name, hasValue = true) {
  const i = args.indexOf(name);
  if (i < 0) return hasValue ? null : false;
  if (!hasValue) { args.splice(i, 1); return true; }
  const v = args[i + 1]; if (!v) die(`${name} needs a value`);
  args.splice(i, 2); return v;
}

const USAGE = `usage: discord.sh <command>   (or: npm run discord -- <command>)
  whoami                                         the bot user + application id
  guilds                                         servers the bot is in
  channels <guild_id>                            text channels of a server
  find-user <guild_id> <name>                    search members by name prefix (Discord may require the Server Members intent for this one)
  history <channel_id> [n=15] [--before <message_id>] [--json]
  send <channel_id> <text|-> [--reply-to <message_id>] [--no-ping] [--silent] [--file <path>]
  react <channel_id> <message_id> <emoji>        unicode emoji, or name:id for custom ones
  dm <user_id> <text|->                          open a DM channel and send
  typing <channel_id>                            typing indicator (~10 s)
  Use '-' as text to read the message from stdin.`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'whoami': {
      const me = await api('GET', '/users/@me');
      const app = await api('GET', '/applications/@me').catch(() => null);
      console.log(`bot: ${me.username} id:${me.id}${app ? ` application_id:${app.id}` : ''}`);
      break;
    }
    case 'guilds': {
      for (const g of await api('GET', '/users/@me/guilds?limit=200')) console.log(`${g.id}  ${g.name}`);
      break;
    }
    case 'history': {
      const json = takeFlag(args, '--json', false); const before = takeFlag(args, '--before');
      const [ch, nRaw] = args; if (!ch) die(USAGE);
      const n = Math.min(Math.max(parseInt(nRaw || '15', 10) || 15, 1), 100);
      const msgs = (await api('GET', `/channels/${ch}/messages?limit=${n}${before ? `&before=${before}` : ''}`)).reverse();
      if (json) { console.log(JSON.stringify(msgs, null, 1)); break; }
      for (const m of msgs) {
        const who = `${m.author.username}${m.author.bot ? ' [bot]' : ''} (${m.author.id})`;
        const reply = m.message_reference && m.message_reference.message_id ? ` reply-to:${m.message_reference.message_id}` : '';
        console.log(`[${fmtTime(m.timestamp)}] ${who} msg:${m.id}${reply}`);
        if (m.content) console.log(m.content.split('\n').map((l) => `    ${l}`).join('\n'));
        for (const a of m.attachments || []) console.log(`    [attachment] ${a.filename} ${a.url}`);
        for (const e of m.embeds || []) console.log(`    [embed] ${e.title || ''} ${e.description ? e.description.slice(0, 200) : ''} ${e.url || ''}`.trimEnd());
        if (m.reactions && m.reactions.length) console.log(`    reactions: ${m.reactions.map((r) => `${r.emoji.name}x${r.count}`).join(' ')}`);
      }
      if (!msgs.length) console.log('(no messages)');
      break;
    }
    case 'send': {
      const rest = args.slice();
      const replyTo = takeFlag(rest, '--reply-to'); const noPing = takeFlag(rest, '--no-ping', false); const silent = takeFlag(rest, '--silent', false); const file = takeFlag(rest, '--file');
      if (file && !fs.existsSync(file)) die(`file not found: ${file}`);
      const [ch, ...t] = rest; if (!ch || !t.length) die(USAGE);
      const text = await readStdinIfDash(t.join(' '));
      if (!text.trim()) die('empty message');
      const ids = await sendMessage(ch, text, { replyTo, noPing, silent, file });
      console.log(`sent ${ids.length} message(s): ${ids.join(' ')}`);
      break;
    }
    case 'react': {
      const [ch, mid, emojiRaw] = args; if (!ch || !mid || !emojiRaw) die(USAGE);
      const emoji = emojiRaw.replace(/^<a?:/, '').replace(/>$/, '');
      await api('PUT', `/channels/${ch}/messages/${mid}/reactions/${encodeURIComponent(emoji)}/@me`);
      console.log('reacted');
      break;
    }
    case 'typing': {
      if (!args[0]) die(USAGE);
      await api('POST', `/channels/${args[0]}/typing`);
      console.log('typing (lasts ~10s)');
      break;
    }
    case 'dm': {
      const [uid, ...t] = args; if (!uid || !t.length) die(USAGE);
      const text = await readStdinIfDash(t.join(' '));
      if (!text.trim()) die('empty message');
      const dmCh = await api('POST', '/users/@me/channels', { recipient_id: uid });
      const ids = await sendMessage(dmCh.id, text);
      console.log(`dm channel ${dmCh.id}; sent ${ids.length} message(s): ${ids.join(' ')}`);
      break;
    }
    case 'channels': {
      if (!args[0]) die(USAGE);
      const TYPES = { 0: 'text', 5: 'announcement', 15: 'forum', 4: 'category' };
      const chans = await api('GET', `/guilds/${args[0]}/channels`);
      for (const c of chans.filter((x) => TYPES[x.type] && x.type !== 4).sort((a, b) => a.position - b.position)) console.log(`${c.id}  #${c.name}  (${TYPES[c.type]})`);
      break;
    }
    case 'find-user': {
      const [gid, ...q] = args; if (!gid || !q.length) die(USAGE);
      const found = await api('GET', `/guilds/${gid}/members/search?query=${encodeURIComponent(q.join(' '))}&limit=10`);
      for (const m of found) console.log(`${m.user.id}  ${m.user.username}${m.nick ? ` (${m.nick})` : ''}${m.user.bot ? ' [bot]' : ''}`);
      if (!found.length) console.log('(no match)');
      break;
    }
    default:
      if (!cmd) { console.log(USAGE); break; }
      die(USAGE);
  }
}

if (require.main === module) main().catch((e) => die(scrub(e.message || String(e))));
module.exports = { splitText, takeFlag };
