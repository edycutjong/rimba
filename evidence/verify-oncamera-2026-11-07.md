# pnpm verify --sample 50 — on camera (demo video scene 9), 7 Nov 2026 23:07 WIB

Recorded live in the demo video: the command ran as a child process during the screen capture and its output streamed into
the terminal on screen. Stream source at the time: Tatum gateway (switched 15:39 UTC); memory: local stand-in.
The video speeds up the 39 s online sample ×12 and labels it on screen. Raw output:

```
  ok   ledgers parse: malformed lines calls 0 · resolutions 0 · notes 0
offline: 2753 calls, 2701 resolutions
  ok   unique round_id: 2753/2753
  ok   digest format: 2753/2753
  ok   predictions in [0,1]: 2753/2753
  ok   abstain = base rate: 360/360
  ok   memory call clamped [0.05,0.95] and consistent: 2393/2393
  ok   I1 resolution has a call: 2701/2701
  ok   I1 one resolution per round: 2701/2701
  ok   I1 resolved after called: 2701/2701
  ok   I2 YES inside window: 1014/1014
  ok   I2 NO past deadline: 1687/1687
  ok   I3 cited note written before call (row): 42726/42726
  ok   I3 cited note exists in notes log, submitted before call: 42726/42726

online via sui-mainnet-grpc.gateway.tatum.io:443 (tatum)
sample of 50 resolved rounds (pool 70, tatum rows): sightings 50/50 · outcomes 50/50 (YES via GetTransaction, NO via GetCheckpoint deadline boundary)
# exit 0
```
