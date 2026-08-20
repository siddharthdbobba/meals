/**
 * Sitemap reading, by regex rather than by XML parser.
 *
 * Sitemaps are a fixed, shallow shape and the only thing we want out of them is
 * `<loc>`, so a real parser (and the dependency it costs) buys nothing. The one
 * distinction that matters is `<sitemapindex>` versus `<urlset>`: an index
 * yields more sitemaps to walk, a urlset yields pages to fetch.
 */

import { decodeEntities } from './extract.ts';

export type Sitemap = { urls: string[]; sitemaps: string[] };

/** `<loc>`, with or without a namespace prefix, across newlines. */
const LOC = /<(?:[A-Za-z0-9]+:)?loc>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?loc>/gi;

export function parseSitemap(xml: string): Sitemap {
  const isIndex = /<(?:[A-Za-z0-9]+:)?sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<(?:[A-Za-z0-9]+:)?urlset[\s>]/i.test(xml);
  if (!isIndex && !isUrlset) return { urls: [], sitemaps: [] };

  const locs = [...xml.matchAll(LOC)]
    .map((m) => decodeEntities(m[1]).trim())
    .filter(Boolean);

  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}
