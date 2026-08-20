import { describe, it, expect } from 'vitest';
import { parseRobots, isAllowed } from '../harvest/lib/robots';
import { parseSitemap } from '../harvest/lib/sitemap';
import { jsonLdRecipes, pageText, canonicalUrl, pageTitle } from '../harvest/lib/extract';

// ------------------------------------------------------------------- robots

describe('parseRobots', () => {
  it('collects the disallow rules of the wildcard group', () => {
    const r = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /private\n', 'mealbot');
    expect(r.disallow).toEqual(['/admin', '/private']);
  });

  it('prefers a group naming our agent over the wildcard group', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: mealbot\nDisallow: /admin\n';
    expect(parseRobots(txt, 'mealbot').disallow).toEqual(['/admin']);
  });

  it('matches the agent group case-insensitively', () => {
    const txt = 'User-agent: MealBot\nDisallow: /x\n';
    expect(parseRobots(txt, 'mealbot').disallow).toEqual(['/x']);
  });

  it('treats an empty disallow value as no restriction', () => {
    expect(parseRobots('User-agent: *\nDisallow:\n', 'mealbot').disallow).toEqual([]);
  });

  it('applies one group to several stacked user-agent lines', () => {
    const txt = 'User-agent: mealbot\nUser-agent: otherbot\nDisallow: /shared\n';
    expect(parseRobots(txt, 'mealbot').disallow).toEqual(['/shared']);
  });

  it('collects sitemap urls regardless of which group they follow', () => {
    const txt = 'Sitemap: https://x.com/sitemap.xml\nUser-agent: *\nDisallow: /a\nSitemap: https://x.com/news.xml\n';
    expect(parseRobots(txt, 'mealbot').sitemaps).toEqual([
      'https://x.com/sitemap.xml',
      'https://x.com/news.xml',
    ]);
  });

  it('reads crawl-delay as seconds', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 10\n', 'mealbot').crawlDelay).toBe(10);
  });

  it('ignores comments and blank lines', () => {
    const txt = '# hello\n\nUser-agent: *\n# nope\nDisallow: /a  # trailing\n';
    expect(parseRobots(txt, 'mealbot').disallow).toEqual(['/a']);
  });

  it('merges every group that names our agent', () => {
    // WordPress sites with several plugins routinely emit more than one
    // "User-agent: *" block; taking only the first silently ignores the rest.
    const txt = 'User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n';
    expect(parseRobots(txt, 'mealbot').disallow).toEqual(['/a', '/b']);
  });

  it('returns an unrestricted result for an empty file', () => {
    const r = parseRobots('', 'mealbot');
    expect(r.disallow).toEqual([]);
    expect(r.allow).toEqual([]);
  });
});

describe('isAllowed', () => {
  const rules = (allow: string[], disallow: string[]) =>
    ({ allow, disallow, sitemaps: [], crawlDelay: undefined });

  it('blocks a path under a disallowed prefix', () => {
    expect(isAllowed(rules([], ['/admin']), '/admin/users')).toBe(false);
  });

  it('permits a path outside every disallowed prefix', () => {
    expect(isAllowed(rules([], ['/admin']), '/recipes/chili')).toBe(true);
  });

  it('lets the longest matching rule win when allow and disallow overlap', () => {
    expect(isAllowed(rules(['/admin/public'], ['/admin']), '/admin/public/x')).toBe(true);
  });

  it('lets disallow win when it is the longer match', () => {
    expect(isAllowed(rules(['/a'], ['/a/b']), '/a/b/c')).toBe(false);
  });

  it('treats a bare slash disallow as blocking everything', () => {
    expect(isAllowed(rules([], ['/']), '/anything')).toBe(false);
  });

  it('honours a trailing wildcard', () => {
    expect(isAllowed(rules([], ['/*.pdf']), '/files/manual.pdf')).toBe(false);
  });

  it('honours an end-of-path anchor', () => {
    expect(isAllowed(rules([], ['/print$']), '/print')).toBe(false);
    expect(isAllowed(rules([], ['/print$']), '/print/page')).toBe(true);
  });
});

// ------------------------------------------------------------------ sitemap

describe('parseSitemap', () => {
  it('returns the page urls of a urlset', () => {
    const xml = `<urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({ urls: ['https://x.com/a', 'https://x.com/b'], sitemaps: [] });
  });

  it('returns child sitemaps rather than urls for a sitemap index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({ urls: [], sitemaps: ['https://x.com/s1.xml'] });
  });

  it('decodes xml entities in a url', () => {
    const xml = `<urlset><url><loc>https://x.com/a?p=1&amp;q=2</loc></url></urlset>`;
    expect(parseSitemap(xml).urls).toEqual(['https://x.com/a?p=1&q=2']);
  });

  it('tolerates namespaced and whitespace-padded loc tags', () => {
    const xml = `<urlset><url>\n  <loc>\n   https://x.com/a\n  </loc>\n</url></urlset>`;
    expect(parseSitemap(xml).urls).toEqual(['https://x.com/a']);
  });

  it('returns nothing for xml that is not a sitemap', () => {
    expect(parseSitemap('<rss><channel></channel></rss>')).toEqual({ urls: [], sitemaps: [] });
  });
});

// ------------------------------------------------------------------ extract

