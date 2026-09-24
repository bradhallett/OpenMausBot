// One session-idle policy for every pooled harness process. The Claude
// driver and the ACP core grew byte-identical copies of this computation
// with different env prefixes; the policy lives here so the default, the
// floor, and the env names cannot drift apart again.

export interface SessionIdlePolicy {
  /** How long a session may sit quiet before it is closed as "idle". */
  idleMs: number;
  /** The smallest idle delay a configuration may ask for. */
  minimumMs: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const MINIMUM_IDLE_MS = 10_000;

function positiveNumber(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The idle policy for one harness. The unified names
 *  (OMB_SESSION_IDLE_MS / OMB_SESSION_IDLE_MIN_MS) set the policy for every
 *  harness at once; the per-harness names that preceded them
 *  (OMB_CLAUDE_SESSION_IDLE_*, OMB_ACP_SESSION_IDLE_*) keep working, so an
 *  existing deployment never changes behavior on upgrade. An unset or
 *  unusable value leaves the default in place, and the floor applies to
 *  whatever wins. */
export function sessionIdlePolicy(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
): SessionIdlePolicy {
  const minimumMs = positiveNumber(
    env.OMB_SESSION_IDLE_MIN_MS ?? env[`OMB_${driverPrefix}_SESSION_IDLE_MIN_MS`],
  ) ?? MINIMUM_IDLE_MS;
  const configured = Number(
    env.OMB_SESSION_IDLE_MS ?? env[`OMB_${driverPrefix}_SESSION_IDLE_MS`],
  ) || DEFAULT_IDLE_MS;
  return { idleMs: Math.max(minimumMs, configured), minimumMs };
}
