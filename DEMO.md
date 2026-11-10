# Demo and reproduction

## Look

1. Open <https://rimba.edycu.dev>. The `REPLAY` badge means a committed snapshot of real mainnet sightings is
   playing at 10×; the "Dev data" tag marks rows that did not come through Tatum and Walrus Memory.
2. Click a creature or a recent stamp to read its call card: the species sentence, the call, the base rate and the
   wallet's own habit, the notes cited, and how it resolved.
3. The Notebook tab lists every resolved call in the replay, each with its checkpoint on Suiscan and a "replay" link
   that plays the round again on the reef; How it works explains the loop and how to check it yourself.

## Reproduce the numbers

```bash
pnpm install
pnpm test                 # 118 tests
pnpm score                # Brier tables from data/live/ (add --write to refresh evidence/)
pnpm verify --offline     # invariants I1–I3 over the local rounds
pnpm verify               # re-derive a sample of outcomes from the chain (uses Tatum if a key is configured, else the public fullnode)
pnpm bench                # latency percentiles
pnpm budget               # Tatum credit projection under the governor (evidence/tatum-budget-*.json with --write)
```

If Tatum answers HTTP 402 (plan out of credits), the logger and `pnpm verify` switch to the public fullnode and tag those
rows `public-dev`. The logger retries Tatum every 10 min; see `evidence/tatum-credits-2026-11-08.md`.

`pnpm score` and `pnpm verify --offline` read `data/live/`, which only exists after a local `pnpm logger` run.

The scorecard separates the headline (Tatum stream × Walrus Memory, live since 8 Nov 03:12:53 UTC) from development
rows. At the 10 Nov re-freeze (12:37:50 UTC) the headline had 4,157 resolved rounds; on never-seen wallets
(N = 1,918) the memory's Brier score is 0.0699 against 0.1425 for the base rate. On seen-before wallets the
per-address frequency table (0.1314) beats the memory (0.1964). Full tables, the dev rows and the two logger outages
(5 h 18 min on 7–8 Nov, about 34 h on 9–10 Nov) are in the README and `evidence/freeze-2026-11-10.md`.
