'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { mkTmp, mkMap, OWNER, BOT_ID } = require('./helpers');
const { SettingsStore } = require('../lib/settings');
const { RuntimeState } = require('../lib/state');
const { Policy } = require('../lib/policy');
const { Batcher, buildEvent } = require('../lib/payload');
const { Pipeline } = require('../lib/pipeline');
const cu = require('../lib/catchup');
const { sleep } = require('../lib/util');

const FRIEND = '300000000000000001', RANDO = '300000000000000002', BOTTY = '400000000000000009';
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const sf = (agoMs, n = 0) => (BigInt(cu.snowflakeFromTs(NOW - agoMs)) + BigInt(n)).toString();

function mk(agoMs, o = {}) {
  const id = o.id || sf(agoMs);
  const dm = o.guild === false;
  return {
    id, channelId: o.ch || 'g1c', guildId: dm ? null : '600000000000000001', guild: dm ? null : { id: '600000000000000001', name: 'Test Guild' },
    channel: { id: o.ch || 'g1c', name: 'general', type: dm ? 1 : 0 }, author: { id: o.aid || RANDO, username: o.user || 'someone', bot: !!o.bot },
    content: o.content || 'hi', attachments: new Map(), createdTimestamp: NOW - agoMs, createdAt: new Date(NOW - agoMs),
    mentions: { users: o.mention ? mkMap([{ id: BOT_ID, username: 'TestBot' }]) : new Map(), channels: new Map(), roles: new Map(), has: (i) => !!o.mention && i === BOT_ID },
    reference: o.replyTo ? { messageId: o.replyTo } : null,
  };
}

function rig(mut) {
  const dir = mkTmp();
  const settings = new SettingsStore(path.join(dir, 's.json'));
  settings.update((d) => { d.approved = [{ id: FRIEND }]; d.newUsers = 'wake-as-other'; d.cooldownSeconds = 0; d.dailyCap.max = 0; if (mut) mut(d); });
  const file = path.join(dir, 'catchup.json');
  const cstate = new cu.CatchupState(file, { pauseMs: 0 });
  const state = new RuntimeState(path.join(dir, 'state.json'));
  const policy = new Policy({ getSettings: () => settings.get(), ownerId: OWNER, state });
  const events = []; const acks = [];
  const batcher = new Batcher({ debounceMs: 30, maxWaitMs: 300, onFlush: (items) => events.push(buildEvent(items)) });
  const pipeline = new Pipeline({ getSettings: () => settings.get(), policy, cstate, state, batcher, ack: (i) => acks.push(i.message_id) });
  return { dir, file, settings, cstate, state, policy, batcher, pipeline, events, acks };
}

