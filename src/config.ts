// Credential discovery. Secrets are read from the user's home config only — never from the repo,
// never logged. Every function here returns `null` when a credential is absent so callers can
// degrade (public-dev stream, local note queue) instead of crashing.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TATUM_ENV = join(homedir(), '.config', 'tatum', 'tatum.env');
export const MEMWAL_ENV = join(homedir(), '.config', 'memwal', 'memwal.env');
export const MEMWAL_JSON = join(homedir(), '.memwal', 'credentials.json');

/** Parse KEY=VALUE lines (quotes optional, `#` comments, `export ` prefix tolerated). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function readEnvFile(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export interface TatumCreds {
  apiKey: string;
  accountId?: string;
}

export function loadTatum(): TatumCreds | null {
  const fromEnv = process.env.TATUM_API_KEY;
  if (fromEnv) return { apiKey: fromEnv, accountId: process.env.TATUM_ACCOUNT_ID };
  const env = readEnvFile(TATUM_ENV);
  if (!env?.TATUM_API_KEY) return null;
  return { apiKey: env.TATUM_API_KEY, accountId: env.TATUM_ACCOUNT_ID };
}

export interface MemwalCreds {
  delegateKey: string;
  accountId: string;
  agentId?: string;
  suiAddress?: string;
  serverUrl: string;
  source: 'env' | 'credentials.json';
}

export const MEMWAL_RELAYER = 'https://relayer.memory.walrus.xyz';

export function loadMemwal(): MemwalCreds | null {
  const env = readEnvFile(MEMWAL_ENV);
  if (env?.MEMWAL_DELEGATE_KEY && env.MEMWAL_ACCOUNT_ID) {
    return {
      delegateKey: env.MEMWAL_DELEGATE_KEY,
      accountId: env.MEMWAL_ACCOUNT_ID,
      agentId: env.MEMWAL_AGENT_ID,
      suiAddress: env.SUI_ADDRESS,
      serverUrl: env.MEMWAL_SERVER_URL || MEMWAL_RELAYER,
      source: 'env',
    };
  }
  if (existsSync(MEMWAL_JSON)) {
    try {
      const j = JSON.parse(readFileSync(MEMWAL_JSON, 'utf8')) as Record<string, unknown>;
      const pick = (...keys: string[]) => {
        for (const k of keys) if (typeof j[k] === 'string' && j[k]) return j[k] as string;
        return undefined;
      };
      const delegateKey = pick('delegateKey', 'delegate_key', 'privateKey', 'key');
      const accountId = pick('accountId', 'account_id');
      if (delegateKey && accountId) {
        return {
          delegateKey,
          accountId,
          agentId: pick('agentId', 'publicKey', 'delegatePublicKey'),
          suiAddress: pick('suiAddress', 'address'),
          serverUrl: pick('serverUrl', 'relayerUrl') ?? MEMWAL_RELAYER,
          source: 'credentials.json',
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}
