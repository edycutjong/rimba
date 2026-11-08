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
  getCheckpoint: async (c: { endpoint: { source: string } }, seq: string) => cpHook(c.endpoint.source, seq),
}));
let cpHook: (source: string, seq: string) => Promise<unknown> = async () => { throw new Error('no backfill in this test'); };

const { CheckpointSource } = await import('../src/stream/source.js');
const PUBLIC = { host: 'public', source: 'public-dev' as const };
const TATUM = { host: 'tatum', source: 'tatum' as const, apiKey: 'k' };
const cp = (seq: number) => ({ checkpoint: { sequence_number: String(seq), digest: `CP${seq}`, summary: { timestamp: { seconds: '1', nanos: 0 } } } });

afterEach(() => {
  streams.length = 0;
  cpHook = async () => { throw new Error('no backfill in this test'); };
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

describe('CheckpointSource — HTTP 402 from Tatum', () => {
  it('a 402 on the Tatum stream hands over to the handler and never reconnects to Tatum by itself', async () => {
    vi.useFakeTimers();
    const why: string[] = [];
    const src: InstanceType<typeof CheckpointSource> = new CheckpointSource(TATUM, {
      onCheckpoint: () => {},
      onPaymentRequired: (source, where) => {
        why.push(`${source}:${where}`);
        src.switchEndpoint(PUBLIC);
        return true;
      },
    }, { idleMs: 10 * 60_000 }); // the silent fake public stream must not trip the idle watchdog
    src.start();
    streams[0]!.emit('error', Object.assign(new Error('2 UNKNOWN: Received HTTP status code 402'), { code: 2 }));
    await vi.advanceTimersByTimeAsync(60_000);
    src.stop();
    expect(why).toEqual(['tatum:SubscribeCheckpoints']);
    expect(streams.map((s) => s.ep)).toEqual(['tatum', 'public-dev']);
  });

  it('a 402 without a handler keeps the old reconnect behaviour; a non-402 error never calls the handler', async () => {
    vi.useFakeTimers();
    let called = 0;
    const src = new CheckpointSource(TATUM, { onCheckpoint: () => {}, onPaymentRequired: () => (called++, true) });
    src.start();
    streams[0]!.emit('error', Object.assign(new Error('14 UNAVAILABLE: Received HTTP status code 429'), { code: 14 }));
    await vi.advanceTimersByTimeAsync(1500);
    src.stop();
    expect(called).toBe(0);
    expect(streams.map((s) => s.ep)).toEqual(['tatum', 'tatum']);
  });

  it('counts every streamed message for the credit meter, tagged with its source', async () => {
    const seen: string[] = [];
    const src = new CheckpointSource(TATUM, { onCheckpoint: () => {}, onMessage: (s) => seen.push(s) });
    src.start();
    streams[0]!.emit('data', cp(1));
    streams[0]!.emit('data', {});
    src.stop();
    expect(seen).toEqual(['tatum', 'tatum']);
  });
});

describe('CheckpointSource — 402 during gap backfill', () => {
  it('a 402 on Tatum GetCheckpoint switches to the public node and the backfill finishes there', async () => {
    const got: [string, string][] = [];
    const calls: string[] = [];
    cpHook = async (source, seq) => {
      calls.push(`${source}:${seq}`);
      if (source === 'tatum') throw Object.assign(new Error('2 UNKNOWN: Received HTTP status code 402'), { code: 2 });
      return cp(Number(seq));
    };
    const src: InstanceType<typeof CheckpointSource> = new CheckpointSource(TATUM, {
      onCheckpoint: (c, source) => void got.push([c.sequence_number!, source]),
      onPaymentRequired: () => (src.switchEndpoint(PUBLIC), true),
    }, { resumeFromSeq: 1n });
    src.start();
    streams[0]!.emit('data', cp(4)); // 2..3 missing → backfill
    await new Promise((r) => setTimeout(r, 20));
    src.stop();
    expect(calls).toEqual(['tatum:2', 'public-dev:2', 'public-dev:3']);
    expect(got).toEqual([['2', 'public-dev'], ['3', 'public-dev'], ['4', 'tatum']]);
  });
});

describe('forced 402 end to end (source + governor, as wired in the logger)', () => {
  it('Tatum 402 → public at once → Tatum retried after 10 min → back on Tatum on the first message', async () => {
    const { TatumGovernor, DEFAULT_BUDGET } = await import('../src/stream/governor.js');
    vi.useFakeTimers({ now: Date.parse('2026-11-09T00:00:00Z') });
    const gov = new TatumGovernor(DEFAULT_BUDGET);
    const got: [string, string][] = [];
    const log: string[] = [];
    const src: InstanceType<typeof CheckpointSource> = new CheckpointSource(TATUM, {
      onCheckpoint: (c, source) => void got.push([c.sequence_number!, source]),
      onMessage: (s) => { if (s === 'tatum' && gov.onTatumOk(Date.now()) !== null) log.push('recovered'); },
      onPaymentRequired: () => { gov.onPaymentRequired(Date.now()); log.push('402'); src.switchEndpoint(PUBLIC); return true; },
    }, { idleMs: 60 * 60_000 });
    // the logger's 30 s governor tick
    const tick = setInterval(() => {
      const d = gov.decide(Date.now());
      if (d.source !== src.endpoint.source) src.switchEndpoint(d.source === 'tatum' ? TATUM : PUBLIC);
    }, 30_000);
    src.start();
    streams[0]!.emit('data', cp(1));
    streams[0]!.emit('error', Object.assign(new Error('2 UNKNOWN: Received HTTP status code 402'), { code: 2 }));
    expect(src.endpoint.source).toBe('public-dev');
    streams[1]!.emit('data', cp(2));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(src.endpoint.source).toBe('public-dev'); // no Tatum retry inside the 10-min back-off
    await vi.advanceTimersByTimeAsync(90_000);
    expect(src.endpoint.source).toBe('tatum'); // retried
    streams.at(-1)!.emit('data', cp(3));
    await vi.advanceTimersByTimeAsync(0);
    clearInterval(tick);
    src.stop();
    expect(log).toEqual(['402', 'recovered']);
    expect(got).toEqual([['1', 'tatum'], ['2', 'public-dev'], ['3', 'tatum']]);
    expect(streams.map((s) => s.ep)).toEqual(['tatum', 'public-dev', 'tatum']);
  });
});