test('catch-up: only qualifying, new, non-dup, non-bot, <=3h messages; missed fields; no 👀 for stale; no double fire', async () => {
  const r = rig();
  const botMsg = mk(2 * 3600e3, { id: sf(2 * 3600e3, 5), aid: BOT_ID, bot: true, content: 'earlier bot msg' });
  const hist = {
    dm: [mk(10 * 3600e3, { ch: 'd1', guild: false, aid: OWNER, content: 'ancient' }),             // >3h: ignored
         mk(100 * 60e3, { ch: 'd1', guild: false, aid: OWNER, content: 'dm old' }),                // owner, 100 min old
         mk(30e3, { ch: 'd1', guild: false, aid: OWNER, content: 'dm fresh' }),                    // owner, 30 s old
         mk(50e3, { ch: 'd1', guild: false, aid: BOTTY, bot: true, content: 'bot dm' })],          // bot author: ignored
    guild: [mk(90 * 60e3, { content: 'plain chatter' }),                                           // no mention: ignored
            mk(80 * 60e3, { content: 'hey bot', mention: true, aid: FRIEND, user: 'Friend' }),      // mention, approved
            botMsg,
            mk(70 * 60e3, { content: 'replying to you', replyTo: botMsg.id, aid: RANDO }),          // reply to bot (resolved from the page)
            mk(60 * 60e3, { content: 'reply to human', replyTo: '123456' }),                        // reply to unknown: ignored
            mk(55 * 60e3, { content: 'already sent', mention: true })],                             // in recent set: skip
  };
  r.cstate.recent[hist.guild[5].id] = NOW - 3600e3;
  const pages = [];
  const fetchFor = (arr) => async ({ after, limit }) => { pages.push({ after, limit }); return arr.filter((m) => BigInt(m.id) > BigInt(after)); };
  const sources = () => [{ channelId: 'd1', kind: 'dm', fetchPage: fetchFor(hist.dm) }, { channelId: 'g1c', kind: 'guild', fetchPage: fetchFor(hist.guild) }];
  const run = (st = r.cstate) => cu.runCatchup({ sources: sources(), state: st, now: NOW, botId: BOT_ID, process: (m, c, o) => r.pipeline.process(m, c, { ...o, botId: BOT_ID }), resolveReplyToBot: async () => false, log: () => {} });

  const r1 = await run(); await sleep(250);
  assert(pages.every((p) => p.limit === 50), 'page limit 50');
  assert.strictEqual(r1.fed, 4, JSON.stringify(r1));
  assert.strictEqual(r.events.length, 2);
  const dm = r.events.find((e) => e.channel_id === 'd1'); const gd = r.events.find((e) => e.channel_id === 'g1c');
  assert.deepStrictEqual(dm.messages.map((m) => m.content), ['dm old', 'dm fresh']);
  assert.deepStrictEqual([dm.missed, dm.kind, dm.author_role], [true, 'dm', 'owner']);
  assert.deepStrictEqual(dm.messages.map((m) => m.delivered_late_seconds), [6000, 30]); assert.strictEqual(dm.delivered_late_seconds, 6000);
  assert.deepStrictEqual(gd.messages.map((m) => m.content), ['hey bot', 'replying to you']);
  assert.deepStrictEqual(gd.messages.map((m) => m.author_role), ['approved', 'other']);
  assert.strictEqual(gd.messages[1].is_reply_to_bot, true); assert.strictEqual(gd.kind, 'mention');
  assert.deepStrictEqual(r.acks, [hist.dm[2].id], '👀/typing only for the fresh (<=2 min) owner message');
  // dedupe: second run and a fresh process reading the same state file fire nothing
  assert.strictEqual((await run()).fed, 0);
  const st2 = new cu.CatchupState(r.file, { pauseMs: 0 });
  assert.strictEqual((await run(st2)).fed, 0); await sleep(150);
  assert.strictEqual(r.events.length, 2);
  assert(st2.lastIds.d1 && st2.hasSeen(hist.dm[2].id));
  // a live message already delivered by catch-up is rejected by the pipeline
  assert.strictEqual((await r.pipeline.process(hist.dm[2], { kind: 'dm', replyToBot: false, authorIsBot: false }, { botId: BOT_ID, now: NOW })).action, 'seen');
});

test('catch-up applies the same policy as live traffic (strangers dropped, quiet hours judged by message time)', async () => {
  const r = rig((d) => { d.newUsers = 'ignore'; d.quietHours = { enabled: true, start: '10:30', end: '11:00', tz: 'UTC', mode: 'suppress', ownerAlways: true }; });
  const hist = [mk(80 * 60e3, { content: 'stranger', mention: true, aid: RANDO }),            // 10:40 UTC, stranger => dropped
                mk(75 * 60e3, { content: 'friend in quiet hours', mention: true, aid: FRIEND }), // 10:45 UTC, quiet => suppressed
                mk(30 * 60e3, { content: 'friend after', mention: true, aid: FRIEND }),         // 11:30 UTC => wakes
                mk(76 * 60e3, { content: 'owner in quiet hours', mention: true, aid: OWNER })]; // owner always wakes
  const res = await cu.runCatchup({ sources: [{ channelId: 'g1c', kind: 'guild', fetchPage: async () => hist }], state: r.cstate, now: NOW, botId: BOT_ID, process: (m, c, o) => r.pipeline.process(m, c, { ...o, botId: BOT_ID }), log: () => {} });
  await sleep(200);
  assert.strictEqual(res.fed, 2);
  assert.deepStrictEqual(r.events[0].messages.map((m) => m.content), ['owner in quiet hours', 'friend after']);
  assert.deepStrictEqual(r.state.stats.dropped, { stranger: 1, 'quiet-hours': 1 });
});

