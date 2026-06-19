import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  formatNewsToMarkdown,
  formatArticleToMarkdown,
} from "../../../src/services/web/parsers/markdown.js";
import { tochkaParser } from "../../../src/services/web/parsers/tochka.js";
import { onlinerParser } from "../../../src/services/web/parsers/onliner.js";
import { extractImageUrl, toAbsoluteHttp, collectImageUrls } from "../../../src/services/web/parsers/image.js";
import type { NewsArticle, NewsItem } from "../../../src/services/web/parsers/types.js";

/** Build a detached element wrapping `html` so image extraction can be tested. */
function elementFrom(html: string): Element {
  const dom = new JSDOM(`<body><div id="root">${html}</div></body>`, { url: "https://news.test/" });
  return dom.window.document.getElementById("root")!;
}

describe("formatNewsToMarkdown", () => {
  it("renders a bullet with linked title, description, views and date", () => {
    const items: NewsItem[] = [
      {
        title: "Big News",
        url: "https://news.test/1",
        date: "15 февраля 2026",
        views: 123,
        description: "Something happened",
      },
    ];
    const md = formatNewsToMarkdown(items);

    expect(md).toContain("**[Big News](https://news.test/1)**");
    expect(md).toContain("Something happened");
    expect(md).toContain("Просмотров: 123");
    expect(md).toContain("15 февраля 2026");
  });

  it("includes a 'Фото:' line with the image URL when present, omits it otherwise", () => {
    const withImg: NewsItem[] = [
      { title: "T", url: "https://n/1", date: "d", views: 1, description: "x", image: "https://n/pic.jpg" },
    ];
    expect(formatNewsToMarkdown(withImg)).toContain("Фото: https://n/pic.jpg");

    const noImg: NewsItem[] = [{ title: "T", url: "https://n/1", date: "d", views: 1, description: "x" }];
    expect(formatNewsToMarkdown(noImg)).not.toContain("Фото:");
  });

  it("returns an empty string for no items", () => {
    expect(formatNewsToMarkdown([])).toBe("");
  });
});

describe("extractImageUrl", () => {
  it("picks the largest srcset variant from a <picture><source>", () => {
    const el = elementFrom(
      `<picture><source srcset="https://img.test/s.webp 280w, https://img.test/l.webp 800w"></picture>`,
    );
    expect(extractImageUrl(el, "https://news.test/")).toBe("https://img.test/l.webp");
  });

  it("falls back to <img src> and resolves a relative URL", () => {
    const el = elementFrom(`<img src="/media/a.jpg">`);
    expect(extractImageUrl(el, "https://news.test/")).toBe("https://news.test/media/a.jpg");
  });

  it("reads an inline background-image url", () => {
    const el = elementFrom(`<div style="background-image:url('https://img.test/bg.jpg')"></div>`);
    expect(extractImageUrl(el, "https://news.test/")).toBe("https://img.test/bg.jpg");
  });

  it("rejects svg icons, data URIs and non-http schemes", () => {
    expect(extractImageUrl(elementFrom(`<img src="https://img.test/icon.svg">`), "https://news.test/")).toBeUndefined();
    expect(extractImageUrl(elementFrom(`<img src="data:image/png;base64,AAAA">`), "https://news.test/")).toBeUndefined();
    expect(toAbsoluteHttp("ftp://img.test/x.jpg", "https://news.test/")).toBeUndefined();
    expect(extractImageUrl(elementFrom(`<span>no image</span>`), "https://news.test/")).toBeUndefined();
  });

  it("prefers lazy data-src over a placeholder src and rejects placeholder URLs", () => {
    // lazy image: real URL in data-src, placeholder in src (the tochka empty_*.png case)
    expect(
      extractImageUrl(
        elementFrom(`<img src="https://img.test/empty_1600_1200.png" data-src="https://img.test/real.jpg">`),
        "https://news.test/",
      ),
    ).toBe("https://img.test/real.jpg");
    // pure placeholder → nothing
    expect(extractImageUrl(elementFrom(`<img src="https://img.test/placeholder.png">`), "https://news.test/")).toBeUndefined();
    expect(toAbsoluteHttp("https://img.test/assets/spacer.gif", "https://news.test/")).toBeUndefined();
    expect(toAbsoluteHttp("https://img.test/empty_1600_1200.png", "https://news.test/")).toBeUndefined();
  });
});

