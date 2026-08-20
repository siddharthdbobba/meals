/**
 * The pipeline's memory: append-only JSONL queues and a `seen` set.
 *
 * Every stage reads one file and appends to another, and nothing is ever
 * rewritten in place. That is what makes the whole harvest restartable: a run
 * killed by a usage limit leaves a valid prefix, and the next run appends to it.
 * A partly-written final line is expected and is skipped on read.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalUrl } from './extract.ts';

export function appendJsonl(file: string, record: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

/** Every parseable record in the file. A missing file is an empty queue, not an
 *  error: stages run before their producer has ever written anything. */
export function readJsonl<T = any>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn last line from an interrupted run. Nothing to recover.
    }
  }
  return out;
}

/**
 * The set of URLs the pipeline has already handled, keyed by canonical form so
 * that tracking parameters and trailing slashes cannot smuggle a page past it.
 *
 * Held in memory for the run and appended to disk on every add, so a crash
 * loses at most the last entry rather than the run.
 */
export class SeenSet {
  private readonly keys: Set<string>;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.keys = new Set(
      existsSync(file)
        ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
        : [],
    );
  }

  has(url: string): boolean {
    return this.keys.has(canonicalUrl(url));
  }

  /** True if this call added the url, false if it was already present. */
  add(url: string): boolean {
    const key = canonicalUrl(url);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, key + '\n', 'utf8');
    return true;
  }

  get size(): number {
    return this.keys.size;
  }
}
