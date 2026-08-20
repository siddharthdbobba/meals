import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendJsonl, readJsonl, SeenSet } from '../harvest/lib/queue';
import { createFetcher } from '../harvest/lib/fetcher';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harvest-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// -------------------------------------------------------------------- queue

describe('appendJsonl and readJsonl', () => {
  it('round-trips records through a file', () => {
    const f = join(dir, 'q.jsonl');
    appendJsonl(f, { url: 'https://x.com/a' });
    appendJsonl(f, { url: 'https://x.com/b' });
    expect(readJsonl(f)).toEqual([{ url: 'https://x.com/a' }, { url: 'https://x.com/b' }]);
  });

  it('writes exactly one line per record', () => {
    const f = join(dir, 'q.jsonl');
    appendJsonl(f, { a: 1 });
    appendJsonl(f, { b: 2 });
    expect(readFileSync(f, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it('creates the file and its parent directory on first append', () => {
    const f = join(dir, 'nested', 'deep', 'q.jsonl');
    appendJsonl(f, { a: 1 });
    expect(readJsonl(f)).toEqual([{ a: 1 }]);
  });

  it('returns nothing for a file that does not exist', () => {
    expect(readJsonl(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('skips a truncated final line rather than throwing', () => {
    const f = join(dir, 'q.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":', 'utf8');
    expect(readJsonl(f)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('SeenSet', () => {
  it('reports a url as unseen before it is added', () => {
    expect(new SeenSet(join(dir, 'seen')).has('https://x.com/a')).toBe(false);
  });

  it('reports a url as seen after it is added', () => {
    const s = new SeenSet(join(dir, 'seen'));
    s.add('https://x.com/a');
    expect(s.has('https://x.com/a')).toBe(true);
  });

  it('treats urls that canonicalise the same as one url', () => {
    const s = new SeenSet(join(dir, 'seen'));
    s.add('https://x.com/a?utm_source=g');
    expect(s.has('https://X.com/a/#top')).toBe(true);
  });

  it('survives a restart by reloading from disk', () => {
    const path = join(dir, 'seen');
    new SeenSet(path).add('https://x.com/a');
    expect(new SeenSet(path).has('https://x.com/a')).toBe(true);
  });

  it('reports adding a duplicate so a caller can skip work', () => {
    const s = new SeenSet(join(dir, 'seen'));
    expect(s.add('https://x.com/a')).toBe(true);
    expect(s.add('https://x.com/a')).toBe(false);
  });
});

// ------------------------------------------------------------------ fetcher

/** A stand-in for `fetch` that records calls and replies from a script. */
function stubFetch(replies: Record<string, { status?: number; body?: string; type?: string }>) {
  const calls: { url: string; ua: string }[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] ?? '' });
    const r = replies[url] ?? { status: 404, body: '' };
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (r.type ?? 'text/html') : null) },
      text: async () => r.body ?? '',
    } as any;
  };
  return { impl, calls };
}

function sleepSpy() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

describe('createFetcher', () => {
  it('returns the body of a successful fetch', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: '<p>hi</p>' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'mealbot', fetchImpl: net.impl });
    expect((await f.fetchPage('https://x.com/a'))?.body).toBe('<p>hi</p>');
  });

  it('sends the configured user agent', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: 'hi' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'mealbot/1.0', fetchImpl: net.impl });
    await f.fetchPage('https://x.com/a');
    expect(net.calls[0].ua).toBe('mealbot/1.0');
  });

  it('serves a repeated url from cache without touching the network', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: 'hi' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'mealbot', fetchImpl: net.impl });
    await f.fetchPage('https://x.com/a');
    const second = await f.fetchPage('https://x.com/a');
    expect(net.calls).toHaveLength(1);
    expect(second).toMatchObject({ body: 'hi', fromCache: true });
  });

  it('shares one cache entry between a url and its canonical twin', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: 'hi' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'mealbot', fetchImpl: net.impl });
    await f.fetchPage('https://x.com/a');
    await f.fetchPage('https://x.com/a?utm_source=g');
    expect(net.calls).toHaveLength(1);
  });

  it('reuses a cache written by an earlier run', async () => {
    const first = stubFetch({ 'https://x.com/a': { body: 'hi' } });
    await createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: first.impl }).fetchPage('https://x.com/a');
    const second = stubFetch({});
    const again = await createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: second.impl }).fetchPage('https://x.com/a');
    expect(second.calls).toHaveLength(0);
    expect(again?.body).toBe('hi');
  });

  it('returns null for a non-success status', async () => {
    const net = stubFetch({ 'https://x.com/a': { status: 500, body: 'boom' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: net.impl });
    expect(await f.fetchPage('https://x.com/a')).toBeNull();
  });

  it('returns null for a non-html content type', async () => {
    const net = stubFetch({ 'https://x.com/a.jpg': { body: 'binary', type: 'image/jpeg' } });
    const f = createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: net.impl });
    expect(await f.fetchPage('https://x.com/a.jpg')).toBeNull();
  });

  it('returns null when the network throws rather than propagating', async () => {
    const f = createFetcher({
      cacheDir: dir, userAgent: 'm',
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    expect(await f.fetchPage('https://x.com/a')).toBeNull();
  });

  it('waits between two fetches to the same host', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: '1' }, 'https://x.com/b': { body: '2' } });
    const s = sleepSpy();
    const f = createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: net.impl, sleep: s.sleep, delayMs: 1000 });
    await f.fetchPage('https://x.com/a');
    await f.fetchPage('https://x.com/b');
    // The gap is `delay minus time already elapsed`, so the exact figure moves
    // with real clock time under load. What must hold is that it waited once,
    // for very nearly the full delay.
    expect(s.waits).toHaveLength(1);
    expect(s.waits[0]).toBeGreaterThan(900);
    expect(s.waits[0]).toBeLessThanOrEqual(1000);
  });

  it('does not make one host wait for another', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: '1' }, 'https://y.com/b': { body: '2' } });
    const s = sleepSpy();
    const f = createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: net.impl, sleep: s.sleep, delayMs: 1000 });
    await f.fetchPage('https://x.com/a');
    await f.fetchPage('https://y.com/b');
    expect(s.waits).toEqual([]);
  });

  it('does not wait before serving a cache hit', async () => {
    const net = stubFetch({ 'https://x.com/a': { body: '1' } });
    const s = sleepSpy();
    const f = createFetcher({ cacheDir: dir, userAgent: 'm', fetchImpl: net.impl, sleep: s.sleep, delayMs: 1000 });
    await f.fetchPage('https://x.com/a');
    await f.fetchPage('https://x.com/a');
    expect(s.waits).toEqual([]);
  });
});
