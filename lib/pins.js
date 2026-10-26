'use strict';
// "Status from a pinned message" (REMOTE_MODE). Pure helpers + a small poller; no discord.js import so it is testable offline.
// The pinned message is UNTRUSTED input unless written by the bot itself or the owner (matched by user id only).
const VALID_STATUS = ['online', 'idle', 'dnd', 'invisible'];
const POLL_MS = 2 * 60 * 1000; // never tighter (rate limits)

// One line of plain text: strip control chars / newlines, collapse whitespace, trim, max 128 chars.
function sanitizeText(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128).trim();
}

// content -> { text, status } (text '' => unusable). Line 1 = status text; optional next line `status: idle|dnd|online|invisible`.
function parsePinnedContent(content) {
  const lines = String(content || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const text = sanitizeText(lines[0]);
  let status = null;
  const m = /^status\s*[:=]\s*(\w+)\s*$/i.exec(lines[1] || '');
  if (m && VALID_STATUS.includes(m[1].toLowerCase())) status = m[1].toLowerCase();
  return { text, status };
}

// items: [{ message: { id, content, author: { id } }, pinnedTimestamp }] (any order). Newest pin by the bot or OWNER_ID wins.
function pickPinned(items, { botId, ownerId }) {
  let best = null;
  for (const it of items || []) {
    const m = it && it.message;
    if (!m || !m.author || !m.author.id) continue;
    const id = String(m.author.id);
    if (id !== String(botId || '') && !(ownerId && id === String(ownerId))) continue; // ignore everyone else
    const p = parsePinnedContent(m.content);
    if (!p.text) continue;
    const ts = Number(it.pinnedTimestamp) || 0;
    if (!best || ts > best.ts) best = { ts, messageId: String(m.id), ...p };
  }
  return best;
}

// Poller. fetchPins() -> items[] (throws Discord errors with .status / .code). onChange(state|null) when the effective value changes.
class PinnedStatus {
  constructor({ fetchPins, getIds, log = () => {}, onChange = () => {} }) {
    Object.assign(this, { fetchPins, getIds, log, onChange });
    this.current = null; this.busy = false; this.lastErr = ''; this.lastKey = '';
  }
  async poll() {
    if (this.busy) return this.current;
    this.busy = true;
    try {
      const items = await this.fetchPins();
      this.lastErr = '';
      this.set(pickPinned(items, this.getIds()));
    } catch (e) {
      const code = e && (e.status || e.httpStatus || e.code);
      const key = String(code || (e && e.message) || 'error').slice(0, 80);
      if (key !== this.lastErr) { this.lastErr = key; this.log(`pinned status: cannot read pins (${key}); using the configured status text / default${this.current ? ' (keeping last pinned value on transient error)' : ''}`); }
      if (code === 403 || code === 404 || code === 50001 || code === 50013 || code === 10003) this.set(null); // unreadable: fall back
    } finally { this.busy = false; }
    return this.current;
  }
  set(v) {
    const key = v ? `${v.messageId}|${v.text}|${v.status || ''}` : '';
    if (key === this.lastKey) return;
    this.lastKey = key; this.current = v;
    this.log(v ? `pinned status: using message ${v.messageId} len=${v.text.length}${v.status ? ` status=${v.status}` : ''}` : 'pinned status: no usable pin (by bot/owner); falling back');
    try { this.onChange(v); } catch (e) { this.log('pinned status onChange error', e); }
  }
}

module.exports = { POLL_MS, sanitizeText, parsePinnedContent, pickPinned, PinnedStatus, VALID_STATUS };
