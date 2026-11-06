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
    return (await this.poll(jobIds, 120_000)).map((s, i) => ({ ...s, text: texts[i]! }));
  }

  /** Re-poll accepted jobs (a congested upload can run ~25 min); resubmitting would pay for a second blob. */
  async confirm(jobIds: string[]): Promise<StoredNote[]> {
    return this.poll(jobIds, 20_000);
  }

  private async poll(jobIds: string[], timeoutMs: number): Promise<StoredNote[]> {
    const t = Date.now();
    try {
      // results are positional: results[i] belongs to jobIds[i] (SDK 0.1.13 memwal.js waitForRememberJobs)
      const res = await this.mw.waitForRememberJobs(jobIds, jobIds.map(() => NAMESPACE), { timeoutMs, pollIntervalMs: 3000 });
      this.rpc('memwal.waitForRememberJobs', Date.now() - t, res.failed === 0);
      const at = new Date().toISOString();
      return jobIds.map((id, i) => {
        const r = res.results[i];
        if (!r) return { text: '', ok: false, pending: true, job_id: id, created_at: at, error: 'no status returned' };
        // `timeout` = still running: pending, not failed. `failed` / `not_found` are final.
        return { text: '', ok: r.status === 'done', pending: r.status === 'timeout', job_id: r.id || id, blob_id: r.blob_id || undefined, created_at: at, error: r.status === 'done' ? undefined : r.error ?? r.status };
      });
    } catch (e) {
      this.rpc('memwal.waitForRememberJobs', Date.now() - t, false);
      // every status read refused (429): the jobs were accepted, so they stay pending — never claimed, never resent
      const at = new Date().toISOString();
      return jobIds.map((id) => ({ text: '', ok: false, pending: true, job_id: id, created_at: at, error: String(e) }));
    }
  }
}
