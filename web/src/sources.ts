import type { NoteInfo, Round, ScoreSet, Sink, SourceStatus } from './types';

const MIN = 60_000;

interface Snapshot {
  generated_at: string;
  question: { horizon_min: number; move_rule: string };
  score: ScoreSet;
  rounds: Round[];
  notes: Record<string, NoteInfo>;
  health: { source: string | null; memory: string | null; last_seq: string | null };
  counts?: { rounds_in_snapshot: number; resolved_total: number };
}

const rank = (r: Round) => (r.resolution ? Date.parse(r.resolution.resolved_at) : Infinity);

/**
 * ReplaySource — plays the frozen snapshot back at `speed`× on the chain's own clock.
 * Calls appear at their logged created_at, resolutions at their logged resolved_at. Nothing is invented:
 * a round's call, its cited notes and its stamp are exactly what the logger wrote.
 */
export class ReplaySource {
  readonly mode = 'replay' as const;
  private snap!: Snapshot;
  private timer = 0;
  private virtual = 0;
  private lastReal = 0;
  private idx = 0;
  private pendingRes: Round[] = [];
  private speed = 10;
  private startAt = 0;
  private endAt = 0;
  private stopped = false;
  private newest: Round | null = null;
  private loops = 0;

  /** `focusId` (deep link `?round=<id>`) starts the replay a few chain-seconds before that round's call;
   * `speed` (`?speed=`) is clamped to 1–60× and always shown on the card. */
  constructor(
    private sink: Sink,
    private base = import.meta.env.BASE_URL,
    private reason: string | null = null,
    opts: { focusId?: string | null; speed?: number | null; snapshot?: string } = {},
  ) {
    this.focusId = opts.focusId ?? null;
    this.snapshotPath = opts.snapshot ?? 'data/snapshot.json';
    if (opts.speed && Number.isFinite(opts.speed)) this.speed = Math.min(60, Math.max(1, Math.round(opts.speed)));
  }
  private focusId: string | null;
  private snapshotPath: string;

