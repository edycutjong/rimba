import { noteVote } from './fmt.js';
import type { NoteInfo, Round, ScoreSet, SourceStatus } from './types.js';

export const store = {
  notes: {} as Record<string, NoteInfo>,
  score: null as ScoreSet | null,
  history: [] as Round[], // resolved rounds, oldest → newest
  open: new Map<string, Round>(),
  stack: [] as Round[], // most recently resolved first (reef session)
  byId: new Map<string, Round>(),
  status: null as SourceStatus | null,
  focus: null as string | null,
  pinned: null as string | null,
  holdUntil: 0,
  maxD: null as number | null, // judge what-if; null = logged
  horizon: 15,
};

const P_MIN = 0.05, P_MAX = 0.95;
const clamp = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));
export const brier = (p: number, o: number) => (p - o) ** 2;

/** Re-vote a logged call using only cited notes closer than `maxD` — the same formula as src/naturalist.ts,
 * including the minimum-evidence abstain that was in force for that call (`min_evidence`, absent = 0). */
export function revote(r: Round, maxD: number): { p: number; called: boolean; used: number } {
  const usable: { id: string; d: number; v: NonNullable<ReturnType<typeof noteVote>> }[] = [];
  r.cited_note_ids.forEach((id, i) => {
    const d = r.cited_distances[i];
    const info = store.notes[id];
    if (d === undefined || !info || !(d < maxD)) return;
    const v = noteVote(info.text);
    if (v) usable.push({ id, d, v });
  });
  const superseded = new Set(usable.flatMap((u) => u.v.supersedes));
  const live = usable.filter((u) => !superseded.has(u.id));
  if (!live.length) return { p: r.p_base, called: false, used: 0 };
  let wy = 0, wn = 0;
  for (const u of live) {
    const w = Math.max(0.05, 1 - u.d / maxD);
    wy += w * u.v.yes;
    wn += w * u.v.n;
  }
  if (wn < (r.min_evidence ?? 0)) return { p: r.p_base, called: false, used: live.length };
  return { p: clamp((wy + r.p_base) / (wn + 1)), called: true, used: live.length };
}

export function movedWithin(r: Round, minutes: number): number | null {
  const res = r.resolution;
  if (!res || res.outcome === null) return null;
  if (res.reason !== 'moved') return 0;
  return res.resolving_ts - r.checkpoint_ts <= minutes * 60_000 ? 1 : 0;
}

export function cumulative(rs: Round[]): { mem: number[]; base: number[] } {
  const mem: number[] = [], base: number[] = [];
  let sm = 0, sb = 0, n = 0;
  for (const r of rs) {
    const o = r.resolution?.outcome;
    if (o === null || o === undefined) continue;
    n++;
    sm += brier(r.p_memory, o);
    sb += brier(r.p_base, o);
    mem.push(sm / n);
    base.push(sb / n);
  }
  return { mem, base };
}
