// Field notes: what the naturalist remembers. One note per resolved round (budget permitting):
//   "Specimen No.0412 · <species sentence> · moved again within 15 min: YES (checkpoint 342417305)"
// When a species' last 5 outcomes disagree with the notes the naturalist recalled for it, a newer
// superseding note carries the fresh tally (memories are immutable — supersede, never delete):
//   "Specimen No.0450 · <species> · last 5 sightings moved again within 15 min: 4 of 5 YES [supersedes No.0398, No.0401] (checkpoint 342419000)"
// Notes hold public chain facts only (bucketed traits, an outcome, a checkpoint number) — no addresses.
import { parseSpecies, type Species } from './species.js';
import { RateLimitedError, type NoteMemory, type StoredNote } from './memory/backend.js';

export interface ParsedNote {
  specimenId: string; // "No.0412"
  species: Species;
  speciesText: string;
  horizonMin: number;
  yes: number;
  n: number;
  supersedes: string[];
  checkpoint: string | null;
}

export function specimenLabel(n: number): string {
  return `No.${String(n).padStart(4, '0')}`;
}

export function outcomeNote(specimen: number, speciesText: string, horizonMin: number, outcome: 0 | 1, checkpoint: string): string {
  return `Specimen ${specimenLabel(specimen)} · ${speciesText} · moved again within ${horizonMin} min: ${outcome ? 'YES' : 'NO'} (checkpoint ${checkpoint})`;
}

export function supersedeNote(specimen: number, speciesText: string, horizonMin: number, yes: number, n: number, supersedes: string[], checkpoint: string): string {
  return `Specimen ${specimenLabel(specimen)} · ${speciesText} · last ${n} sightings moved again within ${horizonMin} min: ${yes} of ${n} YES [supersedes ${supersedes.join(', ')}] (checkpoint ${checkpoint})`;
}

const NOTE_RE = /^Specimen (No\.\d+) · (.+?) · (?:moved again within (\d+) min: (YES|NO)|last (\d+) sightings moved again within (\d+) min: (\d+) of (\d+) YES)(?: \[supersedes ([^\]]+)\])?(?: \(checkpoint (\d+)\))?$/;

export function parseNote(text: string): ParsedNote | null {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return null;
  const species = parseSpecies(m[2]!);
  if (!species) return null;
  const single = m[4] !== undefined;
  const yes = single ? (m[4] === 'YES' ? 1 : 0) : Number(m[7]);
  const n = single ? 1 : Number(m[8]);
  if (!(n > 0) || yes < 0 || yes > n) return null;
  return {
    specimenId: m[1]!,
    species,
    speciesText: m[2]!,
    horizonMin: Number(single ? m[3] : m[6]),
    yes,
    n,
    supersedes: m[9] ? m[9].split(',').map((s) => s.trim()).filter(Boolean) : [],
    checkpoint: m[10] ?? null,
  };
}

// ---------------------------------------------------------------- supersede rule

/**
 * A species drifts when its last `window` outcomes point the other way from the notes the
 * naturalist cited for it: recalled-vote ≥ 0.5 but recent YES rate < 0.5, or vice versa.
 */
export function drifted(recentOutcomes: (0 | 1)[], citedVoteP: number, window = 5): { yes: number; n: number } | null {
  if (recentOutcomes.length < window) return null;
  const last = recentOutcomes.slice(-window);
  const yes = last.reduce<number>((a, b) => a + b, 0);
  const recentYes = yes / window >= 0.5;
  const citedYes = citedVoteP >= 0.5;
  return recentYes !== citedYes ? { yes, n: window } : null;
}

// ---------------------------------------------------------------- writer (budget + priority)

export interface NoteRecord {
  specimen_id: string;
  text: string;
  species: string;
  round_id: string;
  kind: 'outcome' | 'supersede';
  backend: NoteMemory['kind'];
  ok: boolean;
  created_at: string;
  job_id?: string;
  blob_id?: string;
  error?: string;
}

interface Pending {
  specimen: number;
  text: string;
  species: string;
  roundId: string;
  kind: NoteRecord['kind'];
  priority: number;
  queuedAt: number;
}

export interface WriterState {
  next_specimen: number;
  day: string; // UTC yyyy-mm-dd
  written_today: number;
  daily_budget: number;
  rate_limited_today: number;
  next_write_at: number;
}

