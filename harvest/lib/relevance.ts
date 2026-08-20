/**
 * Deciding whether a fetched page is a recipe, a listing of recipes, or noise.
 *
 * Cheap signals first, and a model only where the signals genuinely disagree.
 * At crawl scale this is the difference between classifying 50,000 pages for
 * free and paying for 50,000 model calls, so the bar for escalating to
 * `borderline` is deliberately high.
 */

export type Page = { title: string; text: string; jsonld?: unknown[] };

export type Signals = {
  quantities: number;
  verbs: number;
  hasIngredientsHeading: boolean;
  hasStepsHeading: boolean;
  listicle: boolean;
  navigation: number;
};

/** A number (including fractions and ranges) followed by a cooking unit. */
/**
 * A measured amount: a number with a unit, or a number of countable things.
 *
 * The countable half matters — "2 flour tortillas" and "3 eggs" are amounts,
 * and treating them as none made real recipes look like listing pages.
 */
const QUANTITY =
  /\b[\d¼½¾⅓⅔⅛]+(?:[\/.-]\d+)?\s*(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|g|grams?|kg|ml|l|liters?|litres?|lbs?|pounds?|packets?|packages?|cans?|cloves?|slices?|pinch(?:es)?|dash(?:es)?|scoops?|bars?|blocks?|handfuls?)\b|\b[\d¼½¾⅓⅔⅛]+\s+(?:\w+\s+){0,2}(?:tortillas?|eggs?|sticks?|pouch(?:es)?|bags?|strips?|fillets?|links?|sheets?|squares?|cubes?|bars?|blocks?|packets?)\b/gi;

const VERB =
  /\b(?:boil|simmer|stir|add|mix|pour|heat|cook|bake|whisk|fold|drain|soak|season|serve|combine|chop|dice|slice|sprinkle|cover|rehydrate|dehydrate|knead|toast|fry|saute|steep)\b/gi;

const INGREDIENTS_HEADING = /\bingredients?\b/i;
const STEPS_HEADING = /\b(?:instructions?|directions?|method|steps|preparation)\b/i;

/** Roundup titles: "50 Best…", "Top 20…", "The Best … Roundup", "… Ideas". */
/**
 * Roundup titles. The count must be followed by a plural collection noun
 * within a couple of words — "50 Best Backpacking Recipes" is a listing,
 * "3 Ingredient Easy Camp Pasta" is a recipe that happens to start with a
 * number.
 */
const LISTICLE =
  /(?:^\s*\d+\s+(?:\w+\s+){0,2}(?:meals|recipes|ideas|dinners|breakfasts|lunches|snacks|desserts)\b)|(?:\b(?:top|best)\s+\d+\b)|(?:\broundup\b)|(?:\bthe best\b.*\b(?:meals|recipes|ideas)\b)/i;

/**
 * Site furniture that survives boilerplate stripping.
 *
 * On a forum index or a site homepage the navigation IS the page, so the
 * shared-prefix stripper cannot remove it — there is nothing else left to
 * keep. Those pages carry cooking words ("recipes", "cook") and no quantities,
 * which is exactly the shape of a casual recipe, so without this signal they
 * flood the resolver queue and every one costs a model call.
 */
const NAVIGATION =
  /\b(?:welcome,? guest|new posts|search forums|sign in|log in|register|subscribe|newsletter|facebook|instagram|pinterest|tiktok|youtube|twitter|privacy policy|terms of (?:service|use)|all rights reserved|skip to (?:content|main)|main menu|shopping cart|my account|browse|categories|latest posts|board index)\b/gi;

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

export function recipeSignals(text: string): Signals {
  return {
    quantities: count(text, QUANTITY),
    verbs: count(text, VERB),
    hasIngredientsHeading: INGREDIENTS_HEADING.test(text),
    hasStepsHeading: STEPS_HEADING.test(text),
    listicle: false,
    navigation: count(text, NAVIGATION),
  };
}

/**
 * `recipe` is publishable material, `index` is a listing worth mining for
 * links but not for a recipe, `reject` is neither, and `borderline` is the
 * only verdict that costs a model call.
 */
export function classify(page: Page): 'recipe' | 'index' | 'reject' | 'borderline' {
  // Structured data is the publisher stating outright that this is a recipe.
  if (page.jsonld && page.jsonld.length > 0) return 'recipe';

  const s = recipeSignals(page.text);
  const listicle = LISTICLE.test(page.title);

  const score =
    s.quantities * 2 +
    s.verbs +
    (s.hasIngredientsHeading ? 3 : 0) +
    (s.hasStepsHeading ? 3 : 0);

  // A roundup often quotes one full recipe, so it can outscore a real recipe
  // page. The title is the more reliable signal of intent.
  if (listicle) return 'index';
  // Lots of site furniture and not one measured amount: a listing page, however
  // much cooking vocabulary it happens to carry. A real recipe with a footer is
  // unaffected, because it has quantities.
  if (s.quantities === 0 && s.navigation >= 3) return 'index';
  if (score >= 12) return 'recipe';
  // Any real cooking signal at all earns a second look rather than a guess.
  if (score >= 2) return 'borderline';
  return 'reject';
}
