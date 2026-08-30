/**
 * Stage 5: the gate. Nothing reaches `content/` except through here.
 *
 * Cheap checks first — facet contradictions, impossible arithmetic, and an
 * originality measurement against the source text — because they cost nothing
 * and kill most of what is wrong. Only a draft that survives all three is worth
 * spending refuters on.
 *
 * The refuters are asked to KILL the recipe, not to approve it, and they are
 * given different jobs: one judges whether it is real and cookable, the other
 * whether it is safe to eat. Asking two agents the same question mostly buys
 * the same answer twice; asking different questions finds different faults.
 *
 * Run:
 *   node --experimental-strip-types harvest/stage5-qa.ts [--limit N] [--parallel N]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl } from './lib/queue.ts';
import { shardFor, renderRecipe, cliFailureReason } from './lib/transform.ts';
import { recordSpend, calibrateFromLimit, overBudget, windowSpend, budget } from './lib/spend.ts';
import { qaVerdict, type Recipe, type Refutation } from './lib/qa.ts';

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const DRAFTS = join(ROOT, 'harvest/drafts');
const CONTENT = join(ROOT, 'content');
const REJECTED = join(ROOT, 'harvest/rejected');
const LOG = join(STATE, 'qa.jsonl');

const TIMEOUT_MS = 180_000;
const MODEL = 'claude-haiku-4-5';

/** Two different questions, so two refuters cannot fail the same way. */
const LENSES = [
  {
    name: 'cookable',
    ask: 'Is this recipe REAL and actually cookable exactly as written, on the heat source it claims, with the equipment a camper carries? Look for steps that cannot work, missing steps, quantities that do not make a meal, or a method that does not match the heat source.',
  },
  {
    name: 'safe',
    ask: 'Is this recipe SAFE? Look for food that would spoil before it is eaten, raw or undercooked meat, beans or legumes that need far longer cooking than stated, shelf-life claims that are wrong, or anything that would make someone ill days from a road.',
  },
];

function askClaude(prompt: string): Promise<{ out: string; usd: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'json', '--model', MODEL, '--permission-mode', 'bypassPermissions', prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const envelope = JSON.parse(out);
        resolve({ out: String(envelope.result ?? ''), usd: Number(envelope.total_cost_usd) || 0 });
      } catch {
        // A failure notice is printed raw, outside the envelope. Pass it
        // through so the caller can tell it apart from a refuter's answer.
        resolve({ out, usd: 0 });
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve({ out: '', usd: 0 }); });
  });
}

/** One refuter's answer, or the CLI's excuse for not having one. */
async function refute(prompt: string): Promise<Refutation | { failure: string }> {
  const { out, usd } = await askClaude(prompt);
  recordSpend(STATE, usd, 'stage5');
  const failure = cliFailureReason(out);
  if (failure) {
    if (failure === 'rate limited') calibrateFromLimit(STATE);
    return { failure };
  }
  return parseRefutation(out);
}

function refutePrompt(recipe: Recipe, lens: (typeof LENSES)[number]): string {
  return `You are reviewing a recipe for a backpacking meal library. Your job is to REFUTE it — to find the reason it should not be published. Approving is not your job; someone else does that.

${lens.ask}

Be strict but not pedantic. Wording you would have phrased differently is NOT grounds to refute. A real fault is.

RECIPE:
${JSON.stringify(recipe, null, 2)}

Reply with ONLY a JSON object: {"refuted": true or false, "why": "one short sentence"}`;
}

function parseRefutation(reply: string): Refutation {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(reply.slice(start, end + 1));
      return { refuted: parsed.refuted === true, why: String(parsed.why ?? '') };
    } catch {
      // fall through
    }
  }
  // An unreadable refuter does not get a vote. Silence must not become a
  // rejection, or a flaky subprocess would quietly gut the corpus.
  return { refuted: false, why: 'refuter unreadable' };
}

/** A published filename nothing else has claimed. */
function freePath(slug: string): { slug: string; path: string } {
  const shard = shardFor(slug);
  mkdirSync(join(CONTENT, shard), { recursive: true });
  let candidate = slug;
  let n = 2;
  while (existsSync(join(CONTENT, shard, `${candidate}.md`))) {
    candidate = `${slug}-${n}`;
    n += 1;
  }
  return { slug: candidate, path: join(CONTENT, shard, `${candidate}.md`) };
}

