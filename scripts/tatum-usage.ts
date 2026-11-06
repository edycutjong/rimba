// Day-0 kill test item 4: Tatum credit consumption of the live stream.
// Each run snapshots GET /v4/tatum/usage (1 credit) into evidence/day0/tatum-usage.jsonl and, when an
// earlier snapshot exists, projects the per-hour delta over the remaining build window.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTatum } from '../src/config.js';

const OUT_DIR = join(import.meta.dirname, '..', 'evidence', 'day0');
const LOG = join(OUT_DIR, 'tatum-usage.jsonl');
const creds = loadTatum();
if (!creds) {
  console.log('pending creds: ~/.config/tatum/tatum.env not found');
  process.exit(0);
}
const res = await fetch('https://api.tatum.io/v4/tatum/usage', { headers: { 'x-api-key': creds.apiKey } });
if (!res.ok) {
  console.error(`usage API HTTP ${res.status}`);
  process.exit(1);
}
const days = (await res.json()) as { day: string; usage: number }[];
const total = days.reduce((s, d) => s + (d.usage ?? 0), 0);
const snap = { at: new Date().toISOString(), total_credits_month: total, today: days.at(-1) ?? null };
mkdirSync(OUT_DIR, { recursive: true });
const prev = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as typeof snap).at(-1) : undefined;
appendFileSync(LOG, JSON.stringify(snap) + '\n');
console.log(JSON.stringify(snap));
if (prev) {
  const hours = (Date.parse(snap.at) - Date.parse(prev.at)) / 3.6e6;
  const perHour = (snap.total_credits_month - prev.total_credits_month) / hours;
  console.log(JSON.stringify({ window_h: Number(hours.toFixed(2)), credits_per_hour: Math.round(perHour), projected_4_days: Math.round(perHour * 96) }));
}
