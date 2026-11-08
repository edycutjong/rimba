// Tatum credit governor. Decides, minute by minute, whether the checkpoint stream should run on the
// Tatum gateway or on Sui's public fullnode (rows tagged `public-dev`), from three inputs:
//  1. HTTP 402 Payment Required — the plan ran out. Switch to the public node at once, retry Tatum every
//     `retry_402_min`, switch back on the first message that arrives. (Before this module the logger
//     retried a 402 every 30 s for 5.3 h on 2026-11-08 and never fell back.)
//  2. A budget: the full stream until `full_until` (the submission deadline), then a duty cycle sized from
//     what is left so total use stays ≤ `target_frac` of the plan by `cycle_end`. Judging days get
//     `judging_weight`× the share of later days. A Tatum call may only open while its whole horizon fits
//     inside the current on-window, so every Tatum call resolves on the Tatum stream.
//  3. A hard stop: once usage reaches `hard_stop_frac` of the plan the stream stays public until a human
//     clears the latch (delete `hard_stop` from data/live/governor.json, or raise the plan).
// Pure: time is a parameter, nothing here does I/O. The logger persists `state` and feeds it usage.

import type { NetworkSource } from './client.js';

export interface TatumBudget {
  plan_credits: number;
  cycle_start: string; // ISO; plan cycle (Starter 4M credits)
  cycle_end: string;
  full_until: string; // submission deadline: full stream before this
  judging_until: string; // results expected; on-windows are judging_weight× denser before this
  judging_weight: number;
  target_frac: number; // projected use by cycle_end stays at or under this
  hard_stop_frac: number; // latch public at this fraction
  burn_credits_per_hour: number; // measured on the full stream
  credits_per_call: number; // Sui gRPC: 2 credits per call / streamed message
  on_window_min: number; // length of one Tatum on-window after the deadline
  open_slack_min: number; // margin between a call's deadline and the end of its on-window
  retry_402_min: number;
  usage_poll_min: number;
}

export const DEFAULT_BUDGET: TatumBudget = {
  plan_credits: 4_000_000,
  cycle_start: '2026-11-08T00:00:00Z',
  cycle_end: '2026-12-08T00:00:00Z',
  full_until: '2026-11-10T17:00:00Z',
  judging_until: '2026-11-17T17:00:00Z',
  judging_weight: 3,
  target_frac: 0.85,
  hard_stop_frac: 0.9,
  burn_credits_per_hour: 24_600,
  credits_per_call: 2,
  on_window_min: 45,
  open_slack_min: 3,
  retry_402_min: 10,
  usage_poll_min: 15,
};

export interface Period {
  start: number;
  on_end: number; // Tatum from start to on_end, public from on_end to end
  end: number;
  duty: number;
}

export interface GovernorState {
  api_raw: number | null; // last raw total from GET /v4/tatum/usage
  api_offset: number; // sum of raw totals seen before a counter reset (keeps `used` monotonic)
  api_at: number | null;
  local_calls: number; // Tatum calls/messages counted locally since the last usage poll
  fallback_since: number | null; // first 402 of the current outage
  fallback_until: number | null; // no Tatum attempt before this
  fallback_count: number; // 402s seen in total
  hard_stop: { at: number; used: number } | null;
  period: Period | null;
}

export type Reason = 'no-key' | 'full' | 'duty-on' | 'duty-off' | 'over-target' | 'payment-required' | 'hard-stop';

export interface Decision {
  source: NetworkSource;
  reason: Reason;
  /** Tatum on-window end (ms) — a Tatum call may open only if its deadline + slack falls before it. */
  window_end: number | null;
  duty: number | null;
}

/** HTTP 402 from the gateway. gRPC surfaces it as `2 UNKNOWN: Received HTTP status code 402`. */
export function isPaymentRequired(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
  if (o.status === 402) return true;
  const text = `${String(o.message ?? '')} ${String(o.details ?? '')}`;
  return /(?:status code|HTTP)\s*402\b|\b402 Payment Required\b|payment required/i.test(text);
}

const H = 3_600_000;
const MIN = 60_000;
const t = (iso: string) => Date.parse(iso);

export class TatumGovernor {
  state: GovernorState;

  constructor(readonly b: TatumBudget = DEFAULT_BUDGET, state?: Partial<GovernorState> | null) {
    this.state = {
      api_raw: null, api_offset: 0, api_at: null, local_calls: 0,
      fallback_since: null, fallback_until: null, fallback_count: 0, hard_stop: null, period: null,
      ...(state ?? {}),
    };
  }

  /** Credits used this cycle: last usage-API total (monotonic across counter resets) + calls counted since. */
  used(): number {
    return this.state.api_offset + (this.state.api_raw ?? 0) + this.state.local_calls * this.b.credits_per_call;
  }
  usedFrac(): number {
    return this.used() / this.b.plan_credits;
  }

  recordUsage(rawTotal: number, now: number): void {
    const s = this.state;
    if (s.api_raw !== null && rawTotal < s.api_raw) s.api_offset += s.api_raw; // the API counter reset
    s.api_raw = rawTotal;
    s.api_at = now;
    s.local_calls = 0;
    this.checkHardStop(now);
  }

  countTatumCalls(n: number, now: number): void {
    this.state.local_calls += n;
    this.checkHardStop(now);
  }

  private checkHardStop(now: number): void {
    if (!this.state.hard_stop && this.usedFrac() >= this.b.hard_stop_frac) this.state.hard_stop = { at: now, used: this.used() };
  }

