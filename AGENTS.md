# AGENTS.md

Two situations bring an AI agent to this repo:

1. **You were asked to install / set up the bridge for a human** → read and follow [`AGENT-SETUP.md`](AGENT-SETUP.md). Do not skip its secret-handling rules.
2. **You were asked to change the code** → read [`README.md`](README.md) first, then:
   * Run `npm ci && npm test && npm run check` before and after changes. Tests are offline (no token, no Discord).
   * Settings are runtime data in `data/settings.json` managed by `/bridge` commands (`lib/commands.js`); env holds only `DISCORD_BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_KEY`, `OWNER_ID` (+ optional `DATA_DIR`, `SETTINGS_B64`). Do not add more env switches for things a slash command can own.
   * Any change to `settings.json` shape needs a version bump and a migration in `lib/settings.js` plus a test.
   * `lib/policy.js` decides who may wake the agent. Keep roles resolved by user id, keep the owner exempt from quotas, keep strangers/bots ignored by default.
   * Never log message text (ids and lengths only) and never print secrets. Add a test when you add a log line near message handling.
   * No self-updater, no inbound ports, no telemetry, no real tokens or personal identifiers in the repo, tests or docs.
   * The agent-facing prompt and skill ([`ROUTINE-PROMPT.md`](ROUTINE-PROMPT.md), [`SKILL.md`](SKILL.md)) must stay in sync with the payload built in `lib/payload.js`.

Using the bridge once it runs (replying on Discord from a routine): see [`SKILL.md`](SKILL.md).
