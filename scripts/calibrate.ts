// pnpm exec tsx scripts/calibrate.ts [--source walrus|local-dev] [--target 0.22]
// Picks the memory backend's vote cut-off (`naturalist.max_distance`) from live recalls: every call row
// logs [embedding distance, species slot distance] for its top recalled notes. We want notes whose
// species is within `target` slot distance (the local-dev cut) to vote and the rest not to, so the
// cut-off is the embedding distance that maximises balanced accuracy on that split. Prints only;
// a human-reviewed edit of config/rimba.json applies it.
import { files, readJsonl, type CallRow } from '../src/store.js';

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const source = arg('--source', 'walrus');
const target = Number(arg('--target', '0.22'));
const pairs = readJsonl<CallRow>(files.calls()).filter((c) => c.memory_source === source).flatMap((c) => c.recall_pairs ?? []);
if (pairs.length < 30) {
  console.log(JSON.stringify({ source, pairs: pairs.length, verdict: 'not enough recall pairs yet (need ≥ 30)' }));
  process.exit(0);
}
const pos = pairs.filter(([, s]) => s <= target).map(([e]) => e);
const neg = pairs.filter(([, s]) => s > target).map(([e]) => e);
let best = { cut: 0, bacc: 0, tpr: 0, tnr: 0 };
for (const cut of [...new Set(pairs.map(([e]) => e))].sort((a, b) => a - b)) {
  const tpr = pos.length ? pos.filter((e) => e < cut).length / pos.length : 0;
  const tnr = neg.length ? neg.filter((e) => e >= cut).length / neg.length : 0;
  const bacc = (tpr + tnr) / 2;
  if (bacc > best.bacc) best = { cut, bacc, tpr, tnr };
}
console.log(JSON.stringify({ source, target_slot_distance: target, pairs: pairs.length, near: pos.length, far: neg.length, suggested_max_distance: best.cut, balanced_accuracy: Number(best.bacc.toFixed(3)), tpr: Number(best.tpr.toFixed(3)), tnr: Number(best.tnr.toFixed(3)) }, null, 2));
