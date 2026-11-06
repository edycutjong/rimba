import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'rimba-srv-'));
process.env.RIMBA_DATA_DIR = dir;
const row = { round_id: 'R1', created_at: '2026-11-07T00:00:00Z', network_source: 'tatum', checkpoint_seq: '1', checkpoint_ts: Date.parse('2026-11-07T00:00:00Z') - 900, tx_digest: 'R1', sender: 'S', recipient: 'R', coin_type: 'SUI', amount_raw: '1', horizon_min: 15, move_rule: 'any_transfer', sender_seen_before: false, p_memory: 0.5, call: 'abstain', p_base: 0.5, p_freq: 0.5, cited_note_ids: [], cited_distances: [], memory_source: 'walrus' };
writeFileSync(join(dir, 'calls.jsonl'), JSON.stringify(row) + '\n');
writeFileSync(join(dir, 'rpc.jsonl'), JSON.stringify({ at: 1, method: 'GetCheckpoint', ms: 30, ok: true, source: 'tatum' }) + '\n');
writeFileSync(join(dir, 'health.json'), JSON.stringify({ pid: 1, lag_s: 1 }));

let base = '';
let close: () => void = () => {};
beforeAll(async () => {
  const { makeServer } = await import('../src/server.js');
  const s = makeServer({ pollMs: 50, relayerHealth: async () => ({ status: 'ok' }) });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => s.close();
});
afterAll(() => close());

describe('server', () => {
  it('serves rounds, score, health, notes and the sponsor-call view', async () => {
    const rounds = await (await fetch(`${base}/api/rounds`)).json();
    expect(rounds.total).toBe(1);
    expect(rounds.rounds[0]).toMatchObject({ round_id: 'R1', resolution: null });
    expect((await (await fetch(`${base}/api/rounds?neverSeen=1`)).json()).total).toBe(1);
    const score = await (await fetch(`${base}/api/score`)).json();
    expect(score.headline.counts.calls).toBe(1);
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health).toMatchObject({ logger: { pid: 1 }, walrus_relayer: { status: 'ok' } });
    expect((await (await fetch(`${base}/integrations/verify`)).json()).calls[0].method).toBe('GetCheckpoint');
    expect((await (await fetch(`${base}/api/notes`)).json()).notes).toEqual([]);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/rounds`, { method: 'POST' })).status).toBe(405);
  });

  it('streams rows appended after a client connects as SSE events', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    const dec = new TextDecoder();
    text += dec.decode((await reader.read()).value);
    expect(text).toContain('event: hello');
    appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ ...row, round_id: 'R2', tx_digest: 'R2' }) + '\n');
    const deadline = Date.now() + 3000;
    while (!text.includes('"R2"') && Date.now() < deadline) text += dec.decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain('event: call');
    expect(text).toContain('"R2"');
  });
});
