# Tatum credits: the free-tier outage and the governor (2026-11-08)

Times are UTC (WIB = UTC+7). Log lines are quoted from the logger's own output (`logs/logger.out`, kept out of the repo).

## What happened

| | |
|---|---|
| Burn on the full stream | **29,984 credits/h**: the usage API read 111,206 at 00:40:59 and 118,702 at 00:55:59 on 8 Nov (7,496 credits in 15.0 min, steady stream, no backfill). That matches ≈ 4.3 checkpoints/s × 2 credits per streamed message (`rpc_call` units = 2 × count in `evidence/day0/tatum-usage.jsonl`). It also matches the free plan: 100K credits lasted 3.44 h of streaming (15:39 → 19:05 on 7 Nov), ≈ 29K/h. The earlier day-0 reading of 25,574 credits in 1.04 h (24.6K/h) undercounted, because the usage API lags: it still read 0 eight minutes after the stream opened. |
| Free plan | 100K credits ([docs.tatum.io/docs/plans-limits](https://docs.tatum.io/docs/plans-limits)) |
| First 402 | `2026-11-07T19:05:58.103Z stream error 2: 2 UNKNOWN: Received HTTP status code 402` |
| Last 402 | `2026-11-08T00:23:22.229Z stream error 2: 2 UNKNOWN: Received HTTP status code 402 — reconnect in 30000 ms` |
| Outage | 5 h 18 min, 639 failed reconnects to the same endpoint; the old code retried Tatum and never fell back |
| Lost checkpoints | 78,717. The outage left a gap of 79,917 checkpoints. The newest 1,200 (`342817624..342818823`) were backfilled through Tatum `GetCheckpoint`, and `342738907..342817623` were logged as a gap. Rounds spanning the gap were voided, not resolved. |
| Back on Tatum | 00:23:52 on 8 Nov, on a paid Starter plan: 4M credits per cycle (8 Nov – 8 Dec), auto-upgrade off |
| Usage at restart | 111,206 credits (usage API, 00:40:59) |

## What changed in the code

- **402 → public fullnode at once** (`src/stream/source.ts`, `src/stream/governor.ts`). A 402 on the stream or a backfill
  `GetCheckpoint` switches to `fullnode.mainnet.sui.io` (rows tagged `public-dev`, never headline). Tatum is retried every
  10 min, and the stream switches back on the first message. `pnpm verify` falls back the same way and records
  `endpoint_fallback` in its report (`withPaymentFallback` in `src/stream/client.ts`).
- **Budget** (`config/rimba.json` → `tatum_budget`): the full Tatum stream until the submission deadline (10 Nov 17:00).
  After that, a duty cycle runs: 45-min Tatum on-windows, with the period sized from the credits left so that projected use
  stays ≤ 85 % of 4M by 8 Dec. The judging days (to 17 Nov) get 3× the on-time of later days. A Tatum round opens only if
  its 15-min horizon + 3 min fits inside the on-window, so a round never outlives its window. A 402, the hard stop or a
  logger restart mid-horizon can still cut a window short.
- **Hard stop**: usage ≥ 90 % latches the stream to public until a human clears it.
- **Meter**: the usage API is polled every 15 min (1 credit), and every Tatum call/message is counted locally in between.

## Projection (`pnpm budget --write` → `evidence/tatum-budget-2026-11-08.json`)

From 118,702 credits used at 00:55:59 on 8 Nov:

| burn | at the deadline | at cycle end (8 Dec) | Tatum hours after the deadline |
|---|---|---|---|
| 30K/h (measured) | 2,040,578 | 3,390,578 (84.8 %) | 45 |
| +25 % | 2,521,047 | 3,392,922 (84.8 %) | 23.3 |

First post-deadline period at the measured burn: 45 min on Tatum every 334 min (duty 0.1349, judging week). The schedule is
re-sized from polled usage at the start of every period, so a wrong burn estimate shrinks the later windows rather than
overshooting the target.
