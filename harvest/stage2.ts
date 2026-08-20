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

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, readJsonl, SeenSet } from './lib/queue.ts';
import { sharedPrefix, sharedSuffix, stripBoilerplate } from './lib/boilerplate.ts';
import { classify } from './lib/relevance.ts';
import { ingredientSet, cluster, type Candidate } from './lib/dedup.ts';
import type { Resolved } from './lib/resolve.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const OUT = join(STATE, 'candidates.jsonl');
const BORDERLINE = join(STATE, 'borderline.jsonl');
const RESOLVED = join(STATE, 'resolved.jsonl');

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
  // Deduplicated by URL. Shards used to be assigned domains by position, which
  // re-shuffled whenever new leads arrived and let two shards record the same
  // page. The assignment is stable now, but the records it already wrote are
  // on disk and must not be counted twice.
  const seen = new Set<string>();
  const out: PageRow[] = [];
  for (const f of readdirSync(STATE)) {
    if (!/^pages(-\d+)?\.jsonl$/.test(f)) continue;
    for (const row of readJsonl<PageRow>(join(STATE, f))) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      out.push(row);
    }
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

  // Pages the resolver has already judged. Their ingredients came from a model
  // reading the page, which is exactly what the regex parser could not do.
  const resolved = new Map<string, Resolved>(
    readJsonl<Resolved>(RESOLVED).map((r) => [r.url, r]),
  );
  let promoted = 0;
  // Stage 2 is re-run as the crawl grows, so the borderline queue needs its own
  // seen-set: without it every run re-queues every unresolved page.
  const queued = new SeenSet(join(STATE, 'seen-borderline.txt'));

  for (const [domain, rows] of byDomain) {
    const sample = rows.slice(0, BOILERPLATE_SAMPLE).map((r) => r.text);
    const prefix = sharedPrefix(sample);
    const suffix = sharedSuffix(sample);

    for (const row of rows) {
      const text = stripBoilerplate(row.text, prefix, suffix);
      strippedChars += row.text.length - text.length;

      const verdict = classify({ title: row.title, text, jsonld: row.jsonld });
      verdicts[verdict] += 1;

      if (verdict === 'borderline') {
        const answer = resolved.get(row.url);
        if (!answer) {
          // Queue it for the resolver and move on; it rejoins on the next run.
          if (queued.add(row.url)) {
            appendJsonl(BORDERLINE, { url: row.url, title: row.title, text });
          }
          continue;
        }
        promoted += 1;
        candidates.push({
          id: row.url,
          url: row.url,
          title: answer.title,
          text,
          ingredients: answer.ingredients,
        });
        continue;
      }

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

  // Stage 2 recomputes every cluster from pages.jsonl on each run, so the
  // output is rewritten rather than appended. Appending multiplied the whole
  // corpus every time the stage was re-run against a grown crawl.
  writeFileSync(OUT, '', 'utf8');

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
      `borderline promoted by resolver: ${promoted}`,
      `clusters ${clusters.length} (folded ${folded} duplicates)`,
    ].join('\n'),
  );
}

main();
