/**
 * The recipe frontmatter schema, as a field map rather than a built schema.
 *
 * It takes `z` as an argument instead of importing one, so the same definition
 * serves the consuming site (which passes Astro's bundled `astro/zod`) and this
 * repo's own tests (which pass plain `zod` and never boot Astro). One
 * definition, no mirror to keep in sync.
 *
 * Facet values draw their allowed set from `data/meals.ts`, so a typo in a
 * recipe fails the build instead of quietly dropping it out of a filter.
 *
 * Derived numbers (calories per ounce, total time, buckets) are deliberately
 * absent: `lib/meals.ts` computes them so they cannot drift from their inputs.
 * `water`, `servings`, and `scalable` are here and shown on the recipe page,
 * but they are deliberately not filters.
 */
import {
  TRIP_STYLES, SLOTS, HEAT_SOURCES, WATER, CLEANUP, DIETARY,
  HOME_PREP, SHELF_LIFE, SKILL, COST,
} from "./data/meals";

/** `z` is typed loosely because the two callers supply different copies of
 *  zod; the shape they produce is identical. */
export function mealFields(z: any) {
  return {
    title: z.string(),
    blurb: z.string(),

    tripStyle: z.array(z.enum(TRIP_STYLES)).min(1),
    slot: z.array(z.enum(SLOTS)).min(1),
    heatSource: z.array(z.enum(HEAT_SOURCES)).min(1),

    prepMinutes: z.number().int().min(0),
    cookMinutes: z.number().int().min(0),

    caloriesPerServing: z.number().int().positive(),
    ouncesPerServing: z.number().positive(),
    proteinGrams: z.number().int().min(0),

    water: z.enum(WATER),
    waterMl: z.number().int().min(0).default(0),

    cleanup: z.enum(CLEANUP),
    dietary: z.array(z.enum(DIETARY)).default([]),
    homePrep: z.enum(HOME_PREP),
    shelfLife: z.enum(SHELF_LIFE),
    servings: z.number().int().positive(),
    scalable: z.boolean().default(true),
    skill: z.enum(SKILL),
    cost: z.enum(COST),

    ingredients: z.array(z.object({
      item: z.string(),
      amount: z.string(),
      note: z.string().optional(),
    })).min(1),
    steps: z.array(z.string()).min(1),
    packing: z.string().optional(),
    variations: z.array(z.string()).default([]),
    source: z.string().optional(),

    updated: z.coerce.date().optional(),
    draft: z.boolean().default(false),
  };
}

/** Where the recipe markdown lives, relative to the consuming site's root. */
export const MEALS_GLOB_BASE = "./src/meals/content";
