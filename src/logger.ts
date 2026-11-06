// RIMBA logger — the long-lived process. Streams Sui checkpoints (Tatum gRPC when a key exists,
// public fullnode tagged `public-dev` otherwise) into the core loop (src/loop.ts): sighting → recall
// → call → resolve → remember. Resumes from the last processed sequence after a restart. A credential
// watcher hot-switches the stream to Tatum and the memory to Walrus Memory the moment
// ~/.config/tatum/tatum.env or the Walrus Memory credentials appear.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMemwal, loadTatum } from './config.js';
import { CoreLoop } from './loop.js';
import { LocalNoteMemory, type NoteMemory } from './memory/backend.js';
import { createMemwal, WalrusNoteMemory } from './memory/memwal.js';
import { NoteWriter, type NoteRecord, type WriterState } from './notes.js';
import { chooseEndpoint, type NetworkSource } from './stream/client.js';
import { CheckpointSource } from './stream/source.js';
import { appendJsonl, files, loadConfig, readJson, readJsonl, writeJsonAtomic, ROOT, RoundStore } from './store.js';

const cfg = loadConfig();

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
}, prev?.writer ?? {}, { dailyBudget: cfg.notes?.daily_budget ?? 400 });
writer.reconcile(notes);

const loop = new CoreLoop({
  cfg, store, writer, notes,
  memory,
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
  network_source: chooseEndpoint().source,
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
const ep = chooseEndpoint();
log('logger start', {
  source: ep.source, host: ep.host, resume_from: state.last_checkpoint_seq, horizon_min: cfg.horizon_min, move_rule: cfg.move_rule,
  pending: loop.resolver.pendingCount, calls: store.size, memory: walrus ? 'walrus' : 'local-dev', notes: notes.length,
  ...(store.tornBytes.calls || store.tornBytes.resolutions ? { torn_tail_repaired_bytes: store.tornBytes } : {}),
});

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
  onRpc: rpcLog,
}, { resumeFromSeq: resumeFrom });
src.start();

// Notes flush (30 s): batches of ≤20 under the daily budget.
setInterval(() => {
  writer.flush().catch((e) => log('note flush failed', { error: String(e).slice(0, 300), next_write_at: writer.state.next_write_at, budget: writer.state.daily_budget }));
}, 30_000);

// Credential watcher (60 s): hot-switch to Tatum and to Walrus Memory.
setInterval(() => {
  if (loadTatum() && src.endpoint.source !== 'tatum') {
    log('credential watcher: Tatum key appeared — switching stream to Tatum gateway');
    src.switchEndpoint(chooseEndpoint());
  }
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
  } catch (e) {
    console.error(`heartbeat failed: ${String(e)}`);
  }
}, 30_000);

function heartbeat() {
  const lagS = state.last_checkpoint_ts ? Math.round((Date.now() - state.last_checkpoint_ts) / 1000) : null;
  loop.prune(Date.now());
  writeJsonAtomic(files.health(), {
    at: new Date().toISOString(), pid: process.pid, source: src.endpoint.source, last_seq: state.last_checkpoint_seq, lag_s: lagS,
    rounds_opened_this_run: loop.roundsOpened, rounds_resolved_this_run: loop.roundsResolved, pending: loop.resolver.pendingCount,
    base_rate_p: Number(loop.base.p().toFixed(4)), base_rate_n: loop.base.count, gaps: state.gaps, resolutions_unpersisted: loop.unpersistedCount,
    memory: walrus ? 'walrus' : 'local-dev', notes_total: notes.length, notes_queued: writer.queued,
    notes_written_today: writer.state.written_today, notes_budget_today: writer.state.daily_budget, rate_limited_today: writer.state.rate_limited_today,
  });
  saveState();
}

function shutdown(sig: string) {
  log('logger stop', { signal: sig, last_seq: state.last_checkpoint_seq, notes_queued: writer.queued });
  saveState();
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