export interface NoteWriterOptions {
  dailyBudget?: number; // default 400
  minBudget?: number; // floor after 429 cuts
  batchSize?: number; // ≤ 20
  queueCap?: number;
  burst?: number; // writes allowed ahead of the even daily pace
  now?: () => number;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Queues notes and flushes them in batches of ≤20 under a daily write budget paced evenly across
 * the UTC day (plus a small burst). A 429 from the relayer re-queues the batch, honours its
 * Retry-After, and cuts the day's budget by 25% — the budget is measured from the relayer's behaviour.
 */
export class NoteWriter {
  private queue: Pending[] = [];
  private flushing = false;
  readonly opts: Required<NoteWriterOptions>;
  state: WriterState;

  constructor(
    private memory: () => NoteMemory,
    private onStored: (rec: NoteRecord) => void,
    state: Partial<WriterState> = {},
    opts: NoteWriterOptions = {},
  ) {
    this.opts = { dailyBudget: 400, minBudget: 100, batchSize: 20, queueCap: 400, burst: 20, now: Date.now, ...opts };
    const now = this.opts.now();
    this.state = {
      next_specimen: state.next_specimen ?? 1,
      day: state.day ?? utcDay(now),
      written_today: state.written_today ?? 0,
      daily_budget: state.daily_budget ?? this.opts.dailyBudget,
      rate_limited_today: state.rate_limited_today ?? 0,
      next_write_at: state.next_write_at ?? 0,
    };
    this.rollDay(now);
  }

  get queued(): number {
    return this.queue.length;
  }

  private rollDay(now: number) {
    const d = utcDay(now);
    if (d !== this.state.day) {
      this.state.day = d;
      this.state.written_today = 0;
      this.state.rate_limited_today = 0;
      this.state.daily_budget = this.opts.dailyBudget;
    }
  }

  /** Writes allowed right now: even pace through the UTC day + burst, capped by the day's budget. */
  allowance(now = this.opts.now()): number {
    this.rollDay(now);
    const msIntoDay = now - Date.parse(`${this.state.day}T00:00:00Z`);
    const paced = Math.floor((this.state.daily_budget * msIntoDay) / 86_400_000) + this.opts.burst;
    return Math.max(0, Math.min(this.state.daily_budget, paced) - this.state.written_today);
  }

  /** `build` receives the specimen number assigned to this note and returns the note text. */
  enqueue(build: (specimen: number) => string, species: string, roundId: string, kind: NoteRecord['kind'], priority: number): string {
    const specimen = this.state.next_specimen++;
    this.queue.push({ specimen, text: build(specimen), species, roundId, kind, priority, queuedAt: this.opts.now() });
    if (this.queue.length > this.opts.queueCap) {
      // drop the lowest-priority, oldest note
      let worst = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i]!, w = this.queue[worst]!;
        if (a.priority < w.priority || (a.priority === w.priority && a.queuedAt < w.queuedAt)) worst = i;
      }
      this.queue.splice(worst, 1);
    }
    return specimenLabel(specimen);
  }

  /** Flush one batch if budget and backoff allow. Returns the records written (ok or failed). */
  async flush(): Promise<NoteRecord[]> {
    const now = this.opts.now();
    if (this.flushing || !this.queue.length || now < this.state.next_write_at) return [];
    const n = Math.min(this.opts.batchSize, this.allowance(now), this.queue.length);
    if (n <= 0) return [];
    this.flushing = true;
    this.queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    const batch = this.queue.splice(0, n);
    const mem = this.memory();
    try {
      const stored: StoredNote[] = await mem.remember(batch.map((b) => b.text));
      this.state.written_today += batch.length;
      const out = stored.map((s, i) => {
        const b = batch[i]!;
        const rec: NoteRecord = {
          specimen_id: specimenLabel(b.specimen), text: b.text, species: b.species, round_id: b.roundId, kind: b.kind,
          backend: mem.kind, ok: s.ok, created_at: s.created_at, job_id: s.job_id, blob_id: s.blob_id, error: s.error,
        };
        this.onStored(rec);
        return rec;
      });
      return out;
    } catch (e) {
      this.queue.unshift(...batch);
      if (e instanceof RateLimitedError) {
        this.state.rate_limited_today++;
        this.state.daily_budget = Math.max(this.opts.minBudget, Math.floor(this.state.daily_budget * 0.75));
        this.state.next_write_at = this.opts.now() + Math.max(1, e.retryAfterSeconds) * 1000;
      } else {
        this.state.next_write_at = this.opts.now() + 60_000;
      }
      throw e;
    } finally {
      this.flushing = false;
    }
  }
}
