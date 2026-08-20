/**
 * Stage 1: turn scout leads into fetched, extracted pages.
 *
 * No model runs here. The stage walks each lead domain's sitemap, keeps the
 * URLs whose shape suggests a recipe, fetches them politely, and writes what it
 * extracted to `pages.jsonl`. Everything expensive happens downstream, so this
 * stage's job is to be cheap, polite, and restartable.
 *
 * Run:
 *   node --experimental-strip-types harvest/stage1.ts [--budget N] [--domains N]
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, readJsonl, SeenSet } from './lib/queue.ts';
import { createFetcher } from './lib/fetcher.ts';
import { parseRobots, isAllowed, type RobotsRules } from './lib/robots.ts';
import { parseSitemap } from './lib/sitemap.ts';
import { jsonLdRecipes, pageText, pageTitle, canonicalUrl } from './lib/extract.ts';
import { planDomains, looksLikeRecipeUrl, sameSite, type Lead } from './lib/plan.ts';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const LEADS = join(STATE, 'leads');
/** Each shard owns its own output and its own seen-set. Sharding is by domain,
 *  so the shards never contend for a URL, and separate files mean two 12 KB
 *  appends can never interleave into a corrupt line. */
const shardId = arg('shard', 0);
const shardCount = arg('of', 1);
const PAGES = join(STATE, shardCount > 1 ? `pages-${shardId}.jsonl` : 'pages.jsonl');
const SEEN = join(STATE, shardCount > 1 ? `seen-pages-${shardId}.txt` : 'seen-pages.txt');
const CACHE = join(ROOT, 'harvest/cache');

const UA = 'mealbot/0.1 (+https://siddharthbobba.com/meals; recipe research; contact siddharthdbobba@gmail.com)';

/** How much prose we keep. Enough for a later stage to read a recipe out of a
 *  forum post, far short of storing the web. */
const MAX_TEXT = 12_000;
/** A sitemap index can fan out further than the crawl is worth. */
const MAX_SITEMAPS_PER_DOMAIN = 25;

function loadLeads(): Lead[] {
  const out: Lead[] = [];
  for (const f of readdirSync(LEADS)) {
    if (f.endsWith('.jsonl')) out.push(...readJsonl<Lead>(join(LEADS, f)));
  }
  return out;
}

async function main() {
  const pageBudget = arg('budget', 4000);
  const domainLimit = arg('domains', 9999);

  const leads = loadLeads();
  const all = planDomains(leads);
  // Round-robin rather than block assignment: the plan is sorted richest-first,
  // so contiguous slices would hand one shard every large site.
  const targets = all.filter((_, i) => i % shardCount === shardId).slice(0, domainLimit);
  const seen = new SeenSet(SEEN);
  const fetcher = createFetcher({ cacheDir: CACHE, userAgent: UA, delayMs: 1500 });

  console.log(`shard ${shardId}/${shardCount}: ${leads.length} leads -> ${targets.length} of ${all.length} domains; budget ${pageBudget}; ${seen.size} seen`);

  let fetched = 0;
  let kept = 0;

  for (const target of targets) {
    if (fetched >= pageBudget) break;

    const origin = (() => {
      try { return new URL(target.seeds[0]).origin; } catch { return null; }
    })();
    if (!origin) continue;

    // Politeness first: without robots we do not crawl the domain at all.
    let rules: RobotsRules;
    const robotsPage = await fetcher.fetchPage(`${origin}/robots.txt`);
    rules = robotsPage ? parseRobots(robotsPage.body, 'mealbot') : { allow: [], disallow: [], sitemaps: [] };

    // Candidate urls: the seeds the scouts found, plus whatever the sitemaps list.
    // A site that asks for a slower crawl gets one. Capped so a hostile or
    // typo'd value cannot stall the shard for hours on one domain.
    const politeDelay = Math.min(Math.max(1500, (rules.crawlDelay ?? 0) * 1000), 10_000);
    const domainFetcher = politeDelay === 1500
      ? fetcher
      : createFetcher({ cacheDir: CACHE, userAgent: UA, delayMs: politeDelay });

    const candidates = new Set<string>(target.seeds);
    const sitemapQueue = [...rules.sitemaps];
    if (sitemapQueue.length === 0) sitemapQueue.push(`${origin}/sitemap.xml`);

    let walked = 0;
    while (sitemapQueue.length && walked < MAX_SITEMAPS_PER_DOMAIN) {
      const sm = sitemapQueue.shift()!;
      walked += 1;
      const page = await domainFetcher.fetchPage(sm);
      if (!page) continue;
      const parsed = parseSitemap(page.body);
      for (const child of parsed.sitemaps) {
        if (sitemapQueue.length + walked < MAX_SITEMAPS_PER_DOMAIN) sitemapQueue.push(child);
      }
      for (const url of parsed.urls) candidates.add(url);
    }

    const worth = [...candidates].filter((u) => {
      if (!sameSite(target.seeds[0], u)) return false;
      if (seen.has(u)) return false;
      let path: string;
      try { path = new URL(u).pathname; } catch { return false; }
      if (!isAllowed(rules, path)) return false;
      // Seeds came from a human-ish judgement, so they bypass the shape filter.
      return target.seeds.includes(canonicalUrl(u)) || looksLikeRecipeUrl(u);
    }).slice(0, target.cap);

    if (worth.length === 0) continue;
    console.log(`${target.domain}: ${worth.length} candidate pages (est ${target.estimate})`);

    for (const url of worth) {
      if (fetched >= pageBudget) break;
      if (!seen.add(url)) continue;

      const page = await domainFetcher.fetchPage(url);
      fetched += 1;
      if (!page) continue;

      const recipes = jsonLdRecipes(page.body);
      const text = pageText(page.body);
      // A page with neither structured data nor enough prose to hold a method
      // is a listing page that slipped the shape filter.
      if (recipes.length === 0 && text.length < 400) continue;

      appendJsonl(PAGES, {
        url: page.url,
        domain: target.domain,
        title: pageTitle(page.body),
        jsonld: recipes.length ? recipes : undefined,
        text: text.slice(0, MAX_TEXT),
        chars: text.length,
      });
      kept += 1;
    }
  }

  console.log(`stage 1 done: fetched ${fetched}, kept ${kept}, pages.jsonl now ${readJsonl(PAGES).length}`);
}

main().catch((e) => {
  console.error('stage 1 failed:', e);
  process.exit(1);
});
