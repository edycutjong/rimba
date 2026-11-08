import './style.css';
import { howHtml, wireHow } from './how';
import { Notebook } from './notebook';
import { ReefPage } from './reefpage';
import { LiveSource, ReplaySource } from './sources';
import { store } from './state';
import type { ScoreSet, Sink, SourceStatus } from './types';
import { esc, fmtN, fmtWhen, snapshotPath } from './fmt';

// the reef (intro and grid) is static HTML, painted before any script runs; the notebook and the explainer are added here
const main = document.getElementById('main')!;
main.insertAdjacentHTML('beforeend', `<section id="p-notebook" data-page="notebook" hidden></section><section id="p-how" data-page="how" hidden>${howHtml()}</section>`);
wireHow(document.getElementById('p-how')!);

const ticker = document.getElementById('ticker')!;
const badge = document.getElementById('badge')!;
const reef = new ReefPage();
const notebook = new Notebook(document.getElementById('p-notebook')!);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** what this view's rows came through, read from the rows themselves (never from what is configured now) */
function sourceSentence(s: SourceStatus): string {
  const tatum = s.network_source === 'tatum';
  const walrus = s.memory === 'walrus';
  if (tatum && walrus) return 'This view came through Tatum’s stream with Walrus Memory recall.';
  const stream = tatum ? 'Tatum’s stream' : 'Sui’s public fullnode';
  const memory = walrus ? 'Walrus Memory' : s.memory === 'none' ? 'no memory at all' : 'a local memory stand-in';
  return `This view is development data: ${stream} with ${memory} — never the headline.`;
}

function renderStatus(s: SourceStatus) {
  const tatum = s.network_source === 'tatum';
  const via = tatum ? 'Sui mainnet via Tatum gRPC' : 'Sui mainnet, public fullnode';
  const verb = s.mode === 'live' ? 'Live from' : 'Replay of';
  ticker.innerHTML = `${verb} ${esc(via)}${s.checkpoint ? ` · checkpoint <span class="mono">#${esc(s.checkpoint)}</span>` : ''}${s.note ? ` · <span class="ticker-note">${esc(s.note)}</span>` : ''}`;
  ticker.className = `ticker ${s.mode === 'live' ? 'is-live' : 'is-replay'}`;
  const dev = s.network_source !== 'tatum' || (s.memory !== null && s.memory !== 'walrus');
  document.getElementById('devpill')!.hidden = !dev;
  const src = document.getElementById('reef-src');
  const line = s.network_source === null ? null : sourceSentence(s); // unknown until the first row arrives: keep the static sentence
  if (src && line && src.textContent !== line) src.textContent = line;
  const when = document.getElementById('fl-when')!;
  const whenText = s.mode === 'live' ? 'live from the logger' : s.generated_at ? `${archived ? 'archived ' : ''}snapshot of ${fmtWhen(s.generated_at)}` : '';
  if (when.textContent !== whenText) when.textContent = whenText;
  const rec = document.getElementById('colo-rec')!;
  const recText = s.mode === 'live' ? 'Streaming live from the logger on this machine' : s.generated_at ? `This replay was recorded ${fmtWhen(s.generated_at)}` : rec.textContent;
  if (rec.textContent !== recText) rec.textContent = recText;
  for (const id of ['fl-rounds-a', 'colo-csv']) document.getElementById(id)?.setAttribute('href', s.csv_url);
  if (s.mode === 'live') {
    badge.textContent = 'LIVE';
    badge.className = 'badge badge--live';
    badge.title = 'Streaming from the local logger server';
  } else {
    badge.textContent = `REPLAY ${s.speed ?? 10}×${archived ? ' · ARCHIVE' : ''}`;
    badge.className = 'badge badge--replay';
    badge.title = `${archived ? `Archived snapshot ${archived}, recorded` : 'Recorded'} ${s.generated_at ?? ''} — played back at ${s.speed ?? 10}× speed`;
  }
}

