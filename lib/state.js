'use strict';
// data/state.json: runtime bookkeeping that should survive restarts (daily counters, stats, pending strangers).
// Holds ids, counts and timestamps only: never message text. Flushed lazily (dirty flag) with atomic 600 writes.
const { writeJsonAtomic, readJson } = require('./util');

const PENDING_MAX = 25;

class RuntimeState {
  constructor(file) {
    this.file = file;
    this.dirty = false;
    const j = readJson(file, {}) || {};
    this.day = typeof j.day === 'string' ? j.day : '';
    this.dailyCount = Number.isFinite(j.dailyCount) ? j.dailyCount : 0;
    this.capNotifiedDay = typeof j.capNotifiedDay === 'string' ? j.capNotifiedDay : '';
    this.commandsHash = typeof j.commandsHash === 'string' ? j.commandsHash : '';
    this.stats = { wakes: 0, dropped: {}, lastWakeAt: null, lastWakeKind: null, lastWebhook: null, since: new Date().toISOString(), ...(j.stats || {}) };
    this.pending = j.pending && typeof j.pending === 'object' ? j.pending : {}; // strangers seen in approved-only mode: id -> { username, firstAt, lastAt, count }
  }
  touch() { this.dirty = true; }
  flush() {
    if (!this.dirty) return;
    try {
      writeJsonAtomic(this.file, { day: this.day, dailyCount: this.dailyCount, capNotifiedDay: this.capNotifiedDay, commandsHash: this.commandsHash, stats: this.stats, pending: this.pending });
      this.dirty = false;
    } catch (_) { /* never crash over bookkeeping */ }
  }
  rollDay(day) { if (this.day !== day) { this.day = day; this.dailyCount = 0; this.touch(); } }
  countDrop(reason) { this.stats.dropped[reason] = (this.stats.dropped[reason] || 0) + 1; this.touch(); }
  recordWake(kind, now) { this.stats.wakes++; this.stats.lastWakeAt = new Date(now).toISOString(); this.stats.lastWakeKind = kind; this.touch(); }
  recordWebhook(res, now = Date.now()) { this.stats.lastWebhook = { at: new Date(now).toISOString(), ok: !!res.ok, status: res.status || 0 }; this.touch(); }
  notePending(id, username, now = Date.now()) {
    const e = this.pending[id] || { username: String(username || '').slice(0, 64), firstAt: new Date(now).toISOString(), count: 0 };
    e.count++; e.lastAt = new Date(now).toISOString(); this.pending[id] = e;
    const ids = Object.keys(this.pending);
    if (ids.length > PENDING_MAX) {
      ids.sort((a, b) => String(this.pending[a].lastAt).localeCompare(String(this.pending[b].lastAt)));
      for (const k of ids.slice(0, ids.length - PENDING_MAX)) delete this.pending[k];
    }
    this.touch();
  }
  clearPending(id) { if (this.pending[id]) { delete this.pending[id]; this.touch(); } }
}

module.exports = { RuntimeState };
