# Demo and reproduction

## Look

1. Open <https://rimba.edycu.dev>. The `REPLAY` badge means a committed snapshot of real mainnet sightings is
   playing at 10×; the "Dev data" tag marks rows that did not come through Tatum and Walrus Memory.
2. Click a creature or a recent stamp to read its call card: the species sentence, the call, the base rate and the
   wallet's own habit, the notes cited, and how it resolved.
3. The Notebook tab lists the field notes; How it works explains the loop.

## Reproduce the numbers

```bash
pnpm install
pnpm test                 # 94 tests
pnpm score                # Brier tables from data/live/ (add --write to refresh evidence/)
pnpm verify --offline     # invariants I1–I3 over the local rounds
pnpm verify               # re-derive a sample of outcomes from the chain (uses Tatum if a key is configured, else the public fullnode)
pnpm bench                # latency percentiles
```

`pnpm score` and `pnpm verify --offline` read `data/live/`, which only exists after a local `pnpm logger` run.

The scorecard separates the headline (Tatum stream × Walrus Memory) from development rows. At the time of writing
the headline has no rounds; see the README.