describe("collectImageUrls", () => {
  it("collects distinct image URLs (img then srcset), deduped and in order", () => {
    const el = elementFrom(
      `<img src="https://i/1.jpg">` +
        `<picture><source srcset="https://i/2-s.jpg 200w, https://i/2-l.jpg 800w"></picture>` +
        `<img src="https://i/1.jpg">` + // duplicate, skipped
        `<img src="https://i/3.jpg">`,
    );
    expect(collectImageUrls(el, "https://news.test/", 10)).toEqual([
      "https://i/1.jpg",
      "https://i/3.jpg",
      "https://i/2-l.jpg", // largest srcset variant
    ]);
  });

  it("honours the max cap", () => {
    const el = elementFrom(`<img src="https://i/1.jpg"><img src="https://i/2.jpg"><img src="https://i/3.jpg">`);
    expect(collectImageUrls(el, "https://news.test/", 2)).toHaveLength(2);
  });
});

describe("onlinerParser (image extraction)", () => {
  it("extracts the lead image from a news-tidings item's <picture>", () => {
    const html = `<html><body>
      <div class="news-tidings">
        <div class="news-tidings__item" data-post-date="1781792617">
          <a class="news-tidings__link" href="/2026/06/18/test"><span>Заголовок</span></a>
          <div class="news-tidings__speech">Описание</div>
          <div class="news-tidings__button_views">123</div>
          <div class="news-tidings__time">18 июня</div>
          <picture><source srcset="https://imgproxy.onliner.by/s.webp 280w, https://imgproxy.onliner.by/l.webp 800w"></picture>
        </div>
      </div>
    </body></html>`;

    const items = onlinerParser.parse(html, "https://money.onliner.by/");
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Заголовок");
    expect(items[0]!.url).toBe("https://money.onliner.by/2026/06/18/test");
    expect(items[0]!.image).toBe("https://imgproxy.onliner.by/l.webp");
  });
});

describe("formatArticleToMarkdown", () => {
  it("renders the article header, metadata and body", () => {
    const article: NewsArticle = {
      title: "Article Title",
      url: "https://news.test/a",
      date: "15 февраля 2026",
      views: 42,
      description: "Lead paragraph",
      author: "Иван",
      body: "Full article body.",
      tags: ["tag1", "tag2"],
      source: "news.test",
    };
    const md = formatArticleToMarkdown(article);

    expect(md.startsWith("# Article Title")).toBe(true);
    expect(md).toContain("Источник: [news.test](https://news.test/a)");
    expect(md).toContain("Автор: Иван");
    expect(md).toContain("Дата: 15 февраля 2026");
    expect(md).toContain("Просмотров: 42");
    expect(md).toContain("Теги: tag1, tag2");
    expect(md).toContain("Lead paragraph");
    expect(md).toContain("Full article body.");
  });
});

describe("tochkaParser (HTML → NewsItem[])", () => {
  it("extracts an item with title, resolved url, description and date", () => {
    const html = `<html><body>
      <div class="b-section-item">
        <div class="b-section-item__title">
          <a href="/news/123" title="Tochka Headline">Tochka Headline</a>
        </div>
        <div class="b-section-item__desc">A short description.</div>
        <div class="b-meta-item">15 февраля 2026</div>
      </div>
    </body></html>`;

    const items = tochkaParser.parse(html, "https://tochka.by/");

    expect(items.length).toBeGreaterThan(0);
    const first = items[0]!;
    expect(first.title).toBe("Tochka Headline");
    expect(first.url).toBe("https://tochka.by/news/123"); // relative href resolved against base
    expect(first.description).toBe("A short description.");
    expect(first.date).toBe("15 февраля 2026");
    // "15 февраля 2026" parses to a sortable timestamp.
    expect(typeof first.timestamp).toBe("number");
  });
});
