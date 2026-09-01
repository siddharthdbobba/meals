#!/usr/bin/env bash
#
# The harvest chain: five nested layers, each one waiting for its own work to
# finish and then spawning the next INSIDE itself.
#
#   layer 1  crawl        stage 1 shards, run to completion
#   layer 2  cluster      stage 2: strip, classify, dedup, queue borderline
#   layer 3  resolve      stage 2b: cheap model judges the borderline queue
#   layer 4  recluster    stage 2 again, promoting what the resolver recovered
#   layer 5  transform    stage 3: write recipe DRAFTS
#   layer 6  gate         stage 5: rules, refuters, publish or reject
#
# Each layer is a child process of the one above it, so `pstree` shows the
# whole pipeline as one nested stack. Every stage is independently resumable,
# so a layer that dies can be restarted without losing anything: the crawler
# skips seen URLs, the resolver skips answered pages, and stage 3 skips
# candidates it has already written.
#
# Usage:
#   bash harvest/chain.sh          # start at layer 1
#   bash harvest/chain.sh 3        # start at layer 3
set -uo pipefail

ROOT=/Users/sbobba/projects/meals
STATE="$ROOT/harvest/state"
LOG="$STATE/chain.log"
NODE=(node --experimental-strip-types)
LAYER="${1:-1}"

mkdir -p "$STATE"

say() { echo "[$(date '+%H:%M:%S')] layer $LAYER: $*" | tee -a "$LOG"; }

# Spawn the next layer as a child of this shell, then wait on it. The nesting
# is the point: the parent does not exit until everything below it is done.
descend() {
  local next=$((LAYER + 1))
  if [ "$next" -gt 6 ]; then
    say "chain complete"
    return 0
  fi
  say "descending to layer $next"
  bash "$ROOT/harvest/chain.sh" "$next"
}

case "$LAYER" in
  1)
    say "waiting for any running scouts to finish"
    while pgrep -f "wave2-run.sh" >/dev/null 2>&1; do sleep 30; done
    say "scouts done"

    # Never start a second set of shards on top of a running one: two processes
    # appending 12 KB records to the same pages file would interleave into
    # corrupt lines, and they would fight over the same seen-set.
    if pgrep -f "stage1.ts" >/dev/null 2>&1; then
      say "crawl already running; waiting for it rather than starting a second"
      while pgrep -f "stage1.ts" >/dev/null 2>&1; do sleep 30; done
    else
      say "starting the crawl across all lead domains"
      for i in 0 1 2 3 4 5; do
        "${NODE[@]}" "$ROOT/harvest/stage1.ts" --budget 6000 --shard "$i" --of 6 \
          >> "$STATE/stage1-shard$i.log" 2>&1 &
      done
      wait
    fi
    say "crawl finished: $(cat "$STATE"/pages-*.jsonl 2>/dev/null | wc -l | tr -d ' ') pages"
    descend
    ;;

  2)
    say "clustering"
    "${NODE[@]}" "$ROOT/harvest/stage2.ts" 2>&1 | tee -a "$LOG"
    descend
    ;;

  3)
    say "resolving the borderline queue"
    "${NODE[@]}" "$ROOT/harvest/stage2b-resolve.ts" --batch 20 --parallel 6 2>&1 | tee -a "$LOG"
    descend
    ;;

  4)
    say "reclustering with what the resolver recovered"
    "${NODE[@]}" "$ROOT/harvest/stage2.ts" 2>&1 | tee -a "$LOG"
    descend
    ;;

  5)
    say "writing recipe drafts"
    # Haiku, measured against the alternatives on twenty pages: $0.09 a page
    # against $0.27, valid frontmatter 20/20 against 14/20, and 18/20 through
    # the gate's rules against 11/20. The larger models wander outside "reply
    # with ONLY a JSON object"; this one obeys it.
    "${NODE[@]}" "$ROOT/harvest/stage3.ts" --parallel 10 --model claude-haiku-4-5 2>&1 | tee -a "$LOG"
    descend
    ;;

  6)
    say "quality gate"
    "${NODE[@]}" "$ROOT/harvest/stage5-qa.ts" --parallel 8 2>&1 | tee -a "$LOG"
    say "$(find "$ROOT/content" -name '*.md' | wc -l | tr -d ' ') recipes in content/"
    descend
    ;;

  *)
    echo "unknown layer: $LAYER" >&2
    exit 1
    ;;
esac
