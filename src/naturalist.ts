// The naturalist: recall field notes for a species, vote, call. No LLM anywhere in this path.
//   P(yes) = (Σ wᵢ·yesᵢ + k·base) / (Σ wᵢ·nᵢ + k),   wᵢ = 1 − dᵢ/maxDistance
// clamped to [0.05, 0.95]. Abstains (P = base rate) when no usable note is within maxDistance, or when the
// usable notes add up to less than `minEvidence` weighted observations (Σ wᵢ·nᵢ < minEvidence).
// Usable = same horizon, with a creation time that is BEFORE the call (invariant I3; no timestamp = not usable),
// not superseded by another recalled note.
import { parseNote, type ParsedNote } from './notes.js';
import type { NoteMemory, RecalledNote } from './memory/backend.js';
import { parseSpecies, speciesDistance } from './taxon.js';

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
  /** Abstain unless the usable notes add up to at least this many weighted observations (Σ wᵢ·nᵢ). 0 = off. */
  minEvidence?: number;
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
  abstainReason?: 'no-notes-within-distance' | 'too-little-evidence' | 'memory-unavailable' | 'recall-error';
}

export const clamp = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

export function vote(recalled: RecalledNote[], base: number, o: VoteOptions): Call {
  const k = o.shrink ?? 1;
  const usable: { note: ParsedNote; r: RecalledNote }[] = [];
  for (const r of recalled) {
    if (!(Number.isFinite(r.distance) && r.distance >= 0 && r.distance < o.maxDistance)) continue;
    // I3, fail-closed: a note with no parseable creation time cannot prove it predates the call
    if (!r.created_at || !(Date.parse(r.created_at) < o.callTimeMs)) continue;
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
  cited.sort((a, b) => b.w - a.w);
  const citedOut = cited.slice(0, o.maxCited ?? 20).map(({ w: _w, ...c }) => c);
  // Too little evidence: report the base rate, but keep the citations so the abstain is auditable.
  if (wn < (o.minEvidence ?? 0)) return { p: base, call: 'abstain', cited: citedOut, citedVoteP: wn > 0 ? wy / wn : null, abstainReason: 'too-little-evidence' };
  const p = clamp((wy + k * base) / (wn + k));
  return {
    p: Number(p.toFixed(4)),
    call: p >= 0.5 ? 'yes' : 'no',
    cited: citedOut,
    citedVoteP: wn > 0 ? wy / wn : null,
  };
}

/**
 * [embedding distance, species slot distance] for the top recalled notes — the data that calibrates
 * Walrus Memory's `maxDistance` against the deterministic species distance (scripts/calibrate.ts).
 */
export function recallPairs(query: string, recalled: RecalledNote[], max = 10): [number, number][] {
  const qs = parseSpecies(query);
  if (!qs) return [];
  const out: [number, number][] = [];
  for (const r of recalled.slice(0, max)) {
    const ns = parseNote(r.text)?.species;
    if (ns) out.push([Number(r.distance.toFixed(4)), speciesDistance(qs, ns)]);
  }
  return out;
}

export type NaturalistResult = Call & { recallMs: number; recalled: number; pairs: [number, number][] };

/**
 * Recall + vote. Any memory failure abstains (never blocks the round, never guesses).
 * `recallMaxDistance` (≥ maxDistance) widens what is fetched so near-misses are logged for
 * calibration; only notes under `maxDistance` vote.
 */
export async function naturalistCall(mem: NoteMemory | null, speciesText: string, base: number, o: VoteOptions & { limit?: number; recallMaxDistance?: number }): Promise<NaturalistResult> {
  if (!mem) return { p: base, call: 'abstain', cited: [], citedVoteP: null, abstainReason: 'memory-unavailable', recallMs: 0, recalled: 0, pairs: [] };
  const t = Date.now();
  try {
    const recalled = await mem.recall({ query: speciesText, limit: o.limit ?? 20, maxDistance: Math.max(o.maxDistance, o.recallMaxDistance ?? 0) });
    return { ...vote(recalled, base, o), recallMs: Date.now() - t, recalled: recalled.length, pairs: recallPairs(speciesText, recalled) };
  } catch {
    return { p: base, call: 'abstain', cited: [], citedVoteP: null, abstainReason: 'recall-error', recallMs: Date.now() - t, recalled: 0, pairs: [] };
  }
}
