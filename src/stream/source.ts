// Ordered, gap-free checkpoint feed. Wraps SubscribeCheckpoints with:
//  - reconnect with exponential backoff (1 s → 30 s)
//  - gap backfill through LedgerService.GetCheckpoint for any skipped sequence numbers
//    (after a reconnect, or on start-up when resuming from a saved sequence number)
//  - endpoint hot-switch: `switchEndpoint()` reconnects on a new endpoint and resumes from the
//    last delivered sequence, so nothing is missed when the Tatum key appears.
// Checkpoints are delivered strictly in ascending order; a gap that cannot be backfilled is
// reported through `onGap` so rounds spanning it can be voided rather than mis-resolved.
import type * as grpc from '@grpc/grpc-js';
import { getCheckpoint, makeClients, subscribeCheckpoints, type Endpoint, type RawCheckpoint, type RawSubscribeResponse, type SuiClients } from './client.js';

export interface SourceEvents {
  onCheckpoint(cp: RawCheckpoint, source: Endpoint['source']): void | Promise<void>;
  onGap?(fromSeq: bigint, toSeq: bigint, reason: string): void;
  onStatus?(msg: string): void;
  /** Called after each sponsor RPC with its latency, for the live integration view. */
  onRpc?(method: string, ms: number, ok: boolean, source: Endpoint['source']): void;
}

export interface SourceOptions {
  resumeFromSeq?: bigint; // last delivered seq; delivery resumes at +1
  maxBackfill?: number; // checkpoints; larger gaps are reported, not fetched
  idleMs?: number; // silent-stream watchdog (default 30 s)
}

export class CheckpointSource {
  private clients: SuiClients;
  private stream: grpc.ClientReadableStream<unknown> | null = null;
  private lastSeq: bigint | null;
  private backoffMs = 1000;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBackfill: number;
  private streamOpenedAt = 0;
  private deliveredSinceOpen = 0;
  private lastDataAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  /** A connected stream that sends nothing for this long is cancelled and reopened. */
  readonly idleMs: number;

  constructor(endpoint: Endpoint, private ev: SourceEvents, opts: SourceOptions = {}) {
    this.clients = makeClients(endpoint);
    this.lastSeq = opts.resumeFromSeq ?? null;
    this.maxBackfill = opts.maxBackfill ?? 1200;
    this.idleMs = opts.idleMs ?? 30_000;
  }

  get endpoint(): Endpoint {
    return this.clients.endpoint;
  }
  get lastDeliveredSeq(): bigint | null {
    return this.lastSeq;
  }

  start(): void {
    this.stopped = false;
    this.open();
    this.watchdog ??= setInterval(() => this.checkIdle(), Math.min(5000, this.idleMs));
    this.watchdog.unref?.();
  }

  /** Silent-stream watchdog: keepalive catches dead sockets, not a live connection that sends no data. */
  checkIdle(now = Date.now()): boolean {
    if (this.stopped || !this.stream || now - this.lastDataAt < this.idleMs) return false;
    this.ev.onStatus?.(`stream idle for ${Math.round((now - this.lastDataAt) / 1000)} s — reopening`);
    const st = this.stream;
    this.stream = null;
    st.cancel();
    this.open();
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.stream?.cancel();
    this.stream = null;
    this.clients.close();
  }