  /** A 402 from Tatum: public node now, next Tatum attempt in retry_402_min. */
  onPaymentRequired(now: number): void {
    const s = this.state;
    s.fallback_since ??= now;
    s.fallback_until = now + this.b.retry_402_min * MIN;
    s.fallback_count++;
  }

  /** Data arrived from Tatum. Returns the outage length (ms) when this ends a 402 fallback. */
  onTatumOk(now: number): number | null {
    const s = this.state;
    if (s.fallback_since === null) return null;
    const lasted = now - s.fallback_since;
    s.fallback_since = null;
    s.fallback_until = null;
    return lasted;
  }

  /** Share of each period that runs on Tatum, from what is left of the target and the hours left. */
  dutyAt(now: number, used = this.used()): number {
    const b = this.b;
    // keep one on-window in reserve: a period always opens with a full on-window, so the last one cannot overshoot
    const remaining = b.target_frac * b.plan_credits - used - (b.burn_credits_per_hour * b.on_window_min) / 60;
    if (remaining <= 0) return 0;
    const end = t(b.cycle_end);
    const jEnd = Math.min(t(b.judging_until), end);
    const hJ = Math.max(0, jEnd - now) / H;
    const hA = Math.max(0, end - Math.max(now, jEnd)) / H;
    const denom = b.burn_credits_per_hour * (b.judging_weight * hJ + hA);
    if (denom <= 0) return 1;
    const base = remaining / denom;
    return Math.min(1, now < jEnd ? b.judging_weight * base : base);
  }

  /** The post-deadline schedule: starts a new period whenever the current one has ended. */
  private periodAt(now: number, used: number): Period {
    const b = this.b;
    const p = this.state.period;
    if (p && now >= p.start && now < p.end) return p;
    const full = t(b.full_until);
    const on = b.on_window_min * MIN;
    // continuous with the full stream / the previous period unless the logger was down past an on-window
    let start = p && now >= p.end ? p.end : full;
    if (now - start >= on) start = now;
    const duty = this.dutyAt(start, used);
    let next: Period;
    if (duty <= 0) next = { start, on_end: start, end: start + 60 * MIN, duty: 0 }; // over target: re-check hourly
    else if (duty >= 1) next = { start, on_end: start + on, end: start + on, duty: 1 };
    else next = { start, on_end: start + on, end: start + on / duty, duty };
    this.state.period = next;
    return next;
  }

  decide(now: number, hasKey = true): Decision {
    const s = this.state;
    if (!hasKey) return { source: 'public-dev', reason: 'no-key', window_end: null, duty: null };
    if (s.hard_stop) return { source: 'public-dev', reason: 'hard-stop', window_end: null, duty: null };
    if (s.fallback_until !== null && now < s.fallback_until) return { source: 'public-dev', reason: 'payment-required', window_end: null, duty: null };
    const full = t(this.b.full_until);
    if (now < full) return { source: 'tatum', reason: 'full', window_end: full + this.b.on_window_min * MIN, duty: 1 };
    const p = this.periodAt(now, this.used());
    if (p.duty <= 0) return { source: 'public-dev', reason: 'over-target', window_end: null, duty: 0 };
    if (p.duty >= 1) return { source: 'tatum', reason: 'duty-on', window_end: p.end + this.b.on_window_min * MIN, duty: 1 };
    if (now < p.on_end) return { source: 'tatum', reason: 'duty-on', window_end: p.on_end, duty: p.duty };
    return { source: 'public-dev', reason: 'duty-off', window_end: null, duty: p.duty };
  }

  /** May a round open now on a checkpoint from `source`? Public-dev rounds always may (they never feed a headline). */
  mayOpenCall(source: NetworkSource, now: number, horizonMin: number): boolean {
    if (source !== 'tatum') return true;
    const d = this.decide(now);
    return d.source === 'tatum' && d.window_end !== null && now + (horizonMin + this.b.open_slack_min) * MIN <= d.window_end;
  }
}

export interface Projection {
  used_now: number;
  at_full_until: number;
  at_cycle_end: number;
  frac_at_cycle_end: number;
  tatum_hours_after_deadline: number;
  first_periods: { start: string; on_min: number; period_min: number; duty: number }[];
}

/** Simulate the schedule forward from `now` with a true burn rate (defaults to the configured one). */
export function project(b: TatumBudget, usedNow: number, now: number, burnPerHour = b.burn_credits_per_hour): Projection {
  const g = new TatumGovernor(b, { api_raw: usedNow });
  const full = t(b.full_until);
  const end = t(b.cycle_end);
  let used = usedNow + (now < full ? (burnPerHour * (full - now)) / H : 0);
  const atFull = used;
  g.state.api_raw = used;
  let clock = Math.max(now, full);
  let tatumMs = 0;
  const first: Projection['first_periods'] = [];
  while (clock < end) {
    const d = g.decide(clock);
    const p = g.state.period!;
    const onMs = Math.max(0, Math.min(p.on_end, end) - clock);
    if (d.source === 'tatum' && onMs > 0) {
      used += (burnPerHour * onMs) / H;
      tatumMs += onMs;
      g.state.api_raw = used;
    }
    if (first.length < 6) first.push({ start: new Date(p.start).toISOString(), on_min: Math.round((p.on_end - p.start) / MIN), period_min: Math.round((p.end - p.start) / MIN), duty: Number(p.duty.toFixed(4)) });
    if (g.state.hard_stop) break;
    clock = p.end;
  }
  return {
    used_now: Math.round(usedNow), at_full_until: Math.round(atFull), at_cycle_end: Math.round(used),
    frac_at_cycle_end: Number((used / b.plan_credits).toFixed(4)), tatum_hours_after_deadline: Number((tatumMs / H).toFixed(1)), first_periods: first,
  };
}
