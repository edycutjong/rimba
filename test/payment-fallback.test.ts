import { describe, expect, it, vi } from 'vitest';
import { withPaymentFallback, type SuiClients } from '../src/stream/client.js';

const fake = (source: 'tatum' | 'public-dev'): SuiClients => ({ endpoint: { host: source, source }, subscription: {} as never, ledger: {} as never, close: vi.fn() });
const e402 = () => Object.assign(new Error('2 UNKNOWN: Received HTTP status code 402'), { code: 2 });

describe('withPaymentFallback (verify path)', () => {
  it('on a Tatum 402 retries the call on the public node, stays there, and reports the switch once', async () => {
    const tatum = fake('tatum');
    const pub = fake('public-dev');
    const switched = vi.fn();
    const fo = withPaymentFallback(tatum, () => pub, switched);
    const served: string[] = [];
    const call = async (c: SuiClients) => {
      if (c.endpoint.source === 'tatum') throw e402();
      served.push(c.endpoint.source);
      return 'ok';
    };
    expect(await fo.run(call)).toBe('ok');
    expect(await fo.run(call)).toBe('ok');
    expect(served).toEqual(['public-dev', 'public-dev']);
    expect(switched).toHaveBeenCalledTimes(1);
    expect(tatum.close).toHaveBeenCalledTimes(1);
    expect(fo.clients).toBe(pub);
  });

  it('other errors are thrown unchanged and do not switch', async () => {
    const fo = withPaymentFallback(fake('tatum'), () => fake('public-dev'));
    await expect(fo.run(async () => { throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 }); })).rejects.toThrow('NOT_FOUND');
    expect(fo.clients.endpoint.source).toBe('tatum');
  });

  it('a 402 from the public node itself is not swallowed', async () => {
    const fo = withPaymentFallback(fake('public-dev'), () => fake('public-dev'));
    await expect(fo.run(async () => { throw e402(); })).rejects.toThrow('402');
  });
});
