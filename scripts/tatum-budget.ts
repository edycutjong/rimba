// pnpm budget [--used N] [--write]
// Projects Tatum credit use to the end of the plan cycle under the governor's schedule (src/stream/governor.ts):
// full stream until the deadline, then the adaptive duty cycle. Usage comes from the running logger's
// data/live/governor.json (last usage-API poll + calls counted since), or --used N. Prints the projection
// at the measured burn and at +25 % burn (the schedule re-sizes every period, so a wrong burn estimate
// shows up as a smaller overshoot, bounded by the hard stop).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUDGET, project, TatumGovernor, type GovernorState } from '../src/stream/governor.js';
import { files, loadConfig, readJson, ROOT } from '../src/store.js';

const argv = process.argv.slice(2);
const cfg = loadConfig();
const b = { ...DEFAULT_BUDGET, ...(cfg.tatum_budget ?? {}) };
const usedArg = argv.indexOf('--used');
const st = readJson<GovernorState>(files.governor());
const now = Date.now();
const used = usedArg >= 0 ? Number(argv[usedArg + 1]) : new TatumGovernor(b, st).used();
const nominal = project(b, used, now);
const high = project(b, used, now, b.burn_credits_per_hour * 1.25);
const out = {
  generated_at: new Date(now).toISOString(),
  usage_source: usedArg >= 0 ? 'argument' : st?.api_at ? `governor.json (usage API ${new Date(st.api_at).toISOString()} + local count)` : 'none',
  plan_credits: b.plan_credits, target_frac: b.target_frac, hard_stop_frac: b.hard_stop_frac, burn_credits_per_hour: b.burn_credits_per_hour,
  full_until: b.full_until, judging_until: b.judging_until, cycle_end: b.cycle_end,
  nominal, burn_plus_25pct: high,
  within_target: nominal.frac_at_cycle_end <= b.target_frac + 1e-6,
};
console.log(JSON.stringify(out, null, 2));
if (argv.includes('--write')) {
  const dir = join(ROOT, 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `tatum-budget-${out.generated_at.slice(0, 10)}.json`), JSON.stringify(out, null, 2) + '\n');
}
