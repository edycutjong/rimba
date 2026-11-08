import { ago, b4, callLine, catNo, coinOf, esc, fmtAmount, fmtN, mmss, noteParts, noteVote, pct, short, suiscanCheckpoint, suiscanTx, traitDiff, verdict } from './fmt';
import { ReefCanvas } from './reef';
import { brier, cumulative, movedWithin, revote, store } from './state';
import type { Cell, Round, Scorecard } from './types';

const HOLD_MS = 9_000;

/** "Tatum stream × local memory stand-in" when every row came the same way, else "mixed sources" */
function rowsSource(rs: Round[]): string {
  const kinds = new Set(rs.map((r) => `${r.network_source}|${r.memory_source ?? 'none'}`));
  if (kinds.size !== 1) return kinds.size ? 'mixed sources' : '';
  const [net, mem] = [...kinds][0]!.split('|');
  const stream = net === 'tatum' ? 'Tatum stream' : 'public fullnode';
  const memory = mem === 'walrus' ? 'Walrus Memory' : mem === 'local-dev' ? 'local memory stand-in' : 'no memory';
  return `${stream} × ${memory}`;
}

export class ReefPage {
  readonly canvas: ReefCanvas;
  private card = document.getElementById('card')!;
  private slips = document.getElementById('slips')!;
  private strip = document.getElementById('strip')!;
  private log = document.getElementById('stamplog')!;
  private scoreEl = document.getElementById('score')!;
  private countEl = document.getElementById('reef-count')!;
  private lastCardKey = '';
  private stamped = new Set<string>();
  private lastLogKey = '';
  private failed = false;
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

  /** Instant deliveries (history replayed at boot) only update state; the caller ticks once after the batch,
   * instead of rebuilding the card a few hundred times on the main thread. */
  onCall(r: Round, instant: boolean) {
    store.byId.set(r.round_id, r);
    store.open.set(r.round_id, r);
    this.canvas.add(r, instant);
    if (instant) return;
    this.announce.textContent = `New sighting ${catNo(r.n)}: ${callLine(r)}.`;
    this.tick();
  }

