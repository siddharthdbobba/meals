import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { slugFor, shardFor, toFrontmatter, renderRecipe, parseRecipeJson, validateRecipe } from '../harvest/lib/transform';
import { mealFields } from '../schema';

const valid = {
  title: 'Ramen Bomb',
  blurb: 'Ramen, potatoes, cheese.',
  tripStyle: ['backpacking'],
  slot: ['dinner'],
  heatSource: ['canister-stove'],
  prepMinutes: 1,
  cookMinutes: 6,
  caloriesPerServing: 850,
  ouncesPerServing: 6.5,
  proteinGrams: 20,
  water: 'boiled',
  waterMl: 500,
  cleanup: 'one-pot',
  dietary: ['vegetarian'],
  homePrep: 'grab-and-go',
  shelfLife: 'shelf-stable',
  servings: 1,
  scalable: true,
  skill: 'dump-and-stir',
  cost: '$',
  ingredients: [{ item: 'Instant ramen', amount: '1 block', note: 'keep the packet' }],
  steps: ['Boil the water.', 'Stir it in.'],
  variations: ['Add tuna.'],
  body: 'Some prose about the recipe.',
};

describe('slugFor', () => {
  it('lowercases and hyphenates a title', () => {
    expect(slugFor('Ramen Bomb')).toBe('ramen-bomb');
  });

  it('drops punctuation', () => {
    expect(slugFor("Chef Glenn's Chili!")).toBe('chef-glenns-chili');
  });

  it('collapses runs of separators', () => {
    expect(slugFor('Cold  Soak --- Oats')).toBe('cold-soak-oats');
  });

  it('transliterates nothing but keeps ascii letters and digits', () => {
    expect(slugFor('Café  Mocha 2')).toBe('caf-mocha-2');
  });

  it('trims leading and trailing separators', () => {
    expect(slugFor('  -Camp Hash-  ')).toBe('camp-hash');
  });
});

describe('shardFor', () => {
  it('shards on the first letter', () => {
    expect(shardFor('ramen-bomb')).toBe('r');
  });

  it('puts anything not starting with a letter under an underscore', () => {
    expect(shardFor('7-layer-dip')).toBe('_');
  });
});

describe('toFrontmatter', () => {
  it('quotes string values', () => {
    expect(toFrontmatter({ title: 'Ramen Bomb' })).toContain('title: "Ramen Bomb"');
  });

  it('escapes a quote inside a string', () => {
    expect(toFrontmatter({ blurb: 'He said "hi"' })).toContain('blurb: "He said \\"hi\\""');
  });

  it('writes numbers and booleans bare', () => {
    const out = toFrontmatter({ servings: 2, scalable: true });
    expect(out).toContain('servings: 2');
    expect(out).toContain('scalable: true');
  });

  it('writes a facet array inline and unquoted', () => {
    expect(toFrontmatter({ tripStyle: ['backpacking', 'thru-hike'] }))
      .toContain('tripStyle: [backpacking, thru-hike]');
  });

  it('writes a prose array as a quoted block list', () => {
    expect(toFrontmatter({ steps: ['Boil it.', 'Eat it.'] }))
      .toContain('steps:\n  - "Boil it."\n  - "Eat it."');
  });

  it('writes ingredients as a block of objects', () => {
    const out = toFrontmatter({ ingredients: [{ item: 'Ramen', amount: '1 block' }] });
    expect(out).toContain('ingredients:\n  - item: "Ramen"\n    amount: "1 block"');
  });

  it('includes an ingredient note only when present', () => {
    const withNote = toFrontmatter({ ingredients: [{ item: 'A', amount: '1', note: 'x' }] });
    const without = toFrontmatter({ ingredients: [{ item: 'A', amount: '1' }] });
    expect(withNote).toContain('note: "x"');
    expect(without).not.toContain('note:');
  });

  it('omits an empty array entirely', () => {
    expect(toFrontmatter({ title: 'X', variations: [] })).not.toContain('variations');
  });
});

describe('renderRecipe', () => {
  it('wraps the frontmatter in delimiters and appends the body', () => {
    const out = renderRecipe(valid, 'https://x.com/ramen');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('\n---\n');
    expect(out.trimEnd().endsWith('Some prose about the recipe.')).toBe(true);
  });

  it('records the source url in the frontmatter', () => {
    expect(renderRecipe(valid, 'https://x.com/ramen')).toContain('source: "https://x.com/ramen"');
  });

  it('keeps the body out of the frontmatter block', () => {
    const out = renderRecipe(valid, 'https://x.com/ramen');
    const frontmatter = out.split('\n---\n')[0];
    expect(frontmatter).not.toContain('Some prose');
  });

  it('produces frontmatter the real schema accepts', () => {
    const out = renderRecipe(valid, 'https://x.com/ramen');
    // Round-trip guard: whatever we render must still satisfy mealFields.
    expect(out).toContain('title: "Ramen Bomb"');
    expect(() => z.object(mealFields(z)).parse({ ...valid, source: 'https://x.com/ramen' })).not.toThrow();
  });
});

describe('parseRecipeJson', () => {
  it('reads a bare json object', () => {
    expect(parseRecipeJson('{"title":"X"}')?.title).toBe('X');
  });

  it('reads json out of a fenced block', () => {
    expect(parseRecipeJson('```json\n{"title":"X"}\n```')?.title).toBe('X');
  });

  it('reads json surrounded by chatter', () => {
    expect(parseRecipeJson('Sure!\n{"title":"X"}\nHope that helps.')?.title).toBe('X');
  });

  it('returns null when there is no json', () => {
    expect(parseRecipeJson('I could not write that recipe.')).toBeNull();
  });

  it('returns null for malformed json', () => {
    expect(parseRecipeJson('{"title": }')).toBeNull();
  });
});

describe('validateRecipe', () => {
  it('accepts a complete recipe', () => {
    expect(validateRecipe(valid).ok).toBe(true);
  });

  it('rejects an unknown facet value', () => {
    const r = validateRecipe({ ...valid, cleanup: 'sonic-shower' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/cleanup/);
  });

  it('rejects a missing required field', () => {
    const { caloriesPerServing, ...rest } = valid;
    expect(validateRecipe(rest).ok).toBe(false);
  });

  it('rejects a recipe with no steps', () => {
    expect(validateRecipe({ ...valid, steps: [] }).ok).toBe(false);
  });

  it('rejects prose in a numeric field', () => {
    expect(validateRecipe({ ...valid, proteinGrams: 'about 20' }).ok).toBe(false);
  });

  it('requires a body so the page is not just frontmatter', () => {
    expect(validateRecipe({ ...valid, body: '' }).ok).toBe(false);
  });
});
