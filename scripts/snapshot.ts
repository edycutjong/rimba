// pnpm snapshot [--max 400]
// Freezes the logger's current rounds into the static replay data the Vercel reef page plays back:
//   web/public/data/snapshot.json   rounds (call joined with resolution), the notes they cite, scorecards, run health
//   web/public/data/rounds.csv      the same CSV `pnpm score --write` emits (every scorecard number links here)
// Only the current question's resolved rounds are included; void and still-open rounds are not.
// The page labels the data honestly: rows carry network_source / memory_source and development rows are
// never presented as the headline.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinRounds, roundsCsv, scorecard } from '../src/score.js';
import { files, loadConfig, readJson, readJsonl, ROOT, type CallRow, type ResolutionRow } from '../src/store.js';
import type { NoteRecord } from '../src/notes.js';

const argv = process.argv.slice(2);
const maxArg = argv.indexOf('--max');
const MAX = maxArg >= 0 ? Math.max(10, Number(argv[maxArg + 1]) || 400) : 400;

const cfg = loadConfig();
const calls = readJsonl<CallRow>(files.calls());
const resolutions = readJsonl<ResolutionRow>(files.resolutions());
const notes = readJsonl<NoteRecord>(files.notes());

// catalogue number of a round = its 1-based position in the whole calls file (stable across snapshots)
const catalogue = new Map(calls.map((c, i) => [c.round_id, i + 1]));
const sameQ = calls.filter((c) => c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule);
const { rounds, void: voided, pending } = joinRounds(sameQ, resolutions);
const resByRound = new Map(resolutions.map((r) => [r.round_id, r]));

// only full-loop rows (naturalist wired: species + memory backend recorded) are replayed; scorecards still count what they count
const replayable = rounds.filter((r) => r.species && r.memory_source);
const picked = replayable.slice(-MAX).map((r) => {
  const res = resByRound.get(r.round_id)!;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { recall_pairs: _rp, brier_memory: _bm, brier_base: _bb, brier_freq: _bf, resolved_at: _ra, resolving_checkpoint_seq: _rc, resolving_digest: _rd, outcome: _o, ...call } = r;
  return {
    ...call,
    n: catalogue.get(r.round_id) ?? 0,
    resolution: {
      outcome: res.outcome, reason: res.reason, resolved_at: res.resolved_at, resolving_checkpoint_seq: res.resolving_checkpoint_seq,
      resolving_digest: res.resolving_digest, resolving_ts: res.resolving_ts, network_source: res.network_source,
    },
  };
});

const cited = new Set(picked.flatMap((r) => r.cited_note_ids));
const noteMap: Record<string, { text: string; species: string; created_at: string; backend: string; kind: string; blob_id?: string }> = {};
for (const n of notes) {
  if (!n.ok || !cited.has(n.specimen_id)) continue;
  noteMap[n.specimen_id] = { text: n.text, species: n.species, created_at: n.created_at, backend: n.backend, kind: n.kind, ...(n.blob_id ? { blob_id: n.blob_id } : {}) };
}

const health = readJson<Record<string, unknown>>(files.health()) ?? {};
const snapshot = {
  generated_at: new Date().toISOString(),
  question: { horizon_min: cfg.horizon_min, move_rule: cfg.move_rule },
  max_distance: cfg.naturalist?.max_distance ?? null,
  score: {
    headline: scorecard(calls, resolutions, cfg, { network_source: 'tatum', memory_source: 'walrus' }),
    development: scorecard(calls, resolutions, cfg, { network_source: 'public-dev', memory_source: 'local-dev' }),
    all_rows: scorecard(calls, resolutions, cfg),
  },
  counts: { rounds_in_snapshot: picked.length, resolved_total: rounds.length, void: voided, pending, excluded_other_question: calls.length - sameQ.length },
  health: {
    source: health.source ?? null,
    memory: health.memory ?? null,
    notes_total: health.notes_total ?? null,
    last_seq: health.last_seq ?? null,
    at: health.at ?? null,
  },
  rounds: picked,
  notes: noteMap,
};

const out = join(ROOT, 'web', 'public', 'data');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'snapshot.json'), JSON.stringify(snapshot) + '\n');
writeFileSync(join(out, 'rounds.csv'), roundsCsv(rounds));
console.error(`snapshot: ${picked.length} rounds (of ${rounds.length} resolved, ${replayable.length} full-loop), ${Object.keys(noteMap).length} cited notes → web/public/data/{snapshot.json,rounds.csv}`);
