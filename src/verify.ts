// Verification. Two layers:
//   offline  — invariants over the local files: I1 (call before resolution, one resolution per round),
//              I2-shape (YES inside the window, NO past the deadline, resolving checkpoint after the
//              sighting), I3 (every cited note was written before the call), prediction ranges.
//   online   — re-derives sampled rounds from the chain via Sui gRPC (Tatum gateway when a key exists):
//              GetTransaction on the sighting and on the YES move, GetCheckpoint on the NO deadline
//              boundary; and `replayWindow`, which feeds a contiguous checkpoint range through the SAME
//              Resolver and compares every outcome (I2: an outcome is a pure function of checkpoints).
import { activitiesOf, sightingsOf } from './loop.js';
import type { NoteRecord } from './notes.js';
import { Resolver } from './resolver.js';
import type { RawCheckpoint, RawTransaction } from './stream/client.js';
import { decodeCheckpoint, decodeTransaction, tsToMs } from './stream/decode.js';
import type { CallRow, ResolutionRow, RimbaConfig } from './store.js';

export interface Finding {
  check: string;
  round_id: string;
  detail: string;
}

export interface OfflineReport {
  rounds: number;
  resolutions: number;
  checks: Record<string, { checked: number; failed: number }>;
  findings: Finding[];
}

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function offlineChecks(calls: CallRow[], resolutions: ResolutionRow[], notes: NoteRecord[]): OfflineReport {
  const checks: OfflineReport['checks'] = {};
  const findings: Finding[] = [];
  const tally = (check: string, ok: boolean, round_id: string, detail: string) => {
    const c = (checks[check] ??= { checked: 0, failed: 0 });
    c.checked++;
    if (!ok) {
      c.failed++;
      if (findings.length < 200) findings.push({ check, round_id, detail });
    }
  };
  const callById = new Map<string, CallRow>();
  for (const c of calls) {
    tally('unique round_id', !callById.has(c.round_id), c.round_id, 'duplicate call row');
    callById.set(c.round_id, c);
    tally('digest format', DIGEST_RE.test(c.tx_digest) && c.round_id === c.tx_digest, c.round_id, `bad digest ${c.tx_digest}`);
    const inRange = [c.p_base, c.p_freq, c.p_memory].every((p) => p >= 0 && p <= 1);
    tally('predictions in [0,1]', inRange, c.round_id, `p_memory=${c.p_memory} p_base=${c.p_base} p_freq=${c.p_freq}`);
    if (c.call === 'abstain') tally('abstain = base rate', c.p_memory === c.p_base, c.round_id, `abstained with p_memory ${c.p_memory} ≠ p_base ${c.p_base}`);
    else tally('memory call clamped [0.05,0.95] and consistent', c.p_memory >= 0.05 && c.p_memory <= 0.95 && (c.call === 'yes') === c.p_memory >= 0.5 && c.cited_note_ids.length > 0, c.round_id, `call ${c.call} p ${c.p_memory} cited ${c.cited_note_ids.length}`);
  }
  const notesById = new Map<string, NoteRecord>();
  for (const n of notes) if (n.ok) notesById.set(`${n.backend}:${n.specimen_id}`, n);
  const seenRes = new Set<string>();
  for (const r of resolutions) {
    const c = callById.get(r.round_id);
    tally('I1 resolution has a call', !!c, r.round_id, 'resolution without a call row');
    tally('I1 one resolution per round', !seenRes.has(r.round_id), r.round_id, 'second resolution');
    seenRes.add(r.round_id);
    if (!c) continue;
    tally('I1 resolved after called', Date.parse(r.resolved_at) >= Date.parse(c.created_at), r.round_id, `resolved ${r.resolved_at} < called ${c.created_at}`);
    const deadline = c.checkpoint_ts + c.horizon_min * 60_000;
    if (r.outcome === 1) {
      tally('I2 YES inside window', r.resolving_ts <= deadline && BigInt(r.resolving_checkpoint_seq) > BigInt(c.checkpoint_seq) && r.resolving_digest !== c.tx_digest && r.reason === 'moved', r.round_id, `YES at ${r.resolving_ts} (deadline ${deadline}) seq ${r.resolving_checkpoint_seq}`);
    } else if (r.outcome === 0) {
      tally('I2 NO past deadline', r.resolving_ts > deadline && BigInt(r.resolving_checkpoint_seq) > BigInt(c.checkpoint_seq) && r.reason === 'deadline', r.round_id, `NO at ${r.resolving_ts} (deadline ${deadline})`);
    } else {
      tally('void only on a checkpoint gap', r.reason === 'gap', r.round_id, `void with reason ${r.reason}`);
    }
  }
  for (const c of calls) {
    if (!c.cited_note_ids.length) continue;
    const t = Date.parse(c.created_at);
    c.cited_note_ids.forEach((id, i) => {
      const at = c.cited_created_at?.[i] ?? null;
      tally('I3 cited note written before call (row)', !!at && Date.parse(at) < t, c.round_id, `${id} at ${at} vs call ${c.created_at}`);
      const rec = notesById.get(`${c.memory_source}:${id}`);
      tally('I3 cited note exists in notes log, written before call', !!rec && Date.parse(rec.created_at) < t, c.round_id, `${id} ${rec ? 'logged ' + rec.created_at : 'missing from notes log'}`);
    });
  }
  return { rounds: calls.length, resolutions: resolutions.length, checks, findings };
}

