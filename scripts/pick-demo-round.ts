/**
 * pick-demo-round — choose the rounds the demo video shows, by rule, from the published snapshot.
 *
 *   pnpm pick-demo [path/to/snapshot.json]
 *
 * Hero round: a wallet the naturalist had never seen, a real call (not an abstain) that cites ≥ 3 notes,
 * a memory probability at least 15 points away from the base rate, and a call the chain proved right.
 * Wrong round: a real call the chain proved wrong (never-seen wallet preferred) — shown on camera on purpose.
 * Ties break on the larger memory-vs-base gap, then the shorter wait, then round id, so the pick is reproducible.
 * Only rounds inside the snapshot qualify: the reef can deep-link them (`/?round=<id>`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/store.js';

interface Res {
  outcome: 0 | 1 | null;
  reason: string;
  resolving_checkpoint_seq: string;
  resolving_ts: number;
}
interface SnapRound {
  round_id: string;
  n: number;
  species?: string;
  sender: string;
  sender_seen_before: boolean;
  call: 'yes' | 'no' | 'abstain';
  p_memory: number;
  p_base: number;
  p_freq: number;
  cited_note_ids: string[];
  checkpoint_seq: string;
  checkpoint_ts: number;
  network_source: string;
  memory_source?: string;
  resolution: Res | null;
}

const path = process.argv[2] ?? join(ROOT, 'web/public/data/snapshot.json');
const snap = JSON.parse(readFileSync(path, 'utf8')) as { generated_at: string; rounds: SnapRound[] };

const verdict = (r: SnapRound) =>
  !r.resolution || r.resolution.outcome === null || r.call === 'abstain'
    ? null
    : (r.call === 'yes') === (r.resolution.outcome === 1)
      ? 'right'
      : 'wrong';
const gap = (r: SnapRound) => Math.abs(r.p_memory - r.p_base);
const waitS = (r: SnapRound) => (r.resolution ? (r.resolution.resolving_ts - r.checkpoint_ts) / 1000 : Infinity);
const order = (a: SnapRound, b: SnapRound) => gap(b) - gap(a) || waitS(a) - waitS(b) || a.round_id.localeCompare(b.round_id);

const real = snap.rounds.filter((r) => r.call !== 'abstain' && r.cited_note_ids.length >= 3);
const hero = real.filter((r) => !r.sender_seen_before && gap(r) >= 0.15 && verdict(r) === 'right').sort(order)[0];
const wrongPool = real.filter((r) => verdict(r) === 'wrong');
const wrong = [...wrongPool.filter((r) => !r.sender_seen_before), ...wrongPool.filter((r) => r.sender_seen_before)].sort(
  (a, b) => Number(a.sender_seen_before) - Number(b.sender_seen_before) || waitS(a) - waitS(b) || order(a, b),
)[0];

const show = (label: string, r: SnapRound | undefined) => {
  if (!r) return { label, found: false };
  return {
    label,
    found: true,
    round_id: r.round_id,
    catalogue: `No. ${String(r.n).padStart(4, '0')}`,
    species: r.species ?? null,
    first_seen_wallet: !r.sender_seen_before,
    call: r.call,
    p_memory: r.p_memory,
    p_base: r.p_base,
    p_freq: r.p_freq,
    cited_notes: r.cited_note_ids.length,
    outcome: r.resolution?.outcome ?? null,
    reason: r.resolution?.reason ?? null,
    verdict: verdict(r),
    wait_s: Math.round(waitS(r)),
    sighted_checkpoint: r.checkpoint_seq,
    resolving_checkpoint: r.resolution?.resolving_checkpoint_seq ?? null,
    data: `${r.network_source} × ${r.memory_source ?? 'none'}`,
    deep_link: `/?round=${r.round_id}`,
  };
};

console.log(
  JSON.stringify(
    { snapshot: path.replace(ROOT + '/', ''), generated_at: snap.generated_at, candidates: { hero: real.filter((r) => !r.sender_seen_before && gap(r) >= 0.15 && verdict(r) === 'right').length, wrong: wrongPool.length }, hero: show('hero', hero), wrong: show('wrong', wrong) },
    null,
    2,
  ),
);
if (!hero || !wrong) process.exitCode = 1;
