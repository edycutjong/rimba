// pnpm verify --offline                 invariants over local files (no network)
// pnpm verify [--sample 50]             re-derive sampled rounds from the chain via Sui gRPC
//             [--replay-minutes 20]     + replay a contiguous checkpoint window through the same Resolver
//             [--write]                 write evidence/verify-<UTC date>.json/.md
// The chain is read through the Tatum gateway when TATUM_API_KEY / ~/.config/tatum/tatum.env exists;
// otherwise through Sui's public fullnode, and the report says so.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { thresholdMap } from '../src/loop.js';
import type { NoteRecord } from '../src/notes.js';
import { chooseEndpoint, getCheckpoint, getTransaction, makeClients, type RawCheckpoint } from '../src/stream/client.js';
import { files, loadConfig, readJsonl, ROOT, type CallRow, type ResolutionRow } from '../src/store.js';
import { checkNoBoundary, checkSighting, checkYes, offlineChecks, replayWindow } from '../src/verify.js';

const argv = process.argv.slice(2);
const opt = (name: string, dflt: number) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const cfg = loadConfig();
const calls = readJsonl<CallRow>(files.calls());
const resolutions = readJsonl<ResolutionRow>(files.resolutions());
const notes = readJsonl<NoteRecord>(files.notes());
const report: Record<string, unknown> = { generated_at: new Date().toISOString() };

const off = offlineChecks(calls, resolutions, notes);
report.offline = off;
const offFailed = Object.values(off.checks).reduce((a, c) => a + c.failed, 0);
console.log(`offline: ${off.rounds} calls, ${off.resolutions} resolutions`);
for (const [k, v] of Object.entries(off.checks)) console.log(`  ${v.failed ? 'FAIL' : 'ok  '} ${k}: ${v.checked - v.failed}/${v.checked}`);
for (const f of off.findings.slice(0, 10)) console.log(`    ✗ ${f.check} ${f.round_id.slice(0, 12)} — ${f.detail}`);

