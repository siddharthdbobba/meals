import { describe, it, expect } from 'vitest';
import { looksLikeRecipeUrl, planDomains, sameSite } from '../harvest/lib/plan';

describe('looksLikeRecipeUrl', () => {
  it('accepts a path that names a recipe section', () => {
    expect(looksLikeRecipeUrl('https://x.com/recipes/dutch-oven-chili')).toBe(true);
  });

  it('accepts recipe-adjacent vocabulary in the slug', () => {
    expect(looksLikeRecipeUrl('https://x.com/blog/best-backpacking-meal-ideas')).toBe(true);
  });

  it('rejects a path with no food signal at all', () => {
    expect(looksLikeRecipeUrl('https://x.com/about/our-team')).toBe(false);
  });

  it('rejects site furniture even when the slug mentions food', () => {
    expect(looksLikeRecipeUrl('https://x.com/tag/recipes')).toBe(false);
    expect(looksLikeRecipeUrl('https://x.com/category/recipes/page/4')).toBe(false);
    expect(looksLikeRecipeUrl('https://x.com/author/recipes')).toBe(false);
  });

  it('rejects non-page assets', () => {
    expect(looksLikeRecipeUrl('https://x.com/recipes/chili.jpg')).toBe(false);
    expect(looksLikeRecipeUrl('https://x.com/feed/recipes.xml')).toBe(false);
  });

  it('rejects a bare domain', () => {
    expect(looksLikeRecipeUrl('https://x.com/')).toBe(false);
  });

  it('ignores case in the path', () => {
    expect(looksLikeRecipeUrl('https://x.com/Recipes/Chili')).toBe(true);
  });
});

describe('sameSite', () => {
  it('accepts a url on the same host', () => {
    expect(sameSite('https://x.com/a', 'https://x.com/b')).toBe(true);
  });

  it('accepts the www variant of the same host', () => {
    expect(sameSite('https://x.com/a', 'https://www.x.com/b')).toBe(true);
  });

  it('rejects a different host', () => {
    expect(sameSite('https://x.com/a', 'https://y.com/b')).toBe(false);
  });

  it('rejects a subdomain that is not www', () => {
    expect(sameSite('https://x.com/a', 'https://shop.x.com/b')).toBe(false);
  });
});

describe('planDomains', () => {
  const lead = (domain: string, url: string, est = 10) =>
    ({ domain, url, est_recipe_count: est, type: 'blog' });

  it('groups several leads on one domain into a single crawl target', () => {
    const plan = planDomains([lead('x.com', 'https://x.com/a'), lead('x.com', 'https://x.com/b')]);
    expect(plan).toHaveLength(1);
    expect(plan[0].seeds).toEqual(['https://x.com/a', 'https://x.com/b']);
  });

  it('orders targets by total estimated recipes, richest first', () => {
    const plan = planDomains([lead('small.com', 'https://small.com/a', 5), lead('big.com', 'https://big.com/a', 500)]);
    expect(plan.map((t) => t.domain)).toEqual(['big.com', 'small.com']);
  });

  it('sums the estimates of every lead on a domain', () => {
    const plan = planDomains([lead('x.com', 'https://x.com/a', 10), lead('x.com', 'https://x.com/b', 30)]);
    expect(plan[0].estimate).toBe(40);
  });

  it('drops a duplicate seed url', () => {
    const plan = planDomains([lead('x.com', 'https://x.com/a'), lead('x.com', 'https://x.com/a?utm_source=g')]);
    expect(plan[0].seeds).toEqual(['https://x.com/a']);
  });

  it('drops a lead whose url will not parse', () => {
    expect(planDomains([lead('x.com', 'nonsense')])).toEqual([]);
  });

  it('caps how many pages one domain may contribute so no single site dominates', () => {
    const plan = planDomains([lead('x.com', 'https://x.com/a', 100_000)], { perDomainCap: 400 });
    expect(plan[0].cap).toBe(400);
  });
});