describe('jsonLdRecipes', () => {
  it('finds a top-level Recipe object', () => {
    const html = `<script type="application/ld+json">{"@type":"Recipe","name":"Chili"}</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['Chili']);
  });

  it('finds a Recipe nested in an @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Grits"}]}</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['Grits']);
  });

  it('finds a Recipe inside a top-level array', () => {
    const html = `<script type="application/ld+json">[{"@type":"Organization"},{"@type":"Recipe","name":"Oats"}]</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['Oats']);
  });

  it('accepts an @type given as an array', () => {
    const html = `<script type="application/ld+json">{"@type":["Recipe","Thing"],"name":"Stew"}</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['Stew']);
  });

  it('reads several script blocks on one page', () => {
    const html =
      `<script type="application/ld+json">{"@type":"Recipe","name":"A"}</script>` +
      `<script type="application/ld+json">{"@type":"Recipe","name":"B"}</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('skips a malformed block instead of throwing', () => {
    const html =
      `<script type="application/ld+json">{oops</script>` +
      `<script type="application/ld+json">{"@type":"Recipe","name":"C"}</script>`;
    expect(jsonLdRecipes(html).map((r) => r.name)).toEqual(['C']);
  });

  it('ignores ordinary javascript script tags', () => {
    expect(jsonLdRecipes(`<script>var x = {"@type":"Recipe"}</script>`)).toEqual([]);
  });

  it('uses only the first recipe when a page carries several', () => {
    // A roundup page embeds one Recipe per dish. Flattening them all produced a
    // single fifty-ingredient composite belonging to no actual recipe.
    const html =
      `<script type="application/ld+json">{"@type":"Recipe","name":"A"}</script>` +
      `<script type="application/ld+json">{"@type":"Recipe","name":"B"}</script>`;
    expect(jsonLdRecipes(html)).toHaveLength(2);
  });

  it('returns nothing when the page has no structured data', () => {
    expect(jsonLdRecipes('<html><body>hi</body></html>')).toEqual([]);
  });
});

describe('decodeEntities via pageText', () => {
  it('leaves an out-of-range numeric entity alone instead of throwing', () => {
    // String.fromCodePoint throws RangeError above 0x10FFFF, and one malformed
    // entity in one crawled page used to kill the whole shard.
    expect(() => pageText('<p>a &#99999999; b</p>')).not.toThrow();
    expect(() => pageText('<p>a &#x110000; b</p>')).not.toThrow();
  });
});

describe('pageText', () => {
  it('drops script and style contents', () => {
    const html = '<style>.a{color:red}</style><script>evil()</script><p>Boil water</p>';
    expect(pageText(html)).toBe('Boil water');
  });

  it('strips tags and collapses runs of whitespace', () => {
    expect(pageText('<div>  Boil   <b>water</b>\n\n  now </div>')).toBe('Boil water now');
  });

  it('decodes the common html entities', () => {
    expect(pageText('<p>salt &amp; pepper &nbsp;&#39;s</p>')).toBe("salt & pepper 's");
  });

  it('keeps a block boundary as a single space rather than joining words', () => {
    expect(pageText('<li>Boil</li><li>Stir</li>')).toBe('Boil Stir');
  });
});

describe('canonicalUrl', () => {
  it('lowercases the host but not the path', () => {
    expect(canonicalUrl('https://Example.COM/Recipes/Chili')).toBe('https://example.com/Recipes/Chili');
  });

  it('drops the fragment', () => {
    expect(canonicalUrl('https://x.com/a#comments')).toBe('https://x.com/a');
  });

  it('drops tracking parameters but keeps meaningful ones', () => {
    expect(canonicalUrl('https://x.com/a?utm_source=g&page=2&fbclid=z')).toBe('https://x.com/a?page=2');
  });

  it('removes a trailing slash except at the root', () => {
    expect(canonicalUrl('https://x.com/a/')).toBe('https://x.com/a');
    expect(canonicalUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('sorts query parameters so ordering cannot create a duplicate', () => {
    expect(canonicalUrl('https://x.com/a?b=2&a=1')).toBe('https://x.com/a?a=1&b=2');
  });

  it('returns the input unchanged when it is not a parseable url', () => {
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});

describe('pageTitle', () => {
  it('reads the title element', () => {
    expect(pageTitle('<html><head><title>Ramen Bomb</title></head></html>')).toBe('Ramen Bomb');
  });

  it('trims whitespace and decodes entities', () => {
    expect(pageTitle('<title>\n  Salt &amp; Pepper \n</title>')).toBe('Salt & Pepper');
  });

  it('drops a trailing site name after a separator', () => {
    expect(pageTitle('<title>Ramen Bomb | Trail Cooking</title>')).toBe('Ramen Bomb');
    expect(pageTitle('<title>Ramen Bomb - Trail Cooking</title>')).toBe('Ramen Bomb');
  });

  it('keeps a hyphen that is part of the recipe name', () => {
    expect(pageTitle('<title>No-Cook Couscous</title>')).toBe('No-Cook Couscous');
  });

  it('falls back to the first h1 when there is no title', () => {
    expect(pageTitle('<body><h1>Camp Hash</h1></body>')).toBe('Camp Hash');
  });

  it('returns an empty string when the page has neither', () => {
    expect(pageTitle('<body><p>hi</p></body>')).toBe('');
  });
});
