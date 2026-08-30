/**
 * Stage 3: write a recipe file from a deduplicated candidate.
 *
 * One `claude -p` call per cluster. The agent is given extracted FACTS —
 * ingredients, method, provenance — and asked to write an original recipe in
 * the library's voice. It is never asked to rewrite the source page, and it
 * never sees the source's prose as something to preserve: instructions and
 * headnotes are the author's expression, while an ingredient list is fact.
 *
 * Output is JSON, validated against the site's own `mealFields` schema before
 * anything is written, so a malformed recipe is quarantined rather than
 * breaking the build.
 *
 * Run:
 *   node --experimental-strip-types harvest/stage3.ts [--limit N] [--parallel N] [--model M]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, readJsonl, SeenSet } from './lib/queue.ts';
import { slugFor, parseRecipeJson, validateRecipe } from './lib/transform.ts';
import {
  TRIP_STYLES, SLOTS, HEAT_SOURCES, WATER, CLEANUP, DIETARY,
  HOME_PREP, SHELF_LIFE, SKILL, COST,
} from '../data/meals.ts';

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const argStr = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const CONTENT = join(ROOT, 'content');
const DRAFTS = join(ROOT, 'harvest/drafts');
const QUARANTINE = join(ROOT, 'harvest/quarantine');
const CANDIDATES = join(STATE, 'candidates.jsonl');
const DONE = join(STATE, 'seen-transformed.txt');
const LOG = join(STATE, 'transformed.jsonl');

const TIMEOUT_MS = 300_000;

type Candidate = {
  url: string;
  title: string;
  ingredients: string[];
  text: string;
  duplicates?: { url: string; title: string }[];
};

/** Two real recipes, so the agent copies the house voice rather than inventing
 *  one. Chosen as files, not as a description: showing beats telling. */
function exemplars(): string {
  return ['ramen-bomb.md', 'cold-soak-overnight-oats.md']
    .map((f) => {
      const path = join(CONTENT, f);
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    })
    .filter(Boolean)
    .join('\n\n---8<---\n\n');
}

const VOCAB = `tripStyle: ${TRIP_STYLES.join(', ')}
slot: ${SLOTS.join(', ')}
heatSource: ${HEAT_SOURCES.join(', ')}
water: ${WATER.join(', ')}
cleanup: ${CLEANUP.join(', ')}
dietary: ${DIETARY.join(', ')}
homePrep: ${HOME_PREP.join(', ')}
shelfLife: ${SHELF_LIFE.join(', ')}
skill: ${SKILL.join(', ')}
cost: ${COST.join(', ')}`;

function buildPrompt(c: Candidate, retryErrors?: string[]): string {
  const retry = retryErrors?.length
    ? `\n\nYour previous attempt was REJECTED by the schema:\n${retryErrors.map((e) => `- ${e}`).join('\n')}\nFix exactly these problems.\n`
    : '';

  return `You write recipes for a backpacking and camping meal library.

Below are FACTS extracted from a web page: what the dish contains and roughly how it is made. Write an ORIGINAL recipe from those facts.

Rules that matter:
- Write your own words throughout. Do NOT reuse the source's sentences, phrasing, or headnote. Ingredients and quantities are facts and may be carried over; the writing must be yours.
- Match the voice of the examples: plain, direct, a little dry, no marketing, no "delicious", no exclamation marks. Short sentences. The body explains why the recipe works, not that it is tasty.
- If this is ordinary home cooking, ADAPT it for the trail: shelf-stable substitutions, one pot, minimal water, no fridge, no fresh dairy. Say what you changed in the body if it matters.
- Every facet value must come from the allowed vocabulary exactly. Do not invent values.
- caloriesPerServing, ouncesPerServing, and proteinGrams are your best honest estimate from the ingredients. ouncesPerServing is the DRY PACKED weight carried, excluding water added at camp.
- steps must be actually cookable on the heatSource you chose.
- DIETARY TAGS ARE CLAIMS ABOUT EVERY INGREDIENT, and they are the most common
  reason a recipe is rejected. Check each one against your own ingredient list
  before you write it. Leave the array EMPTY rather than guess:
    vegan        no meat, fish, dairy, cheese, butter, egg, honey, whey
    vegetarian   no meat, fish, or seafood of any kind
    dairy-free   no milk, cheese, butter, cream, yogurt, ghee, whey
    gluten-free  no wheat, flour, pasta, noodles, ramen, couscous, barley,
                 bread, tortillas, bulgur, or seitan
    nut-free     no peanuts, almonds, cashews, walnuts, pecans, or nut butter
  A tag you leave off costs nothing. A tag that is wrong is a filter that lies
  to someone with an allergy.
- If any heatSource is "no-cook", then cookMinutes must be 0 and water must not
  be "boiled".

ALLOWED FACET VALUES:
${VOCAB}

EXAMPLE RECIPES (voice and shape to match, not content to copy):
${exemplars()}

FACTS FROM THE SOURCE:
Title seen: ${c.title}
Ingredients identified: ${c.ingredients.join(', ')}
Page text (for method only): ${c.text.slice(0, 4_000)}
${retry}
Reply with ONLY a JSON object, no prose and no code fence, with exactly these keys:
title, blurb, tripStyle[], slot[], heatSource[], prepMinutes, cookMinutes, caloriesPerServing, ouncesPerServing, proteinGrams, water, waterMl, cleanup, dietary[], homePrep, shelfLife, servings, scalable, skill, cost, ingredients[{item, amount, note?}], steps[], packing, variations[], body

body is the markdown prose that follows the frontmatter: two short paragraphs.`;
}

