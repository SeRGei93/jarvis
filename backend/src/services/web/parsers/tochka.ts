import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";

const TOCHKA_DOMAIN = "tochka.by" as const;

const MONTHS: Record<string, number> = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** Парсит "15 февраля 2026" в timestamp для сортировки */
function parseDateToTimestamp(dateStr: string): number | undefined {
  const trimmed = dateStr.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return undefined;
  const day = Number.parseInt(parts[0], 10);
  const monthKey = parts[1].toLowerCase();
  const month = MONTHS[monthKey];
  const year = Number.parseInt(parts[2], 10);
  if (
    Number.isNaN(day) ||
    month === undefined ||
    Number.isNaN(year)
  ) {
    return undefined;
  }
  try {
    return Math.floor(new Date(year, month, day).getTime() / 1000);
  } catch {
    return undefined;
  }
}

export const tochkaParser: NewsParser = {
  domains: [TOCHKA_DOMAIN],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const items = doc.querySelectorAll(".b-section-item");
    const result: NewsItem[] = [];

    for (const item of items) {
      const linkEl = item.querySelector<HTMLAnchorElement>(
        ".b-section-item__title a"
      ) ?? item.querySelector<HTMLAnchorElement>(
        ".b-section-item__picture a"
      );
      const href = linkEl?.getAttribute("href") ?? "";
      const url = resolveUrl(href, baseUrl);
      if (!url) continue;

      const title =
        linkEl?.getAttribute("title") ??
        linkEl?.textContent?.trim() ??
        "";

      const description =
        item.querySelector(".b-section-item__desc")?.textContent?.trim() ?? "";

      const metaItem = item.querySelector(".b-meta-item");
      const date = metaItem?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const timestamp = parseDateToTimestamp(date);

      if (title) {
        result.push({
          title: title.replace(/&quot;/g, '"'),
          url,
          date,
          views: 0,
          description,
          timestamp,
        });
      }
    }

    dom.window.close();
    return result;
  },
};
