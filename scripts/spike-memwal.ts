// Spike + day-0 kill test items 5–6 for Walrus Memory (mainnet relayer).
//  - always: relayer health() + compatibility() (public, unsigned)
//  - with credentials: 20-note rememberBulk → wait for jobs; recall with maxDistance on 3 paraphrases
//    of one species (should hit) and 2 unrelated queries (should return nothing).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMemwal } from '../src/config.js';
import { anonymousMemwal, createMemwal, NAMESPACE } from '../src/memory/memwal.js';

const OUT = join(import.meta.dirname, '..', 'evidence', 'day0');
mkdirSync(OUT, { recursive: true });
const MAX_DISTANCE = Number(process.env.RIMBA_MAX_DISTANCE ?? 0.35);

const report: Record<string, unknown> = { measured_at: new Date().toISOString(), relayer: 'https://relayer.memory.walrus.xyz', namespace: NAMESPACE };

const anon = anonymousMemwal();
try {
  const t = Date.now();
  report.health = await anon.health();
  report.health_ms = Date.now() - t;
} catch (e) {
  report.health_error = String(e);
}
try {
  report.compatibility = await anon.compatibility();
} catch (e) {
  report.compatibility_error = String(e);
}
anon.destroy();

const creds = loadMemwal();
if (!creds) {
  report.kill_test_5 = 'pending creds';
  report.kill_test_6 = 'pending creds';
} else {
  const mw = createMemwal(creds)!;
  const species = [
    'large round SUI transfer, single recipient, night UTC, new counterparty',
    'large USDC transfer, single recipient, day UTC, repeat counterparty',
  ];
  const items = Array.from({ length: 20 }, (_, i) => ({
    text: `Specimen No.D0${String(i).padStart(2, '0')} · ${species[i % 2]} · moved again within 10 min: ${i % 3 ? 'YES' : 'NO'} (day-0 calibration note)`,
    namespace: NAMESPACE,
  }));
  const t0 = Date.now();
  const res = await mw.rememberBulkAndWait(items, { timeoutMs: 300_000 });
  report.kill_test_5 = {
    submitted: res.total,
    succeeded: res.succeeded,
    failed: res.failed,
    wall_ms: Date.now() - t0,
    blob_ids: res.results.map((r) => r.blob_id).filter(Boolean),
    pass: res.succeeded === 20,
  };
  const hitQueries = [
    'big round-number SUI send at night to a wallet never seen before',
    'large SUI transfer to a new counterparty during UTC night',
    'night-time whole-number SUI transfer, one recipient, first contact',
  ];
  const missQueries = ['favourite pizza toppings in Naples', 'how to tune a guitar to drop D'];
  const recallOne = async (q: string) => {
    const t = Date.now();
    const r = await mw.recall({ query: q, namespace: NAMESPACE, limit: 20, maxDistance: MAX_DISTANCE, scoringWeights: { semantic: 1, recency: 0.5, recencyHalfLifeDays: 3 } });
    return { query: q, ms: Date.now() - t, n: r.results.length, distances: r.results.map((x) => Number(x.distance.toFixed(3))), sample: r.results[0]?.text };
  };
  const hits = [];
  for (const q of hitQueries) hits.push(await recallOne(q));
  const misses = [];
  for (const q of missQueries) misses.push(await recallOne(q));
  report.kill_test_6 = {
    max_distance: MAX_DISTANCE,
    hits,
    misses,
    pass: hits.every((h) => h.n > 0 && h.sample?.includes('SUI')) && misses.every((m) => m.n === 0),
  };
  mw.destroy();
}
writeFileSync(join(OUT, 'memwal-spike.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
