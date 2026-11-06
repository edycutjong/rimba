// The two opponents the memory naturalist must beat, computed online at call time (no hindsight):
//   base rate  — running YES fraction over all resolved rounds, Beta-smoothed toward the day-0 prior;
//   frequency  — the sender's own YES fraction, smoothed toward the base rate (never-seen = base rate).
export class BaseRate {
  private yes = 0;
  private n = 0;
  constructor(private prior: number, private priorWeight = 20) {}
  observe(outcome: 0 | 1): void {
    this.n++;
    this.yes += outcome;
  }
  p(): number {
    return (this.yes + this.prior * this.priorWeight) / (this.n + this.priorWeight);
  }
  get count(): number {
    return this.n;
  }
}

export class FrequencyTable {
  private stats = new Map<string, { yes: number; n: number }>();
  constructor(private k = 2) {}
  observe(sender: string, outcome: 0 | 1): void {
    const s = this.stats.get(sender) ?? { yes: 0, n: 0 };
    s.n++;
    s.yes += outcome;
    this.stats.set(sender, s);
  }
  p(sender: string, base: number): number {
    const s = this.stats.get(sender);
    if (!s) return base;
    return (s.yes + base * this.k) / (s.n + this.k);
  }
  resolvedCount(sender: string): number {
    return this.stats.get(sender)?.n ?? 0;
  }
}

export function brier(p: number, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}
