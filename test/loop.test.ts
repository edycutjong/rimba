import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreLoop } from '../src/loop.js';
import { LocalNoteMemory } from '../src/memory/backend.js';
import { NoteWriter, type NoteRecord } from '../src/notes.js';
import { checkI3, InvariantError, RoundStore, type CallRow, type RimbaConfig } from '../src/store.js';
import type { RawCheckpoint } from '../src/stream/client.js';

const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const A = '0x' + 'a'.repeat(64), B = '0x' + 'b'.repeat(64), C = '0x' + 'c'.repeat(64), D = '0x' + 'd'.repeat(64);
const cfg: RimbaConfig = {
  horizon_min: 15, move_rule: 'any_transfer', base_rate_prior: 0.46, thresholds_raw: { [SUI]: '100000000000' }, source: 'test',
  naturalist: { max_distance: { walrus: 0.35, 'local-dev': 0.22 }, limit: 20, shrink: 1, recall_timeout_ms: 1000 },
  notes: { daily_budget: 400, supersede_window: 5, supersede_cooldown_min: 120 },
};
const T0 = Date.parse('2026-11-07T12:00:00Z');
const sec = (ms: number) => ({ seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 });

function cp(seq: number, ts: number, txs: { digest: string; from: string; to: string; amount: bigint }[]): RawCheckpoint {
  return {
    sequence_number: String(seq), digest: `CP${seq}`, summary: { timestamp: sec(ts) },
    transactions: txs.map((t) => ({
      digest: t.digest, timestamp: sec(ts), transaction: { sender: t.from }, effects: { status: { success: true } },
      balance_changes: [{ address: t.from, coin_type: SUI, amount: String(-t.amount - 1000n) }, { address: t.to, coin_type: SUI, amount: String(t.amount) }],
    })),
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rimba-'));
  let now = T0;
  const clock = () => now;
  const store = new RoundStore(join(dir, 'calls.jsonl'), join(dir, 'res.jsonl'));
  const mem = new LocalNoteMemory([], clock);
  const notes: NoteRecord[] = [];
  const writer = new NoteWriter(() => mem, (r) => { notes.push(r); loop.countNote(r); }, {}, { now: clock });
  const order: string[] = [];
  const loop: CoreLoop = new CoreLoop({ cfg, store, writer, memory: () => mem, notes, now: clock, emit: (ev, d) => order.push(`${ev}:${(d as { round_id?: string; digest?: string }).round_id ?? (d as { digest?: string }).digest}`) });
  return { dir, store, writer, loop, notes, order, mem, tick: (ms: number) => { now += ms; } };
}

const BIG = 500n * 10n ** 9n;

describe('CoreLoop — sighting → recall → call → resolve → remember', () => {
  it('opens a round per large transfer with all three predictions frozen at call time', async () => {
    const s = setup();
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }, { digest: 'small', from: C, to: D, amount: 1n }]), 'public-dev');
    const c = s.store.call('T1')!;
    expect(s.store.size).toBe(1);
    expect(c).toMatchObject({ call: 'abstain', p_memory: 0.46, p_base: 0.46, p_freq: 0.46, memory_source: 'local-dev', sender_seen_before: false });
    expect(c.species).toContain('SUI transfer');
  });

  it('I1: the call is on disk before its resolution, and resolution is keyed by round_id', async () => {
    const s = setup();
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]), 'public-dev');
    s.tick(60_000);
    await s.loop.onCheckpoint(cp(2, T0 + 60_000, [{ digest: 'T2', from: A, to: C, amount: 5n }]), 'public-dev');
    expect(s.store.resolution('T1')).toMatchObject({ outcome: 1, resolving_digest: 'T2', reason: 'moved' });
    const callLines = readFileSync(join(s.dir, 'calls.jsonl'), 'utf8').trim().split('\n');
    const resLines = readFileSync(join(s.dir, 'res.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(callLines[0]!).round_id).toBe('T1');
    expect(JSON.parse(resLines[0]!).round_id).toBe('T1');
    expect(s.order.indexOf('call:T1')).toBeLessThan(s.order.indexOf('resolution:T1'));
    expect(Date.parse(s.store.resolution('T1')!.resolved_at)).toBeGreaterThanOrEqual(Date.parse(c(s, 'T1').created_at));
  });

  it('resolves NO past the deadline and writes an outcome note for it', async () => {
    const s = setup();
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]), 'public-dev');
    s.tick(16 * 60_000);
    await s.loop.onCheckpoint(cp(2, T0 + 16 * 60_000, []), 'public-dev');
    expect(s.store.resolution('T1')!.outcome).toBe(0);
    expect(s.writer.queued).toBe(1);
    await s.writer.flush();
    expect(s.notes[0]!.text).toMatch(/^Specimen No\.0001 · .+ · moved again within 15 min: NO \(checkpoint 2\)$/);
  });

  it('memory changes the next call: a remembered outcome is recalled, cited, and predates the call (I3)', async () => {
    const s = setup();
    // round 1: sender A, NO
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]), 'public-dev');
    s.tick(16 * 60_000);
    await s.loop.onCheckpoint(cp(2, T0 + 16 * 60_000, []), 'public-dev');
    await s.writer.flush();
    s.tick(1000);
    // round 2: a never-seen sender with the same species → memory votes NO
    await s.loop.onCheckpoint(cp(3, T0 + 16 * 60_000 + 1000, [{ digest: 'T3', from: C, to: D, amount: BIG }]), 'public-dev');
    const c3 = s.store.call('T3')!;
    expect(c3.sender_seen_before).toBe(false);
    expect(c3.call).toBe('no');
    expect(c3.cited_note_ids).toEqual(['No.0001']);
    expect(Date.parse(c3.cited_created_at![0]!)).toBeLessThan(Date.parse(c3.created_at));
    expect(c3.p_memory).toBeLessThan(c3.p_base);
  });

  it('a sighting never resolves itself, and a replayed checkpoint opens no duplicate round', async () => {
    const s = setup();
    const k = cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]);
    await s.loop.onCheckpoint(k, 'public-dev');
    await s.loop.onCheckpoint(k, 'public-dev');
    expect(s.store.size).toBe(1);
    expect(s.store.resolution('T1')).toBeUndefined();
  });

  it('rebuilds pending rounds and opponents from disk after a restart', async () => {
    const s = setup();
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]), 'public-dev');
    const store2 = new RoundStore(join(s.dir, 'calls.jsonl'), join(s.dir, 'res.jsonl'));
    const mem = new LocalNoteMemory();
    const loop2 = new CoreLoop({ cfg, store: store2, writer: new NoteWriter(() => mem, () => {}), memory: () => mem, notes: [], now: () => T0 + 60_000 });
    expect(loop2.resolver.pendingCount).toBe(1);
    await loop2.onCheckpoint(cp(2, T0 + 60_000, [{ digest: 'T2', from: A, to: C, amount: 5n }]), 'public-dev');
    expect(store2.resolution('T1')!.outcome).toBe(1);
  });
});

