import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";

const MONTHS: Record<string, number> = {
  января: 0, февраля: 1, марта: 2, апреля: 3,
  мая: 4, июня: 5, июля: 6, августа: 7,
  сентября: 8, октября: 9, ноября: 10, декабря: 11,
};

/** Парсит "09 марта 2026" в unix timestamp */
function parseDate(dateStr: string): number | undefined {
  const m = dateStr.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return undefined;
  const day = Number.parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  const year = Number.parseInt(m[3], 10);
  if (month === undefined || Number.isNaN(day) || Number.isNaN(year)) return undefined;
  return Math.floor(new Date(year, month, day).getTime() / 1000);
}

function stripHtml(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`);
  const text = dom.window.document.body.textContent?.trim() ?? "";
  dom.window.close();
  return text;
}

interface WikidomItem {
  link?: string;
  title?: string;
  text?: string;
  date?: string;
  views?: number;
  labels?: { text: string }[];
}

export const wikidomParser: NewsParser = {
  domains: ["wikidom.by"],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const magazine = doc.querySelector("v-magazine");
    const raw = magazine?.getAttribute(":data-source");
    dom.window.close();

    if (!raw) return [];

    let data: { items?: WikidomItem[] };
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }

    if (!Array.isArray(data.items)) return [];

    const result: NewsItem[] = [];
    for (const item of data.items) {
      if (!item.title || !item.link) continue;

      const url = new URL(item.link, baseUrl).href;
      const description = item.text ? stripHtml(item.text) : "";
      const date = item.date ?? "";
      const timestamp = date ? parseDate(date) : undefined;
      const label = item.labels?.[0]?.text ?? "";
      const titlePrefix = label ? `[${label}] ` : "";

      result.push({
        title: `${titlePrefix}${item.title}`,
        url,
        date,
        views: item.views ?? 0,
        description,
        timestamp,
      });
    }

    return result;
  },
};
