// The naturalist: recall field notes for a species, vote, call. No LLM anywhere in this path.
//   P(yes) = (Σ wᵢ·yesᵢ + k·base) / (Σ wᵢ·nᵢ + k),   wᵢ = 1 − dᵢ/maxDistance
// clamped to [0.05, 0.95]. Abstains (P = base rate) when no usable note is within maxDistance.
// Usable = same horizon, written BEFORE the call (invariant I3), not superseded by another recalled note.
import { parseNote, type ParsedNote } from './notes.js';
import type { NoteMemory, RecalledNote } from './memory/backend.js';

export const P_MIN = 0.05;
export const P_MAX = 0.95;

export interface VoteOptions {
  maxDistance: number;
  horizonMin: number;
  /** Strength of the pull toward the base rate, in pseudo-observations. */
  shrink?: number;
  /** Notes written at/after this instant are ignored (I3). */
  callTimeMs: number;
  maxCited?: number;
}

export interface Citation {
  id: string; // specimen id, e.g. "No.0412"
  distance: number;
  yes: number;
  n: number;
  created_at?: string;
}

export interface Call {
  p: number;
  call: 'yes' | 'no' | 'abstain';
  cited: Citation[];
  /** Vote of the cited notes alone (no base-rate pull), used by the supersede rule. */
  citedVoteP: number | null;
  abstainReason?: 'no-notes-within-distance' | 'memory-unavailable' | 'recall-error';
}

export const clamp = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

export function vote(recalled: RecalledNote[], base: number, o: VoteOptions): Call {
  const k = o.shrink ?? 1;
  const usable: { note: ParsedNote; r: RecalledNote }[] = [];
  for (const r of recalled) {
    if (!(r.distance < o.maxDistance)) continue;
    if (r.created_at && !(Date.parse(r.created_at) < o.callTimeMs)) continue; // I3
    const note = parseNote(r.text);
    if (!note || note.horizonMin !== o.horizonMin) continue;
    usable.push({ note, r });
  }
  const superseded = new Set(usable.flatMap((u) => u.note.supersedes));
  const live = usable.filter((u) => !superseded.has(u.note.specimenId));
  if (!live.length) return { p: base, call: 'abstain', cited: [], citedVoteP: null, abstainReason: 'no-notes-within-distance' };

  let wy = 0, wn = 0;
  const cited: (Citation & { w: number })[] = [];
  for (const { note, r } of live) {
    const w = Math.max(0.05, 1 - r.distance / o.maxDistance);
    wy += w * note.yes;
    wn += w * note.n;
    cited.push({ id: note.specimenId, distance: Number(r.distance.toFixed(4)), yes: note.yes, n: note.n, created_at: r.created_at, w });
  }
  const p = clamp((wy + k * base) / (wn + k));
  cited.sort((a, b) => b.w - a.w);
  return {
    p: Number(p.toFixed(4)),
    call: p >= 0.5 ? 'yes' : 'no',
    cited: cited.slice(0, o.maxCited ?? 5).map(({ w: _w, ...c }) => c),
    citedVoteP: wn > 0 ? wy / wn : null,
  };
}

/** Recall + vote. Any memory failure abstains (never blocks the round, never guesses). */
export async function naturalistCall(mem: NoteMemory | null, speciesText: string, base: number, o: VoteOptions & { limit?: number }): Promise<Call & { recallMs: number; recalled: number }> {
  if (!mem) return { p: base, call: 'abstain', cited: [], citedVoteP: null, abstainReason: 'memory-unavailable', recallMs: 0, recalled: 0 };
  const t = Date.now();
  try {
    const recalled = await mem.recall({ query: speciesText, limit: o.limit ?? 20, maxDistance: o.maxDistance });
    return { ...vote(recalled, base, o), recallMs: Date.now() - t, recalled: recalled.length };
  } catch {
    return { p: base, call: 'abstain', cited: [], citedVoteP: null, abstainReason: 'recall-error', recallMs: Date.now() - t, recalled: 0 };
  }
}
