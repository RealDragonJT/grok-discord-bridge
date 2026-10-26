'use strict';
// Docker HEALTHCHECK. The bridge rewrites <DATA_DIR>/health.json every 30 s; this reads it.
// Exit 0 = connected, healthy and fresh. Exit 1 = anything else. No network ports are involved.
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_AGE_MS = 120000;
try {
  const h = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
  const age = Date.now() - h.ts;
  const ok = h.connected && h.healthy && age < MAX_AGE_MS;
  console.log(ok ? 'ok' : `unhealthy: connected=${h.connected} healthy=${h.healthy} age=${Math.round(age / 1000)}s problems=${(h.problems || []).join(',')}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`no health report yet (${e.code || e.name})`);
  process.exit(1);
}
