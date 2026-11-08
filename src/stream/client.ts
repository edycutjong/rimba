// Sui gRPC client. Tatum's gateway is the production endpoint (critical path). Until a Tatum key
// exists the same protos are pointed at Sui's public fullnode and every row is tagged `public-dev`
// so it can never feed a headline number.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTatum } from '../config.js';
import { isPaymentRequired } from './governor.js';

export const TATUM_HOST = 'sui-mainnet-grpc.gateway.tatum.io:443';
export const PUBLIC_HOST = 'fullnode.mainnet.sui.io:443';

export type NetworkSource = 'tatum' | 'public-dev';

export interface Endpoint {
  host: string;
  source: NetworkSource;
  apiKey?: string;
}

/** Tatum when a key is configured, otherwise the public fullnode (dev only). */
export function chooseEndpoint(): Endpoint {
  const t = loadTatum();
  if (t) return { host: TATUM_HOST, source: 'tatum', apiKey: t.apiKey };
  return { host: PUBLIC_HOST, source: 'public-dev' };
}

export const PUBLIC_ENDPOINT: Endpoint = { host: PUBLIC_HOST, source: 'public-dev' };

/** Unary calls that fall back to the public node when Tatum answers 402 (plan out of credits) — used by verify.
 * The switch is one-way for the life of the object and reported through `onSwitch`, so a report can say which
 * endpoint actually served it. */
export function withPaymentFallback(primary: SuiClients, makeFallback: () => SuiClients = () => makeClients(PUBLIC_ENDPOINT), onSwitch?: (e: unknown) => void) {
  let cur = primary;
  return {
    get clients(): SuiClients {
      return cur;
    },
    async run<T>(fn: (c: SuiClients) => Promise<T>): Promise<T> {
      try {
        return await fn(cur);
      } catch (e) {
        if (cur.endpoint.source !== 'tatum' || !isPaymentRequired(e)) throw e;
        const old = cur;
        cur = makeFallback();
        old.close();
        onSwitch?.(e);
        return fn(cur);
      }
    },
  };
}

const PROTO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'proto');

let cachedPkg: grpc.GrpcObject | null = null;
function suiPackage(): grpc.GrpcObject {
  if (cachedPkg) return cachedPkg;
  const def = protoLoader.loadSync(
    ['sui/rpc/v2/subscription_service.proto', 'sui/rpc/v2/ledger_service.proto'],
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true, includeDirs: [PROTO_ROOT] },
  );
  const root = grpc.loadPackageDefinition(def) as unknown as {
    sui: { rpc: { v2: grpc.GrpcObject } };
  };
  cachedPkg = root.sui.rpc.v2;
  return cachedPkg;
}

export function metadataFor(ep: Endpoint): grpc.Metadata {
  const md = new grpc.Metadata();
  if (ep.apiKey) md.add('x-api-key', ep.apiKey);
  return md;
}

type Ctor = new (host: string, creds: grpc.ChannelCredentials, opts?: grpc.ChannelOptions) => grpc.Client;

const CHANNEL_OPTS: grpc.ChannelOptions = {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 10_000,
};

export interface SuiClients {
  endpoint: Endpoint;
  subscription: grpc.Client;
  ledger: grpc.Client;
  close(): void;
}

export function makeClients(ep: Endpoint = chooseEndpoint()): SuiClients {
  const pkg = suiPackage();
  const creds = grpc.credentials.createSsl();
  const Sub = pkg.SubscriptionService as unknown as Ctor;
  const Led = pkg.LedgerService as unknown as Ctor;
  const subscription = new Sub(ep.host, creds, CHANNEL_OPTS);
  const ledger = new Led(ep.host, creds, CHANNEL_OPTS);
  return {
    endpoint: ep,
    subscription,
    ledger,
    close() {
      subscription.close();
      ledger.close();
    },
  };
}

/** Fields the decoder needs — keeps stream payloads small. Paths are relative to `Checkpoint`. */
export const CHECKPOINT_READ_MASK = [
  'sequence_number',
  'digest',
  'summary.timestamp',
  'transactions.digest',
  'transactions.transaction.sender',
  'transactions.effects.status',
  'transactions.balance_changes',
].join(',');

export function subscribeCheckpoints(c: SuiClients, readMask = CHECKPOINT_READ_MASK): grpc.ClientReadableStream<unknown> {
  const fn = (c.subscription as unknown as Record<string, (req: unknown, md: grpc.Metadata) => grpc.ClientReadableStream<unknown>>)
    .SubscribeCheckpoints!.bind(c.subscription);
  return fn({ read_mask: { paths: readMask.split(',') } }, metadataFor(c.endpoint));
}

/** Retry a call that the gateway rate-limited (gRPC UNAVAILABLE carrying HTTP 429, or RESOURCE_EXHAUSTED).
 * Tatum's free tier answers bursts of unary calls with 429 (observed 2026-11-07: 4 GetTransaction in ~200 ms → 1 × 429);
 * without this, verify reported those as "tx not found". Other errors are thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 300, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: number }).code;
      const limited = code === grpc.status.RESOURCE_EXHAUSTED || (code === grpc.status.UNAVAILABLE && /429|rate/i.test(String((e as Error).message)));
      if (!limited || i >= attempts - 1) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

function unary<T>(client: grpc.Client, method: string, req: unknown, ep: Endpoint, timeoutMs = 15_000): Promise<T> {
  return withRetry(() => unaryOnce<T>(client, method, req, ep, timeoutMs));
}

function unaryOnce<T>(client: grpc.Client, method: string, req: unknown, ep: Endpoint, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const fn = (client as unknown as Record<string, (r: unknown, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v: T) => void) => void>)[method];
    if (!fn) return reject(new Error(`no method ${method}`));
    fn.call(client, req, metadataFor(ep), { deadline: Date.now() + timeoutMs }, (err, v) => (err ? reject(err) : resolve(v)));
  });
}

export function getCheckpoint(c: SuiClients, sequenceNumber?: string, readMask = CHECKPOINT_READ_MASK) {
  const req: Record<string, unknown> = { read_mask: { paths: readMask.split(',') } };
  if (sequenceNumber !== undefined) req.sequence_number = sequenceNumber;
  return unary<{ checkpoint?: RawCheckpoint }>(c.ledger, 'GetCheckpoint', req, c.endpoint);
}

export function getTransaction(c: SuiClients, digest: string) {
  return unary<{ transaction?: RawTransaction }>(
    c.ledger,
    'GetTransaction',
    { digest, read_mask: { paths: ['digest', 'checkpoint', 'timestamp', 'transaction.sender', 'effects.status', 'balance_changes'] } },
    c.endpoint,
  );
}

// ---- raw shapes as decoded by proto-loader (keepCase, longs as String) ----
export interface RawTimestamp { seconds?: string; nanos?: number }
export interface RawBalanceChange { address?: string; coin_type?: string; amount?: string }
export interface RawTransaction {
  digest?: string;
  checkpoint?: string;
  timestamp?: RawTimestamp;
  transaction?: { sender?: string };
  effects?: { status?: { success?: boolean } };
  balance_changes?: RawBalanceChange[];
}
export interface RawCheckpoint {
  sequence_number?: string;
  digest?: string;
  summary?: { timestamp?: RawTimestamp };
  transactions?: RawTransaction[];
}
export interface RawSubscribeResponse { cursor?: string; checkpoint?: RawCheckpoint }
