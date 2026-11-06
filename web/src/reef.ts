import { amountOf, coinOf, verdict, type Coin } from './fmt';
import type { Round } from './types';

const COLORS = { open: '#D4A83A', right: '#5FD3A8', wrong: '#FF7A5C', abstain: '#8FAAA4', ink: '#F2EAD3', rule: '#24474D' };

interface Creature {
  r: Round;
  coin: Coin;
  hx: number; // home position 0..1 (stable per sender: a returning wallet surfaces in the same patch of reef)
  hy: number;
  rad: number;
  phase: number;
  born: number; // real ms
  resolvedAt: number | null; // real ms
  v: ReturnType<typeof verdict>;
  drift: number;
}

const FADE_MS = 22_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

const THRESH: Record<Coin, number> = { SUI: 282.91, USDC: 70, other: 1 };

export class ReefCanvas {
  private ctx: CanvasRenderingContext2D;
  private creatures = new Map<string, Creature>();
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
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
    const rad = Math.min(46, 15 + Math.log2(ratio) * 6);
    const hx = 0.08 + 0.84 * hash(r.sender);
    const hy = 0.12 + 0.72 * hash(r.sender + 'y');
    this.creatures.set(r.round_id, {
      r, coin, hx, hy, rad, phase: hash(r.round_id) * 6.28, born: instant ? nowReal - 3_000 : nowReal, resolvedAt: null, v: null,
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
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.draw(performance.now());
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
      if (d < Math.max(c.rad + 6, 22) && d < bd) { best = c; bd = d; }
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // water column
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#12383e');
    g.addColorStop(1, '#0a2226');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // light shafts
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = COLORS.ink;
    for (let i = 0; i < 4; i++) {
      const x = w * (0.12 + i * 0.26) + (this.reduce.matches ? 0 : Math.sin(t / 5000 + i) * 18);
      ctx.beginPath();
      ctx.moveTo(x - 20, 0); ctx.lineTo(x + 20, 0); ctx.lineTo(x + 80, h); ctx.lineTo(x - 60, h); ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // seabed stipple
    ctx.fillStyle = COLORS.rule;
    for (let i = 0; i < 70; i++) {
      ctx.globalAlpha = 0.5;
      ctx.fillRect(hash('s' + i) * w, h - 6 - hash('t' + i) * 26, 2, 2);
    }
    ctx.globalAlpha = 1;
    const list = [...this.creatures.values()].sort((a, b) => b.rad - a.rad);
    for (const c of list) {
      const a = this.alpha(c, t);
      if (a <= 0.01) continue;
      this.drawCreature(c, t, a);
    }
    // label of hovered / selected
    for (const id of [this.hover, this.selected]) {
      const c = id ? this.creatures.get(id) : null;
      if (!c) continue;
      const [x, y] = this.pos(c, t);
      ctx.font = '600 13px "IBM Plex Mono", monospace';
      const label = `No. ${String(c.r.n).padStart(4, '0')}`;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(w - tw - 14, Math.max(4, x - tw / 2 - 5)), ly = Math.max(4, y - c.rad - 28);
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(lx, ly, tw + 10, 20);
      ctx.fillStyle = '#0D2B30';
      ctx.fillText(label, lx + 5, ly + 14);
    }
  }

  private drawCreature(c: Creature, t: number, a: number) {
    const { ctx } = this;
    const [x, y] = this.pos(c, t);
    const open = c.resolvedAt === null;
    const col = open ? COLORS.open : c.v === 'right' ? COLORS.right : c.v === 'wrong' ? COLORS.wrong : COLORS.abstain;
    const still = this.reduce.matches;
    const pulse = open && !still ? 0.5 + 0.5 * Math.sin(t / 380 + c.phase) : open ? 0.6 : 0;
    const r = c.rad * (open ? 1 + pulse * 0.06 : 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = a;
    // glow while the call is open
    if (open || c.resolvedAt !== null && t - c.resolvedAt < 2_500) {
      const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
      glow.addColorStop(0, col + (open ? '66' : '88'));
      glow.addColorStop(1, col + '00');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, 6.3); ctx.fill();
    }
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    const wob = still ? 0 : Math.sin(t / 420 + c.phase);
    if (c.coin === 'SUI') {
      // jellyfish: bell + trailing tentacles
      ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.quadraticCurveTo(r * 0.6, r * 0.35, 0, r * 0.3); ctx.quadraticCurveTo(-r * 0.6, r * 0.35, -r, 0); ctx.fill();
      ctx.globalAlpha = a * 0.85;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(i * r * 0.36, r * 0.25);
        ctx.bezierCurveTo(i * r * 0.36 + wob * 6, r * 0.8, i * r * 0.36 - wob * 6, r * 1.2, i * r * 0.36 + wob * 4, r * 1.7);
        ctx.stroke();
      }
    } else if (c.coin === 'USDC') {
      // ray: diamond wings, a tail
      const flap = still ? 0 : wob * 0.12;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.5); ctx.quadraticCurveTo(r * 1.3, -r * (0.6 + flap), r * 1.05, r * 0.05); ctx.quadraticCurveTo(r * 0.4, r * 0.7, 0, r * 0.7);
      ctx.quadraticCurveTo(-r * 0.4, r * 0.7, -r * 1.05, r * 0.05); ctx.quadraticCurveTo(-r * 1.3, -r * (0.6 + flap), 0, -r * 0.5); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, r * 0.65); ctx.quadraticCurveTo(wob * 8, r * 1.4, wob * 5, r * 2); ctx.stroke();
    } else {
      // fish: body + tail
      ctx.beginPath(); ctx.ellipse(0, 0, r * 1.15, r * 0.65, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-r * 1.0, 0); ctx.lineTo(-r * 1.7, -r * 0.5 + wob * 3); ctx.lineTo(-r * 1.7, r * 0.5 + wob * 3); ctx.closePath(); ctx.fill();
    }
    // eye-dot: dark centre so the creature reads as a specimen, not a blob
    ctx.globalAlpha = a;
    ctx.fillStyle = '#0D2B30';
    ctx.beginPath(); ctx.arc(c.coin === 'other' ? r * 0.6 : 0, c.coin === 'SUI' ? -r * 0.3 : 0, Math.max(2, r * 0.1), 0, 6.3); ctx.fill();
    if (this.selected === c.r.round_id) {
      ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(0, 0, r * 1.5 + 4, 0, 6.3); ctx.stroke();
    }
    ctx.restore();
  }
}
