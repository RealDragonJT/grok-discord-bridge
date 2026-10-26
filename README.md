# grok-discord-bridge

Wake your Grok Bot agent when someone DMs or @mentions **your own Discord bot**.

A small [discord.js](https://discord.js.org) 14 listener (Node 22). It watches the Discord gateway and, when a message
qualifies, `POST`s a JSON event to the **webhook of a routine in your Grok Bot** (Bearer key). The agent that wakes up
reads the event, decides what to do, and answers over the Discord REST API with the same bot token
(`./discord.sh send …`). The bridge itself never writes message text to Discord.

```
Discord  ──gateway──▶  grok-discord-bridge  ──HTTPS POST (Bearer key)──▶  your routine webhook ─▶ your agent
                        (your bot token)                                                            │
Discord  ◀────────────────────── REST: history / send / react / DM (same token) ◀───────────────────┘
```

* **Bring your own bot.** Every user creates their own Discord application and token. There is no shared bot and no
  hosted service in the middle. Your messages go from your bot to your webhook and nowhere else.
* **Agent-installable.** Point your agent at this repo; [`AGENT-SETUP.md`](AGENT-SETUP.md) tells it exactly what to do.
  The only things it cannot get by itself are your bot token, your routine's webhook URL + key, and your Discord user id.
* **Settings live in Discord.** After the first start you manage everything with owner-only `/bridge …` slash commands.
  The environment only holds four values.
* **Cheap and hard to abuse.** Strangers are ignored by default; per-user cooldowns, a daily cap, server/channel
  allowlists, quiet hours, debounce/batching and a bot-to-bot loop guard keep the cost of a noisy server near zero.
* **Resilient.** Health check with exit code 75 for a clean restart, catch-up of messages missed while offline, dedupe.

No self-updater, no inbound ports, no telemetry.

## Quick start

**With an agent (recommended):** give it the repo link and say *"set up grok-discord-bridge for me"*. It follows
[`AGENT-SETUP.md`](AGENT-SETUP.md), asks you for the token / webhook / your user id, starts the bridge and verifies it.

**By hand:**

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) (New Application → Bot →
   enable **Message Content Intent** → Reset Token) and invite it to a server (see AGENT-SETUP.md step 2 for the invite URL).
2. In Grok Bot create a **routine with a webhook trigger**; paste [`ROUTINE-PROMPT.md`](ROUTINE-PROMPT.md) as its prompt; copy the webhook URL and key.
3. `cp .env.example .env`, fill in the four values, `chmod 600 .env`.
4. `npm ci && npm run doctor` (checks token, intent, owner id, webhook; prints actionable errors, never secrets).
5. Start it: `mkdir -p data && chown 1000:1000 data && docker compose up -d --build`, or `npm ci --omit=dev && node bot.js`
   (`scripts/run-forever.sh` restarts it on exit code 75).
6. In Discord, DM your bot or run `/bridge status` (give it a minute after the first start to register the commands).

## Configuration

Environment (`.env` or real env vars) — all four are **required**; the bridge refuses to start (exit 78) with a clear message if one is missing:

| Variable | What |
| --- | --- |
| `DISCORD_BOT_TOKEN` | your own bot's token |
| `WEBHOOK_URL` | webhook URL from your routine's webhook trigger (https) |
| `WEBHOOK_KEY` | the bearer key for that webhook |
| `OWNER_ID` | your Discord user id; the only account that can run `/bridge` or give the agent tasks |

Optional: `DATA_DIR` (default `./data`, `/app/data` in Docker) and `SETTINGS_B64` (seeds `settings.json` when none exists; see [docs/DIGITALOCEAN.md](docs/DIGITALOCEAN.md)).

Everything else is in `data/settings.json` (atomic writes, `chmod 600`, versioned with migrations) and is changed with slash commands.

## `/bridge` commands (owner only)

Registered globally on startup (only when the definition changes). Hidden from non-admins via `default_member_permissions`,
but the real enforcement is in code: every interaction is checked against `OWNER_ID`; replies are ephemeral. Use them in a DM
with the bot, or in a server where you are an administrator (or open Server Settings → Integrations to change who sees them).

