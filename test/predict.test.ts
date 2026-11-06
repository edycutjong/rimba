import { describe, expect, it } from 'vitest';
import { BaseRate, brier, FrequencyTable } from '../src/predict.js';

describe('baselines', () => {
  it('base rate starts at the prior and moves toward observed outcomes', () => {
    const b = new BaseRate(0.4, 10);
    expect(b.p()).toBeCloseTo(0.4);
    for (let i = 0; i < 10; i++) b.observe(1);
    expect(b.p()).toBeCloseTo(0.7);
    expect(b.count).toBe(10);
  });

  it('frequency table falls back to base rate for never-seen senders and smooths known ones', () => {
    const f = new FrequencyTable(2);
    expect(f.p('0xnew', 0.3)).toBe(0.3);
    f.observe('0xa', 1);
    f.observe('0xa', 1);
    expect(f.p('0xa', 0.5)).toBeCloseTo(0.75);
    expect(f.resolvedCount('0xa')).toBe(2);
  });

  it('brier is squared error', () => {
    expect(brier(0.7, 1)).toBeCloseTo(0.09);
    expect(brier(0.7, 0)).toBeCloseTo(0.49);
  });
});
