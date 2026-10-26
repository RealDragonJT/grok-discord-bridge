'use strict';
// Catch-up for messages missed while the gateway was down / the host was frozen.
// Pure logic (no discord.js import) so it is unit-testable offline: bot.js supplies the Discord bits (channel fetchers)
// and a `process(message, classification, { missed, now })` callback that is the SAME pipeline live messages use
// (policy -> payload -> batcher -> webhook). Nothing here ever sends anything to Discord.
const fs = require('fs');
const core = require('./util');

const DISCORD_EPOCH = 1420070400000n;
const DEFAULTS = {
  windowMs: 3 * 3600 * 1000,   // never look back further than this
  limit: 50,                   // REST page size per channel
  maxPages: 3,                 // only page again if a page came back full
  staleMs: 2 * 60 * 1000,      // older than this => no typing / 👀 reaction
  overlapMs: 90 * 1000,        // re-look slightly before the last known-alive time
  maxChannels: 60,             // hard cap on channels fetched per run (rate-limit guard)
  pauseMs: 300,                // pause between REST fetches
  maxRefFetches: 10,           // extra REST calls allowed per run to resolve "reply to bot?"
  recentIdsMax: 500,
  recentIdsTtlMs: 6 * 3600 * 1000,
};

const snowflakeFromTs = (ms) => ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
const tsFromSnowflake = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const maxId = (a, b) => (!a ? b : !b ? a : (BigInt(a) >= BigInt(b) ? a : b));
const cmpId = (a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

// Persisted "last-seen" state: last processed id per channel, gateway-alive time, recent handled ids, known DM channels.
class CatchupState {
  constructor(file, opts = {}) {
    this.file = file;
    this.o = { ...DEFAULTS, ...opts };
    this.lastIds = {};        // channel_id -> last processed message id
    this.lastAliveAt = 0;     // epoch ms: last time the gateway was verified alive
    this.recent = {};         // message_id -> epoch ms it was handled (delivered OR deliberately dropped)
    this.dmChannels = [];     // DM channel ids seen with owner/approved users
    this.undelivered = {};    // channel_id -> oldest message id whose webhook delivery failed (ids only, never text)
    this.load();
  }
  load() {
    const j = core.readJson(this.file, null);
    if (!j) return; // first run / corrupt => empty
    if (j.lastIds && typeof j.lastIds === 'object') this.lastIds = j.lastIds;
    if (Number.isFinite(j.lastAliveAt)) this.lastAliveAt = j.lastAliveAt;
    if (j.recent && typeof j.recent === 'object') this.recent = j.recent;
    if (Array.isArray(j.dmChannels)) this.dmChannels = j.dmChannels.map(String);
    if (j.undelivered && typeof j.undelivered === 'object') this.undelivered = j.undelivered;
  }
  save() {
    try { core.writeJsonAtomic(this.file, { lastAliveAt: this.lastAliveAt, lastIds: this.lastIds, recent: this.recent, dmChannels: this.dmChannels, undelivered: this.undelivered }, 1); } catch (_) { /* never crash the bridge over bookkeeping */ }
  }
  hasSeen(id) { return Object.prototype.hasOwnProperty.call(this.recent, id); }
  // Marks a message as handled (dedupe only). It deliberately does NOT move the per-channel cursor: a newer live message
  // must never push the cursor past older messages that were missed. Only a completed catch-up pass advances the cursor.
  markSeen(channelId, id, now = Date.now()) {
    this.recent[id] = now;
    this.prune(now);
  }
  // A webhook delivery failed for these messages: forget that they were handled and remember where to re-read from,
  // so the next catch-up pass feeds them again. `items` are [{ channelId, id }].
  noteUndelivered(items) {
    for (const { channelId, id } of items) {
      if (!channelId || !id) continue;
      delete this.recent[id];
      this.undelivered[channelId] = this.undelivered[channelId] ? (cmpId(id, this.undelivered[channelId]) < 0 ? id : this.undelivered[channelId]) : id;
    }
    this.save();
  }
  hasUndelivered() { return Object.keys(this.undelivered).length > 0; }
  advance(channelId, id) { if (channelId && id) this.lastIds[channelId] = maxId(this.lastIds[channelId], id); }
  prune(now = Date.now()) {
    for (const id of Object.keys(this.recent)) if (now - this.recent[id] > this.o.recentIdsTtlMs) delete this.recent[id];
    const left = Object.keys(this.recent);
    if (left.length > this.o.recentIdsMax) {
      left.sort((a, b) => cmpId(a, b));
      for (const id of left.slice(0, left.length - this.o.recentIdsMax)) delete this.recent[id];
    }
    for (const [ch, id] of Object.entries(this.lastIds)) if (now - tsFromSnowflake(id) > 7 * 86400000) delete this.lastIds[ch];
  }
  alive(now = Date.now()) { this.lastAliveAt = now; this.save(); }
  rememberDm(channelId) { channelId = String(channelId); if (!this.dmChannels.includes(channelId)) { this.dmChannels.push(channelId); if (this.dmChannels.length > 50) this.dmChannels.shift(); this.save(); } }
}

// Follow-up window: after the bot posts in a guild channel, the OWNER's next messages there (within the window)
// wake the agent too, without an @mention (kind 'followup'). Each new bot message restarts the window.
class FollowupTracker {
  constructor() { this.lastBotAt = new Map(); }
  noteBot(channelId, ts) { if (!channelId || !Number.isFinite(ts)) return; if (ts > (this.lastBotAt.get(channelId) || 0)) this.lastBotAt.set(channelId, ts); }
  inWindow(channelId, ts, windowMs) {
    if (!windowMs || windowMs <= 0) return false;
    const b = this.lastBotAt.get(channelId);
    return !!b && ts >= b && ts - b <= windowMs;
  }
}

// Does this (live or fetched) message qualify as a wake candidate? Returns { kind, replyToBot, authorIsBot } or null.
// Policy (roles, allowlists, cooldowns...) is applied afterwards by lib/policy.js. Webhook posts and the bot's own messages never qualify.
// `resolveReplyToBot(message)` is async and only consulted for guild messages that don't @mention the bot.
// `isFollowup(message)` (optional, sync) => true when an owner message falls in a follow-up window.
async function classifyMessage(message, { botId, resolveReplyToBot, isFollowup }) {
  const a = message.author;
  if (!a || a.id === botId || message.webhookId) return null;
  const isDM = (message.channel && message.channel.type === 1 /* ChannelType.DM */) || !message.guildId;
  if (isDM) return a.bot ? null : { kind: 'dm', replyToBot: false, authorIsBot: false };
  let kind = null, replyToBot = false;
  const m = message.mentions;
  const mentioned = m && (typeof m.has === 'function' ? m.has(botId, { ignoreEveryone: true }) : (m.users && m.users.has && m.users.has(botId)));
  if (mentioned) kind = 'mention';
  if (message.reference && message.reference.messageId && resolveReplyToBot) {
    try { if (await resolveReplyToBot(message)) { replyToBot = true; kind = kind || 'mention'; } } catch (_) { /* deleted/unavailable */ }
  }
  if (!kind && isFollowup && !a.bot) { try { if (isFollowup(message)) kind = 'followup'; } catch (_) { /* ignore */ } }
  return kind ? { kind, replyToBot, authorIsBot: !!a.bot } : null;
}

// Fetch + feed one channel. `fetchPage({ after, limit })` -> array of messages (any order).
async function catchUpChannel({ channelId, kind, fetchPage, state, now, floorMs, botId, process, resolveReplyToBot, isFollowup, log, budget, followups }) {
  const o = state.o;
  const windowFloor = Math.max(now - o.windowMs, floorMs || 0);
  const redo = state.undelivered[channelId]; // re-read from just before the oldest message whose delivery failed
  let after = redo
    ? maxId(snowflakeFromTs(windowFloor), (BigInt(redo) - 1n).toString())
    : maxId(snowflakeFromTs(windowFloor), state.lastIds[channelId]);
  const res = { fetched: 0, fed: 0, skipped_seen: 0 };
  let newest = null;
  for (let page = 0; page < o.maxPages; page++) {
    if (budget && budget.requests-- <= 0) break;
    const batch = (await fetchPage({ after, limit: o.limit }) || []).slice().sort((a, b) => cmpId(a.id, b.id));
    res.fetched += batch.length;
    const byId = new Map(batch.map((m) => [m.id, m]));
    for (const msg of batch) {
      newest = maxId(newest, msg.id);
      if (followups && msg.author && msg.author.id === botId) followups.noteBot(channelId, msg.createdTimestamp || tsFromSnowflake(msg.id));
      if (cmpId(msg.id, after) <= 0) continue;
      if (now - (msg.createdTimestamp || tsFromSnowflake(msg.id)) > o.windowMs) continue;
      if (state.hasSeen(msg.id)) { res.skipped_seen++; continue; }
      const c = await classifyMessage(msg, {
        botId,
        isFollowup: kind === 'guild' ? isFollowup : null,
        resolveReplyToBot: async (mm) => {
          const ref = byId.get(mm.reference.messageId);
          if (ref) return ref.author && ref.author.id === botId;
          if (budget && budget.refs-- <= 0) return false;
          return resolveReplyToBot ? resolveReplyToBot(mm) : false;
        },
      });
      if (!c) continue;
      const r = await process(msg, c, { missed: true, now });
      if (r && r.action === 'wake') res.fed++;
    }
    if (batch.length) after = batch[batch.length - 1].id;
    if (batch.length < o.limit) break;
    if (o.pauseMs) await core.sleep(o.pauseMs);
  }
  if (newest) state.advance(channelId, newest); // don't re-read the same non-qualifying history next time
  if (redo && state.undelivered[channelId] === redo) delete state.undelivered[channelId]; // re-fed; a new failure re-adds it
  return res;
}

// Catch up across sources: [{ channelId, kind, fetchPage }]. Sequential with a small pause (rate-limit friendly).
async function runCatchup({ sources, state, now = Date.now(), floorMs, botId, process, resolveReplyToBot, isFollowup, log = () => {}, followups = null }) {
  const o = state.o;
  const budget = { requests: o.maxChannels * o.maxPages, refs: o.maxRefFetches };
  const totals = { channels: 0, fetched: 0, fed: 0, skipped_seen: 0, errors: 0 };
  for (const src of sources.slice(0, o.maxChannels)) {
    try {
      const r = await catchUpChannel({ ...src, state, now, floorMs, botId, process, resolveReplyToBot, isFollowup, log, budget, followups });
      totals.channels++; totals.fetched += r.fetched; totals.fed += r.fed; totals.skipped_seen += r.skipped_seen;
    } catch (e) {
      totals.errors++;
      log(`catch-up: channel ${src.channelId} failed: ${e.code || ''} ${e.name}`);
      if (e.status === 429 || e.code === 429) break;
    }
    if (o.pauseMs) await core.sleep(o.pauseMs);
  }
  state.save();
  return totals;
}

module.exports = { DEFAULTS, CatchupState, FollowupTracker, classifyMessage, catchUpChannel, runCatchup, snowflakeFromTs, tsFromSnowflake, maxId, cmpId };
