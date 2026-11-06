// The one core flow, as a testable unit: sighting → recall → call → resolve → remember.
// The logger process wires this to the live checkpoint stream; tests drive it with fixtures.
import { BaseRate, FrequencyTable } from './baselines.js';
import { naturalistCall } from './naturalist.js';
import { drifted, outcomeNote, parseNote, supersedeNote, type NoteRecord, type NoteWriter } from './notes.js';
import { Resolver, type Activity, type Resolution } from './resolver.js';
import { speciesSentence } from './taxon.js';
import { normAddr, normCoin, tsToMs, decodeCheckpoint, type Transfer } from './stream/decode.js';
import type { NetworkSource, RawCheckpoint } from './stream/client.js';
import type { NoteMemory } from './memory/backend.js';
import type { CallRow, ResolutionRow, RimbaConfig, RoundStore } from './store.js';

export interface LoopDeps {
  cfg: RimbaConfig;
  store: RoundStore;
  writer: NoteWriter;
  /** Current memory backend (null = none); may change at runtime when credentials appear. */
  memory: () => NoteMemory | null;
  notes: NoteRecord[];
  now?: () => number;
  emit?: (event: 'sighting' | 'call' | 'resolution' | 'note', data: unknown) => void;
  onError?: (msg: string) => void;
}

const HISTORY_TTL_MS = 2 * 3600_000;
const r6 = (x: number) => Number(x.toFixed(6));

/** The largest above-threshold transfer in a tx becomes that tx's sighting (one round per tx). */
export function sightingsOf(transfers: Transfer[], thresholds: Map<string, bigint>): Transfer[] {
  const best = new Map<string, { t: Transfer; ratio: number }>();
  for (const t of transfers) {
    const th = thresholds.get(t.coinType);
    if (th === undefined || th <= 0n || t.amountRaw < th) continue;
    const ratio = Number((t.amountRaw * 1000n) / th);
    const cur = best.get(t.txDigest);
    if (!cur || ratio > cur.ratio) best.set(t.txDigest, { t, ratio });
  }
  return [...best.values()].map((b) => b.t);
}

/** What counts as "the sender moved again", per the configured move rule. */
export function activitiesOf(rule: RimbaConfig['move_rule'], cp: RawCheckpoint, transfers: Transfer[], sightings: Transfer[]): Activity[] {
  if (rule === 'any_transfer') return transfers;
  if (rule === 'above_threshold_transfer') return sightings;
  const ts = tsToMs(cp.summary?.timestamp);
  const out: Activity[] = [];
  for (const tx of cp.transactions ?? []) {
    if (tx.effects?.status?.success === false || !tx.transaction?.sender || !tx.digest) continue;
    out.push({ sender: normAddr(tx.transaction.sender), txDigest: tx.digest, timestampMs: tsToMs(tx.timestamp) || ts });
  }
  return out;
}

export const thresholdMap = (cfg: Pick<RimbaConfig, 'thresholds_raw'>) => new Map(Object.entries(cfg.thresholds_raw).map(([c, v]) => [normCoin(c), BigInt(v)]));

export class CoreLoop {
  readonly base: BaseRate;
  readonly freq = new FrequencyTable();
  readonly resolver = new Resolver();
  private thresholds: Map<string, bigint>;
  private H_MS: number;
  private seenSenders = new Map<string, number>(); // sender → prior sightings
  private pairs = new Set<string>(); // sender>recipient seen in sightings
  private lastMove = new Map<string, number>(); // sender → last transfer ts on stream
  private speciesOutcomes = new Map<string, (0 | 1)[]>();
  private speciesNotes = new Map<string, { n: number; yes: number }>();
  private lastSupersede = new Map<string, number>();
  /** Specimen ids of each species' most recent outcome notes, and of its latest tally (supersede) note. */
  private speciesNoteIds = new Map<string, string[]>();
  private lastTallyId = new Map<string, string>();
  private now: () => number;
  roundsOpened = 0;
  roundsResolved = 0;
  /** Resolutions computed but not yet on disk (write failed): retried on every checkpoint, never recomputed. */
  private unpersisted = new Map<string, { r: Resolution; source: NetworkSource }>();

