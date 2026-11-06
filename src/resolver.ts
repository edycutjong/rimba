// Resolver: "does this sender move again within H minutes?"
// Outcome is a pure function of the checkpoints that follow the sighting (invariant I2):
//   YES at the first later activity by the same sender (per the configured move rule) whose
//       timestamp is within H minutes of the sighting;
//   NO  at the first checkpoint whose timestamp passes the deadline with no such transfer;
//   VOID if an unrecoverable checkpoint gap overlaps the window (the outcome cannot be known).
/** Anything that counts as "the sender moved": a transfer, or any signed tx, depending on the move rule. */
export interface Activity {
  sender: string;
  txDigest: string;
  timestampMs: number;
}

export interface PendingRound {
  roundId: string;
  sender: string;
  txDigest: string;
  checkpointSeq: bigint;
  timestampMs: number;
  deadlineMs: number;
}

export interface Resolution {
  roundId: string;
  outcome: 0 | 1 | null; // null = void
  resolvingCheckpointSeq: string;
  resolvingDigest: string; // tx digest for YES, checkpoint digest for NO/VOID
  resolvedAtMs: number;
  reason: 'moved' | 'deadline' | 'gap';
}

export class Resolver {
  private bySender = new Map<string, PendingRound[]>();
  private all = new Map<string, PendingRound>();

  get pendingCount(): number {
    return this.all.size;
  }

  pending(): PendingRound[] {
    return [...this.all.values()];
  }

  add(r: PendingRound): void {
    this.all.set(r.roundId, r);
    const arr = this.bySender.get(r.sender);
    if (arr) arr.push(r);
    else this.bySender.set(r.sender, [r]);
  }

  private remove(r: PendingRound): void {
    this.all.delete(r.roundId);
    const arr = this.bySender.get(r.sender);
    if (!arr) return;
    const i = arr.indexOf(r);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) this.bySender.delete(r.sender);
  }

  /**
   * Feed one checkpoint's transfers, in stream order. Must be called BEFORE new rounds from the
   * same checkpoint are added, so a sighting never resolves itself.
   */
  onCheckpoint(seq: bigint, cpDigest: string, cpTsMs: number, acts: Activity[]): Resolution[] {
    const out: Resolution[] = [];
    for (const t of acts) {
      const arr = this.bySender.get(t.sender);
      if (!arr) continue;
      for (const r of [...arr]) {
        if (t.txDigest === r.txDigest || seq <= r.checkpointSeq) continue; // only LATER checkpoints count (same rule live and on replay)
        if (t.timestampMs <= r.deadlineMs) {
          out.push({ roundId: r.roundId, outcome: 1, resolvingCheckpointSeq: seq.toString(), resolvingDigest: t.txDigest, resolvedAtMs: t.timestampMs, reason: 'moved' });
          this.remove(r);
        }
      }
    }
    for (const r of [...this.all.values()]) {
      if (cpTsMs > r.deadlineMs) {
        out.push({ roundId: r.roundId, outcome: 0, resolvingCheckpointSeq: seq.toString(), resolvingDigest: cpDigest, resolvedAtMs: cpTsMs, reason: 'deadline' });
        this.remove(r);
      }
    }
    return out;
  }

  /** An unrecoverable gap: every pending round whose window may overlap it is voided. */
  onGap(toSeq: bigint, atMs: number): Resolution[] {
    const out: Resolution[] = [];
    for (const r of [...this.all.values()]) {
      if (r.checkpointSeq <= toSeq) {
        out.push({ roundId: r.roundId, outcome: null, resolvingCheckpointSeq: toSeq.toString(), resolvingDigest: '', resolvedAtMs: atMs, reason: 'gap' });
        this.remove(r);
      }
    }
    return out;
  }
}
