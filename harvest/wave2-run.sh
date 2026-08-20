#!/usr/bin/env bash
# Wave 2 scouts.
#
# WebSearch is capped at 200 queries per session, which is what silenced 49 of
# wave 1's cells. So wave 2 runs as separate `claude -p` sessions: each gets its
# own budget, takes five cells, and spends about thirty searches. Jobs run eight
# at a time.
#
# Every scout writes its own leads file, so a killed job costs one cell and
# never corrupts a shared file. Re-running skips cells whose file already exists.
set -uo pipefail

ROOT=/Users/sbobba/projects/meals
STATE=$ROOT/harvest/state
LEADS=$STATE/leads
JOBS=$STATE/wave2-jobs
PAR=${PAR:-8}

mkdir -p "$LEADS" "$JOBS"

python3 - "$STATE/wave2-cells.json" "$JOBS" "$LEADS" <<'PY'
import json, sys, os, pathlib

cells = json.load(open(sys.argv[1]))
jobs_dir, leads_dir = sys.argv[2], sys.argv[3]

# Skip any cell already on disk so a re-run resumes instead of redoing.
todo = [c for c in cells if not os.path.exists(f"{leads_dir}/{c['id']}.jsonl")]

BATCH = 5
for n in range(0, len(todo), BATCH):
    batch = todo[n:n + BATCH]
    parts = [f"""You are a SOURCE SCOUT for a backpacking and camping recipe library.

You have {len(batch)} assigned cells. Work them ONE AT A TIME, in order. Spend about 6 WebSearch queries per cell and no more — your session's search budget is finite and shared across all {len(batch)} cells.

FIRST, read {leads_dir}/../domains-wave1.txt. Those 381 domains are already found. A lead on one of them is worthless — skip it and find something new. Finding obscure, small, personal sites is the entire point of this wave.

You are looking for WEBSITES AND THREADS that hold many recipes. You are NOT collecting recipes. Do not write or copy any recipe.

For each cell:
1. Run about 6 WebSearch queries inside that cell's slice. Use the cell's own language and native terms where given — searching in English for a Finnish cell defeats the purpose.
2. Optionally WebFetch one or two results to judge how many recipes a source holds.
3. Prefer an INDEX, CATEGORY, or THREAD url over a single recipe url.
4. Append one JSON line per lead to {leads_dir}/<CELL_ID>.jsonl using a Bash heredoc. Create the file even if empty-handed (`touch` it) so the cell is not retried.

Line format, exactly:
{{"url":"...","domain":"...","type":"forum|blog|subreddit|brand|video|journal|org","why":"one short line","est_recipe_count":40,"has_sitemap":true,"language":"en","cell":"<CELL_ID>"}}

Quality bar: a real, reachable page plausibly holding 5+ distinct recipes for camp, trail, or any cooking without a kitchen. No listicles that only link out, no gear reviews, no paywalled apps.

YOUR CELLS:
"""]
    for c in batch:
        parts.append(
            f"\n--- CELL {c['id']} ---\n"
            f"Source type: {c['sourceType']}\n"
            f"Region/language: {c['region']}\n"
            f"Topic: {c['lexicon']}\n"
            f"Write to: {leads_dir}/{c['id']}.jsonl\n"
        )
    parts.append("\nWhen every cell is done, reply with one line per cell: CELL_ID and the number of leads written. Nothing else.\n")

    job = f"{jobs_dir}/job-{n // BATCH:03d}.txt"
    pathlib.Path(job).write_text("".join(parts))

print(len(todo), "cells to run;", (len(todo) + BATCH - 1) // BATCH, "jobs")
PY

ls "$JOBS"/job-*.txt 2>/dev/null | sort > "$STATE/wave2-joblist.txt"
COUNT=$(wc -l < "$STATE/wave2-joblist.txt" | tr -d ' ')
echo "launching $COUNT jobs, $PAR at a time"

run_job() {
  job="$1"
  name=$(basename "$job" .txt)
  claude -p --permission-mode bypassPermissions "$(cat "$job")" \
    > "/Users/sbobba/projects/meals/harvest/state/wave2-jobs/$name.log" 2>&1
  echo "done $name"
}
export -f run_job

xargs -P "$PAR" -I{} bash -c 'run_job "$@"' _ {} < "$STATE/wave2-joblist.txt"

echo "wave 2 complete: $(ls "$LEADS"/*.jsonl | wc -l | tr -d ' ') lead files total"
