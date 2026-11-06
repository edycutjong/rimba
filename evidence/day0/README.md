# Day-0 kill test

Measured 2026-11-07 03:49–04:51 WIB (2026-11-06 20:49–21:51 UTC) on Sui mainnet, before the Tatum key existed.
Endpoint: Sui public fullnode gRPC (`fullnode.mainnet.sui.io:443`, same `sui.rpc.v2` protos as Tatum's gateway).
Every number below is tagged `public-dev`; none of them feeds a headline. Raw numbers: [`day0.json`](day0.json).

| # | Test | Result | Verdict |
|---|---|---|---|
| 1 | Stream decode on real checkpoints | 14,707 checkpoints (342400542 → 342416271) streamed and decoded; 5 captured as test fixtures (`test/fixtures/`) | PASS |
| 2 | ≥ 20 sightings above threshold in 30 min | 59 sightings in the first 30 min (125 in 62 min, 2.02/min, 80 distinct senders) | PASS |
| 3 | Base rate of "sender moves again within H" in 15–85% | any transfer by the sender: H=2 12.4% · 5 32.8% · 10 41.0% · **15 46.1%** · 30 51.6% | PASS — H = 15 min |
| 4 | Tatum credit use × 4 days fits the plan | needs the Tatum key | pending creds |
| 5 | 20-note `rememberBulk` lands on mainnet | needs the Walrus Memory delegate key; relayer `health()` = ok, mode `production` ([`memwal-spike.json`](memwal-spike.json)) | pending creds |
| 6 | `recall` with `maxDistance`: 3 paraphrases hit, 2 unrelated miss | needs the delegate key | pending creds |

## Choices made from these numbers (`config/rimba.json`)
- **Sighting thresholds** (≈ 2 sightings/min across the two busiest coins): SUI ≥ 282.91 SUI, USDC ≥ 70 USDC.
  1,226 peer transfers in 62 min (19.8/min); SUI (1,017) and USDC (91) carry 90% of them.
- **Move rule:** the sender makes any transfer (any coin, any size) — the most direct reading of "moves again".
- **Horizon H = 15 min** (46.1%, n = 89). H = 30 min (51.6%, n = 62) is nominally closer to 50%, but this collector
  did not backfill and saw 93.5% of checkpoints (1,023 missing after stream resets), which biases every rate
  slightly *down*; the 15-minute rate is within noise of 50% and halves the wait between call and answer.
- **Base-rate prior:** 0.46.

## Notes
- Peer transfers are rare on Sui: across 1,395 transactions in 40 checkpoints only 0.7% credited a second address.
  Most mainnet traffic is bot DeFi through shared pools, which the decoder correctly does not count as transfers.
- The live logger backfills skipped checkpoints with `LedgerService.GetCheckpoint`, so its coverage is complete.
- `raw-no-signers.jsonl.gz` holds the transfers and checkpoint headers from this window (the per-signer lines are
  omitted for size). Re-run: `pnpm day0 analyze <raw.jsonl> <outDir>`.
