<div align="center">
  <img src="docs/assets/icon-animated.svg" alt="RIMBA icon: a pencilled field card with a green RESOLVED stamp across its corner" width="144">
  <h1>RIMBA 🪼</h1>
  <p><em>A naturalist agent built on Tatum's Sui gRPC stream and Walrus Memory: it calls what big Sui wallets do next and lets the chain grade its calls.</em></p>
  <img src="docs/assets/readme-hero-animated.svg" alt='RIMBA — a naturalist agent calls what big Sui wallets do next and the chain resolves the call. An ochre-pencilled field card — "moves again within 15 min: YES, 72%" — stamped green RESOLVED by checkpoint, three cited notes beneath.' width="100%">

  <br/>

  [![Live Reef](https://img.shields.io/badge/🚀_Live-Reef-06b6d4?style=for-the-badge)](https://rimba.edycu.dev)
  [![Demo Video](https://img.shields.io/badge/▶_Demo-Video-ff0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtu.be/7qJOvaxraEQ)
  [![Built for Total Recall](https://img.shields.io/badge/Tatum_×_Walrus-Total_Recall-8b5cf6?style=for-the-badge)](https://tatum.io/hackathon/total-recall)

  <br/>

  ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
  ![Node.js](https://img.shields.io/badge/Node.js_22-339933?style=flat&logo=node.js&logoColor=white)
  ![gRPC](https://img.shields.io/badge/gRPC-244c5a?style=flat&logo=grpc&logoColor=white)
  ![Sui](https://img.shields.io/badge/Sui_mainnet-4da2ff?style=flat)
  [![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)
  [![CI](https://github.com/edycutjong/rimba/actions/workflows/ci.yml/badge.svg)](https://github.com/edycutjong/rimba/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/edycutjong/rimba?sort=semver&color=2ea44f)](https://github.com/edycutjong/rimba/releases/latest)

</div>

---

**Track 1 — Markets & Sports Prediction · Best Walrus Memory.** RIMBA is a forecaster for on-chain flow: each call is a
dated yes/no forecast ("does this wallet move again within 15 minutes?"), frozen before the answer exists, graded by
the chain and scored by Brier against the base rate and the wallet's own habit.

> **Read this first.** RIMBA scores itself, and it only counts a round toward its headline if the checkpoint arrived
> through **Tatum's Sui gRPC** *and* the recall came from **Walrus Memory**. Walrus Memory went live on 8 Nov at
> 03:12:53 UTC; from then on, rounds streamed through Tatum count toward the headline. At the 10 Nov re-freeze (12:37:50 UTC) the headline
> had **4,157 resolved rounds**. For wallets it had never seen (N = 1,918) the memory's Brier score is **0.0699**
> against 0.1425 for the base rate (50.9 % skill); across all 4,157 it is 0.1380 against 0.2191 (37.0 %). On wallets
> it *had* seen (N = 2,239) the plain per-address frequency table (0.1314) beats the memory (0.1964). Earlier rows
> (public fullnode or Tatum with a local memory stand-in) are labelled `DEV DATA` / `DEV MEMORY` and never count.
> The logger was offline for about 34 h on 9–10 Nov (network loss on the builder's machine), so the headline has a
> hole there. See [Scorecard](#-scorecard-and-what-it-does-not-claim-yet).

## 📸 See it in Action

<p align="center"><img src="docs/reef.png" alt="RIMBA reef page: sightings as jellyfish, the call card with cited field notes and the never-seen-wallet scorecard" width="100%"></p>

The animated banner above replays one real logged call (No. 0409: 699.94 SUI, `YES · 72%`, resolved at checkpoint
342451091, outcome written as note No.0218). It ran on development data (public fullnode + local memory stand-in) and
illustrates the loop; it is not a scorecard figure.

Demo video (2 min 54 s): <https://youtu.be/7qJOvaxraEQ>. It was recorded on 7–8 Nov, before Walrus Memory went live, so
every number in it is development data and labelled so on screen; the live headline is in the [Scorecard](#-scorecard-and-what-it-does-not-claim-yet).

The [live reef](https://rimba.edycu.dev) replays a committed snapshot of real Sui mainnet sightings at 10× speed
(badge `REPLAY`); run the logger and server locally and the same page switches to `LIVE` over server-sent events.
Each jellyfish (SUI), ray (USDC) or fish (other coin) is a large transfer. The card on the right is one call: the
species sentence, `YES/NO/ABSTAIN` with a probability, the base rate and the wallet's own habit beside it, the countdown
on the chain's clock, and the field notes the call cited. Click a stamp to read how an earlier call resolved.

## 💡 The Problem & Solution

### The Problem
Big Sui wallets move many times a day. Watchers guess what each will do next, but nobody scores the guess, so neither
people nor bots learn whose read to trust. Where predictions are scored at all, resolution is often slow; on Sui a "what
happens next" question can resolve in minutes, straight from the chain.

### The Solution
For every large transfer the naturalist writes a **sighting**, turns it into a plain-words **species sentence**
(deterministic code, no LLM: size bucket, round or odd shape, number of recipients, time of day, new vs. repeat counterparty, the wallet's recent pace, how often the wallet was sighted before, coin), and **recalls**
similar field notes from Walrus Memory. It calls *"this wallet moves again within 15 minutes: yes / no"*, or abstains
when no note is close enough, and records which notes it cited. The stream itself resolves the call minutes later and
the outcome is written back as a new field note, so the next similar sighting can get a different call. Each round is
also scored against two opponents logged at the same instant: the global base rate and that address's own frequency.
The score is a Brier score (mean of `(p − outcome)²`; lower is better; always guessing 0.5 scores 0.25).

## 🏗️ Architecture & Tech Stack

<p align="center"><img src="docs/assets/architecture.png" alt="RIMBA architecture: Sui mainnet checkpoints stream from Tatum gRPC (primary; the public Sui fullnode is the fallback, picked by a credit governor) through source.ts, decode.ts and taxon.ts; the naturalist recalls field notes from Walrus Memory and calls whether the wallet moves again within 15 minutes; the resolver grades the call on later checkpoints and notes.ts writes the outcome back to memory, with a local-dev stand-in answering until Walrus credentials are set; an append-only log feeds pnpm verify (re-derives rounds on-chain through Tatum), the Brier scorecard, the logger server (SSE) and the snapshot that the reef page at rimba.edycu.dev replays." width="100%"></p>

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript, pnpm |
| Sui stream | `@grpc/grpc-js` + vendored `sui.rpc.v2` protos ([`proto/`](proto)) |
| Memory | `@mysten-incubation/memwal`, namespace `field-notes` |
| Local state | append-only rounds and notes under `data/live/` (crash-safe, greppable) |
| Web | Vite + canvas 2D, no framework; Vercel static host |
| Tests / CI | vitest, ESLint, `tsc`, GitHub Actions |

Details: [ARCHITECTURE.md](ARCHITECTURE.md).

## 🏆 Sponsor Integration — Tatum + Walrus Memory

**Tatum Sui gRPC** (`sui-mainnet-grpc.gateway.tatum.io:443`, TLS, `x-api-key` metadata) is the engine, not decoration.
Three methods of `sui.rpc.v2` carry the whole loop:

| Method | Used for | Code |
|---|---|---|
| `SubscriptionService/SubscribeCheckpoints` | the live feed every sighting comes from | [`src/stream/client.ts`](src/stream/client.ts), [`src/stream/source.ts`](src/stream/source.ts) |
| `LedgerService/GetCheckpoint` | gap backfill so no checkpoint is skipped; re-derives NO outcomes at the deadline | [`src/stream/source.ts`](src/stream/source.ts), [`scripts/verify.ts`](scripts/verify.ts) |
| `LedgerService/GetTransaction` | `pnpm verify` re-derives the sighting and each YES move from the chain | [`src/stream/client.ts`](src/stream/client.ts), [`scripts/verify.ts`](scripts/verify.ts) |

**Walrus Memory** (`@mysten-incubation/memwal`, relayer `relayer.memory.walrus.xyz`): `recall` with a semantic + recency
scoring blend and a `maxDistance` cut-off drives every call ([`src/naturalist.ts`](src/naturalist.ts),
[`src/memory/memwal.ts`](src/memory/memwal.ts)); `remember` writes outcomes as field notes (budget permitting, with a daily write
budget), and a species whose behaviour drifts gets a newer superseding note rather than a deletion
([`src/notes.ts`](src/notes.ts)). The memory sees only public chain data.

Both are behind one `CheckpointSource` / memory-backend interface, which is how the same code runs against the public
fullnode and a local stand-in before credentials exist; every row records its `network_source` and memory backend.

**Running on a metered plan.** The full checkpoint stream costs ≈ 30K Tatum credits an hour (measured: 29,984/h), since
every streamed message is billed. The free plan's 100K credits ran out at 19:05 UTC on 7 Nov. The old logger then retried the same endpoint after each
402 for 5 h 18 min and never fell back, so 78,717 checkpoints became a logged gap, and rounds that spanned it were voided.
The stream has been back on Tatum since 00:23 UTC on 8 Nov, on a paid Starter plan (4M credits per cycle). A 402 now
switches the stream, the backfill and `pnpm verify` to the public fullnode at once (rows tagged `public-dev`). Tatum is
retried every 10 min. A credit governor ([`src/stream/governor.ts`](src/stream/governor.ts)) keeps the full stream until the
deadline, then runs 45-min Tatum windows sized to stay ≤ 85 % of the plan (projection at the measured burn: 84.8 %). It
latches to public at 90 %. A Tatum round opens only if its 15-min horizon fits inside the current Tatum window. Details and the measured numbers are in
[`evidence/tatum-credits-2026-11-08.md`](evidence/tatum-credits-2026-11-08.md).

## 📊 Engineering Rigor

| Measure | Value | Reproduce |
|---|---|---|
| Tests | 118 passing, 16 files | `pnpm test` |
| Static checks | `tsc --noEmit`, ESLint, web `tsc` clean | `pnpm typecheck && pnpm lint` |
| Invariants I1–I3 | I1 a call is written before its resolution, one resolution per round; I2 an outcome is a pure function of later checkpoints; I3 every cited note predates the call | [`test/loop.test.ts`](test/loop.test.ts), [`test/naturalist.test.ts`](test/naturalist.test.ts), [`test/verify.test.ts`](test/verify.test.ts) |
| On-chain re-derivation | `pnpm verify` re-derives sampled sightings and outcomes from the chain; exit 0 only if all match; 10 Nov: 50/50 sightings and 50/50 outcomes via the Tatum gateway | [`evidence/verify-2026-11-10.json`](evidence/verify-2026-11-10.json) |
| Benchmarks (6 Nov run, earlier question; the p50s are per-checkpoint and unaffected) | decode p50 0.012 ms per mainnet checkpoint; checkpoint → call written p50 887 ms (public node) | [`evidence/bench-2026-11-06.md`](evidence/bench-2026-11-06.md) |

### Attacks defeated

| Control | Why it is load-bearing | Test |
|---|---|---|
| Predictions are frozen when the call is written | the memory, base-rate and frequency predictions are logged on the same round before any outcome exists | [`test/loop.test.ts`](test/loop.test.ts) |
| Calls written more than 60 s after their checkpoint are excluded from the stream-labelled scorecards and the headline (they stay visible in the all-rows view) | a late call could have seen the outcome | [`test/score.test.ts`](test/score.test.ts) |
| Rounds resolved through a different stream than they were called on are excluded | mixing sources would blur the headline | [`test/score.test.ts`](test/score.test.ts) |
| Abstain when no note is within `maxDistance` | an uninformed call is reported as the base rate, not as skill | [`test/naturalist.test.ts`](test/naturalist.test.ts) |
| Checkpoint gaps void a round instead of resolving it NO | a missing checkpoint is not evidence of silence | [`test/resolver.test.ts`](test/resolver.test.ts) |

## ⛓️ Live Deployment

No wallet signing anywhere: RIMBA only reads the chain, and its code never submits a Sui transaction. The Walrus Memory SDK authenticates with a delegate key.

- Reef page: <https://rimba.edycu.dev> (Vercel static, replay of [`web/public/data/snapshot.json`](web/public/data/snapshot.json); every resolved round under the current question is in [`web/public/data/rounds.csv`](web/public/data/rounds.csv): 7,813 rows at the 10 Nov re-freeze: 4,447 Tatum × Walrus Memory, 874 Tatum × local stand-in, 2,452 public fullnode × local stand-in, 40 with no memory; open rounds are not included; the headline count is lower because calls written more than 60 s after their checkpoint are excluded)
- Logger: runs continuously on the builder's machine (`pnpm logger`) and resolves each call on the chain's own clock.

## 🧮 Scorecard and what it does not claim yet

Question: does the sender move again within 15 minutes (any transfer)? Source of truth: [`evidence/score-2026-11-10.md`](evidence/score-2026-11-10.md), regenerated by `pnpm score --write`; frozen at 10 Nov 2026 19:37:50 WIB (12:37:50 UTC), [`evidence/freeze-2026-11-10.md`](evidence/freeze-2026-11-10.md).

| Stream × memory | Rounds resolved | Status |
|---|---|---|
| Tatum gRPC × Walrus Memory (**headline**) | **4,157** | since the Walrus switch-over, 8 Nov 03:12:53 UTC; 36 void (checkpoint gap), 309 excluded (call written > 60 s after its checkpoint) |
| Tatum stream × local stand-in (**DEV MEMORY**) | 874 rows in `rounds.csv` | 7–8 Nov, before Walrus Memory was live; not a headline |
| Sui public fullnode × local stand-in (**DEV DATA**) | 2,408 | 6–7 Nov, development only, never a headline |

Headline (Tatum × Walrus), Brier score, lower is better:

| Subset | N | Memory | Base rate | Per-address frequency | Skill vs base |
|---|---|---|---|---|---|
| Never-seen addresses | 1,918 | **0.0699** | 0.1425 | 0.1425 | 50.9 % |
| Seen before | 2,239 | 0.1964 | 0.2848 | **0.1314** | 31.1 % |
| All | 4,157 | 0.1380 | 0.2191 | 0.1365 | 37.0 % |

On addresses it has seen before, the per-address frequency table beats the memory; the memory's edge is on wallets it
has never seen, which is the question RIMBA is built for. Across all rows the frequency table and the memory are close
(0.1365 vs 0.1380). The dev rows, reported only for comparison: never-seen N = 1,130, 0.1085 against 0.1693; all
2,408, 0.1421 against 0.2370 (frequency 0.1519). The reef is a frozen snapshot of 400 sampled rounds of the ledger,
taken at the same instant; `rounds.csv` holds all 7,813 resolved rounds. The logger keeps running, so later
`pnpm score` output will have larger N.

**Outages.** Two holes in the ledger, both logged in `data/live/events.jsonl` and neither backfilled in full:
- 7 Nov 19:05 → 8 Nov 00:23 UTC (5 h 18 min): Tatum free plan exhausted, 78,717-checkpoint gap (see
  [Running on a metered plan](#-sponsor-integration--tatum--walrus-memory)).
- 9 Nov 02:20 UTC → 10 Nov 12:35 UTC (about 34 h): the builder's machine lost network (`ENETUNREACH`), the logger was
  stopped at 02:57 UTC and restarted at 12:35 UTC. It logged a 507,787-checkpoint gap, beyond its 1,200-checkpoint
  backfill cap, so no rounds exist for that period; rounds open across it were voided. The 399 notes queued for Walrus
  at the stop were kept in the logger's saved state and resumed after the restart.

**Limitations, stated plainly**
- "Moves again within 15 min" is partly a habit question; the per-address frequency table is a strong opponent on known
  addresses, which is why the headline is the never-seen subset.
- Per the Walrus Memory documentation the managed relayer sees plaintext notes; notes hold only public chain data.
- The horizon and size thresholds were chosen on development rows before any headline row existed
  ([`evidence/day0/`](evidence/day0), [`config/rimba.json`](config/rimba.json)). The Walrus abstain distance (0.35) is an
  initial value set before any Walrus Memory recall had run; it may be recalibrated with `scripts/calibrate.ts`, and any
  change will be stated here.
- Small samples: a few hundred rounds separate skill from luck only loosely. Read the N next to every number.

## 🚀 Getting Started

### Prerequisites
Node ≥ 22 and pnpm. A Tatum API key and a Walrus Memory delegate key are optional: without them the logger falls back
to the public fullnode and a local memory stand-in and tags every row accordingly.

### Installation
```bash
pnpm install
pnpm logger          # watch the stream, make and resolve calls (hot-switches to Tatum / Walrus when keys appear)
pnpm server          # serves /events (SSE) for the reef page; in another shell: pnpm --dir web dev
```
Credentials are read from `~/.config/tatum/tatum.env` (`TATUM_API_KEY`) and `~/.config/memwal/memwal.env`
(`MEMWAL_DELEGATE_KEY`, `MEMWAL_ACCOUNT_ID`, `MEMWAL_AGENT_ID`, `SUI_ADDRESS`), never from the repository.

## 🧪 Testing & CI

```bash
pnpm test && pnpm typecheck && pnpm lint   # 118 tests, type and lint clean
pnpm score --write                         # Brier scorecard → evidence/
pnpm verify                                # re-derive sampled outcomes from the chain
pnpm bench                                 # p50 / p95 numbers
```
CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) is a 6-stage pipeline: quality (typecheck, lint, tests on Node 22 + 24) and
security (gitleaks full history, `pnpm audit`) in parallel → web build with a bundle budget → Playwright E2E on the reef and
`pnpm bench` p95 budgets → production deploy to rimba.edycu.dev. Every green push to main is tagged with a semantic version
and released ([`release.yml`](.github/workflows/release.yml)). CodeQL and Dependabot run alongside.

## 📁 Project Structure

```
src/stream/   Tatum gRPC client, checkpoint source with gap backfill, decoder
src/memory/   Walrus Memory backend + local stand-in behind one interface
src/          taxon (species sentence), naturalist (recall + vote), resolver, notes, score, verify, logger, server
scripts/      score, verify, bench, snapshot, day-0 measurement, spikes
web/          reef page (Vite + canvas)
evidence/     score, verify and bench output the numbers above come from
```

## 📄 License

[MIT](LICENSE)

## 🙏 Acknowledgments

Tatum for the Sui gRPC gateway and Walrus / Mysten Labs for Walrus Memory and the `sui.rpc.v2` protos.
