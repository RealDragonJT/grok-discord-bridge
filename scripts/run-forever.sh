#!/usr/bin/env bash
# Minimal supervisor for running the bridge with plain `node` (no Docker, no systemd).
# Restarts immediately on exit code 75 (gateway unhealthy), with a short backoff on other failures,
# and stops on a clean exit (0) or a config error (78). Run it from the project directory.
set -u
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
delay=5
while true; do
  node bot.js
  code=$?
  case "$code" in
    0) echo "bridge exited cleanly"; exit 0 ;;
    78) echo "configuration error (see above); not restarting"; exit 78 ;;
    75) echo "gateway unhealthy; restarting now"; delay=5; continue ;;
  esac
  echo "bridge exited with code $code; restarting in ${delay}s"
  sleep "$delay"
  delay=$(( delay < 60 ? delay * 2 : 60 ))
done
