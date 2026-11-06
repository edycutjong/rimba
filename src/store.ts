// Append-only local store under data/live/ (git-ignored while live; frozen copies are committed as
// evidence). Calls and resolutions are separate files so a round's predictions are provably on disk
// before its outcome exists (invariant I1); rounds.csv is materialised from the two by `score`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  state: () => join(DATA_DIR, 'state.json'),
  health: () => join(DATA_DIR, 'health.json'),
};

export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n');
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn final line after a crash is skipped, never fatal
    }
  }
  return out;
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
}

export function loadConfig(): RimbaConfig {
  const p = join(ROOT, 'config', 'rimba.json');
  const c = readJson<RimbaConfig>(p);
  if (!c) throw new Error(`missing ${p}`);
  return c;
}
