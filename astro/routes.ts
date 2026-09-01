/**
 * Route data for the consuming site. Kept here so the list of recipe pages and
 * the draft rule live with the recipes rather than with the site's routing.
 */
import { getCollection } from "astro:content";

/** One entry per published recipe, shaped for Astro's getStaticPaths. */
export async function getMealPaths() {
  const meals = await getCollection("meals");
  return meals
    .filter((m) => !m.data.draft)
    .map((meal) => ({ params: { slug: mealSlug(meal.id) }, props: { meal } }));
}

/**
 * The URL slug for a recipe id.
 *
 * Sharding is how the files are stored, not how they are addressed: the id is
 * `c/camp-chili-mac` and the page stays at /meals/camp-chili-mac/. Basenames
 * are unique across shards because the shard is derived from the basename,
 * so the gate's own collision check already guarantees it.
 */
export function mealSlug(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}
