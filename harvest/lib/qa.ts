/**
 * The quality gate.
 *
 * With no human approving individual recipes, this is the only thing standing
 * between the crawl and the published site, so it is deliberately hostile.
 * Three independent checks, cheapest first: facet contradictions and
 * arithmetic run here for free, and only what survives is worth a model's
 * time.
 *
 * The rules encode things a model gets wrong confidently — claiming a cold-soak
 * meal needs boiled water, calling something vegan over a block of cheddar,
 * asserting more protein calories than the meal contains.
 */

export type Recipe = {
  title: string;
  tripStyle: string[];
  slot: string[];
  heatSource: string[];
  prepMinutes: number;
  cookMinutes: number;
  caloriesPerServing: number;
  ouncesPerServing: number;
  proteinGrams: number;
  water: string;
  waterMl: number;
  shelfLife: string;
  dietary: string[];
  servings: number;
  ingredients: { item: string; amount: string; note?: string }[];
  body: string;
  [k: string]: unknown;
};

export type Refutation = { refuted: boolean; why: string };

const ANIMAL = {
  meat: /\b(beef|pork|chicken|turkey|bacon|sausage|salami|pepperoni|jerky|ham|lamb|venison|duck|meat|tuna|salmon|anchov|fish|shrimp|prawn|crab|sardine)\b/i,
  dairyEgg: /\b(cheese|cheddar|parmesan|mozzarella|butter|milk|cream|yogurt|yoghurt|ghee|egg|eggs|honey|whey|custard)\b/i,
};

const GLUTEN =
  /\b(wheat|flour|pasta|noodle|noodles|ramen|couscous|barley|rye|bulgur|semolina|bread|tortilla|cracker|orzo|farro|seitan|pretzel)\b/i;

const ingredientText = (r: Recipe): string =>
  r.ingredients.map((i) => `${i.item} ${i.note ?? ''}`).join(' ');

/** Contradictions between facets, and between a facet and the ingredients. */
export function facetViolations(r: Recipe): string[] {
  const v: string[] = [];
  const heat = new Set(r.heatSource);
  const items = ingredientText(r);

  if (heat.has('cold-soak') && r.water === 'boiled') {
    v.push('cold-soak recipe claims boiled water');
  }
  if (heat.has('no-cook') && r.cookMinutes > 0) {
    v.push('no-cook recipe claims cook time');
  }
  if (heat.has('no-cook') && r.water === 'boiled') {
    v.push('no-cook recipe claims boiled water');
  }
  if (r.water === 'none' && r.waterMl > 0) {
    v.push('water is "none" but waterMl is above zero');
  }
  if (r.water !== 'none' && r.waterMl <= 0) {
    v.push(`water is "${r.water}" but no volume is given`);
  }

  // Weight-bound trips cannot carry cast iron or a cooler.
  const onFoot = r.tripStyle.includes('thru-hike');
  if (onFoot && heat.has('dutch-oven')) {
    v.push('dutch oven on a thru-hike');
  }
  if (onFoot && r.shelfLife === 'cooler') {
    v.push('cooler-dependent food on a thru-hike');
  }

  const diet = new Set(r.dietary);
  if (diet.has('vegan') && (ANIMAL.meat.test(items) || ANIMAL.dairyEgg.test(items))) {
    v.push('claims vegan but the ingredients are not');
  }
  if (diet.has('vegetarian') && ANIMAL.meat.test(items)) {
    v.push('claims vegetarian but contains meat or fish');
  }
  if (diet.has('dairy-free') && ANIMAL.dairyEgg.test(items) && /\b(cheese|butter|milk|cream|yogurt|ghee|whey)\b/i.test(items)) {
    v.push('claims dairy-free but contains dairy');
  }
  if (diet.has('gluten-free') && GLUTEN.test(items)) {
    v.push('claims gluten free but contains gluten');
  }
  if (diet.has('nut-free') && /\b(peanut|almond|cashew|walnut|pecan|hazelnut|pistachio|nut butter)\b/i.test(items)) {
    v.push('claims nut free but contains nuts');
  }

  return v;
}

/** Physically or arithmetically impossible numbers. */
export function plausibilityViolations(r: Recipe): string[] {
  const v: string[] = [];

  const calPerOz = r.caloriesPerServing / r.ouncesPerServing;
  // Pure fat is roughly 250 cal/oz, so nothing beats that whatever the trip.
  if (calPerOz > 200) v.push(`impossible calorie density: ${Math.round(calPerOz)} cal/oz`);

  // The floor only applies to food actually carried dry. Corn on the cob is
  // genuinely 35 cal/oz because it is mostly water, and a car-camping recipe
  // built on fresh produce out of a cooler is not lying about its numbers.
  const carried =
    r.shelfLife === 'shelf-stable' &&
    r.tripStyle.some((t) => ['backpacking', 'thru-hike', 'bikepacking', 'day-hike'].includes(t));
  if (carried && calPerOz < 40) {
    v.push(`implausibly low calorie density for carried food: ${Math.round(calPerOz)} cal/oz`);
  }

  // Protein carries 4 kcal/g, so its calories cannot exceed the meal's.
  if (r.proteinGrams * 4 > r.caloriesPerServing) {
    v.push(`protein (${r.proteinGrams} g) implies more calories than the meal has`);
  }
  if (r.proteinGrams > 70) v.push(`implausible protein: ${r.proteinGrams} g`);

  if (r.prepMinutes + r.cookMinutes <= 0) v.push('recipe takes no time at all');
  if (r.servings < 1 || r.servings > 12) v.push(`implausible servings: ${r.servings}`);
  if (r.ingredients.length === 0) v.push('no ingredients');

  return v;
}

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * The share of the body's n-grams that also appear in the source.
 *
 * This is the originality check, and it is mechanical on purpose: the pipeline
 * promises that instructions and headnotes are rewritten rather than copied,
 * and a promise nothing measures is not a promise.
 */