let onlineFailed = 0;
if (!argv.includes('--offline')) {
  const ep = chooseEndpoint();
  const clients = makeClients(ep);
  report.endpoint = { source: ep.source, host: ep.host };
  console.log(`\nonline via ${ep.host} (${ep.source}${ep.source === 'tatum' ? '' : ' — no Tatum key found; set TATUM_API_KEY to verify through the sponsor gateway'})`);
  const resById = new Map(resolutions.map((r) => [r.round_id, r]));
  const sameQ = calls.filter((c) => c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule);
  const resolved = sameQ.filter((c) => resById.get(c.round_id)?.outcome != null);
  const pool = resolved.some((c) => c.network_source === 'tatum') ? resolved.filter((c) => c.network_source === 'tatum') : resolved;
  const N = Math.min(opt('--sample', 50), pool.length);
  // deterministic-but-spread sample: every k-th round
  const step = pool.length / Math.max(1, N);
  const sample = Array.from({ length: N }, (_, i) => pool[Math.floor(i * step)]!);
  let sOk = 0, oOk = 0;
  const failures: string[] = [];
  const cpCache = new Map<string, RawCheckpoint | undefined>();
  const cpAt = async (seq: string) => {
    if (!cpCache.has(seq)) cpCache.set(seq, (await getCheckpoint(clients, seq, 'sequence_number,digest,summary.timestamp')).checkpoint);
    return cpCache.get(seq);
  };
  for (const c of sample) {
    const r = resById.get(c.round_id)!;
    const s = checkSighting(c, (await getTransaction(clients, c.tx_digest).catch(() => ({ transaction: undefined }))).transaction);
    let o: { ok: boolean; detail: string };
    if (r.outcome === 1) o = checkYes(c, r, (await getTransaction(clients, r.resolving_digest).catch(() => ({ transaction: undefined }))).transaction, cfg.move_rule);
    else o = checkNoBoundary(c, r, await cpAt(r.resolving_checkpoint_seq), await cpAt((BigInt(r.resolving_checkpoint_seq) - 1n).toString()));
    if (s.ok) sOk++;
    if (o.ok) oOk++;
    if (!s.ok || !o.ok) failures.push(`${c.round_id.slice(0, 12)} sighting:${s.detail} outcome:${o.detail}`);
  }
  report.sample = { n: N, pool: pool.length, pool_source: pool[0]?.network_source ?? null, sightings_matched: sOk, outcomes_matched: oOk, failures };
  onlineFailed += N - sOk + (N - oOk);
  console.log(`sample of ${N} resolved rounds (pool ${pool.length}, ${pool[0]?.network_source ?? '—'} rows): sightings ${sOk}/${N} · outcomes ${oOk}/${N} (YES via GetTransaction, NO via GetCheckpoint deadline boundary)`);
  for (const f of failures.slice(0, 10)) console.log(`  ✗ ${f}`);

  const minutes = opt('--replay-minutes', 0);
  if (minutes > 0 && resolved.length) {
    // window = [first sighting of the most recent fully-resolved stretch, +minutes]
    const sorted = [...resolved].sort((a, b) => a.checkpoint_ts - b.checkpoint_ts);
    const lastRes = Math.max(...sorted.map((c) => resById.get(c.round_id)!.resolving_ts));
    const startTs = Math.max(sorted[0]!.checkpoint_ts, lastRes - minutes * 60_000);
    const anchor = sorted.find((c) => c.checkpoint_ts >= startTs)!;
    const first = BigInt(anchor.checkpoint_seq);
    const endTs = anchor.checkpoint_ts + minutes * 60_000;
    const cps: RawCheckpoint[] = [];
    const t0 = Date.now();
    let seq = first;
    const CONC = opt('--concurrency', 6);
    const fetchCp = async (s: bigint): Promise<RawCheckpoint | undefined> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return (await getCheckpoint(clients, s.toString())).checkpoint;
        } catch (e) {
          const code = (e as { code?: number }).code;
          if (code === 5) return undefined; // NOT_FOUND: past the chain tip
          if (attempt >= 6) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 429 / UNAVAILABLE → back off
        }
      }
    };
    outer: for (;;) {
      const batch = await Promise.all(Array.from({ length: CONC }, (_, i) => fetchCp(seq + BigInt(i))));
      for (const cp of batch) {
        if (!cp) break outer;
        cps.push(cp);
        if (Number(cp.summary?.timestamp?.seconds ?? 0) * 1000 > endTs) break outer;
      }
      seq += BigInt(CONC);
    }
    const inWindow = sameQ.filter((c) => BigInt(c.checkpoint_seq) >= first && BigInt(c.checkpoint_seq) <= BigInt(cps[cps.length - 1]!.sequence_number!));
    const rr = replayWindow(cps, inWindow, resById, cfg, thresholdMap(cfg));
    report.replay = { first_seq: first.toString(), last_seq: cps[cps.length - 1]!.sequence_number, checkpoints: cps.length, ms: Date.now() - t0, rounds_in_window: inWindow.length, ...rr };
    onlineFailed += rr.compared - rr.matched;
    console.log(`replay of ${cps.length} checkpoints ${first}..${cps[cps.length - 1]!.sequence_number} (${Math.round((Date.now() - t0) / 1000)} s): sightings re-found ${rr.sightings_found}/${inWindow.length} · outcomes matched ${rr.matched}/${rr.compared}`);
    for (const m of rr.mismatches.slice(0, 10)) console.log(`  ✗ ${m.round_id.slice(0, 12)} local ${m.local} chain ${m.chain} — ${m.detail}`);
  }
  clients.close();
}

if (argv.includes('--write')) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(ROOT, 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `verify-${day}.json`), JSON.stringify(report, null, 2) + '\n');
  console.error(`wrote evidence/verify-${day}.json`);
}
process.exit(offFailed + onlineFailed ? 1 : 0);
