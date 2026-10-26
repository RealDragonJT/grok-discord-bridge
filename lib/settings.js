'use strict';
// data/settings.json: every runtime option, managed by the owner through /bridge slash commands.
// Atomic writes, chmod 600, versioned with migrations, always normalized (bad values fall back to defaults).
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, isSnowflake } = require('./util');

const VERSION = 1;
const NEW_USER_MODES = ['ignore', 'approved-only', 'wake-as-other'];
const GUILD_MODES = ['allow-all', 'allowlist'];
const QUIET_MODES = ['suppress', 'hold'];
const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const LIST_CAP = 500;

const DEFAULTS = Object.freeze({
  version: VERSION,
  // What happens to people who are neither the owner nor approved. 'ignore' = silently dropped (safest, no cost).
  newUsers: 'ignore',
  approved: [],   // [{ id, label, addedAt }]
  blocked: [],    // [{ id, label, addedAt }]
  quietHours: { enabled: false, start: '22:00', end: '07:00', tz: 'UTC', mode: 'suppress', ownerAlways: true },
  guilds: { mode: 'allow-all', allow: [], deny: [] },
  channels: {},   // { [guildId]: [channelId, ...] } optional per-guild channel allowlist for non-owner wakes
  bots: { allow: [], maxWakesPerMinute: 3 }, // other bots never wake the agent unless allowlisted
  cooldownSeconds: 15,                        // per-user wake cooldown (owner exempt). 0 = off
  dailyCap: { max: 200, tz: 'UTC' },          // max wakes/day from non-owners (owner exempt). 0 = unlimited
  followupMinutes: 10,                        // owner follow-up window after the bot posts (0 = off)
  options: { debounceSeconds: 4, reactEyes: true, typing: true },
  presence: { text: '', status: 'online' },
  pinnedChannelId: '',                        // optional channel whose newest pin (by bot or owner) is the status text
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, min, max, dflt) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);

function parseHHMM(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const fmtHHMM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
function validTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

const idList = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter(isSnowflake))].slice(0, LIST_CAP);
function userList(v) {
  const out = []; const seen = new Set();
  for (const e of Array.isArray(v) ? v : []) {
    const o = isObj(e) ? e : { id: e };
    const id = String(o.id || '').trim();
    if (!isSnowflake(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: str(o.label || o.username || '', 64), addedAt: str(o.addedAt || '', 40) });
  }
  return out.slice(0, LIST_CAP);
}

// Upgrade older on-disk shapes to the current one. Add a step here whenever the format changes.
function migrate(raw) {
  let s = isObj(raw) ? clone(raw) : {};
  let v = Number.isInteger(s.version) ? s.version : 0;
  if (v < 1) {
    // v0 (pre-release shape): plain id arrays, flat quiet*/cooldown/daily fields, 'strangers' instead of 'newUsers'
    if (Array.isArray(s.approved)) s.approved = s.approved.map((e) => (isObj(e) ? e : { id: e }));
    if (Array.isArray(s.blocked)) s.blocked = s.blocked.map((e) => (isObj(e) ? e : { id: e }));
    if (s.strangers && !s.newUsers) s.newUsers = s.strangers;
    if (s.quietStart || s.quietEnd || s.quietTz) s.quietHours = { ...(s.quietHours || {}), enabled: true, start: s.quietStart, end: s.quietEnd, tz: s.quietTz };
    if (s.cooldown !== undefined && s.cooldownSeconds === undefined) s.cooldownSeconds = s.cooldown;
    if (s.dailyMax !== undefined && !s.dailyCap) s.dailyCap = { max: s.dailyMax };
    v = 1;
  }
  s.version = v;
  return s; // future versions (> VERSION) are kept as-is and normalized best-effort
}

