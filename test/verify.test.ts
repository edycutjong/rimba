import { describe, expect, it } from 'vitest';
import { checkNoBoundary, checkSighting, checkYes, offlineChecks, replayWindow } from '../src/verify.js';
import type { NoteRecord } from '../src/notes.js';
import type { CallRow, ResolutionRow } from '../src/store.js';
import type { RawCheckpoint, RawTransaction } from '../src/stream/client.js';

const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const A = '0x' + 'a'.repeat(64), B = '0x' + 'b'.repeat(64);
const D1 = '4MctU5eZJDdqmna86fzxh8sJ61m8YQ4FY5hknqw4rj22';
const D2 = 'FifUct1ANUGWQgbjG19ihqpkmJKeBqDcE6vhSZyAyouP';
const T0 = 1_794_000_000_000;
const sec = (ms: number) => ({ seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 });
const call = (p: Partial<CallRow> = {}): CallRow => ({
  round_id: D1, created_at: new Date(T0 + 1000).toISOString(), network_source: 'public-dev', checkpoint_seq: '10', checkpoint_ts: T0, tx_digest: D1,
  sender: A, recipient: B, coin_type: SUI, amount_raw: '500', horizon_min: 15, move_rule: 'any_transfer', sender_seen_before: false,
  p_memory: 0.46, call: 'abstain', p_base: 0.46, p_freq: 0.46, cited_note_ids: [], cited_distances: [], ...p,
});
const res = (p: Partial<ResolutionRow> = {}): ResolutionRow => ({ round_id: D1, resolved_at: new Date(T0 + 70_000).toISOString(), outcome: 1, reason: 'moved', resolving_checkpoint_seq: '11', resolving_digest: D2, resolving_ts: T0 + 60_000, network_source: 'public-dev', ...p });
const tx = (digest: string, cp: string, ts: number, amount = 500n): RawTransaction => ({
  digest, checkpoint: cp, timestamp: sec(ts), transaction: { sender: A }, effects: { status: { success: true } },
  balance_changes: [{ address: A, coin_type: SUI, amount: String(-amount - 10n) }, { address: B, coin_type: SUI, amount: String(amount) }],
});

describe('offline invariant checks', () => {
  it('passes a clean round', () => {
    const r = offlineChecks([call()], [res()], []);
    expect(r.findings).toEqual([]);
  });

  it('flags I1 (orphan, double, resolved before called), I2 (YES after deadline) and I3 (cited note missing/late)', () => {
    const late = call({ round_id: D2, tx_digest: D2, call: 'yes', p_memory: 0.7, cited_note_ids: ['No.0001'], cited_created_at: [new Date(T0 + 5000).toISOString()] });
    const notes: NoteRecord[] = [];
    const r = offlineChecks([call(), late], [
      res(), res(), res({ round_id: 'ghost' }),
      res({ round_id: D2, resolved_at: new Date(T0).toISOString(), resolving_ts: T0 + 16 * 60_000 }),
    ], notes);
    const failed = Object.entries(r.checks).filter(([, v]) => v.failed).map(([k]) => k);
    expect(failed).toEqual(expect.arrayContaining([
      'I1 resolution has a call', 'I1 one resolution per round', 'I1 resolved after called', 'I2 YES inside window',
      'I3 cited note written before call (row)', 'I3 cited note exists in notes log, submitted before call',
    ]));
  });

  it('flags an abstain whose p_memory is not the base rate', () => {
    const r = offlineChecks([call({ p_memory: 0.9 })], [], []);
    expect(r.checks['abstain = base rate']!.failed).toBe(1);
  });
});

describe('online re-derivation (pure parts)', () => {
  it('checks the sighting tx and the YES move', () => {
    expect(checkSighting(call(), tx(D1, '10', T0)).ok).toBe(true);
    expect(checkSighting(call(), tx(D1, '10', T0, 499n)).ok).toBe(false);
    expect(checkYes(call(), res(), tx(D2, '11', T0 + 60_000), 'any_transfer').ok).toBe(true);
    expect(checkYes(call(), res(), tx(D2, '11', T0 + 16 * 60_000), 'any_transfer').ok).toBe(false);
    // above_threshold_transfer: the YES move itself must clear the threshold, and the thresholds are required
    expect(checkYes(call(), res(), tx(D2, '11', T0 + 60_000, 1n), 'above_threshold_transfer', new Map([[SUI, 100n]])).ok).toBe(false);
    expect(checkYes(call(), res(), tx(D2, '11', T0 + 60_000, 500n), 'above_threshold_transfer', new Map([[SUI, 100n]])).ok).toBe(true);
    expect(checkYes(call(), res(), tx(D2, '11', T0 + 60_000, 500n), 'above_threshold_transfer').ok).toBe(false);
  });

  it('checks the NO deadline boundary', () => {
    const r = res({ outcome: 0, reason: 'deadline', resolving_checkpoint_seq: '99', resolving_digest: 'CP99', resolving_ts: T0 + 15 * 60_000 + 1 });
    const at: RawCheckpoint = { sequence_number: '99', digest: 'CP99', summary: { timestamp: sec(T0 + 15 * 60_000 + 1) } };
    const before: RawCheckpoint = { sequence_number: '98', digest: 'CP98', summary: { timestamp: sec(T0 + 15 * 60_000) } };
    expect(checkNoBoundary(call(), r, at, before).ok).toBe(true);
    expect(checkNoBoundary(call(), r, at, at).ok).toBe(false);
  });

  it('replays a checkpoint window through the same Resolver and matches local outcomes', () => {
    const cps: RawCheckpoint[] = [
      { sequence_number: '10', digest: 'CP10', summary: { timestamp: sec(T0) }, transactions: [tx(D1, '10', T0)] },
      { sequence_number: '11', digest: 'CP11', summary: { timestamp: sec(T0 + 60_000) }, transactions: [tx(D2, '11', T0 + 60_000, 1n)] },
    ];
    const th = new Map([[SUI, 100n]]);
    const ok = replayWindow(cps, [call()], new Map([[D1, res()]]), { move_rule: 'any_transfer', horizon_min: 15 }, th);
    expect(ok).toMatchObject({ compared: 1, matched: 1, sightings_found: 1, sightings_missing: [], holes: 0, oracle_disagreements: [] });
    // a hole in the checkpoint array and a sighting that is not on chain are reported, never silently passed
    const holed = replayWindow([cps[0]!, { ...cps[1]!, sequence_number: '13' }], [call(), call({ round_id: 'GHOST', tx_digest: 'GHOST' })], new Map([[D1, res()]]), { move_rule: 'any_transfer', horizon_min: 15 }, th);
    expect(holed.holes).toBe(2);
    expect(holed.sightings_missing).toEqual(['GHOST']);
    // a local YES claimed at a checkpoint inside the replay that the replay never produced is a mismatch, not silence
    const claimed = replayWindow([cps[0]!], [call()], new Map([[D1, res({ resolving_checkpoint_seq: '10' })]]), { move_rule: 'any_transfer', horizon_min: 15 }, th);
    expect(claimed.compared).toBe(1);
    expect(claimed.mismatches[0]!.detail).toMatch(/inside the replay/);
    const bad = replayWindow(cps, [call()], new Map([[D1, res({ outcome: 0, resolving_digest: 'CPX' })]]), { move_rule: 'any_transfer', horizon_min: 15 }, th);
    expect(bad.matched).toBe(0);
    expect(bad.mismatches).toHaveLength(1);
  });
});
