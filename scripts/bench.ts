// pnpm bench [--write]
// p50/p95 latencies, all measured — nothing estimated:
//   decode           decodeCheckpoint on the 5 committed mainnet fixtures (in-process, 200 rounds each)
//   species+vote     species sentence + local recall over 400 notes + vote (in-process)
//   chain→call       checkpoint timestamp → call row written, from live calls.jsonl, per stream source
//   recall           naturalist recall latency from live calls.jsonl, per memory backend
//   rpc              every sponsor RPC the logger made (rpc.jsonl), per method × source
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LocalNoteMemory } from '../src/memory/backend.js';
import { vote } from '../src/naturalist.js';
import { outcomeNote } from '../src/notes.js';
import { sentence, SLOTS, speciesSentence } from '../src/species.js';
import type { RawCheckpoint } from '../src/stream/client.js';
import { decodeCheckpoint } from '../src/stream/decode.js';
import { files, readJsonl, ROOT, type CallRow } from '../src/store.js';

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}
const stat = (xs: number[], digits = 3) => ({ n: xs.length, p50: round(pct(xs, 50), digits), p95: round(pct(xs, 95), digits) });
const round = (x: number | null, d: number) => (x === null ? null : Number(x.toFixed(d)));

const out: Record<string, unknown> = { generated_at: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}` };

// decode
const FIX = join(ROOT, 'test', 'fixtures');
const cps = readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(FIX, f), 'utf8')).response.checkpoint as RawCheckpoint);
const dec: number[] = [];
for (let i = 0; i < 200; i++) for (const cp of cps) {
  const t = performance.now();
  decodeCheckpoint(cp);
  dec.push(performance.now() - t);
}
out.decode_ms = { ...stat(dec), checkpoints: cps.length, txs_per_checkpoint_mean: Number((cps.reduce((a, c) => a + (c.transactions?.length ?? 0), 0) / cps.length).toFixed(1)) };

// species + local recall + vote
const rnd = (() => { let x = 42; return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); })();
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const randomSpecies = () => sentence({ coin: pick(['SUI', 'USDC']), size: pick(SLOTS.size), shape: pick(SLOTS.shape), recipients: pick(SLOTS.recipients), time: pick(SLOTS.time), counterparty: pick(SLOTS.counterparty), pace: pick(SLOTS.pace), familiarity: pick(SLOTS.familiarity) });
const old = new Date(Date.now() - 3600_000).toISOString();
const mem = new LocalNoteMemory(Array.from({ length: 400 }, (_, i) => ({ text: outcomeNote(i + 1, randomSpecies(), 15, rnd() < 0.46 ? 1 : 0, '1'), created_at: old })));
const sv: number[] = [];
for (let i = 0; i < 1000; i++) {
  const t = performance.now();
  const sp = speciesSentence({ coinType: '0x2::sui::SUI', amountRaw: BigInt(Math.floor(rnd() * 1e13)), thresholdRaw: 282_910_000_000n, recipientsCount: 1 + Math.floor(rnd() * 3), timestampMs: Date.now(), repeatCounterparty: rnd() < 0.3, lastMoveAgoMs: rnd() < 0.2 ? null : rnd() * 7200_000, priorSightings: Math.floor(rnd() * 6) });
  vote(await mem.recall({ query: sp, limit: 20, maxDistance: 0.22 }), 0.46, { maxDistance: 0.22, horizonMin: 15, callTimeMs: Date.now() });
  sv.push(performance.now() - t);
}
out.species_recall_vote_local_ms = { ...stat(sv), notes: 400 };

// live: chain→call and recall, from calls.jsonl
const calls = readJsonl<CallRow>(files.calls());
const bySrc = new Map<string, number[]>();
const recall = new Map<string, number[]>();
for (const c of calls) {
  const lat = Date.parse(c.created_at) - c.checkpoint_ts;
  if (Number.isFinite(lat) && lat >= 0) (bySrc.get(c.network_source) ?? bySrc.set(c.network_source, []).get(c.network_source)!).push(lat);
  if (c.memory_source && c.memory_source !== 'none' && typeof c.recall_ms === 'number') (recall.get(c.memory_source) ?? recall.set(c.memory_source, []).get(c.memory_source)!).push(c.recall_ms);
}
out.chain_to_call_ms = Object.fromEntries([...bySrc].map(([k, v]) => [k, stat(v, 0)]));
out.recall_ms = Object.fromEntries([...recall].map(([k, v]) => [k, stat(v, 0)]));

// live: sponsor RPCs
const rpc = readJsonl<{ method: string; ms: number; ok: boolean; source: string }>(files.rpc());
const groups = new Map<string, { ms: number[]; ok: number; n: number }>();
for (const r of rpc) {
  const k = `${r.method} · ${r.source}`;
  const g = groups.get(k) ?? { ms: [], ok: 0, n: 0 };
  g.n++;
  if (r.ok) { g.ok++; if (r.method !== 'SubscribeCheckpoints') g.ms.push(r.ms); }
  groups.set(k, g);
}
out.rpc_ms = Object.fromEntries([...groups].map(([k, g]) => [k, { ...stat(g.ms, 0), calls: g.n, ok_rate: Number((g.ok / g.n).toFixed(4)) }]));

const md = [
  `# RIMBA bench — ${out.generated_at}`, '', `Node ${process.version}, ${out.platform}. Reproduce: \`pnpm bench\`.`, '',
  '| measure | n | p50 | p95 |', '|---|---|---|---|',
  `| decode one mainnet checkpoint (ms) | ${(out.decode_ms as { n: number }).n} | ${(out.decode_ms as { p50: number }).p50} | ${(out.decode_ms as { p95: number }).p95} |`,
  `| species + local recall (400 notes) + vote (ms) | ${sv.length} | ${round(pct(sv, 50), 3)} | ${round(pct(sv, 95), 3)} |`,
  ...[...bySrc].map(([k, v]) => `| checkpoint → call written, stream ${k} (ms) | ${v.length} | ${pct(v, 50)} | ${pct(v, 95)} |`),
  ...[...recall].map(([k, v]) => `| naturalist recall, memory ${k} (ms) | ${v.length} | ${pct(v, 50)} | ${pct(v, 95)} |`),
  ...[...groups].filter(([, g]) => g.ms.length).map(([k, g]) => `| RPC ${k} (ms, ok ${(100 * g.ok / g.n).toFixed(1)}% of ${g.n}) | ${g.ms.length} | ${pct(g.ms, 50)} | ${pct(g.ms, 95)} |`),
].join('\n') + '\n';
console.log(md);
if (process.argv.includes('--write')) {
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(join(ROOT, 'evidence'), { recursive: true });
  writeFileSync(join(ROOT, 'evidence', `bench-${day}.md`), md);
  writeFileSync(join(ROOT, 'evidence', `bench-${day}.json`), JSON.stringify(out, null, 2) + '\n');
  console.error(`wrote evidence/bench-${day}.md/.json`);
}
