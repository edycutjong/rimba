import * as grpc from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/stream/client.js';

const err = (code: number, message: string) => Object.assign(new Error(message), { code });
const noSleep = async () => {};

describe('withRetry (gateway rate limits)', () => {
  it('retries UNAVAILABLE carrying HTTP 429, then returns the value', async () => {
    let n = 0;
    const v = await withRetry(async () => {
      n++;
      if (n < 3) throw err(grpc.status.UNAVAILABLE, '14 UNAVAILABLE: Received HTTP status code 429');
      return 'tx';
    }, 5, 1, noSleep);
    expect(v).toBe('tx');
    expect(n).toBe(3);
  });

  it('retries RESOURCE_EXHAUSTED and gives up after the attempt cap', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw err(grpc.status.RESOURCE_EXHAUSTED, 'quota'); }, 3, 1, noSleep)).rejects.toThrow('quota');
    expect(n).toBe(3);
  });

  it('does not retry other errors (a missing tx is a real answer)', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw err(grpc.status.NOT_FOUND, 'not found'); }, 5, 1, noSleep)).rejects.toThrow('not found');
    expect(n).toBe(1);
  });

  it('does not retry a plain UNAVAILABLE without a rate-limit signal', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw err(grpc.status.UNAVAILABLE, 'connection reset'); }, 5, 1, noSleep)).rejects.toThrow('reset');
    expect(n).toBe(1);
  });
});
