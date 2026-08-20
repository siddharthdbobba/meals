/**
 * Turning a pile of scout leads into a crawl plan, and deciding which of a
 * site's URLs are worth fetching at all.
 *
 * This is the cheapest filter in the pipeline and therefore the most valuable
 * one: every URL rejected here is a fetch we never make and a page a model
 * never reads. It is deliberately shape-based — path vocabulary only, no
 * content — because it runs before anything is downloaded.
 */

export type Lead = {
  domain: string;
  url: string;
  est_recipe_count?: number;
  type?: string;
};

export type Target = {
  domain: string;
  seeds: string[];
  estimate: number;
  cap: number;
};

/** Words that suggest a page holds food, in a path segment. */
const FOOD = /(recipe|meal|food|cook|dinner|breakfast|lunch|supper|snack|dessert|menu|kitchen|eat|dish|bake|stew|chili|ramen|soup|coffee|dehydrat|freezer.?bag|cold.?soak|provision|galley|rations?)/i;

/**
 * Listing pages, archives, and paginated indexes. They match `FOOD` constantly
 * and contain no recipe of their own, so they are the dominant source of
 * wasted fetches on a blog.
 */
const FURNITURE =
  /\/(tag|tags|category|categories|author|page|search|feed|rss|comments?|wp-json|wp-admin|login|signup|cart|checkout|privacy|terms|about|contact)(\/|$)/i;

/** Anything that is a file rather than an article. */
const ASSET = /\.(jpe?g|png|gif|webp|svg|pdf|zip|mp[34]|mov|css|js|xml|json|ico)$/i;

export function looksLikeRecipeUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (path === '/' || path === '') return false;
  if (ASSET.test(path)) return false;
  if (FURNITURE.test(path)) return false;
  return FOOD.test(path);
}

/** Same host, treating `www.` as the same site and any other subdomain as not. */
export function sameSite(a: string, b: string): boolean {
  const host = (u: string) => {
    try {
      return new URL(u).host.replace(/^www\./i, '').toLowerCase();
    } catch {
      return null;
    }
  };
  const ha = host(a);
  return ha !== null && ha === host(b);
}

/**
 * Group leads into one crawl target per domain, richest first.
 *
 * The per-domain cap matters more than it looks: a single large recipe site
 * could otherwise supply most of the corpus, and a library where two thousand
 * recipes come from one blog is that blog with extra steps.
 */
export function planDomains(leads: Lead[], opts: { perDomainCap?: number } = {}): Target[] {
  const cap = opts.perDomainCap ?? 300;
  const byDomain = new Map<string, { seeds: Set<string>; estimate: number }>();

  for (const lead of leads) {
    let normalized: string;
    try {
      normalized = new URL(lead.url).toString();
    } catch {
      continue;
    }
    // Canonicalise here so `?utm_source=` cannot enter the plan as a second seed.
    const seed = canonicalSeed(normalized);
    const key = lead.domain.replace(/^www\./i, '').toLowerCase();
    const entry = byDomain.get(key) ?? { seeds: new Set<string>(), estimate: 0 };
    entry.seeds.add(seed);
    entry.estimate += lead.est_recipe_count ?? 0;
    byDomain.set(key, entry);
  }

  return [...byDomain.entries()]
    .map(([domain, e]) => ({ domain, seeds: [...e.seeds], estimate: e.estimate, cap }))
    .sort((a, b) => b.estimate - a.estimate);
}

/** A local copy of the canonical form, limited to what a seed url needs. */
function canonicalSeed(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  u.hash = '';
  const path = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
  const q = u.searchParams.toString();
  return `${u.protocol}//${u.host}${path}${q ? `?${q}` : ''}`;
}