// ---------------------------------------------------------------- online: per-round re-derivation

export interface Rederived {
  round_id: string;
  sighting_ok: boolean;
  outcome_ok: boolean;
  detail: string;
}

/** The sighting tx, fetched from the chain, decodes to the same sender/coin/amount/checkpoint. */
export function checkSighting(c: CallRow, tx: RawTransaction | undefined): { ok: boolean; detail: string } {
  if (!tx) return { ok: false, detail: 'sighting tx not found' };
  const ts = tsToMs(tx.timestamp);
  const ts_ok = ts === c.checkpoint_ts;
  const transfers = decodeTransaction(tx, String(tx.checkpoint ?? ''), '', ts);
  const t = transfers.find((x) => x.coinType === c.coin_type);
  if (!t) return { ok: false, detail: 'sighting tx has no transfer of that coin' };
  const ok = t.sender === c.sender && t.amountRaw.toString() === c.amount_raw && String(tx.checkpoint) === c.checkpoint_seq && ts_ok;
  return { ok, detail: ok ? 'sighting matches' : `chain: sender ${t.sender.slice(0, 10)} amount ${t.amountRaw} cp ${tx.checkpoint} ts ${ts}` };
}

/** A YES: the resolving tx is a transfer by the same sender, after the sighting, inside the window. */
export function checkYes(c: CallRow, r: ResolutionRow, tx: RawTransaction | undefined, rule: RimbaConfig['move_rule'], thresholds?: Map<string, bigint>): { ok: boolean; detail: string } {
  if (!tx) return { ok: false, detail: 'resolving tx not found' };
  if (rule === 'above_threshold_transfer' && !thresholds) return { ok: false, detail: 'above_threshold_transfer needs the thresholds to verify' };
  const ts = tsToMs(tx.timestamp);
  const deadline = c.checkpoint_ts + c.horizon_min * 60_000;
  const moved = rule === 'any_signed_tx'
    ? tx.effects?.status?.success !== false && (tx.transaction?.sender ?? '').toLowerCase().replace(/^0x0*/, '') === c.sender.replace(/^0x0*/, '')
    : decodeTransaction(tx, String(tx.checkpoint ?? ''), '', ts).some((t) => {
        if (t.sender !== c.sender) return false;
        if (rule !== 'above_threshold_transfer') return true;
        const th = thresholds!.get(t.coinType);
        return th !== undefined && th > 0n && t.amountRaw >= th;
      });
  const ok = moved && ts <= deadline && BigInt(String(tx.checkpoint ?? '0')) > BigInt(c.checkpoint_seq) && String(tx.checkpoint) === r.resolving_checkpoint_seq;
  return { ok, detail: ok ? 'YES re-derived' : `moved=${moved} ts=${ts} deadline=${deadline} cp=${tx.checkpoint}` };
}

/** A NO: the resolving checkpoint is the first past the deadline (its predecessor is not). */
export function checkNoBoundary(c: CallRow, r: ResolutionRow, at: RawCheckpoint | undefined, before: RawCheckpoint | undefined): { ok: boolean; detail: string } {
  const deadline = c.checkpoint_ts + c.horizon_min * 60_000;
  const tA = tsToMs(at?.summary?.timestamp), tB = tsToMs(before?.summary?.timestamp);
  const ok = !!at && !!before && tA > deadline && tB <= deadline && at.digest === r.resolving_digest;
  return { ok, detail: ok ? 'NO deadline boundary re-derived' : `cp ${r.resolving_checkpoint_seq} ts ${tA}, prev ts ${tB}, deadline ${deadline}` };
}

// ---------------------------------------------------------------- online: window replay (I2)

export interface ReplayResult {
  compared: number;
  matched: number;
  mismatches: { round_id: string; local: 0 | 1 | null; chain: 0 | 1 | null; detail: string }[];
  sightings_found: number;
  /** Rounds in the window whose sighting was NOT re-found on chain. */
  sightings_missing: string[];
  /** Missing sequence numbers inside the supplied checkpoint array (a replay over a hole proves nothing). */
  holes: number;
  /** Rounds where the independent oracle and the Resolver disagree (a shared-interpretation bug would show here). */
  oracle_disagreements: string[];
}

