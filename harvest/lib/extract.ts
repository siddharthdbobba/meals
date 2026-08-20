/**
 * Getting facts out of a fetched page.
 *
 * Two paths, in order of preference. Most modern recipe sites publish
 * schema.org `Recipe` as JSON-LD, which is structured and free of prose;
 * `jsonLdRecipes` takes that. Forums and older blogs publish nothing, so
 * `pageText` falls back to the visible words and lets a later stage read them.
 *
 * `canonicalUrl` is the identity function for the whole pipeline: two URLs that
 * canonicalise the same are the same page, and the `seen` set is keyed on it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** `<script type="application/ld+json">` blocks, with any other attributes. */
const LD_JSON =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

type Json = Record<string, unknown>;

function isRecipe(node: unknown): node is Json {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const t = (node as Json)['@type'];
  return Array.isArray(t) ? t.includes('Recipe') : t === 'Recipe';
}

/** Depth-first so `@graph` members surface in document order. */
function collectRecipes(node: unknown, out: Json[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRecipes(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (isRecipe(node)) out.push(node as Json);
  for (const value of Object.values(node as Json)) {
    if (value && typeof value === 'object') collectRecipes(value, out);
  }
}

/**
 * Every schema.org Recipe on the page, in document order.
 *
 * A malformed block is skipped rather than thrown: one publisher's broken JSON
 * must not cost us the rest of the page, and at crawl scale broken JSON is
 * routine.
 */
export function jsonLdRecipes(html: string): Json[] {
  const found: Json[] = [];
  for (const match of html.matchAll(LD_JSON)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    collectRecipes(parsed, found);
  }
  return found;
}

/** The visible words of a page, with markup, scripts, and styles removed. */
export function pageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Tags become a space, never nothing, so `<li>a</li><li>b</li>` cannot
      // run two words together into one.
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parameters that identify a campaign or a click, never a page. */
const TRACKING = /^(utm_|fbclid$|gclid$|mc_(cid|eid)$|igshid$|_ga$|ref$|source$)/i;

/**
 * The canonical form of a URL: lowercase host, no fragment, no tracking
 * parameters, sorted query, no trailing slash outside the root.
 *
 * Anything unparseable is returned untouched, so a bad lead becomes one junk
 * entry rather than an exception in the middle of a crawl.
 */
export function canonicalUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
  const query = u.searchParams.toString();
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}

/** Separators sites use to append their own name to every page title. Each
 *  requires surrounding whitespace, so a hyphenated dish name survives. */
const TITLE_SUFFIX = /\s+[|•·»–—]\s+.*$|\s+-\s+.*$/;

/**
 * The page's own title, with the site's branding trimmed off.
 *
 * `<title>` first, `<h1>` as a fallback for the many forum and blog templates
 * that leave the title generic.
 */
export function pageTitle(html: string): string {
  const tag =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ??
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!tag) return '';
  const text = pageText(tag[1]);
  return text.replace(TITLE_SUFFIX, '').trim();
}
