import { describe, it, expect } from 'vitest';
import { sharedPrefix, sharedSuffix, stripBoilerplate } from '../harvest/lib/boilerplate';
import { classify, recipeSignals } from '../harvest/lib/relevance';
import { normalizeIngredient, ingredientSet, simhash, hamming, cluster } from '../harvest/lib/dedup';

// -------------------------------------------------------------- boilerplate

describe('sharedPrefix', () => {
  it('finds the run of words every page begins with', () => {
    const pages = [
      'Trail Cooking Menu Home About Ramen Bomb recipe here',
      'Trail Cooking Menu Home About Cold Soak Oats recipe here',
      'Trail Cooking Menu Home About Camp Hash recipe here',
    ];
    expect(sharedPrefix(pages)).toBe('Trail Cooking Menu Home About');
  });

  it('finds nothing when the pages do not share an opening', () => {
    expect(sharedPrefix(['alpha beta gamma', 'delta epsilon zeta'])).toBe('');
  });

  it('ignores a shared opening too short to be navigation', () => {
    expect(sharedPrefix(['The ramen bomb', 'The cold soak'])).toBe('');
  });

  it('declines to guess from a single page', () => {
    expect(sharedPrefix(['Trail Cooking Menu Home About Ramen Bomb'])).toBe('');
  });

  it('tolerates one odd page rather than giving up on the domain', () => {
    const pages = [
      'Trail Cooking Menu Home About one',
      'Trail Cooking Menu Home About two',
      'Trail Cooking Menu Home About three',
      'totally different page',
    ];
    expect(sharedPrefix(pages)).toBe('Trail Cooking Menu Home About');
  });
});

describe('sharedSuffix', () => {
  it('finds the run of words every page ends with', () => {
    const pages = [
      'Ramen Bomb recipe Copyright 2026 All Rights Reserved Contact Us',
      'Cold Soak Oats Copyright 2026 All Rights Reserved Contact Us',
      'Camp Hash notes Copyright 2026 All Rights Reserved Contact Us',
    ];
    expect(sharedSuffix(pages)).toBe('Copyright 2026 All Rights Reserved Contact Us');
  });

  it('finds nothing when the pages do not share an ending', () => {
    expect(sharedSuffix(['alpha beta gamma', 'delta epsilon zeta'])).toBe('');
  });
});

describe('stripBoilerplate', () => {
  it('removes the shared prefix and suffix from a page', () => {
    const text = 'Menu Home About Ramen Bomb is good Copyright 2026 Contact';
    expect(stripBoilerplate(text, 'Menu Home About', 'Copyright 2026 Contact')).toBe('Ramen Bomb is good');
  });

  it('leaves a page alone when nothing is shared', () => {
    expect(stripBoilerplate('Ramen Bomb is good', '', '')).toBe('Ramen Bomb is good');
  });

  it('does not strip a prefix the page does not actually start with', () => {
    expect(stripBoilerplate('Ramen Bomb is good', 'Menu Home About', '')).toBe('Ramen Bomb is good');
  });

  it('never strips the page down to nothing', () => {
    expect(stripBoilerplate('Menu Home About', 'Menu Home About', '')).toBe('Menu Home About');
  });
});

// ---------------------------------------------------------------- relevance

const recipeText = `
Ingredients
2 cups instant rice
1 packet taco seasoning
4 oz freeze dried beef
1 tablespoon olive oil
Instructions
Boil 2 cups of water in your pot. Add the rice and stir.
Cover and let it sit for 5 minutes, then add the seasoning and mix well.
Serve hot straight from the pot.
`;

describe('recipeSignals', () => {
  it('counts measured quantities', () => {
    expect(recipeSignals(recipeText).quantities).toBeGreaterThanOrEqual(4);
  });

  it('counts cooking verbs', () => {
    expect(recipeSignals(recipeText).verbs).toBeGreaterThanOrEqual(4);
  });

  it('notices ingredient and instruction headings', () => {
    const s = recipeSignals(recipeText);
    expect(s.hasIngredientsHeading).toBe(true);
    expect(s.hasStepsHeading).toBe(true);
  });

  it('finds no quantities in prose that merely mentions food', () => {
    expect(recipeSignals('We talked about ramen and how good dinner was.').quantities).toBe(0);
  });
});

