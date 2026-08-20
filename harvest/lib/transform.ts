/**
 * Turning a deduplicated candidate into a recipe file.
 *
 * The model returns JSON, never YAML. Frontmatter written by a model cannot be
 * validated before it is on disk — a stray colon or an unquoted apostrophe
 * produces a file that fails the site build — whereas JSON can be parsed,
 * checked against the real `mealFields` schema, and only then serialised here,
 * deterministically. Every recipe that reaches `content/` has already passed
 * the same schema the site enforces.
 */

import { z } from 'zod';
import { mealFields } from '../../schema.ts';

/** Facet arrays are enum values, so they render inline and unquoted, matching
 *  the recipes already in `content/`. Prose arrays render as quoted blocks. */
const INLINE_ARRAYS = new Set(['tripStyle', 'slot', 'heatSource', 'dietary']);

/** Frontmatter key order, so every generated file reads the same way. */
const FIELD_ORDER = [
  'title', 'blurb', 'tripStyle', 'slot', 'heatSource', 'prepMinutes', 'cookMinutes',
  'caloriesPerServing', 'ouncesPerServing', 'proteinGrams', 'water', 'waterMl',
  'cleanup', 'dietary', 'homePrep', 'shelfLife', 'servings', 'scalable', 'skill',
  'cost', 'ingredients', 'steps', 'packing', 'variations', 'source',
];

export function slugFor(title: string): string {
  return title
    .toLowerCase()
    // Apostrophes vanish rather than becoming separators, so "Glenn's" reads
    // as "glenns" instead of splitting into "glenn-s".
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Which `content/<shard>/` directory a slug belongs in. */
export function shardFor(slug: string): string {
  const first = slug[0] ?? '_';
  return /[a-z]/.test(first) ? first : '_';
}

const quote = (s: string): string => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Serialise a value map to YAML, in the shapes this schema actually uses. */
export function toFrontmatter(recipe: Record<string, unknown>): string {
  const lines: string[] = [];

  const keys = [
    ...FIELD_ORDER.filter((k) => k in recipe),
    ...Object.keys(recipe).filter((k) => !FIELD_ORDER.includes(k) && k !== 'body'),
  ];

  for (const key of keys) {
    const value = recipe[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    if (Array.isArray(value)) {
      if (INLINE_ARRAYS.has(key)) {
        lines.push(`${key}: [${value.join(', ')}]`);
      } else if (typeof value[0] === 'object') {
        lines.push(`${key}:`);
        for (const entry of value as Record<string, unknown>[]) {
          lines.push(`  - item: ${quote(String(entry.item))}`);
          lines.push(`    amount: ${quote(String(entry.amount))}`);
          if (entry.note) lines.push(`    note: ${quote(String(entry.note))}`);
        }
      } else {
        lines.push(`${key}:`);
        for (const entry of value) lines.push(`  - ${quote(String(entry))}`);
      }
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quote(String(value))}`);
    }
  }

  return lines.join('\n');
}

/** The complete markdown file: frontmatter, then the prose body. */
export function renderRecipe(recipe: Record<string, unknown>, source: string): string {
  const { body, ...fields } = recipe;
  return `---\n${toFrontmatter({ ...fields, source })}\n---\n\n${String(body ?? '').trim()}\n`;
}

/** The first JSON object in a reply, fenced or not, chatter or not. */
export function parseRecipeJson(reply: string): Record<string, any> | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced?.[1], reply].filter(Boolean) as string[]) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the next candidate.
    }
  }
  return null;
}

/** The site's own schema, plus the body the markdown file needs. */
const recipeSchema = z
  .object(mealFields(z))
  .extend({ body: z.string().min(1) })
  .omit({ source: true, updated: true, draft: true });

export type Validation = { ok: boolean; errors: string[] };

/**
 * Check a candidate recipe against the schema the site enforces.
 *
 * Deliberately the same `mealFields` the content collection uses, rather than
 * a copy: a recipe that passes here cannot fail the site build, and a facet
 * typo is caught before the file is written instead of at deploy time.
 */
export function validateRecipe(recipe: unknown): Validation {
  const result = recipeSchema.safeParse(recipe);
  if (result.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
