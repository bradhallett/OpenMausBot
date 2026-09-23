// The composio tool router (issue #1667). Composio's on-demand discovery
// already keeps connected-app schemas out of the agent's context, but it
// leaves the choice of which tools to hydrate to the main model guessing
// from names in a long catalog — high-cardinality, off-policy selection,
// where every wrong hydration pays context. This module ranks the
// candidates a COMPOSIO_SEARCH_TOOLS response returned against the turn's
// goal with the calibrated decision model (#1630), keeps full schemas for
// the winners only (fetched through the ordinary
// COMPOSIO_GET_TOOL_SCHEMAS meta tool), and strips them from the rest.
//
// It is a new caller of the decision model, not a new decision path: the
// semantics are the chooser's (server/decision-chooser.ts), mirrored
// rather than imported because that module owns the computer-use loop —
// confidence gate, silent fallback on every failure, a three-error
// breaker, a 12s decide timeout racing an AbortSignal, and one
// decision.chooser event per outcome tagged flow "tool-router" so the
// populations stay separable. A router failure must never break a
// connected-app call: every failure path returns the original bytes.
import { randomUUID } from "node:crypto";

export const TOOL_ROUTER_FLOW = "tool-router";
/** How many ranked tools keep their schemas. Mirrors the chooser's
 * candidate ceiling: one screen's worth of choices, not a catalog. */
export const TOOL_ROUTER_MAX_WINNERS = 32;
/** The ranking request's wire cap. Goal text plus names and one-liners —
 * the bytes that decide rank — never schemas or full descriptions. */
export const TOOL_ROUTER_MAX_RANKING_BYTES = 65_536;
const MIN_CANDIDATES = 2;
const ONE_LINER_MAX = 160;

type JsonRecord = Record<string, unknown>;

export type ToolCandidate = { name: string; description: string };

export type ToolRouterReport = {
  outcome: "acted" | "abstained" | "below-threshold" | "error";
  flow: typeof TOOL_ROUTER_FLOW;
  candidateCount: number;
  winnerCount: number;
  latencyMs: number;
  breakerOpen: boolean;
  selectedId?: string;
  confidence?: number;
  model?: string;
  detail?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The first line of a description, bounded: what a ranking should see.
 * Full descriptions belong to the hydration step, not the decision. */
export function oneLiner(description: unknown): string {
  if (typeof description !== "string") return "";
  const line = description.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > ONE_LINER_MAX ? line.slice(0, ONE_LINER_MAX - 1) + "…" : line;
}

function candidateFromEntry(name: string, entry: unknown): ToolCandidate | null {
  const description = oneLiner(isRecord(entry) ? entry.description : undefined);
  return name.trim() && description ? { name: name.trim(), description } : null;
}

/** Candidates from a COMPOSIO_SEARCH_TOOLS payload. The backend owns this
 * shape and has changed it across versions, so every known spelling is
 * accepted — keyed schema maps (snake or camel), or flat tool arrays —
 * and an unknown shape yields nothing, which passes the response through
 * untouched. */
export function parseSearchToolsCandidates(payload: unknown): ToolCandidate[] {
  if (!isRecord(payload)) return [];
  const map = payload.tool_schemas ?? payload.toolSchemas;
  if (isRecord(map)) {
    const candidates: ToolCandidate[] = [];
    for (const [name, entry] of Object.entries(map)) {
      const candidate = candidateFromEntry(name, entry);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }
  for (const key of ["tools", "results", "data"]) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    const candidates: ToolCandidate[] = [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const name = [item.name, item.tool_slug, item.toolSlug, item.slug].find(
        (value) => typeof value === "string" && value.trim(),
      );
      if (typeof name !== "string") continue;
      const candidate = candidateFromEntry(name, item);
      if (candidate) candidates.push(candidate);
    }
    if (candidates.length) return candidates;
  }
  return [];
}

export type RankingRequest = {
  state: { goal: string; catalog: Array<{ name: string; description: string }>; candidate_count: number; truncated_count: number };
  criteria: Record<string, string>;
  truncatedCount: number;
};

/** The decision request: criteria maps every tool id to its one-liner
 * plus the mandatory abstain escape; the state carries the goal and the
 * same name/one-liner catalog. If the catalog outgrows the wire cap the
 * tail is dropped deterministically (input order), never silently
 * reweighted. Null means too few candidates to rank. */
export function buildRankingRequest(goal: string, candidates: ToolCandidate[]): RankingRequest | null {
  const seen = new Set<string>();
  const unique: ToolCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    unique.push(candidate);
  }
  if (unique.length < MIN_CANDIDATES) return null;
  const abstain = "Decline to rank; let the main model choose from the full list.";
  let kept = unique;
  let truncatedCount = 0;
  for (;;) {
    const criteria = Object.fromEntries([
      ...kept.map((candidate) => [candidate.name, candidate.description] as const),
      ["abstain", abstain] as const,
    ]);
    const state = {
      goal: goal.slice(0, 4_000),
      catalog: kept.map((candidate) => ({ name: candidate.name, description: candidate.description })),
      candidate_count: kept.length,
      truncated_count: truncatedCount,
    };
    const bytes = Buffer.byteLength(JSON.stringify({ state, criteria }), "utf8");
    if (bytes <= TOOL_ROUTER_MAX_RANKING_BYTES || kept.length <= MIN_CANDIDATES) {
      return { state, criteria, truncatedCount };
    }
    const nextLength = Math.max(MIN_CANDIDATES, Math.floor(kept.length * 0.9));
    truncatedCount += kept.length - nextLength;
    kept = kept.slice(0, nextLength);
  }
}

