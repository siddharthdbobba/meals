/**
 * Removing the parts of a page that belong to the site rather than the recipe.
 *
 * Every extracted page opens with the nav menu and closes with the footer,
 * which is pure cost: a model reads it once per recipe and learns nothing. The
 * trick is that boilerplate is, by definition, the text a domain repeats — so
 * it can be found by comparing pages against each other, with no model and no
 * per-site rules.
 */

/** Below this, a shared run is a coincidence of phrasing, not navigation. */
const MIN_SHARED_WORDS = 4;

/** How many pages must share a run for it to count as the site's furniture.
 *  Not all of them: one atypical template would otherwise hide the menu. */
const AGREEMENT = 0.75;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/**
 * The longest opening run of words that most of these pages share.
 *
 * `reversed` walks from the end instead, which is how `sharedSuffix` reuses
 * this without a second implementation.
 */
function sharedRun(texts: string[], reversed: boolean): string {
  // With one page there is nothing to compare against, and every word it has
  // would look equally "shared".
  if (texts.length < 2) return '';

  const lists = texts.map((t) => (reversed ? words(t).reverse() : words(t)));
  const needed = Math.max(2, Math.ceil(lists.length * AGREEMENT));
  // Bounded by the longest page, not the shortest: a single short outlier
  // must not truncate the menu that every other page agrees on.
  const longest = Math.max(...lists.map((l) => l.length));

  const run: string[] = [];
  for (let i = 0; i < longest; i += 1) {
    // The candidate is whichever word the most pages have at this position.
    // A page that has already ended simply votes for nothing.
    const counts = new Map<string, number>();
    for (const list of lists) {
      if (i >= list.length) continue;
      counts.set(list[i], (counts.get(list[i]) ?? 0) + 1);
    }
    if (counts.size === 0) break;
    const [word, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count < needed) break;
    run.push(word);
  }

  if (run.length < MIN_SHARED_WORDS) return '';
  return (reversed ? run.reverse() : run).join(' ');
}

export const sharedPrefix = (texts: string[]): string => sharedRun(texts, false);
export const sharedSuffix = (texts: string[]): string => sharedRun(texts, true);

/**
 * Strip a known prefix and suffix from one page.
 *
 * Refuses to empty the page: a listing page really can be nothing but
 * navigation, and an empty string downstream looks like a fetch failure rather
 * than what it is.
 */
export function stripBoilerplate(text: string, prefix: string, suffix: string): string {
  let out = text.trim();
  if (prefix && out.startsWith(prefix)) out = out.slice(prefix.length).trim();
  if (suffix && out.endsWith(suffix)) out = out.slice(0, out.length - suffix.length).trim();
  return out.length === 0 ? text.trim() : out;
}
