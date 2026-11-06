import { describe, expect, it } from 'vitest';
import { naturalistCall, vote, P_MAX, P_MIN } from '../src/naturalist.js';
import { outcomeNote, supersedeNote } from '../src/notes.js';
import { LocalNoteMemory, type NoteMemory, type RecalledNote } from '../src/memory/backend.js';

const SP = 'huge round SUI transfer, single recipient, night UTC, new counterparty, moved within 2 min, first sighting';
const T = Date.parse('2026-11-07T12:00:00Z');
const before = new Date(T - 60_000).toISOString();
const o = { maxDistance: 0.3, horizonMin: 15, callTimeMs: T };
const n = (sp: number, out: 0 | 1, distance: number, created_at = before): RecalledNote => ({ text: outcomeNote(sp, SP, 15, out, '1'), distance, created_at });

describe('vote', () => {
  it('abstains at the base rate when no note is within maxDistance', () => {
    const c = vote([n(1, 1, 0.3), n(2, 1, 0.5)], 0.46, o);
    expect(c).toMatchObject({ call: 'abstain', p: 0.46, cited: [], abstainReason: 'no-notes-within-distance' });
  });

  it('weights near notes more than far ones and cites them nearest-first', () => {
    const c = vote([n(1, 1, 0.01), n(2, 0, 0.25)], 0.5, o);
    expect(c.call).toBe('yes');
    expect(c.p).toBeGreaterThan(0.5);
    expect(c.cited.map((x) => x.id)).toEqual(['No.0001', 'No.0002']);
  });

  it('abstains on too little evidence (Σ w·n < minEvidence) but keeps the citations auditable', () => {
    // one note at distance 0.15 of maxDistance 0.3 → w = 0.5, Σ w·n = 0.5 < 2
    const thin = vote([n(1, 1, 0.15)], 0.46, { ...o, minEvidence: 2 });
    expect(thin).toMatchObject({ call: 'abstain', p: 0.46, abstainReason: 'too-little-evidence' });
    expect(thin.cited.map((x) => x.id)).toEqual(['No.0001']);
    // the same note with the rule off would have called YES
    expect(vote([n(1, 1, 0.15)], 0.46, o).call).toBe('yes');
    // three notes at distance 0 → Σ w·n = 3 ≥ 2 → a real call, same P as without the rule
    const enough = [n(1, 1, 0), n(2, 1, 0), n(3, 0, 0)];
    expect(vote(enough, 0.46, { ...o, minEvidence: 2 })).toMatchObject({ call: 'yes', p: vote(enough, 0.46, o).p });
  });

  it('clamps P(yes) to [0.05, 0.95]', () => {
    const many = Array.from({ length: 50 }, (_, i) => n(i + 1, 1, 0));
    expect(vote(many, 0.5, o).p).toBe(P_MAX);
    const none = Array.from({ length: 50 }, (_, i) => n(i + 1, 0, 0));
    expect(vote(none, 0.5, o).p).toBe(P_MIN);
  });

  it('I3 fail-closed: a recalled note with no creation time, or a non-finite distance, never votes', () => {
    const c = vote([{ text: outcomeNote(1, SP, 15, 1, '1'), distance: 0.01 }, n(2, 1, Number.NaN), n(3, 1, -0.1)], 0.46, o);
    expect(c).toMatchObject({ call: 'abstain', cited: [] });
  });

  it('I3: ignores notes written at or after the call', () => {
    const c = vote([n(1, 1, 0.01, new Date(T).toISOString()), n(2, 1, 0.01, new Date(T + 1).toISOString())], 0.46, o);
    expect(c.call).toBe('abstain');
  });

  it('ignores notes for a different horizon and notes superseded by a recalled note', () => {
    const other: RecalledNote = { text: outcomeNote(3, SP, 10, 1, '1'), distance: 0.01, created_at: before };
    expect(vote([other], 0.46, o).call).toBe('abstain');
    const sup: RecalledNote = { text: supersedeNote(9, SP, 15, 0, 5, ['No.0001'], '2'), distance: 0.02, created_at: before };
    const c = vote([n(1, 1, 0.01), sup], 0.5, o);
    expect(c.cited.map((x) => x.id)).toEqual(['No.0009']);
    expect(c.call).toBe('no');
  });
});

describe('naturalistCall', () => {
  it('recalls from memory and changes its call once notes exist (before/after)', async () => {
    const mem = new LocalNoteMemory();
    const first = await naturalistCall(mem, SP, 0.46, { ...o, maxDistance: 0.22 });
    expect(first.call).toBe('abstain');
    await mem.remember([1, 2, 3].map((i) => outcomeNote(i, SP, 15, 1, String(i))));
    const second = await naturalistCall(mem, SP, 0.46, { ...o, maxDistance: 0.22, callTimeMs: Date.now() + 1 });
    expect(second.call).toBe('yes');
    expect(second.cited).toHaveLength(3);
  });

  it('abstains (never throws) when memory is missing or recall fails', async () => {
    expect((await naturalistCall(null, SP, 0.4, o)).abstainReason).toBe('memory-unavailable');
    const broken: NoteMemory = { kind: 'walrus', recall: async () => { throw new Error('down'); }, remember: async () => [] };
    expect(await naturalistCall(broken, SP, 0.4, o)).toMatchObject({ call: 'abstain', p: 0.4, abstainReason: 'recall-error' });
  });
});

describe('calibration pairs', () => {
  it('logs near-misses from the widened recall without letting them vote', async () => {
    const far = 'huge round SUI transfer, single recipient, night UTC, new counterparty, no earlier move seen, regular';
    const mem = new LocalNoteMemory([{ text: outcomeNote(1, far, 15, 1, '1'), created_at: before }]);
    const r = await naturalistCall(mem, SP, 0.46, { ...o, maxDistance: 0.22, recallMaxDistance: 0.6 });
    expect(r.call).toBe('abstain');
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]![1]).toBeGreaterThan(0.22);
  });
});
