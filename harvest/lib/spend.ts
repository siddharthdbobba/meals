/**
 * A rolling ledger of what the harvest spends, and the budget it stops at.
 *
 * Claude Code publishes no readable meter for the five-hour limit: not through
 * `claude auth status`, not in `-p --output-format json`, not anywhere under
 * ~/.claude. Only an interactive /usage shows it. So the chain meters itself:
 * every model call reports its own cost, the calls of the last five hours are
 * summed, and the run stops when that sum crosses the budget.
 *
 * The budget calibrates itself. The first time a run is actually rate limited,
 * the window's spend at that moment is recorded as the ceiling, and the budget
 * becomes 90% of it — so the next window stops short of the wall instead of
 * walking into it.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WINDOW_MS = 5 * 60 * 60 * 1000;

const ledgerPath = (state: string) => join(state, 'spend.jsonl');
const budgetPath = (state: string) => join(state, 'spend-budget.txt');

export function recordSpend(state: string, usd: number, stage: string): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  appendFileSync(ledgerPath(state), `${JSON.stringify({ t: Date.now(), usd, stage })}\n`, 'utf8');
}

/** What the harvest has spent inside the last five hours. */
export function windowSpend(state: string, now = Date.now()): number {
  const path = ledgerPath(state);
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { t: number; usd: number };
      if (now - e.t < WINDOW_MS) total += e.usd;
    } catch {
      // A torn last line from a killed run is not worth failing the budget over.
    }
  }
  return total;
}

/** The budget in force, or null when none has been calibrated yet. */
export function budget(state: string): number | null {
  const path = budgetPath(state);
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, 'utf8').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setBudget(state: string, usd: number): void {
  writeFileSync(budgetPath(state), `${usd.toFixed(4)}\n`, 'utf8');
}

/**
 * Called when the CLI reports a rate limit: the spend in the window at that
 * moment is the observed ceiling, and 90% of it is the budget from now on.
 * Only ever lowers the budget — one unusually cheap window should not raise it.
 */
export function calibrateFromLimit(state: string, now = Date.now()): number | null {
  const ceiling = windowSpend(state, now);
  if (ceiling <= 0) return null;
  const target = ceiling * 0.9;
  const current = budget(state);
  if (current === null || target < current) {
    setBudget(state, target);
    appendFileSync(
      join(state, 'spend-calibration.log'),
      `${new Date(now).toISOString()} rate limited at $${ceiling.toFixed(2)} in the window; budget now $${target.toFixed(2)}\n`,
      'utf8',
    );
    return target;
  }
  return current;
}

/** The reason to stop now, or null to carry on. */
export function overBudget(state: string, now = Date.now()): string | null {
  const cap = budget(state);
  if (cap === null) return null;
  const spent = windowSpend(state, now);
  if (spent < cap) return null;
  return `spent $${spent.toFixed(2)} of the $${cap.toFixed(2)} five-hour budget`;
}
