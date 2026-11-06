import { describe, expect, it } from 'vitest';
import { cell, joinRounds, roundsCsv, scorecard, CSV_COLUMNS } from '../src/score.js';
import type { CallRow, ResolutionRow } from '../src/store.js';

const call = (id: string, p: Partial<CallRow> = {}): CallRow => ({
  round_id: id, created_at: '2026-11-07T00:00:00Z', network_source: 'tatum', checkpoint_seq: '1', checkpoint_ts: 0, tx_digest: id, sender: 'S' + id,
  recipient: 'R', coin_type: 'SUI', amount_raw: '1', horizon_min: 15, move_rule: 'any_transfer', sender_seen_before: false, p_memory: 0.8,
  call: 'yes', p_base: 0.5, p_freq: 0.5, cited_note_ids: ['No.0001'], cited_distances: [0.1], memory_source: 'walrus', species: 'a, b', ...p,
});
const res = (id: string, outcome: 0 | 1 | null): ResolutionRow => ({ round_id: id, resolved_at: '2026-11-07T00:20:00Z', outcome, reason: outcome === null ? 'gap' : outcome ? 'moved' : 'deadline', resolving_checkpoint_seq: '2', resolving_digest: 'X', resolving_ts: 1, network_source: 'tatum' });
const cfg = { horizon_min: 15, move_rule: 'any_transfer' as const };

describe('score', () => {
  it('joins calls with resolutions, counting void and pending separately', () => {
    const j = joinRounds([call('A'), call('B'), call('C')], [res('A', 1), res('B', null)]);
    expect(j.rounds.map((r) => r.round_id)).toEqual(['A']);
    expect(j).toMatchObject({ void: 1, pending: 1 });
    expect(j.rounds[0]!.brier_memory).toBeCloseTo(0.04);
    expect(j.rounds[0]!.brier_base).toBeCloseTo(0.25);
  });

  it('computes Brier, skill vs base, and the memory-called subset', () => {
    const { rounds } = joinRounds([call('A'), call('B', { p_memory: 0.5, call: 'abstain' })], [res('A', 1), res('B', 0)]);
    const c = cell(rounds);
    expect(c.n).toBe(2);
    expect(c.brier_memory).toBeCloseTo((0.04 + 0.25) / 2);
    expect(c.brier_base).toBeCloseTo(0.25);
    expect(c.skill_vs_base).toBeCloseTo(1 - 0.145 / 0.25);
    expect(c.n_called).toBe(1);
    expect(c.brier_memory_called).toBeCloseTo(0.04);
  });

  it('headline filter keeps only Tatum × Walrus rows; never-seen subset and other-question rows are separated', () => {
    const calls = [
      call('A'),
      call('B', { network_source: 'public-dev' }),
      call('C', { memory_source: 'local-dev' }),
      call('D', { sender_seen_before: true }),
      call('E', { horizon_min: 10 }),
    ];
    const rs = ['A', 'B', 'C', 'D', 'E'].map((id) => res(id, 1));
    const s = scorecard(calls, rs, cfg, { network_source: 'tatum', memory_source: 'walrus' });
    expect(s.all.n).toBe(2);
    expect(s.never_seen.n).toBe(1);
    expect(s.seen.n).toBe(1);
    expect(s.counts.excluded_other_question).toBe(1);
    expect(s.by_day).toHaveLength(1);
    expect(scorecard(calls, rs, cfg).all.n).toBe(4);
  });

  it('writes rounds.csv with the documented columns and quotes commas', () => {
    const { rounds } = joinRounds([call('A')], [res('A', 1)]);
    const csv = roundsCsv(rounds).trim().split('\n');
    expect(csv[0]).toBe(CSV_COLUMNS.join(','));
    expect(csv[1]).toContain('"a, b"');
    expect(csv[1]!.split(',').length).toBeGreaterThanOrEqual(CSV_COLUMNS.length);
  });
  it('a Tatum round resolved through another stream does not count under the Tatum filter', () => {
    const s = scorecard([call('A'), call('B')], [res('A', 1), { ...res('B', 1), network_source: 'public-dev' }], cfg, { network_source: 'tatum', memory_source: 'walrus' });
    expect(s.all.n).toBe(1);
  });
});
