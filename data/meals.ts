/**
 * The facet vocabulary for the camp meals library.
 *
 * This module is the single source of truth for every filterable dimension:
 * the schema in `src/content.config.ts` builds its enums from these tuples, the
 * filter UI on `/meals` builds its chips from these definitions, and
 * `src/lib/meals.ts` derives a recipe's facet values using the same keys. A
 * label like "Cold soak" is written once, here.
 *
 * Adding an option means adding it to the tuple. Adding a whole facet means
 * adding a tuple, a `FACETS` entry, and a line in `facetsFor()`.
 */

export const TRIP_STYLES = [
  "car-camping",
  "backpacking",
  "thru-hike",
  "bikepacking",
  "basecamp",
  "day-hike",
  "winter",
  "paddle",
] as const;

export const SLOTS = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "dessert",
  "drink",
] as const;

export const HEAT_SOURCES = [
  "no-cook",
  "cold-soak",
  "canister-stove",
  "alcohol-esbit",
  "liquid-fuel",
  "campfire",
  "grill-grate",
  "dutch-oven",
  "cooler-only",
] as const;

export const WATER = ["none", "cold", "boiled"] as const;
export const CLEANUP = ["in-bag", "one-pot", "foil-packet", "dishes"] as const;
export const DIETARY = [
  "vegetarian",
  "vegan",
  "gluten-free",
  "dairy-free",
  "nut-free",
] as const;
export const HOME_PREP = ["grab-and-go", "premix", "dehydrate"] as const;
export const SHELF_LIFE = ["shelf-stable", "cooler", "day-one"] as const;
export const SKILL = ["dump-and-stir", "basic", "cooking"] as const;
export const COST = ["$", "$$", "$$$"] as const;

/** Derived buckets. These never appear in frontmatter; `src/lib/meals.ts`
 *  computes them from the numeric fields so they cannot drift. */
export const TIME_BUCKETS = ["lt5", "5-15", "15-30", "30plus"] as const;
export const CAL_OZ_BUCKETS = ["lt100", "100-125", "125plus"] as const;
export const CALORIE_BUCKETS = ["lt400", "400-700", "700plus"] as const;
export const PROTEIN_BUCKETS = ["lt10", "10-20", "20plus"] as const;

export type Option = { value: string; label: string };

export type Facet = {
  /** Short key used in the query string and as the `data-` attribute suffix. */
  key: string;
  label: string;
  /** "core" facets sit above the fold as always-visible chips. "more" facets
   *  live behind the disclosure panel. */
  group: "core" | "more";
  /** A one-line explanation shown under the facet label in the more panel. */
  hint?: string;
  options: Option[];
};

const opts = (values: readonly string[], labels: Record<string, string>): Option[] =>
  values.map((value) => ({ value, label: labels[value] ?? value }));

export const FACETS: Facet[] = [
  {
    key: "style",
    label: "Trip style",
    group: "core",
    options: opts(TRIP_STYLES, {
      "car-camping": "Car camping",
      backpacking: "Backpacking",
      "thru-hike": "Thru-hike",
      bikepacking: "Bikepacking",
      basecamp: "Basecamp",
      "day-hike": "Day hike",
      winter: "Winter / snow",
      paddle: "Canoe / raft",
    }),
  },
  {
    key: "slot",
    label: "Time of day",
    group: "core",
    options: opts(SLOTS, {
      breakfast: "Breakfast",
      lunch: "Lunch",
      dinner: "Dinner",
      snack: "Snack",
      dessert: "Dessert",
      drink: "Drink",
    }),
  },
  {
    key: "heat",
    label: "What you cook on",
    group: "core",
    options: opts(HEAT_SOURCES, {
      "no-cook": "No cook",
      "cold-soak": "Cold soak",
      "canister-stove": "Canister stove",
      "alcohol-esbit": "Alcohol / Esbit",
      "liquid-fuel": "Liquid fuel",
      campfire: "Campfire coals",
      "grill-grate": "Grill grate",
      "dutch-oven": "Dutch oven",
      "cooler-only": "Cooler only",
    }),
  },
  {
    key: "time",
    label: "Total time",
    group: "more",
    hint: "Prep plus active cooking.",
    options: opts(TIME_BUCKETS, {
      lt5: "Under 5 min",
      "5-15": "5 to 15 min",
      "15-30": "15 to 30 min",
      "30plus": "30 min or more",
    }),
  },
  {
    key: "caloz",
    label: "Calories per ounce",
    group: "more",
    hint: "The number that matters when every ounce rides on your back. 125 and up is the efficient end.",
    options: opts(CAL_OZ_BUCKETS, {
      lt100: "Under 100",
      "100-125": "100 to 125",
      "125plus": "125 and up",
    }),
  },
  {
    key: "cal",
    label: "Calories per serving",
    group: "more",
    options: opts(CALORIE_BUCKETS, {
      lt400: "Under 400",
      "400-700": "400 to 700",
      "700plus": "700 and up",
    }),
  },
  {
    key: "protein",
    label: "Protein per serving",
    group: "more",
    options: opts(PROTEIN_BUCKETS, {
      lt10: "Under 10 g",
      "10-20": "10 to 20 g",
      "20plus": "20 g and up",
    }),
  },
  {
    key: "cleanup",
    label: "Cleanup",
    group: "more",
    options: opts(CLEANUP, {
      "in-bag": "Eat in the bag",
      "one-pot": "One pot",
      "foil-packet": "Foil packet",
      dishes: "Real dishes",
    }),
  },
  {
    key: "diet",
    label: "Dietary",
    group: "more",
    options: opts(DIETARY, {
      vegetarian: "Vegetarian",
      vegan: "Vegan",
      "gluten-free": "Gluten free",
      "dairy-free": "Dairy free",
      "nut-free": "Nut free",
    }),
  },
  {
    key: "prep",
    label: "Home prep",
    group: "more",
    options: opts(HOME_PREP, {
      "grab-and-go": "Grab and go",
      premix: "Pre-mix at home",
      dehydrate: "Dehydrate ahead",
    }),
  },
  {
    key: "shelf",
    label: "Keeps for",
    group: "more",
    options: opts(SHELF_LIFE, {
      "shelf-stable": "Shelf stable",
      cooler: "Needs a cooler",
      "day-one": "Day one only",
    }),
  },
  {
    key: "skill",
    label: "Effort",
    group: "more",
    options: opts(SKILL, {
      "dump-and-stir": "Dump and stir",
      basic: "Basic",
      cooking: "Actual cooking",
    }),
  },
  {
    key: "cost",
    label: "Cost per serving",
    group: "more",
    options: opts(COST, {
      $: "$",
      $$: "$$",
      $$$: "$$$",
    }),
  },
];

export const FACET_KEYS = FACETS.map((f) => f.key);

export const CORE_FACETS = FACETS.filter((f) => f.group === "core");
export const MORE_FACETS = FACETS.filter((f) => f.group === "more");

/** Look up the human label for a facet value, for rendering pills. */
export function facetLabel(key: string, value: string): string {
  const facet = FACETS.find((f) => f.key === key);
  return facet?.options.find((o) => o.value === value)?.label ?? value;
}

export const SORTS = [
  { value: "cal-oz", label: "Calories per ounce" },
  { value: "weight", label: "Lightest first" },
  { value: "time", label: "Fastest first" },
  { value: "calories", label: "Most calories" },
  { value: "title", label: "A to Z" },
] as const;

export const DEFAULT_SORT = "cal-oz";