// ---------------------------------------------------------------- field log (receipts)
let counted = false;
function countUp(el: HTMLElement, to: number, ms = 1_100) {
  if (reduceMotion || to < 20) {
    el.textContent = fmtN(to);
    return;
  }
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = fmtN(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderFieldLog(s: ScoreSet) {
  const rounds = document.getElementById('fl-rounds')!;
  const head = document.getElementById('fl-head')!;
  const resolved = s.all_rows.counts.resolved;
  if (!counted) countUp(rounds, resolved);
  else rounds.textContent = fmtN(resolved);
  head.textContent = fmtN(s.headline.counts.resolved);
  counted = true;
}

const sink: Sink = {
  onCall: (r, instant) => {
    reef.onCall(r, instant);
    if (deepRound && r.round_id === deepRound) reef.pin(deepRound); // a linked round keeps the card until the visitor lets go
  },
  onResolution: (r, instant) => reef.onResolution(r, instant),
  onNotes: (n) => {
    Object.assign(store.notes, n);
    reef.tick();
  },
  onScore: (s) => {
    store.score = s;
    reef.renderScore();
    renderFieldLog(s);
  },
  onStatus: (s) => {
    const first = !store.status || store.status.mode !== s.mode;
    store.status = s;
    renderStatus(s);
    // the scorecard and the notebook name their rows ("in this replay", rounds.csv total, which key is missing) from the status
    if (first) reef.renderScore();
    if (first && !document.getElementById('p-notebook')!.hidden) notebook.render();
  },
  onHistory: (rs) => {
    store.history = rs;
    for (const r of rs) store.byId.set(r.round_id, store.byId.get(r.round_id) ?? r);
    reef.renderScore();
    if (!document.getElementById('p-notebook')!.hidden) notebook.render();
  },
};

// ---------------------------------------------------------------- routing
const routes = ['reef', 'notebook', 'how'] as const;
function route() {
  // in-page anchors (the skip link's #main) are not routes: leave the current page alone
  if (location.hash && !location.hash.startsWith('#/')) return;
  const [h = '', part] = location.hash.replace(/^#\/?/, '').split('/');
  const name = (routes as readonly string[]).includes(h) ? h : 'reef';
  document.documentElement.dataset.route = name;
  for (const r of routes) document.getElementById(`p-${r}`)!.hidden = r !== name;
  document.querySelectorAll<HTMLAnchorElement>('.nav a[data-route]').forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle('is-on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (name === 'notebook') notebook.render();
  const titles = { reef: 'Reef', notebook: 'Notebook', how: 'How it works' } as const;
  document.title = `${titles[name as keyof typeof titles]} — RIMBA`;
  // #/how/honest (the DEV DATA pill) opens the explainer at its honesty section
  const target = name === 'how' && part === 'honest' ? document.getElementById('how-honest') : null;
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  } else window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);
route();

// ---------------------------------------------------------------- source
const q = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const liveParam = q.get('live');
const deepRound = q.get('round');
const snapPath = snapshotPath(q.get('snap'));
const archived = snapPath === 'data/snapshot.json' ? null : q.get('snap');
const wantLive = deepRound === null && archived === null && (liveParam !== null || (isLocal && q.get('replay') === null));

async function boot() {
  if (wantLive) {
    const base = liveParam && liveParam.startsWith('http') ? liveParam.replace(/\/$/, '') : isLocal && !liveParam ? '' : 'http://127.0.0.1:8787';
    const live = new LiveSource(sink, base);
    try {
      await live.start();
      return;
    } catch {
      live.stop();
      const rep = new ReplaySource(sink, import.meta.env.BASE_URL, 'logger not reachable — showing the recording');
      await rep.start();
      return;
    }
  }
  await new ReplaySource(sink, import.meta.env.BASE_URL, null, { focusId: deepRound, speed: Number(q.get('speed')) || null, snapshot: snapPath }).start();
}
boot()
  .then(() => reef.tick()) // one render after the history batch
  .catch((e) => {
    ticker.textContent = `Could not load data: ${String(e)}`;
    badge.textContent = 'OFFLINE';
    reef.fail(`Could not load the recording (${String(e)})`);
  });
setInterval(() => reef.tick(), 250);
