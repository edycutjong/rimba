// Day-0 kill test (measurements 1–3). Two modes:
//   collect <minutes> <out.jsonl>  — stream checkpoints, append every transfer + every signer (compact JSONL)
//   analyze <in.jsonl> <outDir>    — choose per-coin thresholds (~1–4 sightings/min) and measure the base
//                                    rate of "sender moves again within H" for H ∈ {2,5,10,15,30}.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeClients, subscribeCheckpoints, type RawSubscribeResponse } from '../src/stream/client.js';
import { decodeCheckpoint, normAddr, tsToMs as tsToMsSafe } from '../src/stream/decode.js';

const [mode, a1, a2] = process.argv.slice(2);

if (mode === 'collect') {
  const minutes = Number(a1 ?? 60);
  const out = a2 ?? 'data/live/day0/raw.jsonl';
  mkdirSync(dirname(out), { recursive: true });
  const endAt = Date.now() + minutes * 60_000;
  const c = makeClients();
  appendFileSync(out, JSON.stringify({ k: 'meta', source: c.endpoint.source, host: c.endpoint.host, startedAt: new Date().toISOString(), minutes }) + '\n');
  let cps = 0;
  const start = () => {
    const st = subscribeCheckpoints(c);
    st.on('data', (r: RawSubscribeResponse) => {
      const cp = r.checkpoint;
      if (!cp?.sequence_number) return;
      cps++;
      const ts = tsToMsSafe(cp.summary?.timestamp);
      const lines: string[] = [JSON.stringify({ k: 'cp', seq: cp.sequence_number, ts, n: cp.transactions?.length ?? 0 })];
      for (const tx of cp.transactions ?? []) {
        if (tx.effects?.status?.success === false || !tx.transaction?.sender) continue;
        lines.push(JSON.stringify({ k: 'tx', s: normAddr(tx.transaction.sender), ts, seq: cp.sequence_number }));
      }
      for (const t of decodeCheckpoint(cp)) {
        lines.push(JSON.stringify({ k: 'tr', s: t.sender, r: t.recipients[0], nr: t.recipients.length, c: t.coinType, a: t.amountRaw.toString(), ts: t.timestampMs, seq: t.checkpointSeq, d: t.txDigest }));
      }
      appendFileSync(out, lines.join('\n') + '\n');
      if (Date.now() > endAt) {
        st.cancel();
        console.log(`done: ${cps} checkpoints`);
        process.exit(0);
      }
    });
    st.on('error', (e: Error & { code?: number }) => {
      if (e.code === 1) return;
      appendFileSync(out, JSON.stringify({ k: 'err', at: Date.now(), code: e.code, msg: e.message }) + '\n');
      setTimeout(start, 2000);
    });
  };
  start();
  setInterval(() => console.log(`${new Date().toISOString()} checkpoints=${cps}`), 60_000);
} else if (mode === 'analyze') {
  analyze(a1 ?? 'data/live/day0/raw.jsonl', a2 ?? 'evidence/day0');
} else {
  console.error('usage: day0 collect <minutes> <out> | analyze <in> <outDir>');
  process.exit(2);
}

interface Tr { s: string; c: string; a: bigint; ts: number; seq: string; d: string }

function quantileBig(sorted: bigint[], q: number): bigint {
  if (!sorted.length) return 0n;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
}

