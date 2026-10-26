'use strict';
// grok-discord-bridge: Discord gateway listener that wakes your Grok Bot routine webhook on DMs and @mentions.
// It never replies with text itself: the woken agent answers through the Discord REST API (see discord-cli.js).
// Required env: DISCORD_BOT_TOKEN, WEBHOOK_URL, WEBHOOK_KEY, OWNER_ID. Everything else: /bridge slash commands.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, GatewayIntentBits, Partials, ActivityType, ChannelType, Routes } = require('discord.js');
const { loadConfig } = require('./lib/config');
const { makeLogger, sleep, writeJsonAtomic } = require('./lib/util');
const { SettingsStore } = require('./lib/settings');
const { RuntimeState } = require('./lib/state');
const { Policy } = require('./lib/policy');
const { Batcher, buildEvent, postWebhook } = require('./lib/payload');
const { Pipeline } = require('./lib/pipeline');
const catchup = require('./lib/catchup');
const pins = require('./lib/pins');
const commands = require('./lib/commands');
const { HealthMonitor, statusName, validPing, EXIT_UNHEALTHY, DEFAULTS: HEALTH } = require('./lib/health');

const EX_CONFIG = 78;
const DEFAULT_STATUS_TEXT = 'DM or @mention me';
const cfg = loadConfig();
if (cfg.problems.length) {
  console.error('grok-discord-bridge cannot start. Fix these and restart (run `npm run doctor` for a full check):');
  for (const p of cfg.problems) console.error(`  - ${p}`);
  process.exit(EX_CONFIG);
}
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const probe = path.join(cfg.dataDir, '.write-test');
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
} catch (e) {
  console.error(`DATA_DIR (${cfg.dataDir}) is not writable (${e.code || e.name}). With Docker: mkdir -p data && chown 1000:1000 data`);
  process.exit(EX_CONFIG);
}

const log = makeLogger(() => [cfg.token, cfg.webhookKey, cfg.webhookUrl]);
const settings = new SettingsStore(path.join(cfg.dataDir, 'settings.json'), { log, seedB64: cfg.settingsB64 });
const state = new RuntimeState(path.join(cfg.dataDir, 'state.json'));
const cstate = new catchup.CatchupState(path.join(cfg.dataDir, 'catchup-state.json'));
const followups = new catchup.FollowupTracker();
const policy = new Policy({ getSettings: () => settings.get(), ownerId: cfg.ownerId, state });
const HEALTH_FILE = path.join(cfg.dataDir, 'health.json');

let client = null;
const startedAt = Date.now();
// gateway bookkeeping for health checks / status (reset on every new Client)
const gw = { connectStartedAt: 0, everReady: false, readyAt: 0, lastEventAt: 0, lastDisconnectAt: 0, disconnects: 0, reconnects: 0, resumes: 0, lastPresenceAt: 0 };
const monitor = new HealthMonitor();
let inflightPosts = 0;
let exiting = false;

// ---------- webhook ----------
const batcher = new Batcher({
  debounceMs: () => settings.get().options.debounceSeconds * 1000,
  onFlush: (items) => {
    const payload = buildEvent(items);
    inflightPosts++;
    postWebhook(payload, cfg, log).then((r) => state.recordWebhook(r)).catch((e) => log('post error', e)).finally(() => { inflightPosts--; });
  },
});

// Typing + 👀 for the owner's fresh direct messages. No text reply: the webhook-woken agent replies.
function ackMessage(info, message) {
  const o = settings.get().options;
  if (o.typing) message.channel.sendTyping().catch((e) => log('typing failed', e.code || e.name));
  if (o.reactEyes) message.react('👀').catch((e) => log('react failed', e.code || e.name));
}

