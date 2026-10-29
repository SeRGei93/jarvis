import { describe, it, expect, vi } from "vitest";
import {
  FirecrawlProvider,
  FIRECRAWL_DEFAULT_BASE_URL,
} from "../../../src/services/web/content/firecrawl.js";
import { createContentProvider } from "../../../src/services/web/content/index.js";
import type { Env } from "../../../src/config/env.js";

/** Build a Firecrawl-shaped JSON response. */
function firecrawlResponse(
  data: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FirecrawlProvider", () => {
  it("posts the scrape request and normalises markdown + metadata", async () => {
    const fetchFn = vi.fn(async () =>
      firecrawlResponse({
        markdown: "# Hello\n\nBody",
        metadata: {
          title: ["Page Title", "Site"],
          description: "Desc",
          url: "https://example.test/final",
          statusCode: 200,
          publishedTime: "2026-10-29T10:00:00Z",
        },
      }),
    ) as unknown as typeof globalThis.fetch;

    const provider = new FirecrawlProvider({
      apiKey: "fc-test",
      fetchFn,
      baseUrl: "https://firecrawl.local/",
    });

    const page = await provider.fetchPage({
      url: "https://example.test/a",
      format: "markdown",
      timeoutMs: 5000,
      maxAgeMs: 0,
    });

    expect(page.provider).toBe("firecrawl");
    expect(page.content).toContain("# Hello");
    expect(page.title).toBe("Page Title");
    expect(page.description).toBe("Desc");
    expect(page.finalUrl).toBe("https://example.test/final");
    expect(page.publishedTime).toBe("2026-10-29T10:00:00Z");
    expect(page.statusCode).toBe(200);

    const [input, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(input).toBe("https://firecrawl.local/v2/scrape");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.url).toBe("https://example.test/a");
    expect(body.formats).toEqual(["markdown"]);
    expect(body.onlyMainContent).toBe(true);
    expect(body.maxAge).toBe(0);
    expect(body.timeout).toBe(5000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("requests rawHtml for the html format", async () => {
    const fetchFn = vi.fn(async () =>
      firecrawlResponse({
        rawHtml: "<html><body><h1>Raw</h1></body></html>",
        metadata: { title: "Raw page", url: "https://example.test/" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const provider = new FirecrawlProvider({ apiKey: "fc-test", fetchFn });
    const page = await provider.fetchPage({
      url: "https://example.test/",
      format: "html",
      timeoutMs: 5000,
    });

    expect(page.content).toContain("<h1>Raw</h1>");
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.formats).toEqual(["rawHtml"]);
    expect(body.onlyMainContent).toBe(false);
  });

  it("uses the cloud endpoint by default", async () => {
    const fetchFn = vi.fn(async () => firecrawlResponse({ markdown: "ok" })) as unknown as typeof globalThis.fetch;
    const provider = new FirecrawlProvider({ apiKey: "fc-test", fetchFn });

    await provider.fetchPage({ url: "https://example.test/", format: "markdown", timeoutMs: 5000 });

    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      `${FIRECRAWL_DEFAULT_BASE_URL}/v2/scrape`,
    );
  });

  it("throws a provider error on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: "insufficient credits" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const provider = new FirecrawlProvider({ apiKey: "fc-test", fetchFn });

    await expect(
      provider.fetchPage({ url: "https://example.test/", format: "markdown", timeoutMs: 5000 }),
    ).rejects.toMatchObject({
      name: "ContentProviderError",
      provider: "firecrawl",
      status: 402,
      message: expect.stringContaining("insufficient credits"),
    });
  });

  it("rejects an empty page instead of returning an empty document", async () => {
    const fetchFn = vi.fn(async () => firecrawlResponse({ markdown: "   " })) as unknown as typeof globalThis.fetch;
    const provider = new FirecrawlProvider({ apiKey: "fc-test", fetchFn });

    await expect(
      provider.fetchPage({ url: "https://example.test/", format: "markdown", timeoutMs: 5000 }),
    ).rejects.toThrow(/empty page content/i);
  });

  it("is not configured without an API key", async () => {
    const provider = new FirecrawlProvider({ apiKey: "" });
    expect(provider.configured).toBe(false);
    await expect(
      provider.fetchPage({ url: "https://example.test/", format: "markdown", timeoutMs: 5000 }),
    ).rejects.toThrow(/not configured/i);
  });
});

describe("createContentProvider", () => {
  const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;

  function config(overrides: Record<string, unknown>): Env {
    return { ...overrides } as unknown as Env;
  }

  it("builds Firecrawl when the key is present", () => {
    const provider = createContentProvider(
      config({ CONTENT_PROVIDER: "firecrawl", FIRECRAWL_API_KEY: "fc-test" }),
      fetchFn,
    );
    expect(provider?.name).toBe("firecrawl");
    expect(provider?.configured).toBe(true);
  });

  it("returns undefined for none/local and unknown providers", () => {
    expect(
      createContentProvider(config({ CONTENT_PROVIDER: "none", FIRECRAWL_API_KEY: "fc-test" }), fetchFn),
    ).toBeUndefined();
    expect(
      createContentProvider(config({ CONTENT_PROVIDER: "local", FIRECRAWL_API_KEY: "fc-test" }), fetchFn),
    ).toBeUndefined();
    expect(
      createContentProvider(config({ CONTENT_PROVIDER: "other", FIRECRAWL_API_KEY: "fc-test" }), fetchFn),
    ).toBeUndefined();
  });

  it("returns undefined when Firecrawl is selected without a key", () => {
    expect(
      createContentProvider(config({ CONTENT_PROVIDER: "firecrawl" }), fetchFn),
    ).toBeUndefined();
  });
});
