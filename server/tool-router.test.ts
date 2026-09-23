// Behavior tests for the composio tool router (#1667): the ranking wire
// stays bounded and schema-free, schemas ride only with verified winners,
// and every fallback path returns the original bytes without breaking the
// relay. The decision client is faked at its exported seam; nothing here
// mirrors the module's internals.
import { describe, expect, it } from "vitest";
import type { DecisionChoice, DecisionModelClient } from "./decision-model.ts";
import {
  TOOL_ROUTER_MAX_RANKING_BYTES,
  TOOL_ROUTER_MAX_WINNERS,
  buildRankingRequest,
  createToolRouter,
  jsonRpcToolCall,
  multiExecuteSlugs,
  oneLiner,
  parseSchemaResponse,
  parseSearchToolsCandidates,
  rewriteSearchResult,
  schemaFetchRequest,
  type ToolCandidate,
  type ToolRouterReport,
} from "./tool-router.ts";

const GOAL = "send a welcome email to the new hire";

function catalog(size: number): ToolCandidate[] {
  return Array.from({ length: size }, (_, index) => ({
    name: "TOOL_" + String(index).padStart(4, "0"),
    description: "Performs step " + index + " of the workflow.",
  }));
}

function searchFrame(slugs: string[], options: { structured?: boolean } = {}): Uint8Array {
  const tool_schemas: Record<string, unknown> = {};
  for (const slug of slugs) {
    tool_schemas[slug] = {
      tool_slug: slug,
      toolkit: "kit",
      description: "Tool " + slug + " does exactly one useful thing.",
      input_schema: { type: "object", properties: {} },
    };
  }
  const payload = { success: true, results: [], tool_schemas, session: { id: "trs_test" } };
  const frame = {
    jsonrpc: "2.0",
    id: 41,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      ...(options.structured === false ? {} : { structuredContent: payload }),
    },
  };
  return Buffer.from(JSON.stringify(frame), "utf8");
}

function distribution(ids: string[], top: string): DecisionChoice {
  const weight = (id: string) => (id === top ? 0.5 : 0.5 / (ids.length - 1));
  const probabilities = Object.fromEntries(ids.map((id) => [id, weight(id)]));
  return { selectedId: top, confidence: 0.97, probabilities, model: "fixture-router" };
}

function fixtureRouter(options: {
  decide: (request: { criteria: Record<string, string> }) => Promise<DecisionChoice>;
  goal?: string | null;
  threshold?: number;
  schemaSlugs?: string[];
}) {
  const reports: ToolRouterReport[] = [];
  const decideRequests: Array<{ criteria: Record<string, string>; state: unknown }> = [];
  const schemaRequests: string[][] = [];
  const client: DecisionModelClient = {
    decide: async (request) => {
      decideRequests.push({ criteria: request.criteria, state: request.state });
      return options.decide(request);
    },
  };
  const router = createToolRouter({
    client: () => client,
    threshold: () => options.threshold ?? 0.9,
    goal: () => (options.goal === undefined ? GOAL : options.goal),
    fetchSchemas: async (slugs) => {
      schemaRequests.push(slugs);
      const granted = options.schemaSlugs ?? slugs;
      const schemas = new Map(
        slugs.map((slug) => [
          slug,
          granted.includes(slug)
            ? { tool_slug: slug, toolkit: "kit", input_schema: { type: "object", properties: { hydrated: { type: "boolean" } } } }
            : { tool_slug: slug, toolkit: "kit" },
        ]),
      );
      return { schemas, missing: slugs.filter((slug) => !granted.includes(slug)) };
    },
    report: (_threadId, report) => reports.push(report),
  });
  return { router, reports, decideRequests, schemaRequests };
}

