#!/usr/bin/env bash
# One-shot resume of the harvest chain, paused 2026-08-23, scheduled for Wed
# 2026-08-26 09:00. Re-enters at layer 5 (recipe drafts) — layers 1-4 already
# completed and every stage is resumable, so nothing is redone.
# Self-disables after one run so the weekly launchd trigger doesn't repeat.
set -uo pipefail
ROOT=/Users/sbobba/projects/meals
LABEL=com.sid.meals-harvest-resume
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "[$(date)] resuming harvest at layer 5" >> "$ROOT/harvest/state/chain.log"

# disable the trigger FIRST, so a crash mid-run can't re-fire next Wednesday
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$PLIST"

exec bash "$ROOT/harvest/chain.sh" 5 >> "$ROOT/harvest/state/chain.log" 2>&1
