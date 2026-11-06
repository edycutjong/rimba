// Taxon: deterministic trait buckets → one species sentence. Embedding models are poor at numeric distance,
// so numbers are bucketed into words BEFORE anything is embedded: two "huge round SUI" sightings land
// next to each other whatever the exact amounts were. No LLM, no randomness — same input, same words.
//
// The sentence is also the note's body in Walrus Memory, and `parseSpecies` reads it back into slots
// (used by the local-dev recall stand-in and by tests), so the sentence format is the contract.

export interface SightingTraits {
  coinType: string;
  amountRaw: bigint;
  /** Per-coin sighting threshold in base units (from config). */
  thresholdRaw: bigint;
  recipientsCount: number;
  timestampMs: number;
  /** Has this sender sent to this recipient in an earlier sighting? */
  repeatCounterparty: boolean;
  /** ms since the sender's previous transfer seen on the stream; null if none seen. */
  lastMoveAgoMs: number | null;
  /** Earlier sightings of this sender (rounds opened before this one). */
  priorSightings: number;
}

const DECIMALS: Record<string, number> = { SUI: 9, USDC: 6, USDT: 6, WAL: 9, DEEP: 6 };

export function coinSymbol(coinType: string): string {
  const parts = coinType.split('::');
  return (parts[parts.length - 1] ?? coinType).toUpperCase();
}

/** Ordinal slots — order inside each list is the distance scale. */
export const SLOTS = {
  size: ['large', 'very large', 'huge', 'colossal'],
  shape: ['odd', 'round'],
  recipients: ['single recipient', 'a few recipients', 'many recipients'],
  time: ['night UTC', 'morning UTC', 'afternoon UTC', 'evening UTC'],
  counterparty: ['new counterparty', 'repeat counterparty'],
  pace: ['moved within 2 min', 'moved within 15 min', 'moved within the hour', 'quiet for an hour+', 'no earlier move seen'],
  familiarity: ['first sighting', 'seen a few times', 'regular'],
} as const;
export type SlotName = keyof typeof SLOTS;
export type Species = { coin: string } & { [K in SlotName]: (typeof SLOTS)[K][number] };

export function sizeBucket(amountRaw: bigint, thresholdRaw: bigint): Species['size'] {
  if (thresholdRaw <= 0n) return 'large';
  const ratioX10 = (amountRaw * 10n) / thresholdRaw;
  if (ratioX10 < 20n) return 'large';
  if (ratioX10 < 50n) return 'very large';
  if (ratioX10 < 200n) return 'huge';
  return 'colossal';
}

/** "round" = a whole number of coins that is a multiple of 10 (people type these; bots rarely do). */
export function shapeBucket(amountRaw: bigint, coinType: string): Species['shape'] {
  const dec = DECIMALS[coinSymbol(coinType)] ?? 9;
  const unit = 10n ** BigInt(dec);
  return amountRaw % (unit * 10n) === 0n ? 'round' : 'odd';
}

export function timeBucket(tsMs: number): Species['time'] {
  const h = new Date(tsMs).getUTCHours();
  return SLOTS.time[Math.floor(h / 6)]!;
}

export function paceBucket(lastMoveAgoMs: number | null): Species['pace'] {
  if (lastMoveAgoMs === null) return 'no earlier move seen';
  const m = lastMoveAgoMs / 60_000;
  if (m < 2) return 'moved within 2 min';
  if (m < 15) return 'moved within 15 min';
  if (m < 60) return 'moved within the hour';
  return 'quiet for an hour+';
}

export function classify(t: SightingTraits): Species {
  return {
    coin: coinSymbol(t.coinType),
    size: sizeBucket(t.amountRaw, t.thresholdRaw),
    shape: shapeBucket(t.amountRaw, t.coinType),
    recipients: t.recipientsCount <= 1 ? 'single recipient' : t.recipientsCount <= 4 ? 'a few recipients' : 'many recipients',
    time: timeBucket(t.timestampMs),
    counterparty: t.repeatCounterparty ? 'repeat counterparty' : 'new counterparty',
    pace: paceBucket(t.lastMoveAgoMs),
    familiarity: t.priorSightings === 0 ? 'first sighting' : t.priorSightings <= 3 ? 'seen a few times' : 'regular',
  };
}

/** e.g. "huge round SUI transfer, single recipient, night UTC, new counterparty, moved within 2 min, first sighting" */
export function sentence(s: Species): string {
  return `${s.size} ${s.shape} ${s.coin} transfer, ${s.recipients}, ${s.time}, ${s.counterparty}, ${s.pace}, ${s.familiarity}`;
}

export function speciesSentence(t: SightingTraits): string {
  return sentence(classify(t));
}

const SENTENCE_RE = /^(large|very large|huge|colossal) (odd|round) ([A-Z0-9_]+) transfer, ([^,]+), ([^,]+), ([^,]+), ([^,]+), ([^,]+)$/;

/** Inverse of `sentence`. Returns null for anything that is not a species sentence. */
export function parseSpecies(text: string): Species | null {
  const m = SENTENCE_RE.exec(text.trim());
  if (!m) return null;
  const s = {
    size: m[1], shape: m[2], coin: m[3], recipients: m[4], time: m[5], counterparty: m[6], pace: m[7], familiarity: m[8],
  } as Species;
  for (const k of Object.keys(SLOTS) as SlotName[]) {
    if (!(SLOTS[k] as readonly string[]).includes(s[k])) return null;
  }
  return s;
}

// Slot weights for the local-dev distance (sum = 1). Behavioural slots weigh most: whether a wallet
// just moved says more about whether it moves again than the time of day does.
const WEIGHTS: Record<SlotName | 'coin', number> = {
  pace: 0.3, familiarity: 0.15, counterparty: 0.12, size: 0.12, coin: 0.1, recipients: 0.08, shape: 0.07, time: 0.06,
};
const ORDINAL: ReadonlySet<SlotName> = new Set(['size', 'pace', 'familiarity']);

/** Distance in [0, 1] between two species: 0 = identical. Ordinal slots give partial credit. */
export function speciesDistance(a: Species, b: Species): number {
  let d = a.coin === b.coin ? 0 : WEIGHTS.coin;
  for (const k of Object.keys(SLOTS) as SlotName[]) {
    if (a[k] === b[k]) continue;
    const list = SLOTS[k] as readonly string[];
    if (ORDINAL.has(k)) {
      const gap = Math.abs(list.indexOf(a[k]) - list.indexOf(b[k])) / (list.length - 1);
      d += WEIGHTS[k] * gap;
    } else d += WEIGHTS[k];
  }
  return Number(d.toFixed(6));
}
