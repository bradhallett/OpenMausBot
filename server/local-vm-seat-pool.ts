/** Who holds a pool seat right now, as the per-seat LocalVmLease reports it. */
export interface LocalVmSeatHolder {
  threadId: string;
  expiresAt: number;
}

/** How long a conversation keeps preferring its previous seat after its last
 * turn settles. Matches the lease TTL's half-hour scale: long enough for a
 * person's pause between messages, short enough that an abandoned
 * conversation stops steering assignment within the hour. */
export const DEFAULT_LOCAL_VM_SEAT_AFFINITY_TTL_MS = 30 * 60_000;

interface SeatAffinityEntry {
  seat: number;
  expiresAt: number;
}

/**
 * Seat assignment for `localVm.mode: "pool"` (issue #1654).
 *
 * The lease pool stays the ownership fence: one `LocalVmLease` lane per
 * seat decides who may use a desktop right now. This class only decides
 * WHICH seat a conversation addresses. A TTL-bounded affinity keeps a thread
 * returning to the desktop that holds its login state, and hands the seat
 * back to the pool once the conversation has been idle past the TTL.
 */
export class LocalVmSeatPool {
  private readonly affinity = new Map<string, SeatAffinityEntry>();

  constructor(
    private readonly seatCount: () => number,
    private readonly affinityTtlMs: number = DEFAULT_LOCAL_VM_SEAT_AFFINITY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(affinityTtlMs) || affinityTtlMs <= 0) {
      throw new Error("Local VM seat affinity TTL must be positive");
    }
  }

  private count(): number {
    const seats = Math.floor(this.seatCount());
    return Number.isFinite(seats) && seats >= 1 ? seats : 1;
  }

  private prune(now: number): void {
    const seats = this.count();
    for (const [threadId, entry] of this.affinity) {
      if (entry.expiresAt <= now || entry.seat >= seats) this.affinity.delete(threadId);
    }
  }

  /** The seat a thread still has affinity with, or null once the TTL — or a
   * smaller configured seat count — has lapsed. Read-only: never records. */
  affinitySeat(threadId: string): number | null {
    const entry = this.affinity.get(threadId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now() || entry.seat >= this.count()) {
      this.affinity.delete(threadId);
      return null;
    }
    return entry.seat;
  }

  /**
   * Choose the seat a thread's next Local VM claim addresses. Live affinity
   * wins outright: reusing the desktop that holds the conversation's login
   * state is worth queueing behind its current holder. Otherwise prefer a
   * seat nobody holds and no other thread has live affinity with, then any
   * unheld seat, and when every seat is held, the seat whose lease expires
   * first, so the caller waits where capacity returns soonest. The choice is
   * recorded immediately: two threads assigning concurrently must diverge
   * even before their lease claims land.
   */
  assign(threadId: string, holderOf: (seat: number) => LocalVmSeatHolder | null): number {
    const now = this.now();
    this.prune(now);
    const live = this.affinitySeat(threadId);
    if (live !== null) return this.take(threadId, live, now);
    const seats = this.count();
    const holders: Array<LocalVmSeatHolder | null> = [];
    for (let seat = 0; seat < seats; seat += 1) holders.push(holderOf(seat));
    const softHeld = new Set<number>();
    for (const [otherId, entry] of this.affinity) {
      if (otherId !== threadId && entry.expiresAt > now && entry.seat < seats) softHeld.add(entry.seat);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      for (let seat = 0; seat < seats; seat += 1) {
        if (holders[seat] !== null) continue;
        if (pass === 0 && softHeld.has(seat)) continue;
        return this.take(threadId, seat, now);
      }
    }
    let soonest = 0;
    for (let seat = 1; seat < seats; seat += 1) {
      const best = holders[soonest];
      const candidate = holders[seat];
      if (best && candidate && candidate.expiresAt < best.expiresAt) soonest = seat;
    }
    return this.take(threadId, soonest, now);
  }

  /** Drop a thread's affinity explicitly, without waiting for the TTL. */
  forget(threadId: string): void {
    this.affinity.delete(threadId);
  }

  private take(threadId: string, seat: number, now: number): number {
    this.affinity.set(threadId, { seat, expiresAt: now + this.affinityTtlMs });
    return seat;
  }
}