test('classifyMessage: DM, mention, reply-to-bot, followup; ignores own, webhook and bot-DM messages', async () => {
  const dm = mk(1000, { guild: false, ch: 'd1' });
  assert.deepStrictEqual(await cu.classifyMessage(dm, { botId: BOT_ID }), { kind: 'dm', replyToBot: false, authorIsBot: false });
  assert.strictEqual(await cu.classifyMessage(mk(1000, { guild: false, aid: BOTTY, bot: true }), { botId: BOT_ID }), null);
  assert.strictEqual(await cu.classifyMessage(mk(1000, { mention: true, aid: BOT_ID }), { botId: BOT_ID }), null, 'own message');
  assert.strictEqual(await cu.classifyMessage({ ...mk(1000, { mention: true }), webhookId: '1' }, { botId: BOT_ID }), null);
  assert.deepStrictEqual(await cu.classifyMessage(mk(1000, { mention: true }), { botId: BOT_ID }), { kind: 'mention', replyToBot: false, authorIsBot: false });
  assert.deepStrictEqual(await cu.classifyMessage(mk(1000, { mention: true, aid: BOTTY, bot: true }), { botId: BOT_ID }), { kind: 'mention', replyToBot: false, authorIsBot: true });
  assert.deepStrictEqual(await cu.classifyMessage(mk(1000, { replyTo: '5' }), { botId: BOT_ID, resolveReplyToBot: async () => true }), { kind: 'mention', replyToBot: true, authorIsBot: false });
  assert.strictEqual(await cu.classifyMessage(mk(1000), { botId: BOT_ID }), null);
  assert.deepStrictEqual(await cu.classifyMessage(mk(1000, { aid: OWNER }), { botId: BOT_ID, isFollowup: () => true }), { kind: 'followup', replyToBot: false, authorIsBot: false });
  assert.strictEqual(await cu.classifyMessage(mk(1000, { aid: BOTTY, bot: true }), { botId: BOT_ID, isFollowup: () => true }), null, 'bots never get follow-ups');
});

test('follow-up window: tracker + end-to-end (owner wakes without @mention only inside the window)', async () => {
  const ft = new cu.FollowupTracker(); const W = 10 * 60000;
  ft.noteBot('c1', 1000000);
  assert.strictEqual(ft.inWindow('c1', 1000000 + 60000, W), true);
  assert.strictEqual(ft.inWindow('c1', 1000000 + W + 1, W), false);
  assert.strictEqual(ft.inWindow('c2', 1000000 + 60000, W), false);
  assert.strictEqual(ft.inWindow('c1', 1000000 + 60000, 0), false, '0 = off');
  const r = rig();
  const isFollowup = (m) => r.policy.roleOf(m.author.id) === 'owner' && ft.inWindow(m.channelId, m.createdTimestamp, W);
  ft.noteBot('g1c', NOW - 20 * 60e3);
  const res = await cu.runCatchup({ sources: [{ channelId: 'g1c', kind: 'guild', fetchPage: async () => [mk(15 * 60e3, { aid: OWNER, content: 'owner 5 min after the bot: in window' }), mk(5 * 60e3, { aid: OWNER, content: 'owner 15 min after the bot: too late' }), mk(4 * 60e3, { aid: FRIEND, content: 'friend, no mention, no followup' })] }], state: r.cstate, now: NOW, botId: BOT_ID, process: (m, c, o) => r.pipeline.process(m, c, { ...o, botId: BOT_ID }), isFollowup, log: () => {} });
  await sleep(150);
  assert.strictEqual(res.fed, 1);
  assert.deepStrictEqual([r.events[0].kind, r.events[0].messages[0].content], ['followup', 'owner 5 min after the bot: in window']);
});

