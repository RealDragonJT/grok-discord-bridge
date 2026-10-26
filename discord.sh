#!/usr/bin/env bash
# REST helper for the agent. See SKILL.md. The bot token comes from DISCORD_BOT_TOKEN or a .env file; it is never printed.
exec node "$(dirname "$(readlink -f "$0")")/discord-cli.js" "$@"
