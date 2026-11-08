import { amountOf, coinOf, pct, verdict, type Coin } from './fmt';
import type { Round } from './types';

const COLORS = { open: '#D4A83A', right: '#5FD3A8', wrong: '#FF7A5C', abstain: '#8FAAA4', ink: '#F2EAD3', rule: '#24474D', bg: '#0D2B30', deep: '#0a2226' };
const TAU = Math.PI * 2;

interface Creature {
  r: Round;
  coin: Coin;
  hx: number; // home position 0..1 (stable per sender: a returning wallet surfaces in the same patch of reef)
  hy: number;
  rad0: number; // radius on a full-size reef; drawn × the stage scale
  phase: number;
  born: number; // real ms
  resolvedAt: number | null; // real ms
  v: ReturnType<typeof verdict>;
  drift: number;
}

const FADE_MS = 22_000;
// a full-size reef (the desktop stage); smaller stages draw every creature smaller so a phone shows specimens, not a blob
const REF_AREA = 840 * 720;
const SNOW = 34;
const GRASS = 9;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

// presentation scale only (creature size ∝ log of amount over the logger threshold for that coin) — never shown as a number
const THRESH: Record<Coin, number> = { SUI: 282.91, USDC: 70, other: 1 };

export class ReefCanvas {
  private ctx: CanvasRenderingContext2D;
  private creatures = new Map<string, Creature>();
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private scale = 1;
  private backdrop: HTMLCanvasElement | null = null;
  private selected: string | null = null;
  private hover: string | null = null;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');
  private visible = true;
  onPick: (id: string) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    document.addEventListener('visibilitychange', () => {
      this.visible = !document.hidden;
      if (this.visible) this.loop();
    });
    canvas.addEventListener('pointermove', (e) => {
      const hit = this.hit(e);
      const id = hit?.r.round_id ?? null;
      if (id !== this.hover) {
        this.hover = id;
        canvas.style.cursor = id ? 'pointer' : 'default';
        if (this.reduce.matches) this.draw(performance.now());
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
    });
    canvas.addEventListener('click', (e) => {
      const hit = this.hit(e);
      if (hit) this.onPick(hit.r.round_id);
    });
    this.resize();
    this.loop();
  }

  select(id: string | null) {
    this.selected = id;
    if (this.reduce.matches) this.draw(performance.now());
  }

  add(r: Round, instant: boolean, nowReal = performance.now()) {
    if (this.creatures.has(r.round_id)) return;
    const coin = coinOf(r.coin_type);
    const ratio = Math.max(1, amountOf(r) / THRESH[coin]);
    const rad0 = Math.min(46, 15 + Math.log2(ratio) * 6);
    const hx = 0.08 + 0.84 * hash(r.sender);
    const hy = 0.12 + 0.72 * hash(r.sender + 'y');
    this.creatures.set(r.round_id, {
      r, coin, hx, hy, rad0, phase: hash(r.round_id) * 6.28, born: instant ? nowReal - 3_000 : nowReal, resolvedAt: null, v: null,
      drift: 0.6 + hash(r.round_id + 'd') * 0.8,
    });
    this.prune();
    if (this.reduce.matches) this.draw(nowReal);
  }

  resolve(r: Round, instant: boolean, nowReal = performance.now()) {
    let c = this.creatures.get(r.round_id);
    if (!c) {
      // history that resolved in the past needs no creature
      if (instant) return;
      this.add({ ...r, resolution: null }, true, nowReal);
      c = this.creatures.get(r.round_id)!;
    }
    c.r = r;
    c.v = verdict(r);
    c.resolvedAt = instant ? nowReal - FADE_MS : nowReal;
    if (this.reduce.matches) this.draw(nowReal);
  }

  count(): { open: number; total: number } {
    let open = 0;
    for (const c of this.creatures.values()) if (c.resolvedAt === null) open++;
    return { open, total: this.creatures.size };
  }

  private prune() {
    if (this.creatures.size <= 60) return;
    const old = [...this.creatures.values()].filter((c) => c.resolvedAt !== null).sort((a, b) => a.resolvedAt! - b.resolvedAt!);
    for (const c of old.slice(0, this.creatures.size - 60)) this.creatures.delete(c.r.round_id);
  }

  private resize() {
    const p = this.canvas.parentElement!;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(200, p.clientWidth);
    this.h = Math.max(160, p.clientHeight);
    this.scale = Math.max(0.5, Math.min(1, Math.sqrt((this.w * this.h) / REF_AREA)));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.backdrop = this.paintBackdrop();
    this.draw(performance.now());
  }

