import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  bucket, derive, facetsFor, matches, matchesSearch, matchRanges, highlight, isFilterEmpty,
  isFacetActive, activeFacetCount, encodeFilters, decodeFilters, sortMetrics, compareBy,
  type MealInput,
} from '../lib/meals';
import {
  FACETS, FACET_KEYS, TRIP_STYLES, SLOTS, HEAT_SOURCES, CLEANUP,
  DIETARY, HOME_PREP, SHELF_LIFE, SKILL, COST,
} from '../data/meals';
import { mealFields } from '../schema';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const mealsDir = join(root, 'content');

const validValues: Record<string, string[]> = Object.fromEntries(
  FACETS.map((f) => [f.key, f.options.map((o) => o.value)]),
);

/** A minimal valid recipe. Tests override only the fields they care about, so
 *  a schema addition does not force every test to be rewritten. */
function meal(overrides: Partial<MealInput> = {}): MealInput {
  return {
    title: 'Test Meal',
    blurb: 'A meal for testing.',
    tripStyle: ['backpacking'],
    slot: ['dinner'],
    heatSource: ['canister-stove'],
    prepMinutes: 2,
    cookMinutes: 8,
    caloriesPerServing: 700,
    ouncesPerServing: 6,
    proteinGrams: 20,
    water: 'boiled',
    waterMl: 400,
    cleanup: 'one-pot',
    dietary: ['vegetarian'],
    homePrep: 'premix',
    shelfLife: 'shelf-stable',
    servings: 1,
    scalable: true,
    skill: 'dump-and-stir',
    cost: '$$',
    ingredients: [{ item: 'Ramen', amount: '1 block' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------- derived math

describe('bucket', () => {
  it('is inclusive at the lower edge and exclusive at the upper', () => {
    const names = ['low', 'mid', 'high'];
    expect(bucket(99, [100, 125], names)).toBe('low');
    expect(bucket(100, [100, 125], names)).toBe('mid');
    expect(bucket(124, [100, 125], names)).toBe('mid');
    expect(bucket(125, [100, 125], names)).toBe('high');
  });

  it('rejects a mismatched number of names', () => {
    expect(() => bucket(1, [10], ['a', 'b', 'c'])).toThrow();
  });
});

describe('derive', () => {
  it('computes calories per ounce, rounded', () => {
    expect(derive(meal({ caloriesPerServing: 700, ouncesPerServing: 6 })).caloriesPerOunce).toBe(117);
    expect(derive(meal({ caloriesPerServing: 500, ouncesPerServing: 4 })).caloriesPerOunce).toBe(125);
  });

  it('sums prep and cook time', () => {
    expect(derive(meal({ prepMinutes: 12, cookMinutes: 20 })).totalMinutes).toBe(32);
  });

  it('buckets time at its boundaries', () => {
    const at = (n: number) => derive(meal({ prepMinutes: n, cookMinutes: 0 })).timeBucket;
    expect(at(4)).toBe('lt5');
    expect(at(5)).toBe('5-15');
    expect(at(14)).toBe('5-15');
    expect(at(15)).toBe('15-30');
    expect(at(29)).toBe('15-30');
    expect(at(30)).toBe('30plus');
  });

  it('buckets calories per ounce at 100 and 125', () => {
    const at = (cal: number) => derive(meal({ caloriesPerServing: cal, ouncesPerServing: 1 })).calOzBucket;
    expect(at(99)).toBe('lt100');
    expect(at(100)).toBe('100-125');
    expect(at(124)).toBe('100-125');
    expect(at(125)).toBe('125plus');
  });

  it('buckets calories and protein at their boundaries', () => {
    expect(derive(meal({ caloriesPerServing: 400 })).calorieBucket).toBe('400-700');
    expect(derive(meal({ caloriesPerServing: 700 })).calorieBucket).toBe('700plus');
    expect(derive(meal({ proteinGrams: 10 })).proteinBucket).toBe('10-20');
    expect(derive(meal({ proteinGrams: 20 })).proteinBucket).toBe('20plus');
  });

});

// -------------------------------------------------------------- filter logic

describe('matches', () => {
  const facets = facetsFor(meal({
    tripStyle: ['backpacking', 'thru-hike'],
    slot: ['dinner'],
    heatSource: ['canister-stove'],
  }));

  it('ORs within a facet', () => {
    expect(matches(facets, { slot: ['breakfast', 'dinner'] })).toBe(true);
    expect(matches(facets, { slot: ['breakfast', 'lunch'] })).toBe(false);
  });

  it('ANDs across facets', () => {
    expect(matches(facets, { slot: ['dinner'], heat: ['canister-stove'] })).toBe(true);
    expect(matches(facets, { slot: ['dinner'], heat: ['no-cook'] })).toBe(false);
  });

  it('matches array facets on intersection', () => {
    expect(matches(facets, { style: ['backpacking'] })).toBe(true);
    expect(matches(facets, { style: ['thru-hike'] })).toBe(true);
    expect(matches(facets, { style: ['paddle'] })).toBe(false);
  });

  it('treats an empty facet as inactive', () => {
    expect(matches(facets, { slot: [], heat: [] })).toBe(true);
    expect(matches(facets, {})).toBe(true);
  });

});

describe('matchesSearch', () => {
  const hay = 'couscous bowl olive oil sun dried tomato';

  it('matches every term, in any order', () => {
    expect(matchesSearch(hay, 'tomato couscous')).toBe(true);
    expect(matchesSearch(hay, 'couscous salmon')).toBe(false);
  });

  it('treats an empty query as no filter', () => {
    expect(matchesSearch(hay, '   ')).toBe(true);
  });
});

describe('highlight', () => {
  const text = 'Cold Soak Couscous with Sun-Dried Tomato';

  it('finds every occurrence of every term', () => {
    expect(matchRanges(text, 'soak')).toEqual([[5, 9]]);
    expect(matchRanges(text, 'co')).toEqual([[0, 2], [10, 12], [14, 16]]);
  });

  it('matches case-insensitively but reports ranges into the original text', () => {
    const [[start, end]] = matchRanges(text, 'COUSCOUS');
    expect(text.slice(start, end)).toBe('Couscous');
  });

  it('merges overlapping hits from different terms into one span', () => {
    expect(matchRanges('couscous', 'cous couscous')).toEqual([[0, 8]]);
  });

  it('returns nothing for a blank or unmatched query', () => {
    expect(matchRanges(text, '   ')).toEqual([]);
    expect(matchRanges(text, 'salmon')).toEqual([]);
  });

  it('segments the text without losing or duplicating a character', () => {
    const segments = highlight(text, 'soak tomato');
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['Soak', 'Tomato']);
  });

  it('yields one untouched segment when there is nothing to paint', () => {
    expect(highlight(text, '')).toEqual([{ text, hit: false }]);
  });

  it('handles a hit at either edge', () => {
    expect(highlight('abc', 'a')).toEqual([
      { text: 'a', hit: true },
      { text: 'bc', hit: false },
    ]);
    expect(highlight('abc', 'c')).toEqual([
      { text: 'ab', hit: false },
      { text: 'c', hit: true },
    ]);
  });

  it('lights up exactly what made the card match', () => {
    const query = 'cold couscous';
    expect(matchesSearch(text.toLowerCase(), query)).toBe(true);
    expect(highlight(text, query).filter((s) => s.hit).map((s) => s.text))
      .toEqual(['Cold', 'Couscous']);
  });
});

describe('facet activity', () => {
  const all = { slot: [...SLOTS], heat: [...HEAT_SOURCES] };

  it('treats a full facet and an empty facet alike: neither narrows anything', () => {
    expect(isFacetActive([...SLOTS], [...SLOTS])).toBe(false);
    expect(isFacetActive([], [...SLOTS])).toBe(false);
    expect(isFacetActive(undefined, [...SLOTS])).toBe(false);
    expect(isFacetActive(['dinner'], [...SLOTS])).toBe(true);
  });

  it('counts only the facets that are narrowing', () => {
    expect(activeFacetCount({ slot: [...SLOTS], heat: ['no-cook'] }, all, ['slot', 'heat'])).toBe(1);
    expect(activeFacetCount({ slot: ['lunch'], heat: ['no-cook'] }, all, ['slot', 'heat'])).toBe(2);
  });

  it('is empty when nothing narrows and there is no query', () => {
    expect(isFilterEmpty({ slot: [...SLOTS] }, all, '')).toBe(true);
    expect(isFilterEmpty({}, all, '')).toBe(true);
    expect(isFilterEmpty({ slot: ['dinner'] }, all, '')).toBe(false);
    expect(isFilterEmpty({}, all, 'ramen')).toBe(false);
  });
});

// ------------------------------------------------------------- URL round trip

describe('filter URL codec', () => {
  it('round-trips a narrowed filter state', () => {
    const state = { slot: ['breakfast', 'dinner'], heat: ['no-cook'], diet: ['vegan'] };
    const decoded = decodeFilters(encodeFilters(state, 'weight', 'ramen', validValues), validValues);
    for (const [key, values] of Object.entries(state)) {
      expect(decoded.filter[key], key).toEqual(values);
    }
    expect(decoded.sort).toBe('weight');
    expect(decoded.query).toBe('ramen');
  });

  it('omits facets that are not narrowing, and the default sort', () => {
    expect(encodeFilters({ slot: [] }, 'cal-oz', '', validValues)).toBe('');
    expect(encodeFilters({ slot: [...SLOTS] }, 'cal-oz', '', validValues)).toBe('');
    expect(encodeFilters({ slot: ['lunch'] }, 'cal-oz', '', validValues)).toBe('?slot=lunch');
  });

  it('defaults an unmentioned facet to every option, which is the opening state', () => {
    const decoded = decodeFilters('?slot=lunch', validValues);
    expect(decoded.filter.slot).toEqual(['lunch']);
    expect(decoded.filter.heat).toEqual([...HEAT_SOURCES]);
  });

  it('drops unknown keys and unknown values', () => {
    const decoded = decodeFilters('?slot=breakfast,nonsense&bogus=x&sort=fake', validValues);
    expect(decoded.filter.slot).toEqual(['breakfast']);
    expect(decoded.sort).toBe('cal-oz');
  });

  it('falls back to every option when a facet names only unknown values', () => {
    expect(decodeFilters('?slot=nonsense', validValues).filter.slot).toEqual([...SLOTS]);
  });
});

// -------------------------------------------------------------------- sorting

describe('compareBy', () => {
  const a = sortMetrics(meal({ title: 'Alpha', caloriesPerServing: 600, ouncesPerServing: 6, prepMinutes: 0, cookMinutes: 20 }));
  const b = sortMetrics(meal({ title: 'Beta', caloriesPerServing: 800, ouncesPerServing: 5, prepMinutes: 0, cookMinutes: 5 }));

  it('sorts calories per ounce descending by default', () => {
    expect(compareBy('cal-oz', a, b)).toBeGreaterThan(0);
  });

  it('sorts weight and time ascending', () => {
    expect(compareBy('weight', a, b)).toBeGreaterThan(0);
    expect(compareBy('time', a, b)).toBeGreaterThan(0);
  });

  it('falls back to title for ties', () => {
    const x = sortMetrics(meal({ title: 'Alpha' }));
    const y = sortMetrics(meal({ title: 'Zulu' }));
    expect(compareBy('cal-oz', x, y)).toBeLessThan(0);
  });
});

// ------------------------------------------------- content: schema and coverage

/** The one schema definition, shared with the consuming site's content config. */
const mealSchema = z.object(mealFields(z));

/** A deliberately small YAML reader: enough for the subset of YAML the recipe
 *  frontmatter uses (scalars, inline arrays, and lists of one-level maps), and
 *  no dependency added to the project for a test. */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('no frontmatter');
  const lines = match[1].split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));

  const scalar = (v: string): unknown => {
    const t = v.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^\[.*\]$/.test(t)) {
      const inner = t.slice(1, -1).trim();
      return inner ? inner.split(',').map((s) => scalar(s)) : [];
    }
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"');
    }
    return t;
  };

  const out: Record<string, unknown> = {};
  let key: string | null = null;
  let list: unknown[] | null = null;
  let item: Record<string, unknown> | null = null;

  const flush = () => {
    if (key && list) {
      if (item) { list.push(item); item = null; }
      out[key] = list;
      list = null;
    }
  };

  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (indent === 0 && /^[A-Za-z][\w]*:/.test(text)) {
      flush();
      const [, k, rest] = text.match(/^([A-Za-z][\w]*):\s*(.*)$/)!;
      if (rest === '') { key = k; list = []; } else { out[k] = scalar(rest); key = null; }
      continue;
    }

    if (text.startsWith('- ')) {
      if (!list) continue;
      if (item) { list.push(item); item = null; }
      const rest = text.slice(2);
      const kv = rest.match(/^([A-Za-z][\w]*):\s*(.*)$/);
      if (kv) { item = { [kv[1]]: scalar(kv[2]) }; } else { list.push(scalar(rest)); }
      continue;
    }

    const kv = text.match(/^([A-Za-z][\w]*):\s*(.*)$/);
    if (kv && item) item[kv[1]] = scalar(kv[2]);
  }
  flush();
  return out;
}

