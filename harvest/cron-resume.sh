#!/usr/bin/env bash
#
# Restart the harvest chain on a 5h05m cadence starting at 03:45 local time.
#
# That interval does not divide into 24 hours, so it cannot be written as a
# crontab schedule — the firing times drift a little later every day
# (03:45, 08:50, 13:55, 19:00, 00:05, 05:10, ...). Instead crontab ticks this
# script every 5 minutes and the next due time is kept here, in a file.
#
# Firing repeatedly is safe: every stage is resumable, so the crawler skips
# URLs it has seen, the resolver skips pages it has answered, stage 3 skips
# candidates it has drafted, and the gate skips drafts it has judged. A run
# killed mid-flight continues rather than starting over.
ROOT=/Users/sbobba/projects/meals
STATE="$ROOT/harvest/state"
NEXT="$STATE/cron-next-run"
LOG="$STATE/cron.log"
INTERVAL=$((5 * 3600 + 5 * 60))   # 5h05m

export PATH="/Users/sbobba/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# cron does not export USER, and without it the claude CLI cannot find its
# credentials: it prints "Not logged in · Please run /login" and exits. Every
# stage that asks a model runs unauthenticated, which is how a cron-launched
# chain quietly discarded thousands of candidates it never sent anywhere.
export USER=sbobba
export LOGNAME=sbobba
export HOME=/Users/sbobba
mkdir -p "$STATE"

now=$(date +%s)

# First ever run: wait for the next 03:45 rather than firing immediately.
if [ ! -f "$NEXT" ]; then
  today=$(date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%Y-%m-%d) 03:45:00" +%s)
  [ "$today" -le "$now" ] && today=$((today + 86400))
  echo "$today" > "$NEXT"
  echo "[$(date)] seeded; first run at $(date -r "$today")" >> "$LOG"
  exit 0
fi

due=$(cat "$NEXT")
[ "$now" -lt "$due" ] && exit 0

# Due now. Book the next slot before doing any work, so a long run cannot
# stack up a backlog of missed firings behind it.
next=$((now + INTERVAL))
echo "$next" > "$NEXT"

if pgrep -f "harvest/chain.sh" >/dev/null 2>&1; then
  echo "[$(date)] due, but the chain is already running; next check $(date -r "$next")" >> "$LOG"
  exit 0
fi

echo "[$(date)] chain not running, restarting; next check $(date -r "$next")" >> "$LOG"
nohup bash "$ROOT/harvest/chain.sh" >> "$ROOT/harvest/state/chain-stdout.log" 2>&1 &