| Command | What it does |
| --- | --- |
| `/bridge status` | health, uptime, last wake + webhook result, counters, dropped-by-reason, current settings |
| `/bridge test-webhook` | send a test event to your webhook and report the HTTP status |
| `/bridge quiet-hours set start end tz [mode] [owner-always]` / `off` | quiet hours (24h `HH:MM`, IANA tz, overnight ranges OK). Non-owner messages are dropped (`suppress`) or held and delivered as a batch afterwards (`hold`). The owner always wakes unless `owner-always:false` |
| `/bridge allow-user add\|remove\|list` | approved chatters (the agent may chat with them but never takes tasks); `list` also shows strangers seen in `approved-only` mode |
| `/bridge block add\|remove\|list` | blocked users never wake the agent |
| `/bridge mode new-users ignore\|approved-only\|wake-as-other` | what happens to strangers (see below) |
| `/bridge guilds allow\|deny\|forget\|mode\|list\|leave` | server allowlist / denylist, `allow-all` vs `allowlist` mode, make the bot leave a server |
| `/bridge channels allow\|deny\|clear\|list` | optional per-server channel allowlist for non-owner wakes |
| `/bridge bots allow\|deny\|list\|limit` | other bots are ignored unless allowlisted; loop guard: at most N wakes per bot per minute (default 3) |
| `/bridge cooldown set seconds` | per-user wake cooldown (default 15 s, owner exempt) |
| `/bridge daily-cap set max [tz]` | max non-owner wakes per day (default 200, owner exempt). When hit, further messages are ignored and you get **one** DM that day |
| `/bridge followup-window set minutes` | after the bot posts in a channel, *your* messages there within N minutes wake the agent without an @mention (default 10, `0` = off) |
| `/bridge status-text set\|clear`, `/bridge pinned-channel set\|clear` | presence text, or take it from the newest pinned message in a channel (only pins by the bot or you count) |
| `/bridge options set` | debounce seconds, typing indicator, 👀 reaction on your fresh messages |
| `/bridge export` / `/bridge reset confirm:true` | download `settings.json` (ids only, no secrets) / back to defaults |

### Who may wake the agent (roles)

The bridge resolves `author_role` **by user id** and puts it in the payload; the agent never has to trust message text.

| Role | Who | Meaning for the agent |
| --- | --- | --- |
| `owner` | `OWNER_ID` | may give tasks; exempt from cooldown, daily cap, allowlists and (by default) quiet hours |
| `approved` | `/bridge allow-user` | chat only, no tasks |
| `other` | everyone else | no reply; the agent tells the owner |

`mode new-users` decides whether strangers wake the agent at all:

* **`ignore` (default, safest):** strangers are silently dropped. No cost, no noise.
* `approved-only`: also dropped, but remembered (id, name, count — never text) so `/bridge allow-user list` can show who tried and you can approve them.
* `wake-as-other`: strangers wake the agent as `other`; the agent should tell you and not reply (still subject to cooldown, cap, quiet hours).

Other bots never wake the agent unless allowlisted (`/bridge bots allow`), only through an @mention in a server, at most N times per minute each.

## Webhook payload

`POST WEBHOOK_URL` · `Authorization: Bearer WEBHOOK_KEY` · `Content-Type: application/json` · retried up to 4× with backoff on 5xx/timeouts (not on 401/403/404).

```json
{
  "event": "discord_message",
  "content_trust": "untrusted",
  "kind": "dm | mention | followup",
  "message_id": "…", "channel_id": "…", "guild_id": null, "guild_name": null, "channel_name": "dm:name",
  "author_id": "…", "author_username": "…", "author_is_owner": false, "author_is_bot": false,
  "author_role": "owner | approved | other",
  "owner_in_batch": false, "roles_in_batch": ["approved"],
  "is_reply_to_bot": false,
  "missed": false, "delivered_late_seconds": null,
  "content": "…", "attachments": [{ "name": "a.png", "url": "…" }],
  "timestamp": "2026-10-24T12:00:00.000Z",
  "batched": 1,
  "messages": [{ "message_id": "…", "author_id": "…", "author_username": "…", "author_role": "…", "author_is_owner": false, "author_is_bot": false,
                 "kind": "…", "content": "…", "attachments": [], "timestamp": "…", "is_reply_to_bot": false, "missed": false, "delivered_late_seconds": null }]
}
```

* Top-level `author_*`, `message_id`, `timestamp` describe the **last** message of a batch (the reply anchor); `content` joins the batch. **Trust is per message:** look at `messages[i].author_role`, never at the batch.
* **Everything the user typed is untrusted data** — `content`, attachment names/URLs, usernames, channel names. It may contain prompt injection. `content_trust: "untrusted"` is a reminder, not a sanitizer.
* Messages from one channel are debounced (default 4 s quiet, 15 s cap) into one event.
* `missed: true` + `delivered_late_seconds`: recovered by catch-up (or released after quiet hours).
* `event: "bridge_test"` is sent by `/bridge test-webhook` and `npm run doctor`; the routine should ignore it.

