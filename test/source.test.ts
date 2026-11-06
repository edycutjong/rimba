import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake gRPC layer: every subscribe returns a controllable stream; nothing touches the network.
const streams: (EventEmitter & { cancel: () => void; ep: string })[] = [];
vi.mock('../src/stream/client.js', () => ({
  makeClients: (ep: { host: string; source: string }) => ({ endpoint: ep, close: () => {} }),
  subscribeCheckpoints: (c: { endpoint: { source: string } }) => {
    const s = Object.assign(new EventEmitter(), { cancel: vi.fn(), ep: c.endpoint.source });
    streams.push(s);
    return s;
  },
  getCheckpoint: async () => { throw new Error('no backfill in this test'); },
}));

const { CheckpointSource } = await import('../src/stream/source.js');
const PUBLIC = { host: 'public', source: 'public-dev' as const };
const TATUM = { host: 'tatum', source: 'tatum' as const, apiKey: 'k' };
const cp = (seq: number) => ({ checkpoint: { sequence_number: String(seq), digest: `CP${seq}`, summary: { timestamp: { seconds: '1', nanos: 0 } } } });

afterEach(() => {
  streams.length = 0;
  vi.useRealTimers();
});

describe('CheckpointSource', () => {
  it('a checkpoint received before an endpoint switch keeps the source that sent it', async () => {
    const got: [string, string][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = new CheckpointSource(PUBLIC, {
      onCheckpoint: async (c, source) => {
        got.push([c.sequence_number!, source]);
        if (c.sequence_number === '1') await gate; // hold the queue while the switch happens
      },
    });
    src.start();
    streams[0]!.emit('data', cp(1));
    streams[0]!.emit('data', cp(2)); // queued behind 1, received from the public node
    await Promise.resolve();
    src.switchEndpoint(TATUM);
    streams[1]!.emit('data', cp(3));
    release();
    await new Promise((r) => setTimeout(r, 0));
    src.stop();
    expect(got).toEqual([['1', 'public-dev'], ['2', 'public-dev'], ['3', 'tatum']]);
  });

  it('a reconnect timer from a superseded stream never opens a second subscription', async () => {
    vi.useFakeTimers();
    const src = new CheckpointSource(PUBLIC, { onCheckpoint: () => {} });
    src.start();
    streams[0]!.emit('error', Object.assign(new Error('unavailable'), { code: 14 })); // schedules a reconnect in 1 s
    src.switchEndpoint(TATUM); // opens stream 1 right away
    await vi.advanceTimersByTimeAsync(5000);
    src.stop();
    expect(streams.map((s) => s.ep)).toEqual(['public-dev', 'tatum']);
  });
});
