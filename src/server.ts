// Local read-only server over the logger's files (127.0.0.1:8787). It never writes and never holds
// credentials: the logger is the only process that talks to Tatum and Walrus Memory for the loop.
//   GET /events               SSE: sighting · call · resolution · note (tailed from the append-only files) + health
//   GET /api/rounds           ?since=ISO&neverSeen=1&limit=200 — newest first, call joined with its resolution
//   GET /api/score            Brier scorecard (headline Tatum×Walrus + labelled development views)
//   GET /api/health           logger heartbeat + Walrus Memory relayer health
//   GET /api/notes            ?limit=50 — most recent field notes
//   GET /rounds.csv           every resolved round of the current question (same file `pnpm score --write` emits)
//   GET /integrations/verify  last 20 sponsor calls (method, latency, ok, source)
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { NoteRecord } from './notes.js';
import { joinRounds, roundsCsv, scorecard } from './score.js';
import { files, loadConfig, readJson, readJsonl, type CallRow, type ResolutionRow } from './store.js';

/** Incremental reader of an append-only JSONL file (keeps a partial trailing line for next time). */
export class JsonlTail {
  private offset: number;
  private partial = '';
  constructor(private path: string, fromEnd = true) {
    this.offset = fromEnd && existsSync(path) ? statSync(path).size : 0;
  }
  read(): unknown[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) this.offset = 0; // truncated/rotated
    if (size === this.offset) return [];
    const fd = openSync(this.path, 'r');
    const buf = Buffer.alloc(size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    this.offset = size;
    const text = this.partial + buf.toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    const out: unknown[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip torn line */
      }
    }
    return out;
  }
}

/** Last `n` JSONL rows without reading the whole file. */
export function tailJsonl<T>(path: string, n: number, maxBytes = 256 * 1024): T[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // first line may be cut
  const out: T[] = [];
  for (const l of lines.slice(-n - 1)) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      /* skip */
    }
  }
  return out.slice(-n);
}

export interface ServerOptions {
  relayerHealth?: () => Promise<unknown>;
  pollMs?: number;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function joinedRounds(calls: CallRow[], resolutions: ResolutionRow[]) {
  const res = new Map(resolutions.map((r) => [r.round_id, r]));
  return calls.map((c) => ({ ...c, resolution: res.get(c.round_id) ?? null }));
}

export function makeServer(opts: ServerOptions = {}): Server {
  const cfg = loadConfig();
  const clients = new Set<ServerResponse>();
  const tails = {
    sighting: new JsonlTail(files.sightings()),
    call: new JsonlTail(files.calls()),
    resolution: new JsonlTail(files.resolutions()),
    note: new JsonlTail(files.notes()),
  };
  let relayer: { at: number; value: unknown } = { at: 0, value: null };
  const relayerHealth = async () => {
    if (!opts.relayerHealth) return null;
    if (Date.now() - relayer.at > 60_000) {
      relayer = { at: Date.now(), value: await opts.relayerHealth().catch((e) => { console.error('[server] relayer health failed:', e); return { error: 'relayer unavailable' }; }) };
    }
    return relayer.value;
  };

  const send = (ev: string, data: unknown) => {
    const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const poll = setInterval(() => {
    if (!clients.size) {
      for (const t of Object.values(tails)) t.read(); // keep offsets current
      return;
    }
    for (const [ev, t] of Object.entries(tails)) for (const row of t.read()) send(ev, row);
  }, opts.pollMs ?? 1000);
  const hb = setInterval(() => clients.size && send('health', readJson(files.health())), 10_000);
  poll.unref();
  hb.unref();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': '*' });
        return res.end();
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      switch (url.pathname) {
        case '/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
          res.write(`event: hello\ndata: ${JSON.stringify({ horizon_min: cfg.horizon_min, move_rule: cfg.move_rule, health: readJson(files.health()) })}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        case '/api/rounds': {
          const since = url.searchParams.get('since');
          const neverSeen = url.searchParams.get('neverSeen') === '1' || url.searchParams.get('neverSeen') === 'true';
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
          let rows = joinedRounds(readJsonl<CallRow>(files.calls()), readJsonl<ResolutionRow>(files.resolutions()));
          if (since) rows = rows.filter((r) => r.created_at > since);
          if (neverSeen) rows = rows.filter((r) => !r.sender_seen_before);
          return json(res, 200, { rounds: rows.slice(-limit).reverse(), total: rows.length });
        }
        case '/api/score': {
          const calls = readJsonl<CallRow>(files.calls());
          const resolutions = readJsonl<ResolutionRow>(files.resolutions());
          return json(res, 200, {
            headline: scorecard(calls, resolutions, cfg, { network_source: 'tatum', memory_source: 'walrus' }),
            development: scorecard(calls, resolutions, cfg, { network_source: 'public-dev', memory_source: 'local-dev' }),
            all_rows: scorecard(calls, resolutions, cfg),
          });
        }
        case '/rounds.csv': {
          const sameQ = readJsonl<CallRow>(files.calls()).filter((c) => c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule);
          const csv = roundsCsv(joinRounds(sameQ, readJsonl<ResolutionRow>(files.resolutions())).rounds);
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
          return res.end(csv);
        }
        case '/api/health':
          return json(res, 200, { logger: readJson(files.health()), walrus_relayer: await relayerHealth() });
        case '/api/notes': {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
          return json(res, 200, { notes: tailJsonl<NoteRecord>(files.notes(), limit).reverse() });
        }
        case '/integrations/verify':
          return json(res, 200, { calls: tailJsonl<Record<string, unknown>>(files.rpc(), 20).reverse() });
        default:
          return json(res, 404, { error: 'not found', endpoints: ['/events', '/api/rounds', '/api/score', '/api/health', '/api/notes', '/rounds.csv', '/integrations/verify'] });
      }
    } catch (e) {
      // Log the detail server-side; never echo error text or stack to the client (CodeQL js/stack-trace-exposure).
      console.error(`[server] ${req.method} ${req.url} failed:`, e);
      return json(res, 500, { error: 'internal error' });
    }
  });
  server.on('close', () => {
    clearInterval(poll);
    clearInterval(hb);
    for (const c of clients) c.end();
  });
  return server;
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { anonymousMemwal } = await import('./memory/memwal.js');
  const anon = anonymousMemwal();
  const port = Number(process.env.PORT ?? 8787);
  makeServer({ relayerHealth: () => anon.health() }).listen(port, '127.0.0.1', () => console.log(`rimba server on http://127.0.0.1:${port}`));
}
