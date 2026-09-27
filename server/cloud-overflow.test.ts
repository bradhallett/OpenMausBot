import { describe, expect, it } from "vitest";

import {
  CLOUD_SEAT_IDLE_STOP_MS,
  CloudOverflowConsent,
  CloudSeatLease,
  cloudOverflowAction,
  cloudOverflowConsentText,
  cloudOverflowOfferText,
  cloudSeatStartedText,
  cloudSeatStoppedText,
  formatPerSecondUsd,
} from "./cloud-overflow.ts";

describe("cloud overflow decision (#1655)", () => {
  it("fails closed: feature off, cloud unusable, or no configured rate means no offer and no start", () => {
    const consented = { consented: true, offered: false, started: false };
    expect(cloudOverflowAction({ featureEnabled: false, cloudConfigured: true, perSecondCostUsd: 0.0004, ...consented })).toEqual({ kind: "off" });
    expect(cloudOverflowAction({ featureEnabled: true, cloudConfigured: true, perSecondCostUsd: null, ...consented })).toEqual({ kind: "off" });
    expect(cloudOverflowAction({ featureEnabled: true, cloudConfigured: false, perSecondCostUsd: 0.0004, ...consented })).toEqual({ kind: "off" });
  });

  it("offers exactly once without consent, and never starts: the local wait stays the only path", () => {
    const base = { featureEnabled: true, cloudConfigured: true, perSecondCostUsd: 0.0004 as number | null, started: false };
    expect(cloudOverflowAction({ ...base, consented: false, offered: false })).toEqual({ kind: "offer" });
    expect(cloudOverflowAction({ ...base, consented: false, offered: true })).toEqual({ kind: "none" });
  });

  it("starts only once consent exists, and only while no seat is live", () => {
    const base = { featureEnabled: true, cloudConfigured: true, perSecondCostUsd: 0.0004, consented: true, offered: true };
    expect(cloudOverflowAction({ ...base, started: false })).toEqual({ kind: "start" });
    expect(cloudOverflowAction({ ...base, started: true })).toEqual({ kind: "none" });
  });
});

describe("cloud overflow consent", () => {
  it("keeps consent per conversation, with a configured allowlist pre-consenting", () => {
    const consent = new CloudOverflowConsent();
    expect(consent.consented("t1")).toBe(false);
    consent.grant("t1", 1_000);
    expect(consent.consented("t1")).toBe(true);
    expect(consent.consented("t2")).toBe(false);
    expect(consent.consented("t2", new Set(["t2"]))).toBe(true);
    consent.revoke("t1");
    expect(consent.consented("t1")).toBe(false);
  });

  it("resets the card on revoke, so a later wait may ask again", () => {
    const consent = new CloudOverflowConsent();
    consent.markOffered("t1", 1_000);
    expect(consent.offered("t1")).toBe(true);
    consent.grant("t1", 2_000);
    consent.revoke("t1");
    expect(consent.offered("t1")).toBe(false);
  });
});

describe("cloud seat idle stop (#1655)", () => {
  it("stops the machine only once idle passes the window; a real touch restarts it", () => {
    const lease = new CloudSeatLease({ botId: "b1", threadId: "t1", now: 0, idleStopMs: 5 * 60_000 });
    expect(lease.idleElapsed(5 * 60_000 - 1)).toBe(false);
    expect(lease.idleElapsed(5 * 60_000)).toBe(true);
    lease.touch(5 * 60_000);
    expect(lease.idleElapsed(5 * 60_000)).toBe(false);
    expect(lease.idleFor(5 * 60_000 + 90_000)).toBe(90_000);
    expect(lease.idleElapsed(2 * 5 * 60_000)).toBe(true);
  });

  it("defaults to a few idle minutes and validates the window", () => {
    expect(CLOUD_SEAT_IDLE_STOP_MS).toBe(5 * 60_000);
    expect(() => new CloudSeatLease({ botId: "b", threadId: "t", idleStopMs: 0 })).toThrow();
    expect(() => new CloudSeatLease({ botId: "b", threadId: "t", idleStopMs: Number.NaN })).toThrow();
  });
});

describe("cloud overflow chip text", () => {
  it("shows the per-second cost beside the local wait before the choice is made", () => {
    const text = cloudOverflowOfferText({ perSecondCostUsd: 0.0004, waitEstimateMs: 120_000, idleStopMs: 5 * 60_000 });
    expect(text).toContain("$0.0004 per second");
    expect(text).toContain("Recent local waits here have taken about 2 minutes.");
    expect(text).toContain("Nothing starts without your consent");
    const bare = cloudOverflowOfferText({ perSecondCostUsd: 0.02, idleStopMs: 5 * 60_000 });
    expect(bare).toContain("$0.02 per second");
    expect(bare).not.toContain("Recent local waits");
  });

  it("names the cost when the seat starts, the idle reason when it stops, and the consent verdict", () => {
    expect(formatPerSecondUsd(0.0004)).toBe("$0.0004");
    expect(formatPerSecondUsd(0.02)).toBe("$0.02");
    expect(cloudSeatStartedText({ perSecondCostUsd: 0.0004, idleStopMs: 5 * 60_000 })).toContain("Cloud computer started at $0.0004 per second");
    expect(cloudSeatStartedText({ perSecondCostUsd: 0.0004, idleStopMs: 5 * 60_000 })).toContain("stops automatically after 5 minutes idle");
    expect(cloudSeatStoppedText(5 * 60_000)).toContain("Cloud computer stopped after 5 minutes idle");
    expect(cloudOverflowConsentText(true, 5 * 60_000)).toContain("Cloud overflow allowed");
    expect(cloudOverflowConsentText(false)).toContain("revoked");
  });
});
