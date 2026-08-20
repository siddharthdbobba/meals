/**
 * Collapsing the same recipe published on forty different sites.
 *
 * This is the stage that decides whether a corpus of 5,000 files is 5,000
 * recipes or 800 recipes restated. Fingerprinting is on the *ingredient set*
 * rather than the prose, because prose is exactly what differs between two
 * write-ups of the same dish — and ingredients are facts, so comparing them
 * carries none of the copyright weight that comparing text would.
 */

import { createHash } from 'node:crypto';

export type Candidate = {
  id: string;
  url: string;
  title: string;
  text: string;
  ingredients: string[];
  jsonld?: unknown[];
};

export type Cluster = {
  representative: Candidate;
  duplicates: Candidate[];
  fingerprint: bigint;
};

/**
 * Words describing how an ingredient was cut or measured, not what it is.
 *
 * Deliberately excludes `instant`, `dried`, `dehydrated`, `freeze-dried`, and
 * `ground`: for trail cooking those name a different ingredient with different
 * weight, water needs, and cook time. Instant rice is not rice.
 */
const PREP =
  /\b(?:finely|roughly|thinly|coarsely|freshly|chopped|diced|sliced|minced|grated|shredded|crushed|fresh|large|small|medium|whole|halved|optional|packed|heaping|level|approximately|about|roughly)\b/gi;

/**
 * A leading amount and unit.
 *
 * Longest-first, and anchored with `\b`: without both, the `l` of litres
 * matches inside "2 lbs duck" and leaves the ingredient as "bs duck".
 */
const UNIT =
  /^\s*[\d¼½¾⅓⅔⅛]+(?:[\/.-]\d+)?\s*(?:tablespoons?|teaspoons?|tbsps?|tsps?|ounces?|pounds?|packages?|packets?|liters?|litres?|handfuls?|grams?|cloves?|slices?|scoops?|blocks?|cups?|cans?|bars?|lbs?|kg|ml|oz|g|l)?\b\s*(?:of\s+)?/i;

/**
 * An ingredient line reduced to the thing itself: no amount, no unit, no
 * parenthetical, no preparation, lowercase.
 */