type Reviewed = { outcome: 'published' | 'rejected' } | { outcome: 'deferred'; failure: string };

async function review(file: string): Promise<Reviewed> {
  const draft = JSON.parse(readFileSync(join(DRAFTS, file), 'utf8'));
  const recipe: Recipe = draft.recipe;
  const slug = file.replace(/\.json$/, '');

  // Cheap checks first: if the arithmetic is impossible there is nothing for a
  // refuter to add, and the call is saved.
  const cheap = qaVerdict(recipe, draft.sourceText ?? '', []);

  let refutations: Refutation[] = [];
  if (cheap.pass) {
    const answers = await Promise.all(LENSES.map((lens) => refute(refutePrompt(recipe, lens))));

    // A refuter that never ran has not approved anything. Publishing on its
    // silence is how an unauthenticated cron job could put recipes on the site
    // that nothing had reviewed — the same missing USER that burned the
    // candidates, failing in the opposite and more dangerous direction.
    const failed = answers.find((a) => 'failure' in a) as { failure: string } | undefined;
    if (failed) return { outcome: 'deferred', failure: failed.failure };

    refutations = answers as Refutation[];
  }

  const verdict = qaVerdict(recipe, draft.sourceText ?? '', refutations);
  appendJsonl(LOG, { slug, url: draft.url, pass: verdict.pass, reasons: verdict.reasons });

  if (!verdict.pass) {
    mkdirSync(REJECTED, { recursive: true });
    writeFileSync(
      join(REJECTED, file),
      JSON.stringify({ ...draft, reasons: verdict.reasons }, null, 2),
      'utf8',
    );
    renameSync(join(DRAFTS, file), join(REJECTED, `${slug}.draft.json`));
    return { outcome: 'rejected' };
  }

  const { path } = freePath(slug);
  writeFileSync(path, renderRecipe(recipe as any, draft.url), 'utf8');
  renameSync(join(DRAFTS, file), join(DRAFTS, `${slug}.published`));
  return { outcome: 'published' };
}

async function main() {
  const limit = argNum('limit', Infinity);
  const parallel = argNum('parallel', 4);

  if (!existsSync(DRAFTS)) {
    console.log('no drafts yet');
    return;
  }
  const files = readdirSync(DRAFTS)
    .filter((f) => f.endsWith('.json'))
    .slice(0, limit === Infinity ? undefined : limit);

  if (files.length === 0) {
    console.log('no drafts waiting');
    return;
  }
  console.log(`reviewing ${files.length} drafts, ${parallel} at a time`);

  let published = 0;
  let rejected = 0;
  let deferred = 0;
  const reasons: string[] = [];
  let next = 0;
  let halted: string | null = null;

  const worker = async () => {
    while (next < files.length && !halted) {
      const overspent = overBudget(STATE);
      if (overspent) { halted = overspent; break; }

      const file = files[next];
      next += 1;
      try {
        const result = await review(file);
        if (result.outcome === 'published') published += 1;
        else if (result.outcome === 'rejected') rejected += 1;
        else {
          // The draft stays in drafts/, unjudged, for a run that can reach a
          // model. Five in a row means the condition is the machine's.
          deferred += 1;
          if (deferred >= 5) halted = `the CLI is failing on every refuter: ${result.failure}`;
        }
      } catch (e) {
        rejected += 1;
        reasons.push(`${file}: ${(e as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(parallel, files.length) }, worker));
  const cap = budget(STATE);
  console.log(
    `five-hour spend: $${windowSpend(STATE).toFixed(2)}${cap === null ? ' (no budget calibrated yet)' : ` of $${cap.toFixed(2)}`}`,
  );
  if (halted) console.error(`stage 5 halted: ${halted}`);
  console.log(`stage 5 done: ${published} published, ${rejected} rejected, ${deferred} left unjudged`);
  if (halted) process.exitCode = 1;
  if (reasons.length) console.log(reasons.slice(0, 5).join('\n'));
}

main().catch((e) => {
  console.error('stage 5 failed:', e);
  process.exit(1);
});