function analyze(path: string, outDir: string) {
  const trs: Tr[] = [];
  const signs = new Map<string, number[]>();
  let meta: Record<string, unknown> = {};
  let firstTs = Infinity, lastTs = 0, cps = 0, errs = 0, firstSeq = '', lastSeq = '', missing = 0, prevSeq = -1n;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.k === 'meta') meta = j;
    else if (j.k === 'err') errs++;
    else if (j.k === 'cp') {
      cps++;
      if (j.ts) { firstTs = Math.min(firstTs, j.ts); lastTs = Math.max(lastTs, j.ts); }
      firstSeq ||= j.seq; lastSeq = j.seq;
      const sq = BigInt(j.seq);
      if (prevSeq >= 0n && sq > prevSeq + 1n) missing += Number(sq - prevSeq - 1n);
      if (sq > prevSeq) prevSeq = sq;
    } else if (j.k === 'tx') {
      let arr = signs.get(j.s);
      if (!arr) signs.set(j.s, (arr = []));
      arr.push(j.ts);
    } else if (j.k === 'tr') trs.push({ s: j.s, c: j.c, a: BigInt(j.a), ts: j.ts, seq: j.seq, d: j.d });
  }
  const minutes = (lastTs - firstTs) / 60_000;
  // Per-coin volume
  const byCoin = new Map<string, bigint[]>();
  for (const t of trs) {
    let arr = byCoin.get(t.c);
    if (!arr) byCoin.set(t.c, (arr = []));
    arr.push(t.a);
  }
  const coins = [...byCoin.entries()].sort((x, y) => y[1].length - x[1].length);
  const topCoins = coins.slice(0, 4).filter(([, v]) => v.length / minutes >= 1);
  // Target ≈2 sightings/min overall, split across top coins by sqrt(volume), floor 0.25/min each.
  const TARGET = 2;
  const w = topCoins.map(([, v]) => Math.sqrt(v.length));
  const wsum = w.reduce((p, q) => p + q, 0);
  const thresholds: Record<string, string> = {};
  for (const [i, [coin, vals]] of topCoins.entries()) {
    const rate = Math.max(0.25, (TARGET * w[i]!) / wsum);
    const keep = Math.min(1, (rate * minutes) / vals.length);
    const sorted = [...vals].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
    thresholds[coin] = quantileBig(sorted, 1 - keep).toString();
  }
  const isSighting = (t: Tr) => thresholds[t.c] !== undefined && t.a >= BigInt(thresholds[t.c]!) && t.a > 0n;
  const sightings = trs.filter(isSighting);
  // Index of sender activity (sorted timestamps)
  const idx = (rows: { s: string; ts: number }[]) => {
    const m = new Map<string, number[]>();
    for (const r of rows) {
      let arr = m.get(r.s);
      if (!arr) m.set(r.s, (arr = []));
      arr.push(r.ts);
    }
    for (const v of m.values()) v.sort((p, q) => p - q);
    return m;
  };
  const defs: Record<string, Map<string, number[]>> = {
    any_signed_tx: (() => { for (const v of signs.values()) v.sort((p, q) => p - q); return signs; })(),
    any_transfer: idx(trs),
    above_threshold_transfer: idx(sightings),
  };
  const HS = [2, 5, 10, 15, 30];
  const base: Record<string, Record<string, { n: number; yes: number; rate: number }>> = {};
  for (const [name, m] of Object.entries(defs)) {
    base[name] = {};
    for (const H of HS) {
      let n = 0, yes = 0;
      for (const s of sightings) {
        if (s.ts + H * 60_000 > lastTs) continue; // not resolvable inside the window
        n++;
        const arr = m.get(s.s) ?? [];
        if (arr.some((t) => t > s.ts && t <= s.ts + H * 60_000)) yes++;
      }
      base[name]![String(H)] = { n, yes, rate: n ? yes / n : NaN };
    }
  }
  // Pick (definition, H): rate in [0.15, 0.85], closest to 0.5, prefer shorter H on ties (more rounds).
  let pick: { def: string; H: number; rate: number; n: number } | null = null;
  for (const def of ['above_threshold_transfer', 'any_transfer', 'any_signed_tx']) {
    for (const H of HS) {
      const r = base[def]![String(H)]!;
      if (r.n < 10 || !(r.rate >= 0.15 && r.rate <= 0.85)) continue;
      if (!pick || Math.abs(r.rate - 0.5) < Math.abs(pick.rate - 0.5) - 0.02) pick = { def, H, rate: r.rate, n: r.n };
    }
  }
  const uniqSenders = new Set(sightings.map((s) => s.s)).size;
  const result = {
    measured_at: new Date().toISOString(),
    network_source: meta.source,
    host: meta.host,
    window: { checkpoints: cps, first_seq: firstSeq, last_seq: lastSeq, minutes: Number(minutes.toFixed(1)), stream_errors: errs, checkpoints_missing: missing, coverage: Number((cps / (cps + missing)).toFixed(4)) },
    transfers: trs.length,
    transfers_per_min: Number((trs.length / minutes).toFixed(1)),
    coins_top: coins.slice(0, 8).map(([c, v]) => ({ coin: c, transfers: v.length })),
    thresholds_raw: thresholds,
    sightings: sightings.length,
    sightings_per_min: Number((sightings.length / minutes).toFixed(2)),
    sightings_first_30min: sightings.filter((s) => s.ts <= firstTs + 30 * 60_000).length,
    unique_senders_in_sightings: uniqSenders,
    base_rate: base,
    pick,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/day0.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
