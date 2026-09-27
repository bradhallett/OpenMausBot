/** Consent, cost, and idle-stop policy for overflowing a local computer
 * wait onto a per-second-billed cloud seat (#1655).
 *
 * Like server/claim-idle.ts this module is deliberately synchronous and
 * clock-injected: the server decides every transition on its single
 * thread and tests pin time exactly. Nothing here starts or stops a
 * machine — the wiring does, and only when the decision says to. Keep
 * this module free of server imports. */

import { computerWaitDuration } from "./computer-wait.ts";

/** Default idle stop: a cloud seat no real screen work has touched for
 * this long is stopped (archived), because billing runs per second while
 * it runs. "A few idle minutes" per the issue. */
export const CLOUD_SEAT_IDLE_STOP_MS = 5 * 60_000;

/** What the wait loop should do about cloud overflow, evaluated fresh on
 * every poll. `off` is fail-closed: the feature is disabled, the cloud
 * is not usable, or no per-second cost is configured — no card, no
 * start, and never an invented price. `offer` posts the consent card
 * once per conversation. `start` is the only path that may start a
 * seat, and it requires consent that already exists. */
export type CloudOverflowAction =
  | { kind: "off" }
  | { kind: "none" }
  | { kind: "offer" }
  | { kind: "start" };

export interface CloudOverflowSituation {
  featureEnabled: boolean;
  cloudConfigured: boolean;
  /** The operator's own verified rate; null means do not guess. */
  perSecondCostUsd: number | null;
  consented: boolean;
  offered: boolean;
  started: boolean;
}

export function cloudOverflowAction(situation: CloudOverflowSituation): CloudOverflowAction {
  if (!situation.featureEnabled || !situation.cloudConfigured || situation.perSecondCostUsd === null) return { kind: "off" };
  if (situation.started) return { kind: "none" };
  if (situation.consented) return { kind: "start" };
  if (situation.offered) return { kind: "none" };
  return { kind: "offer" };
}

/** Per-conversation consent plus the offer bookkeeping that keeps the
 * card to one per conversation until it is revoked. A thread the operator
 * allowlisted in config carries standing consent and never needs the
 * card. */
export class CloudOverflowConsent {
  private readonly grants = new Map<string, number>();
  private readonly offers = new Map<string, number>();
  private readonly revocations = new Set<string>();

  consented(threadId: string, allowlistedThreads: ReadonlySet<string> = new Set()): boolean {
    return !this.revocations.has(threadId) && (this.grants.has(threadId) || allowlistedThreads.has(threadId));
  }

  grant(threadId: string, now = Date.now()): void {
    this.revocations.delete(threadId);
    this.grants.set(threadId, now);
  }

  /** Revoking also clears the offered mark, so a later wait in the same
   * conversation may ask again instead of meeting silence. */
  revoke(threadId: string): boolean {
    const had = this.grants.delete(threadId);
    this.revocations.add(threadId);
    this.offers.delete(threadId);
    return had;
  }

  offered(threadId: string): boolean {
    return this.offers.has(threadId);
  }

  markOffered(threadId: string, now = Date.now()): void {
    this.offers.set(threadId, now);
  }
}

/** One running cloud seat started by overflow. `touch` is called only
 * for real computer tool completions on that seat — screen-poller frames
 * never reach it, exactly like #1653's activity clock, so preview
 * traffic cannot keep a paid machine awake. */
export class CloudSeatLease {
  readonly botId: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly idleStopMs: number;
  private lastActivityAt: number;

  constructor(init: { botId: string; threadId: string; now?: number; idleStopMs?: number }) {
    const idleStopMs = init.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
    if (!Number.isFinite(idleStopMs) || idleStopMs <= 0) throw new Error("Cloud seat idle stop window must be positive");
    this.botId = init.botId;
    this.threadId = init.threadId;
    this.startedAt = init.now ?? Date.now();
    this.lastActivityAt = this.startedAt;
    this.idleStopMs = idleStopMs;
  }

  touch(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  idleFor(now = Date.now()): number {
    return Math.max(0, now - this.lastActivityAt);
  }

  idleElapsed(now = Date.now()): boolean {
    return now - this.lastActivityAt >= this.idleStopMs;
  }
}

/** Dollars per second at rate-card precision: enough places for small
 * per-second rates to stay visible, trailing zeros trimmed but never
 * past two decimals. */
export function formatPerSecondUsd(perSecondCostUsd: number): string {
  let text = perSecondCostUsd.toFixed(6).replace(/0+$/, "");
  if (text.endsWith(".")) text += "00";
  else {
    const decimals = text.length - text.indexOf(".") - 1;
    if (decimals < 2) text += "0".repeat(2 - decimals);
  }
  return "$" + text;
}

/** The consent card (#1655): the per-second cost sits beside the local
 * wait picture before any choice is made, and nothing starts without an
 * explicit consent the person still has to give. */
export function cloudOverflowOfferText(opts: { perSecondCostUsd: number; waitEstimateMs?: number; idleStopMs?: number }): string {
  const idleStopMs = opts.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
  const estimate = opts.waitEstimateMs === undefined ? "" : ` Recent local waits here have taken about ${computerWaitDuration(opts.waitEstimateMs)}.`;
  return `This computer is busy. Its work can overflow to a cloud computer for ${formatPerSecondUsd(opts.perSecondCostUsd)} per second.${estimate} Nothing starts without your consent — allow cloud overflow for this conversation to start it; the cloud computer stops after ${computerWaitDuration(idleStopMs)} idle.`;
}

export function cloudSeatStartedText(opts: { perSecondCostUsd: number; idleStopMs?: number }): string {
  const idleStopMs = opts.idleStopMs ?? CLOUD_SEAT_IDLE_STOP_MS;
  return `Cloud computer started at ${formatPerSecondUsd(opts.perSecondCostUsd)} per second. It stops automatically after ${computerWaitDuration(idleStopMs)} idle, and the local wait continues until this computer is free.`;
}

export function cloudSeatStoppedText(idleMs: number): string {
  return `Cloud computer stopped after ${computerWaitDuration(idleMs)} idle — billing pauses while it sleeps.`;
}

export function cloudOverflowConsentText(allowed: boolean, idleStopMs: number = CLOUD_SEAT_IDLE_STOP_MS): string {
  return allowed
    ? `Cloud overflow allowed for this conversation. A waiting turn may start the cloud computer; it stops after ${computerWaitDuration(idleStopMs)} idle.`
    : "Cloud overflow consent revoked. Waits stay local, and no cloud computer starts without a new consent.";
}