// Tell the owner (once per day) that the daily cap was hit. The only unsolicited message the bridge ever sends.
async function notifyOwner(kind) {
  if (!client || kind !== 'daily-cap') return;
  const c = settings.get().dailyCap;
  const u = await client.users.fetch(cfg.ownerId);
  await u.send(`Daily wake cap reached (${c.max}/day, ${c.tz} day). Further non-owner messages are ignored until tomorrow. Your own messages still wake the agent. Change it with /bridge daily-cap set.`);
}

const pipeline = new Pipeline({ getSettings: () => settings.get(), policy, cstate, state, batcher, log, ack: ackMessage, notifyOwner });

// ---------- presence (pinned message > settings text > default) ----------
let pinnedStatus = null; let pinTimer = null;
function currentPresence() {
  const p = settings.get().presence;
  const pin = pinnedStatus && pinnedStatus.current;
  if (pin) return { activity: pin.text, status: pin.status || p.status };
  return { activity: p.text || DEFAULT_STATUS_TEXT, status: p.status };
}
async function fetchPinItems(c, channelId) {
  try {
    const r = await c.rest.get(Routes.channelMessagesPins(channelId), { query: new URLSearchParams({ limit: '50' }) });
    return (r.items || []).map((i) => ({ message: i.message, pinnedTimestamp: Date.parse(i.pinned_at) }));
  } catch (e) {
    if (!(e && e.status === 404 && e.code !== 10003)) throw e; // endpoint missing on older API => legacy; 10003 = unknown channel
    const arr = await c.rest.get(Routes.channelPins(channelId));
    return (arr || []).map((m, idx) => ({ message: m, pinnedTimestamp: arr.length - idx }));
  }
}
function stopPinnedStatus() { if (pinTimer) clearInterval(pinTimer); pinTimer = null; pinnedStatus = null; }
function startPinnedStatus(c) {
  stopPinnedStatus();
  const channelId = settings.get().pinnedChannelId;
  if (!channelId) return;
  pinnedStatus = new pins.PinnedStatus({
    fetchPins: () => fetchPinItems(c, channelId),
    getIds: () => ({ botId: c.user && c.user.id, ownerId: cfg.ownerId }), // only pins by the bot or the owner count
    log,
    onChange: () => { if (client === c) applyPresence('pinned message'); },
  });
  const poll = () => { if (client === c && !exiting && pinnedStatus) pinnedStatus.poll().catch((e) => log('pinned status error', e)); };
  poll();
  pinTimer = setInterval(poll, pins.POLL_MS);
  if (pinTimer.unref) pinTimer.unref();
}
function presencePayload() {
  const p = currentPresence();
  return { status: p.status, activities: p.activity ? [{ name: 'Custom Status', type: ActivityType.Custom, state: p.activity }] : [] };
}
function applyPresence(reason = 'manual', quiet = false) {
  if (!client || !client.user || exiting || gatewayState().status !== 'READY') return false;
  try {
    client.user.setPresence(presencePayload());
    gw.lastPresenceAt = Date.now();
    if (!quiet) log(`presence set (${reason}) status=${currentPresence().status}`);
    return true;
  } catch (e) { log('presence error', e); return false; }
}