describe('classify', () => {
  it('accepts a page carrying schema.org Recipe data outright', () => {
    expect(classify({ title: 'Anything', text: 'short', jsonld: [{ name: 'x' }] })).toBe('recipe');
  });

  it('accepts a page with quantities, verbs, and headings', () => {
    expect(classify({ title: 'Taco Rice', text: recipeText })).toBe('recipe');
  });

  it('calls a numbered listicle an index', () => {
    expect(classify({ title: '50 Best Backpacking Recipes', text: 'A list of our favourites. ' + recipeText })).toBe('index');
  });

  it('calls a roundup an index even without a leading number', () => {
    expect(classify({ title: 'The Best Backpacking Meals Roundup', text: recipeText })).toBe('index');
  });

  it('calls a navigation-heavy page with no quantities an index', () => {
    const forumIndex = 'Camp Oven Recipes Welcome, Guest. New posts Search forums Sign In Register '
      + 'Facebook Instagram Pinterest. Over the years people have put together many recipes you can cook.';
    expect(classify({ title: 'Camp Oven Recipes', text: forumIndex })).toBe('index');
  });

  it('still sends a casual recipe with no quantities to the resolver', () => {
    // The whole point of borderline: a hiker writing a real recipe loosely.
    const casual = 'Boil some water, add the noodles, then stir in a handful of cheese and serve.';
    expect(classify({ title: 'My go-to camp dinner', text: casual })).toBe('borderline');
  });

  it('does not call a real recipe an index just because the page has a footer', () => {
    const withNav = recipeText + ' Facebook Instagram Pinterest Sign In Privacy Policy';
    expect(classify({ title: 'Taco Rice', text: withNav })).toBe('recipe');
  });

  it('counts pieces of a thing as a quantity', () => {
    // "2 flour tortillas" is a measured amount; treating it as none made real
    // recipes look like listing pages.
    expect(recipeSignals('2 flour tortillas and 3 eggs').quantities).toBeGreaterThanOrEqual(2);
  });

  it('does not call a single recipe an index for having a number in its title', () => {
    expect(classify({ title: '3 Ingredient Easy Camp Pasta', text: recipeText })).toBe('recipe');
  });

  it('rejects a page with no cooking signal', () => {
    expect(classify({ title: 'Our Team', text: 'We are a company that sells tents and sleeping bags to hikers.' })).toBe('reject');
  });

  it('sends a thin, ambiguous page to a model rather than guessing', () => {
    expect(classify({ title: 'Camp dinner', text: 'Boil water, add the noodles, eat.' })).toBe('borderline');
  });
});

// ------------------------------------------------------------------- dedup