  /** Everything that does not move, painted once per resize: the water column, light from the surface,
   * the vignette of depth and two layers of seabed. */
  private paintBackdrop(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    const { w, h } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const water = g.createLinearGradient(0, 0, 0, h);
    water.addColorStop(0, '#12383e');
    water.addColorStop(1, COLORS.deep);
    g.fillStyle = water;
    g.fillRect(0, 0, w, h);
    const surface = g.createRadialGradient(w * 0.5, -h * 0.3, 0, w * 0.5, -h * 0.3, h * 1.05);
    surface.addColorStop(0, 'rgba(242,234,211,0.075)');
    surface.addColorStop(1, 'rgba(242,234,211,0)');
    g.fillStyle = surface;
    g.fillRect(0, 0, w, h);
    const depth = g.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.35, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
    depth.addColorStop(0, 'rgba(10,34,38,0)');
    depth.addColorStop(1, 'rgba(10,34,38,0.55)');
    g.fillStyle = depth;
    g.fillRect(0, 0, w, h);
    // seabed: a far ridge in the rule colour, a near one in deep water, both smooth curves through seeded points
    const ridge = (base: number, amp: number, seed: string, fill: string, alpha: number) => {
      const n = Math.max(6, Math.round(w / 90));
      const pts = Array.from({ length: n + 1 }, (_, i) => [(i / n) * w, h - base - hash(seed + i) * amp] as const);
      g.save();
      g.globalAlpha = alpha;
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, pts[0]![1]);
      for (let i = 1; i <= n; i++) {
        const [x0, y0] = pts[i - 1]!;
        const [x1, y1] = pts[i]!;
        g.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      }
      g.lineTo(w, pts[n]![1]);
      g.lineTo(w, h);
      g.closePath();
      g.fill();
      g.restore();
    };
    ridge(22, 26, 'far', COLORS.rule, 0.5);
    ridge(6, 14, 'near', COLORS.deep, 0.95);
    // sand stipple on the near ridge, as before
    g.fillStyle = COLORS.rule;
    g.globalAlpha = 0.6;
    for (let i = 0; i < 80; i++) g.fillRect(hash('s' + i) * w, h - 4 - hash('t' + i) * 14, 2, 2);
    g.globalAlpha = 1;
    return c;
  }

  private pos(c: Creature, t: number): [number, number] {
    const m = this.reduce.matches ? 0 : 1;
    const x = c.hx * this.w + Math.sin(t / 2600 * c.drift + c.phase) * 18 * m;
    const y = c.hy * this.h + Math.cos(t / 3100 * c.drift + c.phase * 1.3) * 12 * m + (c.resolvedAt !== null ? -((t - c.resolvedAt) / FADE_MS) * 14 * m : 0);
    return [x, y];
  }

  private alpha(c: Creature, t: number): number {
    if (c.resolvedAt === null) return Math.min(1, (t - c.born) / 700 + 0.15);
    return Math.max(0, 1 - (t - c.resolvedAt) / FADE_MS);
  }

  private hit(e: PointerEvent | MouseEvent): Creature | null {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top, t = performance.now();
    let best: Creature | null = null, bd = Infinity;
    for (const c of this.creatures.values()) {
      if (this.alpha(c, t) <= 0.05) continue;
      const [x, y] = this.pos(c, t);
      const d = Math.hypot(mx - x, my - y);
      if (d < Math.max(c.rad0 * this.scale + 6, 22) && d < bd) { best = c; bd = d; }
    }
    return best;
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.visible) return;
    this.draw(performance.now());
    if (!this.reduce.matches) this.raf = requestAnimationFrame(this.loop);
    else this.raf = window.setTimeout(this.loop, 1_000) as unknown as number;
  };

  private draw(t: number) {
    const { ctx, w, h, dpr } = this;
    const still = this.reduce.matches;
    const tm = still ? 0 : t;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.backdrop) ctx.drawImage(this.backdrop, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // light shafts
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = COLORS.ink;
    for (let i = 0; i < 4; i++) {
      const x = w * (0.12 + i * 0.26) + Math.sin(tm / 5000 + i) * 18;
      ctx.beginPath();
      ctx.moveTo(x - 20, 0); ctx.lineTo(x + 20, 0); ctx.lineTo(x + 80, h); ctx.lineTo(x - 60, h); ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // seagrass on the seabed, leaning with the swell
    ctx.save();
    ctx.strokeStyle = COLORS.abstain;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, 2 * this.scale);
    for (let i = 0; i < GRASS; i++) {
      const x0 = (0.05 + 0.9 * hash('g' + i)) * w;
      const y0 = h - 5 - hash('gy' + i) * 8;
      for (let b = 0; b < 3; b++) {
        const tall = (16 + hash('gh' + i + b) * 26) * this.scale;
        const lean = (b - 1) * 5 * this.scale + Math.sin(tm / 2300 + i + b * 0.7) * 5 * this.scale;
        ctx.globalAlpha = 0.16 + 0.08 * b;
        ctx.beginPath();
        ctx.moveTo(x0 + (b - 1) * 4, y0);
        ctx.quadraticCurveTo(x0 + (b - 1) * 4 + lean * 0.4, y0 - tall * 0.55, x0 + (b - 1) * 4 + lean, y0 - tall);
        ctx.stroke();
      }
    }
    ctx.restore();
    // marine snow: slow specks sinking through the column
    ctx.save();
    ctx.fillStyle = COLORS.ink;
    for (let i = 0; i < SNOW; i++) {
      const sink = 0.004 + hash('v' + i) * 0.006;
      const y = (hash('n' + i) * h + tm * sink) % h;
      const x = hash('m' + i) * w + Math.sin(tm / 3200 + i) * 6;
      const s = 1 + hash('z' + i) * 1.4;
      ctx.globalAlpha = 0.07 + hash('a' + i) * 0.14;
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
    const list = [...this.creatures.values()].sort((a, b) => b.rad0 - a.rad0);
    for (const c of list) {
      const a = this.alpha(c, t);
      if (a <= 0.01) continue;
      this.drawCreature(c, t, a);
    }
    // label of hovered / selected: catalogue number, coin and the call, with a tick down to the specimen
    for (const id of [this.hover, this.selected]) {
      const c = id ? this.creatures.get(id) : null;
      if (!c) continue;
      const [x, y] = this.pos(c, t);
      const rad = c.rad0 * this.scale;
      ctx.font = '500 13px "IBM Plex Mono", monospace';
      const label = this.label(c);
      const tw = ctx.measureText(label).width;
      const lx = Math.min(w - tw - 14, Math.max(4, x - tw / 2 - 5)), ly = Math.max(4, y - rad - 30);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(lx, ly, tw + 10, 20);
      if (ly + 20 < y - rad) {
        ctx.fillRect(Math.min(Math.max(x, lx + 4), lx + tw + 6) - 0.75, ly + 20, 1.5, Math.max(0, y - rad - ly - 24));
      }
      ctx.fillStyle = COLORS.bg;
      ctx.fillText(label, lx + 5, ly + 14);
    }
  }

  private label(c: Creature): string {
    const r = c.r;
    const call = r.call === 'abstain' ? 'ABSTAIN' : `${r.call.toUpperCase()} ${pct(r.call === 'yes' ? r.p_memory : 1 - r.p_memory)}`;
    const v = c.v === 'right' ? ' · RIGHT' : c.v === 'wrong' ? ' · WRONG' : '';
    return `No. ${String(r.n).padStart(4, '0')} · ${c.coin} · ${call}${v}`;
  }

  private drawCreature(c: Creature, t: number, a: number) {
    const { ctx } = this;
    const [x, y] = this.pos(c, t);
    const open = c.resolvedAt === null;
    const col = open ? COLORS.open : c.v === 'right' ? COLORS.right : c.v === 'wrong' ? COLORS.wrong : COLORS.abstain;
    const still = this.reduce.matches;
    const pulse = open && !still ? 0.5 + 0.5 * Math.sin(t / 380 + c.phase) : open ? 0.6 : 0;
    const r = c.rad0 * this.scale * (open ? 1 + pulse * 0.06 : 1);
    const lw = Math.max(1.2, 2 * this.scale);
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = a;
    // glow while the call is open, and briefly when it resolves
    if (open || c.resolvedAt !== null && t - c.resolvedAt < 2_500) {
      const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
      glow.addColorStop(0, col + (open ? '66' : '88'));
      glow.addColorStop(1, col + '00');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    const wob = still ? 0 : Math.sin(t / 420 + c.phase);
    if (c.coin === 'SUI') this.jellyfish(r, wob, a, lw);
    else if (c.coin === 'USDC') this.ray(r, wob, a, lw);
    else this.fish(r, wob, a);
    // eye-dot: dark centre so the creature reads as a specimen, not a blob
    ctx.globalAlpha = a;
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath(); ctx.arc(c.coin === 'other' ? r * 0.6 : 0, c.coin === 'SUI' ? -r * 0.3 : 0, Math.max(2, r * 0.1), 0, TAU); ctx.fill();
    if (this.selected === c.r.round_id) {
      ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(0, 0, r * 1.5 + 4, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /** SUI: a bell with a rim and a sheen, two frilled oral arms and five trailing tentacles */
  private jellyfish(r: number, wob: number, a: number, lw: number) {
    const { ctx } = this;
    ctx.globalAlpha = a * 0.8;
    ctx.lineWidth = lw * 0.8;
    for (let i = -2; i <= 2; i++) {
      const x0 = i * r * 0.34;
      ctx.beginPath(); ctx.moveTo(x0, r * 0.22);
      ctx.bezierCurveTo(x0 + wob * 6, r * 0.8, x0 - wob * 6, r * 1.2, x0 + wob * 4, r * 1.7);
      ctx.stroke();
    }
    ctx.globalAlpha = a * 0.9;
    ctx.lineWidth = lw * 1.7;
    for (const k of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(k * r * 0.1, r * 0.24);
      ctx.quadraticCurveTo(k * r * 0.24 + wob * 3, r * 0.62, k * r * 0.07 - wob * 2, r * 1.0);
      ctx.stroke();
    }
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.quadraticCurveTo(r * 0.6, r * 0.35, 0, r * 0.3); ctx.quadraticCurveTo(-r * 0.6, r * 0.35, -r, 0); ctx.fill();
    // the rim, where the bell turns under
    ctx.globalAlpha = a * 0.3;
    ctx.strokeStyle = COLORS.bg;
    ctx.lineWidth = Math.max(1, lw * 0.85);
    ctx.beginPath(); ctx.moveTo(-r * 0.9, r * 0.07); ctx.quadraticCurveTo(-r * 0.5, r * 0.29, 0, r * 0.23); ctx.quadraticCurveTo(r * 0.5, r * 0.29, r * 0.9, r * 0.07); ctx.stroke();
    // light on the crown
    ctx.globalAlpha = a * 0.24;
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath(); ctx.ellipse(-r * 0.36, -r * 0.56, r * 0.3, r * 0.12, -0.6, 0, TAU); ctx.fill();
  }

  /** USDC: a manta seen from above — cephalic fins, swept wings that beat, a whip tail and a pale dorsal ridge */
  private ray(r: number, wob: number, a: number, lw: number) {
    const { ctx } = this;
    const f = wob * 0.14;
    ctx.globalAlpha = a * 0.9;
    ctx.lineWidth = Math.max(1, lw * 0.75);
    ctx.beginPath(); ctx.moveTo(0, r * 0.55); ctx.quadraticCurveTo(wob * 7, r * 1.35, wob * 4, r * 2.1); ctx.stroke();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.4);
    ctx.quadraticCurveTo(r * 0.12, -r * 0.64, r * 0.25, -r * 0.5);
    ctx.quadraticCurveTo(r * 0.85, -r * (0.42 + f), r * 1.34, r * (0.1 - f));
    ctx.quadraticCurveTo(r * 0.7, r * 0.14, r * 0.22, r * 0.5);
    ctx.quadraticCurveTo(r * 0.1, r * 0.66, 0, r * 0.62);
    ctx.quadraticCurveTo(-r * 0.1, r * 0.66, -r * 0.22, r * 0.5);
    ctx.quadraticCurveTo(-r * 0.7, r * 0.14, -r * 1.34, r * (0.1 - f));
    ctx.quadraticCurveTo(-r * 0.85, -r * (0.42 + f), -r * 0.25, -r * 0.5);
    ctx.quadraticCurveTo(-r * 0.12, -r * 0.64, 0, -r * 0.4);
    ctx.fill();
    ctx.globalAlpha = a * 0.26;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = Math.max(1, lw * 0.7);
    ctx.beginPath(); ctx.moveTo(0, -r * 0.28); ctx.quadraticCurveTo(0, r * 0.1, 0, r * 0.46); ctx.stroke();
  }

  /** other coins: a fish with a forked tail, a dorsal fin, a gill line and a flank sheen */
  private fish(r: number, wob: number, a: number) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(-r * 0.95, 0);
    ctx.lineTo(-r * 1.75, -r * 0.55 + wob * 3);
    ctx.quadraticCurveTo(-r * 1.42, wob * 2, -r * 1.75, r * 0.55 + wob * 3);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.48); ctx.quadraticCurveTo(-r * 0.15, -r * 1.02, r * 0.28, -r * 0.56); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.15, r * 0.62, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = a * 0.3;
    ctx.strokeStyle = COLORS.bg;
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.beginPath(); ctx.arc(r * 0.5, 0, r * 0.4, Math.PI * 0.64, Math.PI * 1.36); ctx.stroke();
    ctx.globalAlpha = a * 0.2;
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath(); ctx.ellipse(r * 0.02, -r * 0.27, r * 0.56, r * 0.11, 0, 0, TAU); ctx.fill();
  }
}
