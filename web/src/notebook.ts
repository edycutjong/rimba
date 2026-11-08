import { catNo, coinOf, esc, fmtAmount, fmtN, pct, short, suiscanCheckpoint, suiscanTx, verdict } from './fmt';
import { store } from './state';
import type { Round } from './types';

const PAGE = 20;

export class Notebook {
  private page = 0;
  private neverOnly = false;
  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>('[data-page]');
      if (b && !b.hasAttribute('disabled')) {
        this.page = Number(b.dataset.page);
        this.render();
        el.querySelector<HTMLElement>('#nb-h')?.scrollIntoView({ block: 'start' });
      }
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'nb-never') {
        this.neverOnly = t.checked;
        this.page = 0;
        this.render();
        el.querySelector<HTMLInputElement>('#nb-never')?.focus();
      }
    });
  }

  /** "400 rounds in this replay · rounds.csv holds all 3,045" — both numbers come from the snapshot */
  private countLine(shown: number, total: number): string {
    const s = store.status;
    const where = s?.mode === 'live' ? 'from the logger' : 'in this replay';
    const head = this.neverOnly ? `<b>${fmtN(shown)}</b> of ${fmtN(total)} rounds ${where}` : `<b>${fmtN(total)}</b> resolved round${total === 1 ? '' : 's'} ${where}`;
    const all = s?.mode !== 'live' && s?.counts && s.counts.resolved_total > total ? ` · rounds.csv holds all ${fmtN(s.counts.resolved_total)}` : '';
    return `<span class="nb-count">${head}${all}</span>`;
  }

  render() {
    const all = store.history.slice().reverse();
    const rows = this.neverOnly ? all.filter((r) => !r.sender_seen_before) : all;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    this.page = Math.min(this.page, pages - 1);
    const slice = rows.slice(this.page * PAGE, this.page * PAGE + PAGE);
    const snap = new URLSearchParams(location.search).get('snap');
    const replayLink = store.status?.mode === 'replay' ? (id: string) => `?round=${encodeURIComponent(id)}${snap && /^\d{4}-\d{2}-\d{2}$/.test(snap) ? `&snap=${snap}` : ''}` : null;
    this.el.innerHTML = `
      <div class="doc">
        <p class="eyebrow">Plate II · Field notebook</p>
        <h1 id="nb-h" class="doc-h">Every resolved call, in order</h1>
        <p class="lede">Each row is one sighting: the call the naturalist wrote down, the chain's answer, and the notes it leaned on. Checkpoint links go to Suiscan so you can look the answer up yourself${replayLink ? '; “replay” plays the round again on the reef' : ''}.</p>
        <div class="nb-tools">
          <label class="chip chip--check"><input type="checkbox" id="nb-never" ${this.neverOnly ? 'checked' : ''}/><span>Never-seen wallets only</span></label>
          ${this.countLine(rows.length, all.length)}
          <a class="pill" href="${esc(store.status?.csv_url ?? 'data/rounds.csv')}" target="_blank" rel="noopener">rounds.csv ↗</a>
        </div>
        ${
          rows.length
            ? `<table class="nb" aria-labelledby="nb-h">
          <thead><tr><th scope="col">No.</th><th scope="col">Sighting</th><th scope="col">Call</th><th scope="col">Chain's answer</th><th scope="col">Notes cited</th><th scope="col">Verify</th></tr></thead>
          <tbody>${slice.map((r) => this.row(r, replayLink)).join('')}</tbody></table>`
            : '<p class="muted">No resolved rounds yet.</p>'
        }
        <nav class="pager" aria-label="Notebook pages">
          <button type="button" class="pill" data-page="${this.page - 1}" ${this.page === 0 ? 'disabled' : ''}>← Newer</button>
          <span class="muted">Page ${this.page + 1} of ${pages}</span>
          <button type="button" class="pill" data-page="${this.page + 1}" ${this.page >= pages - 1 ? 'disabled' : ''}>Older →</button>
        </nav>
      </div>`;
  }

  private row(r: Round, replayLink: ((id: string) => string) | null): string {
    const v = verdict(r);
    const res = r.resolution!;
    const ans = res.outcome === 1 ? 'moved again' : 'did not move';
    const call = r.call === 'abstain' ? `abstained (base ${pct(r.p_base)})` : `${r.call.toUpperCase()} ${pct(r.call === 'yes' ? r.p_memory : 1 - r.p_memory)}`;
    return `<tr>
      <td data-l="No."><span class="mono">${catNo(r.n).replace('No. ', '')}</span></td>
      <td data-l="Sighting"><span class="nb-species">${esc(r.species ?? '—')}</span><br/><span class="mono small">${esc(fmtAmount(r))} · ${coinOf(r.coin_type)} · ${r.sender_seen_before ? 'returning' : 'first-seen'} · <span class="nw">${esc(short(r.sender, 6, 4))}</span></span></td>
      <td data-l="Call">${esc(call)}</td>
      <td data-l="Chain's answer" class="nb-ans"><span class="mini-stamp mini-stamp--${v ?? 'none'}">${v === 'right' ? 'RIGHT' : v === 'wrong' ? 'WRONG' : 'NO CALL'}</span>${esc(ans)}</td>
      <td data-l="Notes cited">${r.cited_note_ids.length ? r.cited_note_ids.slice(0, 4).map((id) => `<span class="mono chipid">${esc(id.replace('No.', ''))}</span>`).join(' ') + (r.cited_note_ids.length > 4 ? ` <span class="muted">+${r.cited_note_ids.length - 4}</span>` : '') : '<span class="muted">none — abstained</span>'}</td>
      <td data-l="Verify"><span class="nb-links"><a class="link-quiet mono" href="${suiscanCheckpoint(res.resolving_checkpoint_seq)}" target="_blank" rel="noopener">#${esc(res.resolving_checkpoint_seq)} ↗</a><a class="link-quiet small" href="${suiscanTx(r.tx_digest)}" target="_blank" rel="noopener">transfer ↗</a>${replayLink ? `<a class="link-quiet small" href="${replayLink(r.round_id)}" aria-label="Replay ${catNo(r.n)} on the reef">replay</a>` : ''}</span></td>
    </tr>`;
  }
}