// ---------- real gateway state ----------
// NB: client.ws.status is the *manager* status and stays READY after the first connect even while a shard is reconnecting, so look at the shards.
function gatewayState(now = Date.now()) {
  if (!client) return { status: 'NONE', ping: null, ackAt: 0, ackAgeMs: null, shards: 0 };
  if (client.ws.destroyed) return { status: 'DESTROYED', ping: null, ackAt: 0, ackAgeMs: null, shards: 0 };
  const shards = Array.from(client.ws.shards.values());
  if (!shards.length) return { status: statusName(client.ws.status) === 'READY' ? 'NO_SHARDS' : statusName(client.ws.status), ping: null, ackAt: 0, ackAgeMs: null, shards: 0 };
  const bad = shards.find((sh) => sh.status !== 0);
  const status = bad ? statusName(bad.status) : 'READY';
  const ping = client.ws.ping;
  let ackAt = 0;
  for (const sh of shards) if (validPing(sh.ping) && sh.lastPingTimestamp > 0) ackAt = Math.max(ackAt, sh.lastPingTimestamp + sh.ping);
  return { status, ping: Number.isFinite(ping) ? ping : null, ackAt, ackAgeMs: ackAt ? now - ackAt : null, shards: shards.length };
}
function healthSnapshot(now = Date.now()) {
  const g = gatewayState(now);
  return { hasClient: !!client, status: g.status, ping: g.ping === null ? NaN : g.ping, ackAt: g.ackAt, lastEventAt: gw.lastEventAt, readyAt: gw.readyAt, connectStartedAt: gw.connectStartedAt, everReady: gw.everReady };
}
const ageS = (t, now) => (t ? Math.round((now - t) / 1000) : null);
function statusReport() {
  const now = Date.now();
  const g = gatewayState(now);
  const connected = g.status === 'READY';
  const problems = [];
  if (!connected) problems.push(`ws_status=${g.status}`);
  if (connected && gw.readyAt && now - gw.readyAt > HEALTH.settleMs) {
    if (!validPing(g.ping)) problems.push(`ws_ping=${g.ping}`);
    if (g.ackAt && now - g.ackAt > HEALTH.ackStaleMs) problems.push(`heartbeat_ack_stale_${ageS(g.ackAt, now)}s`);
  }
  if (monitor.wake) problems.push('verifying_gateway_after_clock_jump');
  return {
    connected, healthy: problems.length === 0 && !!client, problems,
    ws_status: g.status, ping_ms: validPing(g.ping) ? g.ping : null,
    gateway_uptime_s: gw.readyAt && connected ? ageS(gw.readyAt, now) : null,
    process_uptime_s: Math.round((now - startedAt) / 1000),
    reconnects: gw.reconnects, resumes: gw.resumes, disconnects: gw.disconnects,
    guilds: client && client.guilds ? client.guilds.cache.size : 0,
    held: pipeline.held.length,
  };
}

// ---------- health check: exit 75 so the supervisor restarts us right away ----------
async function exitUnhealthy(reason) {
  if (exiting) return;
  exiting = true;
  log(`HEALTH: gateway unhealthy, exiting with code ${EXIT_UNHEALTHY} so the supervisor restarts the bridge: ${reason}`);
  try { batcher.flushAll(); } catch (_) { /* ignore */ }
  cstate.save(); state.flush();
  const deadline = Date.now() + 8000;
  while (inflightPosts > 0 && Date.now() < deadline) await sleep(200);
  process.exit(EXIT_UNHEALTHY);
}
function writeHealthFile(rep) {
  try { writeJsonAtomic(HEALTH_FILE, { ts: Date.now(), connected: rep.connected, healthy: rep.healthy, problems: rep.problems, ws_status: rep.ws_status }); } catch (_) { /* ignore */ }
}
function healthTick() {
  const now = Date.now();
  let r;
  try { r = monitor.tick(now, healthSnapshot(now)); } catch (e) { log('health check error', e); return; }
  for (const n of r.notes) log(`HEALTH: ${n}`);
  if (r.notes.some((n) => /clock jumped/.test(n))) scheduleCatchup('clock-jump'); // REST works even if the gateway is dead; reads the pre-freeze lastAliveAt
  else if (!r.reasons.length && !monitor.wake && healthSnapshot(now).status === 'READY') {
    const g = gatewayState(now);
    if (g.ackAgeMs !== null && g.ackAgeMs < 90000) cstate.alive(now); // only count genuinely verified-alive time
  }
  if (r.reasons.length) log(`HEALTH: ${r.action === 'exit' ? 'FAILED' : 'warning'}: ${r.reasons.join('; ')}`);
  writeHealthFile(statusReport());
  state.flush();
  pipeline.releaseHeld(now, client && client.user && client.user.id).catch((e) => log('release held error', e));
  if (r.action === 'exit') return void exitUnhealthy(r.reasons.join('; '));
  if (!r.reasons.length && now - gw.lastPresenceAt > 10 * 60 * 1000) applyPresence('periodic', true);
}