  switchEndpoint(ep: Endpoint): void {
    this.ev.onStatus?.(`switching endpoint ${this.clients.endpoint.source} → ${ep.source}`);
    this.stream?.cancel();
    this.stream = null;
    this.clients.close();
    this.clients = makeClients(ep);
    this.backoffMs = 1000;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const st = subscribeCheckpoints(this.clients);
    // provenance is fixed at ingress: a checkpoint queued before an endpoint switch keeps its own source
    const source = this.clients.endpoint.source;
    this.stream = st;
    this.streamOpenedAt = Date.now();
    this.lastDataAt = Date.now();
    this.deliveredSinceOpen = 0;
    this.ev.onStatus?.(`stream open on ${this.clients.endpoint.host} (${this.clients.endpoint.source})`);
    st.on('data', (r: RawSubscribeResponse) => {
      const cp = r.checkpoint;
      if (!cp?.sequence_number) return;
      this.deliveredSinceOpen++;
      this.lastDataAt = Date.now();
      this.queue = this.queue.then(() => this.handle(cp, source)).catch((e) => this.ev.onStatus?.(`handler error: ${String(e)}`));
    });
    st.on('error', (e: Error & { code?: number }) => {
      if (st !== this.stream) return; // superseded stream
      if (e.code === 1 && this.stopped) return;
      this.ev.onRpc?.('SubscribeCheckpoints', Date.now() - this.streamOpenedAt, false, this.clients.endpoint.source);
      this.ev.onStatus?.(`stream error ${e.code}: ${e.message} — reconnect in ${this.backoffMs} ms`);
      this.stream = null;
      const wait = this.backoffMs;
      // A stream that delivered checkpoints was healthy (the public node resets every ~30 s);
      // only back off exponentially when connects fail outright.
      this.backoffMs = this.deliveredSinceOpen > 0 ? 1000 : Math.min(30_000, this.backoffMs * 2);
      setTimeout(() => this.open(), wait);
    });
    st.on('end', () => {
      if (st !== this.stream || this.stopped) return;
      this.stream = null;
      setTimeout(() => this.open(), this.backoffMs);
    });
  }

  private async handle(cp: RawCheckpoint, source: Endpoint['source']): Promise<void> {
    const seq = BigInt(cp.sequence_number!);
    if (this.lastSeq !== null && seq <= this.lastSeq) return; // duplicate after reconnect
    if (this.lastSeq !== null && seq > this.lastSeq + 1n) await this.backfill(this.lastSeq + 1n, seq - 1n);
    await this.deliver(cp, source);
  }

  private async backfill(from: bigint, to: bigint): Promise<void> {
    const n = Number(to - from + 1n);
    let start = from;
    if (n > this.maxBackfill) {
      const skipTo = to - BigInt(this.maxBackfill) + 1n;
      this.ev.onGap?.(from, skipTo - 1n, `gap of ${n} checkpoints exceeds backfill cap ${this.maxBackfill}`);
      start = skipTo;
    }
    this.ev.onStatus?.(`backfilling ${start}..${to} (${Number(to - start + 1n)} checkpoints)`);
    for (let s = start; s <= to; s++) {
      let cp: RawCheckpoint | undefined;
      let cpSource: Endpoint['source'] = this.clients.endpoint.source;
      for (let attempt = 0; attempt < 4 && !cp; attempt++) {
        const t = Date.now();
        const c = this.clients; // the client this attempt actually uses labels the checkpoint it returns
        try {
          const got = (await getCheckpoint(c, s.toString())).checkpoint;
          if (!got?.sequence_number) throw new Error('GetCheckpoint returned no sequence_number');
          cp = got;
          cpSource = c.endpoint.source;
          this.ev.onRpc?.('GetCheckpoint', Date.now() - t, true, c.endpoint.source);
        } catch (e) {
          this.ev.onRpc?.('GetCheckpoint', Date.now() - t, false, c.endpoint.source);
          if (attempt === 3) this.ev.onStatus?.(`GetCheckpoint ${s} failed: ${String(e)}`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (!cp) {
        this.ev.onGap?.(s, s, 'GetCheckpoint failed after retries');
        this.lastSeq = s;
        continue;
      }
      await this.deliver(cp, cpSource);
    }
  }

  private async deliver(cp: RawCheckpoint, source: Endpoint['source']): Promise<void> {
    this.lastSeq = BigInt(cp.sequence_number!);
    await this.ev.onCheckpoint(cp, source);
  }
}
