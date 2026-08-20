/**
 * A polite, caching HTTP getter.
 *
 * Three obligations, all of them the crawler's rather than the caller's:
 * identify ourselves honestly, never fetch the same URL twice, and leave a gap
 * between consecutive requests to one host. The cache is what makes a
 * restarted run cheap; the per-host gap is what keeps a 5,000-page crawl from
 * reading as an attack.
 *
 * `fetchImpl` and `sleep` are injected so politeness is testable without a
 * network or a real clock.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalUrl } from './extract.ts';

export type Page = { url: string; body: string; fromCache: boolean };

export type FetcherOptions = {
  cacheDir: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between two requests to the same host. */
  delayMs?: number;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Content types worth handing to the extractors. Anything else is a download. */
const TEXTUAL = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)/i;

export function createFetcher(opts: FetcherOptions) {
  const {
    cacheDir,
    userAgent,
    fetchImpl = fetch,
    sleep = wait,
    delayMs = 1500,
  } = opts;

  /** Last request time per host, so hosts throttle independently. */
  const lastFetch = new Map<string, number>();

  // Sharded two deep: a flat directory of 5,000+ files is slow to stat on
  // every lookup, and the crawl does nothing but look up.
  const cachePath = (key: string) => {
    const h = createHash('sha256').update(key).digest('hex');
    return join(cacheDir, h.slice(0, 2), h.slice(2, 4), `${h}.html`);
  };

  async function fetchPage(url: string): Promise<Page | null> {
    const key = canonicalUrl(url);
    const path = cachePath(key);

    if (existsSync(path)) {
      return { url: key, body: readFileSync(path, 'utf8'), fromCache: true };
    }

    const host = (() => {
      try { return new URL(key).host; } catch { return key; }
    })();

    const since = Date.now() - (lastFetch.get(host) ?? -Infinity);
    if (since < delayMs) await sleep(delayMs - since);
    lastFetch.set(host, Date.now());

    let body: string;
    try {
      const res = await fetchImpl(key, { headers: { 'User-Agent': userAgent } } as RequestInit);
      if (res.status >= 400) return null;
      const type = res.headers.get('content-type') ?? 'text/html';
      if (!TEXTUAL.test(type)) return null;
      body = await res.text();
    } catch {
      // A dead host or a reset connection is one lost page, not a lost run.
      return null;
    }

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body, 'utf8');
    return { url: key, body, fromCache: false };
  }

  return { fetchPage };
}
