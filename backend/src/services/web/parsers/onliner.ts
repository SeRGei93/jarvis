import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";

const ONLINER_DOMAINS = [
  "money.onliner.by",
  "people.onliner.by",
  "tech.onliner.by",
] as const;

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function parseViews(text: string): number {
  const num = text.replace(/\s/g, "").replace(/\u00a0/g, "");
  const parsed = Number.parseInt(num, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export const onlinerParser: NewsParser = {
  domains: [...ONLINER_DOMAINS],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const container = doc.querySelector(".news-tidings");
    if (!container) {
      dom.window.close();
      return [];
    }

    const items = container.querySelectorAll(".news-tidings__item");
    const result: NewsItem[] = [];

    for (const item of items) {
      if (item.querySelector(".news-banner")) continue;

      const linkEl =
        item.querySelector<HTMLAnchorElement>("a.news-tidings__link") ??
        item.querySelector<HTMLAnchorElement>("a.news-tidings__stub");
      const href = linkEl?.getAttribute("href") ?? "";
      const url = resolveUrl(href, baseUrl);
      if (!url) continue;

      const title =
        item.querySelector(".news-tidings__link span")?.textContent?.trim() ??
        linkEl?.textContent?.trim() ??
        "";

      const description =
        item.querySelector(".news-tidings__speech")?.textContent?.trim() ?? "";

      const viewsEl = item.querySelector(".news-tidings__button_views");
      const views = parseViews(viewsEl?.textContent?.trim() ?? "0");

      const date =
        item.querySelector(".news-tidings__time")?.textContent?.trim() ?? "";

      const timestampAttr = item.getAttribute("data-post-date");
      const timestamp = timestampAttr
        ? Number.parseInt(timestampAttr, 10)
        : undefined;

      if (title) {
        result.push({
          title,
          url,
          date,
          views,
          description,
          timestamp: !Number.isNaN(timestamp) ? timestamp : undefined,
        });
      }
    }

    dom.window.close();
    return result;
  },
};