const files = readdirSync(mealsDir).filter((f) => f.endsWith('.md'));
const recipes = files.map((f) => ({
  file: f,
  data: mealSchema.parse(parseFrontmatter(readFileSync(join(mealsDir, f), 'utf8'))),
}));
const live = recipes.filter((r) => !r.data.draft).map((r) => r.data);

describe('meal content', () => {
  it('has recipes to filter', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files)('%s conforms to the schema', (file) => {
    expect(() => mealSchema.parse(parseFrontmatter(readFileSync(join(mealsDir, file), 'utf8')))).not.toThrow();
  });

  it('gives every recipe a sane calories-per-ounce figure', () => {
    for (const r of live) {
      const calOz = derive(r as unknown as MealInput).caloriesPerOunce;
      expect(calOz, r.title).toBeGreaterThan(30);
      expect(calOz, r.title).toBeLessThan(230);
    }
  });

  it('never claims a no-cook recipe needs boiled water', () => {
    for (const r of live) {
      if (r.heatSource.includes('no-cook')) expect(r.water, r.title).not.toBe('boiled');
    }
  });

  it('keeps vegan recipes vegetarian too', () => {
    for (const r of live) {
      if (r.dietary.includes('vegan')) expect(r.dietary, r.title).toContain('vegetarian');
    }
  });

  it('leaves no core facet option with an empty result set', () => {
    for (const facet of FACETS.filter((f) => f.group === 'core')) {
      for (const option of facet.options) {
        const hits = live.filter((r) => matches(facetsFor(r as unknown as MealInput), { [facet.key]: [option.value] }));
        expect(hits.length, `${facet.key}=${option.value}`).toBeGreaterThan(0);
      }
    }
  });

  it('covers the combinations people actually ask for', () => {
    const count = (filter: Record<string, string[]>) =>
      live.filter((r) => matches(facetsFor(r as unknown as MealInput), filter)).length;

    expect(count({ heat: ['no-cook'] }), 'no-cook').toBeGreaterThanOrEqual(3);
    expect(count({ heat: ['cold-soak'] }), 'cold-soak').toBeGreaterThanOrEqual(2);
    expect(count({ diet: ['vegetarian'] }), 'vegetarian').toBeGreaterThanOrEqual(3);
    expect(count({ diet: ['vegan'] }), 'vegan').toBeGreaterThanOrEqual(2);
    expect(count({ slot: ['breakfast'] }), 'breakfast').toBeGreaterThanOrEqual(3);
    expect(count({ slot: ['dessert'] }), 'dessert').toBeGreaterThanOrEqual(2);
    expect(count({ slot: ['drink'] }), 'drink').toBeGreaterThanOrEqual(2);
    expect(count({ style: ['car-camping'], heat: ['dutch-oven', 'campfire'] }), 'car camping over fire')
      .toBeGreaterThanOrEqual(2);
  });
});