/**
 * Independent outcome oracle for one round, written without the Resolver: scan the later checkpoints in
 * order; YES at the first activity by the sender stamped at or before the deadline, NO at the first
 * checkpoint stamped past it, undefined if the window does not close inside `cps`.
 */
export function oracleOutcome(c: CallRow, cps: { seq: bigint; ts: number; digest: string; acts: { sender: string; txDigest: string; timestampMs: number }[] }[], horizonMin: number): { outcome: 0 | 1; seq: string; digest: string } | undefined {
  const start = BigInt(c.checkpoint_seq);
  const deadline = c.checkpoint_ts + horizonMin * 60_000;
  for (const cp of cps) {
    if (cp.seq <= start) continue;
    const hit = cp.acts.find((a) => a.sender === c.sender && a.txDigest !== c.tx_digest && a.timestampMs <= deadline);
    if (hit) return { outcome: 1, seq: cp.seq.toString(), digest: hit.txDigest };
    if (cp.ts > deadline) return { outcome: 0, seq: cp.seq.toString(), digest: cp.digest };
  }
  return undefined;
}

/**
 * Feed checkpoints [first..last] (in order) through a fresh Resolver with the same rules as the logger.
 * Rounds whose sighting is in the range are opened at their checkpoint; every round whose window closes
 * inside the range is compared with the local resolution.
 */
export function replayWindow(cps: RawCheckpoint[], calls: CallRow[], resolutions: Map<string, ResolutionRow>, cfg: Pick<RimbaConfig, 'move_rule' | 'horizon_min'>, thresholds: Map<string, bigint>): ReplayResult {
  const resolver = new Resolver();
  const bySeq = new Map<string, CallRow[]>();
  for (const c of calls) {
    const arr = bySeq.get(c.checkpoint_seq) ?? [];
    arr.push(c);
    bySeq.set(c.checkpoint_seq, arr);
  }
  const chain = new Map<string, { outcome: 0 | 1 | null; seq: string; digest: string }>();
  let sightingsFound = 0;
  const missing: string[] = [];
  let holes = 0;
  let prevSeq: bigint | null = null;
  const flat: Parameters<typeof oracleOutcome>[1] = [];
  for (const cp of cps) {
    const seq = BigInt(cp.sequence_number!);
    if (prevSeq !== null && seq !== prevSeq + 1n) holes += Number(seq - prevSeq - 1n) || 1;
    prevSeq = seq;
    const ts = tsToMs(cp.summary?.timestamp);
    const transfers = decodeCheckpoint(cp);
    const sightings = sightingsOf(transfers, thresholds);
    const acts = activitiesOf(cfg.move_rule, cp, transfers, sightings);
    flat.push({ seq, ts, digest: cp.digest ?? '', acts });
    for (const r of resolver.onCheckpoint(seq, cp.digest ?? '', ts, acts)) {
      chain.set(r.roundId, { outcome: r.outcome, seq: r.resolvingCheckpointSeq, digest: r.resolvingDigest });
    }
    for (const c of bySeq.get(cp.sequence_number!) ?? []) {
      const s = sightings.find((x) => x.txDigest === c.tx_digest);
      if (s && s.sender === c.sender) sightingsFound++;
      else missing.push(c.round_id);
      resolver.add({ roundId: c.round_id, sender: c.sender, txDigest: c.tx_digest, checkpointSeq: seq, timestampMs: c.checkpoint_ts, deadlineMs: c.checkpoint_ts + cfg.horizon_min * 60_000 });
    }
  }
  const out: ReplayResult = { compared: 0, matched: 0, mismatches: [], sightings_found: sightingsFound, sightings_missing: missing, holes, oracle_disagreements: [] };
  const callById = new Map(calls.map((c) => [c.round_id, c]));
  for (const [id, ch] of chain) {
    const c = callById.get(id);
    const o = c && ch.outcome !== null ? oracleOutcome(c, flat, cfg.horizon_min) : undefined;
    if (ch.outcome !== null && (!o || o.outcome !== ch.outcome || o.seq !== ch.seq || o.digest !== ch.digest)) out.oracle_disagreements.push(id);
    const local = resolutions.get(id);
    if (!local || local.outcome === null) continue; // void locally (gap) — nothing to compare
    out.compared++;
    const same = local.outcome === ch.outcome && local.resolving_checkpoint_seq === ch.seq && local.resolving_digest === ch.digest;
    if (same) out.matched++;
    else out.mismatches.push({ round_id: id, local: local.outcome, chain: ch.outcome, detail: `local ${local.resolving_checkpoint_seq}/${local.resolving_digest.slice(0, 8)} chain ${ch.seq}/${ch.digest.slice(0, 8)}` });
  }
  return out;
}
