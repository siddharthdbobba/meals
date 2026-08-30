import { describe, it, expect } from 'vitest';
import { facetViolations, plausibilityViolations, ngramOverlap, qaVerdict, sourceGrounding } from '../harvest/lib/qa';

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

  it('catches no-cook that claims boiled water', () => {
    // The site's own suite enforces this, and the gate did not, so a recipe
    // listing no-cook alongside boiled water reached content/ and broke the
    // build. The gate must be at least as strict as the thing it feeds.
    const v = facetViolations(meal({ heatSource: ['canister-stove', 'no-cook'], water: 'boiled' }));
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

  it('enforces the floor the site itself enforces, whatever the trip', () => {
    // tests/meals.test.ts requires every recipe above 30 cal/oz. The gate has
    // to be at least as strict, or it publishes something that breaks the build.
    expect(plausibilityViolations(meal({
      tripStyle: ['car-camping'], shelfLife: 'day-one',
      caloriesPerServing: 270, ouncesPerServing: 10,
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

describe('sourceGrounding', () => {
  const ings = [
    { item: 'Instant rice', amount: '1 cup' },
    { item: 'Dried beef', amount: '2 oz' },
    { item: 'Chili powder', amount: '1 tsp' },
  ];

  it('is high when the source really does discuss these ingredients', () => {
    const src = 'Pack instant rice and some dried beef, then add chili powder at camp.';
    expect(sourceGrounding(ings, src)).toBeGreaterThan(0.8);
  });

  it('is zero when the source is about something else entirely', () => {
    const src = 'Kyle Peters finishes Arenacross season undefeated. Adventure Rider news and ride reports.';
    expect(sourceGrounding(ings, src)).toBe(0);
  });

  it('matches on the head word rather than the exact phrase', () => {
    expect(sourceGrounding([{ item: 'Sharp cheddar cheese', amount: '1 oz' }], 'add some cheese')).toBe(1);
  });
});

describe('qaVerdict grounding', () => {
  const fabricated = meal({
    ingredients: [
      { item: 'Instant rice', amount: '1 cup' },
      { item: 'Dried beef', amount: '2 oz' },
      { item: 'Chili powder', amount: '1 tsp' },
    ],
  });

  it('rejects a recipe whose ingredients appear nowhere in its source', () => {
    // A motocross news article cannot be the source of a rice bowl. Publishing
    // it would attribute invented content to someone else's page.
    // A real crawled page, not a fragment: grounding abstains on very short
    // text because script detection needs something to work with.
    const motocross = ('Kyle Peters finishes the Arenacross season undefeated, and with that '
      + 'result he takes the championship for the second time in a row. The team said that '
      + 'the bike was set up for the tighter rounds, and it is clear from the lap times that '
      + 'this was the right call when the track went slick in the final. ').repeat(4);
    const r = qaVerdict(fabricated, motocross, []);
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/source|grounded|fabricat/i);
  });

  it('accepts a recipe its source actually supports', () => {
    const supporting = ('Bring instant rice and dried beef, season with chili powder at camp. '
      + 'This one pot dinner packs down small and rehydrates fast on the trail. ').repeat(3);
    const r = qaVerdict(fabricated, supporting, []);
    expect(r.pass).toBe(true);
  });

  it('does not punish a recipe adapted from a Norwegian source', () => {
    // meny.no/oppskrifter/pisket-krem is a real whipped cream recipe. It uses
    // the same alphabet as English, so a script test cannot tell them apart;
    // only the language can.
    const norwegian = ('Pisket krem oppskrift med sukker og vaniljesukker. Visp fløten til '
      + 'den er stiv men ikke for lenge ellers blir det smør. Serveres til dessert og kaker. ').repeat(3);
    expect(qaVerdict(fabricated, norwegian, []).pass).toBe(true);
  });

  it('does not punish a recipe adapted from a Czech source', () => {
    const czech = ('Drsné westernové recepty na guláš a fazole v kotlíku nad ohněm. '
      + 'Připravíme si maso cibuli a koření potom vaříme pomalu několik hodin. ').repeat(3);
    expect(qaVerdict(fabricated, czech, []).pass).toBe(true);
  });

  it('does not punish a recipe adapted from a non-latin source', () => {
    // The Hindi and Japanese pages the scouts found are real recipes whose
    // ingredient names cannot match an English list. Grounding cannot judge
    // them, so it must abstain rather than reject.
    const r = qaVerdict(fabricated, 'बारबेक्यू सोया चाप रेसिपी दही बेसन मसाला '.repeat(20), []);
    expect(r.pass).toBe(true);
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
