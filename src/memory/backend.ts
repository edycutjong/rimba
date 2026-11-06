// The naturalist talks to memory through one small interface with two implementations:
//   walrus     — Walrus Memory (the judged path): recall + rememberBulk on the mainnet relayer;
//   local-dev  — a stand-in used ONLY while no Walrus Memory credentials exist, so the loop can run
//                end-to-end. Every round records which one answered (`memory_source`) and local-dev
//                rounds never feed a headline number — the same rule as `public-dev` stream rows.
import { parseSpecies, speciesDistance } from '../taxon.js';
import { parseNote } from '../notes.js';

export type MemorySource = 'walrus' | 'local-dev';

export interface RecalledNote {
  text: string;
  distance: number;
  /** RFC3339 write time (relayer-recorded for walrus). */
  created_at?: string;
  blob_id?: string;
}

export interface RecallQuery {
  query: string;
  limit: number;
  maxDistance: number;
}

export interface StoredNote {
  text: string;
  ok: boolean;
  job_id?: string;
  blob_id?: string;
  /** When the write was confirmed (walrus: job reached `done`). */
  created_at: string;
  error?: string;
}

export class RateLimitedError extends Error {
  constructor(public retryAfterSeconds: number, message = 'rate limited (429)') {
    super(message);
  }
}

export interface NoteMemory {
  readonly kind: MemorySource;
  recall(q: RecallQuery): Promise<RecalledNote[]>;
  /** Write up to 20 notes; resolves when every write is confirmed or failed. */
  remember(texts: string[]): Promise<StoredNote[]>;
}

/** In-process stand-in. Distance = weighted slot distance between the species in the two texts. */
export class LocalNoteMemory implements NoteMemory {
  readonly kind = 'local-dev' as const;
  private notes: { text: string; created_at: string; species: ReturnType<typeof parseSpecies> }[] = [];
  constructor(seed: { text: string; created_at: string }[] = [], private now: () => number = Date.now) {
    for (const n of seed) this.add(n.text, n.created_at);
  }

  private add(text: string, created_at: string) {
    this.notes.push({ text, created_at, species: parseNote(text)?.species ?? null });
  }

  get size(): number {
    return this.notes.length;
  }

  async recall(q: RecallQuery): Promise<RecalledNote[]> {
    const qs = parseSpecies(q.query);
    if (!qs) return [];
    const scored: RecalledNote[] = [];
    for (const n of this.notes) {
      if (!n.species) continue;
      const distance = speciesDistance(qs, n.species);
      // SDK semantics: drop memories whose distance is >= maxDistance
      if (distance < q.maxDistance) scored.push({ text: n.text, distance, created_at: n.created_at });
    }
    // relevance first, newest first among ties (mirrors recency-weighted ranking)
    scored.sort((a, b) => a.distance - b.distance || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    return scored.slice(0, q.limit);
  }

  async remember(texts: string[]): Promise<StoredNote[]> {
    const created_at = new Date(this.now()).toISOString();
    return texts.map((text) => {
      this.add(text, created_at);
      return { text, ok: true, created_at };
    });
  }
}
