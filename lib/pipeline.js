'use strict';
// The one path every candidate message takes (live, catch-up, or released from quiet-hours hold):
//   dedupe -> policy.admit (role, allowlists, quiet hours, cooldown, caps) -> payload -> debounce batcher -> webhook.
// Logs ids and lengths only, never message text.
const { extractInfo } = require('./payload');

class Pipeline {
  constructor({ getSettings, policy, cstate, state, batcher, log = () => {}, ack = null, notifyOwner = null, staleMs = 120000, maxHeld = 100 }) {
    Object.assign(this, { getSettings, policy, cstate, state, batcher, log, ack, notifyOwner, staleMs, maxHeld });
    this.held = []; // [{ message, c, heldAt }] in memory only (quiet-hours mode "hold")
  }

  async process(message, c, { missed = false, now = Date.now(), released = false, botId } = {}) {
    if (this.cstate.hasSeen(message.id)) return { action: 'seen' };
    if (this.held.some((h) => h.message.id === message.id)) return { action: 'seen' };
    const authorId = message.author.id;
    const ts = message.createdTimestamp || (message.createdAt ? +new Date(message.createdAt) : now);
    const channelId = message.channelId || (message.channel && message.channel.id);
    const guildId = message.guildId || (message.guild && message.guild.id) || null;
    const d = this.policy.admit({
      authorId, authorUsername: message.author.username, authorIsBot: !!c.authorIsBot, kind: c.kind, guildId, channelId, ts, released,
      pendingSameUser: this.batcher.hasPending(channelId, authorId),
    }, now);

    if (d.action === 'hold') {
      if (this.held.length >= this.maxHeld) { const old = this.held.shift(); this.cstate.markSeen(old.message.channelId, old.message.id, now); this.state.countDrop('hold-overflow'); }
      this.held.push({ message, c, heldAt: now });
      this.state.countDrop('held-quiet-hours');
      this.log(`held (quiet hours) msg=${message.id} channel=${channelId} role=${d.role}`);
      return d;
    }
    if (d.action === 'drop') {
      this.cstate.markSeen(channelId, message.id, now); // handled on purpose: catch-up must not resurrect it
      this.state.countDrop(d.reason);
      if (d.pending) this.state.notePending(authorId, message.author.username, now);
      if (d.reason === 'daily-cap' && d.notifyCap && this.notifyOwner) Promise.resolve(this.notifyOwner('daily-cap')).catch(() => {});
      this.log(`dropped reason=${d.reason} kind=${c.kind} msg=${message.id} channel=${channelId} author=${authorId} len=${(message.content || '').length}`);
      return d;
    }

    const ageMs = Math.max(0, now - ts);
    const info = extractInfo(message, { kind: c.kind, botId, role: d.role, isReplyToBot: c.replyToBot, missed, deliveredLateSeconds: missed ? Math.round(ageMs / 1000) : null });
    this.cstate.markSeen(info.channel_id, info.message_id, now);
    this.cstate.save();
    this.state.recordWake(c.kind, now);
    this.log(`wake ${c.kind}${missed ? ' MISSED' : ''} msg=${info.message_id} channel=${info.channel_id} role=${info.author_role} len=${info.content.length}${missed ? ` late=${info.delivered_late_seconds}s` : ''}`);
    if (this.ack && d.role === 'owner' && c.kind !== 'followup' && ageMs <= this.staleMs) this.ack(info, message); // typing / 👀 only for fresh direct owner messages
    this.batcher.add(info);
    return { ...d, info };
  }

  // Deliver held messages whose quiet period is over (as missed:true, so the agent sees how late they are).
  async releaseHeld(now = Date.now(), botId) {
    if (!this.held.length) return 0;
    const ready = this.held.filter((h) => !this.policy.quietFor(this.policy.roleOf(h.message.author.id), now));
    this.held = this.held.filter((h) => !ready.includes(h));
    for (const h of ready) await this.process(h.message, h.c, { missed: true, now, released: true, botId });
    if (ready.length) this.log(`released ${ready.length} held message(s) after quiet hours`);
    return ready.length;
  }
}

module.exports = { Pipeline };
