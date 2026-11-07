export function howHtml(): string {
  return `
<div class="doc">
  <p class="eyebrow">How it works</p>
  <h1 class="doc-h">A naturalist, a stream, and a notebook it cannot cheat in</h1>
  <p class="lede">RIMBA watches Sui mainnet for large transfers, writes down a call about what that wallet does next, and lets the chain mark it. Outcomes become field notes in Walrus Memory (up to 400 a day, novel species and corrections first), so the next call can cite what it learned.</p>

  <figure class="loopfig">
    <svg viewBox="0 0 880 330" role="img" aria-labelledby="loop-t loop-d" class="loop">
      <title id="loop-t">The RIMBA loop</title>
      <desc id="loop-d">Tatum checkpoint stream feeds sightings. Each sighting becomes a species sentence, is recalled against Walrus Memory, and a call is frozen with the base rate and frequency table. Later checkpoints resolve the call. The outcome is remembered as a new note in Walrus Memory, which the next recall can cite.</desc>
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8FAAA4"/></marker></defs>
      <g font-family="'Source Sans 3', sans-serif" font-size="15" fill="#0D2B30">
        <g><rect x="12" y="28" width="160" height="78" rx="6" fill="#F2EAD3"/><text x="92" y="56" text-anchor="middle" font-weight="700">1 · Tatum stream</text><text x="92" y="78" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="11">SubscribeCheckpoints</text><text x="92" y="96" text-anchor="middle" font-size="12">large transfers → sightings</text></g>
        <g><rect x="236" y="28" width="160" height="78" rx="6" fill="#F2EAD3"/><text x="316" y="56" text-anchor="middle" font-weight="700">2 · Species sentence</text><text x="316" y="78" text-anchor="middle" font-size="12">traits → words, no LLM</text><text x="316" y="96" text-anchor="middle" font-size="12" font-style="italic">deterministic</text></g>
        <g><rect x="460" y="28" width="160" height="78" rx="6" fill="#F2EAD3"/><text x="540" y="56" text-anchor="middle" font-weight="700">3 · Recall</text><text x="540" y="78" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="11">memwal.recall</text><text x="540" y="96" text-anchor="middle" font-size="12">Walrus Memory, field-notes</text></g>
        <g><rect x="684" y="28" width="184" height="78" rx="6" fill="#D4A83A"/><text x="776" y="56" text-anchor="middle" font-weight="700">4 · The call, frozen</text><text x="776" y="78" text-anchor="middle" font-size="12">YES/NO + cited notes</text><text x="776" y="96" text-anchor="middle" font-size="12">+ base rate + habit, same instant</text></g>
        <g><rect x="684" y="214" width="184" height="78" rx="6" fill="#5FD3A8"/><text x="776" y="242" text-anchor="middle" font-weight="700">5 · The chain answers</text><text x="776" y="264" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="11" textLength="164" lengthAdjust="spacingAndGlyphs">GetCheckpoint · GetTransaction</text><text x="776" y="282" text-anchor="middle" font-size="12">later checkpoints resolve it</text></g>
        <g><rect x="460" y="214" width="160" height="78" rx="6" fill="#F2EAD3"/><text x="540" y="242" text-anchor="middle" font-weight="700">6 · Field note</text><text x="540" y="264" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="11">rememberBulk</text><text x="540" y="282" text-anchor="middle" font-size="12">outcome written to memory</text></g>
        <g><rect x="12" y="214" width="384" height="78" rx="6" fill="none" stroke="#8FAAA4" stroke-dasharray="5 5"/><text x="204" y="244" text-anchor="middle" fill="#F2EAD3" font-weight="700">The next sighting of that kind</text><text x="204" y="266" text-anchor="middle" fill="#8FAAA4" font-size="13">recalls this note — or a newer one that supersedes it</text></g>
      </g>
      <g stroke="#8FAAA4" stroke-width="2" fill="none" marker-end="url(#arr)">
        <path d="M174 67H234"/><path d="M398 67H458"/><path d="M622 67H682"/><path d="M776 108V212"/><path d="M682 253H622"/><path d="M458 253H398"/>
        <path d="M204 212V150Q204 128 226 128H520Q540 128 540 110" stroke-dasharray="4 4"/>
      </g>
    </svg>
    <figcaption>One loop, six steps. The call (4) is written to disk before its outcome exists; the notes it cites must be older than the call.</figcaption>
  </figure>

  <div class="two">
    <section class="plate">
      <h2>What each sponsor does</h2>
      <dl class="calls">
        <dt>Tatum — the eyes and the judge</dt>
        <dd>The gRPC gateway streams every Sui mainnet checkpoint (<span class="mono">sui.rpc.v2.SubscriptionService/SubscribeCheckpoints</span>). The same gateway re-derives outcomes later: <span class="mono">LedgerService/GetCheckpoint</span> and <span class="mono">LedgerService/GetTransaction</span>. The call path contains no model.</dd>
        <dt>Walrus Memory — the notebook</dt>
        <dd>Resolved outcomes are written as notes in the <span class="mono">field-notes</span> namespace, up to 400 a day, novel species and corrections first. <span class="mono">recall</span> returns the nearest notes with distances; <span class="mono">rememberBulk</span> writes new ones; memories are immutable, so a species whose behaviour drifts gets a newer note that supersedes the old one.</dd>
      </dl>
    </section>
    <section class="plate">
      <h2>Why you can trust a number</h2>
      <ul class="ticks">
        <li><b>Calls are written first.</b> The prediction row is on disk at call time; the resolution is appended later, keyed by round. Nothing is edited.</li>
        <li><b>Two opponents, same instant.</b> The base rate and a per-wallet frequency table are logged on the same round, so “did memory help?” has a fair comparison.</li>
        <li><b>Never-seen wallets.</b> The frequency table cannot know a brand-new wallet; the headline is scored there.</li>
        <li><b>Losses are published.</b> If memory trails the base rate, the scorecard says so.</li>
      </ul>
    </section>
  </div>

  <section class="plate">
    <h2>Check it yourself</h2>
    <p>From the repository root, with a Tatum key in <span class="mono">~/.config/tatum/tatum.env</span>:</p>
    <pre class="code" tabindex="0"><code>pnpm install
pnpm verify            # re-derives a sample of rounds from Tatum GetCheckpoint / GetTransaction
pnpm verify --offline  # checks the invariants on the append-only logs
pnpm score             # Brier scorecard: memory vs base rate vs frequency table</code></pre>
    <p class="muted">Every scorecard number on the reef links to <span class="mono">rounds.csv</span>; each row there names its checkpoint and transaction digest.</p>
  </section>

  <section class="plate plate--honest">
    <h2>What this page is, honestly</h2>
    <ul class="ticks">
      <li>The deployed page <b>replays</b> a frozen snapshot at 10× and says so in the badge. The live mode needs the logger running on a machine you control.</li>
      <li>Rows labelled <i>public-dev</i> or <i>local-dev</i> came from Sui’s public fullnode or a local memory stand-in, before the Tatum and Walrus Memory keys existed. They are shown, never counted as the headline.</li>
      <li>Walrus Memory’s relayer sees plaintext. Notes contain only public chain facts: bucketed traits, an outcome, a checkpoint number.</li>
      <li>“Moves again” is a habit question, and the frequency table is a strong opponent on wallets it has seen. That is why the headline is on wallets it has not.</li>
    </ul>
  </section>
</div>`;
}