  async start(): Promise<void> {
    const res = await fetch(`${this.base}${this.snapshotPath}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${this.snapshotPath} ${res.status}`);
    this.snap = (await res.json()) as Snapshot;
    const rounds = this.snap.rounds;
    this.sink.onNotes(this.snap.notes);
    this.sink.onScore(this.snap.score);
    this.sink.onHistory(rounds);
    if (!rounds.length) return this.emitStatus();
    this.startAt = Date.parse(rounds[0]!.created_at);
    this.endAt = Math.max(...rounds.map((r) => (r.resolution ? Date.parse(r.resolution.resolved_at) : 0))) + 20_000;
    const focus = this.focusId ? rounds.find((r) => r.round_id === this.focusId) : undefined;
    if (focus) {
      // deep link: everything before stays history; the linked call surfaces live a moment later
      this.beginAt(Date.parse(focus.created_at) - 1_000 * this.speed, true);
    } else {
      // warm start: open on a moment where several calls are mid-countdown, not on an empty reef
      const warmIdx = Math.min(rounds.length - 1, Math.max(0, Math.floor(rounds.length / 3)));
      this.beginAt(Date.parse(rounds[warmIdx]!.created_at) + 1_000, true);
    }
    this.lastReal = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.timer = window.setInterval(() => this.tick(), reduce ? 1_000 : 250);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private beginAt(virtualMs: number, instant: boolean) {
    const rounds = this.snap.rounds;
    this.virtual = virtualMs;
    this.idx = 0;
    this.pendingRes = [];
    // everything already in the past at the warm-start moment is delivered instantly (history, not a show)
    while (this.idx < rounds.length && Date.parse(rounds[this.idx]!.created_at) <= virtualMs) {
      const r = rounds[this.idx++]!;
      this.deliverCall(r, instant);
      if (r.resolution && Date.parse(r.resolution.resolved_at) <= virtualMs) this.deliverResolution(r, instant);
      else if (r.resolution) this.pendingRes.push(r);
    }
    this.emitStatus();
  }

  private tick() {
    if (this.stopped) return;
    const now = performance.now();
    const dt = Math.min(2_000, now - this.lastReal); // a throttled background tab must not fast-forward the stamps
    this.lastReal = now;
    this.virtual += dt * this.speed;
    const rounds = this.snap.rounds;
    while (this.idx < rounds.length && Date.parse(rounds[this.idx]!.created_at) <= this.virtual) {
      const r = rounds[this.idx++]!;
      this.deliverCall(r, false);
      if (r.resolution) this.pendingRes.push(r);
    }
    if (this.pendingRes.length) {
      this.pendingRes.sort((a, b) => rank(a) - rank(b));
      while (this.pendingRes.length && rank(this.pendingRes[0]!) <= this.virtual) this.deliverResolution(this.pendingRes.shift()!, false);
    }
    if (this.virtual > this.endAt && this.idx >= rounds.length && !this.pendingRes.length) {
      this.loops += 1;
      this.sink.onStatus({ ...this.status(), note: 'Replay finished — restarting from the first sighting.' });
      this.beginAt(this.startAt - 1_000, false);
    }
    this.emitStatus();
  }

  private deliverCall(r: Round, instant: boolean) {
    this.newest = r;
    this.sink.onCall({ ...r, resolution: null }, instant);
  }
  private deliverResolution(r: Round, instant: boolean) {
    this.sink.onResolution(r, instant);
  }

  private status(): SourceStatus {
    return {
      mode: 'replay',
      horizon_min: this.snap.question.horizon_min,
      checkpoint: this.newest?.checkpoint_seq ?? this.snap.health.last_seq,
      network_source: this.newest?.network_source ?? null,
      memory: this.newest?.memory_source ?? null,
      note: this.reason,
      generated_at: this.snap.generated_at,
      csv_url: `${this.base}data/rounds.csv`,
      speed: this.speed,
      clockMs: this.virtual,
      counts: this.snap.counts ? { in_snapshot: this.snap.counts.rounds_in_snapshot, resolved_total: this.snap.counts.resolved_total } : null,
    };
  }
  private emitStatus() {
    this.sink.onStatus(this.status());
  }
  get loopCount(): number {
    return this.loops;
  }
}

interface ApiRound extends Omit<Round, 'n'> {
  n?: number;
}

/** LiveSource — SSE from the local logger server (`pnpm server`, 127.0.0.1:8787). */
export class LiveSource {
  readonly mode = 'live' as const;
  private es: EventSource | null = null;
  private horizon = 15;
  private moveRule = '';
  private counter = 0;
  private rounds = new Map<string, Round>();
  private checkpoint: string | null = null;
  private network: 'tatum' | 'public-dev' | null = null;
  private memory: string | null = null;
  private scoreTimer = 0;
  private clockTimer = 0;

  constructor(private sink: Sink, private base: string) {}

  private async json<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return (await r.json()) as T;
  }

