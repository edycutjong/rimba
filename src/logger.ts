// RIMBA logger — the long-lived process. Streams Sui checkpoints (Tatum gRPC when a key exists,
// public fullnode tagged `public-dev` otherwise), turns large transfers into sightings, opens a
// round per sighting with its predictions frozen at call time, and resolves each round from later
// checkpoints. Resumes from the last processed sequence after a restart; a credential watcher
// hot-switches to Tatum the moment ~/.config/tatum/tatum.env appears.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMemwal, loadTatum } from './config.js';
import { BaseRate, FrequencyTable } from './predict.js';
import { Resolver, type Activity, type Resolution } from './resolver.js';
import { chooseEndpoint, type NetworkSource, type RawCheckpoint } from './stream/client.js';
import { decodeCheckpoint, normAddr, normCoin, tsToMs, type Transfer } from './stream/decode.js';
import { CheckpointSource } from './stream/source.js';
import {
  appendJsonl, files, loadConfig, readJson, readJsonl, writeJsonAtomic, ROOT,
  type CallRow, type ResolutionRow,
} from './store.js';

const cfg = loadConfig();
const H_MS = cfg.horizon_min * 60_000;
const thresholds = new Map(Object.entries(cfg.thresholds_raw).map(([c, v]) => [normCoin(c), BigInt(v)]));

interface State {
  last_checkpoint_seq: string | null;
  last_checkpoint_ts: number;
  network_source: NetworkSource;
  started_at: string;
  checkpoints_processed: number;
  gaps: number;
}

