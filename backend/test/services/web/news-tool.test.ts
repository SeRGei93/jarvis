import { describe, expect, it, vi } from "vitest";
import { buildWebTools } from "../../../src/mastra/tools/web.js";
import type { ToolContext } from "../../../src/mastra/tools/registry.js";
import { FETCH_LIMITS } from "../../../src/services/web/config.js";

const opts = { toolCallId: "test", messages: [] } as never;

// Schema-only assertions below: never execute a tool, and never hand it a real
// `fetch` (the suite installs a network-blocking stub, this keeps it explicit).
const neverFetch = (() => {
  throw new Error("network must not be used");
}) as unknown as typeof globalThis.fetch;

const ctx = {
  settings: {
    getTimeouts: async () => ({
      http_client: "30s",
      llm_request: "300s",
      llm_activity: "30s",
    }),
  },
} as unknown as ToolContext;

describe("serper_news tool (raw JSON)", () => {
  it("returns the Serper body verbatim and posts to /news", async () => {
    const raw = JSON.stringify({
      news: [{ title: "News", link: "https://n.test", date: "1 day" }],
      credits: 1,
    });
    const fetchFn = vi.fn(async () =>
      new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof globalThis.fetch;
    const tools = buildWebTools(ctx, fetchFn);

    const out = (await tools.serper_news!.execute!({ query: "news", region: "by" }, opts)) as string;
    expect(out).toBe(raw);
    expect(JSON.parse(out)).toMatchObject({ news: [{ title: "News" }], credits: 1 });

    const [input, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [
      string,
      RequestInit,
    ];
    expect(input).toBe("https://google.serper.dev/news");
    expect(JSON.parse(String(init.body))).toMatchObject({ q: "news", gl: "by", hl: "ru" });
  });

  it("returns an 'Error:' string (does not throw) when the request fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof globalThis.fetch;
    const tools = buildWebTools(ctx, fetchFn);

    const out = (await tools.serper_news!.execute!({ query: "news" }, opts)) as string;
    expect(out.startsWith("Error:")).toBe(true);
  });
});

describe("fetch_url maxChars contract", () => {
  it("accepts the documented range and rejects out-of-range values", () => {
    const tools = buildWebTools(ctx, neverFetch);
    const schema = tools.fetch_url!.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(
      schema.safeParse({ url: "https://example.test/", maxChars: FETCH_LIMITS.minMaxChars }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ url: "https://example.test/", maxChars: FETCH_LIMITS.defaultMaxChars }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ url: "https://example.test/", maxChars: FETCH_LIMITS.maxMaxChars }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ url: "https://example.test/", maxChars: FETCH_LIMITS.minMaxChars - 1 }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://example.test/", maxChars: FETCH_LIMITS.maxMaxChars + 1 }).success,
    ).toBe(false);
  });

  it("is optional (defaults are applied at execute time)", () => {
    const tools = buildWebTools(ctx, neverFetch);
    const schema = tools.fetch_url!.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ url: "https://example.test/" }).success).toBe(true);
  });
});