describe('normalizeIngredient', () => {
  it('drops the amount and unit', () => {
    expect(normalizeIngredient('2 cups instant rice')).toBe('instant rice');
  });

  it('drops a fractional amount', () => {
    expect(normalizeIngredient('1/2 tbsp olive oil')).toBe('olive oil');
  });

  it('drops a parenthetical note', () => {
    expect(normalizeIngredient('4 oz cheddar cheese (or gouda)')).toBe('cheddar cheese');
  });

  it('drops preparation words', () => {
    expect(normalizeIngredient('1 cup chopped fresh onion')).toBe('onion');
  });

  it('lowercases and collapses spacing', () => {
    expect(normalizeIngredient('  2 CUPS   Instant  Rice ')).toBe('instant rice');
  });

  it('does not mistake the l of lbs for a litre', () => {
    expect(normalizeIngredient('2 lbs duck')).toBe('duck');
    expect(normalizeIngredient('3 lb pork butt')).toBe('pork butt');
  });

  it('keeps a unit-like word that is part of the ingredient', () => {
    expect(normalizeIngredient('2 cups long grain rice')).toBe('long grain rice');
  });

  it('drops a unicode fraction amount', () => {
    expect(normalizeIngredient('½ cup rice')).toBe('rice');
    expect(normalizeIngredient('¼ tsp salt')).toBe('salt');
  });

  it('keeps a flavour that follows a comma', () => {
    // Truncating at the comma collapsed every oatmeal flavour into one
    // ingredient, which then merged unrelated recipes.
    expect(normalizeIngredient('1 packet instant oatmeal, apple cinnamon'))
      .toBe('instant oatmeal apple cinnamon');
  });

  it('still drops a preparation clause that follows a comma', () => {
    expect(normalizeIngredient('1 cup onion, finely chopped')).toBe('onion');
  });

  it('leaves an ingredient with no amount alone', () => {
    expect(normalizeIngredient('salt')).toBe('salt');
  });
});

describe('ingredientSet', () => {
  it('prefers the structured recipeIngredient list', () => {
    const page = { title: 't', text: recipeText, jsonld: [{ recipeIngredient: ['2 cups instant rice', '1 tbsp olive oil'] }] };
    expect(ingredientSet(page)).toEqual(['instant rice', 'olive oil']);
  });

  it('falls back to quantity-bearing lines in the text', () => {
    expect(ingredientSet({ title: 't', text: recipeText })).toContain('instant rice');
  });

  it('finds ingredients in flat text that has no line breaks', () => {
    // pageText() collapses all whitespace, so a crawled page arrives as one
    // long line. Splitting on newlines would find nothing at all.
    const flat = 'Ingredients 2 cups instant rice 1 packet taco seasoning 4 oz freeze dried beef Instructions Boil water';
    const found = ingredientSet({ title: 't', text: flat });
    expect(found).toContain('instant rice');
    expect(found).toContain('taco seasoning');
  });

  it('ignores prose that merely sits next to a number', () => {
    const flat = 'I ate 2 cups for breakfast and then 3 oz late morning before camp';
    expect(ingredientSet({ title: 't', text: flat })).toEqual([]);
  });

  it('keeps a single-word ingredient', () => {
    const flat = 'Ingredients 2 lbs duck 1 cup rice 3 oz butter';
    const found = ingredientSet({ title: 't', text: flat });
    expect(found).toContain('duck');
    expect(found).toContain('rice');
  });

  it('uses only the first recipe when a page embeds several', () => {
    // A roundup embeds one Recipe per dish. Flattening them produced a single
    // fifty-ingredient candidate belonging to no actual recipe.
    const page = {
      title: 't', text: '',
      jsonld: [
        { recipeIngredient: ['1 cup rice', '1 tbsp oil'] },
        { recipeIngredient: ['2 cups chocolate', '1 cup marshmallow'] },
      ],
    };
    expect(ingredientSet(page)).toEqual(['rice', 'oil']);
  });

  it('returns each ingredient once', () => {
    const page = { title: 't', text: '', jsonld: [{ recipeIngredient: ['1 cup rice', '2 cups rice'] }] };
    expect(ingredientSet(page)).toEqual(['rice']);
  });
});

describe('simhash', () => {
  it('gives the same fingerprint to the same set', () => {
    expect(simhash(['rice', 'beans'])).toBe(simhash(['rice', 'beans']));
  });

  it('ignores the order of the set', () => {
    expect(simhash(['rice', 'beans'])).toBe(simhash(['beans', 'rice']));
  });

  it('gives different fingerprints to unrelated sets', () => {
    expect(simhash(['rice', 'beans'])).not.toBe(simhash(['chocolate', 'marshmallow']));
  });

  it('keeps near-identical sets close', () => {
    const a = simhash(['rice', 'beans', 'cheese', 'oil', 'salt']);
    const b = simhash(['rice', 'beans', 'cheese', 'oil', 'pepper']);
    const far = simhash(['chocolate', 'marshmallow', 'graham cracker', 'banana', 'sugar']);
    expect(hamming(a, b)).toBeLessThan(hamming(a, far));
  });
});

