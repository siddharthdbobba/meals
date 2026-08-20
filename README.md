# meals

Backpacking and camping recipes, and everything that turns them into a
filterable library: the facet vocabulary, the filter logic, the frontmatter
schema, the page markup, and the stylesheet.

It is consumed by [siddharthbobba.com/meals](https://siddharthbobba.com/meals/),
which mounts this repo as a git submodule at `src/meals`. That site owns only
its two route files, which supply the page shell, the masthead photograph, and
the title and description. Everything else is here.

## Layout

```
content/            21 recipes, one markdown file each; frontmatter carries the facets
data/meals.ts       the facet vocabulary: keys, labels, options, sort options
lib/meals.ts        derived maths, the match predicate, the URL codec (pure functions)
schema.ts           the frontmatter field map, and where the site should glob for content
astro/              the index and recipe components, and the route path list
styles/meals.css    the whole look: filter panel, card grid, recipe page
tests/              boundary, filter-semantics, URL round-trip, and coverage tests
DESIGN.md           the design this was built from
```

`data/meals.ts` is the single source of truth for the facets, and `schema.ts`
for the frontmatter. `schema.ts` takes `z` as an argument rather than importing
one, so the site passes Astro's bundled zod and the tests pass plain zod: one
definition, no mirror to keep in sync.

## Wiring it into a site

```ts
// content.config.ts
import { mealFields, MEALS_GLOB_BASE } from './meals/schema.ts';

const meals = defineCollection({
  loader: glob({ base: MEALS_GLOB_BASE, pattern: '*.md' }),
  schema: z.object(mealFields(z)),
});
```

```astro
---
import MealsIndex from "../../meals/astro/MealsIndex.astro";
---
<YourLayout><MealsIndex /></YourLayout>
```

The recipe route imports `MealRecipe.astro` and re-exports `getMealPaths()` as
its `getStaticPaths`. The components bring their own CSS and expect a host that
defines the usual design tokens (`--paper`, `--ink`, `--panel`, `--rule`, the
zone ramp, and the font families).

## Adding a recipe

Copy an existing file in `content/`, change the frontmatter, run `npm test`.
The suite parses every file against the schema and rejects an unknown facet
value. It also enforces coverage minimums, so no common filter combination is
left with an empty result set.

## Filter semantics

OR within a facet, AND across facets, intersection for array-valued facets. A
facet with every option selected and a facet with none selected both mean "no
constraint": the first is the opening state, the second is what Clear all
leaves behind.

`water`, `servings`, and `scalable` stay in the frontmatter and appear on the
recipe page, but they are deliberately not filters.

## Commands

```bash
npm install
npm test
```