  /** Resolves once the server said hello; rejects (so the caller can fall back to replay) otherwise. */
  start(timeoutMs = 3_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const es = new EventSource(`${this.base}/events`);
      this.es = es;
      const fail = window.setTimeout(() => {
        es.close();
        reject(new Error('no hello from logger server'));
      }, timeoutMs);
      es.addEventListener('hello', (e) => {
        clearTimeout(fail);
        const h = JSON.parse((e as MessageEvent).data) as { horizon_min: number; move_rule: string };
        this.horizon = h.horizon_min;
        this.moveRule = h.move_rule;
        this.hydrate().then(resolve, reject);
        this.wire(es);
      });
      es.onerror = () => {
        // before hello: let the timeout reject; after hello EventSource retries by itself
      };
    });
  }

  stop(): void {
    this.es?.close();
    clearTimeout(this.scoreTimer);
    clearInterval(this.clockTimer);
  }

  private matches(r: { horizon_min: number; move_rule: string }) {
    return r.horizon_min === this.horizon && r.move_rule === this.moveRule;
  }

  private async hydrate() {
    const [rs, notes, score] = await Promise.all([
      this.json<{ rounds: ApiRound[]; total: number }>('/api/rounds?limit=1000'),
      this.json<{ notes: (NoteInfo & { specimen_id: string })[] }>('/api/notes?limit=500'),
      this.json<ScoreSet>('/api/score'),
    ]);
    const map: Record<string, NoteInfo> = {};
    for (const n of notes.notes) map[n.specimen_id] = n;
    this.sink.onNotes(map);
    this.sink.onScore(score);
    // /api/rounds is newest-first and sliced from the full joined list, so position i has catalogue number total − i
    const withN: Round[] = rs.rounds.map((r, i) => ({ ...r, n: rs.total - i }) as Round);
    this.counter = rs.total;
    const chrono = withN.filter((r) => this.matches(r)).reverse();
    for (const r of chrono) this.rounds.set(r.round_id, r);
    this.sink.onHistory(chrono.filter((r) => r.resolution && r.resolution.outcome !== null));
    // replay the last 20 minutes of the live stream into the reef without animation
    const horizonAgo = Date.now() - 20 * MIN;
    for (const r of chrono) {
      if (Date.parse(r.created_at) < horizonAgo && r.resolution) continue;
      this.sink.onCall({ ...r, resolution: null }, true);
      if (r.resolution) this.sink.onResolution(r, true);
    }
    const last = chrono[chrono.length - 1];
    if (last) this.touch(last);
    this.emit();
    this.clockTimer = window.setInterval(() => this.emit(), 1_000);
  }

  private wire(es: EventSource) {
    es.addEventListener('call', (e) => {
      const r = JSON.parse((e as MessageEvent).data) as ApiRound;
      if (!this.matches(r)) return;
      this.counter += 1;
      const round: Round = { ...r, n: this.counter, resolution: null };
      this.rounds.set(round.round_id, round);
      this.touch(round);
      this.sink.onCall(round, false);
    });
    es.addEventListener('resolution', (e) => {
      const res = JSON.parse((e as MessageEvent).data) as Round['resolution'] & { round_id: string };
      const r = this.rounds.get(res.round_id);
      if (!r || !res) return;
      const resolution = { ...res } as Partial<typeof res>;
      delete resolution.round_id;
      const done: Round = { ...r, resolution: resolution as NonNullable<Round['resolution']> };
      this.rounds.set(done.round_id, done);
      this.sink.onResolution(done, false);
      clearTimeout(this.scoreTimer);
      this.scoreTimer = window.setTimeout(() => this.refreshScore(), 3_000);
    });
    es.addEventListener('health', (e) => {
      const h = JSON.parse((e as MessageEvent).data) as { last_seq?: string; source?: 'tatum' | 'public-dev'; memory?: string } | null;
      if (!h) return;
      if (h.last_seq) this.checkpoint = h.last_seq;
      if (h.source) this.network = h.source;
      if (h.memory) this.memory = h.memory;
    });
    es.addEventListener('note', (e) => {
      const n = JSON.parse((e as MessageEvent).data) as NoteInfo & { specimen_id: string; ok?: boolean };
      if (n.ok !== false) this.sink.onNotes({ [n.specimen_id]: n });
    });
  }

  private async refreshScore() {
    try {
      this.sink.onScore(await this.json<ScoreSet>('/api/score'));
      const rs = await this.json<{ rounds: ApiRound[]; total: number }>('/api/rounds?limit=1000');
      const chrono = rs.rounds.map((r, i) => ({ ...r, n: rs.total - i }) as Round).filter((r) => this.matches(r) && r.resolution && r.resolution.outcome !== null).reverse();
      this.sink.onHistory(chrono);
    } catch {
      /* next resolution retries */
    }
  }

  private touch(r: Round) {
    this.checkpoint = r.checkpoint_seq;
    this.network = r.network_source;
    this.memory = r.memory_source ?? null;
  }

  private emit() {
    this.sink.onStatus({
      mode: 'live',
      horizon_min: this.horizon,
      checkpoint: this.checkpoint,
      network_source: this.network,
      memory: this.memory,
      note: null,
      csv_url: `${this.base}/rounds.csv`,
      clockMs: Date.now(),
    });
  }
}
