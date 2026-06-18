import { describe, it, expect, vi } from "vitest";
import {
  performWebSearch,
  performWebSearchBatch,
  resolveSearchRegion,
} from "../../../src/services/web/search.js";

/** Build a JSON Response with the searxng `{ results: [...] }` shape. */
function searxResp(
  results: Array<{ title?: string; content?: string; url?: string }>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveSearchRegion", () => {
  it("returns the default region for undefined", () => {
    const r = resolveSearchRegion(undefined);
    expect(r.resolved).toBe("ru-by");
    expect(r.requested).toBe("default");
  });

  it("maps aliases to a canonical region", () => {
    expect(resolveSearchRegion("belarus").resolved).toBe("ru-by");
    expect(resolveSearchRegion("by").resolved).toBe("ru-by");
    expect(resolveSearchRegion("ru").resolved).toBe("ru-ru");
  });

  it("maps global/world aliases to the worldwide region (not Belarus)", () => {
    expect(resolveSearchRegion("global").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("world").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("all").resolved).toBe("wt-wt");
    expect(resolveSearchRegion("wt").resolved).toBe("wt-wt");
  });

  it("passes a xx-yy literal through unchanged", () => {
    const r = resolveSearchRegion("de-de");
    expect(r.resolved).toBe("de-de");
    expect(r.requested).toBe("de-de");
  });

  it("falls back (with a note) for an unknown region", () => {
    const r = resolveSearchRegion("atlantis");
    expect(r.resolved).toBe("ru-by");
    expect(r.note).toContain("Unknown region");
  });
});

describe("performWebSearch", () => {
  it("formats results as markdown with a Query/Results header", async () => {
    const fetchFn = vi.fn(async () =>
      searxResp([
        { title: "T1", content: "C1", url: "https://a.test" },
        { title: "T2", content: "C2", url: "https://b.test" },
      ]),
    ) as unknown as typeof globalThis.fetch;

    const md = await performWebSearch("test", { fetchFn, timeoutMs: 5000 });

    expect(md).toContain("# Web Search Results");
    expect(md).toContain("Query: test");
    expect(md).toContain("Results: 2");
    expect(md).toContain("T1");
    expect(md).toContain("C1");
    expect(md).toContain("https://a.test");
    expect(md).toContain("T2");
    expect(md).toContain("https://b.test");
  });

  it("returns a 'No results found' message for empty results", async () => {
    const fetchFn = vi.fn(async () => searxResp([])) as unknown as typeof globalThis.fetch;

    const md = await performWebSearch("nothing", { fetchFn, timeoutMs: 5000 });

    expect(md).toContain("No results found.");
    expect(md).toContain("Query: nothing");
  });

  it("retries on HTTP 500 then succeeds on the second call", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return searxResp([], 500);
      return searxResp([{ title: "Recovered", content: "after retry", url: "https://r.test" }]);
    }) as unknown as typeof globalThis.fetch;

    const md = await performWebSearch("retry", { fetchFn, timeoutMs: 5000 });

    expect(calls).toBe(2);
    expect(md).toContain("Recovered");
    expect(md).toContain("https://r.test");
  });
});

describe("performWebSearchBatch", () => {
  it("returns a grouped batch report mentioning every query", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // The query is in the `q` param — echo it back so each query's section is distinct.
      const q = new URL(url).searchParams.get("q") ?? "";
      return searxResp([{ title: `title-${q}`, content: `c-${q}`, url: `https://${q}.test` }]);
    }) as unknown as typeof globalThis.fetch;

    const md = await performWebSearchBatch(["q1", "q2"], { fetchFn, timeoutMs: 5000 });

    expect(md).toContain("# Batch Web Search Results");
    expect(md).toContain("Total queries: 2");
    expect(md).toContain("## Query: q1");
    expect(md).toContain("## Query: q2");
    expect(md).toContain("title-q1");
    expect(md).toContain("title-q2");
  });
});
