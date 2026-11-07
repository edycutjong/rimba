# pnpm verify --sample 50 — on camera (demo video scene 9), 7 Nov 2026 23:30 WIB

Recorded live in the demo video: the command ran as a child process during the screen capture and its output streamed into
the terminal on screen. Stream source at the time: Tatum gateway (switched 15:39 UTC); memory: local stand-in.
The video speeds up the online sample's wait and labels the factor and real time on screen. Raw output:

```
  ok   ledgers parse: malformed lines calls 0 · resolutions 0 · notes 0
offline: 2821 calls, 2790 resolutions
  ok   unique round_id: 2821/2821
  ok   digest format: 2821/2821
  ok   predictions in [0,1]: 2821/2821
  ok   abstain = base rate: 361/361
  ok   memory call clamped [0.05,0.95] and consistent: 2460/2460
  ok   I1 resolution has a call: 2790/2790
  ok   I1 one resolution per round: 2790/2790
  ok   I1 resolved after called: 2790/2790
  ok   I2 YES inside window: 1041/1041
  ok   I2 NO past deadline: 1749/1749
  ok   I3 cited note written before call (row): 43904/43904
  ok   I3 cited note exists in notes log, submitted before call: 43904/43904

online via sui-mainnet-grpc.gateway.tatum.io:443 (tatum)
sample of 50 resolved rounds (pool 159, tatum rows): sightings 50/50 · outcomes 50/50 (YES via GetTransaction, NO via GetCheckpoint deadline boundary)
# exit 0
```
