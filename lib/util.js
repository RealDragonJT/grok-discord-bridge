'use strict';
// Small shared helpers: sleep, atomic JSON writes (mode 600), secret-redacting logger.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// Write JSON atomically (tmp file + rename) with owner-only permissions.
function writeJsonAtomic(file, obj, space = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, space) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) { /* best effort (e.g. Windows) */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

// Logger that redacts secrets. NEVER pass message text to it: log ids and lengths only.
function makeLogger(getSecrets = () => [], sink = (line) => console.log(line)) {
  return function log(...args) {
    let s = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
    for (const sec of getSecrets()) if (sec && sec.length > 6) s = s.split(sec).join('[redacted]');
    s = s.replace(/[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '[redacted-token]');
    sink(`${new Date().toISOString()} ${s}`);
  };
}

const isSnowflake = (v) => /^\d{15,25}$/.test(String(v || '').trim());

module.exports = { sleep, truthy, writeJsonAtomic, readJson, makeLogger, isSnowflake };
