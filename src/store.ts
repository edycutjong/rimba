// Append-only local store under data/live/ (git-ignored while live; frozen copies are committed as
// evidence). Calls and resolutions are separate files so a round's predictions are provably on disk
// before its outcome exists (invariant I1); rounds.csv is materialised from the two by `score`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.RIMBA_DATA_DIR ?? join(ROOT, 'data', 'live');

export const files = {
  sightings: () => join(DATA_DIR, 'sightings.jsonl'),
  calls: () => join(DATA_DIR, 'calls.jsonl'),
  resolutions: () => join(DATA_DIR, 'resolutions.jsonl'),
  events: () => join(DATA_DIR, 'events.jsonl'),
  rpc: () => join(DATA_DIR, 'rpc.jsonl'),
  notes: () => join(DATA_DIR, 'notes.jsonl'),
  state: () => join(DATA_DIR, 'state.json'),
  health: () => join(DATA_DIR, 'health.json'),
  /** Pace + counterparty memory of the stream (lastMove, sender>recipient pairs), saved every 5 min and on stop. */
  pace: () => join(DATA_DIR, 'pace.json'),
  /** Tatum credit governor state: usage meter, 402 fallback, duty period, hard-stop latch. */
  governor: () => join(DATA_DIR, 'governor.json'),
};

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const size = existsSync(path) ? statSync(path).size : 0;
  try {
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch (e) {
    // a partial append must not stay behind: a retry would fuse onto it into one unreadable line
    try {
      truncateSync(path, size);
    } catch {
      /* the original error is what matters */
    }
    throw e;
  }
}

export function readJsonl<T>(path: string, onMalformed?: (lineNo: number) => void): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // never fatal for readers; ledgers are repaired at open (repairTornTail) and counted (malformedLines)
      onMalformed?.(i + 1);
    }
  });
  return out;
}

/** Lines that are not valid JSON — after repairTornTail, any count above zero is real ledger corruption. */
export function malformedLines(path: string): number {
  let bad = 0;
  readJsonl(path, () => bad++);
  return bad;
}

/**
 * A crash mid-append can leave a final record without its newline; the next append would then fuse a
 * valid row onto the fragment and lose both. Cut the fragment off (kept beside the ledger as
 * `<file>.torn-<ms>`) so the ledger ends on a record boundary. Returns the fragment's byte length.
 */
export function repairTornTail(path: string, now = Date.now()): number {
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  if (!buf.length || buf[buf.length - 1] === 0x0a) return 0;
  const keep = buf.lastIndexOf(0x0a) + 1;
  writeFileSync(`${path}.torn-${now}`, buf.subarray(keep));
  truncateSync(path, keep);
  return buf.length - keep;
}