// Coerce anything into a valid settings object. Unknown keys are dropped.
function normalize(input) {
  const s = migrate(input);
  const d = DEFAULTS;
  const q = isObj(s.quietHours) ? s.quietHours : {};
  const startM = parseHHMM(q.start); const endM = parseHHMM(q.end);
  const g = isObj(s.guilds) ? s.guilds : {};
  const ch = {};
  if (isObj(s.channels)) for (const [gid, list] of Object.entries(s.channels)) { const l = idList(list); if (isSnowflake(gid) && l.length) ch[gid] = l; }
  const b = isObj(s.bots) ? s.bots : {};
  const dc = isObj(s.dailyCap) ? s.dailyCap : {};
  const o = isObj(s.options) ? s.options : {};
  const p = isObj(s.presence) ? s.presence : {};
  return {
    version: VERSION,
    newUsers: NEW_USER_MODES.includes(s.newUsers) ? s.newUsers : d.newUsers,
    approved: userList(s.approved),
    blocked: userList(s.blocked),
    quietHours: {
      enabled: q.enabled === true && startM !== null && endM !== null && startM !== endM,
      start: fmtHHMM(startM !== null ? startM : parseHHMM(d.quietHours.start)),
      end: fmtHHMM(endM !== null ? endM : parseHHMM(d.quietHours.end)),
      tz: validTz(q.tz) ? q.tz : d.quietHours.tz,
      mode: QUIET_MODES.includes(q.mode) ? q.mode : d.quietHours.mode,
      ownerAlways: q.ownerAlways === undefined ? d.quietHours.ownerAlways : q.ownerAlways !== false,
    },
    guilds: { mode: GUILD_MODES.includes(g.mode) ? g.mode : d.guilds.mode, allow: idList(g.allow), deny: idList(g.deny) },
    channels: ch,
    bots: { allow: idList(b.allow), maxWakesPerMinute: clampInt(b.maxWakesPerMinute, 1, 60, d.bots.maxWakesPerMinute) },
    cooldownSeconds: clampInt(s.cooldownSeconds, 0, 86400, d.cooldownSeconds),
    dailyCap: { max: clampInt(dc.max, 0, 100000, d.dailyCap.max), tz: validTz(dc.tz) ? dc.tz : d.dailyCap.tz },
    followupMinutes: clampInt(s.followupMinutes, 0, 1440, d.followupMinutes),
    options: {
      debounceSeconds: clampInt(o.debounceSeconds, 1, 60, d.options.debounceSeconds),
      reactEyes: o.reactEyes === undefined ? d.options.reactEyes : o.reactEyes !== false,
      typing: o.typing === undefined ? d.options.typing : o.typing !== false,
    },
    presence: { text: str(p.text, 128), status: PRESENCE_STATUSES.includes(p.status) ? p.status : 'online' },
    pinnedChannelId: isSnowflake(s.pinnedChannelId) ? String(s.pinnedChannelId).trim() : '',
  };
}

class SettingsStore {
  constructor(file, { log = () => {}, seedB64 = '' } = {}) {
    this.file = file; this.log = log;
    this.data = this.load(seedB64);
  }
  load(seedB64) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') {
        if (seedB64) {
          try { raw = JSON.parse(Buffer.from(seedB64, 'base64').toString('utf8')); this.log('settings: seeded from SETTINGS_B64'); } catch (_) { this.log('settings: SETTINGS_B64 is not valid base64 JSON; using defaults'); }
          const data = normalize(raw); this.persist(data); return data;
        }
        const data = normalize({}); this.persist(data); return data;
      }
      // unreadable / corrupt: keep a copy, start from defaults rather than crash-looping
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch (_) { /* ignore */ }
      this.log(`settings: ${path.basename(this.file)} unreadable (${e.name}); backed up and reset to defaults`);
      const data = normalize({}); this.persist(data); return data;
    }
    const data = normalize(raw);
    if (!isObj(raw) || raw.version !== VERSION) { this.log(`settings: migrated to version ${VERSION}`); this.persist(data); }
    return data;
  }
  persist(data) { writeJsonAtomic(this.file, data); }
  get() { return this.data; }
  // fn(draft) mutates a deep copy; result is normalized and saved atomically. Returns the new settings.
  update(fn) {
    const draft = clone(this.data);
    fn(draft);
    const next = normalize(draft);
    this.persist(next);
    this.data = next;
    return next;
  }
  reset() { return this.update((d) => { Object.keys(d).forEach((k) => delete d[k]); }); }
  exportJson() { return JSON.stringify(this.data, null, 2); }
}

module.exports = { VERSION, DEFAULTS, NEW_USER_MODES, GUILD_MODES, QUIET_MODES, PRESENCE_STATUSES, normalize, migrate, SettingsStore, parseHHMM, fmtHHMM, validTz };
