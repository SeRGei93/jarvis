import { describe, it, expect, vi } from "vitest";
import {
  fetchPageAsMarkdown,
  fetchRawHtml,
  type PageParser,
} from "../../../src/services/web/fetch.js";
import { SsrfError, type LookupFn } from "../../../src/services/web/ssrf-guard.js";

/** A lookupFn that always resolves to a single public IPv4 (no real DNS). */
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/** Build an HTML Response (the fetch layer rejects non-html content-types). */
function htmlResp(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

// cleanHtml is not exported, so it is exercised through fetchPageAsMarkdown's
// generic-cleanup fallback (no parser/article handler → cleanHtml path).
describe("cleanHtml (via fetchPageAsMarkdown generic cleanup)", () => {
  it("drops script/nav/banner junk and keeps real text; title from <title>", async () => {
    const html = `<!doctype html><html><head><title>My Title</title></head>
      <body>
        <script>alert('x')</script>
        <nav>menu links</nav>
        <div class="banner">buy now!!!</div>
        <p>Hello world</p>
      </body></html>`;
    const fetchFn = vi.fn(async () => htmlResp(html)) as unknown as typeof globalThis.fetch;

    const out = await fetchPageAsMarkdown("https://example.test/", 5000, {
      fetchFn,
      lookupFn: publicLookup,
      useCache: false,
    });

    expect(out).toContain("# My Title"); // title from <title>
    expect(out).toContain("Hello world");
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
});