function log(msg: string, extra: Record<string, unknown> = {}) {
  const row = { at: new Date().toISOString(), msg, ...extra };
  console.log(`${row.at} ${msg}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
  appendJsonl(files.events(), row);
}

// ---------- rebuild in-memory state from disk ----------
const prev = readJson<State>(files.state());
const calls = readJsonl<CallRow>(files.calls());
const resolutions = readJsonl<ResolutionRow>(files.resolutions());
const resolved = new Map(resolutions.map((r) => [r.round_id, r]));
const callById = new Map(calls.map((c) => [c.round_id, c]));
const base = new BaseRate(cfg.base_rate_prior);
const freq = new FrequencyTable();
const seenSenders = new Set<string>();
const resolver = new Resolver();
for (const c of calls) {
  seenSenders.add(c.sender);
  const r = resolved.get(c.round_id);
  if (r) {
    if (r.outcome !== null) {
      base.observe(r.outcome);
      freq.observe(c.sender, r.outcome);
    }
  } else {
    resolver.add({ roundId: c.round_id, sender: c.sender, txDigest: c.tx_digest, checkpointSeq: BigInt(c.checkpoint_seq), timestampMs: c.checkpoint_ts, deadlineMs: c.checkpoint_ts + c.horizon_min * 60_000 });
  }
}

const state: State = {
  last_checkpoint_seq: prev?.last_checkpoint_seq ?? null,
  last_checkpoint_ts: prev?.last_checkpoint_ts ?? 0,
  network_source: chooseEndpoint().source,
  started_at: new Date().toISOString(),
  checkpoints_processed: prev?.checkpoints_processed ?? 0,
  gaps: prev?.gaps ?? 0,
};
let roundsOpened = 0;
let roundsResolved = 0;

function applyResolutions(rs: Resolution[], source: NetworkSource) {
  for (const r of rs) {
    const call = callById.get(r.roundId);
    if (!call) continue;
    const row: ResolutionRow = {
      round_id: r.roundId,
      resolved_at: new Date().toISOString(),
      outcome: r.outcome,
      reason: r.reason,
      resolving_checkpoint_seq: r.resolvingCheckpointSeq,
      resolving_digest: r.resolvingDigest,
      resolving_ts: r.resolvedAtMs,
      network_source: source,
    };
    appendJsonl(files.resolutions(), row);
    roundsResolved++;
    if (r.outcome !== null) {
      base.observe(r.outcome);
      freq.observe(call.sender, r.outcome);
    }
  }
}

/** The largest above-threshold transfer in a tx becomes that tx's sighting (one round per tx). */
function sightingsOf(transfers: Transfer[]): Transfer[] {
  const best = new Map<string, { t: Transfer; ratio: number }>();
  for (const t of transfers) {
    const th = thresholds.get(t.coinType);
    if (th === undefined || t.amountRaw < th || th <= 0n) continue;
    const ratio = Number((t.amountRaw * 1000n) / th);
    const cur = best.get(t.txDigest);
    if (!cur || ratio > cur.ratio) best.set(t.txDigest, { t, ratio });
  }
  return [...best.values()].map((b) => b.t);
}

function activitiesOf(cp: RawCheckpoint, transfers: Transfer[], sightings: Transfer[]): Activity[] {
  if (cfg.move_rule === 'any_transfer') return transfers;
  if (cfg.move_rule === 'above_threshold_transfer') return sightings;
  const ts = tsToMs(cp.summary?.timestamp);
  const out: Activity[] = [];
  for (const tx of cp.transactions ?? []) {
    if (tx.effects?.status?.success === false || !tx.transaction?.sender || !tx.digest) continue;
    out.push({ sender: normAddr(tx.transaction.sender), txDigest: tx.digest, timestampMs: tsToMs(tx.timestamp) || ts });
  }
  return out;
}

function onCheckpoint(cp: RawCheckpoint, source: NetworkSource) {
  const seq = BigInt(cp.sequence_number!);
  const cpTs = tsToMs(cp.summary?.timestamp);
  const transfers = decodeCheckpoint(cp);
  const sightings = sightingsOf(transfers);
  // 1) resolve existing rounds first, so a sighting never resolves itself
  applyResolutions(resolver.onCheckpoint(seq, cp.digest ?? '', cpTs, activitiesOf(cp, transfers, sightings)), source);
  // 2) open a round per sighting, predictions frozen now
  for (const t of sightings) {
    const pBase = base.p();
    const pFreq = freq.p(t.sender, pBase);
    const row: CallRow = {
      round_id: t.txDigest,
      created_at: new Date().toISOString(),
      network_source: source,
      checkpoint_seq: t.checkpointSeq,
      checkpoint_ts: t.timestampMs,
      tx_digest: t.txDigest,
      sender: t.sender,
      recipient: t.recipients[0] ?? '',
      coin_type: t.coinType,
      amount_raw: t.amountRaw.toString(),
      horizon_min: cfg.horizon_min,
      move_rule: cfg.move_rule,
      sender_seen_before: seenSenders.has(t.sender),
      // Memory naturalist is wired in the core loop; until then it abstains (= base rate).
      p_memory: pBase,
      call: 'abstain',
      p_base: pBase,
      p_freq: pFreq,
      cited_note_ids: [],
      cited_distances: [],
    };
    if (callById.has(row.round_id)) continue; // replayed checkpoint after restart
    appendJsonl(files.sightings(), { seq: t.checkpointSeq, ts: t.timestampMs, digest: t.txDigest, sender: t.sender, recipients: t.recipients, coin: t.coinType, amount: row.amount_raw, source });
    appendJsonl(files.calls(), row);
    callById.set(row.round_id, row);
    seenSenders.add(t.sender);
    resolver.add({ roundId: row.round_id, sender: t.sender, txDigest: t.txDigest, checkpointSeq: seq, timestampMs: t.timestampMs, deadlineMs: t.timestampMs + H_MS });
    roundsOpened++;
  }
  state.last_checkpoint_seq = seq.toString();
  state.last_checkpoint_ts = cpTs;
  state.network_source = source;
  state.checkpoints_processed++;
  if (state.checkpoints_processed % 20 === 0) writeJsonAtomic(files.state(), state);
}

// ---------- start ----------
const PIDFILE = process.env.RIMBA_PIDFILE ?? join(ROOT, '..', 'logs', 'logger.pid');
writeFileSync(PIDFILE, String(process.pid));
const resumeFrom = state.last_checkpoint_seq ? BigInt(state.last_checkpoint_seq) : undefined;
const ep = chooseEndpoint();
log('logger start', { source: ep.source, host: ep.host, resume_from: state.last_checkpoint_seq, horizon_min: cfg.horizon_min, move_rule: cfg.move_rule, pending: resolver.pendingCount, calls: calls.length, memwal: loadMemwal() ? 'configured' : 'absent' });

const src = new CheckpointSource(ep, {
  onCheckpoint,
  onStatus: (m) => log(m),
  onGap: (from, to, reason) => {
    state.gaps++;
    log('gap', { from: from.toString(), to: to.toString(), reason });
    applyResolutions(resolver.onGap(to, Date.now()), src.endpoint.source);
  },
  onRpc: (method, ms, ok, source) => appendJsonl(files.rpc(), { at: Date.now(), method, ms, ok, source }),
}, { resumeFromSeq: resumeFrom });
src.start();

// Credential watcher (60 s): hot-switch to Tatum, note MemWal availability.
let memwalSeen = !!loadMemwal();
setInterval(() => {
  const t = loadTatum();
  if (t && src.endpoint.source !== 'tatum') {
    log('credential watcher: Tatum key appeared — switching stream to Tatum gateway');
    src.switchEndpoint(chooseEndpoint());
  }
  const m = !!loadMemwal();
  if (m && !memwalSeen) log('credential watcher: Walrus Memory credentials appeared');
  memwalSeen = m;
}, 60_000).unref();

// Health heartbeat (30 s)
setInterval(() => {
  const lagS = state.last_checkpoint_ts ? Math.round((Date.now() - state.last_checkpoint_ts) / 1000) : null;
  writeJsonAtomic(files.health(), {
    at: new Date().toISOString(), pid: process.pid, source: src.endpoint.source, last_seq: state.last_checkpoint_seq, lag_s: lagS,
    rounds_opened_this_run: roundsOpened, rounds_resolved_this_run: roundsResolved, pending: resolver.pendingCount,
    base_rate_p: Number(base.p().toFixed(4)), base_rate_n: base.count, gaps: state.gaps, memwal: memwalSeen,
  });
  writeJsonAtomic(files.state(), state);
}, 30_000);

function shutdown(sig: string) {
  log('logger stop', { signal: sig, last_seq: state.last_checkpoint_seq });
  writeJsonAtomic(files.state(), state);
  src.stop();
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) unlinkSync(PIDFILE);
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
