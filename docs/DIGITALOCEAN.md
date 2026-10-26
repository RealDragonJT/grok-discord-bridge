# Hosting on DigitalOcean

The bridge only needs a small always-on machine with outbound HTTPS: no domain, no inbound port, no database.
Two routes are provided. **Both cost money, billed until you delete them; nothing in this repo creates anything for you.**
An agent doing this for you must get your explicit approval of the cost first (AGENT-SETUP.md step 7).

| | Droplet (recommended) | App Platform worker |
| --- | --- | --- |
| Files | [`deploy/digitalocean/cloud-init.yaml`](../deploy/digitalocean/cloud-init.yaml) | [`.do/app.yaml`](../.do/app.yaml) |
| Approx. price* | `s-1vcpu-1gb` ≈ $6/month (the 512 MiB plan is ≈ $4/month) | `apps-s-1vcpu-0.5gb` ≈ $5/month |
| Settings made with `/bridge` | kept on the Droplet disk (`./data`) | **lost on every redeploy / container restart** unless re-seeded with `SETTINGS_B64` |
| Catch-up of missed messages | works across restarts | a fresh container has no state: it starts clean (no duplicates), but anything that arrived while it was down is **not** replayed |
| Updates / patching | yours: `apt upgrade`, `git pull && docker compose up -d --build` | managed by DigitalOcean; redeploy from the app |
| Inbound exposure | ufw denies all inbound except rate-limited SSH | none (worker has no port) |

\* Prices as listed on DigitalOcean's pricing pages when this was written (October 2026): Droplets are billed per second with a monthly cap; App Platform containers are billed per second. Check the current pricing before approving anything.

**Recommendation:** use the Droplet if you care that `/bridge` settings (approved users, quiet hours, allowlists…) and catch-up state survive;
use App Platform if you want zero server maintenance and are fine re-seeding settings after redeploys.

## App Platform worker (`.do/app.yaml`)

1. Edit `github.repo` to the repository App Platform should build (it must be reachable by DigitalOcean: public, or connected to your account).
2. `doctl apps create --spec .do/app.yaml` (or paste the spec into the console).
3. Fill the four `SECRET` variables (`DISCORD_BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_KEY`, `OWNER_ID`). DigitalOcean encrypts a `SECRET` value on first submission. Do not commit real values.
4. Keeping settings across redeploys: run `/bridge export`, then `base64 -w0 settings.json` and put the result into `SETTINGS_B64`. It is used **only** when no `settings.json` exists, which on App Platform means after every redeploy/restart. So whenever you change settings with `/bridge`, re-export and update `SETTINGS_B64` if you want them to survive.
5. The Dockerfile build runs the test-suite; a failing version never deploys.

## Droplet (`deploy/digitalocean/cloud-init.yaml`)

1. Replace the repo URL (`CHANGE_ME` in the `git clone` line) and the four `CHANGE_ME` values, or leave the four secrets and write `/opt/grok-discord-bridge/.env` over SSH after boot. Anything you put in user data is stored by DigitalOcean, readable by root on the Droplet, and cannot be changed afterwards.
2. Create an Ubuntu 24.04 Droplet (`ubuntu-24-04-x64`, `s-1vcpu-1gb`) with the file as user data (console: *Advanced Options → Add Initialization scripts*, `doctl compute droplet create … --user-data-file`, or the API `user_data` field).
3. The file installs Docker + compose, adds a 1 GiB swapfile, enables `ufw` (default deny incoming, SSH rate-limited), clones the repo to `/opt/grok-discord-bridge`, writes `.env` (mode 600), fixes `data/` ownership and runs `docker compose up -d --build`.
4. Check: `ssh root@<ip>`, then `cd /opt/grok-discord-bridge && docker compose ps && docker compose logs --tail 50 && docker compose exec bridge node doctor.js`.
5. To remove SSH exposure completely, delete the `ufw limit OpenSSH` line before creating the Droplet and use the DigitalOcean web console for access. A DigitalOcean Cloud Firewall is a free alternative layer.

## What was verified and what was not

Verified against DigitalOcean's public documentation / pricing pages (read in October 2026):

* App specs support `workers:` components, `dockerfile_path`, and `envs` with `type: SECRET` (value encrypted on first submission).
* The `apps-s-1vcpu-0.5gb` slug (1 shared vCPU, 512 MiB) is listed at $5/month; Basic Droplets are listed at $4/month (512 MiB) and $6/month (1 GiB).
* Droplet creation accepts `user_data` (cloud-init or a script, plain text, ≤ 64 KiB, not editable later); `doctl` has `--user-data-file`.
* DigitalOcean's open-source MCP server's `droplet-create` tool took a user-data argument in a pull request opened in August 2026; whether a given agent plugin version exposes it was **not** checked.

**Not verified (no DigitalOcean account was used, nothing was deployed or built, Docker was not run):**

* that the Grok Bot DigitalOcean plugin exposes app creation, environment-variable setting or Droplet user data. An agent must read the plugin's real tool list and fall back to `doctl`/console steps if something is missing;
* that App Platform accepts empty `SECRET` values in a spec (if not, create the app without them and add them in the console), and the `region: nyc` slug;
* how App Platform treats the bridge's deliberate exit code 75 (a restart is expected) and whether it honours the Dockerfile `HEALTHCHECK` (workers probably ignore it);
* the cloud-init file end to end (package names `docker.io` and `docker-compose-v2` on Ubuntu 24.04, the swapfile and ufw commands, the image build on 1 GiB);
* any price beyond the figures above (bandwidth, backups, taxes).
