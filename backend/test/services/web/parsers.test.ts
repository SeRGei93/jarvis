import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  formatNewsToMarkdown,
  formatArticleToMarkdown,
  formatNewsWithSourceToMarkdown,
  formatFeedSectionsToMarkdown,
  type NewsItemWithSource,
} from "../../../src/services/web/parsers/markdown.js";
import {
  getCacheIdForSite,
  mergeAndLimitNews,
} from "../../../src/services/web/parsers/index.js";
import { NEWS_PARSER_CACHE_VERSION } from "../../../src/services/web/config.js";
import { tochkaParser } from "../../../src/services/web/parsers/tochka.js";
import { onlinerParser } from "../../../src/services/web/parsers/onliner.js";
import { wikidomParser } from "../../../src/services/web/parsers/wikidom.js";
import { parseOnlinerArticle } from "../../../src/services/web/parsers/onliner-article.js";
import { extractImageUrl, toAbsoluteHttp, collectImageUrls } from "../../../src/services/web/parsers/image.js";
import type { NewsArticle, NewsFeedSection, NewsItem } from "../../../src/services/web/parsers/types.js";

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

  it("omits views entirely when they are unknown (no fake 0)", () => {
    const md = formatNewsToMarkdown([
      {
        title: "T",
        url: "https://n/1",
        date: "29 октября 2026",
        views: null,
        description: "x",
      },
    ]);
    expect(md).not.toContain("Просмотров: 0");
    expect(md).not.toContain("Просмотров:");
    expect(md).toContain("29 октября 2026");
  });
});

describe("news source health", () => {
  const healthy: NewsFeedSection = {
    source: "onliner.by",
    url: "https://onliner.by/",
    items: [
      {
        title: "Fresh",
        url: "https://onliner.by/1",
        date: "today",
        views: 10,
        description: "d",
      },
    ],
  };
  const empty: NewsFeedSection = {
    source: "tochka.by",
    url: "https://tochka.by/",
    items: [],
    status: "empty",
  };
  const failed: NewsFeedSection = {
    source: "smartpress.by",
    url: "https://smartpress.by/",
    items: [],
    status: "error",
    error: "HTTP 403",
  };

  it("shows the Sources block in the merged formatter when some items exist", () => {
    const merged: NewsItemWithSource[] = [{ ...healthy.items[0]!, source: "onliner.by" }];
    const md = formatNewsWithSourceToMarkdown(merged, [healthy, empty, failed]);

    expect(md).toContain("## Новости");
    expect(md).toContain("## Источники");
    expect(md).toContain("onliner.by: 1 новостей");
    expect(md).toContain("tochka.by: пусто (парсер вернул 0)");
    expect(md).toContain("smartpress.by: ошибка — HTTP 403");
  });

  it("reports how many of a source's items actually reached the digest", () => {
    const section: NewsFeedSection = {
      source: "onliner.by",
      url: "https://onliner.by/",
      items: [
        { title: "A", url: "https://onliner.by/a", date: "today", views: 1, description: "a" },
        { title: "B", url: "https://onliner.by/b", date: "today", views: 2, description: "b" },
      ],
    };
    const merged: NewsItemWithSource[] = [{ ...section.items[0]!, source: "onliner.by" }];
    const md = formatNewsWithSourceToMarkdown(merged, [section]);
    expect(md).toContain("onliner.by: 2 новостей (1 в дайджесте)");
  });

  it("shows the Sources block in the feed formatter too", () => {
    const md = formatFeedSectionsToMarkdown([healthy, empty, failed]);
    expect(md).toContain("Ошибка: HTTP 403");
    expect(md).toContain("## Источники");
    expect(md).toContain("tochka.by: пусто (парсер вернул 0)");
  });

  it("derives status from error/fallback/items when no explicit status is set", () => {
    const derived = formatFeedSectionsToMarkdown([
      { ...failed, status: undefined },
      { ...empty, status: undefined },
      { source: "wikidom.by", url: "https://wikidom.by/", items: [], fallbackMarkdown: "# page" },
    ]);
    expect(derived).toContain("smartpress.by: ошибка — HTTP 403");
    expect(derived).toContain("tochka.by: пусто (парсер вернул 0)");
    expect(derived).toContain("wikidom.by: fallback (markdown страницы)");
  });
});

describe("getCacheIdForSite", () => {
  it("does not collide for two different URLs on the same host", () => {
    const a = getCacheIdForSite("https://example.test/news?page=1");
    const b = getCacheIdForSite("https://example.test/news?page=2");
    expect(a).not.toBe(b);
  });

  it("includes the parser cache version (parser fixes invalidate old entries)", () => {
    expect(getCacheIdForSite("onliner.by")).toContain(`v${NEWS_PARSER_CACHE_VERSION}`);
    expect(getCacheIdForSite("https://example.test/feed")).toContain(
      `v${NEWS_PARSER_CACHE_VERSION}`,
    );
  });

  it("normalises query parameter order before hashing", () => {
    expect(getCacheIdForSite("https://example.test/x?b=2&a=1")).toBe(
      getCacheIdForSite("https://example.test/x?a=1&b=2"),
    );
  });
});

