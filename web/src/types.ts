export interface Resolution {
  outcome: 0 | 1 | null;
  reason: 'moved' | 'deadline' | 'gap';
  resolved_at: string;
  resolving_checkpoint_seq: string;
  resolving_digest: string;
  resolving_ts: number;
  network_source: 'tatum' | 'public-dev';
}

export interface Round {
  round_id: string;
  n: number; // catalogue number: position of the call in calls.jsonl
  created_at: string;
  network_source: 'tatum' | 'public-dev';
  memory_source?: 'walrus' | 'local-dev' | 'none';
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
  cited_created_at?: (string | null)[];
  species?: string;
  abstain_reason?: string;
  resolution: Resolution | null;
}

export interface NoteInfo {
  text: string;
  species: string;
  created_at: string;
  backend: string;
  kind: string;
  blob_id?: string;
}

export interface Cell {
  n: number;
  brier_memory: number | null;
  brier_base: number | null;
  brier_freq: number | null;
  skill_vs_base: number | null;
  yes_rate: number | null;
  n_called: number;
  brier_memory_called: number | null;
  brier_base_called: number | null;
}

export interface Scorecard {
  question: { horizon_min: number; move_rule: string };
  filter: { network_source: string; memory_source: string };
  all: Cell;
  never_seen: Cell;
  seen: Cell;
  by_day: ({ day: string } & Cell)[];
  counts: { calls: number; resolved: number; void: number; pending: number; excluded_other_question: number };
}

export interface ScoreSet {
  headline: Scorecard;
  development: Scorecard;
  all_rows: Scorecard;
}

export type Mode = 'live' | 'replay';

/** What a data source tells the UI. All callbacks are optional-safe; the UI is the only consumer. */
export interface Sink {
  /** a call was just made (open round) */
  onCall(r: Round, instant: boolean): void;
  /** a round resolved (r.resolution is set) */
  onResolution(r: Round, instant: boolean): void;
  onNotes(notes: Record<string, NoteInfo>): void;
  onScore(s: ScoreSet): void;
  onStatus(s: SourceStatus): void;
  /** full history for the notebook table (oldest → newest) */
  onHistory(rounds: Round[]): void;
}

export interface SourceStatus {
  mode: Mode;
  horizon_min: number;
  /** newest checkpoint number seen */
  checkpoint: string | null;
  /** 'tatum' | 'public-dev' of the newest row */
  network_source: 'tatum' | 'public-dev' | null;
  memory: string | null;
  note: string | null;
  generated_at?: string;
  csv_url: string;
  /** replay clock speed multiplier */
  speed?: number;
  /** now on the chain's clock (ms) — replay uses virtual time */
  clockMs: number;
}