describe('hamming', () => {
  it('is zero for identical fingerprints', () => {
    expect(hamming(0b1011n, 0b1011n)).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hamming(0b1011n, 0b1001n)).toBe(1);
  });
});

describe('cluster', () => {
  const page = (id: string, ings: string[], extra: any = {}) =>
    ({ id, url: `https://x.com/${id}`, title: id, text: 'x'.repeat(500), ingredients: ings, ...extra });

  it('puts two near-identical recipes in one cluster', () => {
    const items = [
      page('a', ['instant ramen', 'potato flakes', 'cheddar cheese', 'olive oil']),
      page('b', ['instant ramen', 'potato flakes', 'cheddar cheese', 'butter']),
    ];
    expect(cluster(items)).toHaveLength(1);
  });

  it('keeps genuinely different recipes apart', () => {
    const items = [
      page('a', ['instant ramen', 'potato flakes', 'cheddar cheese', 'olive oil']),
      page('b', ['chocolate', 'marshmallow', 'graham cracker', 'banana']),
    ];
    expect(cluster(items)).toHaveLength(2);
  });

  it('reports the duplicates it folded into each cluster', () => {
    const items = [
      page('a', ['instant ramen', 'potato flakes', 'cheddar cheese', 'olive oil']),
      page('b', ['instant ramen', 'potato flakes', 'cheddar cheese', 'butter']),
    ];
    expect(cluster(items)[0].duplicates).toHaveLength(1);
  });

  it('prefers a member with structured data as the representative', () => {
    const items = [
      page('a', ['instant ramen', 'potato flakes', 'cheese', 'oil']),
      page('b', ['instant ramen', 'potato flakes', 'cheese', 'oil'], { jsonld: [{ name: 'Ramen Bomb' }] }),
    ];
    expect(cluster(items)[0].representative.id).toBe('b');
  });

  it('prefers the fuller page when neither has structured data', () => {
    const items = [
      page('a', ['ramen', 'potato flakes', 'cheese', 'oil']),
      { ...page('b', ['ramen', 'potato flakes', 'cheese', 'oil']), text: 'x'.repeat(5000) },
    ];
    expect(cluster(items)[0].representative.id).toBe('b');
  });

  it('keeps a one-ingredient recipe as its own cluster', () => {
    // Hot chocolate and a peanut-butter tortilla are real trail meals, and the
    // schema allows a single ingredient. They simply never match anything.
    expect(cluster([page('a', ['hot chocolate mix'])])).toHaveLength(1);
  });

  it('does not merge two recipes that share only pantry staples', () => {
    const items = [
      page('a', ['instant rice', 'olive oil', 'salt', 'garlic powder']),
      page('b', ['ramen noodles', 'olive oil', 'salt', 'garlic powder']),
    ];
    expect(cluster(items)).toHaveLength(2);
  });

  it('does not merge two variants that differ in their one distinctive item', () => {
    const items = [
      page('a', ['rolled oats', 'powdered milk', 'chia seeds', 'blueberries']),
      page('b', ['rolled oats', 'powdered milk', 'chia seeds', 'banana']),
    ];
    expect(cluster(items)).toHaveLength(2);
  });

  it('does not drift a cluster onto an unrelated recipe through a chain', () => {
    // Comparing only against the current representative let A absorb B, then B
    // absorb C, even when A and C share almost nothing.
    const items = [
      page('a', ['instant ramen', 'potato flakes', 'cheddar cheese', 'olive oil']),
      page('b', ['instant ramen', 'potato flakes', 'cheddar cheese', 'butter']),
      page('c', ['butter', 'cheddar cheese', 'sourdough bread', 'garlic']),
    ];
    const out = cluster(items);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});
