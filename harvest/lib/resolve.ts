/**
 * The borderline resolver: a cheap second opinion on pages the keyword scorer
 * will not judge.
 *
 * `classify()` decides most pages for free. What it cannot decide is the hiker
 * who writes "boil water, add the noodles, throw in cheese" — a real recipe
 * with no quantities, no headings, and no structured data. That page scores 2
 * and lands in `borderline`, and `borderline` is exactly where the forum posts
 * and personal blogs live.
 *
 * This module is the pure half: batching, prompt construction, and parsing.
 * The model call itself lives in `stage2b-resolve.ts`, so everything here is
 * testable without a subprocess.
 */

export type BorderlinePage = { url: string; title: string; text: string };

export type Resolved = {
  url: string;
  title: string;
  ingredients: string[];
  adaptable: boolean;
};

/** How much of a page the model sees. Enough to find a short recipe, capped so
 *  one long page cannot crowd out the rest of its batch. */
const EXCERPT_CHARS = 1_500;

export function batchPages<T>(pages: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size));
  return out;
}

/**
 * One prompt covering a whole batch.
 *
 * Pages are identified by position, never by URL: a model shown
 * `seriouseats.com` versus `some-guys-blog.blogspot.com` starts grading the
 * publisher instead of reading the page, and the obscure personal blogs are
 * the ones this stage exists to rescue.
 */
export function buildResolvePrompt(batch: BorderlinePage[]): string {
  const pages = batch
    .map((p, i) => `PAGE ${i + 1}\nTitle: ${p.title}\nText: ${p.text.slice(0, EXCERPT_CHARS)}`)
    .join('\n\n');

  return `You are triaging web pages for a backpacking and camping recipe library.

For each page below, decide whether it contains an ACTUAL COOKABLE RECIPE — something a person could follow to make food. A page that merely discusses food, reviews gear, or lists links to other recipes is not a recipe.

Many of these pages are forum posts and personal blogs where the recipe is written casually, with no ingredient list and no measurements ("boil water, throw in a packet of ramen and a handful of cheese"). Those ARE recipes. Judge whether food gets made, not whether it is formatted like a cookbook.

For each page reply with:
- "page": the page number
- "verdict": "recipe" if food gets made, otherwise "reject"
- "ingredients": the ingredients you can identify, as short plain names without amounts (e.g. "instant ramen", "cheddar cheese"). Required when the verdict is "recipe".
- "adaptable": true if this is ordinary home cooking that could be rewritten for trail cooking (shelf-stable, one pot, no fridge), false if it is already trail food or could never work outdoors.

Reply with ONLY a JSON array, one object per page, no prose and no code fence.

${pages}`;
}

/** The first JSON array in a reply, whether or not it is fenced or surrounded
 *  by chatter. */
function extractJsonArray(reply: string): unknown[] | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], reply].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate rather than losing the whole batch.
    }
  }
  return null;
}

/**
 * Map a reply back onto its batch, keeping only usable recipe verdicts.
 *
 * Everything is defensive: a batch is dozens of pages, and one malformed entry
 * must cost that entry rather than the batch.
 */
export function parseResolveResponse(reply: string, batch: BorderlinePage[]): Resolved[] {
  const rows = extractJsonArray(reply);
  if (!rows) return [];

  const out: Resolved[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;

    const index = Number(r.page) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;
    if (r.verdict !== 'recipe') continue;

    const ingredients = Array.isArray(r.ingredients)
      ? r.ingredients.map((x) => String(x).toLowerCase().trim()).filter(Boolean)
      : [];
    // A recipe we cannot fingerprint cannot be deduplicated or transformed.
    if (ingredients.length === 0) continue;

    out.push({
      url: batch[index].url,
      title: batch[index].title,
      ingredients,
      adaptable: r.adaptable === true,
    });
  }
  return out;
}
