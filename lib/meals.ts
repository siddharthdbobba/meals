/**
 * Pure logic behind the camp meals library.
 *
 * Everything here is deliberately free of DOM and of Astro: the index page
 * imports it at build time to stamp facet values onto cards, the client script
 * imports it to decide what stays visible, and `tests/meals.test.ts` imports it
 * to check the maths. One implementation, three callers, no drift.
 */

import { FACET_KEYS, DEFAULT_SORT, SORTS } from "../data/meals";

/** The frontmatter fields this module reads. Kept structural rather than
 *  importing the collection type so the tests can build fixtures by hand. */
export type MealInput = {
  title: string;
  blurb: string;
  tripStyle: readonly string[];
  slot: readonly string[];
  heatSource: readonly string[];
  prepMinutes: number;
  cookMinutes: number;
  caloriesPerServing: number;
  ouncesPerServing: number;
  proteinGrams: number;
  water: string;
  waterMl?: number;
  cleanup: string;
  dietary: readonly string[];
  homePrep: string;
  shelfLife: string;
  servings: number;
  scalable: boolean;
  skill: string;
  cost: string;
  ingredients: readonly { item: string; amount: string; note?: string }[];
};

export type Derived = {
  caloriesPerOunce: number;
  totalMinutes: number;
  timeBucket: string;
  calOzBucket: string;
  calorieBucket: string;
  proteinBucket: string;
};

/** Facet key to the values a recipe carries for it. Multi-valued throughout,
 *  because matching is always "do these two sets intersect". */
export type FacetValues = Record<string, string[]>;

export type FilterState = Record<string, string[]>;

export type SortKey = (typeof SORTS)[number]["value"];

const SORT_KEYS: string[] = SORTS.map((s) => s.value);

/**
 * Bucket boundaries are inclusive at the lower edge and exclusive at the upper,
 * so a recipe at exactly 125 cal/oz lands in "125plus" and one at exactly 100
 * lands in "100-125". Stated here because boundary behaviour is the kind of
 * thing that gets silently flipped during a refactor.
 */
export function bucket(value: number, edges: number[], names: string[]): string {
  if (names.length !== edges.length + 1) {
    throw new Error("bucket() needs exactly one more name than edges");
  }
  for (let i = 0; i < edges.length; i += 1) {
    if (value < edges[i]) return names[i];
  }
  return names[names.length - 1];
}

export function derive(meal: MealInput): Derived {
  const caloriesPerOunce = Math.round(meal.caloriesPerServing / meal.ouncesPerServing);
  const totalMinutes = meal.prepMinutes + meal.cookMinutes;

  return {
    caloriesPerOunce,
    totalMinutes,
    timeBucket: bucket(totalMinutes, [5, 15, 30], ["lt5", "5-15", "15-30", "30plus"]),
    calOzBucket: bucket(caloriesPerOunce, [100, 125], ["lt100", "100-125", "125plus"]),
    calorieBucket: bucket(meal.caloriesPerServing, [400, 700], ["lt400", "400-700", "700plus"]),
    proteinBucket: bucket(meal.proteinGrams, [10, 20], ["lt10", "10-20", "20plus"]),
  };
}

/** Flatten a recipe into the facet values the filter matches against. */
export function facetsFor(meal: MealInput): FacetValues {
  const d = derive(meal);
  return {
    style: [...meal.tripStyle],
    slot: [...meal.slot],
    heat: [...meal.heatSource],
    time: [d.timeBucket],
    caloz: [d.calOzBucket],
    cal: [d.calorieBucket],
    protein: [d.proteinBucket],
    cleanup: [meal.cleanup],
    diet: [...meal.dietary],
    prep: [meal.homePrep],
    shelf: [meal.shelfLife],
    skill: [meal.skill],
    cost: [meal.cost],
  };
}

/** The lowercased haystack the search box runs against: title, blurb, and
 *  ingredient names. Recipe body prose is deliberately not searched, so a
 *  passing mention in a story cannot outrank an actual ingredient. */
export function searchText(meal: MealInput): string {
  return [meal.title, meal.blurb, ...meal.ingredients.map((i) => i.item)]
    .join(" ")
    .toLowerCase();
}

