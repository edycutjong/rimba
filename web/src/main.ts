import './style.css';
import { howHtml } from './how';
import { Notebook } from './notebook';
import { ReefPage, reefHtml } from './reefpage';
import { LiveSource, ReplaySource } from './sources';
import { store } from './state';
import type { Sink, SourceStatus } from './types';
import { esc } from './fmt';

const main = document.getElementById('main')!;
main.innerHTML = `<section id="p-reef" data-page="reef">${reefHtml()}</section><section id="p-notebook" data-page="notebook" hidden></section><section id="p-how" data-page="how" hidden>${howHtml()}</section>`;

const ticker = document.getElementById('ticker')!;
const badge = document.getElementById('badge')!;
const reef = new ReefPage();
const notebook = new Notebook(document.getElementById('p-notebook')!);

function renderStatus(s: SourceStatus) {
  const tatum = s.network_source === 'tatum';
  const via = tatum ? 'Sui mainnet via Tatum gRPC' : 'Sui mainnet, public fullnode';
  const verb = s.mode === 'live' ? 'Live from' : 'Replay of';
  ticker.innerHTML = `${verb} ${esc(via)}${s.checkpoint ? ` · checkpoint <span class="mono">#${esc(s.checkpoint)}</span>` : ''}${s.note ? ` · <span class="ticker-note">${esc(s.note)}</span>` : ''}`;
  const dev = s.network_source !== 'tatum' || (s.memory !== null && s.memory !== 'walrus');
  document.getElementById('devpill')!.hidden = !dev;
  if (s.mode === 'live') {
    badge.textContent = 'LIVE';
    badge.className = 'badge badge--live';
    badge.title = 'Streaming from the local logger server';
  } else {
    badge.textContent = `REPLAY ${s.speed ?? 10}×`;
    badge.className = 'badge badge--replay';
    badge.title = `Recorded ${s.generated_at ?? ''} — played back at ${s.speed ?? 10}× speed`;
  }
}

const sink: Sink = {
  onCall: (r, instant) => reef.onCall(r, instant),
  onResolution: (r, instant) => reef.onResolution(r, instant),
  onNotes: (n) => {
    Object.assign(store.notes, n);
    reef.tick();
  },
  onScore: (s) => {
    store.score = s;
    reef.renderScore();
  },
  onStatus: (s) => {
    store.status = s;
    renderStatus(s);
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
  const h = location.hash.replace(/^#\/?/, '') || 'reef';
  const name = (routes as readonly string[]).includes(h) ? h : 'reef';
  for (const r of routes) document.getElementById(`p-${r}`)!.hidden = r !== name;
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => {
    const on = a.dataset.route === name;
    a.classList.toggle('is-on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (name === 'notebook') notebook.render();
  const titles = { reef: 'Reef', notebook: 'Notebook', how: 'How it works' } as const;
  document.title = `${titles[name as keyof typeof titles]} — RIMBA`;
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);
route();

// ---------------------------------------------------------------- source
const q = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const liveParam = q.get('live');
const wantLive = liveParam !== null || (isLocal && q.get('replay') === null);

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
  await new ReplaySource(sink).start();
}
boot().catch((e) => {
  ticker.textContent = `Could not load data: ${String(e)}`;
  badge.textContent = 'OFFLINE';
});
setInterval(() => reef.tick(), 250);
