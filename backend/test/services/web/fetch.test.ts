import { describe, it, expect, vi } from "vitest";
import {
  fetchPageAsMarkdown,
  fetchRawHtml,
  type PageParser,
} from "../../../src/services/web/fetch.js";
import { SsrfError, type LookupFn } from "../../../src/services/web/ssrf-guard.js";
import type { ContentProvider } from "../../../src/services/web/content/types.js";

/** A lookupFn that always resolves to a single public IPv4 (no real DNS). */
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/** Build an HTML Response (the fetch layer rejects non-html content-types). */
function htmlResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

// The generic path is now local Readability → Markdown; cleanHtml remains only
// as a last-resort fallback when Readability finds nothing.
describe("generic page readable extraction", () => {
  it("keeps the article and drops script/nav/banner junk", async () => {
    const html = `<!doctype html><html><head><title>My Title</title></head>
      <body>
        <script>alert('x')</script>
        <nav>menu links</nav>
        <div class="banner">buy now!!!</div>
        <article>
          <h1>Article Title</h1>
          <p>${"Long article paragraph. ".repeat(20)}</p>
          <p>Hello world</p>
        </article>
      </body></html>`;
    const fetchFn = vi.fn(async () => htmlResp(html)) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: false,
    });

    expect(out).toContain("Hello world");
    expect(out).toContain("Long article paragraph.");
    expect(out).not.toContain("alert(");
    expect(out).not.toContain("menu links");
    expect(out).not.toContain("buy now");
  });
});

describe("fetchPageAsMarkdown", () => {
  it("happy path: fetches and cleans into the markdown shell", async () => {
    const fetchFn = vi.fn(async () =>
      htmlResp(
        `<html><head><title>Page Title</title></head><body><p>Body text here</p></body></html>`,
      ),
    ) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/article", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: false,
    });

    expect(out.startsWith("# ")).toBe(true);
    expect(out).toContain("# Page Title");
    expect(out).toContain("Source: https://example.test/article");
    expect(out).toContain("Body text here");
  });

  it("uses an injected pageParser over the generic cleaner", async () => {
    const fetchFn = vi.fn(async () =>
      htmlResp(`<html><head><title>Ignored</title></head><body><p>raw</p></body></html>`),
    ) as unknown as typeof globalThis.fetch;

    const parser: PageParser = {
      match: () => true,
      extract: () => ({ html: "<p>X</p>", title: "PT" }),
    };

    const out = await fetchPageAsMarkdown("https://example.test/", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      pageParsers: [parser],
      useCache: false,
    });

    expect(out).toContain("# PT");
    expect(out).toContain("<p>X</p>");
    expect(out).not.toContain("Ignored");
  });

  it("short-circuits via an articleHandler before any fetch", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/news/1", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      articleHandler: async () => "MD!",
      useCache: false,
    });

    expect(out).toBe("MD!");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("blocks SSRF before fetching (fetchFn never called)", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    const privateLookup: LookupFn = async () => [{ address: "10.0.0.1", family: 4 }];

    await expect(
      fetchRawHtml("http://10.0.0.1/", 5000, { fetchFn, lookupFn: privateLookup }),
    ).rejects.toBeInstanceOf(SsrfError);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an oversized response (content-length over the body cap)", async () => {
    const huge = new Response("<html><body>ok</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": String(64 * 1024 * 1024), // 64 MiB > 8 MiB cap
      },
    });
    const fetchFn = vi.fn(async () => huge) as unknown as typeof globalThis.fetch;

    await expect(
      fetchRawHtml("https://example.test/", 5000, { fetchFn, lookupFn: publicLookup }),
    ).rejects.toThrow(/too large/i);
  });

  it("retries once with a cookie from a tiny JS challenge", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return htmlResp(
          `<html><head><title>Verification</title></head><body><script>let c="hg-security=test-cookie; path=/; max-age=120";document.cookie=c;location.reload()</script></body></html>`,
        );
      }
      expect((init?.headers as Record<string, string>).cookie).toBe("hg-security=test-cookie");
      return htmlResp("<html><body><p>real page</p></body></html>");
    }) as unknown as typeof globalThis.fetch;

    const out = await fetchRawHtml("https://example.test/page", 5000, {
      fetchFn,
      lookupFn: publicLookup,
    });

    expect(out).toContain("real page");
    expect(calls).toBe(2);
  });
});