function askClaude(prompt: string, model: string | null): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    const args = ['-p', '--permission-mode', 'bypassPermissions'];
    if (model) args.push('--model', model);
    args.push(prompt);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    // stderr is kept, not discarded. Throwing it away is what hid a rate limit
    // behind seventeen thousand "reply was not valid JSON" quarantines.
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out: '', err: String(e) }); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A draft filename nothing else has claimed. */
function freeDraft(slug: string): { slug: string; path: string } {
  mkdirSync(DRAFTS, { recursive: true });
  let candidate = slug;
  let n = 2;
  while (existsSync(join(DRAFTS, `${candidate}.json`))) {
    candidate = `${slug}-${n}`;
    n += 1;
  }
  return { slug: candidate, path: join(DRAFTS, `${candidate}.json`) };
}

async function transform(
  c: Candidate,
  model: string | null,
): Promise<'written' | 'quarantined' | 'deferred'> {
  let errors: string[] | undefined;
  // The last reply, kept so a quarantine record can show what was actually
  // said. Without it, "reply was not valid JSON" is a verdict with no evidence
  // behind it, and every diagnosis of a bad run is a guess.
  let lastReply = '';
  let lastStderr = '';

  // Two attempts: the second is told exactly which schema rules it broke,
  // which recovers most failures (a stray facet value, a missing field).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { out, err } = await askClaude(buildPrompt(c, errors), model);
    lastReply = out;
    lastStderr = err;

    // An empty reply is the CLI failing, not the model answering badly —
    // usually a rate limit. Treating it as a rejection burned the candidate
    // permanently for a condition that clears on its own, so it is deferred
    // instead: not written, not marked done, retried on a later run.
    if (out.trim() === '') {
      appendJsonl(join(STATE, 'stage3-deferred.jsonl'), { url: c.url, stderr: err.slice(0, 300) });
      await sleep(5_000 + attempt * 10_000);
      if (attempt === 1) return 'deferred';
      continue;
    }

    const parsed = parseRecipeJson(out);

    if (!parsed) {
      errors = ['reply was not valid JSON'];
      continue;
    }

    const check = validateRecipe(parsed);
    if (!check.ok) {
      errors = check.errors;
      continue;
    }

    // Drafts, not content. Stage 5 is the only thing allowed to publish, so a
    // recipe that fails the quality gate never has to be deleted from the site.
    const { slug, path } = freeDraft(slugFor(String(parsed.title)));
    writeFileSync(
      path,
      JSON.stringify({ recipe: parsed, url: c.url, sourceText: c.text, duplicatesFolded: c.duplicates?.length ?? 0 }, null, 2),
      'utf8',
    );
    appendJsonl(LOG, { slug, url: c.url, title: parsed.title, duplicatesFolded: c.duplicates?.length ?? 0 });
    return 'written';
  }

  mkdirSync(QUARANTINE, { recursive: true });
  writeFileSync(
    join(QUARANTINE, `${slugFor(c.title) || 'untitled'}-${Date.now()}.json`),
    JSON.stringify(
      { candidate: c, errors, reply: lastReply.slice(0, 4_000), stderr: lastStderr.slice(0, 1_000) },
      null,
      2,
    ),
    'utf8',
  );
  return 'quarantined';
}

async function main() {
  const limit = argNum('limit', Infinity);
  const parallel = argNum('parallel', 4);
  const model = argStr('model');

  const done = new SeenSet(DONE);
  const pending = readJsonl<Candidate>(CANDIDATES)
    .filter((c) => !done.has(c.url))
    .slice(0, limit === Infinity ? undefined : limit);

  if (pending.length === 0) {
    console.log('no candidates waiting');
    return;
  }
  console.log(`transforming ${pending.length} candidates, ${parallel} at a time${model ? ` on ${model}` : ''}`);

  let written = 0;
  let quarantined = 0;
  let deferred = 0;
  let next = 0;

  const worker = async () => {
    while (next < pending.length) {
      const c = pending[next];
      next += 1;
      try {
        const result = await transform(c, model);
        if (result === 'written') written += 1;
        else if (result === 'deferred') { deferred += 1; continue; }
        else quarantined += 1;
      } catch (e) {
        // Silently counting these hid a defect for thousands of candidates:
        // the failure was an exception, not a schema rejection, so no
        // quarantine file was ever written to explain it.
        quarantined += 1;
        appendJsonl(join(STATE, 'stage3-errors.jsonl'), {
          url: c.url,
          error: (e as Error).message,
          stack: (e as Error).stack?.split('\n').slice(0, 3).join(' | '),
        });
      }
      // Marked done either way: a candidate that failed twice with the schema
      // errors in hand will not do better on a third identical attempt.
      done.add(c.url);
      if ((written + quarantined + deferred) % 10 === 0) {
        console.log(`  ${written} written, ${quarantined} quarantined, ${deferred} deferred`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, worker));
  console.log(`stage 3 done: ${written} drafts written, ${quarantined} quarantined, ${deferred} deferred for a later run`);
}

main().catch((e) => {
  console.error('stage 3 failed:', e);
  process.exit(1);
});
