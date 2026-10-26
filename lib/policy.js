'use strict';
// Who may wake the agent, and when. Pure decision logic (no discord.js): easy to test, easy to audit.
// Roles are resolved HERE, by user id, never from message text:  owner | approved | other.
const { parseHHMM } = require('./settings');

const tzCache = new Map();
function partsIn(ts, tz) {
  let f = tzCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    tzCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: o.year, mo: o.month, d: o.day, minutes: Number(o.hour) * 60 + Number(o.minute) };
}

// Is local time (in q.tz) inside [start, end)?  Overnight ranges (start > end, e.g. 22:00-07:00) wrap midnight.
function isQuiet(q, ts) {
  if (!q || !q.enabled) return false;
  const s = parseHHMM(q.start); const e = parseHHMM(q.end);
  if (s === null || e === null || s === e) return false;
  const m = partsIn(ts, q.tz || 'UTC').minutes;
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

// 'YYYY-MM-DD' in tz: the daily-cap bucket.
function dayKey(ts, tz = 'UTC') { const p = partsIn(ts, tz); return `${p.y}-${p.mo}-${p.d}`; }

class Policy {
  constructor({ getSettings, ownerId, state }) {
    this.getSettings = getSettings; this.ownerId = String(ownerId); this.state = state;
    this.lastWake = new Map();  // user id -> epoch ms of their last admitted wake (cooldown)
    this.botWakes = new Map();  // bot id -> [epoch ms] (loop guard)
  }

  roleOf(userId) {
    const id = String(userId);
    if (id === this.ownerId) return 'owner';
    return this.getSettings().approved.some((u) => u.id === id) ? 'approved' : 'other';
  }
  isBlocked(userId) { return this.getSettings().blocked.some((u) => u.id === String(userId)); }

  quietFor(role, ts) {
    const q = this.getSettings().quietHours;
    if (!isQuiet(q, ts)) return false;
    return role !== 'owner' || !q.ownerAlways;
  }

  guildAllowed(guildId) {
    const g = this.getSettings().guilds;
    if (g.deny.includes(guildId)) return false;
    return g.mode === 'allow-all' || g.allow.includes(guildId);
  }
  channelAllowed(guildId, channelId) {
    const list = this.getSettings().channels[guildId];
    return !list || list.length === 0 || list.includes(channelId);
  }

  // c: { authorId, authorUsername, authorIsBot, kind: dm|mention|followup, guildId|null, channelId, ts, pendingSameUser, released }
  // Returns { action: 'wake'|'drop'|'hold', reason, role, notifyCap? }. Records the wake (cooldown, daily count, bot guard) when it returns 'wake'.
  admit(c, now = Date.now()) {
    const s = this.getSettings();
    const role = this.roleOf(c.authorId);
    const drop = (reason, extra = {}) => ({ action: 'drop', reason, role, ...extra });
    const owner = role === 'owner';

    if (c.authorIsBot) {
      if (!s.bots.allow.includes(String(c.authorId))) return drop('bot');
      if (c.kind !== 'mention' || !c.guildId) return drop('bot');
      const recent = (this.botWakes.get(c.authorId) || []).filter((t) => now - t < 60000);
      this.botWakes.set(c.authorId, recent);
      if (recent.length >= s.bots.maxWakesPerMinute) return drop('bot-loop-guard');
    } else if (!owner && this.isBlocked(c.authorId)) return drop('blocked');

    if (c.kind === 'followup' && !owner) return drop('followup-not-owner');

    if (!owner && c.guildId) {
      if (!this.guildAllowed(c.guildId)) return drop('guild');
      if (!this.channelAllowed(c.guildId, c.channelId)) return drop('channel');
    }

    if (!owner && !c.authorIsBot && role === 'other') {
      if (s.newUsers === 'ignore') return drop('stranger');
      if (s.newUsers === 'approved-only') return drop('stranger', { pending: true });
      // 'wake-as-other': falls through (still subject to quiet hours, cooldown and cap)
    }

    if (!c.released && this.quietFor(role, c.ts)) {
      return s.quietHours.mode === 'hold' ? { action: 'hold', reason: 'quiet-hours', role } : drop('quiet-hours');
    }

    if (!owner && !c.pendingSameUser) {
      const cd = s.cooldownSeconds * 1000;
      const last = this.lastWake.get(String(c.authorId)) || 0;
      if (cd > 0 && now - last < cd) return drop('cooldown');
      const cap = s.dailyCap.max;
      if (cap > 0) {
        this.state.rollDay(dayKey(now, s.dailyCap.tz));
        if (this.state.dailyCount >= cap) {
          const notifyCap = this.state.capNotifiedDay !== this.state.day;
          if (notifyCap) { this.state.capNotifiedDay = this.state.day; this.state.touch(); }
          return drop('daily-cap', { notifyCap });
        }
      }
    }

    if (!owner && !c.pendingSameUser) {
      this.lastWake.set(String(c.authorId), now);
      this.state.rollDay(dayKey(now, s.dailyCap.tz));
      this.state.dailyCount++; this.state.touch();
    }
    if (c.authorIsBot) this.botWakes.get(c.authorId).push(now);
    if (this.lastWake.size > 5000) this.lastWake.clear();
    return { action: 'wake', reason: 'ok', role };
  }
}

module.exports = { Policy, isQuiet, dayKey };
