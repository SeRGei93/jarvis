import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";

export interface SmartpressResult {
  html: string;
  title: string;
}

/** Паттерн URL страницы списка новостей Smartpress */
export function isSmartpressNewsListUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "smartpress.by") return false;
    const path = u.pathname.replace(/\/$/, "");
    return path === "" || path === "/news" || path.startsWith("/news");
  } catch {
    return false;
  }
}

/**
 * Извлекает список новостей из .list-event (основной список, без aside).
 */
export function extractSmartpressNewsContent(html: string): SmartpressResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title = doc.querySelector("title")?.textContent?.trim() ?? "Новости — Smartpress.by";

  const list = doc.querySelector(".list-event:not(.aside__type-1)") ?? doc.querySelector(".list-event");
  if (!list) {
    dom.window.close();
    return null;
  }

  const clone = list.cloneNode(true) as Element;
  clone
    .querySelectorAll("script:not([type='application/ld+json']), style, noscript")
    .forEach((el) => el.remove());

  const result = {
    html: clone.outerHTML,
    title,
  };
  dom.window.close();
  return result;
}

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** Парсит "15.02.2026" и "22:00" в timestamp */
function parseDateTime(dateStr: string, timeStr: string): number | undefined {
  const d = dateStr.trim().split(".");
  const t = timeStr.trim().split(":");
  if (d.length !== 3 || t.length < 2) return undefined;
  const day = Number.parseInt(d[0], 10);
  const month = Number.parseInt(d[1], 10) - 1;
  const year = Number.parseInt(d[2], 10);
  const hours = Number.parseInt(t[0], 10);
  const minutes = Number.parseInt(t[1], 10);
  if ([day, month, year, hours, minutes].some(Number.isNaN)) return undefined;
  try {
    return Math.floor(new Date(year, month, day, hours, minutes).getTime() / 1000);
  } catch {
    return undefined;
  }
}

export const smartpressParser: NewsParser = {
  domains: ["smartpress.by"],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const list = doc.querySelector(".list-event:not(.aside__type-1)") ?? doc.querySelector(".list-event");
    if (!list) {
      dom.window.close();
      return [];
    }

    const items = list.querySelectorAll("li");
    const result: NewsItem[] = [];

    for (const li of items) {
      const linkEl = li.querySelector<HTMLAnchorElement>("p a") ?? li.querySelector<HTMLAnchorElement>("a.img-box");
      const href = linkEl?.getAttribute("href") ?? "";
      const url = resolveUrl(href, baseUrl);
      if (!url) continue;

      const title =
        linkEl?.textContent?.trim() ??
        li.querySelector("img")?.getAttribute("alt")?.trim() ??
        "";
      if (!title) continue;

      const timeEl = li.querySelector(".time");
      const dateEl = li.querySelector(".date");
      const timeStr = timeEl?.textContent?.trim() ?? "";
      const dateStr = dateEl?.textContent?.trim() ?? "";
      const date = [dateStr, timeStr].filter(Boolean).join(" ");
      const timestamp = parseDateTime(dateStr, timeStr);

      result.push({
        title: title.replace(/&quot;/g, '"'),
        url,
        date,
        views: 0,
        description: "",
        timestamp,
      });
    }

    dom.window.close();
    return result;
  },
};
