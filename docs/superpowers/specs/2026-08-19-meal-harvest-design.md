# Meal harvest: design

Date: 2026-08-19
Status: approved, not yet implemented

## Goal

Grow `content/` from 21 recipes to 5,000+ by discovering, extracting, and
rewriting camp and trail food from across the open web, fully automated: no
human approves individual recipes before they publish.

The corpus stays trail-first. Recipes from outside the niche are admitted only
when they can be adapted to trail cooking, and they are rewritten into the trail
schema rather than filed as-is.

## The shape of the problem

Discovery is not the bottleneck and neither is writing. The bottlenecks, in
order:

1. **Facet correctness.** Every recipe needs thirty-odd typed fields, including
   three numbers (`caloriesPerServing`, `ouncesPerServing`, `proteinGrams`) that
   almost no source page states. `caloriesPerOunce` is a headline sort field, so
   wrong numbers are visible on the index page.
2. **Duplication.** Every trail blog on the internet has a ramen bomb. Without
   hard dedup, 5,000 files means roughly 800 distinct recipes and 4,200 restatements.
3. **Junk.** With no human gate, the QA stage is the only thing standing between
   the crawl and the published site.

Discovery is solved by scale of *sources*, not scale of agents: one forum thread
or blog recipe index yields hundreds of recipes from a deterministic crawl that
costs no tokens. Agents are spent on judgment (which sources are worth crawling,
how to rewrite a recipe), not on fetching.

## Architecture

Five stages. Each reads a queue and writes the next one. Every stage is
resumable, and no item is ever processed twice.

```
stage 0  discovery      ~120 subagents      -> harvest/state/leads.jsonl
stage 1  harvest        Node, no LLM        -> harvest/cache/, pages.jsonl
stage 2  filter + dedup mostly determinstic -> candidates.jsonl (clustered)
stage 3  transform      subagent per cluster-> drafts/
stage 4  nutrition      Node + USDA API     -> drafts/ (numbers filled)
stage 5  QA gate        rules + refuters    -> content/<letter>/ or quarantine/
```

### Stage 0 — Source discovery

Roughly 120 subagents, each assigned a disjoint cell of a three-axis grid so
that fan-out does not become fan-of-the-same-search.

- **Source type**: forums (WhiteBlaze, BackpackingLight, Trailspace,
  Bikepacking.com, Hammock Forums), subreddits (Ultralight, backpacking,
  camping, PacificCrestTrail, AppalachianTrail, dehydrating, bikepacking),
  thru-hiker trail journals, personal blogs, gear-brand blogs, scouting and
  outdoor-education programs, YouTube video descriptions, sailing and paddle
  provisioning, mountaineering expedition food, vanlife, dehydrator communities.
- **Region and language**: US, UK/AU/NZ, Canada, Nordic (*turmat*,
  *friluftsliv*), German, Japanese.
- **Lexicon**: trail vocabulary crossed with meal slot — cold soak, freezer-bag
  cooking, ramen bomb, hobo dinner, foil packet, dutch oven, resupply box,
  no-cook dinner, cowboy coffee.

Each agent returns leads, not recipes:

```json
{"url": "...", "domain": "...", "type": "forum|blog|subreddit|brand|video|journal",
 "why": "one line", "est_recipe_count": 40, "has_sitemap": true, "language": "en"}
```

Leads are deduplicated by domain before stage 1. A lead is a promise of volume;
`est_recipe_count` orders the crawl queue.

### Stage 1 — Deterministic harvest

Per accepted domain, in Node, with no model in the loop:

- Fetch and honor `robots.txt`. A disallowed path is not fetched.
- Walk `sitemap.xml` where present; otherwise crawl from the lead URL, bounded
  by depth and same-domain.
- Rate limit per domain, cache every response on disk (gitignored), and never
  refetch a cached URL.
- Extract schema.org `Recipe` JSON-LD where present; fall back to Readability
  text extraction.
- Reddit and forum software are read through their JSON endpoints rather than
  scraped as HTML.

Volume comes from this stage, and it costs no tokens.

### Stage 2 — Relevance filter and dedup

Relevance runs keyword scoring first and sends only borderline pages to a small
model. A general recipe is admitted only if it is plausibly adaptable to trail
cooking.