  onResolution(r: Round, instant: boolean) {
    store.byId.set(r.round_id, r);
    store.open.delete(r.round_id);
    this.canvas.resolve(r, instant);
    if (!instant || verdict(r)) {
      store.stack = [r, ...store.stack.filter((x) => x.round_id !== r.round_id)]
        .sort((a, b) => Date.parse(b.resolution?.resolved_at ?? '') - Date.parse(a.resolution?.resolved_at ?? ''))
        .slice(0, 12);
    }
    if (instant) return;
    if (store.focus === r.round_id) store.holdUntil = performance.now() + HOLD_MS;
    this.announce.textContent = `Sighting ${catNo(r.n)} resolved by checkpoint ${r.resolution?.resolving_checkpoint_seq}: call ${verdict(r) ?? 'void'}.`;
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
    const hasCited = [...store.open.values()].some((r) => r.call !== 'abstain');
    if (cur && !curDone && !(cur.call === 'abstain' && hasCited)) return; // still counting down (an abstain never holds the hero while a call with notes is open)
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

  private renderLog() {
    const rows = store.stack.slice(0, 7);
    const key = rows.map((r) => r.round_id).join(',');
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    this.log.innerHTML = rows.length
      ? `<h2 id="log-h" class="sec-h">Latest stamps</h2><ol class="logrows">${rows
          .map((r) => {
            const v = verdict(r);
            const res = r.resolution!;
            return `<li><span class="mini-stamp mini-stamp--${v ?? 'none'}">${v === 'right' ? 'RIGHT' : v === 'wrong' ? 'WRONG' : 'NO CALL'}</span> <span class="mono">${catNo(r.n)}</span> <span class="logs">${v === 'abstain' ? `no call, scored at the base rate (chain: ${res.outcome === 1 ? 'moved again' : 'did not move'})` : `${esc(callLine(r))} → ${res.outcome === 1 ? 'moved again' : 'did not move'}`}</span> <a class="link-quiet mono" href="${suiscanCheckpoint(res.resolving_checkpoint_seq)}" target="_blank" rel="noopener">#${esc(res.resolving_checkpoint_seq)} ↗</a></li>`;
          })
          .join('')}</ol>`
      : '';
  }

  tick() {
    this.chooseFocus();
    this.renderLog();
    const r = store.focus ? store.byId.get(store.focus) ?? null : null;
    const n = store.open.size;
    this.countEl.textContent = store.status ? `${n} call${n === 1 ? '' : 's'} open` : '';
    this.renderCard(r);
  }

  /** the snapshot (or the logger) could not be read: say so on the card instead of loading forever */
  fail(why: string) {
    this.failed = true;
    this.card.dataset.state = 'void';
    this.card.innerHTML = `<p class="eyebrow">Field card</p><h2 id="card-h" class="card-title">The notebook did not open</h2><p class="muted-on-paper">${esc(why)}. Every resolved round is still in <a class="link-paper" href="data/rounds.csv">rounds.csv</a>.</p>`;
    this.scoreEl.innerHTML = `<h2 id="score-h" class="sec-h">Scorecard</h2><p class="muted">Not loaded — the numbers are in <a class="link-quiet" href="data/rounds.csv">rounds.csv</a>.</p>`;
  }

  private renderCard(r: Round | null) {
    if (this.failed) return;
    const clock = store.status?.clockMs ?? Date.now();
    if (!r) {
      const key = store.status ? 'waiting' : 'loading';
      if (key === this.lastCardKey) return;
      this.lastCardKey = key;
      this.card.dataset.state = 'empty';
      this.card.innerHTML = key === 'loading'
        ? `<p class="eyebrow">Field card</p><h2 id="card-h" class="card-title">Opening the field notebook…</h2><div class="sk" aria-hidden="true"><i></i><i></i><i></i></div>`
        : `<p class="eyebrow">Field card</p><h2 id="card-h" class="card-title">Waiting for the first sighting…</h2><p class="muted-on-paper">The naturalist is watching the stream for large transfers.</p>`;
      this.slips.innerHTML = '';
      return;
    }
    const open = !r.resolution;
    const total = r.horizon_min * 60_000;
    const left = Math.max(0, Date.parse(r.created_at) + total - clock);
    const frac = open ? Math.min(1, Math.max(0, left / total)) : 0;
    const key = `${r.round_id}|${open}|${store.pinned ?? ''}|${store.stack.map((s) => s.round_id).join(',')}`;
    const v = verdict(r);
    const head = `
      <p class="eyebrow"><span class="catno">${catNo(r.n)}</span> ${esc(coinOf(r.coin_type))} sighting · <span class="mono">${esc(fmtAmount(r))}</span>
        ${r.sender_seen_before ? '· returning wallet' : '· <b>first-seen wallet</b>'}</p>
      <h2 id="card-h" class="card-title">${esc(r.species ?? 'Unlabelled sighting')}</h2>
      <p class="ask">Moves again within <b>${r.horizon_min} min</b>?</p>
      <p class="call ${r.call === 'abstain' ? 'call--abstain' : ''}">${esc(callLine(r))}</p>
      <p class="rivals"><span>base rate <b class="mono">${pct(r.p_base)}</b></span><span>this wallet's habit <b class="mono">${pct(r.p_freq)}</b></span>${
        r.call !== 'abstain' ? `<span class="riv-mem">memory says <b class="mono">${pct(r.p_memory)}</b></span>` : ''
      }</p>`;
    let live: string;
    let land = false;
    if (open) {
      live = `<div class="count" role="timer" aria-label="Time left on the chain's clock">
        <div class="bar" style="--ticks:${Math.max(1, Math.min(60, r.horizon_min))}"><i id="bar-fill" style="width:${(frac * 100).toFixed(1)}%"></i></div>
        <p class="count-t"><span class="mono" id="count-t">${mmss(left)}</span> left on the chain's clock${store.status?.mode === 'replay' ? ' <span class="muted-on-paper">(replay ×' + store.status.speed + ')</span>' : ''}</p>
      </div>`;
    } else {
      const res = r.resolution!;
      const cls = v === 'right' ? 'stamp--right' : v === 'wrong' ? 'stamp--wrong' : 'stamp--none';
      const what = res.outcome === 1 ? 'MOVED AGAIN' : res.reason === 'gap' ? 'VOID' : 'DID NOT MOVE';
      const how = v === 'right' ? 'CALL RIGHT' : v === 'wrong' ? 'CALL WRONG' : 'NO CALL MADE';
      // the card re-renders whenever another round resolves; the stamp lands (animates) once per round, not on every re-render
      land = !this.reduce && !this.stamped.has(r.round_id);
      this.stamped.add(r.round_id);
      live = `<div class="stamp ${cls} ${land ? 'stamp--in' : ''}" role="img" aria-label="Resolved by checkpoint ${esc(res.resolving_checkpoint_seq)}: ${what}, ${how}">
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
            const said = `${catNo(s.n)}: ${callLine(s)} → ${s.resolution?.outcome === 1 ? 'moved again' : 'did not move'}`;
            return `<button type="button" class="mini mini--${sv ?? 'none'} ${s.round_id === r.round_id ? 'is-on' : ''}" data-pick="${esc(s.round_id)}" title="${esc(said)}" aria-label="Show ${catNo(s.n)}: ${sv ?? 'void'}"><span class="mono">${String(s.n).padStart(4, '0')}</span></button>`;
          })
          .join('')}</div>`
      : '';
    const pin = store.pinned ? `<button type="button" class="pill" data-unpin>Follow the newest call</button>` : '';
    const others = store.open.size - (open ? 1 : 0);
    const more = `<p class="more" id="more-open">${others > 0 ? `${others} other call${others === 1 ? '' : 's'} open on the reef — click a creature or a stamp to read its card.` : ''} ${pin}</p>`;
    if (key !== this.lastCardKey) {
      this.card.dataset.state = open ? 'open' : v ?? 'void';
      this.card.innerHTML = head + live + stack + more;
      this.card.classList.remove('is-thump');
      if (land) {
        void this.card.offsetWidth; // restart the thump when two stamps land back to back
        this.card.classList.add('is-thump');
      }
      this.lastCardKey = key;
      this.renderSlips(r);
    } else if (open) {
      const f = document.getElementById('bar-fill');
      const t = document.getElementById('count-t');
      if (f) f.style.width = `${(frac * 100).toFixed(1)}%`;
      const mo = document.getElementById('more-open');
      const rest = store.open.size - 1;
      if (mo && !store.pinned) mo.textContent = rest > 0 ? `${rest} other call${rest === 1 ? '' : 's'} open on the reef — click a creature or a stamp to read its card.` : '';
      if (t) t.textContent = mmss(left);
    }
  }

  /** a note as written, with the traits that differ from this sighting marked */
  private noteHtml(text: string, sighting: string | undefined): { html: string; marked: boolean } {
    const p = noteParts(text);
    if (!p) return { html: esc(text.replace(/^Specimen /, '')), marked: false };
    const traits = sighting ? traitDiff(p.species, sighting) : null;
    const marked = !!traits?.some((t) => t.some((x) => x.diff));
    const sp = traits ? traits.map((t) => t.map(({ w, diff }) => (diff ? `<mark class="diff">${esc(w)}</mark>` : esc(w))).join(' ')).join(', ') : esc(p.species);
    return {
      html: `<span class="slip-id">${esc(p.id)}</span><span class="slip-sep"> · </span><span class="slip-sp">${sp}</span><span class="slip-sep"> · </span><span class="slip-res">${esc(p.clause)}</span>`,
      marked,
    };
  }

  private renderSlips(r: Round) {
    const take = r.cited_note_ids.slice(0, 3);
    let body: string;
    let anyMarked = false;
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
          const note = info ? this.noteHtml(info.text, r.species) : null;
          if (note?.marked) anyMarked = true;
          return `<article class="slip">
            <p class="slip-text">${note ? note.html : `<span class="mono">${esc(id)}</span> — note text not loaded`}</p>
            <p class="slip-meta"><span>distance <b class="mono">${d !== undefined ? d.toFixed(3) : '—'}</b></span>
              <span>written ${ageMs !== null ? ago(ageMs) + ' before the call' : '—'}</span>
              <span class="slip-out">${esc(out)}</span>
              ${where ? `<span class="slip-where">${esc(where)}${info?.blob_id ? ' · <span class="mono">' + esc(short(info.blob_id, 8, 4)) + '</span>' : ''}</span>` : ''}</p>
          </article>`;
        })
        .join('');
    }
    const thin = r.call === 'abstain' && take.length > 0;
    if (thin) body = `<p class="slip slip--empty">Too little evidence: these notes add up to fewer than ${r.min_evidence ?? 2} weighted observations, so the naturalist abstained and reported the base rate (${pct(r.p_base)}).</p>` + body;
    const key = anyMarked ? `<p class="slips-key"><mark class="diff">Marked</mark> words are where a note differs from this sighting; the rest match.</p>` : '';
    const more = r.cited_note_ids.length > 3 ? `<p class="slips-more">+ ${r.cited_note_ids.length - 3} more notes within reach ${thin ? 'were also recalled' : 'also voted'}.</p>` : '';
    this.slips.innerHTML = `<h2 id="slips-h" class="sec-h">Notes it cited <span class="sec-sub">(${r.cited_note_ids.length} within reach)</span></h2>${key}${body}${more}`;
  }

  // ---------------------------------------------------------------- scorecard

  private cellRow(label: string, c: Cell): string {
    if (!c.n) return `<tr><th scope="row">${label}</th><td colspan="4" class="muted">no resolved rounds yet</td></tr>`;
    const vals = [c.brier_memory, c.brier_base, c.brier_freq];
    const best = Math.min(...(vals.filter((x): x is number => x !== null) as number[]));
    const cellHtml = (x: number | null) =>
      `<td><a class="num ${x === best ? 'num--best' : ''}" href="${esc(store.status?.csv_url ?? 'data/rounds.csv')}" title="Every number is derived from rounds.csv" target="_blank" rel="noopener">${b4(x)}</a></td>`;
    return `<tr><th scope="row">${label}</th><td class="mono">${fmtN(c.n)}</td>${vals.map(cellHtml).join('')}</tr>`;
  }

  private skill(c: Cell, who: string): string {
    if (c.skill_vs_base === null) return '';
    const s = c.skill_vs_base * 100;
    const subject = who ? `${who}: memory` : 'Memory';
    return s >= 0 ? `${subject} beats the base rate by ${s.toFixed(1)}%.` : `${subject} trails the base rate by ${Math.abs(s).toFixed(1)}% — reported as logged.`;
  }

  private sparkline(): string {
    const hist = store.history;
    const { mem, base } = cumulative(hist);
    if (mem.length < 3) return `<p class="muted">Curve appears after 3 resolved rounds.</p>`;
    const W = 320, H = 72, pad = 5;
    const all = [...mem, ...base];
    const lo = Math.min(...all), hi = Math.max(...all);
    const sx = (i: number) => pad + (i / (mem.length - 1)) * (W - 2 * pad);
    const sy = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
    const line = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    const ref = 0.25 > lo && 0.25 < hi;
    const where = store.status?.mode === 'live' ? 'the logger has resolved' : 'in this replay';
    const src = rowsSource(hist);
    return `<figure class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cumulative Brier score over the ${mem.length} rounds ${where}: memory ends at ${mem[mem.length - 1]!.toFixed(3)}, base rate at ${base[base.length - 1]!.toFixed(3)}">
      ${ref ? `<path d="M0,${sy(0.25).toFixed(1)}H${W}" stroke="#F2EAD3" stroke-opacity=".32" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>` : ''}
      <path d="${line(base)}" fill="none" stroke="#8FAAA4" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <path d="${line(mem)}" fill="none" stroke="#D4A83A" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
      <figcaption><i class="swatch swatch--mem"></i>memory <i class="swatch swatch--base"></i>base rate — cumulative Brier over the <b>${fmtN(mem.length)}</b> rounds ${where}${src ? ` (${esc(src)})` : ''}, oldest to newest; lower is better${ref ? '. Dashed: 0.25, what always saying 50% scores' : ''}.</figcaption></figure>`;
  }

  /** what-if numbers for the judge controls; pure function of store state */
  private judgeState(): { dmax: number; maxD: number; whatif: string } {
    const H = store.status?.horizon_min ?? 15;
    const hist = store.history;
    const dists = hist.flatMap((r) => r.cited_distances);
    const dmax = dists.length ? Math.ceil(Math.max(...dists) * 100) / 100 : 0.3;
    const maxD = store.maxD ?? dmax;
    const where = store.status?.mode === 'live' ? 'from the logger' : 'in this replay';
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
        whatif += `<p class="whatif">What if the naturalist were stricter (maxDistance ${store.maxD.toFixed(2)})? It would still cite notes on <b class="mono">${fmtN(called)}</b> of the <b class="mono">${fmtN(n)}</b> rounds ${where}. Brier: stricter memory <b class="mono">${b4(sm / n)}</b> · logged memory <b class="mono">${b4(sl / n)}</b> · base rate <b class="mono">${b4(sb / n)}</b>. Recomputed in your browser from the logged citations — the calls themselves are unchanged.</p>`;
      }
      if (horizonDiffers) {
        const k = hist.map((r) => movedWithin(r, store.horizon)).filter((x): x is number => x !== null);
        const y = k.reduce<number>((a, b) => a + b, 0);
        whatif += `<p class="whatif">Re-asked at <b>${store.horizon} min</b>: <b class="mono">${fmtN(y)}</b> of <b class="mono">${fmtN(k.length)}</b> wallets ${where} moved within that time (${pct(y / (k.length || 1))}), re-derived from each resolving checkpoint's timestamp. Brier is not recomputed — every call was made for ${H} minutes.</p>`;
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
      this.scoreEl.innerHTML = `<h2 id="score-h" class="sec-h">Scorecard</h2><p class="muted">Loading the scorecard…</p>`;
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
    const nv = card.never_seen;
    const csv = esc(store.status?.csv_url ?? 'data/rounds.csv');
    const verdictLine = this.skill(nv, '');
    this.strip.innerHTML = nv.n
      ? `<p class="strip-h"><b>Never-seen wallets</b> <span>N <span class="mono">${fmtN(nv.n)}</span></span>${hasHead ? '' : ' <span class="tag tag--dev">Dev data</span>'}</p>
        <p class="strip-nums"><span>memory <a class="num ${nv.brier_memory! <= Math.min(nv.brier_base!, nv.brier_freq!) ? 'num--best' : ''}" href="${csv}" target="_blank" rel="noopener">${b4(nv.brier_memory)}</a></span> <span>base rate <a class="num" href="${csv}" target="_blank" rel="noopener">${b4(nv.brier_base)}</a></span> <span>frequency <a class="num" href="${csv}" target="_blank" rel="noopener">${b4(nv.brier_freq)}</a></span></p>
        ${verdictLine ? `<p class="strip-v">${esc(verdictLine)} Brier score, lower is better.</p>` : ''}`
      : '';
    this.scoreEl.innerHTML = `
      <h2 id="score-h" class="sec-h">Scorecard</h2>
      <p class="score-tag">${label}</p>
      <div class="table-wrap"><table class="scoretable">
        <thead><tr><th scope="col"><span class="sr-only">Group</span></th><th scope="col">N</th><th scope="col">Memory</th><th scope="col">Base rate</th><th scope="col">Frequency table</th></tr></thead>
        <tbody>${this.cellRow('Never-seen wallets', card.never_seen)}${this.cellRow('All rounds', card.all)}</tbody>
      </table></div>
      <p class="skill">${esc(this.skill(card.all, 'All rounds'))} <span class="muted">Brier: lower is better; always saying 50% scores 0.25. Click any number for rounds.csv.</span></p>
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
