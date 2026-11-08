import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, isPaymentRequired, project, TatumGovernor } from '../src/stream/governor.js';

const MIN = 60_000;
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const BEFORE = at('2026-11-09T12:00:00Z');
const AFTER = at('2026-11-12T00:00:00Z');

describe('isPaymentRequired', () => {
  it('recognises the gateway 402 as gRPC surfaces it, and nothing else', () => {
    expect(isPaymentRequired(Object.assign(new Error('2 UNKNOWN: Received HTTP status code 402'), { code: 2 }))).toBe(true);
    expect(isPaymentRequired({ status: 402 })).toBe(true);
    expect(isPaymentRequired(new Error('402 Payment Required'))).toBe(true);
    expect(isPaymentRequired(Object.assign(new Error('14 UNAVAILABLE: Received HTTP status code 429'), { code: 14 }))).toBe(false);
    expect(isPaymentRequired(Object.assign(new Error('13 INTERNAL: Received RST_STREAM with code 2'), { code: 13 }))).toBe(false);
    expect(isPaymentRequired(new Error('checkpoint 340200402 not found'))).toBe(false);
    expect(isPaymentRequired(null)).toBe(false);
  });
});

describe('TatumGovernor', () => {
  it('a 402 switches to the public node at once, retries Tatum after retry_402_min, and recovers on data', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET);
    expect(g.decide(BEFORE).source).toBe('tatum');
    g.onPaymentRequired(BEFORE);
    expect(g.decide(BEFORE)).toMatchObject({ source: 'public-dev', reason: 'payment-required' });
    expect(g.decide(BEFORE + 9 * MIN).source).toBe('public-dev');
    expect(g.decide(BEFORE + 10 * MIN).source).toBe('tatum'); // retry window
    g.onPaymentRequired(BEFORE + 10 * MIN); // still out of credits → another 10 min on public
    expect(g.decide(BEFORE + 15 * MIN).source).toBe('public-dev');
    expect(g.state.fallback_count).toBe(2);
    expect(g.onTatumOk(BEFORE + 21 * MIN)).toBe(21 * MIN); // outage measured from the first 402
    expect(g.decide(BEFORE + 21 * MIN)).toMatchObject({ source: 'tatum', reason: 'full' });
    expect(g.onTatumOk(BEFORE + 22 * MIN)).toBeNull();
  });

  it('runs the full stream before the deadline and stays public without a key', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET);
    expect(g.decide(BEFORE)).toMatchObject({ source: 'tatum', reason: 'full', duty: 1 });
    expect(g.decide(BEFORE, false)).toMatchObject({ source: 'public-dev', reason: 'no-key' });
  });

  it('hard stop latches public at hard_stop_frac until a human clears it', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET);
    g.recordUsage(0.89 * 4_000_000, BEFORE);
    expect(g.state.hard_stop).toBeNull();
    g.countTatumCalls(0.02 * 2_000_000, BEFORE + MIN); // 0.01 of the plan at 2 credits/call
    expect(g.state.hard_stop).not.toBeNull();
    expect(g.decide(BEFORE + 2 * MIN)).toMatchObject({ source: 'public-dev', reason: 'hard-stop' });
    g.recordUsage(10, BEFORE + 3 * MIN); // even a usage counter reset does not unlatch it
    expect(g.decide(BEFORE + 3 * MIN).reason).toBe('hard-stop');
  });

  it('keeps used() monotonic across a usage-API counter reset and adds locally counted calls', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET);
    g.recordUsage(100_000, BEFORE);
    g.countTatumCalls(500, BEFORE + MIN);
    expect(g.used()).toBe(101_000);
    g.recordUsage(2_000, BEFORE + 2 * MIN); // counter reset: the earlier 100K still counts
    expect(g.used()).toBe(102_000);
  });

  it('after the deadline: a 45-min on-window, then public; duty is denser during judging', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET, { api_raw: 1_700_000 });
    const d = g.decide(AFTER);
    const p = g.state.period!;
    expect(d.source).toBe('tatum');
    expect(p.on_end - p.start).toBe(45 * MIN);
    expect(p.duty).toBeGreaterThan(0);
    expect(p.duty).toBeLessThan(1);
    expect(g.decide(p.on_end + MIN)).toMatchObject({ source: 'public-dev', reason: 'duty-off' });
    expect(g.decide(p.end).source).toBe('tatum'); // next period opens on
    const judging = g.dutyAt(at('2026-11-16T00:00:00Z'), 2_000_000);
    const after = g.dutyAt(at('2026-11-18T00:00:00Z'), 2_000_000);
    expect(judging).toBeGreaterThan(after);
  });

  it('over target → public, re-checked hourly (not latched)', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET, { api_raw: 0.86 * 4_000_000 });
    expect(g.decide(AFTER)).toMatchObject({ source: 'public-dev', reason: 'over-target' });
    expect(g.state.hard_stop).toBeNull();
    expect(g.state.period!.end - g.state.period!.start).toBe(60 * MIN);
  });

  it('a Tatum round may open only if its horizon + slack fits inside the on-window; public rounds always may', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET, { api_raw: 1_700_000 });
    const full = at(DEFAULT_BUDGET.full_until);
    // the first on-window continues the full stream for 45 min past the deadline
    expect(g.mayOpenCall('tatum', full - 30 * MIN, 15)).toBe(true);
    expect(g.mayOpenCall('tatum', full + 27 * MIN, 15)).toBe(true); // 27 + 15 + 3 = 45
    expect(g.mayOpenCall('tatum', full + 28 * MIN, 15)).toBe(false);
    expect(g.mayOpenCall('public-dev', full + 28 * MIN, 15)).toBe(true);
    g.onPaymentRequired(full - 60 * MIN);
    expect(g.mayOpenCall('tatum', full - 55 * MIN, 15)).toBe(false); // no Tatum rounds during a 402 fallback
  });

  it('a period resumes the schedule after the logger was down instead of replaying missed windows', () => {
    const g = new TatumGovernor(DEFAULT_BUDGET, { api_raw: 1_700_000 });
    g.decide(AFTER);
    const late = g.state.period!.end + 10 * H;
    g.decide(late);
    expect(g.state.period!.start).toBe(late);
  });
});

describe('project', () => {
  it('keeps projected use at or under the target at the measured burn, and under the hard stop at +25 % burn', () => {
    const now = at('2026-11-08T00:40:00Z');
    const nominal = project(DEFAULT_BUDGET, 106_000, now);
    const high = project(DEFAULT_BUDGET, 106_000, now, DEFAULT_BUDGET.burn_credits_per_hour * 1.25);
    expect(nominal.frac_at_cycle_end).toBeLessThanOrEqual(0.85);
    expect(high.frac_at_cycle_end).toBeLessThan(DEFAULT_BUDGET.hard_stop_frac); // re-sized every period: overshoot stays small
    expect(nominal.tatum_hours_after_deadline).toBeGreaterThan(24);
    expect(nominal.at_full_until).toBeLessThan(0.5 * 4_000_000);
  });
});
