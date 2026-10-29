import { describe, it, expect } from "vitest";
import { readableFromHtml } from "../../../src/services/web/readable.js";

const LONG = "Long article paragraph with enough text for Readability. ".repeat(20);

describe("readableFromHtml", () => {
  it("extracts the article, metadata, absolute links and images", () => {
    const html = `<!doctype html><html><head>
      <title>Page Title</title>
      <meta name="description" content="Page description">
      <meta property="article:published_time" content="2026-10-29T10:00:00Z">
    </head><body>
      <nav>menu links</nav>
      <article>
        <h1>Article heading</h1>
        <p>${LONG}</p>
        <p><a href="/relative">a link</a></p>
        <figure><img src="/image.jpg" alt="An image"><figcaption>Caption</figcaption></figure>
        <pre><code>line1
    line2</code></pre>
      </article>
      <footer>footer junk</footer>
    </body></html>`;

    const page = readableFromHtml(html, "https://example.test/news/1");
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain("Article heading");
    expect(page!.markdown).toContain("Long article paragraph");
    expect(page!.markdown).toContain("[a link](https://example.test/relative)");
    expect(page!.markdown).toContain("![An image](https://example.test/image.jpg)");
    expect(page!.markdown).toContain("line1\n    line2"); // <pre> indentation preserved
    expect(page!.markdown).not.toContain("menu links");
    expect(page!.description).toBe("Page description");
    expect(page!.publishedTime).toBe("2026-10-29T10:00:00Z");
  });

  it("returns null for an empty document", () => {
    expect(readableFromHtml("<html><body></body></html>", "https://example.test/")).toBeNull();
  });

  it("falls back to <main> for non-article pages", () => {
    const html = `<html><body><main><h1>Docs</h1><p>${LONG}</p></main></body></html>`;
    const page = readableFromHtml(html, "https://example.test/docs");
    expect(page?.markdown).toContain("Docs");
    expect(page?.markdown).toContain("Long article paragraph");
  });
});
