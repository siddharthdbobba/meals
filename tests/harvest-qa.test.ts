import { describe, it, expect } from 'vitest';
import { facetViolations, plausibilityViolations, ngramOverlap, qaVerdict } from '../harvest/lib/qa';

const base = {
  title: 'Test Meal',
  blurb: 'A meal.',
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
  dietary: [] as string[],
  homePrep: 'premix',
  shelfLife: 'shelf-stable',
  servings: 1,
  scalable: true,
  skill: 'dump-and-stir',
  cost: '$$',
  ingredients: [{ item: 'Instant rice', amount: '1 cup' }],
  steps: ['Boil it.'],
  body: 'Prose.',
};
const meal = (o: Partial<typeof base> = {}) => ({ ...base, ...o });

describe('facetViolations', () => {
  it('passes a coherent recipe', () => {
    expect(facetViolations(meal())).toEqual([]);
  });

  it('catches cold soak that claims boiled water', () => {
    const v = facetViolations(meal({ heatSource: ['cold-soak'], water: 'boiled' }));
    expect(v.join(' ')).toMatch(/cold.soak/i);
  });

  it('catches no-cook that claims cook time', () => {
    const v = facetViolations(meal({ heatSource: ['no-cook'], cookMinutes: 10 }));
    expect(v.join(' ')).toMatch(/no-cook/i);
  });

  it('catches water none with a water volume', () => {
    expect(facetViolations(meal({ water: 'none', waterMl: 300 })).length).toBeGreaterThan(0);
  });

  it('catches boiled water with no volume', () => {
    expect(facetViolations(meal({ water: 'boiled', waterMl: 0 })).length).toBeGreaterThan(0);
  });

  it('catches a dutch oven carried on a thru-hike', () => {
    const v = facetViolations(meal({ heatSource: ['dutch-oven'], tripStyle: ['thru-hike'] }));
    expect(v.join(' ')).toMatch(/dutch/i);
  });

  it('catches a cooler-dependent meal on a thru-hike', () => {
    const v = facetViolations(meal({ shelfLife: 'cooler', tripStyle: ['thru-hike'] }));
    expect(v.join(' ')).toMatch(/cooler|shelf/i);
  });

  it('catches vegan claimed over dairy', () => {
    const v = facetViolations(meal({
      dietary: ['vegan'],
      ingredients: [{ item: 'Cheddar cheese', amount: '1 oz' }],
    }));
    expect(v.join(' ')).toMatch(/vegan/i);
  });

  it('catches vegetarian claimed over meat', () => {
    const v = facetViolations(meal({
      dietary: ['vegetarian'],
      ingredients: [{ item: 'Summer sausage', amount: '2 oz' }],
    }));
    expect(v.join(' ')).toMatch(/vegetarian/i);
  });

  it('catches gluten free claimed over couscous', () => {
    const v = facetViolations(meal({
      dietary: ['gluten-free'],
      ingredients: [{ item: 'Instant couscous', amount: '1/2 cup' }],
    }));
    expect(v.join(' ')).toMatch(/gluten/i);
  });

  it('does not flag vegan honey-free food as vegan violation', () => {
    expect(facetViolations(meal({
      dietary: ['vegan'],
      ingredients: [{ item: 'Instant rice', amount: '1 cup' }, { item: 'Olive oil', amount: '1 tbsp' }],
    }))).toEqual([]);
  });
});

