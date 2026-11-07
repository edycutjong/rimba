# Developer-experience report — Tatum Sui gRPC and Walrus Memory

Notes from building RIMBA against both sponsors. Tatum items were observed while building; Walrus Memory items marked (docs) come from its documentation and were not exercised, because no Walrus account was wired in at this commit.

## Tatum Sui gRPC
- The method names are `sui.rpc.v2.SubscriptionService/SubscribeCheckpoints` and `LedgerService/GetCheckpoint` /
  `GetTransaction`. The `.proto` files are not shipped with the gateway docs; we vendored them from MystenLabs/sui-apis
  (`proto/`).
- The same protos work unchanged against `fullnode.mainnet.sui.io:443`, which let us build and test the whole
  decode path before a Tatum key existed. The endpoint is a one-line switch.
- A long stream needs reconnect and resume: `source.ts` resumes from the last sequence and backfills any skipped
  checkpoints with `GetCheckpoint`, and reports a gap instead of guessing.

## Walrus Memory
- `recall` takes a semantic distance cut-off, so "nothing close enough" is a real answer; RIMBA abstains instead of
  forcing a call.
- (docs) Memories are immutable, so a changed habit is recorded as a newer superseding note rather than an edit.
- (assumed, untested) The embedding does not measure numeric distance, so RIMBA converts amounts and times into words ("large", "evening
  UTC") before storing a note.
- (docs) The managed relayer sees note text, so notes contain only public chain data.

## What we could not measure yet
Latency and rate limits of the Tatum gateway and the Walrus relayer under our load: both need credentials that are not
wired into the logger at this commit. Benchmarks in `evidence/` are from the public fullnode and a local stand-in.
