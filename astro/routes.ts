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
    .map((meal) => ({ params: { slug: meal.id }, props: { meal } }));
}