// --- External content provider (vendor-neutral) ------------------------------

/** A provider returning a fixed markdown document. */
function fakeProvider(markdown = "Provider body"): ContentProvider & {
  fetchPage: ReturnType<typeof vi.fn>;
} {
  const fetchPage = vi.fn(async (req: { url: string; format: string }) => ({
    provider: "fake",
    requestedUrl: req.url,
    finalUrl: req.url,
    format: "markdown" as const,
    content: markdown,
    title: "Provider Title",
  }));
  return {
    name: "fake",
    configured: true,
    fetchPage,
  } as unknown as ContentProvider & { fetchPage: ReturnType<typeof vi.fn> };
}

describe("fetchPageAsMarkdown: external content provider", () => {
  it("prefers local Readability for SSR pages and does not spend a provider credit", async () => {
    const provider = fakeProvider("# Provider\n\nProvider body");
    const article = `<html><body><article><h1>Local title</h1><p>${"Local article paragraph. ".repeat(20)}</p></article></body></html>`;
    const fetchFn = vi.fn(async () => htmlResp(article)) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/article", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      contentProvider: provider,
      useCache: false,
    });

    expect(out).toContain("Local article paragraph.");
    expect(out).not.toContain("Provider body");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(provider.fetchPage).not.toHaveBeenCalled();
  });

  it("falls back to the provider when local HTML has no readable content", async () => {
    const provider = fakeProvider("Provider shell content");
    const fetchFn = vi.fn(async () =>
      htmlResp("<html><body><div id='app'></div><noscript>enable JS</noscript></body></html>"),
    ) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/app", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      contentProvider: provider,
      useCache: false,
    });

    expect(out).toContain("Provider shell content");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(provider.fetchPage).toHaveBeenCalledOnce();
  });

  it("prefers a matching specialised parser over the provider", async () => {
    const provider = fakeProvider();
    const parser: PageParser = {
      match: () => true,
      extract: () => ({ html: "<p>local parser</p>", title: "Local" }),
    };
    const fetchFn = vi.fn(async () =>
      new Response("<html><body>raw</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/page", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      pageParsers: [parser],
      contentProvider: provider,
      useCache: false,
    });

    expect(out).toContain("local parser");
    expect(provider.fetchPage).not.toHaveBeenCalled();
  });

  it("falls back to the provider when the local fetch fails", async () => {
    const provider = fakeProvider("Provider fallback");
    const fetchFn = vi.fn(async () => {
      throw new Error("local boom");
    }) as unknown as typeof globalThis.fetch;
    const parser: PageParser = { match: () => true, extract: () => null };

    const out = await fetchPageAsMarkdown("https://example.test/page", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      pageParsers: [parser],
      contentProvider: provider,
      useCache: false,
    });

    expect(out).toContain("Provider fallback");
    expect(provider.fetchPage).toHaveBeenCalledOnce();
  });

  it("falls back to the provider when the article handler returns null", async () => {
    const provider = fakeProvider("After article handler");
    const fetchFn = vi.fn(async () =>
      htmlResp("<html><body><div id='app'></div></body></html>"),
    ) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/news/1", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      contentProvider: provider,
      articleHandler: async () => null,
      useCache: false,
    });

    expect(out).toContain("After article handler");
    expect(provider.fetchPage).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not let the provider bypass the SSRF guard", async () => {
    const provider = fakeProvider();
    const privateLookup: LookupFn = async () => [{ address: "10.0.0.1", family: 4 }];

    await expect(
      fetchPageAsMarkdown("http://10.0.0.1/", 5000, {
        lookupFn: privateLookup,
        contentProvider: provider,
        useCache: false,
      }),
    ).rejects.toBeInstanceOf(SsrfError);

    expect(provider.fetchPage).not.toHaveBeenCalled();
  });
});
