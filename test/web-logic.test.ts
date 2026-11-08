import { describe, expect, it } from 'vitest';
import { noteVote, snapshotPath, verdict } from '../web/src/fmt.js';
import { cumulative, movedWithin, revote, store } from '../web/src/state.js';
import type { Round } from '../web/src/types.js';

const base: Round = {
  round_id: 'r1', n: 1, created_at: '2026-11-06T22:00:00Z', network_source: 'public-dev', memory_source: 'local-dev', checkpoint_seq: '100', checkpoint_ts: 1_000_000,
  tx_digest: 'd', sender: '0xa', recipient: '0xb', coin_type: '0x2::sui::SUI', amount_raw: '1', horizon_min: 15, move_rule: 'any_transfer',
  sender_seen_before: false, p_memory: 0.8, call: 'yes', p_base: 0.5, p_freq: 0.5,
  cited_note_ids: ['No.0001', 'No.0002'], cited_distances: [0.05, 0.2], resolution: { outcome: 1, reason: 'moved', resolved_at: 'x', resolving_checkpoint_seq: '200', resolving_digest: 'e', resolving_ts: 1_000_000 + 4 * 60_000, network_source: 'public-dev' },
};

describe('reef web logic', () => {
  it('parses single and tally notes, and supersedes', () => {
    expect(noteVote('Specimen No.0001 · x · moved again within 15 min: YES (checkpoint 5)')).toEqual({ yes: 1, n: 1, supersedes: [] });
    expect(noteVote('Specimen No.0009 · x · last 5 sightings moved again within 15 min: 4 of 5 YES [supersedes No.0001, No.0002] (checkpoint 5)')).toEqual({ yes: 4, n: 5, supersedes: ['No.0001', 'No.0002'] });
    expect(noteVote('garbage')).toBeNull();
  });

  it('re-votes with the same formula as the naturalist (weights 1 − d/maxDistance, shrink toward base)', () => {
    store.notes = {
      'No.0001': { text: 'Specimen No.0001 · x · moved again within 15 min: YES', species: 'x', created_at: '', backend: 'local-dev', kind: 'outcome' },
      'No.0002': { text: 'Specimen No.0002 · x · moved again within 15 min: NO', species: 'x', created_at: '', backend: 'local-dev', kind: 'outcome' },
    };
    const wide = revote(base, 0.22);
    // w1 = 1 − .05/.22, w2 = 1 − .2/.22 ; p = (w1·1 + 0.5) / (w1 + w2 + 1)
    const w1 = 1 - 0.05 / 0.22, w2 = 1 - 0.2 / 0.22;
    expect(wide.p).toBeCloseTo((w1 + 0.5) / (w1 + w2 + 1), 6);
    expect(wide.used).toBe(2);
    const strict = revote(base, 0.1); // only the 0.05 note is within reach
    expect(strict.used).toBe(1);
    const none = revote(base, 0.04);
    expect(none).toEqual({ p: 0.5, called: false, used: 0 });
    // the minimum-evidence abstain logged on the row is applied too (Σ w·n = w1 + w2 < 2)
    expect(revote({ ...base, min_evidence: 2 }, 0.22)).toEqual({ p: 0.5, called: false, used: 2 });
    expect(revote({ ...base, min_evidence: 0.5 }, 0.22).called).toBe(true);
  });

  it('re-derives shorter horizons from the resolving checkpoint timestamp', () => {
    expect(movedWithin(base, 5)).toBe(1);
    expect(movedWithin(base, 3)).toBe(0);
    expect(movedWithin({ ...base, resolution: { ...base.resolution!, reason: 'deadline', outcome: 0 } }, 15)).toBe(0);
    expect(movedWithin({ ...base, resolution: null }, 15)).toBeNull();
  });

  it('judges right/wrong/abstain', () => {
    expect(verdict(base)).toBe('right');
    expect(verdict({ ...base, call: 'no' })).toBe('wrong');
    expect(verdict({ ...base, call: 'abstain' })).toBe('abstain');
    expect(verdict({ ...base, resolution: null })).toBeNull();
  });

  it('cumulative Brier is the running mean', () => {
    const c = cumulative([base, { ...base, round_id: 'r2', p_memory: 0.2 }]);
    expect(c.mem[0]).toBeCloseTo(0.04, 6);
    expect(c.mem[1]).toBeCloseTo((0.04 + 0.64) / 2, 6);
    expect(c.base[1]).toBeCloseTo(0.25, 6);
  });
});

describe('snapshotPath (?snap= deep link)', () => {
  it('maps a dated archive to its file and everything else to the current snapshot', () => {
    expect(snapshotPath('2026-11-07')).toBe('data/archive/snapshot-2026-11-07.json');
    expect(snapshotPath(null)).toBe('data/snapshot.json');
    expect(snapshotPath('')).toBe('data/snapshot.json');
    expect(snapshotPath('../../etc/passwd')).toBe('data/snapshot.json');
    expect(snapshotPath('2026-11-07/../x')).toBe('data/snapshot.json');
  });
});