export function writeJsonAtomic(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface CallRow {
  round_id: string;
  created_at: string;
  network_source: 'tatum' | 'public-dev';
  checkpoint_seq: string;
  checkpoint_ts: number;
  tx_digest: string;
  sender: string;
  recipient: string;
  coin_type: string;
  amount_raw: string;
  horizon_min: number;
  move_rule: string;
  sender_seen_before: boolean;
  p_memory: number;
  call: 'yes' | 'no' | 'abstain';
  p_base: number;
  p_freq: number;
  cited_note_ids: string[];
  cited_distances: number[];
  // ---- core loop fields (absent on rows from before the naturalist was wired) ----
  species?: string;
  memory_source?: 'walrus' | 'local-dev' | 'none';
  /** Write times of the cited notes, same order as cited_note_ids (I3 evidence). */
  cited_created_at?: (string | null)[];
  abstain_reason?: string;
  recall_ms?: number;
  /** Vote of the cited notes alone (null on abstain) — what the supersede rule compares against. */
  cited_vote_p?: number | null;
  /** The naturalist's minimum weighted evidence (Σ w·n) in force when this call was made; absent = 0 (rule not yet in force). */
  min_evidence?: number;
  /** [embedding distance, species slot distance] of the top recalled notes (calibration data). */
  recall_pairs?: [number, number][];
}

export interface ResolutionRow {
  round_id: string;
  resolved_at: string;
  outcome: 0 | 1 | null;
  reason: 'moved' | 'deadline' | 'gap';
  resolving_checkpoint_seq: string;
  resolving_digest: string;
  resolving_ts: number;
  network_source: 'tatum' | 'public-dev';
}

export interface RimbaConfig {
  horizon_min: number;
  move_rule: 'any_transfer' | 'above_threshold_transfer' | 'any_signed_tx';
  base_rate_prior: number;
  thresholds_raw: Record<string, string>;
  source: string; // where these numbers came from
  naturalist?: { max_distance: { walrus: number; 'local-dev': number }; recall_max_distance?: { walrus: number; 'local-dev': number }; limit: number; shrink: number; min_evidence?: number; recall_timeout_ms: number };
  notes?: { daily_budget: number; supersede_window: number; supersede_cooldown_min: number };
  /** Tatum credit governor (src/stream/governor.ts); missing keys fall back to DEFAULT_BUDGET. */
  tatum_budget?: Partial<import('./stream/governor.js').TatumBudget>;
}

export function loadConfig(): RimbaConfig {
  const p = join(ROOT, 'config', 'rimba.json');
  const c = readJson<RimbaConfig>(p);
  if (!c) throw new Error(`missing ${p}`);
  return c;
}

/** A round's predictions must be on disk before its outcome exists (I1); notes it cites must predate it (I3). */
export class InvariantError extends Error {}

export function checkI3(call: Pick<CallRow, 'round_id' | 'created_at' | 'cited_note_ids' | 'cited_created_at'>): void {
  const t = Date.parse(call.created_at);
  const at = call.cited_created_at ?? [];
  // every citation must carry the time its note was written, and that time must precede the call
  if (call.cited_note_ids.length && at.length !== call.cited_note_ids.length) throw new InvariantError(`I3: round ${call.round_id} cites ${call.cited_note_ids.length} notes but logs ${at.length} creation times`);
  at.forEach((c, i) => {
    if (!c || !(Date.parse(c) < t)) throw new InvariantError(`I3: round ${call.round_id} cites ${call.cited_note_ids[i]} written ${c}, not before call ${call.created_at}`);
  });
}

/**
 * The only writer of calls.jsonl / resolutions.jsonl. Calls are appended at call time; a resolution
 * is appended later, keyed by round_id, and is refused unless its call is already on disk, unresolved,
 * and older than the resolution.
 */
export class RoundStore {
  private calls = new Map<string, CallRow>();
  private resolved = new Map<string, ResolutionRow>();
  /** Bytes cut from a torn final record at open, per ledger (0 = clean). */
  readonly tornBytes: { calls: number; resolutions: number };
  constructor(private callsPath = files.calls(), private resPath = files.resolutions()) {
    this.tornBytes = { calls: repairTornTail(callsPath), resolutions: repairTornTail(resPath) };
    for (const c of readJsonl<CallRow>(callsPath)) this.calls.set(c.round_id, c);
    for (const r of readJsonl<ResolutionRow>(resPath)) this.resolved.set(r.round_id, r);
  }

  has(roundId: string): boolean {
    return this.calls.has(roundId);
  }
  call(roundId: string): CallRow | undefined {
    return this.calls.get(roundId);
  }
  resolution(roundId: string): ResolutionRow | undefined {
    return this.resolved.get(roundId);
  }
  allCalls(): CallRow[] {
    return [...this.calls.values()];
  }
  get size(): number {
    return this.calls.size;
  }

  openRound(row: CallRow): void {
    if (this.calls.has(row.round_id)) throw new InvariantError(`round ${row.round_id} already open`);
    checkI3(row);
    appendJsonl(this.callsPath, row);
    this.calls.set(row.round_id, row);
  }

  resolveRound(row: ResolutionRow): void {
    const call = this.calls.get(row.round_id);
    if (!call) throw new InvariantError(`I1: resolution for unknown round ${row.round_id}`);
    if (this.resolved.has(row.round_id)) throw new InvariantError(`I1: round ${row.round_id} already resolved`);
    if (Date.parse(row.resolved_at) < Date.parse(call.created_at)) throw new InvariantError(`I1: resolution of ${row.round_id} predates its call`);
    appendJsonl(this.resPath, row);
    this.resolved.set(row.round_id, row);
  }
}