  constructor(private d: LoopDeps) {
    const cfg = d.cfg;
    this.now = d.now ?? Date.now;
    this.base = new BaseRate(cfg.base_rate_prior);
    this.H_MS = cfg.horizon_min * 60_000;
    this.thresholds = thresholdMap(cfg);
    // rebuild from disk: opponents, familiarity, pending rounds, species history
    const calls = d.store.allCalls().sort((a, b) => Number(BigInt(a.checkpoint_seq) - BigInt(b.checkpoint_seq)));
    for (const c of calls) {
      this.seenSenders.set(c.sender, (this.seenSenders.get(c.sender) ?? 0) + 1);
      if (c.recipient) this.pairs.add(`${c.sender}>${c.recipient}`);
      const r = d.store.resolution(c.round_id);
      if (r) {
        if (r.outcome !== null) this.observe(c, r.outcome);
      } else if (c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule) {
        this.resolver.add({ roundId: c.round_id, sender: c.sender, txDigest: c.tx_digest, checkpointSeq: BigInt(c.checkpoint_seq), timestampMs: c.checkpoint_ts, deadlineMs: c.checkpoint_ts + c.horizon_min * 60_000 });
      }
    }
    for (const n of d.notes) this.countNote(n);
    const num = (id: string) => Number(id.replace(/^No\./, '')) || 0;
    for (const n of [...d.notes].filter((x) => x.ok).sort((a, b) => num(a.specimen_id) - num(b.specimen_id))) {
      if (n.kind === 'outcome') this.trackNoteId(n.species, n.specimen_id);
      else this.lastTallyId.set(n.species, n.specimen_id);
    }
  }

  private trackNoteId(species: string, id: string) {
    const arr = this.speciesNoteIds.get(species) ?? [];
    arr.push(id);
    if (arr.length > 20) arr.shift();
    this.speciesNoteIds.set(species, arr);
  }

  private get nat() {
    return this.d.cfg.naturalist ?? { max_distance: { walrus: 0.35, 'local-dev': 0.22 }, limit: 20, shrink: 1, recall_timeout_ms: 6000 };
  }
  private get notesCfg() {
    return this.d.cfg.notes ?? { daily_budget: 400, supersede_window: 5, supersede_cooldown_min: 120 };
  }

  /** Track how well each species is covered by notes in the CURRENT backend (drives note priority). */
  countNote(n: NoteRecord): void {
    const mem = this.d.memory();
    if (!n.ok || (mem && n.backend !== mem.kind)) return;
    const p = parseNote(n.text);
    if (!p) return;
    const s = this.speciesNotes.get(n.species) ?? { n: 0, yes: 0 };
    s.n++;
    if (p.yes / p.n >= 0.5) s.yes++;
    this.speciesNotes.set(n.species, s);
  }

  /** Called when the memory backend changes (credentials appeared): recount coverage for the new one. */
  resetNoteCounts(notes: NoteRecord[]): void {
    this.speciesNotes.clear();
    for (const n of notes) this.countNote(n);
  }

  private observe(c: CallRow, outcome: 0 | 1) {
    // only rounds under the current question feed the opponents and the species history
    if (c.horizon_min !== this.d.cfg.horizon_min || c.move_rule !== this.d.cfg.move_rule) return;
    this.base.observe(outcome);
    this.freq.observe(c.sender, outcome);
    if (c.species) {
      const arr = this.speciesOutcomes.get(c.species) ?? [];
      arr.push(outcome);
      if (arr.length > 20) arr.shift();
      this.speciesOutcomes.set(c.species, arr);
    }
  }

  /** Observers (logs, SSE) must never break the loop: a throwing listener is reported, not propagated. */
  private safeEmit(event: 'sighting' | 'call' | 'resolution' | 'note', data: unknown): void {
    try {
      this.d.emit?.(event, data);
    } catch (e) {
      this.d.onError?.(`emit ${event} failed: ${String(e)}`);
    }
  }

  sightingsOf(transfers: Transfer[]): Transfer[] {
    return sightingsOf(transfers, this.thresholds);
  }

  /**
   * While a computed resolution is not on disk, a saved resume cursor must not pass the checkpoint
   * that resolved it: after a crash the round is pending again and that checkpoint must be replayed.
   */
  holdCursorAt(): bigint | null {
    let min: bigint | null = null;
    for (const { r } of this.unpersisted.values()) {
      const s = BigInt(r.resolvingCheckpointSeq) - 1n;
      if (min === null || s < min) min = s;
    }
    return min;
  }

