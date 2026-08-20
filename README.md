# meals

Backpacking and camping recipes, plus the vocabulary and logic that make them
filterable. Content and rules only: no site, no styling, no markup.

It is consumed by [siddharthbobba.com/meals](https://siddharthbobba.com/meals/),
which mounts this repo as a git submodule at `src/meals` and supplies the pages
and the CSS.

## Layout

```
content/       21 recipes, one markdown file each; frontmatter carries the facets
data/meals.ts  the facet vocabulary: keys, labels, options, sort options
lib/meals.ts   derived maths, the match predicate, the URL codec (pure functions)
tests/         boundary, filter-semantics, URL round-trip, and coverage tests
DESIGN.md      the design this was built from
```

`data/meals.ts` is the single source of truth for the facets. The consuming
site builds both its content schema and its filter UI from those tuples, so a
label is written once and a typo in a recipe fails the build.

## Adding a recipe

Copy an existing file in `content/`, change the frontmatter, run `npm test`.
The suite parses every file against the schema and will reject an unknown facet
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
