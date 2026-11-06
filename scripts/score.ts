// pnpm score [--json] [--write]
// Prints the Brier scorecard. The HEADLINE is rounds streamed through Tatum with memory on Walrus
// Memory; development rows (public-dev stream and/or local-dev memory) are shown separately and
// labelled — they never feed the headline. --write also materialises data/live/rounds.csv and
// writes evidence/score-<UTC date>.md (+ .json).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinRounds, renderScorecard, roundsCsv, scorecard } from '../src/score.js';
import { DATA_DIR, files, loadConfig, readJsonl, ROOT, type CallRow, type ResolutionRow } from '../src/store.js';

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const calls = readJsonl<CallRow>(files.calls());
const resolutions = readJsonl<ResolutionRow>(files.resolutions());

const headline = scorecard(calls, resolutions, cfg, { network_source: 'tatum', memory_source: 'walrus' });
const views = {
  headline,
  tatum_any_memory: scorecard(calls, resolutions, cfg, { network_source: 'tatum' }),
  dev_public_local: scorecard(calls, resolutions, cfg, { network_source: 'public-dev', memory_source: 'local-dev' }),
  all_rows: scorecard(calls, resolutions, cfg),
};

if (args.has('--json')) {
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), ...views }, null, 2));
} else {
  const md = [
    `# RIMBA scorecard — ${new Date().toISOString()}`,
    '',
    'Brier score: mean of (p − outcome)²; lower is better; always guessing 0.5 scores 0.25.',
    'Headline = rounds streamed through **Tatum Sui gRPC** with the naturalist recalling from **Walrus Memory**.',
    '',
    renderScorecard(views.headline, 'HEADLINE — Tatum stream × Walrus Memory'),
    renderScorecard(views.tatum_any_memory, 'Tatum stream, any memory backend'),
    renderScorecard(views.dev_public_local, 'DEVELOPMENT ONLY — public fullnode stream × local-dev memory stand-in (never a headline)'),
    renderScorecard(views.all_rows, 'All rows under the current question'),
  ].join('\n');
  console.log(md);
  if (args.has('--write')) {
    const day = new Date().toISOString().slice(0, 10);
    const sameQ = calls.filter((c) => c.horizon_min === cfg.horizon_min && c.move_rule === cfg.move_rule);
    writeFileSync(join(DATA_DIR, 'rounds.csv'), roundsCsv(joinRounds(sameQ, resolutions).rounds));
    const ev = join(ROOT, 'evidence');
    mkdirSync(ev, { recursive: true });
    writeFileSync(join(ev, `score-${day}.md`), md);
    writeFileSync(join(ev, `score-${day}.json`), JSON.stringify({ generated_at: new Date().toISOString(), ...views }, null, 2) + '\n');
    console.error(`wrote data/live/rounds.csv, evidence/score-${day}.md, evidence/score-${day}.json`);
  }
}
