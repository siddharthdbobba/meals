# Camp Meals — design

**Date:** 2026-08-19
**Status:** approved for implementation
**Routes:** `/meals`, `/meals/[slug]`

## Purpose

A browsable, filterable library of backpacking and camping recipes on
siddharthbobba.com. The value is not the recipes alone — it is being able to
ask the collection a precise question ("no-cook, vegetarian, over 125 cal/oz,
under 5 minutes") and get an answer in one screen. Every design decision below
serves that query loop.

Success criteria:

- A visitor can go from landing on `/meals` to a filtered set of 1–5 candidate
  meals in under 15 seconds, without a page reload.
- A filtered view is shareable as a URL.
- Adding a new recipe means adding one markdown file and nothing else.
- The page works with JavaScript disabled: all recipes render, filters are
  simply absent.

## Architecture

Three pieces, following patterns already in the repo (`trips`, `notes`):

1. **Content collection `meals`** — `src/content/meals/*.md`, one file per
   recipe. Frontmatter carries every filter facet plus the ingredient and step
   lists. Body is optional long-form prose (notes, variations, trail context).
2. **Index page `/meals`** — `src/pages/meals/index.astro`. Renders every
   non-draft recipe as a card at build time. Filtering is client-side over
   `data-*` attributes on those cards. No framework; a single inline
   `<script>`, consistent with the rest of the site.
3. **Detail page `/meals/[slug]`** — `src/pages/meals/[slug].astro`, a static
   `getStaticPaths` route rendering the full recipe.

No D1, no KV, no API routes. This is static content; the deploy story is
unchanged.

### Why client-side filtering

The collection is expected to reach at most a few hundred recipes. Rendering
all cards at build time and toggling `hidden` in the browser is faster than any
server round-trip, keeps the page fully static and cacheable at the edge, and
degrades gracefully. Server-side filtering would buy nothing at this scale and
would break the no-JS fallback.

## Data model

`src/content.config.ts` gains a `meals` collection. Facet values are closed
enums wherever a closed set is possible, so the filter UI can be generated from
the schema instead of being hand-maintained, and so typos fail the build.

```ts
const meals = defineCollection({
  loader: glob({ base: './src/content/meals', pattern: '*.md' }),
  schema: z.object({
    title: z.string(),
    blurb: z.string(),                    // one-line card description

    // --- facets ---
    tripStyle: z.array(z.enum([
      "car-camping", "backpacking", "thru-hike", "bikepacking",
      "basecamp", "day-hike", "winter", "paddle",
    ])).min(1),

    slot: z.array(z.enum([
      "breakfast", "lunch", "dinner", "snack", "dessert", "drink",
    ])).min(1),

    heatSource: z.array(z.enum([
      "no-cook", "cold-soak", "canister-stove", "alcohol-esbit",
      "liquid-fuel", "campfire", "grill-grate", "dutch-oven", "cooler-only",
    ])).min(1),

    prepMinutes: z.number().int().min(0),   // at home + at camp, before heat
    cookMinutes: z.number().int().min(0),   // active heat time

    caloriesPerServing: z.number().int().positive(),
    ouncesPerServing: z.number().positive(),
    proteinGrams: z.number().int().min(0),

    water: z.enum(["none", "cold", "boiled"]),
    waterMl: z.number().int().min(0).default(0),

    cleanup: z.enum(["in-bag", "one-pot", "foil-packet", "dishes"]),

    dietary: z.array(z.enum([
      "vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free",
    ])).default([]),

    homePrep: z.enum(["grab-and-go", "premix", "dehydrate"]),
    shelfLife: z.enum(["shelf-stable", "cooler", "day-one"]),
    servings: z.number().int().positive(),
    scalable: z.boolean().default(true),
    skill: z.enum(["dump-and-stir", "basic", "cooking"]),
    cost: z.enum(["$", "$$", "$$$"]),
    season: z.array(z.enum(["hot", "cold", "any"])).default(["any"]),

    // --- content ---
    ingredients: z.array(z.object({
      item: z.string(),
      amount: z.string(),
      note: z.string().optional(),
    })).min(1),
    steps: z.array(z.string()).min(1),
    packing: z.string().optional(),       // how it rides in the pack
    variations: z.array(z.string()).default([]),
    source: z.string().optional(),        // attribution / inspiration

    updated: z.coerce.date().optional(),
    draft: z.boolean().default(false),
  }),
});
```

### Derived fields

Computed at build time in the page, never stored in frontmatter (so they cannot
drift from their inputs):

- `caloriesPerOunce = caloriesPerServing / ouncesPerServing`, rounded to the
  nearest integer. Bucketed for filtering: `<100`, `100–125`, `>125`.
- `totalMinutes = prepMinutes + cookMinutes`. Bucketed: `<5`, `5–15`,
  `15–30`, `30+`.
- `servingsBucket`: `1` → solo, `2` → pair, `>=4` → group. A recipe with
  `scalable: true` also matches every bucket at or below its own size — a
  scalable 4-serving recipe answers a solo query, a fixed one does not.

### Facet vocabulary — single source of truth

`src/data/meals.ts` exports the ordered facet definitions: for each facet, its
key, human label, group ("Core" vs "More"), and its ordered options with human
labels. Both the schema enums and the filter UI read from this module, so the
label for `cold-soak` ("Cold soak") is written once. Adding a facet option
means editing one file.

## Page: `/meals`

Layout, top to bottom, inside `SiteShell` with `theme="mountain"` and a
`PageMasthead` matching `/trips` and `/notes`:

1. **Search + sort row.** A text input filtering on title, blurb, and
   ingredient names. A `<select>` sorting by cal/oz (desc, default), weight
   (asc), total time (asc), calories (desc), or title (A–Z).
2. **Core filter chips, always visible.** Trip style, meal slot, heat source —
   the three facets that answer most queries. Rendered as toggle buttons in
   three labelled rows.
3. **"More filters" disclosure.** A `<details>` panel holding the remaining
   thirteen facets: time, cal/oz, water, cleanup, dietary, home prep, shelf
   life, servings, skill, cost, season, protein, calories.
4. **Result count + clear.** "23 meals" live count, and a "Clear filters"
   button that appears only when a filter is active.
5. **Card grid.** Each card: title, blurb, a small stat strip (cal/oz, weight,
   total time), and facet pills for slot and heat source. Links to the detail
   page.
6. **Empty state.** When a filter combination matches nothing: a short line
   plus the clear-filters button.

### Filter semantics

- **Within one facet: OR.** Checking "breakfast" and "dinner" shows both.
- **Across facets: AND.** "breakfast" + "no-cook" shows only no-cook
  breakfasts.
- **Array-valued facets match on intersection.** A recipe tagged
  `tripStyle: [backpacking, thru-hike]` matches a "backpacking" filter.
- **No filters selected in a facet means that facet is inactive** — it does not
  exclude anything.

This is the behavior people already expect from faceted commerce search, so it
needs no explanation in the UI.

### URL state

Active filters serialize to the query string:
`?slot=breakfast,dinner&heat=no-cook&sort=cal-oz`. Written with
`history.replaceState` on every change (no history spam), read on load to
restore state. A URL with no query string is the unfiltered default. Unknown
keys and unknown values in the query string are ignored rather than erroring.

### Implementation of filtering

Each card carries its facet values as `data-*` attributes, arrays joined with
`|`, plus `data-search` holding a lowercased concatenation of title, blurb, and
ingredients, and numeric `data-cal-oz`, `data-weight`, `data-minutes`,
`data-calories` for sorting.

On any control change, one pass over the card list sets `hidden` per card and
updates the count; sorting reorders via `appendChild` on the already-filtered
set. At a few hundred cards this is well under a frame, so no debouncing is
needed beyond a short one on the search input's `input` event.

### No-JS behavior

The filter controls are inside a `<form>` that never submits, and the card grid
is fully populated in the HTML. Without JS, a visitor sees every recipe and
inert controls. The controls are wrapped in an element the script un-hides on
boot, so no-JS visitors do not see dead UI.

## Page: `/meals/[slug]`

Single column, prose width. Title, blurb, then a stat block (calories, weight,
cal/oz, protein, servings, total time, water needed, cost), then facet pills,
then ingredients as a table, steps as an ordered list, then optional packing
notes, variations, and source attribution. A "back to all meals" link that
preserves nothing — the index restores its own state from the URL when the
visitor uses the browser back button.

## Seed content

15–20 recipes at launch, chosen to spread across the facets so no filter
combination that a reasonable person would try comes back empty. Concretely,
coverage must include: at least three no-cook, at least two cold-soak, at least
three vegetarian and two vegan, at least two dutch-oven or campfire car-camping
meals, at least three breakfasts, two desserts, and two drinks.

Nutrition numbers are approximate by nature. Each recipe states its values as
authored estimates; the detail page carries one line noting that macros are
estimates for planning, not precise nutrition data.

## Testing

Vitest, in `tests/` (Node pool — no Workers bindings needed):

1. **Schema conformance.** Every file in `src/content/meals/` parses against
   the schema. Guards against typos in enum values.
2. **Derived math.** `caloriesPerOunce`, bucket assignment, and
   `totalMinutes` bucketing are pure functions in `src/lib/meals.ts` and get
   direct unit tests, including boundary values (exactly 100 and exactly 125
   cal/oz; exactly 5, 15, 30 minutes).
3. **Filter logic.** The predicate that decides whether a recipe matches a
   filter state is a pure function in `src/lib/meals.ts`, imported by both the
   test and the client script. Tests cover: OR within facet, AND across
   facets, array intersection, empty facet meaning inactive, scalable
   servings matching smaller buckets.
4. **URL serialization round-trip.** Encoding a filter state and decoding it
   returns the same state; unknown keys and values are dropped.
5. **Seed coverage.** A test asserting the coverage minimums listed under Seed
   content, so the collection cannot silently drift into a state where common
   filter combinations are empty.

Bucket boundaries are inclusive at the lower edge and exclusive at the upper
(`100–125` means `>=100 and <125`), asserted in the boundary tests.

## Out of scope

Deliberately excluded from this pass, listed so they are not silently dropped:

- User accounts, favorites, or saved meal plans.
- A trip-level meal planner that sums calories and weight across days.
- Photos per recipe. The schema can gain an optional cover later; the seed
  content ships without one rather than shipping placeholders.
- Shopping-list export.
- Search across recipe body prose (search covers title, blurb, ingredients).

## Files touched

New:

- `src/content/meals/*.md` — seed recipes
- `src/data/meals.ts` — facet vocabulary
- `src/lib/meals.ts` — derived math, bucketing, filter predicate, URL codec
- `src/pages/meals/index.astro`
- `src/pages/meals/[slug].astro`
- `src/styles/meals.css`
- `tests/meals.test.ts`

Modified:

- `src/content.config.ts` — register the `meals` collection
- Site navigation — add the `/meals` link alongside Trips and Notes
