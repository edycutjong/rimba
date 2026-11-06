import { describe, expect, it } from 'vitest';
import { classify, parseSpecies, sentence, shapeBucket, sizeBucket, speciesDistance, speciesSentence, type SightingTraits } from '../src/taxon.js';

const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const base: SightingTraits = {
  coinType: SUI, amountRaw: 5_000n * 10n ** 9n, thresholdRaw: 282_910_000_000n, recipientsCount: 1,
  timestampMs: Date.parse('2026-11-07T02:00:00Z'), repeatCounterparty: false, lastMoveAgoMs: 60_000, priorSightings: 0,
};

describe('species', () => {
  it('is deterministic: same traits, same sentence', () => {
    expect(speciesSentence(base)).toBe(speciesSentence({ ...base }));
    expect(speciesSentence(base)).toBe('huge round SUI transfer, single recipient, night UTC, new counterparty, moved within 2 min, first sighting');
  });

  it('buckets size by multiple of the coin threshold', () => {
    expect(sizeBucket(100n, 100n)).toBe('large');
    expect(sizeBucket(199n, 100n)).toBe('large');
    expect(sizeBucket(200n, 100n)).toBe('very large');
    expect(sizeBucket(500n, 100n)).toBe('huge');
    expect(sizeBucket(2000n, 100n)).toBe('colossal');
  });

  it('calls whole multiples of 10 coins round, using the coin decimals', () => {
    expect(shapeBucket(300n * 10n ** 9n, SUI)).toBe('round');
    expect(shapeBucket(300_000_000_001n, SUI)).toBe('odd');
    expect(shapeBucket(70n * 10n ** 6n, USDC)).toBe('round');
    expect(shapeBucket(75n * 10n ** 6n, USDC)).toBe('odd');
  });

  it('buckets pace, familiarity, time and recipients', () => {
    const s = classify({ ...base, lastMoveAgoMs: null, priorSightings: 5, recipientsCount: 3, timestampMs: Date.parse('2026-11-07T13:00:00Z') });
    expect(s).toMatchObject({ pace: 'no earlier move seen', familiarity: 'regular', recipients: 'a few recipients', time: 'afternoon UTC' });
    expect(classify({ ...base, lastMoveAgoMs: 10 * 60_000 }).pace).toBe('moved within 15 min');
    expect(classify({ ...base, lastMoveAgoMs: 2 * 3600_000 }).pace).toBe('quiet for an hour+');
  });

  it('round-trips sentence ⇄ parse and rejects non-species text', () => {
    const s = classify(base);
    expect(parseSpecies(sentence(s))).toEqual(s);
    expect(parseSpecies('favourite pizza toppings in Naples')).toBeNull();
    expect(parseSpecies('huge round SUI transfer, single recipient, night UTC, new counterparty, sometimes, first sighting')).toBeNull();
  });

  it('distance: 0 for identical, grows with differences, ordinal slots give partial credit', () => {
    const a = classify(base);
    expect(speciesDistance(a, a)).toBe(0);
    const near = { ...a, pace: 'moved within 15 min' as const };
    const far = { ...a, pace: 'no earlier move seen' as const };
    expect(speciesDistance(a, near)).toBeGreaterThan(0);
    expect(speciesDistance(a, far)).toBeGreaterThan(speciesDistance(a, near));
    expect(speciesDistance(a, { ...a, coin: 'USDC' })).toBeCloseTo(0.1);
    expect(speciesDistance(a, far)).toBe(speciesDistance(far, a));
  });
});