describe("catalog adapter", () => {
  it("reads candidates from every known backend spelling and ignores unknown shapes", () => {
    const fromMap = parseSearchToolsCandidates({
      tool_schemas: { GMAIL_SEND: { description: "Send mail.\nMore detail." }, SLACK_POST: { description: "Post a message." } },
    });
    expect(fromMap.map((candidate) => candidate.name)).toEqual(["GMAIL_SEND", "SLACK_POST"]);
    expect(fromMap[0].description).toBe("Send mail.");
    const fromCamel = parseSearchToolsCandidates({ toolSchemas: { A: { description: "First." }, B: { description: "Second." } } });
    expect(fromCamel).toHaveLength(2);
    const fromArray = parseSearchToolsCandidates({ tools: [{ name: "A", description: "First." }, { tool_slug: "B", description: "Second." }] });
    expect(fromArray.map((candidate) => candidate.name)).toEqual(["A", "B"]);
    expect(parseSearchToolsCandidates({ unexpected: true })).toEqual([]);
  });

  it("bounds one-liners to the first line of a description", () => {
    expect(oneLiner("first line\nsecond line")).toBe("first line");
    expect(oneLiner("x".repeat(400)).length).toBeLessThanOrEqual(160);
    expect(oneLiner(undefined)).toBe("");
  });

  it("builds a ranking payload of goal text, names and one-liners only, under the wire cap", () => {
    const big = catalog(517).map((candidate) => ({
      name: candidate.name,
      description: "x".repeat(120) + " " + candidate.description,
    }));
    const ranking = buildRankingRequest(GOAL, big);
    expect(ranking).not.toBeNull();
    const wire = JSON.stringify({ state: ranking!.state, criteria: ranking!.criteria });
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(TOOL_ROUTER_MAX_RANKING_BYTES);
    const stateText = JSON.stringify(ranking!.state);
    expect(stateText).toContain(GOAL);
    expect(stateText).toContain("TOOL_0000");
    expect(stateText).not.toContain("input_schema");
    expect(stateText).not.toContain("schemaRef");
    expect(Object.keys(ranking!.criteria).at(-1)).toBe("abstain");
    expect(ranking!.state.catalog.every((entry) => Object.keys(entry).join(",") === "name,description")).toBe(true);
  });

  it("truncates an oversized catalog deterministically from the tail", () => {
    const huge = catalog(6_000).map((candidate) => ({ ...candidate, description: candidate.description + " " + "y".repeat(200) }));
    const ranking = buildRankingRequest(GOAL, huge);
    expect(ranking!.truncatedCount).toBeGreaterThan(0);
    expect(ranking!.state.catalog.length).toBeLessThan(huge.length);
    expect(ranking!.state.catalog[0].name).toBe(huge[0].name);
    expect(ranking!.state.catalog.at(-1)!.name).toBe(huge[ranking!.state.catalog.length - 1].name);
  });

  it("refuses to rank fewer than two candidates", () => {
    expect(buildRankingRequest(GOAL, catalog(1))).toBeNull();
  });

  it("recognizes relay frames and execute slugs", () => {
    expect(jsonRpcToolCall({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).toBeNull();
    expect(jsonRpcToolCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } })!.name).toBe("COMPOSIO_SEARCH_TOOLS");
    expect(multiExecuteSlugs({ tools: [{ tool_slug: "A" }, { tool_slug: "B" }, {}] })).toEqual(["A", "B"]);
  });

  it("frames a winners-only schema fetch and parses misses", () => {
    const frame = schemaFetchRequest(["A", "B"]);
    expect(frame.method).toBe("tools/call");
    expect(frame.params.arguments).toEqual({ tool_slugs: ["A", "B"] });
    const payload = { data: { tool_schemas: { A: { input_schema: { type: "object" } } } }, not_found: ["B"] };
    const envelope = { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
    const outcome = parseSchemaResponse(envelope);
    expect([...outcome.schemas.keys()]).toEqual(["A"]);
    expect(outcome.missing).toEqual(["B"]);
  });
});

