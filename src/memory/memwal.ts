// Walrus Memory wrapper. One namespace (`field-notes`). The client is only created when a delegate
// key exists; otherwise callers get `null` and the logger runs on the local-dev stand-in until the
// credential watcher sees the key appear.
import { MemWal, MemWalRateLimitedError } from '@mysten-incubation/memwal';
import { randomBytes } from 'node:crypto';
import { loadMemwal, MEMWAL_RELAYER, type MemwalCreds } from '../config.js';
import { RateLimitedError, type NoteMemory, type RecallQuery, type RecalledNote, type StoredNote } from './backend.js';

export const NAMESPACE = 'field-notes';
/** Recall ranking: semantic first, a recency nudge with a short half-life so drifting species update. */
export const SCORING_WEIGHTS = { semantic: 1, recency: 0.5, recencyHalfLifeDays: 3 } as const;

export function createMemwal(creds: MemwalCreds | null = loadMemwal()): MemWal | null {
  if (!creds) return null;
  return MemWal.create({ key: creds.delegateKey, accountId: creds.accountId, serverUrl: creds.serverUrl, namespace: NAMESPACE });
}

/** A throwaway client for the unauthenticated endpoints (`/health`, `/version`). Never writes. */
export function anonymousMemwal(serverUrl = MEMWAL_RELAYER): MemWal {
  return MemWal.create({ key: randomBytes(32).toString('hex'), accountId: '0x0', serverUrl, namespace: NAMESPACE });
}

export type RpcLog = (method: string, ms: number, ok: boolean) => void;

function asRateLimit(e: unknown): RateLimitedError | null {
  if (e instanceof MemWalRateLimitedError) return new RateLimitedError(e.retryAfterSeconds ?? 60, e.message);
  const st = (e as { status?: number } | null)?.status;
  if (st === 429) return new RateLimitedError(Number((e as { retryAfterSeconds?: number }).retryAfterSeconds) || 60, String(e));
  return null;
}

/** The judged memory path: recall and rememberBulk against the mainnet relayer. */
export class WalrusNoteMemory implements NoteMemory {
  readonly kind = 'walrus' as const;
  constructor(private mw: MemWal, private rpc: RpcLog = () => {}, private recallTimeoutMs = 6000) {}

  async recall(q: RecallQuery): Promise<RecalledNote[]> {
    const t = Date.now();
    try {
      const r = await this.mw.recall({
        query: q.query, namespace: NAMESPACE, limit: q.limit, maxDistance: q.maxDistance,
        scoringWeights: { ...SCORING_WEIGHTS }, timeoutMs: this.recallTimeoutMs,
      });
      this.rpc('memwal.recall', Date.now() - t, true);
      return r.results.map((x) => ({ text: x.text, distance: x.distance, created_at: x.created_at, blob_id: x.blob_id }));
    } catch (e) {
      this.rpc('memwal.recall', Date.now() - t, false);
      throw asRateLimit(e) ?? e;
    }
  }

  async remember(texts: string[]): Promise<StoredNote[]> {
    if (texts.length > 20) throw new Error('rememberBulk takes at most 20 items');
    const items = texts.map((text) => ({ text, namespace: NAMESPACE }));
    const t = Date.now();
    let jobIds: string[];
    try {
      jobIds = (await this.mw.rememberBulk(items)).job_ids;
      this.rpc('memwal.rememberBulk', Date.now() - t, true);
    } catch (e) {
      this.rpc('memwal.rememberBulk', Date.now() - t, false);
      throw asRateLimit(e) ?? e;
    }
    const t2 = Date.now();
    try {
      const res = await this.mw.waitForRememberJobs(jobIds, items.map(() => NAMESPACE), { timeoutMs: 300_000, pollIntervalMs: 3000 });
      this.rpc('memwal.waitForRememberJobs', Date.now() - t2, res.failed === 0);
      const at = new Date().toISOString();
      return res.results.map((r, i) => ({ text: texts[i]!, ok: r.status === 'done', job_id: r.id || jobIds[i], blob_id: r.blob_id || undefined, created_at: at, error: r.error }));
    } catch (e) {
      this.rpc('memwal.waitForRememberJobs', Date.now() - t2, false);
      // Accepted but unconfirmed: report as failed with their job ids so nothing is claimed as stored.
      const at = new Date().toISOString();
      return texts.map((text, i) => ({ text, ok: false, job_id: jobIds[i], created_at: at, error: String(e) }));
    }
  }
}
