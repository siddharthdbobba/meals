/**
 * Stage 2b: ask a cheap model about the pages the keyword scorer would not judge.
 *
 * Runs `claude -p` as a subprocess against the user's subscription rather than
 * the API — no key, no SDK, same mechanism as the scouts. Pages go out in
 * batches so one call covers many pages, and each batch that comes back is
 * written immediately, so a run killed halfway keeps everything it earned.
 *
 * Run:
 *   node --experimental-strip-types harvest/stage2b-resolve.ts [--batch N] [--parallel N] [--limit N]
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { leanArgs } from './lib/cli.ts';
import { appendJsonl, readJsonl, SeenSet } from './lib/queue.ts';
import {
  batchPages,
  buildResolvePrompt,
  parseResolveResponse,
  type BorderlinePage,
} from './lib/resolve.ts';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const ROOT = new URL('..', import.meta.url).pathname;
const STATE = join(ROOT, 'harvest/state');
const BORDERLINE = join(STATE, 'borderline.jsonl');
const RESOLVED = join(STATE, 'resolved.jsonl');
const DONE = join(STATE, 'seen-resolved.txt');

/** Triage is a small judgement on a short excerpt, so it runs on the cheapest
 *  model. Every page it rejects is a transformation agent never spawned. */
const MODEL = 'claude-haiku-4-5';

/** A batch that has not answered in this long is not going to. */
const TIMEOUT_MS = 180_000;

function askClaude(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', '--model', MODEL, '--permission-mode', 'bypassPermissions', ...leanArgs(), prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    // stderr is drained but ignored: the CLI writes progress there, and an
    // unread pipe eventually blocks the child.
    child.stderr.on('data', () => {});

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function main() {
  const batchSize = arg('batch', 20);
  const parallel = arg('parallel', 6);
  const limit = arg('limit', Infinity);

  const done = new SeenSet(DONE);
  const pending = readJsonl<BorderlinePage>(BORDERLINE)
    .filter((p) => !done.has(p.url))
    .slice(0, limit === Infinity ? undefined : limit);

  if (pending.length === 0) {
    console.log('no borderline pages waiting');
    return;
  }

  const batches = batchPages(pending, batchSize);
  console.log(`${pending.length} borderline pages in ${batches.length} batches, ${parallel} at a time`);

  let recipes = 0;
  let rejected = 0;

  // A simple worker pool: each worker pulls the next batch until none are left.
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next];
      next += 1;

      const reply = await askClaude(buildResolvePrompt(batch));
      const resolved = parseResolveResponse(reply, batch);

      for (const r of resolved) appendJsonl(RESOLVED, r);
      // Every page in the batch is marked done, including the rejects: without
      // that, rejected pages would be re-asked on every run forever.
      for (const p of batch) done.add(p.url);

      recipes += resolved.length;
      rejected += batch.length - resolved.length;
      console.log(`batch: ${resolved.length}/${batch.length} are recipes (${recipes} kept so far)`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  console.log(`stage 2b done: ${recipes} recipes recovered, ${rejected} rejected`);
}

main().catch((e) => {
  console.error('stage 2b failed:', e);
  process.exit(1);
});