// ---------- discord handling ----------
async function repliesToBot(message) {
  const ref = await message.fetchReference();
  return ref.author.id === client.user.id;
}
const followupFn = (m) => policy.roleOf(m.author.id) === 'owner' && followups.inWindow(m.channelId, m.createdTimestamp, settings.get().followupMinutes * 60000);

async function onMessage(message) {
  try {
    if (message.author && message.author.id === client.user.id) { followups.noteBot(message.channelId, message.createdTimestamp); return; }
    if (cstate.hasSeen(message.id)) return;
    const c = await catchup.classifyMessage(message, { botId: client.user.id, resolveReplyToBot: repliesToBot, isFollowup: message.guildId && settings.get().followupMinutes > 0 ? followupFn : null });
    if (!c) return;
    const r = await pipeline.process(message, c, { botId: client.user.id });
    if (c.kind === 'dm' && r.action === 'wake') cstate.rememberDm(r.info.channel_id);
  } catch (e) { log('onMessage error', e); }
}

// ---------- catch-up ----------
let catchupRunning = false, catchupPending = null, catchupTimer = null;
function scheduleCatchup(reason, { fresh = false } = {}) {
  if (exiting) return;
  catchupPending = { reasons: [...(catchupPending ? catchupPending.reasons : []), reason], fresh: fresh || (catchupPending && catchupPending.fresh) };
  if (catchupTimer || catchupRunning) return;
  catchupTimer = setTimeout(() => { catchupTimer = null; runCatchupNow().catch((e) => log('catch-up error', e)); }, 2000);
}
async function buildCatchupSources(fresh, floorMs, now) {
  const c = client; const s = settings.get();
  const sources = []; const seen = new Set();
  // 1) DMs with the owner / approved users (a bot can't list its DM channels: use remembered ones + createDM for known ids)
  const dmIds = new Set(cstate.dmChannels);
  const userIds = new Set([cfg.ownerId, ...s.approved.map((u) => u.id)]);
  for (const uid of userIds) {
    try { const ch = await c.users.createDM(uid); if (ch) { dmIds.add(ch.id); cstate.rememberDm(ch.id); } } catch (e) { log(`catch-up: createDM ${uid} failed: ${e.code || e.name}`); }
  }
  for (const id of dmIds) {
    try {
      const ch = c.channels.cache.get(id) || await c.channels.fetch(id);
      if (!ch || ch.type !== ChannelType.DM) continue;
      const rid = ch.recipientId || (ch.recipient && ch.recipient.id);
      if (policy.roleOf(rid) === 'other' && s.newUsers !== 'wake-as-other') continue; // strangers would be dropped anyway
      seen.add(id);
      sources.push({ channelId: id, kind: 'dm', fetchPage: ({ after, limit }) => ch.messages.fetch({ after, limit }).then((m) => Array.from(m.values())) });
    } catch (e) { log(`catch-up: DM channel ${id} unavailable: ${e.code || e.name}`); }
  }
  // 2) guild text channels the bot can read. After a fresh session lastMessageId tells which channels have nothing new (saves REST calls).
  const afterId = catchup.snowflakeFromTs(Math.max(now - catchup.DEFAULTS.windowMs, floorMs || 0));
  const chans = [];
  for (const g of c.guilds.cache.values()) {
    const me = g.members.me;
    for (const ch of g.channels.cache.values()) {
      if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) continue;
      if (seen.has(ch.id)) continue;
      try { const perms = me && ch.permissionsFor(me); if (!perms || !perms.has('ViewChannel') || !perms.has('ReadMessageHistory')) continue; } catch (_) { continue; }
      if (fresh && ch.lastMessageId && catchup.cmpId(ch.lastMessageId, catchup.maxId(afterId, cstate.lastIds[ch.id])) <= 0) continue;
      chans.push(ch);
    }
  }
  chans.sort((x, y) => (y.lastMessageId ? (x.lastMessageId ? catchup.cmpId(y.lastMessageId, x.lastMessageId) : 1) : (x.lastMessageId ? -1 : 0)));
  for (const ch of chans) sources.push({ channelId: ch.id, kind: 'guild', fetchPage: ({ after, limit }) => ch.messages.fetch({ after, limit }).then((m) => Array.from(m.values())) });
  return sources;
}
async function runCatchupNow() {
  if (catchupRunning || !client || !client.user || exiting) return;
  const job = catchupPending; catchupPending = null;
  if (!job) return;
  catchupRunning = true;
  const t0 = Date.now();
  try {
    if (!cstate.lastAliveAt) { // brand-new install (or wiped data dir): never replay old history, just start the clock
      cstate.alive(t0);
      log('catch-up: no previous state (fresh install); skipping replay of old messages');
      return;
    }
    const floorMs = cstate.lastAliveAt - catchup.DEFAULTS.overlapMs;
    const sources = await buildCatchupSources(job.fresh, floorMs, t0);
    const botId = client.user.id;
    const r = await catchup.runCatchup({
      sources, state: cstate, now: t0, floorMs, botId, log, followups,
      process: (m, c, o) => pipeline.process(m, c, { ...o, botId }),
      resolveReplyToBot: repliesToBot,
      isFollowup: settings.get().followupMinutes > 0 ? followupFn : null,
    });
    log(`catch-up (${[...new Set(job.reasons)].join('+')}): channels=${r.channels} fetched=${r.fetched} missed_fed=${r.fed} dup_skipped=${r.skipped_seen} errors=${r.errors} in ${Date.now() - t0}ms (since ${new Date(floorMs).toISOString()})`);
  } catch (e) { log('catch-up failed', e); }
  finally {
    catchupRunning = false;
    cstate.save();
    if (catchupPending) scheduleCatchup('rerun');
  }
}

