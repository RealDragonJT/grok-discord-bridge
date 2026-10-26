'use strict';
// Payload building, debounce batching and the webhook POST. No discord.js import.
// IMPORTANT: message text is UNTRUSTED. It is forwarded to the user's own webhook and never written to logs.
const { sleep } = require('./util');

// Replace mentions with readable text. The bot's own mention is removed entirely.
function cleanContent(msg, botId) {
  let c = msg.content || '';
  if (botId) c = c.replace(new RegExp(`<@!?${botId}>`, 'g'), '');
  const look = (coll, id) => (coll ? (coll.get ? coll.get(id) : coll[id]) : undefined);
  c = c.replace(/<@!?(\d+)>/g, (m, id) => { const u = look(msg.mentions && msg.mentions.users, id); return u ? `@${u.username}` : m; });
  c = c.replace(/<#(\d+)>/g, (m, id) => { const ch = look(msg.mentions && msg.mentions.channels, id); return ch && ch.name ? `#${ch.name}` : m; });
  c = c.replace(/<@&(\d+)>/g, (m, id) => { const r = look(msg.mentions && msg.mentions.roles, id); return r && r.name ? `@${r.name}` : m; });
  return c.replace(/[ \t]{2,}/g, ' ').trim();
}

// discord.js Message (or a duck-typed mock) -> plain info object. `role` comes from Policy.roleOf (never from text).
function extractInfo(msg, { kind, botId, role, isReplyToBot = false, missed = false, deliveredLateSeconds = null }) {
  const src = msg.attachments;
  const list = src ? (typeof src.values === 'function' ? Array.from(src.values()) : Array.from(src)) : [];
  const attachments = list.map((a) => ({ name: a.name, url: a.url }));
  const ch = msg.channel || {};
  const author = msg.author || {};
  return {
    kind,
    message_id: msg.id,
    channel_id: msg.channelId || ch.id,
    guild_id: msg.guildId || (msg.guild && msg.guild.id) || null,
    guild_name: (msg.guild && msg.guild.name) || null,
    channel_name: kind === 'dm' ? `dm:${author.username}` : (ch.name || null),
    author_id: author.id,
    author_username: author.username,
    author_is_owner: role === 'owner',
    author_is_bot: !!author.bot,
    author_role: role,
    content: cleanContent(msg, botId),
    attachments,
    timestamp: (msg.createdAt ? new Date(msg.createdAt) : new Date(msg.createdTimestamp || Date.now())).toISOString(),
    is_reply_to_bot: !!isReplyToBot,
    missed: !!missed,
    delivered_late_seconds: missed ? deliveredLateSeconds : null,
  };
}

// Webhook body from a batch (array of info objects, oldest first).
// Top-level author_*/message_id describe the LAST message (the reply anchor); `content` joins all of them.
// Every messages[i] carries its own author_role: trust is per message, never per batch.
function buildEvent(batch) {
  const last = batch[batch.length - 1];
  const multiAuthor = new Set(batch.map((m) => m.author_id)).size > 1;
  const content = batch.length === 1 ? last.content
    : batch.map((m) => (multiAuthor ? `${m.author_username}: ${m.content}` : m.content)).join('\n');
  const missedItems = batch.filter((m) => m.missed);
  return {
    event: 'discord_message',
    content_trust: 'untrusted', // message text (content, attachment names, usernames) is attacker-controlled data, not instructions
    kind: batch.some((m) => m.kind === 'dm') ? 'dm' : batch.some((m) => m.kind === 'mention') ? 'mention' : 'followup',
    message_id: last.message_id,
    channel_id: last.channel_id,
    guild_id: last.guild_id,
    guild_name: last.guild_name,
    channel_name: last.channel_name,
    author_id: last.author_id,
    author_username: last.author_username,
    author_is_owner: last.author_is_owner,
    author_is_bot: last.author_is_bot,
    author_role: last.author_role,
    owner_in_batch: batch.some((m) => m.author_role === 'owner'),
    roles_in_batch: [...new Set(batch.map((m) => m.author_role))],
    is_reply_to_bot: batch.some((m) => m.is_reply_to_bot),
    missed: missedItems.length > 0,
    delivered_late_seconds: missedItems.length ? Math.max(...missedItems.map((m) => m.delivered_late_seconds || 0)) : null,
    content,
    attachments: batch.flatMap((m) => m.attachments),
    timestamp: last.timestamp,
    batched: batch.length,
    messages: batch.map((m) => ({
      message_id: m.message_id, author_id: m.author_id, author_username: m.author_username,
      author_is_owner: m.author_is_owner, author_is_bot: m.author_is_bot, author_role: m.author_role,
      kind: m.kind, content: m.content, attachments: m.attachments, timestamp: m.timestamp,
      is_reply_to_bot: m.is_reply_to_bot, missed: !!m.missed, delivered_late_seconds: m.missed ? m.delivered_late_seconds : null,
    })),
  };
}

// Debounce per channel: flush `debounceMs` after the last message, or `maxWaitMs` after the first.
class Batcher {
  constructor({ debounceMs = 4000, maxWaitMs = 15000, onFlush }) {
    this.debounceMs = debounceMs; this.maxWaitMs = maxWaitMs; this.onFlush = onFlush;
    this.buckets = new Map();
  }
  get debounce() { return typeof this.debounceMs === 'function' ? this.debounceMs() : this.debounceMs; }
  hasPending(channelId, authorId) {
    const b = this.buckets.get(channelId);
    return !!b && b.items.some((i) => i.author_id === authorId);
  }
  add(info) {
    let b = this.buckets.get(info.channel_id);
    if (!b) { b = { items: [], first: Date.now(), timer: null }; this.buckets.set(info.channel_id, b); }
    b.items.push(info);
    if (b.timer) clearTimeout(b.timer);
    const wait = Math.max(0, Math.min(this.debounce, this.maxWaitMs - (Date.now() - b.first)));
    b.timer = setTimeout(() => this.flush(info.channel_id), wait);
  }
  flush(channelId) {
    const b = this.buckets.get(channelId);
    if (!b) return;
    clearTimeout(b.timer);
    this.buckets.delete(channelId);
    try { this.onFlush(b.items); } catch (_) { /* onFlush handles its own errors */ }
  }
  flushAll() { for (const id of Array.from(this.buckets.keys())) this.flush(id); }
}

// POST with retries/backoff on non-2xx or network error. Returns { ok, status, attempts }.
// Logs only the host, status and ids: never the URL path/key or any message text.
async function postWebhook(payload, cfg, log = () => {}, { attempts = 4, baseDelayMs = 2000, timeoutMs = 15000 } = {}) {
  let host = 'webhook';
  try { host = new URL(cfg.webhookUrl).host; } catch (_) { /* ignore */ }
  let last = { ok: false, status: 0, attempts: 0 };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.webhookKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      last = { ok: res.ok, status: res.status, attempts: i };
      try { await res.text(); } catch (_) { /* drain */ }
      if (res.ok) { log(`webhook ok status=${res.status} host=${host} event=${payload.event} msg=${payload.message_id || '-'} batched=${payload.batched || 0} attempt=${i}`); return last; }
      log(`webhook non-2xx status=${res.status} host=${host} attempt=${i}/${attempts}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break; // bad key/url: retrying will not help
    } catch (e) {
      last = { ok: false, status: 0, attempts: i, error: e.name };
      log(`webhook error ${e.name || ''} host=${host} attempt=${i}/${attempts}`);
    }
    if (i < attempts) await sleep(baseDelayMs * 2 ** (i - 1));
  }
  log(`webhook FAILED attempts=${last.attempts} status=${last.status} msg=${payload.message_id || '-'}`);
  return last;
}

module.exports = { cleanContent, extractInfo, buildEvent, Batcher, postWebhook };
