import { describe, expect, it } from 'vitest';
import { Resolver } from '../src/resolver.js';

const S = '0xs';
const round = (id: string, seq: bigint, ts: number, H = 10) => ({ roundId: id, sender: S, txDigest: id, checkpointSeq: seq, timestampMs: ts, deadlineMs: ts + H * 60_000 });

describe('Resolver', () => {
  it('resolves YES on a later activity by the same sender inside the window', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0));
    const out = r.onCheckpoint(11n, 'CP11', 60_000, [{ sender: S, txDigest: 'T2', timestampMs: 60_000 }]);
    expect(out).toEqual([expect.objectContaining({ roundId: 'T1', outcome: 1, resolvingDigest: 'T2', resolvingCheckpointSeq: '11', reason: 'moved' })]);
    expect(r.pendingCount).toBe(0);
  });

  it('never resolves a round with its own transaction', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0));
    expect(r.onCheckpoint(10n, 'CP10', 0, [{ sender: S, txDigest: 'T1', timestampMs: 0 }])).toEqual([]);
  });

  it('resolves NO at the first checkpoint past the deadline', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0, 2));
    expect(r.onCheckpoint(11n, 'CP11', 119_999, [])).toEqual([]);
    const out = r.onCheckpoint(12n, 'CP12', 120_001, []);
    expect(out[0]).toMatchObject({ outcome: 0, resolvingDigest: 'CP12', reason: 'deadline' });
  });

  it('ignores other senders and activity after the deadline', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0, 1));
    const out = r.onCheckpoint(11n, 'CP11', 70_000, [
      { sender: '0xother', txDigest: 'X', timestampMs: 1000 },
      { sender: S, txDigest: 'T2', timestampMs: 70_000 },
    ]);
    expect(out).toEqual([expect.objectContaining({ outcome: 0 })]);
  });

  it('one activity resolves every open round of that sender', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0));
    r.add(round('T2', 11n, 1000));
    const out = r.onCheckpoint(12n, 'CP', 2000, [{ sender: S, txDigest: 'T3', timestampMs: 2000 }]);
    expect(out.map((o) => o.roundId).sort()).toEqual(['T1', 'T2']);
  });

  it('voids rounds overlapping an unrecoverable gap', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0));
    r.add(round('T2', 50n, 0));
    const out = r.onGap(20n, 5);
    expect(out).toEqual([expect.objectContaining({ roundId: 'T1', outcome: null, reason: 'gap' })]);
    expect(r.pending().map((p) => p.roundId)).toEqual(['T2']);
  });
  it('ignores other txs by the sender in the sighting checkpoint (same answer live and on replay)', () => {
    const r = new Resolver();
    r.add(round('T1', 10n, 0));
    expect(r.onCheckpoint(10n, 'CP10', 0, [{ sender: S, txDigest: 'T0', timestampMs: 0 }])).toEqual([]);
    expect(r.pendingCount).toBe(1);
  });
});