describe("createToolRouter", () => {
  it("ranks, hydrates only the winners, and rewrites the response in rank order", async () => {
    const slugs = catalog(40).map((candidate) => candidate.name);
    const { router, reports, decideRequests, schemaRequests } = fixtureRouter({
      decide: async (request) => distribution(Object.keys(request.criteria), "TOOL_0007"),
    });
    const routed = await router.routeSearch({ threadId: "t1", responseBytes: searchFrame(slugs), contentType: "application/json" });
    expect(routed).not.toBeNull();
    const frame = JSON.parse(Buffer.from(routed!).toString("utf8"));
    const payload = JSON.parse(frame.result.content[0].text);
    expect(decideRequests).toHaveLength(1);
    expect(schemaRequests).toHaveLength(1);
    expect(new Set(schemaRequests[0]).size).toBe(TOOL_ROUTER_MAX_WINNERS);
    expect(schemaRequests[0]).not.toContain("TOOL_0039");
    expect(payload.tool_router.ranked_winners[0]).toBe("TOOL_0007");
    expect(Object.keys(payload.tool_schemas).slice(0, TOOL_ROUTER_MAX_WINNERS)).toEqual(payload.tool_router.ranked_winners);
    expect(payload.tool_schemas.TOOL_0007.input_schema).toEqual({ type: "object", properties: { hydrated: { type: "boolean" } } });
    expect(payload.tool_schemas.TOOL_0039.schema_omitted).toBe(true);
    expect(payload.tool_schemas.TOOL_0039.description).toContain("does exactly one useful thing");
    expect(payload.tool_schemas.TOOL_0039.input_schema).toBeUndefined();
    expect(payload.tool_router.schema_omitted_count).toBe(8);
    expect(frame.id).toBe(41);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: "acted",
      flow: "tool-router",
      selectedId: "TOOL_0007",
      candidateCount: 40,
      winnerCount: TOOL_ROUTER_MAX_WINNERS,
      breakerOpen: false,
    });
    expect(reports[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("caps winners at 32 across the 31/32/33 boundary", async () => {
    for (const size of [31, 32, 33]) {
      const slugs = catalog(size).map((candidate) => candidate.name);
      const { router, reports } = fixtureRouter({
        decide: async (request) => distribution(Object.keys(request.criteria), "TOOL_0000"),
      });
      const routed = await router.routeSearch({ threadId: "cap" + size, responseBytes: searchFrame(slugs), contentType: "application/json" });
      expect(routed).not.toBeNull();
      const payload = JSON.parse(JSON.parse(Buffer.from(routed!).toString("utf8")).result.content[0].text);
      expect(payload.tool_router.ranked_winners).toHaveLength(Math.min(size, TOOL_ROUTER_MAX_WINNERS));
      expect(reports[0].winnerCount).toBe(Math.min(size, TOOL_ROUTER_MAX_WINNERS));
      expect(reports[0].candidateCount).toBe(size);
    }
  });

  it("falls back to the original response on abstain and below-threshold confidence", async () => {
    const slugs = ["A", "B", "C"];
    const abstain = fixtureRouter({
      decide: async (request) => distribution(Object.keys(request.criteria), "abstain"),
    });
    expect(await abstain.router.routeSearch({ threadId: "t2", responseBytes: searchFrame(slugs), contentType: "application/json" })).toBeNull();
    expect(abstain.schemaRequests).toHaveLength(0);
    expect(abstain.reports[0].outcome).toBe("abstained");

    const lowConfidence = fixtureRouter({
      decide: async (request) => ({ ...distribution(Object.keys(request.criteria), "A"), confidence: 0.4 }),
    });
    expect(await lowConfidence.router.routeSearch({ threadId: "t3", responseBytes: searchFrame(slugs), contentType: "application/json" })).toBeNull();
    expect(lowConfidence.reports[0].outcome).toBe("below-threshold");
    expect(lowConfidence.schemaRequests).toHaveLength(0);
  });

  it("returns the original bytes when winner verification fails", async () => {
    const slugs = ["A", "B", "C"];
    const { router, reports, schemaRequests } = fixtureRouter({
      decide: async (request) => distribution(Object.keys(request.criteria), "A"),
      schemaSlugs: ["A"],
    });
    expect(await router.routeSearch({ threadId: "t4", responseBytes: searchFrame(slugs), contentType: "application/json" })).toBeNull();
    expect(schemaRequests).toHaveLength(1);
    expect(reports[0].outcome).toBe("error");
    expect(reports[0].detail).toMatch(/schema verification failed/);
  });

  it("trips the breaker after three consecutive errors and then stays silent", async () => {
    let failures = 0;
    const { router, reports, decideRequests } = fixtureRouter({
      decide: async () => {
        failures += 1;
        throw new Error("decision endpoint down");
      },
    });
    const bytes = searchFrame(["A", "B"]);
    for (let index = 0; index < 3; index += 1) {
      expect(await router.routeSearch({ threadId: "t5", responseBytes: bytes, contentType: "application/json" })).toBeNull();
    }
    expect(router.breakerOpen()).toBe(true);
    expect(reports).toHaveLength(3);
    expect(reports[2].detail).toMatch(/router disabled/);
    expect(reports[2].breakerOpen).toBe(true);
    expect(await router.routeSearch({ threadId: "t5", responseBytes: bytes, contentType: "application/json" })).toBeNull();
    expect(decideRequests).toHaveLength(3);
    expect(reports).toHaveLength(3);
  });

  it("aborts mid-ranking without a schema fetch, an aborted event, and no breaker tick", async () => {
    const controller = new AbortController();
    let pending: ((error: Error) => void) | undefined;
    const { router, reports, schemaRequests } = fixtureRouter({
      decide: () =>
        new Promise<DecisionChoice>((_, reject) => {
          pending = reject;
          controller.signal.addEventListener("abort", () => pending?.(controller.signal.reason as Error), { once: true });
        }),
    });
    const routing = router.routeSearch({ threadId: "t6", responseBytes: searchFrame(["A", "B"]), contentType: "application/json", signal: controller.signal });
    controller.abort(new Error("caller closed"));
    expect(await routing).toBeNull();
    expect(schemaRequests).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("error");
    expect(reports[0].detail).toMatch(/ranking aborted/);
    expect(reports[0].breakerOpen).toBe(false);
  });

  it("ignores a goalless thread, a non-JSON body, and an error result silently", async () => {
    const { router, reports, decideRequests } = fixtureRouter({ decide: async (request) => distribution(Object.keys(request.criteria), "A"), goal: null });
    expect(await router.routeSearch({ threadId: "t7", responseBytes: searchFrame(["A", "B"]), contentType: "application/json" })).toBeNull();
    const json = fixtureRouter({ decide: async (request) => distribution(Object.keys(request.criteria), "A") });
    expect(await json.router.routeSearch({ threadId: "t7", responseBytes: searchFrame(["A", "B"]), contentType: "text/event-stream" })).toBeNull();
    expect(await json.router.routeSearch({ threadId: "t7", responseBytes: Buffer.from("{not json"), contentType: "application/json" })).toBeNull();
    expect(decideRequests).toHaveLength(0);
    expect(json.decideRequests).toHaveLength(0);
    expect(reports).toHaveLength(0);
    expect(json.reports).toHaveLength(0);
  });

  it("logs an execute outside the verified winner set and relays within it", async () => {
    const slugs = catalog(40).map((candidate) => candidate.name);
    const { router, reports } = fixtureRouter({
      decide: async (request) => distribution(Object.keys(request.criteria), "TOOL_0000"),
    });
    await router.routeSearch({ threadId: "t8", responseBytes: searchFrame(slugs), contentType: "application/json" });
    expect(router.observeExecute("t8", ["TOOL_0000", "TOOL_0005"])).toBeNull();
    const outside = router.observeExecute("t8", ["TOOL_0000", "TOOL_0039"]);
    expect(outside?.outcome).toBe("abstained");
    expect(outside?.detail).toContain("TOOL_0039");
    expect(router.observeExecute("unknown-thread", ["TOOL_0000"])).toBeNull();
    expect(reports.filter((report) => report.outcome === "abstained").length).toBe(0);
  });
});

describe("rewriteSearchResult", () => {
  it("rewrites structured content the same as text content", () => {
    const original = searchFrame(["A", "B"]);
    const schemas = new Map([["A", { input_schema: { type: "object", properties: { hydrated: { type: "boolean" } } } }]]);
    const rewritten = rewriteSearchResult(Buffer.from(original).toString("utf8"), ["A"], schemas);
    expect(rewritten).not.toBeNull();
    const frame = JSON.parse(rewritten!);
    const viaText = JSON.parse(frame.result.content[0].text);
    const viaStructured = frame.result.structuredContent;
    expect(viaText.tool_schemas.A.rank_verified).toBe(true);
    expect(viaStructured.tool_schemas.A.input_schema.properties.hydrated).toEqual({ type: "boolean" });
    expect(viaStructured.tool_schemas.B.schema_omitted).toBe(true);
    expect(viaStructured.tool_schemas.B.input_schema).toBeUndefined();
    expect(viaStructured.tool_router.schema_omitted_count).toBe(1);
  });
});

describe("winner ordering", () => {
  it("orders winners by probability with deterministic tie-breaks", async () => {
    const slugs = catalog(4).map((candidate) => candidate.name);
    const { router } = fixtureRouter({
      decide: async () => ({
        selectedId: "TOOL_0002",
        confidence: 0.95,
        probabilities: {
          TOOL_0000: 0.1,
          TOOL_0001: 0.3,
          TOOL_0002: 0.4,
          TOOL_0003: 0.1,
          abstain: 0.1,
        },
      }),
    });
    const routed = await router.routeSearch({ threadId: "t9", responseBytes: searchFrame(slugs), contentType: "application/json" });
    const payload = JSON.parse(JSON.parse(Buffer.from(routed!).toString("utf8")).result.content[0].text);
    expect(payload.tool_router.ranked_winners).toEqual(["TOOL_0002", "TOOL_0001", "TOOL_0000", "TOOL_0003"]);
  });
});
