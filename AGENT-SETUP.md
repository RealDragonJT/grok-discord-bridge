# AGENT-SETUP.md — instructions for an AI agent

You are an AI agent (for example a Grok Bot agent) asked to install **grok-discord-bridge** for a human, from this repo.
Goal: the human's own Discord bot wakes a routine in *their* Grok Bot whenever someone DMs or @mentions it, and you can
answer on Discord afterwards. Follow the steps in order. Do as much as you can yourself; ask the human **only** for the
things listed in step 2. Never print, log, commit or echo a secret (token, webhook URL, webhook key).

Rules that apply throughout:

* **One instance per bot token.** If the human already runs a bot with this token somewhere, stop it first.
* Do not register slash commands yourself; the bridge registers `/bridge` globally on its first start.
* Do not "improve" `OWNER_ID`: it is the human's own Discord user id and nobody else's.
* Do not push this repo anywhere or open ports. The bridge only makes outbound connections.
* Never start installing paid infrastructure (see step 7) without the human's explicit approval of the cost.

## 1. Check prerequisites

```bash
node --version        # needs >= 20 (22 recommended); only required for the non-Docker route and for `npm run doctor`
docker --version && docker compose version     # preferred runtime
git --version
curl -sS -o /dev/null -w '%{http_code}\n' https://discord.com/api/v10/gateway   # expect 200: outbound HTTPS works
```

* Prefer **Docker** (`docker compose`). If Docker is missing but Node ≥ 20 exists, use Node directly (step 4b).
* If neither exists, ask the human where it should run (their server, a Droplet: step 7, …) before going on.
* Clone/obtain this repo into a directory the human wants to keep (e.g. `~/grok-discord-bridge`) and `cd` into it.
* Run `npm ci` once (also needed for `npm run doctor`).

## 2. Ask the human for exactly these things

Everything else you can compute. Collect secrets through your platform's private-input mechanism if it has one (a form
or secret prompt); otherwise tell the human to put them into `.env` themselves rather than pasting them into chat. Ask in one message:

### a) Their Discord bot token (they must create the bot; you cannot)

Give them these exact steps:

1. Open <https://discord.com/developers/applications> (sign in) → **New Application** → name it → **Create**.
2. Left menu → **Bot**. Under **Privileged Gateway Intents** turn on **Message Content Intent** (required). *Server Members* and *Presence* intents are **not** needed. Click **Save Changes**.
3. Still on **Bot**: click **Reset Token** → confirm → **copy the token** (shown once). Keep it secret. (Not the "client secret", not the "public key".)
4. Optional: on **Bot**, turn **Public Bot** off so only they can add this bot to servers.
5. They also need the **Application ID** (General Information → *Application ID*), or just give you the token and you can derive it: `GET /applications/@me` returns it (`npm run doctor` prints the invite URL for you).

**Invite URL** (compute it from the application id; the human opens it, picks a server they manage, authorizes):

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=68672
```

`68672` = View Channels + Send Messages + Read Message History + Add Reactions. Optional extras: **Attach Files**
(+32768 → `101440`) and **Pin Messages** (permission bit 51, `+2251799813685248`; all three extras together: `2251799813786688`).
The `applications.commands` scope is required for the `/bridge` commands. DMs need no permission, but the human must share a server with the bot
(the invite above takes care of that).

### b) The webhook URL and key from *their own* Grok Bot routine

They (or you, if your tools can create routines) create a **routine with a webhook trigger**:

1. In Grok Bot, create a new routine; as its prompt paste the contents of [`ROUTINE-PROMPT.md`](ROUTINE-PROMPT.md) (step 6), with the placeholders filled in.
2. Add a **webhook trigger** to the routine.
3. In the routine's panel copy the **webhook URL** and the **key** (shown with the trigger). These two values are what the bridge needs: `WEBHOOK_URL` and `WEBHOOK_KEY`. The key may only be shown once.

If you can create the routine yourself but cannot read the URL/key back, ask the human to copy them from the routine panel.

### c) Their Discord user id (`OWNER_ID`)

Discord → **User Settings → Advanced → Developer Mode: on**. Then right-click **their own name** (in a server's member list or a DM) → **Copy User ID**. It is a number of 17–19 digits. This account becomes the *owner*: the only one who can use `/bridge` commands and give the agent tasks.

## 3. Write `.env` (mode 600, without printing secrets)

```bash
umask 077
# Values come from variables you already hold in memory / the private form; do NOT `set -x`, do NOT echo them.
printf '%s\n' \
  "DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}" \
  "WEBHOOK_URL=${WEBHOOK_URL}" \
  "WEBHOOK_KEY=${WEBHOOK_KEY}" \
  "OWNER_ID=${OWNER_ID}" > .env
