import { describe, it, expect, vi } from "vitest";
import { buildWebTools, WEB_TOOL_NAMES } from "../../../src/mastra/tools/web.js";
import type { ToolContext } from "../../../src/mastra/tools/registry.js";

// NOTE: tools that fetch arbitrary URLs (fetch_url, kufar_search, avby_search, …)
// are NOT exercised here: the production SSRF guard does real DNS (no injectable
// lookupFn at the tool layer). Their fetch/parse paths are covered hermetically at
// the service level in fetch.test.ts. Here we only drive tools that either use
// fetchFn-only (web_search) or no network at all (the lookup tools).

// Minimal ToolCallOptions for direct execute() calls.
const opts = { toolCallId: "test", messages: [] } as never;

// Only settings.getTimeouts is read by the tools.
const ctx = {
  settings: {
    getTimeouts: async () => ({
      http_client: "30s",
      llm_request: "300s",
      llm_activity: "30s",
    }),
  },
} as unknown as ToolContext;

/** Build a fetchFn returning searxng JSON for web_search. */
function searxFetch(
  results: Array<{ title?: string; content?: string; url?: string }>,
): typeof globalThis.fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof globalThis.fetch;
}

describe("buildWebTools registry", () => {
  it("exposes exactly 21 tools matching WEB_TOOL_NAMES", () => {
    expect(WEB_TOOL_NAMES.size).toBe(21);
    const tools = buildWebTools(ctx, searxFetch([]));
    expect(new Set(Object.keys(tools))).toEqual(WEB_TOOL_NAMES);
  });
});

describe("web_search tool (fetchFn-only, no DNS)", () => {
  it("returns markdown containing a result title", async () => {
    const fetchFn = searxFetch([
      { title: "Hit Title", content: "snippet", url: "https://hit.test" },
    ]);
    const tools = buildWebTools(ctx, fetchFn);
    const out = (await tools.web_search!.execute!({ query: "hello" }, opts)) as string;

    expect(typeof out).toBe("string");
    expect(out).toContain("Hit Title");
    expect(out).toContain("https://hit.test");
  });

  it("returns an 'Error:' string (does not throw) when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof globalThis.fetch;
    const tools = buildWebTools(ctx, fetchFn);

    const out = (await tools.web_search!.execute!({ query: "hello" }, opts)) as string;
    expect(typeof out).toBe("string");
    expect(out.startsWith("Error:")).toBe(true);
  });
});

describe("lookup tools (no network)", () => {
  // A fetchFn that throws — proves these tools never touch the network.
  const throwingFetch = vi.fn(async () => {
    throw new Error("network must not be used");
  }) as unknown as typeof globalThis.fetch;

  it("relax_categories returns a non-empty JSON array", async () => {
    const tools = buildWebTools(ctx, throwingFetch);
    const out = (await tools.relax_categories!.execute!({}, opts)) as string;
    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("relax_afisha_categories returns a non-empty JSON array", async () => {
    const tools = buildWebTools(ctx, throwingFetch);
    const out = (await tools.relax_afisha_categories!.execute!({}, opts)) as string;
    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("kufar_regions (no arg) returns a non-empty JSON array of top regions", async () => {
    const tools = buildWebTools(ctx, throwingFetch);
    const out = (await tools.kufar_regions!.execute!({}, opts)) as string;
    const parsed = JSON.parse(out) as Array<{ name: string; rgn: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("rgn");
  });
});
