/**
 * Stage 2: turn fetched pages into deduplicated recipe candidates.
 *
 * Three passes, all cheap. Strip each domain's furniture by comparing its
 * pages against each other; classify what is left; then collapse the same
 * recipe published on many sites into one cluster. Everything downstream costs
 * a model call per item, so this stage's whole job is to hand over as few
 * items as honestly possible.
 *
 * Run:
 *   node --experimental-strip-types harvest/stage2.ts [--report]
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from './lib/queue.ts';
import { sharedPrefix, sharedSuffix, stripBoilerplate } from './lib/boilerplate.ts';
import { classify } from './lib/relevance.ts';
import { ingredientSet, cluster, type Candidate } from './lib/dedup.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const OUT = join(STATE, 'candidates.jsonl');

type PageRow = {
  url: string;
  domain: string;
  title: string;
  text: string;
  jsonld?: unknown[];
};

/** Enough pages to see what a domain repeats; more adds nothing. */
const BOILERPLATE_SAMPLE = 30;

function loadPages(): PageRow[] {
  const out: PageRow[] = [];
  for (const f of readdirSync(STATE)) {
    if (/^pages(-\d+)?\.jsonl$/.test(f)) out.push(...readJsonl<PageRow>(join(STATE, f)));
  }
  return out;
}

function main() {
  const pages = loadPages();
  if (pages.length === 0) {
    console.log('no pages yet; run stage 1 first');
    return;
  }

  const byDomain = new Map<string, PageRow[]>();
  for (const p of pages) {
    const list = byDomain.get(p.domain) ?? [];
    list.push(p);
    byDomain.set(p.domain, list);
  }

  const verdicts = { recipe: 0, index: 0, borderline: 0, reject: 0 };
  const candidates: Candidate[] = [];
  let strippedChars = 0;

  for (const [domain, rows] of byDomain) {
    const sample = rows.slice(0, BOILERPLATE_SAMPLE).map((r) => r.text);
    const prefix = sharedPrefix(sample);
    const suffix = sharedSuffix(sample);

    for (const row of rows) {
      const text = stripBoilerplate(row.text, prefix, suffix);
      strippedChars += row.text.length - text.length;

      const verdict = classify({ title: row.title, text, jsonld: row.jsonld });
      verdicts[verdict] += 1;
      // Index pages are kept out of the corpus but are not wasted: their links
      // already entered the crawl frontier in stage 1.
      if (verdict !== 'recipe') continue;

      candidates.push({
        id: row.url,
        url: row.url,
        title: row.title,
        text,
        ingredients: ingredientSet({ text, jsonld: row.jsonld as any[] }),
        jsonld: row.jsonld,
      });
    }
  }

  const clusters = cluster(candidates);

  for (const k of clusters) {
    appendJsonl(OUT, {
      url: k.representative.url,
      title: k.representative.title,
      ingredients: k.representative.ingredients,
      text: k.representative.text,
      jsonld: k.representative.jsonld,
      fingerprint: k.fingerprint.toString(16),
      duplicates: k.duplicates.map((d) => ({ url: d.url, title: d.title })),
    });
  }

  const folded = clusters.reduce((n, k) => n + k.duplicates.length, 0);
  console.log(
    [
      `pages ${pages.length} across ${byDomain.size} domains`,
      `boilerplate stripped ${(strippedChars / 1000).toFixed(0)}k chars`,
      `verdicts recipe=${verdicts.recipe} index=${verdicts.index} borderline=${verdicts.borderline} reject=${verdicts.reject}`,
      `clusters ${clusters.length} (folded ${folded} duplicates)`,
    ].join('\n'),
  );
}

main();
