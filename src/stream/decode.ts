// Checkpoint → transfers. A *transfer* is a successful transaction in which the signer's balance of a
// coin goes down and at least one OTHER address's balance of that coin goes up. Swaps through shared
// pools produce no positive change for another address, so they are not transfers.
import type { RawCheckpoint, RawTimestamp, RawTransaction } from './client.js';

export interface Transfer {
  checkpointSeq: string;
  checkpointDigest: string;
  txDigest: string;
  timestampMs: number;
  sender: string;
  /** Recipients sorted by amount received, largest first. */
  recipients: string[];
  coinType: string;
  /** Total received by non-sender addresses, in the coin's base units. */
  amountRaw: bigint;
}

export function tsToMs(ts?: RawTimestamp): number {
  if (!ts?.seconds) return 0;
  return Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
}

/** Canonical lowercase 0x-prefixed 64-hex address (Sui addresses may arrive unpadded). */
export function normAddr(a: string): string {
  const h = a.toLowerCase().replace(/^0x/, '');
  return '0x' + h.padStart(64, '0');
}

/** Normalise coin types so `0x2::sui::SUI` and the long form compare equal. */
export function normCoin(t: string): string {
  const m = /^0x([0-9a-fA-F]+)(::.*)$/.exec(t);
  if (!m) return t;
  return '0x' + m[1]!.toLowerCase().padStart(64, '0') + m[2];
}

export function decodeTransaction(tx: RawTransaction, cpSeq: string, cpDigest: string, cpTsMs: number): Transfer[] {
  if (tx.effects?.status?.success === false) return [];
  const sender = tx.transaction?.sender;
  if (!sender || !tx.digest || !tx.balance_changes?.length) return [];
  const s = normAddr(sender);
  const byCoin = new Map<string, { senderDelta: bigint; incoming: Map<string, bigint> }>();
  for (const bc of tx.balance_changes) {
    if (!bc.address || !bc.coin_type || bc.amount === undefined) continue;
    let amt: bigint;
    try {
      amt = BigInt(bc.amount);
    } catch {
      continue;
    }
    const coin = normCoin(bc.coin_type);
    const addr = normAddr(bc.address);
    let e = byCoin.get(coin);
    if (!e) byCoin.set(coin, (e = { senderDelta: 0n, incoming: new Map() }));
    if (addr === s) e.senderDelta += amt;
    else if (amt > 0n) e.incoming.set(addr, (e.incoming.get(addr) ?? 0n) + amt);
  }
  const ts = tsToMs(tx.timestamp) || cpTsMs;
  const out: Transfer[] = [];
  for (const [coinType, e] of byCoin) {
    if (e.senderDelta >= 0n || e.incoming.size === 0) continue;
    const recips = [...e.incoming.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    // Amount moved = what other addresses received, capped by what the sender lost (gas excluded).
    let received = 0n;
    for (const [, v] of recips) received += v;
    const lost = -e.senderDelta;
    out.push({
      checkpointSeq: cpSeq,
      checkpointDigest: cpDigest,
      txDigest: tx.digest,
      timestampMs: ts,
      sender: s,
      recipients: recips.map(([a]) => a),
      coinType,
      amountRaw: received < lost ? received : lost,
    });
  }
  return out;
}

export function decodeCheckpoint(cp: RawCheckpoint): Transfer[] {
  const seq = cp.sequence_number ?? '';
  const digest = cp.digest ?? '';
  const ts = tsToMs(cp.summary?.timestamp);
  const out: Transfer[] = [];
  for (const tx of cp.transactions ?? []) out.push(...decodeTransaction(tx, seq, digest, ts));
  return out;
}