export function normalizeIngredient(line: string): string {
  let s = line.toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');       // "(or gouda)"
  // A clause after the comma is dropped only when nothing but preparation is
  // left in it. Truncating unconditionally collapsed every oatmeal flavour
  // into one ingredient, which then merged unrelated recipes.
  const comma = s.indexOf(',');
  if (comma !== -1) {
    const tail = s.slice(comma + 1);
    const meaningful = tail.replace(PREP, ' ').replace(/[^a-z0-9 ]/g, ' ').trim();
    s = meaningful ? `${s.slice(0, comma)} ${tail}` : s.slice(0, comma);
  }
  s = s.replace(UNIT, ' ');                // leading "2 cups of"
  s = s.replace(/^\s*[\d¼½¾⅓⅔⅛]+(?:[\/.-]\d+)?\s*/, ' '); // a bare leading count
  s = s.replace(PREP, ' ');
  return s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A number and its unit, the marker that an ingredient phrase is starting. */
const QUANTITY_START =
  /\b\d+(?:[\/.-]\d+)?\s*(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|g|grams?|kg|ml|l|lbs?|pounds?|packets?|packages?|cans?|cloves?|slices?|scoops?|bars?|blocks?|handfuls?)\b/gi;

/** Where an ingredient list stops and the method begins. */
const SECTION_BREAK = /\b(?:instructions?|directions?|method|steps|preparation|notes?|nutrition)\b.*$/i;

/** Longer than this and the match is a paragraph, not an ingredient. */
const MAX_INGREDIENT_CHARS = 60;

/**
 * Words that cannot open an ingredient.
 *
 * Forum prose constantly puts a number beside ordinary writing — "I ate 2 cups
 * for breakfast" — and without this every such phrase enters the corpus as an
 * ingredient called "for breakfast".
 */
const NOT_AN_INGREDIENT =
  /^(?:for|and|to|or|of|a|an|the|plus|with|per|at|in|on|is|was|it|i|we|you|he|she|they|my|his|her|their|about|around|over|under|late|early|more|less|each|every|some|any|that|this|there|then|than|so|but|if|when|while|after|before|during|because|cal|cals|calorie|calories|day|days|night|nights|morning|evening|afternoon|breakfast|lunch|dinner|meal|meals|person|people|mile|miles|km|hour|hours|minute|minutes|year|years|time|times)\b/i;

/** An ingredient is a short noun phrase, not a sentence. */
const MAX_INGREDIENT_WORDS = 5;

/**
 * Split page text into candidate ingredient phrases.
 *
 * `pageText` collapses every run of whitespace, so a crawled page arrives as
 * one unbroken line and splitting on newlines finds nothing. Instead the text
 * is cut immediately before each quantity, which is where an ingredient phrase
 * actually begins, and each piece is truncated at the method heading.
 */
function ingredientPhrases(text: string): string[] {
  const marked = text.replace(QUANTITY_START, (m) => `\n${m}`);
  return marked
    .split('\n')
    .map((line) => line.replace(SECTION_BREAK, '').trim())
    .filter((line) => line.length > 0 && line.length <= MAX_INGREDIENT_CHARS);
}

type IngredientSource = { text: string; jsonld?: any[] };

/** The distinct ingredients of a page, structured data first. */
export function ingredientSet(page: IngredientSource): string[] {
  // The FIRST recipe only. A roundup page embeds one Recipe per dish, and
  // flattening them all produced a single fifty-ingredient candidate that
  // belonged to no actual recipe.
  const first = page.jsonld?.find((r: any) => Array.isArray(r?.recipeIngredient)) as any;
  const fromJsonLd: unknown[] = first?.recipeIngredient ?? [];

  const lines = fromJsonLd.length ? fromJsonLd.map(String) : ingredientPhrases(page.text);

  const out: string[] = [];
  for (const line of lines) {
    const n = normalizeIngredient(line);
    if (!n || out.includes(n)) continue;
    // Structured data is the publisher's own list, so it is taken as given.
    // Text scraped from prose has to earn its place.
    if (!fromJsonLd.length) {
      if (NOT_AN_INGREDIENT.test(n)) continue;
      if (n.split(' ').length > MAX_INGREDIENT_WORDS) continue;
    }
    out.push(n);
  }
  return out;
}

/** A stable 64-bit hash of one token. */
function tokenHash(token: string): bigint {
  const digest = createHash('sha1').update(token).digest();
  return digest.readBigUInt64BE(0);
}

/**
 * A 64-bit SimHash of a token set.
 *
 * Unlike a plain hash, similar inputs produce similar outputs, so "same recipe,
 * one ingredient swapped" lands a few bits away rather than somewhere unrelated.
 * Order-independent, because an ingredient list is a set.
 */
export function simhash(tokens: string[]): bigint {
  const weights = new Array<number>(64).fill(0);
  for (const token of new Set(tokens)) {
    const h = tokenHash(token);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n += 1;
  }
  return n;
}

/**
 * Ingredients almost every recipe carries.
 *
 * They inflate similarity without saying anything about what the dish is:
 * rice + oil + salt + garlic powder and ramen + oil + salt + garlic powder
 * score 0.6 on the raw sets while being two different dinners. Similarity is
 * therefore computed over what is left once these are removed.
 */
const STAPLES = new Set([
  'salt', 'pepper', 'black pepper', 'salt and pepper', 'water', 'oil', 'olive oil',
  'vegetable oil', 'cooking oil', 'butter', 'margarine', 'sugar', 'brown sugar',
  'garlic powder', 'onion powder', 'seasoning', 'spices', 'flour', 'all purpose flour',
]);

/** Fewer than this and there is nothing to match on, so the recipe stands
 *  alone rather than being dropped: hot chocolate and a peanut-butter tortilla
 *  are real trail meals and the schema allows a single ingredient. */
const MIN_TO_MATCH = 2;

/**
 * How much of two ingredient sets must overlap to call them one recipe.
 *
 * Jaccard rather than SimHash distance: a recipe has a handful of ingredients,
 * and at that size swapping one flips far more fingerprint bits than the
 * recipes actually differ. Comparing the sets directly is both cheaper and
 * honest about what "nearly the same" means. SimHash stays as the stored
 * fingerprint, useful as a blocking key once the corpus is large.
 */
const THRESHOLD = 0.7;

/**
 * How alike two recipes are, ignoring pantry staples.
 *
 * Falls back to the raw sets when one recipe is nothing but staples, so simple
 * drinks still match each other.
 */
export function similarity(a: string[], b: string[]): number {
  const strip = (xs: string[]) => xs.filter((x) => !STAPLES.has(x));
  const da = strip(a);
  const db = strip(b);
  return da.length && db.length ? jaccard(da, db) : jaccard(a, b);
}

/** Share of ingredients two recipes hold in common. */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  const union = A.size + B.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Structured data beats prose, and a fuller page beats a thin one. */
function betterOf(a: Candidate, b: Candidate): Candidate {
  const structured = (c: Candidate) => (c.jsonld?.length ? 1 : 0);
  if (structured(a) !== structured(b)) return structured(a) > structured(b) ? a : b;
  return a.text.length >= b.text.length ? a : b;
}

/**
 * Group candidates into one cluster per distinct recipe.
 *
 * Greedy single-pass against existing cluster fingerprints: at this scale the
 * quadratic worst case never materialises, because most recipes match nothing.
 */
export function cluster(candidates: Candidate[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const c of candidates) {
    const fp = simhash(c.ingredients);

    // Too thin to compare: keep it, but never match it to anything.
    if (c.ingredients.length < MIN_TO_MATCH) {
      clusters.push({ representative: c, duplicates: [], fingerprint: fp });
      continue;
    }

    // Complete linkage — the candidate must be similar to every member, not
    // just the representative. Matching the representative alone let A absorb
    // B and then B absorb C, drifting a cluster onto an unrelated recipe.
    const hit = clusters.find((k) =>
      [k.representative, ...k.duplicates].every(
        (m) => similarity(m.ingredients, c.ingredients) >= THRESHOLD,
      ),
    );
    if (!hit) {
      clusters.push({ representative: c, duplicates: [], fingerprint: fp });
      continue;
    }

    const winner = betterOf(hit.representative, c);
    const loser = winner === c ? hit.representative : c;
    hit.duplicates.push(loser);
    hit.representative = winner;
  }

  return clusters;
}
