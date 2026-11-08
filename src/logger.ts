// RIMBA logger — the long-lived process. Streams Sui checkpoints (Tatum gRPC when a key exists,
// public fullnode tagged `public-dev` otherwise) into the core loop (src/loop.ts): sighting → recall
// → call → resolve → remember. Resumes from the last processed sequence after a restart. A credential
// watcher hot-switches the stream to Tatum and the memory to Walrus Memory the moment
// ~/.config/tatum/tatum.env or the Walrus Memory credentials appear.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMemwal, loadTatum } from './config.js';
import { CoreLoop, type PaceState } from './loop.js';
import { LocalNoteMemory, type NoteMemory } from './memory/backend.js';
import { createMemwal, WalrusNoteMemory } from './memory/memwal.js';
import { NoteWriter, type NoteRecord, type WriterState } from './notes.js';
import { chooseEndpoint, PUBLIC_ENDPOINT, type NetworkSource } from './stream/client.js';
import { DEFAULT_BUDGET, TatumGovernor, type GovernorState } from './stream/governor.js';
import { CheckpointSource } from './stream/source.js';
import { appendJsonl, files, loadConfig, readJson, readJsonl, writeJsonAtomic, ROOT, RoundStore } from './store.js';

const cfg = loadConfig();

// ---------- Tatum credit governor (402 fallback + budget) ----------
const budget = { ...DEFAULT_BUDGET, ...(cfg.tatum_budget ?? {}) };
const gov = new TatumGovernor(budget, readJson<GovernorState>(files.governor()));
const saveGov = () => {
  try {
    writeJsonAtomic(files.governor(), gov.state);
  } catch (e) {
    console.error(`governor save failed: ${String(e)}`);
  }
};

interface State {
  last_checkpoint_seq: string | null;
  last_checkpoint_ts: number;
  network_source: NetworkSource;
  started_at: string;
  checkpoints_processed: number;
  gaps: number;
  writer?: Partial<WriterState>;
}