function c(s: ReturnType<typeof setup>, id: string): CallRow {
  return s.store.call(id)!;
}

describe('RoundStore invariants', () => {
  const row = (id: string, created_at: string, extra: Partial<CallRow> = {}): CallRow => ({
    round_id: id, created_at, network_source: 'public-dev', checkpoint_seq: '1', checkpoint_ts: 0, tx_digest: id, sender: A, recipient: B,
    coin_type: SUI, amount_raw: '1', horizon_min: 15, move_rule: 'any_transfer', sender_seen_before: false, p_memory: 0.5, call: 'abstain',
    p_base: 0.5, p_freq: 0.5, cited_note_ids: [], cited_distances: [], ...extra,
  });
  const res = (id: string, resolved_at: string) => ({ round_id: id, resolved_at, outcome: 1 as const, reason: 'moved' as const, resolving_checkpoint_seq: '2', resolving_digest: 'X', resolving_ts: 0, network_source: 'public-dev' as const });
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'rimba-')); return new RoundStore(join(d, 'c'), join(d, 'r')); };

  it('I1: refuses a resolution without a call, a second resolution, or one that predates the call', () => {
    const st = fresh();
    expect(() => st.resolveRound(res('X', '2026-11-07T00:00:00Z'))).toThrow(InvariantError);
    st.openRound(row('R', '2026-11-07T00:00:10Z'));
    expect(() => st.resolveRound(res('R', '2026-11-07T00:00:09Z'))).toThrow(/predates/);
    st.resolveRound(res('R', '2026-11-07T00:00:11Z'));
    expect(() => st.resolveRound(res('R', '2026-11-07T00:00:12Z'))).toThrow(/already resolved/);
  });

  it('refuses to open the same round twice', () => {
    const st = fresh();
    st.openRound(row('R', '2026-11-07T00:00:10Z'));
    expect(() => st.openRound(row('R', '2026-11-07T00:00:11Z'))).toThrow(InvariantError);
  });

  it('I3: refuses a call that cites a note written at or after the call', () => {
    expect(() => checkI3(row('R', '2026-11-07T00:00:10Z', { cited_note_ids: ['No.0001'], cited_created_at: ['2026-11-07T00:00:10Z'] }))).toThrow(/I3/);
    expect(() => checkI3(row('R', '2026-11-07T00:00:10Z', { cited_note_ids: ['No.0001'], cited_created_at: ['2026-11-07T00:00:09Z'] }))).not.toThrow();
    expect(() => fresh().openRound(row('R', '2026-11-07T00:00:10Z', { cited_note_ids: ['No.0001'], cited_created_at: ['2026-11-07T00:00:11Z'] }))).toThrow(InvariantError);
  });
});

describe('CoreLoop resilience', () => {
  it('a failed resolution write does not stop the other rounds in the batch from resolving', async () => {
    const s = setup();
    const errors: string[] = [];
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }, { digest: 'T9', from: C, to: B, amount: BIG }]), 'public-dev');
    const orig = s.store.resolveRound.bind(s.store);
    s.store.resolveRound = (row) => { if (row.round_id === 'T1') throw new Error('disk full'); orig(row); };
    (s.loop as unknown as { d: { onError: (m: string) => void } }).d.onError = (m) => errors.push(m);
    s.tick(16 * 60_000);
    await s.loop.onCheckpoint(cp(2, T0 + 16 * 60_000, []), 'public-dev');
    expect(s.store.resolution('T9')!.outcome).toBe(0);
    expect(s.store.resolution('T1')).toBeUndefined();
    expect(errors[0]).toMatch(/T1/);
  });

  it('a throwing observer never strands a round: it is pending in the resolver and still resolves', async () => {
    const s = setup();
    const errors: string[] = [];
    const d = (s.loop as unknown as { d: { emit: () => void; onError: (m: string) => void } }).d;
    d.emit = () => { throw new Error('listener down'); };
    d.onError = (m) => errors.push(m);
    await s.loop.onCheckpoint(cp(1, T0, [{ digest: 'T1', from: A, to: B, amount: BIG }]), 'public-dev');
    expect(s.store.has('T1')).toBe(true);
    expect(s.loop.resolver.pendingCount).toBe(1);
    expect(errors.some((m) => /emit call failed/.test(m))).toBe(true);
    s.tick(16 * 60_000);
    await s.loop.onCheckpoint(cp(2, T0 + 16 * 60_000, []), 'public-dev');
    expect(s.store.resolution('T1')!.outcome).toBe(0);
  });
});
