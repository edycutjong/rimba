# verify through the Tatum gateway — 2026-11-07 15:48 UTC (22:48 WIB)

The Tatum key went live at 15:39 UTC; the logger's credential watcher switched the stream to
`sui-mainnet-grpc.gateway.tatum.io:443` at 15:39:22 UTC. Memory is still the local stand-in (Walrus Memory key not wired),
so these rows are `tatum × local-dev`: not headline rows. The online sample uses only Tatum-streamed rows when any exist.

Command: `pnpm verify --sample 50` at commit 59484f6 (after the 429 retry fix). Raw output:

```
  ok   ledgers parse: malformed lines calls 0 · resolutions 0 · notes 0
offline: 2664 calls, 2629 resolutions
  ok   unique round_id: 2664/2664
  ok   digest format: 2664/2664
  ok   predictions in [0,1]: 2664/2664
  ok   abstain = base rate: 356/356
  ok   memory call clamped [0.05,0.95] and consistent: 2308/2308
  ok   I1 resolution has a call: 2629/2629
  ok   I1 one resolution per round: 2629/2629
  ok   I1 resolved after called: 2629/2629
  ok   I2 YES inside window: 985/985
  ok   I2 NO past deadline: 1644/1644
  ok   I3 cited note written before call (row): 41192/41192
  ok   I3 cited note exists in notes log, submitted before call: 41192/41192

online via sui-mainnet-grpc.gateway.tatum.io:443 (tatum)
sample of 9 resolved rounds (pool 9, tatum rows): sightings 9/9 · outcomes 9/9 (YES via GetTransaction, NO via GetCheckpoint deadline boundary)
```

Before the retry fix (same minute, commit c123c39) the gateway answered a burst of GetTransaction calls with HTTP 429 and
verify reported 2/4 sightings as matched; the failures were rate limits, not missing transactions (see commit 59484f6).
