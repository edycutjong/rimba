import { ago, b4, callLine, catNo, coinOf, esc, fmtAmount, mmss, noteVote, pct, short, suiscanCheckpoint, suiscanTx, verdict } from './fmt';
import { ReefCanvas } from './reef';
import { brier, cumulative, movedWithin, revote, store } from './state';
import type { Cell, Round, Scorecard } from './types';

const HOLD_MS = 9_000;

export function reefHtml(): string {
  return `
<div class="reef-grid">
  <section class="reef-panel" aria-labelledby="reef-h">
    <h1 id="reef-h" class="sr-only">The reef: live sightings</h1>
    <div class="reef-stage"><canvas id="reef" role="img" aria-label="Reef canvas: each creature is a large Sui transfer the naturalist is watching"></canvas></div>
    <div class="reef-legend" aria-label="Legend">
      <span><i class="dot dot--open"></i>call open</span>
      <span><i class="dot dot--right"></i>call right</span>
      <span><i class="dot dot--wrong"></i>call wrong</span>
      <span class="legend-shapes">jellyfish = SUI · ray = USDC · fish = other</span>
      <span class="reef-count" id="reef-count"></span>
    </div>
  </section>
  <div class="side">
    <section class="card paper" id="card" aria-labelledby="card-h" aria-live="off"></section>
    <section class="slips" id="slips" aria-labelledby="slips-h"></section>
    <section class="score" id="score" aria-labelledby="score-h"></section>
  </div>
</div>`;
}

