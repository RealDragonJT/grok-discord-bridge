'use strict';
// Environment configuration. The ONLY things that live in env are the four required values
// (plus optional DATA_DIR / SETTINGS_B64). Everything else is managed by /bridge slash commands (data/settings.json).
const fs = require('fs');
const path = require('path');
const { isSnowflake } = require('./util');

const ROOT = path.join(__dirname, '..');
const REQUIRED = ['DISCORD_BOT_TOKEN', 'WEBHOOK_URL', 'WEBHOOK_KEY', 'OWNER_ID'];
const SECRET_NAMES = ['DISCORD_BOT_TOKEN', 'WEBHOOK_KEY', 'WEBHOOK_URL'];

function parseEnv(text) {
  const out = {};
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const isPlaceholder = (v) => !v || /^(your[_-]|change[_-]?me|<|paste)/i.test(v.trim());

// Values: process.env first (Docker/compose/systemd), then the .env file (direct `node` runs).
function loadConfig({ env = process.env, envFile = env.ENV_FILE || path.join(process.cwd(), '.env') } = {}) {
  let fileVals = {};
  try { fileVals = parseEnv(fs.readFileSync(envFile, 'utf8')); } catch (_) { /* no file: env only */ }
  const get = (k) => {
    const e = env[k];
    const v = e !== undefined && e !== '' ? e : (fileVals[k] || '');
    return String(v).trim();
  };
  const val = (k) => (isPlaceholder(get(k)) ? '' : get(k));
  const cfg = {
    token: val('DISCORD_BOT_TOKEN'),
    webhookUrl: val('WEBHOOK_URL'),
    webhookKey: val('WEBHOOK_KEY'),
    ownerId: val('OWNER_ID'),
    dataDir: get('DATA_DIR') || path.join(ROOT, 'data'),
    settingsB64: get('SETTINGS_B64'),
    envFile,
  };
  cfg.missing = REQUIRED.filter((k) => !{ DISCORD_BOT_TOKEN: cfg.token, WEBHOOK_URL: cfg.webhookUrl, WEBHOOK_KEY: cfg.webhookKey, OWNER_ID: cfg.ownerId }[k]);
  cfg.problems = validate(cfg);
  return cfg;
}

// Actionable problems (never include secret values).
function validate(cfg) {
  const p = [];
  for (const k of cfg.missing || []) p.push(`${k} is not set. ${HELP[k]}`);
  if (cfg.ownerId && !isSnowflake(cfg.ownerId)) p.push('OWNER_ID must be a numeric Discord user id (15-25 digits). In Discord: Settings > Advanced > Developer Mode, then right-click your name > Copy User ID.');
  if (cfg.webhookUrl) {
    let u = null;
    try { u = new URL(cfg.webhookUrl); } catch (_) { /* invalid */ }
    if (!u || !/^https?:$/.test(u.protocol)) p.push('WEBHOOK_URL is not a valid http(s) URL. Copy it again from your Grok Bot routine\'s webhook trigger.');
    else if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) p.push('WEBHOOK_URL uses plain http:// for a non-local host. Use the https:// URL from your routine; the bearer key must not travel unencrypted.');
  }
  if (cfg.token && !/^[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{15,}$/.test(cfg.token)) p.push('DISCORD_BOT_TOKEN does not look like a bot token (three dot-separated parts). Use "Reset Token" on the Bot page of the Developer Portal and copy the whole value (not the client secret, not the public key).');
  return p;
}

const HELP = {
  DISCORD_BOT_TOKEN: 'Create your own bot in the Discord Developer Portal (Bot page > Reset Token). See AGENT-SETUP.md.',
  WEBHOOK_URL: 'Create a routine with a webhook trigger in Grok Bot and copy its URL.',
  WEBHOOK_KEY: 'Copy the key shown next to the routine\'s webhook URL.',
  OWNER_ID: 'Your own Discord user id (Developer Mode > right-click yourself > Copy User ID).',
};

module.exports = { ROOT, REQUIRED, SECRET_NAMES, parseEnv, loadConfig, validate, isPlaceholder };
