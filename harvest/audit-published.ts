/**
 * Re-check everything already published against the current gate.
 *
 * The gate gets stricter as faults are found, and recipes published under an
 * older, laxer version stay on disk. This walks `content/`, applies today's
 * rules, and pulls anything that no longer passes back out — clearing its
 * source URL from the transformed set so the pipeline writes it again.
 *
 * Only sharded directories are touched. The hand-written recipes at the top of
 * `content/` are not the pipeline's to judge.
 *
 * Run:
 *   node --experimental-strip-types harvest/audit-published.ts [--fix]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { facetViolations, plausibilityViolations, type Recipe } from './lib/qa.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTENT = join(ROOT, 'content');
const STATE = join(ROOT, 'harvest/state');
const PULLED = join(ROOT, 'harvest/pulled');
const TRANSFORMED = join(STATE, 'seen-transformed.txt');

const fix = process.argv.includes('--fix');

/** Enough YAML for the frontmatter this pipeline writes — quoted scalars,
 *  inline enum arrays, quoted block lists, and the ingredient objects. */
function parseFrontmatter(text: string): Record<string, any> {
  const end = text.indexOf('\n---', 4);
  const body = text.slice(4, end === -1 ? undefined : end);
  const out: Record<string, any> = {};
  let key: string | null = null;
  let list: any[] | null = null;

  const scalar = (raw: string): any => {
    const t = raw.trim();
    if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"');
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    return t;
  };

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;

    const item = line.match(/^\s+- item:\s*(.*)$/);
    if (item && list) { list.push({ item: scalar(item[1]) }); continue; }
    const field = line.match(/^\s+(amount|note):\s*(.*)$/);
    if (field && list && list.length) { list[list.length - 1][field[1]] = scalar(field[2]); continue; }
    const entry = line.match(/^\s+-\s+(.*)$/);
    if (entry && list) { list.push(scalar(entry[1])); continue; }

    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const value = kv[2].trim();

    if (value === '') { list = []; out[key] = list; continue; }
    list = null;
    if (/^\[.*\]$/.test(value)) {
      out[key] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      out[key] = scalar(value);
    }
  }
  return out;
}

function main() {
  const shards = readdirSync(CONTENT, { withFileTypes: true }).filter((d) => d.isDirectory());
  const bad: { file: string; source: string; reasons: string[] }[] = [];
  let checked = 0;

  for (const shard of shards) {
    for (const name of readdirSync(join(CONTENT, shard.name))) {
      if (!name.endsWith('.md')) continue;
      const path = join(CONTENT, shard.name, name);
      const text = readFileSync(path, 'utf8');
      const recipe = parseFrontmatter(text) as Recipe;
      recipe.body = 'x';
      checked += 1;

      const reasons = [...facetViolations(recipe), ...plausibilityViolations(recipe)];
      if (reasons.length) {
        bad.push({ file: join(shard.name, name), source: String(recipe.source ?? ''), reasons });
      }
    }
  }

  console.log(`checked ${checked} published recipes, ${bad.length} now fail the gate`);
  for (const b of bad.slice(0, 20)) console.log(`  ${b.file}: ${b.reasons.join('; ')}`);
  if (bad.length > 20) console.log(`  ... and ${bad.length - 20} more`);

  if (!fix) {
    console.log('\nrun with --fix to pull them out and requeue their sources');
    return;
  }

  mkdirSync(PULLED, { recursive: true });
  const pulledSources = new Set(bad.map((b) => b.source).filter(Boolean));

  for (const b of bad) {
    renameSync(join(CONTENT, b.file), join(PULLED, b.file.replace('/', '__')));
  }

  if (existsSync(TRANSFORMED)) {
    const kept = readFileSync(TRANSFORMED, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !pulledSources.has(l));
    writeFileSync(TRANSFORMED, kept.join('\n') + '\n', 'utf8');
  }

  console.log(`pulled ${bad.length} recipes into harvest/pulled/ and requeued ${pulledSources.size} sources`);
}

main();
