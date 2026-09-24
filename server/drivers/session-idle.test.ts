import { describe, expect, it } from "vitest";

import { sessionIdlePolicy } from "./session-idle.ts";

describe("sessionIdlePolicy", () => {
  it("defaults to ten minutes with a ten-second floor", () => {
    expect(sessionIdlePolicy("CLAUDE", {})).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
    expect(sessionIdlePolicy("ACP", {})).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
  });

  it("honors each harness's own legacy names", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "2000" }).minimumMs).toBe(2_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "2000" }).minimumMs).toBe(2_000);
  });

  it("lets the unified names set every harness at once and win over the legacy names", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MS: "90000", OMB_CLAUDE_SESSION_IDLE_MS: "120000" }).idleMs).toBe(90_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MS: "90000", OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(90_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MIN_MS: "4000", OMB_ACP_SESSION_IDLE_MIN_MS: "2000" }).minimumMs).toBe(4_000);
  });

  it("floors a configured idle below the minimum and ignores unusable values", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "1", OMB_CLAUDE_SESSION_IDLE_MIN_MS: "30000" }).idleMs).toBe(30_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "not-a-number" }).idleMs).toBe(10 * 60_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "0" }).idleMs).toBe(10 * 60_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "-5" }).minimumMs).toBe(10_000);
  });
});
