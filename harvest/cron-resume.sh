#!/usr/bin/env bash
# Restart the harvest chain if it is not already running.
#
# Every stage is resumable, so this is safe to fire repeatedly: the crawler
# skips URLs it has seen, the resolver skips pages it has answered, stage 3
# skips candidates it has drafted, and the gate skips drafts it has judged.
# A run that was killed mid-flight simply continues.
ROOT=/Users/sbobba/projects/meals
export PATH="/Users/sbobba/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if pgrep -f "harvest/chain.sh" >/dev/null 2>&1; then
  echo "[$(date)] chain already running, nothing to do" >> "$ROOT/harvest/state/cron.log"
  exit 0
fi

echo "[$(date)] chain not running, restarting from layer 1" >> "$ROOT/harvest/state/cron.log"
nohup bash "$ROOT/harvest/chain.sh" >> "$ROOT/harvest/state/chain-stdout.log" 2>&1 &
