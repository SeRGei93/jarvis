import { describe, it, expect } from "vitest";
import {
  formatNewsToMarkdown,
  formatArticleToMarkdown,
} from "../../../src/services/web/parsers/markdown.js";
import { tochkaParser } from "../../../src/services/web/parsers/tochka.js";
import type { NewsArticle, NewsItem } from "../../../src/services/web/parsers/types.js";

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

  it("returns an empty string for no items", () => {
    expect(formatNewsToMarkdown([])).toBe("");
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