test('state: recent-id set stays bounded; fresh state has no lastAliveAt (bot.js skips replay)', () => {
  const dir = mkTmp();
  const st = new cu.CatchupState(path.join(dir, 'c.json'), { recentIdsMax: 3 });
  assert.strictEqual(st.lastAliveAt, 0);
  for (let i = 0; i < 6; i++) st.markSeen('x', sf(1000 * (10 - i)), NOW);
  assert.strictEqual(Object.keys(st.recent).length, 3);
  st.alive(NOW); assert.strictEqual(new cu.CatchupState(path.join(dir, 'c.json')).lastAliveAt, NOW);
});

test('a newer live message never moves the cursor past an older missed one (reconnect recovery)', async () => {
  const r = rig();
  const missed = mk(20 * 60e3, { id: sf(20 * 60e3), content: 'missed while down', mention: true, aid: FRIEND });
  const live = mk(5 * 60e3, { id: sf(5 * 60e3), content: 'live after reconnect', mention: true, aid: FRIEND });
  // the live message is processed first (as the gateway does after a reconnect)
  await r.pipeline.process(live, { kind: 'mention', replyToBot: false, authorIsBot: false }, { botId: BOT_ID, now: NOW });
  assert.strictEqual(r.cstate.lastIds['g1c'], undefined, 'live handling must not advance the catch-up cursor');
  const res = await cu.catchUpChannel({
    channelId: 'g1c', kind: 'guild', state: r.cstate, now: NOW, floorMs: NOW - 3600e3, botId: BOT_ID,
    fetchPage: async ({ after }) => [missed, live].filter((m) => BigInt(m.id) > BigInt(after)),
    process: (m, c, o) => r.pipeline.process(m, c, { ...o, botId: BOT_ID }),
  });
  assert.strictEqual(res.fed, 1, 'only the missed one is fed; the live one is a dup');
  await sleep(150);
  assert.deepStrictEqual(r.events.flatMap((e) => e.messages.map((m) => m.content)).sort(), ['live after reconnect', 'missed while down']);
});

test('failed webhook deliveries are kept (ids only) and re-fed by the next catch-up pass, then cleared', async () => {
  const r = rig();
  const m = mk(10 * 60e3, { id: sf(10 * 60e3), content: 'important', mention: true, aid: FRIEND });
  const cls = { kind: 'mention', replyToBot: false, authorIsBot: false };
  await r.pipeline.process(m, cls, { botId: BOT_ID, now: NOW });
  await sleep(150);
  assert.strictEqual(r.events.length, 1);
  assert(r.cstate.hasSeen(m.id));
  // the webhook then failed for that batch
  r.cstate.noteUndelivered([{ channelId: 'g1c', id: m.id }]);
  assert(!r.cstate.hasSeen(m.id)); assert(r.cstate.hasUndelivered());
  const saved = JSON.stringify(JSON.parse(require('fs').readFileSync(r.file, 'utf8')));
  assert(!saved.includes('important'), 'only ids are persisted, never message text');
  // survives a restart
  const st2 = new cu.CatchupState(r.file, { pauseMs: 0 });
  assert.strictEqual(st2.undelivered['g1c'], m.id);
  const events2 = [];
  const pipe2 = new Pipeline({ getSettings: () => r.settings.get(), policy: r.policy, cstate: st2, state: r.state, batcher: new Batcher({ debounceMs: 30, maxWaitMs: 300, onFlush: (i) => events2.push(buildEvent(i)) }) });
  st2.advance('g1c', m.id); // even if the cursor had moved past it
  const res = await cu.catchUpChannel({
    channelId: 'g1c', kind: 'guild', state: st2, now: NOW, floorMs: NOW - 3600e3, botId: BOT_ID,
    fetchPage: async ({ after }) => [m].filter((x) => BigInt(x.id) > BigInt(after)),
    process: (mm, c, o) => pipe2.process(mm, c, { ...o, botId: BOT_ID }),
  });
  assert.strictEqual(res.fed, 1);
  await sleep(150);
  assert.strictEqual(events2.length, 1); assert.strictEqual(events2[0].messages[0].content, 'important'); assert.strictEqual(events2[0].missed, true);
  assert(!st2.hasUndelivered(), 'cleared once re-fed');
});
