import { describe, expect, it } from 'vitest';
import { drifted, NoteWriter, outcomeNote, parseNote, supersedeNote, type NoteRecord } from '../src/notes.js';
import { LocalNoteMemory, RateLimitedError, type NoteMemory } from '../src/memory/backend.js';

const SP = 'huge round SUI transfer, single recipient, night UTC, new counterparty, moved within 2 min, first sighting';

describe('note text', () => {
  it('formats and parses an outcome note', () => {
    const t = outcomeNote(412, SP, 15, 1, '342417305');
    expect(t).toBe(`Specimen No.0412 · ${SP} · moved again within 15 min: YES (checkpoint 342417305)`);
    expect(parseNote(t)).toMatchObject({ specimenId: 'No.0412', horizonMin: 15, yes: 1, n: 1, supersedes: [], checkpoint: '342417305', speciesText: SP });
    expect(parseNote(outcomeNote(7, SP, 15, 0, '1'))).toMatchObject({ yes: 0, n: 1 });
    // counts from a remote memory must be small safe integers
    expect(parseNote(supersedeNote(8, SP, 15, 3, 5, ['No.0001'], '1').replace(/3 of 5/, '1 of 99999999999999999999').replace('last 5', 'last 99999999999999999999'))).toBeNull();
    expect(parseNote(supersedeNote(8, SP, 15, 3, 5, ['No.0001'], '1'))).toMatchObject({ yes: 3, n: 5 });
  });

  it('formats and parses a superseding tally note', () => {
    const t = supersedeNote(450, SP, 15, 4, 5, ['No.0398', 'No.0401'], '342419000');
    expect(parseNote(t)).toMatchObject({ specimenId: 'No.0450', yes: 4, n: 5, supersedes: ['No.0398', 'No.0401'], horizonMin: 15 });
  });

  it('rejects malformed notes and impossible tallies', () => {
    expect(parseNote('hello')).toBeNull();
    expect(parseNote(`Specimen No.1 · ${SP} · last 5 sightings moved again within 15 min: 6 of 5 YES`)).toBeNull();
  });

  it('notes carry no addresses (public, bucketed facts only)', () => {
    expect(outcomeNote(1, SP, 15, 1, '9')).not.toMatch(/0x[0-9a-f]{6,}/);
  });
});

describe('drift rule', () => {
  it('fires only when the last 5 outcomes disagree with the cited vote', () => {
    expect(drifted([1, 1, 1, 1], 0.2)).toBeNull(); // fewer than 5
    expect(drifted([1, 1, 1, 0, 1], 0.2)).toEqual({ yes: 4, n: 5 });
    expect(drifted([1, 1, 1, 0, 1], 0.8)).toBeNull();
    expect(drifted([0, 0, 0, 0, 0, 0, 1], 0.9)).toEqual({ yes: 1, n: 5 });
  });
});

describe('NoteWriter', () => {
  const t0 = Date.parse('2026-11-07T12:00:00Z'); // half the UTC day elapsed
  const mk = (mem: NoteMemory, now: () => number, opts = {}) => {
    const out: NoteRecord[] = [];
    const w = new NoteWriter(() => mem, (r) => out.push(r), {}, { dailyBudget: 400, now, ...opts });
    return { w, out };
  };

  it('paces writes evenly across the UTC day plus a burst', () => {
    const { w } = mk(new LocalNoteMemory(), () => t0);
    expect(w.allowance(t0)).toBe(200 + 20);
    expect(w.allowance(Date.parse('2026-11-07T00:00:00Z'))).toBe(20);
  });

  it('writes batches of ≤20, highest priority first, assigning specimen numbers', async () => {
    const mem = new LocalNoteMemory([], () => t0);
    const { w, out } = mk(mem, () => t0);
    for (let i = 0; i < 25; i++) w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, String(i)), SP, `R${i}`, 'outcome', i === 24 ? 3 : 1);
    await w.flush();
    expect(out).toHaveLength(20);
    expect(out[0]!.round_id).toBe('R24');
    expect(out[0]!.text.startsWith('Specimen No.0025')).toBe(true);
    expect(mem.size).toBe(20);
    expect(w.queued).toBe(5);
    expect(w.state.written_today).toBe(20);
  });

  it('on 429: re-queues, honours Retry-After, cuts the day budget by 25%', async () => {
    let now = t0;
    const mem: NoteMemory = { kind: 'walrus', recall: async () => [], remember: async () => { throw new RateLimitedError(90); } };
    const { w } = mk(mem, () => now);
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R1', 'outcome', 1);
    await expect(w.flush()).rejects.toBeInstanceOf(RateLimitedError);
    expect(w.queued).toBe(1);
    expect(w.state.daily_budget).toBe(300);
    expect(w.state.next_write_at).toBe(t0 + 90_000);
    now = t0 + 10_000;
    expect(await w.flush()).toEqual([]); // still backing off
  });

  it('resets the budget at the UTC day boundary', () => {
    let now = t0;
    const { w } = mk(new LocalNoteMemory(), () => now);
    w.state.written_today = 220;
    w.state.daily_budget = 300;
    expect(w.allowance(now)).toBe(0);
    now = Date.parse('2026-11-08T06:00:00Z');
    expect(w.allowance(now)).toBe(100 + 20);
    expect(w.state.daily_budget).toBe(400);
  });

  it('drops the lowest-priority oldest note when the queue is full', () => {
    const { w } = mk(new LocalNoteMemory(), () => t0, { queueCap: 2 });
    w.enqueue(() => 'a', SP, 'A', 'outcome', 1);
    w.enqueue(() => 'b', SP, 'B', 'outcome', 0);
    w.enqueue(() => 'c', SP, 'C', 'outcome', 2);
    expect(w.queued).toBe(2);
  });
});