// ---------- slash commands ----------
const cmdCtx = {
  ownerId: cfg.ownerId, settings, state, log,
  get botId() { return client && client.user ? client.user.id : ''; },
  getStatus: () => statusReport(),
  guilds: () => (client ? Array.from(client.guilds.cache.values()).map((g) => ({ id: g.id, name: g.name })) : []),
  leaveGuild: async (id) => { const g = client && client.guilds.cache.get(id); if (!g) return false; await g.leave(); return true; },
  testWebhook: () => postWebhook({ event: 'bridge_test', content_trust: 'untrusted', note: 'Test event from /bridge test-webhook. No action needed.', timestamp: new Date().toISOString() }, cfg, log, { attempts: 1 }),
  onChange: (keys) => {
    if (!client) return;
    if (keys.includes('*') || keys.includes('pinnedChannelId')) startPinnedStatus(client);
    if (keys.includes('*') || keys.includes('presence') || keys.includes('pinnedChannelId')) applyPresence('settings');
  },
};
async function registerCommands(c) {
  const def = commands.definition();
  const h = crypto.createHash('sha256').update(JSON.stringify(def)).digest('hex');
  if (state.commandsHash === h) return;
  try {
    await c.application.commands.set([def]); // global registration; only when the definition changed
    state.commandsHash = h; state.touch(); state.flush();
    log('slash commands registered (/bridge)');
  } catch (e) { log(`slash command registration failed: ${e.code || ''} ${e.name}; will retry on next start`); }
}

