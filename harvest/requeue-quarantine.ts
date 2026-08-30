/**
 * Give back the candidates that were never really tried.
 *
 * Stage 3 used to treat an empty reply from `claude -p` as a rejection: it
 * wrote a quarantine file saying "reply was not valid JSON" and marked the
 * candidate done, permanently. But an empty reply is the CLI failing, not the
 * model answering badly — under heavy parallelism it is almost always a rate
 * limit, which clears on its own.
 *
 * Roughly seventeen thousand candidates were retired that way. This finds the
 * quarantine files whose only complaint was an unreadable reply, clears those
 * URLs from the transformed set, and deletes the files so the pipeline picks
 * them up again. Quarantines with a real schema complaint are left alone.
 *
 * Run:
 *   node --experimental-strip-types harvest/requeue-quarantine.ts [--fix]
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const QUARANTINE = join(ROOT, 'harvest/quarantine');
const TRANSFORMED = join(ROOT, 'harvest/state/seen-transformed.txt');

const fix = process.argv.includes('--fix');

/** The complaint that means "we never got an answer", not "the answer was bad". */
const TRANSIENT = 'reply was not valid JSON';

function main() {
  if (!existsSync(QUARANTINE)) {
    console.log('nothing quarantined');
    return;
  }

  const files = readdirSync(QUARANTINE).filter((f) => f.endsWith('.json'));
  const recoverable: string[] = [];
  const urls = new Set<string>();
  let real = 0;

  for (const f of files) {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(join(QUARANTINE, f), 'utf8'));
    } catch {
      continue;
    }
    const errors: string[] = parsed.errors ?? [];
    // Only if EVERY complaint is the transient one. A file that also carries a
    // schema error was genuinely judged and stays put.
    if (errors.length > 0 && errors.every((e) => e === TRANSIENT)) {
      recoverable.push(f);
      if (parsed.candidate?.url) urls.add(parsed.candidate.url);
    } else {
      real += 1;
    }
  }

  console.log(`${files.length} quarantined: ${recoverable.length} were never answered, ${real} were genuinely rejected`);

  if (!fix) {
    console.log('run with --fix to give the unanswered ones back to the queue');
    return;
  }

  if (existsSync(TRANSFORMED)) {
    const kept = readFileSync(TRANSFORMED, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !urls.has(l));
    writeFileSync(TRANSFORMED, kept.join('\n') + '\n', 'utf8');
  }

  for (const f of recoverable) unlinkSync(join(QUARANTINE, f));

  console.log(`requeued ${urls.size} candidates and cleared ${recoverable.length} quarantine files`);
}

main();
