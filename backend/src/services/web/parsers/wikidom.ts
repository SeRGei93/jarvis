import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";
import { extractImageUrl, toAbsoluteHttp } from "./image.js";

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

/** Parses the current Wikidom `DD.MM.YYYY` / ISO `<time datetime>` formats. */
function parseTimestamp(dateText: string, datetime?: string | null): number | undefined {
  if (datetime) {
    const parsed = Date.parse(datetime);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  const dotted = dateText.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    const day = Number.parseInt(dotted[1], 10);
    const month = Number.parseInt(dotted[2], 10) - 1;
    const year = Number.parseInt(dotted[3], 10);
    if (!Number.isNaN(day) && !Number.isNaN(month) && !Number.isNaN(year)) {
      return Math.floor(new Date(year, month, day).getTime() / 1000);
    }
  }
  return parseDate(dateText);
}

function parseCount(text: string | undefined): number {
  const digits = (text ?? "").replace(/[^\d]/g, "");
  const parsed = Number.parseInt(digits, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  image?: string;
  img?: string;
  cover?: string;
  picture?: string;
  thumbnail?: string;
}

/**
 * Current Wikidom markup (Next.js SSR): article cards are ordinary anchors
 * ending in `-p`; the old `v-magazine :data-source` JSON is gone. Parse both
 * the hero poster and the compact analytics list without a browser.
 */
function parseHtmlItems(doc: Document, baseUrl: string): NewsItem[] {
  const result: NewsItem[] = [];
  const seen = new Set<string>();

  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/blog/"][href$="-p"]')) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const title =
      anchor.querySelector(".magazine-poster__title")?.textContent?.trim() ??
      anchor.querySelector(".blog-analytics-list__name")?.textContent?.trim() ??
      anchor.querySelector("img")?.getAttribute("alt")?.trim() ??
      "";
    if (!title) continue;

    const timeEl = anchor.querySelector("time");
    const date = timeEl?.textContent?.trim() ?? "";
    const timestamp = parseTimestamp(date, timeEl?.getAttribute("datetime"));
    const views = parseCount(anchor.querySelector(".magazine-poster__views-text")?.textContent);
    const description = anchor.querySelector(".magazine-poster__text")?.textContent?.trim() ?? "";
    const label = anchor.querySelector(".magazine-poster__label")?.textContent?.trim() ?? "";
    const image = extractImageUrl(anchor, baseUrl);

    seen.add(url);
    result.push({
      title: label ? `[${label}] ${title}` : title,
      url,
      date,
      views,
      description,
      timestamp,
      image,
    });
  }

  return result;
}

export const wikidomParser: NewsParser = {
  domains: ["wikidom.by"],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const magazine = doc.querySelector("v-magazine");
    const raw = magazine?.getAttribute(":data-source");

    if (!raw) {
      const fallback = parseHtmlItems(doc, baseUrl);
      dom.window.close();
      return fallback;
    }

    let data: { items?: WikidomItem[] };
    try {
      data = JSON.parse(raw);
    } catch {
      const fallback = parseHtmlItems(doc, baseUrl);
      dom.window.close();
      return fallback;
    }

    if (!Array.isArray(data.items)) {
      dom.window.close();
      return [];
    }

    const result: NewsItem[] = [];
    for (const item of data.items) {
      if (!item.title || !item.link) continue;

      const url = new URL(item.link, baseUrl).href;
      const description = item.text ? stripHtml(item.text) : "";
      const date = item.date ?? "";
      const timestamp = date ? parseDate(date) : undefined;
      const label = item.labels?.[0]?.text ?? "";
      const titlePrefix = label ? `[${label}] ` : "";
      const image = toAbsoluteHttp(
        item.image ?? item.img ?? item.cover ?? item.picture ?? item.thumbnail,
        baseUrl,
      );

      result.push({
        title: `${titlePrefix}${item.title}`,
        url,
        date,
        views: item.views ?? 0,
        description,
        timestamp,
        image,
      });
    }

    dom.window.close();
    return result;
  },
};