/** The tools/call frame a provider bridge posts, or null for anything
 * else on the relay. */
export function jsonRpcToolCall(body: unknown): { name: string; arguments: unknown } | null {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return null;
  const name = body.params.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return { name: name.trim(), arguments: body.params.arguments };
}

export type ToolSchemaOutcome = { schemas: Map<string, JsonRecord>; missing: string[] };

/** Locate the Composio tool payload inside an MCP result envelope:
 * structured content first, then a JSON text item. */
function toolPayload(frame: unknown): JsonRecord | null {
  if (!isRecord(frame) || !isRecord(frame.result)) return null;
  const result = frame.result;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      const trimmed = item.text.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) return parsed;
      } catch {
        // not JSON after all
      }
    }
  }
  return null;
}

/** The executed tool slugs of a COMPOSIO_MULTI_EXECUTE_TOOL call, if the
 * frame is one. */
export function multiExecuteSlugs(arguments_: unknown): string[] {
  if (!isRecord(arguments_) || !Array.isArray(arguments_.tools)) return [];
  const slugs: string[] = [];
  for (const item of arguments_.tools) {
    if (isRecord(item) && typeof item.tool_slug === "string" && item.tool_slug.trim()) slugs.push(item.tool_slug.trim());
  }
  return slugs;
}

/** One batched COMPOSIO_GET_TOOL_SCHEMAS frame for the winners. */
export function schemaFetchRequest(slugs: string[]): {
  jsonrpc: "2.0";
  id: string;
  method: "tools/call";
  params: { name: "COMPOSIO_GET_TOOL_SCHEMAS"; arguments: { tool_slugs: string[] } };
} {
  return {
    jsonrpc: "2.0",
    id: "tool-router-" + randomUUID(),
    method: "tools/call",
    params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: slugs } },
  };
}

/** Parse a COMPOSIO_GET_TOOL_SCHEMAS answer into per-slug records. The
 * backend may wrap the payload in data and reports misses separately;
 * both spellings are accepted. */
export function parseSchemaResponse(frame: unknown): ToolSchemaOutcome {
  const schemas = new Map<string, JsonRecord>();
  const missing: string[] = [];
  const payload = toolPayload(frame) ?? (isRecord(frame) ? frame : {});
  const data = isRecord(payload.data) ? payload.data : undefined;
  const map = isRecord(payload.tool_schemas)
    ? payload.tool_schemas
    : isRecord(data?.tool_schemas)
      ? data.tool_schemas
      : isRecord(payload.toolSchemas)
        ? payload.toolSchemas
        : undefined;
  if (map) {
    for (const [slug, entry] of Object.entries(map)) {
      if (isRecord(entry)) schemas.set(slug, entry);
    }
  }
  const notFound = Array.isArray(payload.not_found) ? payload.not_found : Array.isArray(data?.not_found) ? data.not_found : undefined;
  if (notFound) {
    for (const slug of notFound) if (typeof slug === "string") missing.push(slug);
  }
  return { schemas, missing };
}