describe("mergeAndLimitNews", () => {
  function item(source: string, n: number, ts: number): NewsItemWithSource {
    return {
      title: `${source}-${n}`,
      url: `https://${source}/${n}`,
      date: "today",
      views: 0,
      description: "",
      source,
      timestamp: ts,
    };
  }
  function section(source: string, count: number, baseTs: number): NewsFeedSection {
    return {
      source,
      url: `https://${source}/`,
      items: Array.from({ length: count }, (_, i) => item(source, i, baseTs + i)),
    };
  }

  it("keeps a quota for every source so date-only feeds are not squeezed out", () => {
    const sections = [
      section("smartpress.by", 10, 1_000),
      section("tochka.by", 2, 10),
      section("wikidom.by", 2, 5),
      section("onliner.by", 10, 500),
    ];

    const merged = mergeAndLimitNews(sections, 10, 5, 2);
    const sources = merged.map((i) => i.source);
    expect(merged).toHaveLength(10);
    expect(sources.filter((s) => s === "onliner.by")).toHaveLength(5);
    expect(sources).toContain("tochka.by");
    expect(sources).toContain("wikidom.by");
  });

  it("deduplicates URLs across sections", () => {
    const sections = [section("onliner.by", 3, 100), section("onliner.by", 3, 100)];
    const merged = mergeAndLimitNews(sections, 50, 5, 2);
    expect(new Set(merged.map((i) => i.url)).size).toBe(merged.length);
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

  it("reads a background-image set on the element ITSELF (onliner news-header__image)", () => {
    const root = elementFrom(`<div class="hdr" style="background-image:url('https://content.test/h.jpg')"></div>`);
    const el = root.querySelector<HTMLElement>(".hdr")!;
    expect(extractImageUrl(el, "https://news.test/")).toBe("https://content.test/h.jpg");
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

  it("parses the newer news-tiles variant", () => {
    const html = `<html><body>
      <div class="news-tidings">
        <div class="news-tidings__item" data-post-date="1793250010">
          <div class="news-tiles__list"><div class="news-tiles__item">
            <a class="news-tiles__stub" href="/2026/10/29/new-tile"></a>
            <div class="news-tiles__button news-tiles__button_views">17 409</div>
            <div class="news-tiles__time">29 октября 2026 в 8:00</div>
            <div class="news-tiles__subtitle">Новый заголовок</div>
          </div></div>
        </div>
      </div>
    </body></html>`;

    const items = onlinerParser.parse(html, "https://money.onliner.by/");
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Новый заголовок");
    expect(items[0]!.url).toBe("https://money.onliner.by/2026/10/29/new-tile");
    expect(items[0]!.views).toBe(17409);
    expect(items[0]!.date).toBe("29 октября 2026 в 8:00");
  });
});

describe("wikidomParser", () => {
  it("falls back to the current SSR markup when v-magazine is gone", () => {
    const html = `<html><body>
      <div class="magazine__main">
        <a class="v-magazine-poster" href="/blog/first-114461-p">
          <time datetime="2026-10-29T10:00:00.000Z">29.10.2026</time>
          <h2 class="magazine-poster__title">Первый материал</h2>
          <div class="magazine-poster__text">Краткое описание</div>
          <img src="/upload/first.jpg" alt="Первый материал">
          <span class="magazine-poster__views-text">285</span>
        </a>
        <a class="blog-analytics-list__link" href="/blog/second-114262-p">
          <time datetime="2026-10-20T10:06:42.000Z">20.10.2026</time>
          <span class="blog-analytics-list__name">Второй материал</span>
        </a>
      </div>
    </body></html>`;

    const items = wikidomParser.parse(html, "https://wikidom.by/blog");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Первый материал",
      url: "https://wikidom.by/blog/first-114461-p",
      date: "29.10.2026",
      views: 285,
      description: "Краткое описание",
      image: "https://wikidom.by/upload/first.jpg",
    });
    expect(items[1]!.title).toBe("Второй материал");
    expect(items[1]!.timestamp).toBe(Math.floor(Date.parse("2026-10-20T10:06:42.000Z") / 1000));
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
      image: "https://news.test/photo.jpg",
    };
    const md = formatArticleToMarkdown(article);

    expect(md.startsWith("# Article Title")).toBe(true);
    expect(md).toContain("Источник: [news.test](https://news.test/a)");
    expect(md).toContain("Фото: https://news.test/photo.jpg");
    expect(md).toContain("Автор: Иван");
    expect(md).toContain("Дата: 15 февраля 2026");
    expect(md).toContain("Просмотров: 42");
    expect(md).toContain("Теги: tag1, tag2");
    expect(md).toContain("Lead paragraph");
    expect(md).toContain("Full article body.");
  });

  it("omits the Фото line when the article has no image", () => {
    const article: NewsArticle = {
      title: "T", url: "https://n/a", date: "", views: 0, description: "", body: "b", source: "n",
    };
    expect(formatArticleToMarkdown(article)).not.toContain("Фото:");
  });
});

describe("parseOnlinerArticle (image extraction)", () => {
  it("extracts the lead photo from the news-header__image background", () => {
    const html = `<html><body>
      <div class="news-container" data-post-date="1718700000">
        <div class="news-header">
          <div class="news-header__image" style="background-image: url('https://content.onliner.by/news/970x485/abc.jpg');"></div>
          <h1 class="news-header__title">Заголовок</h1>
          <div class="news-header__time">19 июня 2026</div>
        </div>
        <div class="news-entry"><div class="news-entry__speech">Лид.</div></div>
        <div class="news-text"><p>Тело статьи.</p></div>
      </div>
    </body></html>`;

    const article = parseOnlinerArticle(html, "https://people.onliner.by/2026/06/19/test");
    expect(article).not.toBeNull();
    expect(article!.title).toBe("Заголовок");
    expect(article!.image).toBe("https://content.onliner.by/news/970x485/abc.jpg");
    expect(article!.body).toContain("Тело статьи");
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