/**
 * OR within a facet, AND across facets. A facet with nothing selected is
 * inactive and excludes nothing.
 */
export function matches(facets: FacetValues, filter: FilterState): boolean {
  for (const key of Object.keys(filter)) {
    const wanted = filter[key];
    if (!wanted || wanted.length === 0) continue;
    const have = facets[key] ?? [];
    if (!wanted.some((v) => have.includes(v))) return false;
  }
  return true;
}

export function matchesSearch(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/**
 * Whether a facet is actually narrowing anything.
 *
 * The page opens with every option checked, so "all of them" and "none of
 * them" both mean no constraint: one is the starting state, the other is what
 * Clear all leaves behind. Only a strict, non-empty subset is a real filter,
 * which is what this reports and what the URL and the active-count badge use.
 */
export function isFacetActive(selected: string[] | undefined, all: string[]): boolean {
  const n = selected?.length ?? 0;
  return n > 0 && n < all.length;
}

export function activeFacetCount(
  filter: FilterState,
  allValues: Record<string, string[]>,
  keys: string[] = FACET_KEYS,
): number {
  return keys.filter((key) => isFacetActive(filter[key], allValues[key] ?? [])).length;
}

export function isFilterEmpty(
  filter: FilterState,
  allValues: Record<string, string[]>,
  query = "",
): boolean {
  if (query.trim()) return false;
  return activeFacetCount(filter, allValues) === 0;
}

/** Serialize filter state to a query string. Facets that are not narrowing
 *  anything are omitted, as is the default sort, so the opening view has a bare
 *  URL and a shared one carries only the choices that mattered. */
export function encodeFilters(
  filter: FilterState,
  sort: string,
  query = "",
  allValues: Record<string, string[]> = {},
): string {
  const params = new URLSearchParams();
  for (const key of FACET_KEYS) {
    const values = filter[key];
    if (isFacetActive(values, allValues[key] ?? [])) params.set(key, (values as string[]).join(","));
  }
  if (query.trim()) params.set("q", query.trim());
  if (sort && sort !== DEFAULT_SORT) params.set("sort", sort);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Read filter state back out of a query string. A facet the URL does not
 * mention falls back to every option selected, which is the page's opening
 * state. Unknown keys and unknown values are dropped rather than throwing,
 * because a hand-edited or stale shared URL should degrade to a sensible view
 * instead of an error.
 */
export function decodeFilters(
  search: string,
  validValues: Record<string, string[]>,
): { filter: FilterState; sort: string; query: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const filter: FilterState = {};
  for (const key of FACET_KEYS) {
    const allowed = validValues[key] ?? [];
    const raw = params.get(key);
    if (!raw) {
      filter[key] = [...allowed];
      continue;
    }
    const values = raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => allowed.includes(v));
    filter[key] = values.length > 0 ? values : [...allowed];
  }
  const sortParam = params.get("sort") ?? "";
  const sort = SORT_KEYS.includes(sortParam) ? sortParam : DEFAULT_SORT;
  return { filter, sort, query: params.get("q") ?? "" };
}

/** The numbers the sort control reads, stamped onto each card. */
export type SortMetrics = {
  calOz: number;
  weight: number;
  minutes: number;
  calories: number;
  title: string;
};

export function sortMetrics(meal: MealInput): SortMetrics {
  const d = derive(meal);
  return {
    calOz: d.caloriesPerOunce,
    weight: meal.ouncesPerServing,
    minutes: d.totalMinutes,
    calories: meal.caloriesPerServing,
    title: meal.title.toLowerCase(),
  };
}

export function compareBy(sort: string, a: SortMetrics, b: SortMetrics): number {
  switch (sort) {
    case "weight":
      return a.weight - b.weight || a.title.localeCompare(b.title);
    case "time":
      return a.minutes - b.minutes || a.title.localeCompare(b.title);
    case "calories":
      return b.calories - a.calories || a.title.localeCompare(b.title);
    case "title":
      return a.title.localeCompare(b.title);
    case "cal-oz":
    default:
      return b.calOz - a.calOz || a.title.localeCompare(b.title);
  }
}