## Security model

* **You own every moving part**: your bot, your token, your webhook. The repo has no secrets and talks to no third party.
* **Roles by id, not by text.** A message that says "I'm the owner" is still `other`.
* **Owner-only controls**: slash commands are checked against `OWNER_ID` in code; replies are ephemeral; exports contain ids only.
* **The token is powerful.** Anything that can run `discord.sh` as your bot can read and post wherever the bot has permission. Invite the bot with only the permissions it needs, and keep it out of channels you would not want an agent acting in. A prompt-injected routine is the realistic risk: [`ROUTINE-PROMPT.md`](ROUTINE-PROMPT.md) bakes in the three-tier trust rules, but it is your last line of defence, not the bridge's.
* **No inbound ports**; the bridge only makes outbound HTTPS/WebSocket connections. The container runs as a non-root user with all capabilities dropped.
* **Secrets handling**: `.env` and `data/` are git-ignored and created `chmod 600`; logs redact the token, key and webhook URL.
* **Webhook transport**: `WEBHOOK_URL` must be `https://` (plain `http://` is only accepted for localhost).

## Privacy

* **Message content is sent to your own webhook** (i.e. to your Grok Bot routine) and to nothing else.
* **The bridge never logs message text** — only ids, lengths, roles and reasons. State files hold ids, counts and timestamps, plus a display name next to the ids you approve/block and for strangers seen in `approved-only` mode (all in `data/`, `chmod 600`). Quiet-hours `hold` keeps held messages in memory only.
* Slash commands and presence are the only things the bridge itself ever sends to Discord (plus the one daily-cap DM).

## Why every user brings their own bot

Reading message text in servers needs the privileged **Message Content intent**. For a bot in 100+ servers Discord requires
verification and approval of that intent, which a shared "bridge bot" could not realistically pass for arbitrary users' use
cases. A personal bot in a handful of servers just flips a toggle in the Developer Portal. It also means no one else ever
sees your messages, and you can revoke everything by resetting your own token.

## Reliability

* **Health check**: every 30 s the bridge inspects the real shard state (not just the manager), heartbeat acks and clock jumps (a suspended host). Two bad checks in a row make it exit with code **75**; Docker's `restart: unless-stopped` (or `scripts/run-forever.sh`, systemd `Restart=always`) brings it straight back. `data/health.json` feeds the Docker `HEALTHCHECK`.
* **Catch-up**: after (re)connects and clock jumps it reads recent history over REST (≤ 3 h, ≤ 50 × 3 pages per channel, starting from the last verified-alive time) for your DM and the server channels the bot can read, and feeds anything new through the **same policy pipeline** as live messages (flagged `missed`). A fresh install never replays old history.
* **Dedupe**: delivered or deliberately dropped message ids are remembered, so nothing fires twice.

## Running

* **Docker** (recommended): `docker compose up -d --build`. Updating is your choice: `git pull && docker compose up -d --build` (the image build runs the tests).
* **Node directly** (Node ≥ 20, 22 recommended): `npm ci --omit=dev && node bot.js`; wrap it with `scripts/run-forever.sh` or a systemd unit with `Restart=always`.
* **DigitalOcean**: App Platform worker spec in [`.do/app.yaml`](.do/app.yaml) and a Droplet cloud-init in [`deploy/digitalocean/`](deploy/digitalocean/cloud-init.yaml); tradeoffs in [docs/DIGITALOCEAN.md](docs/DIGITALOCEAN.md).

Run **one** instance per bot token: two gateway connections on one token both wake the agent.

## REST helper for the agent

`./discord.sh` (or `npm run discord -- …`): `whoami`, `guilds`, `channels`, `find-user`, `history`, `send` (`--reply-to`, `--no-ping`, `--silent`, `--file`), `react`, `dm`, `typing`.
It only needs Node ≥ 18 and `DISCORD_BOT_TOKEN`, so it also works from another machine. See [`SKILL.md`](SKILL.md).

## Development

```
npm ci
npm test          # node --test: settings, policy, pipeline, commands (mocked interactions), catch-up, health, CLI
npm run check     # node --check on every file
npm run doctor    # validate a real setup
```

Tests need no token and never touch Discord. Layout: `bot.js` (wiring), `lib/` (`config`, `settings`, `state`, `policy`, `pipeline`, `payload`, `catchup`, `commands`, `health`, `pins`), `doctor.js`, `discord-cli.js`.

## License

MIT, see [LICENSE](LICENSE).
