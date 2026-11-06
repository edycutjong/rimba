import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawCheckpoint, RawTransaction } from '../src/stream/client.js';
import { decodeCheckpoint, decodeTransaction, normAddr, normCoin, tsToMs } from '../src/stream/decode.js';

const FIX = join(import.meta.dirname, 'fixtures');
const SUI = '0x2::sui::SUI';
const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const C = '0x' + 'c'.repeat(64);

function tx(p: Partial<RawTransaction>): RawTransaction {
  return { digest: 'D1', transaction: { sender: A }, effects: { status: { success: true } }, ...p };
}

describe('decodeTransaction', () => {
  it('turns a sender debit + recipient credit into one transfer, excluding gas from the amount', () => {
    const t = decodeTransaction(tx({ balance_changes: [
      { address: A, coin_type: SUI, amount: '-1000002000' },
      { address: B, coin_type: SUI, amount: '1000000000' },
    ] }), '7', 'CP', 1000);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ sender: A, recipients: [B], amountRaw: 1_000_000_000n, checkpointSeq: '7', timestampMs: 1000 });
    expect(t[0]!.coinType).toBe(normCoin(SUI));
  });

  it('ignores swaps through shared pools (no other address credited)', () => {
    expect(decodeTransaction(tx({ balance_changes: [
      { address: A, coin_type: SUI, amount: '-5000' },
      { address: A, coin_type: '0xdead::usdc::USDC', amount: '42' },
    ] }), '1', 'CP', 0)).toEqual([]);
  });

  it('ignores failed transactions', () => {
    expect(decodeTransaction(tx({ effects: { status: { success: false } }, balance_changes: [
      { address: A, coin_type: SUI, amount: '-5' }, { address: B, coin_type: SUI, amount: '5' },
    ] }), '1', 'CP', 0)).toEqual([]);
  });

  it('orders multiple recipients by amount and caps the amount by what the sender lost', () => {
    const [t] = decodeTransaction(tx({ balance_changes: [
      { address: A, coin_type: SUI, amount: '-300' },
      { address: B, coin_type: SUI, amount: '100' },
      { address: C, coin_type: SUI, amount: '400' },
    ] }), '1', 'CP', 0);
    expect(t!.recipients).toEqual([C, B]);
    expect(t!.amountRaw).toBe(300n);
  });

  it('prefers the transaction timestamp over the checkpoint timestamp', () => {
    const [t] = decodeTransaction(tx({ timestamp: { seconds: '10', nanos: 5_000_000 }, balance_changes: [
      { address: A, coin_type: SUI, amount: '-1' }, { address: B, coin_type: SUI, amount: '1' },
    ] }), '1', 'CP', 99);
    expect(t!.timestampMs).toBe(10_005);
  });
});

describe('normalisers', () => {
  it('pads short addresses and coin package ids', () => {
    expect(normAddr('0x2')).toBe('0x' + '0'.repeat(63) + '2');
    expect(normCoin('0x2::sui::SUI')).toBe('0x' + '0'.repeat(63) + '2::sui::SUI');
    expect(tsToMs(undefined)).toBe(0);
  });
});

describe('real mainnet fixtures', () => {
  const fixtures = readdirSync(FIX).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
  it('has at least 5 captured checkpoints', () => expect(fixtures.length).toBeGreaterThanOrEqual(5));
  for (const f of fixtures) {
    it(`decodes ${f} without throwing and every transfer is well-formed`, () => {
      const cp = (JSON.parse(readFileSync(join(FIX, f), 'utf8')) as { response: { checkpoint: RawCheckpoint } }).response.checkpoint;
      expect(cp.sequence_number).toMatch(/^\d+$/);
      expect(cp.transactions?.length ?? 0).toBeGreaterThan(0);
      for (const t of decodeCheckpoint(cp)) {
        expect(t.sender).toMatch(/^0x[0-9a-f]{64}$/);
        expect(t.amountRaw > 0n).toBe(true);
        expect(t.recipients).not.toContain(t.sender);
        expect(t.checkpointSeq).toBe(cp.sequence_number);
      }
    });
  }
});