describe('plausibilityViolations', () => {
  it('passes ordinary numbers', () => {
    expect(plausibilityViolations(meal())).toEqual([]);
  });

  it('catches an impossible calorie density', () => {
    // Pure fat is about 250 cal/oz; nothing a person carries beats that.
    expect(plausibilityViolations(meal({ caloriesPerServing: 3000, ouncesPerServing: 2 })).length)
      .toBeGreaterThan(0);
  });

  it('catches a calorie density too low for food carried on your back', () => {
    expect(plausibilityViolations(meal({
      tripStyle: ['backpacking'], shelfLife: 'shelf-stable',
      caloriesPerServing: 50, ouncesPerServing: 10,
    })).length).toBeGreaterThan(0);
  });

  it('allows a watery car-camping dish to be watery', () => {
    // Corn on the cob really is about 35 cal/oz. The density floor exists to
    // catch fabricated numbers for food carried dry, not to forbid fresh
    // produce from a cooler.
    expect(plausibilityViolations(meal({
      tripStyle: ['car-camping', 'basecamp'], shelfLife: 'day-one',
      caloriesPerServing: 280, ouncesPerServing: 8,
    }))).toEqual([]);
  });

  it('still rejects an impossible density even for car camping', () => {
    expect(plausibilityViolations(meal({
      tripStyle: ['car-camping'], shelfLife: 'day-one',
      caloriesPerServing: 3000, ouncesPerServing: 2,
    })).length).toBeGreaterThan(0);
  });

  it('catches protein whose calories exceed the whole meal', () => {
    // Protein is 4 kcal/g, so this is arithmetically impossible.
    const v = plausibilityViolations(meal({ proteinGrams: 60, caloriesPerServing: 200 }));
    expect(v.join(' ')).toMatch(/protein/i);
  });

  it('catches an absurd protein figure', () => {
    expect(plausibilityViolations(meal({ proteinGrams: 200, caloriesPerServing: 3000, ouncesPerServing: 20 })).length)
      .toBeGreaterThan(0);
  });

  it('catches a recipe that takes no time at all to cook or prepare', () => {
    expect(plausibilityViolations(meal({ prepMinutes: 0, cookMinutes: 0 })).length).toBeGreaterThan(0);
  });
});

describe('ngramOverlap', () => {
  it('is zero for unrelated text', () => {
    expect(ngramOverlap('the quick brown fox jumps over lazy dogs today', 'completely different words entirely here now friend', 5)).toBe(0);
  });

  it('is one when the text is copied wholesale', () => {
    const t = 'boil the water and add the noodles then stir in the cheese slowly';
    expect(ngramOverlap(t, t, 5)).toBe(1);
  });

  it('is high when a long passage is lifted', () => {
    const source = 'intro words here boil the water and add the noodles then stir in the cheese slowly outro';
    const body = 'boil the water and add the noodles then stir in the cheese slowly';
    expect(ngramOverlap(body, source, 5)).toBeGreaterThan(0.8);
  });

  it('is low when the same facts are rewritten', () => {
    const source = 'Bring two cups of water to a rolling boil, then add the ramen and cook for three minutes.';
    const body = 'Get the pot going. Once it is bubbling, drop the noodles in and give them three minutes.';
    expect(ngramOverlap(body, source, 5)).toBeLessThan(0.2);
  });

  it('is zero when the body is shorter than the window', () => {
    expect(ngramOverlap('too short', 'anything at all here', 5)).toBe(0);
  });
});

describe('qaVerdict', () => {
  it('passes a clean recipe', () => {
    expect(qaVerdict(meal(), 'unrelated source text about something else', []).pass).toBe(true);
  });

  it('fails on a facet contradiction', () => {
    const r = qaVerdict(meal({ heatSource: ['no-cook'], cookMinutes: 12 }), 'x', []);
    expect(r.pass).toBe(false);
  });

  it('fails when the body was lifted from the source', () => {
    const copied = 'boil the water and add the noodles then stir in the cheese slowly and eat';
    const r = qaVerdict(meal({ body: copied }), copied, []);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/original|overlap/i);
  });

  it('fails when a majority of refuters reject it', () => {
    const r = qaVerdict(meal(), 'x', [
      { refuted: true, why: 'not cookable' },
      { refuted: true, why: 'unsafe' },
    ]);
    expect(r.pass).toBe(false);
  });

  it('survives a single dissenting refuter', () => {
    const r = qaVerdict(meal(), 'x', [
      { refuted: true, why: 'i disagree' },
      { refuted: false, why: 'fine' },
    ]);
    expect(r.pass).toBe(true);
  });

  it('reports every reason it failed, not just the first', () => {
    const r = qaVerdict(meal({ heatSource: ['no-cook'], cookMinutes: 12, proteinGrams: 60, caloriesPerServing: 200 }), 'x', []);
    expect(r.reasons.length).toBeGreaterThan(1);
  });
});