describe('NoteWriter durability', () => {
  const t0 = Date.parse('2026-11-07T12:00:00Z');
  it('reconciles specimen numbers and today\'s spend from the notes log after a restart', () => {
    const w = new NoteWriter(() => new LocalNoteMemory(), () => {}, { next_specimen: 3, day: '2026-11-07', written_today: 1 }, { now: () => t0 });
    w.reconcile([
      { specimen_id: 'No.0007', created_at: '2026-11-07T10:00:00Z', backend: 'local-dev' },
      { specimen_id: 'No.0008', created_at: '2026-11-07T11:00:00Z', backend: 'local-dev' },
      { specimen_id: 'No.0009', created_at: '2026-11-07T11:30:00Z', backend: 'walrus' },
      { specimen_id: 'No.0002', created_at: '2026-11-06T23:00:00Z', backend: 'local-dev' },
    ]);
    expect(w.state.next_specimen).toBe(10);
    expect(w.state.written_today).toBe(2); // only the backend whose spend is being measured
  });

  it('a switch to Walrus starts its own spend: the stand-in\'s day (and its 429 cuts) never block Walrus writes', async () => {
    let mem: NoteMemory = new LocalNoteMemory([], () => t0);
    const recs: NoteRecord[] = [];
    const w = new NoteWriter(() => mem, (r) => recs.push(r), { day: '2026-11-07', written_today: 400, daily_budget: 100, next_write_at: t0 + 3600_000 }, { now: () => t0 });
    w.reconcile([{ specimen_id: 'No.0001', created_at: '2026-11-07T01:00:00Z', backend: 'walrus' }]);
    expect(w.allowance()).toBe(0);
    mem = { kind: 'walrus', recall: async () => [], remember: async (t) => t.map((text) => ({ text, ok: true, created_at: new Date(t0).toISOString() })) };
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R', 'outcome', 1);
    await w.flush();
    expect(w.state).toMatchObject({ backend: 'walrus', daily_budget: 400, written_today: 2 });
    expect(recs.map((r) => [r.backend, r.ok])).toEqual([['walrus', true]]);
  });

  it('clears the queue on a memory switch', () => {
    const w = new NoteWriter(() => new LocalNoteMemory(), () => {}, {}, { now: () => t0 });
    w.enqueue(() => 'a', SP, 'A', 'outcome', 1);
    expect(w.clearQueue()).toBe(1);
    expect(w.queued).toBe(0);
  });

  it('persists the pending queue through a snapshot', () => {
    const a = new NoteWriter(() => new LocalNoteMemory(), () => {}, {}, { now: () => t0 });
    a.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R1', 'outcome', 1);
    const b = new NoteWriter(() => new LocalNoteMemory(), () => {}, JSON.parse(JSON.stringify(a.snapshot())), { now: () => t0 });
    expect(b.queued).toBe(1);
    expect(b.state.next_specimen).toBe(2);
  });

  it('records a failure for every note the backend did not confirm, and an observer error does not re-queue', async () => {
    const mem: NoteMemory = { kind: 'walrus', recall: async () => [], remember: async (texts) => [{ text: texts[0]!, ok: true, created_at: 'x' }] };
    const out: NoteRecord[] = [];
    const w = new NoteWriter(() => mem, (r) => { out.push(r); throw new Error('disk full'); }, {}, { now: () => t0 });
    w.enqueue(() => 'a', SP, 'A', 'outcome', 1);
    w.enqueue(() => 'b', SP, 'B', 'outcome', 1);
    const recs = await w.flush();
    expect(recs.map((r) => r.ok)).toEqual([true, false]);
    expect(out).toHaveLength(2);
    expect(w.queued).toBe(0);
  });
});

