import type { Round } from './types.js';

export type Coin = 'SUI' | 'USDC' | 'other';

export function coinOf(coinType: string): Coin {
  if (coinType.endsWith('::sui::SUI')) return 'SUI';
  if (coinType.endsWith('::usdc::USDC')) return 'USDC';
  return 'other';
}

export function amountOf(r: Pick<Round, 'amount_raw' | 'coin_type'>): number {
  const raw = Number(r.amount_raw);
  const c = coinOf(r.coin_type);
  return c === 'SUI' ? raw / 1e9 : c === 'USDC' ? raw / 1e6 : raw;
}

export function fmtAmount(r: Pick<Round, 'amount_raw' | 'coin_type'>): string {
  const a = amountOf(r);
  const n = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toLocaleString('en-US', { maximumFractionDigits: 1 });
  const c = coinOf(r.coin_type);
  return `${n} ${c === 'other' ? 'tokens' : c}`;
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const b4 = (x: number | null) => (x === null ? '—' : x.toFixed(4));
export const catNo = (n: number) => `No. ${String(n).padStart(4, '0')}`;
/** counts as the README prints them: 1,130 */
export const fmtN = (n: number) => n.toLocaleString('en-US');

/** "8 Nov 2026, 01:00 UTC" — when a snapshot was recorded */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

/** A field note as written: "Specimen No.0001 · <species> · <outcome clause>" (null if it has another shape). */
export function noteParts(text: string): { id: string; species: string; clause: string } | null {
  const parts = text.replace(/^Specimen /, '').split(' · ');
  if (parts.length !== 3) return null;
  const [id, species, clause] = parts as [string, string, string];
  return { id, species, clause };
}

/** The note's species traits, word by word, flagged where they differ from the sighting's sentence:
 * a trait that appears verbatim in the sighting matches; otherwise its words are compared with the trait
 * in the same position. Presentation only — the distance itself comes from the recall. */
export function traitDiff(noteSpecies: string, sighting: string): { w: string; diff: boolean }[][] {
  const mine = sighting.split(', ');
  const have = new Set(mine);
  return noteSpecies.split(', ').map((trait, i) => {
    const words = trait.split(' ');
    if (have.has(trait)) return words.map((w) => ({ w, diff: false }));
    const peer = new Set((mine[i] ?? '').split(' '));
    return words.map((w) => ({ w, diff: !peer.has(w) }));
  });
}
export const short = (s: string, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

/** Deep link `?snap=YYYY-MM-DD` replays an archived snapshot (e.g. the one a demo video was recorded from);
 * anything else, including path tricks, falls back to the current snapshot. */
export const snapshotPath = (snap: string | null): string =>
  snap !== null && /^\d{4}-\d{2}-\d{2}$/.test(snap) ? `data/archive/snapshot-${snap}.json` : 'data/snapshot.json';
export const suiscanCheckpoint = (seq: string) => `https://suiscan.xyz/mainnet/checkpoint/${seq}`;
export const suiscanTx = (digest: string) => `https://suiscan.xyz/mainnet/tx/${digest}`;

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'moments';
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** Did the naturalist's call match the chain? abstain → null (nothing to be right or wrong about). */
export function verdict(r: Round): 'right' | 'wrong' | 'abstain' | null {
  if (!r.resolution || r.resolution.outcome === null) return null;
  if (r.call === 'abstain') return 'abstain';
  return (r.call === 'yes') === (r.resolution.outcome === 1) ? 'right' : 'wrong';
}

export const callLine = (r: Round) =>
  r.call === 'abstain'
    ? `ABSTAIN — ${r.abstain_reason === 'too-little-evidence' ? 'too little evidence' : r.abstain_reason === 'recall-error' || r.abstain_reason === 'memory-unavailable' ? 'memory unavailable' : 'no close notes'}, base rate ${pct(r.p_base)}`
    : `${r.call.toUpperCase()} ${pct(r.call === 'yes' ? r.p_memory : 1 - r.p_memory)}`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const NOTE_RE = /moved again within \d+ min: (YES|NO)|last (\d+) sightings moved again within \d+ min: (\d+) of (\d+) YES(?: \[supersedes ([^\]]+)\])?/;
export interface NoteVote {
  yes: number;
  n: number;
  supersedes: string[];
}
export function noteVote(text: string): NoteVote | null {
  const m = NOTE_RE.exec(text);
  if (!m) return null;
  const sup = m[5] ? m[5].split(',').map((s) => s.trim()) : [];
  if (m[1]) return { yes: m[1] === 'YES' ? 1 : 0, n: 1, supersedes: sup };
  return { yes: Number(m[3]), n: Number(m[4]), supersedes: sup };
}
