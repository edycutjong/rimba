// Walrus Memory wrapper. One namespace (`field-notes`). The client is only created when a delegate
// key exists; otherwise callers get `null` and queue notes locally until the credential watcher
// sees the key appear.
import { MemWal } from '@mysten-incubation/memwal';
import { randomBytes } from 'node:crypto';
import { loadMemwal, MEMWAL_RELAYER, type MemwalCreds } from '../config.js';

export const NAMESPACE = 'field-notes';

export function createMemwal(creds: MemwalCreds | null = loadMemwal()): MemWal | null {
  if (!creds) return null;
  return MemWal.create({ key: creds.delegateKey, accountId: creds.accountId, serverUrl: creds.serverUrl, namespace: NAMESPACE });
}

/** A throwaway client for the unauthenticated endpoints (`/health`, `/version`). Never writes. */
export function anonymousMemwal(serverUrl = MEMWAL_RELAYER): MemWal {
  return MemWal.create({ key: randomBytes(32).toString('hex'), accountId: '0x0', serverUrl, namespace: NAMESPACE });
}
