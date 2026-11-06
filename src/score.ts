// Scorecard: Brier score of the three predictions frozen on every round — memory (the naturalist),
// base rate, per-address frequency — on all resolved rounds and on the never-seen-address subset,
// plus a day-by-day curve. Lower Brier is better; 0.25 is a coin flip at p = 0.5.
// Pure functions over calls + resolutions; `scripts/score.ts` is the CLI.
import { brier } from './baselines.js';
import type { CallRow, ResolutionRow, RimbaConfig } from './store.js';

export interface Round extends CallRow {
  resolved_at: string;
  resolving_checkpoint_seq: string;
  resolving_digest: string;
  outcome: 0 | 1;
  brier_memory: number;
  brier_base: number;
  brier_freq: number;
}

export interface Cell {
  n: number;
  brier_memory: number | null;
  brier_base: number | null;
  brier_freq: number | null;
  /** 1 − Brier(memory)/Brier(base): > 0 means memory beat the base rate. */
  skill_vs_base: number | null;
  yes_rate: number | null;
  /** Rounds where memory made a call (did not abstain). */
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

const r4 = (x: number | null) => (x === null ? null : Number(x.toFixed(4)));

export function joinRounds(calls: CallRow[], resolutions: ResolutionRow[]): { rounds: Round[]; void: number; pending: number } {
  const res = new Map(resolutions.map((r) => [r.round_id, r]));
  const rounds: Round[] = [];
  let voided = 0, pending = 0;
  for (const c of calls) {
    const r = res.get(c.round_id);
    if (!r) { pending++; continue; }
    if (r.outcome === null) { voided++; continue; }
    rounds.push({
      ...c, resolved_at: r.resolved_at, resolving_checkpoint_seq: r.resolving_checkpoint_seq, resolving_digest: r.resolving_digest,
      outcome: r.outcome, brier_memory: brier(c.p_memory, r.outcome), brier_base: brier(c.p_base, r.outcome), brier_freq: brier(c.p_freq, r.outcome),
    });
  }
  return { rounds, void: voided, pending };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function cell(rs: Round[]): Cell {
  const bm = mean(rs.map((r) => r.brier_memory));
  const bb = mean(rs.map((r) => r.brier_base));
  const called = rs.filter((r) => r.call !== 'abstain');
  return {
    n: rs.length,
    brier_memory: r4(bm),
    brier_base: r4(bb),
    brier_freq: r4(mean(rs.map((r) => r.brier_freq))),
    skill_vs_base: bm !== null && bb ? r4(1 - bm / bb) : null,
    yes_rate: r4(mean(rs.map((r) => r.outcome))),
    n_called: called.length,
    brier_memory_called: r4(mean(called.map((r) => r.brier_memory))),
    brier_base_called: r4(mean(called.map((r) => r.brier_base))),
  };
}

export interface ScoreFilter {
  network_source?: 'tatum' | 'public-dev' | 'any';
  memory_source?: 'walrus' | 'local-dev' | 'none' | 'any';
}

export function scorecard(calls: CallRow[], resolutions: ResolutionRow[], cfg: Pick<RimbaConfig, 'horizon_min' | 'move_rule'>, f: ScoreFilter = {}): Scorecard {
  const ns = f.network_source ?? 'any', ms = f.memory_source ?? 'any';
  const sameQ = calls.filter((c) => c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule);
  const picked = sameQ.filter((c) => (ns === 'any' || c.network_source === ns) && (ms === 'any' || (c.memory_source ?? 'none') === ms));
  const { rounds, void: voided, pending } = joinRounds(picked, resolutions);
  const days = new Map<string, Round[]>();
  for (const r of rounds) {
    const d = r.created_at.slice(0, 10);
    const arr = days.get(d) ?? [];
    arr.push(r);
    days.set(d, arr);
  }
  return {
    question: { horizon_min: cfg.horizon_min, move_rule: cfg.move_rule },
    filter: { network_source: ns, memory_source: ms },
    all: cell(rounds),
    never_seen: cell(rounds.filter((r) => !r.sender_seen_before)),
    seen: cell(rounds.filter((r) => r.sender_seen_before)),
    by_day: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, rs]) => ({ day, ...cell(rs) })),
    counts: { calls: picked.length, resolved: rounds.length, void: voided, pending, excluded_other_question: calls.length - sameQ.length },
  };
}

// ---------------------------------------------------------------- rounds.csv

export const CSV_COLUMNS = [
  'round_id', 'created_at', 'network_source', 'memory_source', 'checkpoint_seq', 'tx_digest', 'sender', 'recipient', 'coin_type',
  'amount_raw', 'species_sentence', 'sender_seen_before', 'horizon_min', 'move_rule', 'p_memory', 'call', 'p_base', 'p_freq',
  'cited_note_ids', 'cited_distances', 'resolved_at', 'resolving_checkpoint_seq', 'resolving_digest', 'outcome',
  'brier_memory', 'brier_base', 'brier_freq',
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(';') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function roundsCsv(rounds: Round[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rounds) {
    const row: Record<string, unknown> = { ...r, species_sentence: r.species ?? '', memory_source: r.memory_source ?? 'none' };
    row.brier_memory = r4(r.brier_memory);
    row.brier_base = r4(r.brier_base);
    row.brier_freq = r4(r.brier_freq);
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- text report

const f4 = (x: number | null) => (x === null ? '—' : x.toFixed(4));

export function cellRow(label: string, c: Cell): string {
  return `| ${label} | ${c.n} | ${f4(c.brier_memory)} | ${f4(c.brier_base)} | ${f4(c.brier_freq)} | ${c.skill_vs_base === null ? '—' : (c.skill_vs_base * 100).toFixed(1) + '%'} | ${c.n_called} | ${f4(c.brier_memory_called)} vs ${f4(c.brier_base_called)} |`;
}

export function renderScorecard(s: Scorecard, title: string): string {
  const head = '| subset | N | Brier memory | Brier base rate | Brier frequency | skill vs base | memory called | Brier when called (memory vs base) |\n|---|---|---|---|---|---|---|---|';
  const lines = [
    `### ${title}`,
    `Question: does the sender move again within ${s.question.horizon_min} min (rule \`${s.question.move_rule}\`)? Filter: stream \`${s.filter.network_source}\`, memory \`${s.filter.memory_source}\`.`,
    `Rounds: ${s.counts.calls} calls · ${s.counts.resolved} resolved · ${s.counts.void} void (checkpoint gap) · ${s.counts.pending} pending.`,
    '',
    head,
    cellRow('never-seen addresses', s.never_seen),
    cellRow('seen before', s.seen),
    cellRow('all', s.all),
    '',
    '| day (UTC) | N | Brier memory | Brier base rate | Brier frequency | skill vs base | memory called | Brier when called |',
    '|---|---|---|---|---|---|---|---|',
    ...s.by_day.map((d) => cellRow(d.day, d)),
  ];
  return lines.join('\n') + '\n';
}