describe('NoteWriter — accepted jobs and backend switches', () => {
  const T = Date.parse('2026-11-07T12:00:00Z');
  it('keeps an accepted-but-unconfirmed write awaiting, re-polls it by job id, and never resubmits it', async () => {
    let now = T;
    const sent: string[][] = [];
    let confirmDone = false;
    const mem: NoteMemory = {
      kind: 'walrus',
      recall: async () => [],
      remember: async (texts) => { sent.push(texts); return texts.map((text, i) => ({ text, ok: i === 1, pending: i === 0, job_id: `J${i}`, created_at: new Date(now).toISOString() })); },
      confirm: async (ids) => ids.map((id) => ({ text: '', ok: confirmDone, pending: !confirmDone, job_id: id, blob_id: confirmDone ? 'B0' : undefined, created_at: new Date(now).toISOString() })),
    };
    const recs: NoteRecord[] = [];
    const w = new NoteWriter(() => mem, (r) => recs.push(r), {}, { now: () => now });
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R0', 'outcome', 1);
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 0, '2'), SP, 'R1', 'outcome', 1);
    await w.flush();
    expect(recs.map((r) => [r.round_id, r.ok])).toEqual([['R1', true]]);
    expect(w.awaitingCount).toBe(1);
    now += 60_000;
    await w.flush(); // still running
    expect(w.awaitingCount).toBe(1);
    confirmDone = true;
    now += 60_000;
    await w.flush();
    expect(recs.map((r) => [r.round_id, r.ok, r.blob_id ?? null])).toEqual([['R1', true, null], ['R0', true, 'B0']]);
    expect(recs[1]!.submitted_at).toBe(new Date(T).toISOString());
    expect(sent).toHaveLength(1); // the accepted note was never sent a second time
    expect(w.snapshot().awaiting).toEqual([]);
  });

  it('drops notes queued under another backend, on a hot switch or after a cold restart', async () => {
    let mem: NoteMemory = new LocalNoteMemory([], () => T);
    const recs: NoteRecord[] = [];
    const w = new NoteWriter(() => mem, (r) => recs.push(r), {}, { now: () => T + 3600_000 });
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R0', 'outcome', 1);
    const walrus: NoteMemory = { kind: 'walrus', recall: async () => [], remember: async (t) => t.map((text) => ({ text, ok: true, created_at: 'x' })) };
    // cold restart: the persisted queue has no backend tag (pre-tag state) → treated as local-dev
    const cold = new NoteWriter(() => walrus, (r) => recs.push(r), { queue: [{ ...w.snapshot().queue![0]!, backend: undefined }] }, { now: () => T + 3600_000 });
    await cold.flush();
    expect(cold.queued).toBe(0);
    expect(cold.droppedOtherBackend).toBe(1);
    mem = walrus; // hot switch
    await w.flush();
    expect(w.droppedOtherBackend).toBe(1);
    expect(recs).toHaveLength(0);
  });
});

describe('NoteWriter — crash windows (a2a r02)', () => {
  const T = Date.parse('2026-11-07T12:00:00Z');
  it('a two-phase backend has the accepted job ids in saved state before any polling starts', async () => {
    let seen: ReturnType<NoteWriter['snapshot']> | null = null;
    const mem: NoteMemory = {
      kind: 'walrus', recall: async () => [], remember: async () => { throw new Error('two-phase only'); },
      submit: async (texts) => texts.map((_, i) => `J${i}`),
      confirm: async (ids) => ids.map((id) => ({ text: '', ok: true, job_id: id, created_at: new Date(T).toISOString() })),
    };
    const recs: NoteRecord[] = [];
    const w: NoteWriter = new NoteWriter(() => mem, (r) => recs.push(r), {}, { now: () => T, onAccepted: () => { seen = w.snapshot(); } });
    w.enqueue((sp) => outcomeNote(sp, SP, 15, 1, '1'), SP, 'R0', 'outcome', 1);
    await w.flush();
    expect(seen!.queue).toEqual([]);
    expect(seen!.awaiting!.map((a) => a.job_id)).toEqual(['J0']);
    expect(recs.map((r) => [r.round_id, r.ok, r.job_id])).toEqual([['R0', true, 'J0']]);
  });

  it('a note logged after the last state save is not resubmitted after a crash', () => {
    const w = new NoteWriter(() => new LocalNoteMemory(), () => {}, { day: '2026-11-07', queue: [{ specimen: 5, text: 'x', species: SP, roundId: 'R', kind: 'outcome', priority: 1, queuedAt: T }] }, { now: () => T });
    w.reconcile([{ specimen_id: 'No.0005', created_at: '2026-11-07T11:59:00Z', backend: 'local-dev' }]);
    expect(w.queued).toBe(0);
    expect(w.state.next_specimen).toBe(6);
  });
});
