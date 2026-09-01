/**
 * The pipeline's memory: append-only JSONL queues and a `seen` set.
 *
 * Every stage reads one file and appends to another, and nothing is ever
 * rewritten in place. That is what makes the whole harvest restartable: a run
 * killed by a usage limit leaves a valid prefix, and the next run appends to it.
 * A partly-written final line is expected and is skipped on read.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalUrl } from './extract.ts';

export function appendJsonl(file: string, record: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Every parseable record, one at a time, without ever holding the file as a
 * string.
 *
 * A queue that grows past 512 MiB cannot be read with readFileSync at all:
 * V8 refuses to make a string that long and throws ERR_STRING_TOO_LONG. The
 * candidate queue crossed that line at 529 MB, which would have stopped the
 * whole harvest dead — reading its own work is the first thing every stage
 * does. Chunked reads have no such ceiling, and a stage that consumes the
 * queue as it goes never holds more than one record.
 */
export function* iterJsonl<T = any>(file: string): Generator<T> {
  if (!existsSync(file)) return;
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = '';
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const text = carry + chunk.toString('utf8', 0, read);
      const lines = text.split('\n');
      // The last piece may be half a record: hold it until the next chunk.
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as T;
        } catch {
          // A torn line from an interrupted run. Nothing to recover.
        }
      }
    }
    const last = carry.trim();
    if (last) {
      try {
        yield JSON.parse(last) as T;
      } catch {
        // The torn final line an interrupted producer leaves behind.
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** Every parseable record in the file, all at once. Only for queues small
 *  enough to hold: prefer iterJsonl for anything a stage produces per page. */
export function readJsonl<T = any>(file: string): T[] {
  return [...iterJsonl<T>(file)];
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

/**
 * How many times each URL has been tried and failed.
 *
 * The crawler cannot mark a URL seen before fetching it — a timeout or a 503
 * would then retire the page permanently — but it also cannot retry a dead URL
 * forever. Counting attempts lets a failure be retried a few times and then
 * given up on.
 */
export class AttemptLog {
  private readonly counts = new Map<string, number>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const key = line.trim();
        if (key) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
    }
  }

  count(url: string): number {
    return this.counts.get(canonicalUrl(url)) ?? 0;
  }

  record(url: string): void {
    const key = canonicalUrl(url);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, key + '\n', 'utf8');
  }
}