export class ReefPage {
  readonly canvas: ReefCanvas;
  private card = document.getElementById('card')!;
  private slips = document.getElementById('slips')!;
  private scoreEl = document.getElementById('score')!;
  private countEl = document.getElementById('reef-count')!;
  private lastCardKey = '';
  private announce = document.getElementById('announce')!;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    this.canvas = new ReefCanvas(document.getElementById('reef') as HTMLCanvasElement);
    this.canvas.onPick = (id) => this.pin(id);
    // pointerdown as well as click: the card re-renders when a call resolves, which can swap a button between press and release
    const onCard = (e: Event) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
      if (b) this.pin(b.dataset.pick!);
      if ((e.target as HTMLElement).closest('[data-unpin]')) {
        store.pinned = null;
        store.holdUntil = 0;
        this.tick();
      }
    };
    this.card.addEventListener('pointerdown', onCard);
    this.card.addEventListener('click', onCard);
    this.scoreEl.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'maxd') store.maxD = Number(t.value);
      if (t.name === 'hz') store.horizon = Number(t.value);
      this.updateJudge();
    });
    this.scoreEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-reset]')) {
        store.maxD = null;
        store.horizon = store.status?.horizon_min ?? 15;
        this.renderScore(true);
      }
    });
    this.renderScore();
    this.tick();
  }

  pin(id: string) {
    if (!store.byId.has(id)) return;
    store.pinned = id;
    store.focus = id;
    this.tick();
  }

  onCall(r: Round, instant: boolean) {
    store.byId.set(r.round_id, r);
    store.open.set(r.round_id, r);
    this.canvas.add(r, instant);
    if (!instant) this.announce.textContent = `New sighting ${catNo(r.n)}: ${callLine(r)}.`;
    this.tick();
  }

  onResolution(r: Round, instant: boolean) {
    store.byId.set(r.round_id, r);
    store.open.delete(r.round_id);
    this.canvas.resolve(r, instant);
    if (!instant || verdict(r)) {
      store.stack = [r, ...store.stack.filter((x) => x.round_id !== r.round_id)].slice(0, 12);
    }
    if (!instant && store.focus === r.round_id) store.holdUntil = performance.now() + HOLD_MS;
    if (!instant) this.announce.textContent = `Sighting ${catNo(r.n)} resolved by checkpoint ${r.resolution?.resolving_checkpoint_seq}: call ${verdict(r) ?? 'void'}.`;
    this.tick();
  }

  /** choose the focused round: stay on it until it resolves + hold, then take the newest open call */
  private chooseFocus() {
    // a card the visitor picked stays until they ask to follow the newest call again
    if (store.pinned) {
      const p = store.byId.get(store.pinned);
      if (p) { store.focus = p.round_id; this.canvas.select(store.focus); return; }
      store.pinned = null;
    }
    const cur = store.focus ? store.byId.get(store.focus) : null;
    const curDone = !!cur?.resolution;
    if (cur && !curDone) return; // still counting down
    if (cur && performance.now() < store.holdUntil) return; // let the stamp sit
    let best: Round | null = null;
    // prefer the newest open call that actually cites notes (the hero should show memory working); else the newest
    for (const r of store.open.values()) {
      const better = !best || (r.call !== 'abstain') > (best.call !== 'abstain') || ((r.call !== 'abstain') === (best.call !== 'abstain') && r.created_at > best.created_at);
      if (better) best = r;
    }
    if (best) store.focus = best.round_id;
    else if (!cur && store.stack[0]) store.focus = store.stack[0].round_id;
    this.canvas.select(store.focus);
  }

  tick() {
    this.chooseFocus();
    const r = store.focus ? store.byId.get(store.focus) ?? null : null;
    const c = this.canvas.count();
    this.countEl.textContent = `${store.open.size} calls open`;
    void c;
    this.renderCard(r);
  }

  private renderCard(r: Round | null) {
    const clock = store.status?.clockMs ?? Date.now();
    if (!r) {
      this.card.innerHTML = `<p class="eyebrow">Field card</p><h2 id="card-h" class="card-title">Waiting for the first sighting…</h2><p class="muted-on-paper">The naturalist is watching the stream for large transfers.</p>`;
      this.slips.innerHTML = '';
      this.lastCardKey = '';
      return;
    }
    const open = !r.resolution;
    const total = r.horizon_min * 60_000;
    const left = Math.max(0, Date.parse(r.created_at) + total - clock);
    const frac = open ? Math.min(1, Math.max(0, left / total)) : 0;
    const key = `${r.round_id}|${open}|${store.pinned ?? ''}|${store.stack.map((s) => s.round_id).join(',')}`;
    const v = verdict(r);
    const head = `
      <p class="eyebrow"><span class="mono">${catNo(r.n)}</span> · ${esc(coinOf(r.coin_type))} sighting · <span class="mono">${esc(fmtAmount(r))}</span>
        ${r.sender_seen_before ? '· returning wallet' : '· <b>first-seen wallet</b>'}</p>
      <h2 id="card-h" class="card-title">${esc(r.species ?? 'Unlabelled sighting')}</h2>
      <p class="ask">Moves again within <b>${r.horizon_min} min</b>?</p>
      <p class="call ${r.call === 'abstain' ? 'call--abstain' : ''}">${esc(callLine(r))}</p>
      <p class="rivals"><span>base rate <b class="mono">${pct(r.p_base)}</b></span><span>this wallet's habit <b class="mono">${pct(r.p_freq)}</b></span>${
        r.call !== 'abstain' ? `<span>memory says <b class="mono">${pct(r.p_memory)}</b></span>` : ''
      }</p>`;
    let live: string;
    if (open) {
      live = `<div class="count" role="timer" aria-label="Time left on the chain's clock">
        <div class="bar"><i id="bar-fill" style="width:${(frac * 100).toFixed(1)}%"></i></div>
        <p class="count-t"><span class="mono" id="count-t">${mmss(left)}</span> left on the chain's clock${store.status?.mode === 'replay' ? ' <span class="muted-on-paper">(replay ×' + store.status.speed + ')</span>' : ''}</p>
      </div>`;
    } else {
      const res = r.resolution!;
      const cls = v === 'right' ? 'stamp--right' : v === 'wrong' ? 'stamp--wrong' : 'stamp--none';
      const what = res.outcome === 1 ? 'MOVED AGAIN' : res.reason === 'gap' ? 'VOID' : 'DID NOT MOVE';
      const how = v === 'right' ? 'CALL RIGHT' : v === 'wrong' ? 'CALL WRONG' : 'NO CALL MADE';
      live = `<div class="stamp ${cls} ${this.reduce ? '' : 'stamp--in'}" role="img" aria-label="Resolved by checkpoint ${esc(res.resolving_checkpoint_seq)}: ${what}, ${how}">
          <span class="stamp-a">RESOLVED · <span class="mono">checkpoint #${esc(res.resolving_checkpoint_seq)}</span></span>
          <span class="stamp-b">${what} · ${how}</span>
        </div>
        <p class="chain-links"><a class="link-paper" href="${suiscanCheckpoint(res.resolving_checkpoint_seq)}" target="_blank" rel="noopener">checkpoint on Suiscan ↗</a>
          <a class="link-paper" href="${suiscanTx(r.tx_digest)}" target="_blank" rel="noopener">the sighted transfer ↗</a></p>`;
    }
    const stack = store.stack.length
      ? `<div class="stackrow"><span class="stackrow-l">Recent stamps</span>${store.stack
          .map((s) => {
            const sv = verdict(s);
            return `<button type="button" class="mini mini--${sv ?? 'none'} ${s.round_id === r.round_id ? 'is-on' : ''}" data-pick="${esc(s.round_id)}" aria-label="Show ${catNo(s.n)}: ${sv ?? 'void'}"><span class="mono">${String(s.n).slice(-3)}</span></button>`;
          })
          .join('')}</div>`
      : '';
    const pin = store.pinned ? `<button type="button" class="pill" data-unpin>Follow the newest call</button>` : '';
    const more = `<p class="more" id="more-open">${store.open.size > (open ? 1 : 0) ? `${store.open.size - (open ? 1 : 0)} other call${store.open.size - (open ? 1 : 0) === 1 ? '' : 's'} open on the reef — click a creature or a stamp to read its card.` : ''} ${pin}</p>`;
    if (key !== this.lastCardKey) {
      this.card.innerHTML = head + live + stack + more;
      this.lastCardKey = key;
      this.renderSlips(r);
    } else if (open) {
      const f = document.getElementById('bar-fill');
      const t = document.getElementById('count-t');
      if (f) f.style.width = `${(frac * 100).toFixed(1)}%`;
      const mo = document.getElementById('more-open');
      const others = store.open.size - 1;
      if (mo && !store.pinned) mo.textContent = others > 0 ? `${others} other call${others === 1 ? '' : 's'} open on the reef — click a creature or a stamp to read its card.` : '';
      if (t) t.textContent = mmss(left);
    }
  }

  private renderSlips(r: Round) {
    const take = r.cited_note_ids.slice(0, 3);
    let body: string;
    if (!take.length) {
      body = `<p class="slip slip--empty">No notes within reach. The naturalist abstained and reported the base rate (${pct(r.p_base)}) — it does not guess without a memory.</p>`;
    } else {
      body = take
        .map((id, i) => {
          const info = store.notes[id];
          const d = r.cited_distances[i];
          const written = r.cited_created_at?.[i];
          const ageMs = written ? Date.parse(r.created_at) - Date.parse(written) : null;
          const v = info ? noteVote(info.text) : null;
          const out = v ? (v.n === 1 ? (v.yes ? 'moved again' : 'did not move') : `${v.yes} of ${v.n} moved`) : '—';
          const where = info ? (info.backend === 'walrus' ? 'Walrus Memory' : 'local-dev memory (not Walrus)') : '';
          return `<article class="slip">
            <p class="slip-text">${info ? esc(info.text.replace(/^Specimen /, '')) : `<span class="mono">${esc(id)}</span> — note text not loaded`}</p>
            <p class="slip-meta"><span>distance <b class="mono">${d !== undefined ? d.toFixed(3) : '—'}</b></span>
              <span>written ${ageMs !== null ? ago(ageMs) + ' before the call' : '—'}</span>
              <span class="slip-out">${esc(out)}</span>
              ${where ? `<span class="slip-where">${esc(where)}${info?.blob_id ? ' · <span class="mono">' + esc(short(info.blob_id, 8, 4)) + '</span>' : ''}</span>` : ''}</p>
          </article>`;
        })
        .join('');
    }
    const more = r.cited_note_ids.length > 3 ? `<p class="slips-more">+ ${r.cited_note_ids.length - 3} more notes within reach also voted.</p>` : '';
    this.slips.innerHTML = `<h2 id="slips-h" class="sec-h">Notes it cited <span class="sec-sub">(${r.cited_note_ids.length} within reach)</span></h2>${body}${more}`;
  }

  // ---------------------------------------------------------------- scorecard

  private cellRow(label: string, c: Cell): string {
    if (!c.n) return `<tr><th scope="row">${label}</th><td colspan="4" class="muted">no resolved rounds yet</td></tr>`;
    const vals = [c.brier_memory, c.brier_base, c.brier_freq];
    const best = Math.min(...(vals.filter((x): x is number => x !== null) as number[]));
    const cellHtml = (x: number | null) =>
      `<td><a class="num ${x === best ? 'num--best' : ''}" href="${esc(store.status?.csv_url ?? 'data/rounds.csv')}" title="Every number is derived from rounds.csv" target="_blank" rel="noopener">${b4(x)}</a></td>`;
    return `<tr><th scope="row">${label}</th><td class="mono">${c.n}</td>${vals.map(cellHtml).join('')}</tr>`;
  }

  private skill(c: Cell): string {
    if (c.skill_vs_base === null) return '';
    const s = c.skill_vs_base * 100;
    return s >= 0 ? `Memory beats the base rate by ${s.toFixed(1)}%.` : `Memory currently trails the base rate by ${Math.abs(s).toFixed(1)}% — reported as logged.`;
  }

  private sparkline(): string {
    const { mem, base } = cumulative(store.history);
    if (mem.length < 3) return `<p class="muted">Curve appears after 3 resolved rounds.</p>`;
    const W = 320, H = 64, pad = 4;
    const all = [...mem, ...base];
    const lo = Math.min(...all), hi = Math.max(...all);
    const sx = (i: number) => pad + (i / (mem.length - 1)) * (W - 2 * pad);
    const sy = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const line = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    return `<figure class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cumulative Brier score over ${mem.length} resolved rounds: memory ends at ${mem[mem.length - 1]!.toFixed(3)}, base rate at ${base[base.length - 1]!.toFixed(3)}">
      <path d="${line(base)}" fill="none" stroke="#8FAAA4" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <path d="${line(mem)}" fill="none" stroke="#D4A83A" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
      <figcaption><i class="swatch swatch--mem"></i>memory <i class="swatch swatch--base"></i>base rate — cumulative Brier over rounds, lower is better</figcaption></figure>`;
  }

  /** what-if numbers for the judge controls; pure function of store state */
  private judgeState(): { dmax: number; maxD: number; whatif: string } {
    const H = store.status?.horizon_min ?? 15;
    const hist = store.history;
    const dists = hist.flatMap((r) => r.cited_distances);
    const dmax = dists.length ? Math.ceil(Math.max(...dists) * 100) / 100 : 0.3;
    const maxD = store.maxD ?? dmax;
    let whatif = '';
    const horizonDiffers = store.horizon !== H;
    if (hist.length) {
      if (store.maxD !== null && store.maxD < dmax) {
        let called = 0, sm = 0, sb = 0, sl = 0;
        for (const r of hist) {
          const o = r.resolution!.outcome as 0 | 1;
          const v = revote(r, store.maxD);
          if (v.called) called++;
          sm += brier(v.p, o);
          sb += brier(r.p_base, o);
          sl += brier(r.p_memory, o);
        }
        const n = hist.length;
        whatif += `<p class="whatif">What if the naturalist were stricter (maxDistance ${store.maxD.toFixed(2)})? It would still cite notes on <b class="mono">${called}</b> of <b class="mono">${n}</b> rounds. Brier: stricter memory <b class="mono">${b4(sm / n)}</b> · logged memory <b class="mono">${b4(sl / n)}</b> · base rate <b class="mono">${b4(sb / n)}</b>. Recomputed in your browser from the logged citations — the calls themselves are unchanged.</p>`;
      }
      if (horizonDiffers) {
        const k = hist.map((r) => movedWithin(r, store.horizon)).filter((x): x is number => x !== null);
        const y = k.reduce<number>((a, b) => a + b, 0);
        whatif += `<p class="whatif">Re-asked at <b>${store.horizon} min</b>: <b class="mono">${y}</b> of <b class="mono">${k.length}</b> wallets moved within that time (${pct(y / (k.length || 1))}), re-derived from each resolving checkpoint's timestamp. Brier is not recomputed — every call was made for ${H} minutes.</p>`;
      }
    }
    return { dmax, maxD, whatif };
  }

  private updateJudge() {
    const { maxD, whatif } = this.judgeState();
    const v = document.getElementById('maxd-v');
    const out = document.getElementById('judge-out');
    if (v) v.textContent = maxD.toFixed(2);
    if (out) out.innerHTML = whatif || '<p class="muted">Move the slider or pick a horizon to see the what-if.</p>';
  }

  renderScore(keepOpen = false) {
    const wasOpen = keepOpen || !!(document.getElementById('judge') as HTMLDetailsElement | null)?.open;
    const s = store.score;
    if (!s) {
      this.scoreEl.innerHTML = `<h2 id="score-h" class="sec-h">Scorecard</h2><p class="muted">Loading…</p>`;
      return;
    }
    const hasHead = s.headline.all.n > 0;
    const card: Scorecard = hasHead ? s.headline : s.development;
    const label = hasHead
      ? '<span class="tag tag--head">Headline · Tatum stream × Walrus Memory</span>'
      : '<span class="tag tag--dev">Development data · public fullnode × local-dev memory</span>';
    const note = hasHead
      ? ''
      : `<p class="devnote">Headline rows (Tatum stream <i>and</i> Walrus Memory) start when both keys are in. ${s.headline.counts.calls ? '' : 'Until then these numbers are development numbers and never the headline.'}</p>`;
    const { dmax, maxD, whatif } = this.judgeState();
    const hist = store.history;
    this.scoreEl.innerHTML = `
      <h2 id="score-h" class="sec-h">Scorecard ${label}</h2>
      <table class="scoretable">
        <thead><tr><th scope="col"><span class="sr-only">Group</span></th><th scope="col">N</th><th scope="col">Memory</th><th scope="col">Base rate</th><th scope="col">Frequency table</th></tr></thead>
        <tbody>${this.cellRow('Never-seen wallets', card.never_seen)}${this.cellRow('All rounds', card.all)}</tbody>
      </table>
      <p class="skill">${esc(this.skill(card.never_seen.n ? card.never_seen : card.all))} <span class="muted">Brier: lower is better; always saying 50% scores 0.25. Click any number for rounds.csv.</span></p>
      ${note}${this.sparkline()}
      <details class="judge" id="judge"${wasOpen ? ' open' : ''}>
        <summary>Judge controls <span class="muted">— stress the naturalist</span></summary>
        <div class="judge-body">
          <label class="field-l" for="maxd">maxDistance <b class="mono" id="maxd-v">${maxD.toFixed(2)}</b> <span class="muted">(logged ≤ ${dmax.toFixed(2)}; lower = stricter)</span></label>
          <input class="range" type="range" id="maxd" min="0.02" max="${dmax}" step="0.01" value="${maxD}" ${hist.length ? '' : 'disabled'} />
          <fieldset class="hz"><legend class="field-l">Horizon</legend>
            ${[5, 10, 15].map((h) => `<label class="chip"><input type="radio" name="hz" value="${h}" ${store.horizon === h ? 'checked' : ''}/><span>${h} min</span></label>`).join('')}
          </fieldset>
          <button type="button" class="pill" data-reset>Reset to logged</button>
          <div id="judge-out" aria-live="polite">${whatif || '<p class="muted">Move the slider or pick a horizon to see the what-if.</p>'}</div>
        </div>
      </details>`;
  }
}