chmod 600 .env
unset DISCORD_BOT_TOKEN WEBHOOK_URL WEBHOOK_KEY OWNER_ID
ls -l .env      # confirm -rw-------
```

No quotes around values. If the human wrote `.env` themselves, just verify the file exists and is `chmod 600`.
`.env` and `data/` are git-ignored; never commit them.

## 4. Validate, then start

**First run the doctor** (it never prints secrets; it exits non-zero with an actionable `fix:` line per problem):

```bash
npm run doctor
```

It checks: Node version, the four values, `OWNER_ID` format and that the user exists, the token (`GET /users/@me`), that the
**Message Content intent** is enabled, the invite URL, that the data directory is writable, and that the **webhook**
accepts a harmless `bridge_test` event (this triggers the routine once; the routine prompt ignores that event).
Fix every `[FAIL]` and rerun until it ends with "All required checks passed". Use `npm run doctor -- --no-webhook` to skip the webhook POST.

### 4a. Docker (preferred)

```bash
mkdir -p data && chown 1000:1000 data       # the container runs as uid 1000 (may need sudo)
docker compose up -d --build                # the image build runs the test-suite
docker compose ps                           # State "Up", health becomes "healthy" within ~2 min
docker compose logs --tail 40               # expect: "clientReady: connected as …", "slash commands registered (/bridge)"
```

`restart: unless-stopped` brings it back after crashes, host reboots and the deliberate exit-75 health restarts.

### 4b. Node directly

```bash
npm ci --omit=dev
nohup scripts/run-forever.sh > bridge.log 2>&1 &     # or a systemd unit with Restart=always, or tmux
```

`scripts/run-forever.sh` restarts on exit code 75 (unhealthy gateway) and on crashes; it stops on a configuration error (exit 78).
Logs contain ids and lengths only, never message text.

## 5. Verify end to end

1. Ask the human to run **`/bridge status`** (in a DM with the bot, or in a server where they are admin). Commands appear within about a minute of the first successful start. It should show `healthy`, the gateway `READY`, and the settings.
2. Ask them to run **`/bridge test-webhook`**: it must report `HTTP 2xx`. (`401/403` = wrong key, `404` = wrong URL.)
3. Ask them to DM the bot "hello" (or @mention it in a server). The routine should run and you (the routine) should reply. `/bridge status` then shows the last wake time and counters.
4. If something fails: `npm run doctor`, then `docker compose logs --tail 100`. Common causes: Message Content intent off ("disallowed intents" in the log), token reset (rejected), bot not in a shared server (no DMs), routine disabled (404).

Defaults are conservative: strangers are **ignored**, other bots are ignored, 15 s per-user cooldown, 200 non-owner wakes/day.
Everything is changed by the owner with `/bridge …` slash commands (see README) — you never need to edit env for settings.

## 6. Create the routine prompt

If not already done in step 2b: create the routine and use [`ROUTINE-PROMPT.md`](ROUTINE-PROMPT.md) as its prompt (fill in the
bracketed placeholders: how the REST helper is invoked on the machine the routine runs on, and the human's preferences).
The helper is `./discord.sh <command>` (`history`, `send`, `react`, `dm`, `typing`, `channels`, `find-user`, `whoami`); see [`SKILL.md`](SKILL.md).
The routine needs `DISCORD_BOT_TOKEN` available to the helper (env var or a `.env` next to it) on whatever machine it executes shell commands.
Install [`SKILL.md`](SKILL.md) as an agent skill if your platform supports skills.

## 7. Optional: host it on DigitalOcean (paid; the human must approve the cost)

Only if the human wants an always-on host and has (or will create) a DigitalOcean account. **Do not create, resize or
delete anything until the human has confirmed the monthly cost in writing.** You need a DigitalOcean integration
(Grok Bot's DigitalOcean plugin, `doctl`, or the console); if the plugin is not installed, ask the human to install/connect it
or to do the clicks themselves. State plainly which tools you actually have.

Pick one (tradeoffs in [`docs/DIGITALOCEAN.md`](docs/DIGITALOCEAN.md)):

| | Droplet (recommended) | App Platform worker |
| --- | --- | --- |
| Spec | [`deploy/digitalocean/cloud-init.yaml`](deploy/digitalocean/cloud-init.yaml) | [`.do/app.yaml`](.do/app.yaml) |
| Persistence | `./data` on the Droplet disk: settings + catch-up state survive restarts and redeploys | ephemeral disk: **`/bridge` settings reset on redeploy/restart** unless re-seeded via `SETTINGS_B64`; fresh state skips catch-up replay |
| Approx. cost (verify on the pricing page) | `s-1vcpu-1gb` about $6/month ($4 512 MiB plan exists but may fail the image build) | `apps-s-1vcpu-0.5gb` worker about $5/month |
| You maintain | the OS (apt updates), Docker | nothing |

**Droplet route**

1. Ask the human to confirm: "A DigitalOcean Droplet (`s-1vcpu-1gb`, about $6/month, billed until deleted). OK?" and for a region + SSH key (optional).
2. The repo must be cloneable from the Droplet (public repo, or adapt the clone line with a read-only deploy token). Copy `deploy/digitalocean/cloud-init.yaml`, replace the git URL and fill the four `CHANGE_ME` values (or leave the secret ones and write `/opt/grok-discord-bridge/.env` yourself over SSH afterwards).
3. Create the Droplet with the file as **user data** (image `ubuntu-24-04-x64`; DigitalOcean's API has a `user_data` field, and `doctl compute droplet create … --user-data-file`). Whether the DigitalOcean plugin's create-Droplet tool exposes user data depends on its version: check its tool schema; if it does not, create the Droplet in the console/with `doctl` or paste the cloud-init into the console's "Startup scripts" box.
4. Wait ~3–5 minutes, then follow step 5 (verify). On the Droplet: `cd /opt/grok-discord-bridge && docker compose ps && docker compose logs --tail 50`.
5. Keep the secrets out of your own logs; user data cannot be edited later, and it is readable by root on the Droplet.

**App Platform route**

1. Ask the human to confirm the cost (worker, about $5/month) **and** that they accept the ephemeral-disk limitation.
2. The repo has to be reachable by App Platform. Edit `.do/app.yaml` (`github.repo`), create the app (`doctl apps create --spec .do/app.yaml` or the plugin's create-app tool), then set the four SECRET variables in the app's environment (they are encrypted on first submission). Optionally set `SETTINGS_B64` (`base64 -w0 settings.json` from `/bridge export`).
3. Check the deployment logs for `clientReady: connected as …`, then step 5.

Always give the human the cleanup instructions: how to delete the Droplet / app to stop billing.