describe('facet vocabulary', () => {
  it('has unique facet keys', () => {
    expect(new Set(FACET_KEYS).size).toBe(FACET_KEYS.length);
  });

  it('has unique option values inside each facet', () => {
    for (const f of FACETS) {
      const values = f.options.map((o) => o.value);
      expect(new Set(values).size, f.key).toBe(values.length);
    }
  });

  it('labels every option', () => {
    for (const f of FACETS) {
      for (const o of f.options) expect(o.label, `${f.key}.${o.value}`).toBeTruthy();
    }
  });

  it('has no filter for the fields that are facts on the page but not questions people ask', () => {
    expect(FACET_KEYS).not.toContain('water');
    expect(FACET_KEYS).not.toContain('serves');
    expect(FACET_KEYS).not.toContain('season');
  });

  it('mirrors the schema: every enum tuple that is filterable is reachable from a facet', () => {
    const byKey = Object.fromEntries(FACETS.map((f) => [f.key, f.options.map((o) => o.value)]));
    expect(byKey.style).toEqual([...TRIP_STYLES]);
    expect(byKey.slot).toEqual([...SLOTS]);
    expect(byKey.heat).toEqual([...HEAT_SOURCES]);
    expect(byKey.cleanup).toEqual([...CLEANUP]);
    expect(byKey.diet).toEqual([...DIETARY]);
    expect(byKey.prep).toEqual([...HOME_PREP]);
    expect(byKey.shelf).toEqual([...SHELF_LIFE]);
    expect(byKey.skill).toEqual([...SKILL]);
    expect(byKey.cost).toEqual([...COST]);
  });
});
