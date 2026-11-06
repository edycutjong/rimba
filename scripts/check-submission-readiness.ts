// pnpm tsx scripts/check-submission-readiness.ts — exits 1 if anything a judge would check is missing.
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const checks: [string, boolean][] = [];
const has = (f: string) => existsSync(f);
const read = (f: string) => (has(f) ? readFileSync(f, 'utf8') : '');

for (const f of ['README.md', 'LICENSE', 'ARCHITECTURE.md', 'DEMO.md', 'docs/DX-REPORT.md', 'SECURITY.md', '.github/workflows/ci.yml']) {
  checks.push([`${f} exists`, has(f)]);
}
const readme = read('README.md');
checks.push(['README states the headline round count honestly', /Tatum gRPC × Walrus Memory \(\*\*headline\*\*\)/.test(readme)]);
checks.push(['no placeholder text in README', !/lorem|TODO|work in progress|TBD/i.test(readme)]);
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n');
const leaks = tracked.filter((f) => /(^|\/)(CLAUDE|AGENTS)\.md$|\.claude\/|\.env($|\.)|\.pem$|credentials/i.test(f));
checks.push([`no kitchen/secret files tracked (${leaks.join(', ') || 'none'})`, leaks.length === 0]);

let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
