import { describe, it, expect } from 'vitest';
import { batchPages, buildResolvePrompt, parseResolveResponse } from '../harvest/lib/resolve';

const page = (url: string, title = 'Camp dinner', text = 'Boil water, add noodles.') =>
  ({ url, title, text });

describe('batchPages', () => {
  it('splits pages into batches of the given size', () => {
    const pages = Array.from({ length: 25 }, (_, i) => page(`https://x.com/${i}`));
    expect(batchPages(pages, 10).map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it('returns nothing for no pages', () => {
    expect(batchPages([], 10)).toEqual([]);
  });

  it('puts everything in one batch when the size exceeds the input', () => {
    expect(batchPages([page('https://x.com/1')], 10)).toHaveLength(1);
  });
});

describe('buildResolvePrompt', () => {
  const batch = [page('https://x.com/1', 'Ramen Bomb'), page('https://x.com/2', 'Cold Soak Oats')];

  it('numbers each page so the reply can be matched back', () => {
    const p = buildResolvePrompt(batch);
    expect(p).toContain('PAGE 1');
    expect(p).toContain('PAGE 2');
  });

  it('includes each title', () => {
    const p = buildResolvePrompt(batch);
    expect(p).toContain('Ramen Bomb');
    expect(p).toContain('Cold Soak Oats');
  });

  it('does not leak the url into the model prompt', () => {
    // The url is matched back by index. Sending it invites the model to judge
    // the domain's reputation instead of the page's content.
    expect(buildResolvePrompt(batch)).not.toContain('https://x.com/1');
  });

  it('truncates a very long page so one page cannot dominate the batch', () => {
    const huge = page('https://x.com/1', 'Big', 'x'.repeat(50_000));
    expect(buildResolvePrompt([huge]).length).toBeLessThan(10_000);
  });

  it('asks for one json object per page', () => {
    expect(buildResolvePrompt(batch)).toMatch(/json/i);
  });
});

describe('parseResolveResponse', () => {
  const batch = [page('https://x.com/1'), page('https://x.com/2')];

  it('maps verdicts back onto the batch by index', () => {
    const reply = JSON.stringify([
      { page: 1, verdict: 'recipe', ingredients: ['instant ramen', 'cheese'] },
      { page: 2, verdict: 'reject', ingredients: [] },
    ]);
    const out = parseResolveResponse(reply, batch);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://x.com/1');
    expect(out[0].ingredients).toEqual(['instant ramen', 'cheese']);
  });

  it('reads json out of a fenced code block', () => {
    const reply = 'Here you go:\n```json\n[{"page":1,"verdict":"recipe","ingredients":["rice","beans"]}]\n```\nDone.';
    expect(parseResolveResponse(reply, batch)).toHaveLength(1);
  });

  it('returns nothing when the reply is not json at all', () => {
    expect(parseResolveResponse('I could not read those pages.', batch)).toEqual([]);
  });

  it('ignores an entry whose page number is out of range', () => {
    const reply = JSON.stringify([{ page: 99, verdict: 'recipe', ingredients: ['rice', 'beans'] }]);
    expect(parseResolveResponse(reply, batch)).toEqual([]);
  });

  it('drops a recipe verdict that carries no ingredients', () => {
    // Without ingredients the page cannot be deduplicated or transformed, so
    // accepting it would put an unusable record into the corpus.
    const reply = JSON.stringify([{ page: 1, verdict: 'recipe', ingredients: [] }]);
    expect(parseResolveResponse(reply, batch)).toEqual([]);
  });

  it('keeps the adaptable flag when the model sets it', () => {
    const reply = JSON.stringify([
      { page: 1, verdict: 'recipe', ingredients: ['rice', 'beans'], adaptable: true },
    ]);
    expect(parseResolveResponse(reply, batch)[0].adaptable).toBe(true);
  });

  it('survives a single malformed entry among good ones', () => {
    const reply = JSON.stringify([
      { page: 1, verdict: 'recipe', ingredients: ['rice', 'beans'] },
      { verdict: 'recipe' },
    ]);
    expect(parseResolveResponse(reply, batch)).toHaveLength(1);
  });
});