function log(msg: string, extra: Record<string, unknown> = {}) {
  const row = { at: new Date().toISOString(), msg, ...extra };
  console.log(`${row.at} ${msg}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
  appendJsonl(files.events(), row);
}
const rpcLog = (method: string, ms: number, ok: boolean, source: string) => appendJsonl(files.rpc(), { at: Date.now(), method, ms, ok, source });

// ---------- memory backend ----------
const notes = readJsonl<NoteRecord>(files.notes());
const local = new LocalNoteMemory(notes.filter((n) => n.ok && n.backend === 'local-dev'));
let walrus: WalrusNoteMemory | null = null;
function tryWalrus(): WalrusNoteMemory | null {
  const mw = createMemwal(loadMemwal());
  return mw ? new WalrusNoteMemory(mw, (m, ms, ok) => rpcLog(m, ms, ok, 'walrus'), cfg.naturalist?.recall_timeout_ms ?? 6000) : null;
}
walrus = tryWalrus();
async function checkRelayer(why: string) {
  try {
    const c = await createMemwal(loadMemwal())?.compatibility();
    log('walrus relayer compatibility', { why, ok: true, version: (c as { version?: string } | undefined)?.version ?? null });
  } catch (e) {
    log('walrus relayer compatibility', { why, ok: false, error: String(e).slice(0, 300) });
  }
}
if (walrus) void checkRelayer('startup');
// Circuit breaker: 3 recall failures in a row → abstain without calling for 60 s.
let recallFailures = 0;
let breakerUntil = 0;
function memory(): NoteMemory | null {
  const m: NoteMemory = walrus ?? local;
  if (Date.now() < breakerUntil) return null;
  return m;
}

// ---------- state + core loop ----------
const prev = readJson<State>(files.state());
const store = new RoundStore();
const writer = new NoteWriter(() => walrus ?? local, (rec) => {
  appendJsonl(files.notes(), rec);
  notes.push(rec);
  loop.countNote(rec);
  log(rec.ok ? 'note stored' : 'note failed', { specimen: rec.specimen_id, backend: rec.backend, kind: rec.kind, blob_id: rec.blob_id, error: rec.error });
}, prev?.writer ?? {}, { dailyBudget: cfg.notes?.daily_budget ?? 400, onAccepted: () => saveState() });
writer.reconcile(notes);

const loop = new CoreLoop({
  cfg, store, writer, notes,
  memory,
  mayOpenCall: (source, now) => gov.mayOpenCall(source, now, cfg.horizon_min),
  onError: (msg) => log('loop error', { error: msg.slice(0, 500) }),
  emit: (ev, data) => {
    if (ev === 'sighting') {
      const s = data as Record<string, unknown>;
      appendJsonl(files.sightings(), { seq: s.seq, ts: Date.now(), digest: s.digest, sender: s.sender, coin: s.coin, amount: s.amount, species: s.species, source: s.source });
    }
    if (ev === 'call') {
      const c = data as { abstain_reason?: string; memory_source?: string };
      if (c.abstain_reason === 'recall-error') {
        if (++recallFailures >= 3) {
          breakerUntil = Date.now() + 60_000;
          recallFailures = 0;
          log('recall breaker open for 60 s after 3 failures');
        }
      } else if (c.memory_source !== 'none') recallFailures = 0;
    }
  },
});

const state: State = {
  last_checkpoint_seq: prev?.last_checkpoint_seq ?? null,
  last_checkpoint_ts: prev?.last_checkpoint_ts ?? 0,
  network_source: 'public-dev',
  started_at: new Date().toISOString(),
  checkpoints_processed: prev?.checkpoints_processed ?? 0,
  gaps: prev?.gaps ?? 0,
};
const saveState = () => {
  try {
    // never save a resume cursor past a checkpoint whose resolution is not yet on disk
    const hold = loop.holdCursorAt();
    const cursor = hold !== null && state.last_checkpoint_seq !== null && BigInt(state.last_checkpoint_seq) > hold ? hold.toString() : state.last_checkpoint_seq;
    writeJsonAtomic(files.state(), { ...state, last_checkpoint_seq: cursor, writer: writer.snapshot() });
  } catch (e) {
    console.error(`state save failed: ${String(e)}`);
  }
};

// ---------- start ----------
const PIDFILE = process.env.RIMBA_PIDFILE ?? join(ROOT, '..', 'logs', 'logger.pid');
writeFileSync(PIDFILE, String(process.pid));
const resumeFrom = state.last_checkpoint_seq ? BigInt(state.last_checkpoint_seq) : undefined;
/** The endpoint the governor wants now: Tatum only with a key, inside budget, and not in a 402 back-off. */
function desiredEndpoint(now = Date.now()) {
  const ep = chooseEndpoint();
  const d = gov.decide(now, ep.source === 'tatum');
  return { ep: d.source === 'tatum' ? ep : PUBLIC_ENDPOINT, d };
}
const { ep, d: d0 } = desiredEndpoint();
state.network_source = ep.source;
log('logger start', {
  governor: { reason: d0.reason, used: Math.round(gov.used()), used_frac: Number(gov.usedFrac().toFixed(4)), hard_stop: gov.state.hard_stop, fallback_since: gov.state.fallback_since },
  source: ep.source, host: ep.host, resume_from: state.last_checkpoint_seq, horizon_min: cfg.horizon_min, move_rule: cfg.move_rule,
  pending: loop.resolver.pendingCount, calls: store.size, memory: walrus ? 'walrus' : 'local-dev', notes: notes.length,
  ...(store.tornBytes.calls || store.tornBytes.resolutions ? { torn_tail_repaired_bytes: store.tornBytes } : {}),
});

// pace + counterparties survive a restart (otherwise every sender reads "no earlier move seen" for up to 2 h)
loop.restorePace(readJson<PaceState>(files.pace()), Date.now());
const savePace = () => {
  try {
    writeJsonAtomic(files.pace(), loop.paceSnapshot());
  } catch (e) {
    console.error(`pace save failed: ${String(e)}`);
  }
};
let beats = 0;

const src = new CheckpointSource(ep, {
  onCheckpoint: async (cp, source) => {
    try {
      await loop.onCheckpoint(cp, source);
    } catch (e) {
      // A checkpoint we could not fully process is a gap: void every round whose window it may touch.
      state.gaps++;
      log('handler error — treating checkpoint as a gap', { seq: cp.sequence_number, error: String(e).slice(0, 500) });
      loop.applyResolutions(loop.resolver.onGap(BigInt(cp.sequence_number!), Date.now()), source);
    }
    state.last_checkpoint_seq = cp.sequence_number!;
    state.last_checkpoint_ts = Number(cp.summary?.timestamp?.seconds ?? 0) * 1000;
    state.network_source = source;
    state.checkpoints_processed++;
    if (state.checkpoints_processed % 20 === 0) saveState();
  },
  onStatus: (m) => log(m),
  onGap: (from, to, reason) => {
    state.gaps++;
    log('gap', { from: from.toString(), to: to.toString(), reason });
    loop.applyResolutions(loop.resolver.onGap(to, Date.now()), src.endpoint.source);
  },
  onRpc: (method, ms, ok, source) => {
    rpcLog(method, ms, ok, source);
    if (source === 'tatum' && method !== 'SubscribeCheckpoints') gov.countTatumCalls(1, Date.now());
  },
  onMessage: (source) => {
    if (source !== 'tatum') return;
    const now = Date.now();
    gov.countTatumCalls(1, now);
    const lasted = gov.onTatumOk(now);
    if (lasted !== null) {
      log('tatum recovered after 402 fallback — stream back on the Tatum gateway', { outage_min: Math.round(lasted / 60_000), payment_required_total: gov.state.fallback_count });
      saveGov();
    }
  },
  onPaymentRequired: (_source, where) => {
    gov.onPaymentRequired(Date.now());
    log('tatum HTTP 402 (out of credits) — falling back to the public fullnode; rows are public-dev until Tatum answers again', {
      where, retry_at: new Date(gov.state.fallback_until!).toISOString(), payment_required_total: gov.state.fallback_count, used: Math.round(gov.used()),
    });
    saveGov();
    src.switchEndpoint(PUBLIC_ENDPOINT);
    return true;
  },
}, { resumeFromSeq: resumeFrom });
src.start();

// Notes flush (30 s): batches of ≤20 under the daily budget.
setInterval(() => {
  writer.flush().catch((e) => log('note flush failed', { error: String(e).slice(0, 300), next_write_at: writer.state.next_write_at, budget: writer.state.daily_budget }));
}, 30_000);

// Governor tick (30 s): Tatum key present? in budget? on-window? 402 back-off over? → switch endpoint if needed.
let lastReason = d0.reason;
setInterval(() => {
  const { ep: want, d } = desiredEndpoint();
  if (d.reason !== lastReason) {
    log('tatum governor', { from: lastReason, to: d.reason, source: want.source, used: Math.round(gov.used()), used_frac: Number(gov.usedFrac().toFixed(4)), duty: d.duty, window_end: d.window_end ? new Date(d.window_end).toISOString() : null });
    lastReason = d.reason;
  }
  if (want.source !== src.endpoint.source) {
    log(want.source === 'tatum' ? 'switching stream to the Tatum gateway' : 'switching stream to the public fullnode', { reason: d.reason });
    src.switchEndpoint(want);
  }
  saveGov();
}, 30_000).unref();

// Usage poll (usage_poll_min): the authoritative credit count from GET /v4/tatum/usage (1 credit per poll).
async function pollUsage() {
  const t = loadTatum();
  if (!t) return;
  try {
    const res = await fetch('https://api.tatum.io/v4/tatum/usage', { headers: { 'x-api-key': t.apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return log('tatum usage poll failed', { status: res.status });
    const days = (await res.json()) as { usage?: { units?: number }[] }[];
    const total = days.reduce((s, d) => s + (d.usage ?? []).reduce((a, u) => a + (Number(u.units) || 0), 0), 0);
    const wasStopped = !!gov.state.hard_stop;
    gov.recordUsage(total, Date.now());
    appendJsonl(files.events(), { at: new Date().toISOString(), msg: 'tatum usage', raw_total: total, used: Math.round(gov.used()), used_frac: Number(gov.usedFrac().toFixed(4)) });
    if (!wasStopped && gov.state.hard_stop) log('tatum HARD STOP — usage at the hard-stop fraction; stream stays public until a human clears hard_stop in governor.json', { used: Math.round(gov.used()), frac: budget.hard_stop_frac });
    saveGov();
  } catch (e) {
    log('tatum usage poll failed', { error: String(e).slice(0, 200) });
  }
}
void pollUsage();
setInterval(() => void pollUsage(), budget.usage_poll_min * 60_000).unref();

// Credential watcher (60 s): Walrus Memory hot-switch (the Tatum switch is the governor tick above).
setInterval(() => {
  if (!walrus) {
    walrus = tryWalrus();
    if (walrus) {
      log('credential watcher: Walrus Memory credentials appeared — naturalist now recalls from and writes to Walrus Memory');
      loop.resetNoteCounts(notes);
      // Walrus Memory starts fresh: notes queued under the local-dev stand-in are not carried over.
      const dropped = writer.clearQueue();
      if (dropped) log('dropped local-dev era queued notes at the memory switch', { dropped });
      void checkRelayer('credentials appeared');
    }
  }
}, 60_000).unref();

// Health heartbeat (30 s)
setInterval(() => {
  try {
    heartbeat();
    if (++beats % 10 === 0) savePace(); // every 5 min
  } catch (e) {
    console.error(`heartbeat failed: ${String(e)}`);
  }
}, 30_000);

function heartbeat() {
  const lagS = state.last_checkpoint_ts ? Math.round((Date.now() - state.last_checkpoint_ts) / 1000) : null;
  loop.prune(Date.now());
  writeJsonAtomic(files.health(), {
    at: new Date().toISOString(), pid: process.pid, source: src.endpoint.source, last_seq: state.last_checkpoint_seq, lag_s: lagS,
    tatum: (() => {
      const d = gov.decide(Date.now(), !!loadTatum());
      return { reason: d.reason, duty: d.duty, window_end: d.window_end ? new Date(d.window_end).toISOString() : null, used: Math.round(gov.used()), used_frac: Number(gov.usedFrac().toFixed(4)), plan: budget.plan_credits, fallback_since: gov.state.fallback_since ? new Date(gov.state.fallback_since).toISOString() : null, payment_required_total: gov.state.fallback_count, hard_stop: gov.state.hard_stop, rounds_skipped_window_closing: loop.roundsSkippedWindow };
    })(),
    rounds_opened_this_run: loop.roundsOpened, rounds_resolved_this_run: loop.roundsResolved, pending: loop.resolver.pendingCount,
    base_rate_p: Number(loop.base.p().toFixed(4)), base_rate_n: loop.base.count, gaps: state.gaps, resolutions_unpersisted: loop.unpersistedCount,
    memory: walrus ? 'walrus' : 'local-dev', notes_total: notes.length, notes_queued: writer.queued, notes_awaiting_confirmation: writer.awaitingCount,
    notes_dropped_backend_switch: writer.droppedOtherBackend,
    notes_written_today: writer.state.written_today, notes_budget_today: writer.state.daily_budget, rate_limited_today: writer.state.rate_limited_today,
  });
  saveState();
}

function shutdown(sig: string) {
  log('logger stop', { signal: sig, last_seq: state.last_checkpoint_seq, notes_queued: writer.queued });
  saveState();
  savePace();
  saveGov();
  src.stop();
  try {
    if (existsSync(PIDFILE) && readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) unlinkSync(PIDFILE);
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
// A long-lived process: log and keep going rather than die on one bad promise.
process.on('unhandledRejection', (e) => {
  try { log('unhandledRejection', { error: String(e).slice(0, 500) }); } catch { /* ignore */ }
});
process.on('uncaughtException', (e) => {
  try { log('uncaughtException', { error: String(e).slice(0, 500) }); } catch { /* ignore */ }
});
process.on('SIGINT', () => shutdown('SIGINT'));