export function ngramOverlap(body: string, source: string, n: number): number {
  const b = words(body);
  if (b.length < n) return 0;

  const sourceGrams = new Set<string>();
  const s = words(source);
  for (let i = 0; i + n <= s.length; i += 1) sourceGrams.add(s.slice(i, i + n).join(' '));

  let total = 0;
  let hits = 0;
  for (let i = 0; i + n <= b.length; i += 1) {
    total += 1;
    if (sourceGrams.has(b.slice(i, i + n).join(' '))) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

/** Above this share of shared 8-grams, the body is the source's writing. */
const MAX_OVERLAP = 0.18;

/** Words too common to prove anything by appearing. */
const WEAK = new Set([
  'salt', 'water', 'oil', 'sugar', 'pepper', 'powder', 'mix', 'dried', 'instant',
  'fresh', 'ground', 'whole', 'large', 'small', 'and', 'the', 'of', 'or',
]);

/**
 * The share of a recipe's ingredients that the source page actually mentions.
 *
 * A page about motocross results cannot be the source of a rice bowl. Without
 * this the pipeline will happily invent a recipe from any page that reached
 * stage 3 and stamp someone else's URL on it, which is worse than a bad
 * recipe: it is invented content attributed to a real publisher.
 */
export function sourceGrounding(
  ingredients: { item: string }[],
  sourceText: string,
): number {
  if (ingredients.length === 0) return 0;
  const hay = sourceText.toLowerCase();

  let checked = 0;
  let found = 0;
  for (const ing of ingredients) {
    // The head word carries the identity: "sharp cheddar cheese" is grounded by
    // "cheese". Weak words are skipped so salt and water cannot vouch for a
    // recipe on their own.
    const words = ing.item.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const meaningful = words.filter((w) => w.length > 2 && !WEAK.has(w));
    if (meaningful.length === 0) continue;
    checked += 1;
    if (meaningful.some((w) => hay.includes(w))) found += 1;
  }
  return checked === 0 ? 0 : found / checked;
}

/** Below this share of ingredients present in the source, the recipe was not
 *  drawn from that page. */
const MIN_GROUNDING = 0.4;

/** Function words that are everywhere in English prose and rare elsewhere. */
const ENGLISH_MARKERS =
  /\b(the|and|of|to|in|for|with|you|your|it|is|are|that|this|from|about|into|until|then|when)\b/gi;

/**
 * Whether grounding can say anything about this source at all.
 *
 * Grounding compares English ingredient names against the page, so it is
 * meaningless unless the page is in English. A script test is not enough:
 * Norwegian and Czech use the same alphabet, and judging meny.no's whipped
 * cream recipe against English words rejected a perfectly real recipe. The
 * language has to be detected, not the alphabet.
 */
function groundable(sourceText: string): boolean {
  const words = sourceText.split(/\s+/).filter(Boolean);
  if (words.length < 60) return false;
  const markers = (sourceText.match(ENGLISH_MARKERS) ?? []).length;
  // English prose runs well above this; other languages fall far below it.
  return markers / words.length > 0.08;
}

export type Verdict = { pass: boolean; reasons: string[] };

/**
 * The whole gate. Refuters are asked to kill the recipe, so a tie stands: a
 * recipe survives unless a majority says it should not.
 */
export function qaVerdict(r: Recipe, sourceText: string, refutations: Refutation[]): Verdict {
  const reasons = [...facetViolations(r), ...plausibilityViolations(r)];

  const overlap = ngramOverlap(r.body, sourceText, 8);
  if (overlap > MAX_OVERLAP) {
    reasons.push(`body is not original: ${Math.round(overlap * 100)}% shared 8-grams with the source`);
  }

  if (groundable(sourceText)) {
    const grounding = sourceGrounding(r.ingredients, sourceText);
    if (grounding < MIN_GROUNDING) {
      reasons.push(
        `not grounded in its source: only ${Math.round(grounding * 100)}% of ingredients appear on the page`,
      );
    }
  }

  const against = refutations.filter((x) => x.refuted);
  if (refutations.length > 0 && against.length > refutations.length / 2) {
    reasons.push(...against.map((x) => `refuted: ${x.why}`));
  }

  return { pass: reasons.length === 0, reasons };
}