  get unpersistedCount(): number {
    return this.unpersisted.size;
  }

  applyResolutions(rs: Resolution[], source: NetworkSource): void {
    for (const r of rs) {
      const call = this.d.store.call(r.roundId);
      if (!call || this.d.store.resolution(r.roundId)) continue;
      const row: ResolutionRow = {
        round_id: r.roundId,
        resolved_at: new Date(this.now()).toISOString(),
        outcome: r.outcome,
        reason: r.reason,
        resolving_checkpoint_seq: r.resolvingCheckpointSeq,
        resolving_digest: r.resolvingDigest,
        resolving_ts: r.resolvedAtMs,
        network_source: source,
      };
      try {
        this.d.store.resolveRound(row);
      } catch (e) {
        // never abort the batch, never lose the outcome: keep it and retry the same row on the next checkpoint
        if (!this.unpersisted.has(r.roundId)) this.d.onError?.(`resolution write failed for ${r.roundId} (will retry): ${String(e)}`);
        this.unpersisted.set(r.roundId, { r, source });
        continue;
      }
      this.unpersisted.delete(r.roundId);
      this.roundsResolved++;
      this.safeEmit('resolution', row);
      if (r.outcome === null) continue;
      this.observe(call, r.outcome);
      if (call.species) this.remember(call, r.outcome, r.resolvingCheckpointSeq);
    }
  }

  private remember(call: CallRow, outcome: 0 | 1, checkpoint: string) {
    const species = call.species!;
    const known = this.speciesNotes.get(species);
    // novel species first; a well-covered species whose outcome matches its notes is lowest priority
    let priority = !known || known.n < 3 ? 2 : 1;
    if (known && known.n >= 8 && (known.yes / known.n >= 0.5 ? 1 : 0) === outcome) priority = 0;
    this.trackNoteId(species, this.d.writer.enqueue((sp) => outcomeNote(sp, species, call.horizon_min, outcome, checkpoint), species, call.round_id, 'outcome', priority));

    const nc = this.notesCfg;
    if (call.call === 'abstain' || call.cited_vote_p == null || !call.cited_note_ids.length) return;
    // a supersede corrects the CURRENT memory: never let a call made on another backend retire notes here
    if (call.memory_source !== (this.d.memory()?.kind ?? 'none')) return;
    const drift = drifted(this.speciesOutcomes.get(species) ?? [], call.cited_vote_p, nc.supersede_window);
    const last = this.lastSupersede.get(species) ?? 0;
    if (drift && this.now() - last >= nc.supersede_cooldown_min * 60_000) {
      this.lastSupersede.set(species, this.now());
      // the tally replaces the notes it summarises (its window's outcome notes and the previous tally) as well as
      // the cited notes it corrects, so no outcome is counted twice when both are recalled
      const window = (this.speciesNoteIds.get(species) ?? []).slice(-drift.n);
      const prevTally = this.lastTallyId.get(species);
      const sup = [...new Set([...call.cited_note_ids.slice(0, 3), ...window, ...(prevTally ? [prevTally] : [])])];
      this.lastTallyId.set(species, this.d.writer.enqueue((sp) => supersedeNote(sp, species, call.horizon_min, drift.yes, drift.n, sup, checkpoint), species, call.round_id, 'supersede', 3));
    }
  }

  async onCheckpoint(cp: RawCheckpoint, source: NetworkSource): Promise<void> {
    const seq = BigInt(cp.sequence_number!);
    const cpTs = tsToMs(cp.summary?.timestamp);
    const transfers = decodeCheckpoint(cp);
    const sightings = this.sightingsOf(transfers);
    // 0) retry resolutions whose write failed earlier (same outcome, same resolving checkpoint)
    for (const { r, source: s } of [...this.unpersisted.values()]) this.applyResolutions([r], s);
    // 1) resolve existing rounds first, so a sighting never resolves itself
    this.applyResolutions(this.resolver.onCheckpoint(seq, cp.digest ?? '', cpTs, activitiesOf(this.d.cfg.move_rule, cp, transfers, sightings)), source);
    // 2) open a round per sighting: opponents frozen now, memory recalled, call written before any outcome
    for (const t of sightings) {
      // one bad sighting (e.g. an I3 refusal at openRound) skips that round only — it never voids the open book
      try {
        await this.openSighting(t, seq, source);
      } catch (e) {
        this.d.onError?.(`sighting ${t.txDigest} skipped: ${String(e)}`);
      }
    }
    // 3) only now learn this checkpoint's moves (no same-checkpoint leakage into the species)
    for (const t of transfers) this.lastMove.set(t.sender, Math.max(this.lastMove.get(t.sender) ?? 0, t.timestampMs));
  }

