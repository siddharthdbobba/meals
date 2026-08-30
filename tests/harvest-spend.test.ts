import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSpend, windowSpend, budget, setBudget, calibrateFromLimit, overBudget, WINDOW_MS,
} from '../harvest/lib/spend';

let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'spend-')); });

describe('the five-hour ledger', () => {
  it('sums only what was spent inside the window', () => {
    const now = Date.now();
    writeFileSync(join(state, 'spend.jsonl'), [
      JSON.stringify({ t: now - WINDOW_MS - 1000, usd: 10, stage: 'stage3' }),
      JSON.stringify({ t: now - 60_000, usd: 2, stage: 'stage3' }),
      JSON.stringify({ t: now - 1000, usd: 3, stage: 'stage5' }),
    ].join('\n') + '\n');
    expect(windowSpend(state, now)).toBeCloseTo(5);
  });

  it('survives the torn last line a killed run leaves behind', () => {
    writeFileSync(join(state, 'spend.jsonl'), `${JSON.stringify({ t: Date.now(), usd: 4 })}\n{"t":1,"us`);
    expect(windowSpend(state)).toBeCloseTo(4);
  });

  it('has no budget, and so no verdict, until one is calibrated', () => {
    recordSpend(state, 100, 'stage3');
    expect(budget(state)).toBeNull();
    expect(overBudget(state)).toBeNull();
  });

  it('sets the budget to 90% of the spend the wall was hit at', () => {
    recordSpend(state, 20, 'stage3');
    expect(calibrateFromLimit(state)).toBeCloseTo(18);
    expect(budget(state)).toBeCloseTo(18);
  });

  it('lowers a budget on a cheaper wall, and never raises it on a dearer one', () => {
    setBudget(state, 18);
    recordSpend(state, 10, 'stage3');
    calibrateFromLimit(state);
    expect(budget(state)).toBeCloseTo(9);

    recordSpend(state, 100, 'stage3');
    calibrateFromLimit(state);
    expect(budget(state)).toBeCloseTo(9);
  });

  it('stops the run once the window reaches the budget', () => {
    setBudget(state, 10);
    recordSpend(state, 9.5, 'stage3');
    expect(overBudget(state)).toBeNull();
    recordSpend(state, 1, 'stage3');
    expect(overBudget(state)).toMatch(/\$10\.50 of the \$10\.00/);
  });
});
