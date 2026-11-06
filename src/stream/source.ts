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

  constructor(endpoint: Endpoint, private ev: SourceEvents, opts: SourceOptions = {}) {
    this.clients = makeClients(endpoint);
    this.lastSeq = opts.resumeFromSeq ?? null;
    this.maxBackfill = opts.maxBackfill ?? 1200;
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
  }

  stop(): void {
    this.stopped = true;
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
    this.stream = st;
    this.streamOpenedAt = Date.now();
    this.ev.onStatus?.(`stream open on ${this.clients.endpoint.host} (${this.clients.endpoint.source})`);
    st.on('data', (r: RawSubscribeResponse) => {
      const cp = r.checkpoint;
      if (!cp?.sequence_number) return;
      this.queue = this.queue.then(() => this.handle(cp)).catch((e) => this.ev.onStatus?.(`handler error: ${String(e)}`));
    });
    st.on('error', (e: Error & { code?: number }) => {
      if (st !== this.stream) return; // superseded stream
      if (e.code === 1 && this.stopped) return;
      this.ev.onRpc?.('SubscribeCheckpoints', Date.now() - this.streamOpenedAt, false, this.clients.endpoint.source);
      this.ev.onStatus?.(`stream error ${e.code}: ${e.message} — reconnect in ${this.backoffMs} ms`);
      this.stream = null;
      const wait = this.backoffMs;
      // A stream that stayed up for a minute was healthy; reset backoff.
      this.backoffMs = Date.now() - this.streamOpenedAt > 60_000 ? 1000 : Math.min(30_000, this.backoffMs * 2);
      setTimeout(() => this.open(), wait);
    });
    st.on('end', () => {
      if (st !== this.stream || this.stopped) return;
      this.stream = null;
      setTimeout(() => this.open(), this.backoffMs);
    });
  }

  private async handle(cp: RawCheckpoint): Promise<void> {
    const seq = BigInt(cp.sequence_number!);
    if (this.lastSeq !== null && seq <= this.lastSeq) return; // duplicate after reconnect
    if (this.lastSeq !== null && seq > this.lastSeq + 1n) await this.backfill(this.lastSeq + 1n, seq - 1n);
    await this.deliver(cp);
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
      for (let attempt = 0; attempt < 4 && !cp; attempt++) {
        const t = Date.now();
        try {
          cp = (await getCheckpoint(this.clients, s.toString())).checkpoint;
          this.ev.onRpc?.('GetCheckpoint', Date.now() - t, true, this.clients.endpoint.source);
        } catch (e) {
          this.ev.onRpc?.('GetCheckpoint', Date.now() - t, false, this.clients.endpoint.source);
          if (attempt === 3) this.ev.onStatus?.(`GetCheckpoint ${s} failed: ${String(e)}`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (!cp) {
        this.ev.onGap?.(s, s, 'GetCheckpoint failed after retries');
        this.lastSeq = s;
        continue;
      }
      await this.deliver(cp);
    }
  }

  private async deliver(cp: RawCheckpoint): Promise<void> {
    this.lastSeq = BigInt(cp.sequence_number!);
    await this.ev.onCheckpoint(cp, this.clients.endpoint.source);
  }
}