Dedup is the stage that decides whether 5,000 files means 5,000 recipes.
Candidates are clustered by SimHash over their normalized ingredient set,
combined with fuzzy title matching. Each cluster keeps its best-sourced member
as the representative; the rest survive only as material for that recipe's
`variations` list.

### Stage 3 — Transformation

One subagent per surviving cluster. The agent receives extracted *facts* —
ingredients, amounts, method, provenance — and writes a new recipe. It never
receives the instruction to rewrite a page, and it never sees the source page's
prose as something to preserve.

The prompt carries `data/meals.ts` in full, three exemplar files from `content/`,
the house voice rules, and, for non-trail sources, the adaptation instruction:
dehydrate this, swap that, collapse the cook time, cut the pans to one.

Output is complete frontmatter plus original body prose. Provenance goes in
`source`.

### Stage 4 — Nutrition

Deterministic, because these numbers are the site's most checkable claim.

- Parse each ingredient line into amount, unit, and item.
- Match the item against USDA FoodData Central; convert to grams.
- Sum kcal and protein across ingredients; divide by `servings`.
- `ouncesPerServing` is **dry packed weight**: water added at camp is excluded.
  Getting this wrong inflates cal/oz, which is a headline sort field.
- Unmatched ingredients fall back to a model estimate and are flagged.
- Reconcile: computed kcal against `4·protein + 4·carb + 9·fat`. More than 20%
  apart quarantines the recipe rather than publishing a number nobody checked.

### Stage 5 — QA gate

With no human approving individual recipes, this stage is the whole quality
story. A draft publishes only if it clears all five:

1. **Schema parse** against `mealFields`.
2. **Facet consistency rules**, deterministic and table-driven. Examples:
   `cold-soak` implies `water` is not `boiled`; `no-cook` implies
   `cookMinutes` is 0; `dutch-oven` is not a `thru-hike` heat source;
   `vegan` implies no dairy, egg, or honey among the ingredients;
   `shelfLife: cooler` is not compatible with `thru-hike`.
3. **Plausibility bounds**: calories per ounce between 40 and 190, protein at or
   under 60 g, servings within a sane range, total time non-zero unless
   `no-cook`.
4. **Two independent refuters**, each prompted to kill the recipe rather than
   approve it: is this real, is it safe, is it actually cookable on the heat
   source it claims? Food safety is explicit — raw meat held in a cooler,
   overstated shelf life, undercooked beans. A majority to refute rejects.
5. **Originality**: n-gram overlap against the source text above threshold sends
   the draft back for a rewrite rather than publishing it.

Passing drafts land in `content/<letter>/<slug>.md`. Failing drafts land in
`quarantine/` **with their reason**, so failure is inspectable rather than lost.

## Orchestration and resumability

Stages 3 through 5 run as a `Workflow` `pipeline()`, not `parallel()`: each
candidate flows through transform, nutrition, and QA independently, so a slow
recipe never holds up a fast one.

All state lives in `harvest/state/` as JSONL queues plus a `seen` set keyed by
canonical URL. A run appends; it never rewrites history. This makes the whole
pipeline restartable at any point, which is what lets it survive a usage limit.

A cron fires every few hours, drains as much of the queue as the limit allows,
and exits cleanly. The next firing resumes from the queue, and nothing is
recomputed.

## Changes to the existing repo

- `content/` shards to `content/<letter>/<slug>.md`. The Astro glob pattern
  widens to `**/*.md`.
- The test suite stops parsing every file on every local run: it samples
  locally, and the full parse moves to CI.
- The coverage tests invert. At 21 recipes the risk was an empty filter
  combination; at 5,000 the risk is junk, so the assertions become quality
  floors rather than presence checks.

## Legal and ethical posture

- Ingredient lists are facts and are used as such. Instructions and headnotes
  are expression: they are never copied, and the originality check in stage 5
  enforces that mechanically rather than on trust.
- `robots.txt` is honored, requests are rate limited, and responses are cached
  so no URL is fetched twice.
- Every recipe carries its provenance in `source`.

## Accepted risks

- **Cost.** Stage 3 is roughly 5,000 agent calls and is the bulk of the spend.
- **Voice.** The house voice that makes the current 21 recipes good will read
  thinner across 5,000, however well the transformation prompt is written. This
  is the acknowledged price of removing the human gate.
- **Build time.** 5,000 static pages lengthens the consuming site's build
  measurably.