  private async openSighting(t: Transfer, seq: bigint, source: NetworkSource): Promise<void> {
    if (this.d.store.has(t.txDigest)) return; // replayed checkpoint after restart
    const pBase = r6(this.base.p());
    const pFreq = r6(this.freq.p(t.sender, pBase));
    const prior = this.seenSenders.get(t.sender) ?? 0;
    const lm = this.lastMove.get(t.sender);
    const species = speciesSentence({
      coinType: t.coinType, amountRaw: t.amountRaw, thresholdRaw: this.thresholds.get(t.coinType)!,
      recipientsCount: t.recipients.length, timestampMs: t.timestampMs,
      repeatCounterparty: t.recipients.some((r) => this.pairs.has(`${t.sender}>${r}`)),
      lastMoveAgoMs: lm !== undefined && lm <= t.timestampMs ? t.timestampMs - lm : null,
      priorSightings: prior,
    });
    this.safeEmit('sighting', { seq: t.checkpointSeq, digest: t.txDigest, sender: t.sender, coin: t.coinType, amount: t.amountRaw.toString(), species, source });
    const mem = this.d.memory();
    const callStart = this.now();
    const nat = this.nat;
    const c = await naturalistCall(mem, species, pBase, {
      maxDistance: mem ? nat.max_distance[mem.kind] : 0, horizonMin: this.d.cfg.horizon_min, shrink: nat.shrink, minEvidence: nat.min_evidence ?? 0,
      callTimeMs: callStart, limit: nat.limit, recallMaxDistance: mem ? nat.recall_max_distance?.[mem.kind] : undefined,
    });
    const row: CallRow = {
      round_id: t.txDigest,
      created_at: new Date(Math.max(this.now(), callStart + 1)).toISOString(),
      network_source: source,
      checkpoint_seq: t.checkpointSeq,
      checkpoint_ts: t.timestampMs,
      tx_digest: t.txDigest,
      sender: t.sender,
      recipient: t.recipients[0] ?? '',
      coin_type: t.coinType,
      amount_raw: t.amountRaw.toString(),
      horizon_min: this.d.cfg.horizon_min,
      move_rule: this.d.cfg.move_rule,
      sender_seen_before: prior > 0,
      p_memory: c.p,
      call: c.call,
      p_base: pBase,
      p_freq: pFreq,
      cited_note_ids: c.cited.map((x) => x.id),
      cited_distances: c.cited.map((x) => x.distance),
      species,
      memory_source: mem?.kind ?? 'none',
      cited_created_at: c.cited.map((x) => x.created_at ?? null),
      abstain_reason: c.abstainReason,
      recall_ms: c.recallMs,
      cited_vote_p: c.citedVoteP === null ? null : Number(c.citedVoteP.toFixed(4)),
      recall_pairs: c.pairs,
      min_evidence: nat.min_evidence ?? 0,
    };
    this.d.store.openRound(row);
    // a round on disk is pending in the resolver at once: nothing may run between these two lines
    this.resolver.add({ roundId: row.round_id, sender: t.sender, txDigest: t.txDigest, checkpointSeq: seq, timestampMs: t.timestampMs, deadlineMs: t.timestampMs + this.H_MS });
    this.seenSenders.set(t.sender, prior + 1);
    for (const r of t.recipients) this.pairs.add(`${t.sender}>${r}`);
    this.roundsOpened++;
    this.safeEmit('call', row);
  
  }

  /** Drop stale history so a long-running logger stays small. */
  prune(nowTs: number): void {
    for (const [k, v] of this.lastMove) if (nowTs - v > HISTORY_TTL_MS) this.lastMove.delete(k);
  }

  get lastMoveSize(): number {
    return this.lastMove.size;
  }
}