// ---------- connect ----------
async function connect() {
  if (client) { try { client.destroy(); } catch (_) { /* ignore */ } }
  stopPinnedStatus();
  Object.assign(gw, { connectStartedAt: Date.now(), everReady: false, readyAt: 0, lastEventAt: 0 });
  monitor.reset();
  const c = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
    presence: presencePayload(), // sent with every IDENTIFY, so a fresh session is never blank
  });
  client = c;
  const live = (fn) => (...args) => { if (client === c) fn(...args); }; // ignore events from a replaced client
  c.on('error', live((e) => log('client error', e)));
  c.on('warn', live((m) => log('client warn', m)));
  c.on('raw', live(() => { gw.lastEventAt = Date.now(); }));
  c.on('debug', live((m) => { if (/zombie|invalid session|not recoverable|resum|reconnect|closed|close code/i.test(String(m))) log('gateway debug:', String(m).slice(0, 300)); }));
  c.on('invalidated', live(() => { log('client invalidated: session is no longer usable'); exitUnhealthy('client invalidated'); }));
  c.once('clientReady', live(() => {
    gw.everReady = true; gw.readyAt = Date.now();
    log(`clientReady: connected as ${c.user.tag} (${c.user.id}); guilds=${c.guilds.cache.size}`);
    applyPresence('clientReady');
    startPinnedStatus(c);
    registerCommands(c);
    writeHealthFile(statusReport());
    scheduleCatchup('clientReady', { fresh: true });
  }));
  c.on('shardReady', live((id, unavailable) => {
    const first = !gw.everReady;
    gw.everReady = true; gw.readyAt = Date.now();
    log(`shard ${id} ready${unavailable && unavailable.size ? ` (unavailable guilds: ${unavailable.size})` : ''}`);
    if (!first) { setTimeout(live(() => applyPresence(`shardReady ${id} (new session)`)), 1000); scheduleCatchup('new-session', { fresh: true }); }
  }));
  c.on('shardDisconnect', live((ev, id) => { gw.disconnects++; gw.lastDisconnectAt = Date.now(); log(`shard ${id} disconnected code=${ev && ev.code} wasClean=${ev && ev.wasClean}`); }));
  c.on('shardReconnecting', live((id) => { gw.reconnects++; log(`shard ${id} reconnecting`); }));
  c.on('shardResume', live((id, replayed) => {
    gw.resumes++; gw.readyAt = Date.now();
    log(`shard ${id} resumed (replayed ${replayed} events)`);
    applyPresence(`shardResume ${id}`);
    if (pinnedStatus) pinnedStatus.poll().catch((e) => log('pinned status error', e));
    scheduleCatchup('shardResume');
  }));
  c.on('shardError', live((e, id) => log(`shard ${id} error`, e)));
  c.on('messageCreate', live(onMessage));
  c.on('interactionCreate', live((i) => { commands.handleInteraction(i, cmdCtx).catch((e) => log('interaction error', e)); }));
  await c.login(cfg.token);
}

async function main() {
  log(`grok-discord-bridge starting (node ${process.version}, data dir ${cfg.dataDir})`);
  let failDelay = 60000;
  for (;;) {
    try { log('logging in to Discord...'); await connect(); return; } catch (e) {
      const msg = /disallowed intents/i.test(e.message)
        ? 'login failed: the Message Content intent is not enabled. Developer Portal > your app > Bot > enable "Message Content Intent" > Save.'
        : /invalid token|TokenInvalid/i.test(e.message) || e.code === 'TokenInvalid'
          ? 'login failed: Discord rejected the token (invalid or reset). Update DISCORD_BOT_TOKEN and restart.'
          : `login failed: ${e.code || ''} ${e.name}`;
      log(`${msg} Retrying in ${Math.round(failDelay / 1000)}s.`);
      if (client) { try { client.destroy(); } catch (_) { /* ignore */ } client = null; }
      await sleep(failDelay);
      failDelay = Math.min(failDelay * 2, 600000);
    }
  }
}

setInterval(healthTick, HEALTH.intervalMs);
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
process.on('uncaughtException', (e) => log('uncaughtException', e));
const shutdown = () => { exiting = true; log('shutting down'); batcher.flushAll(); cstate.save(); state.flush(); setTimeout(() => process.exit(0), 1500); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
main();
