import { JSDOM } from "jsdom";
import type { NewsItem, NewsParser } from "./types.js";

export interface GismeteoResult {
  html: string; // Очищенный HTML
  title: string;
}

/** Заменяет кастомные элементы Gismeteo (value в атрибуте) на текст */
function replaceCustomElements(html: string): string {
  return html
    .replace(
      /<temperature-value\s+[^>]*value="(-?\d+)"[^>]*\/?>\s*(?:<\/temperature-value>)?/gi,
      "$1°"
    )
    .replace(
      /<speed-value\s+[^>]*value="([^"]*)"[^>]*\/?>\s*(?:<\/speed-value>)?/gi,
      "$1"
    )
    .replace(
      /<precipitation-value\s+[^>]*value="([^"]*)"[^>]*\/?>\s*(?:<\/precipitation-value>)?/gi,
      "$1"
    )
    .replace(
      /<pressure-value\s+[^>]*value="([^"]*)"[^>]*\/?>\s*(?:<\/pressure-value>)?/gi,
      "$1"
    )
    .replace(
      /<snow-value\s+[^>]*value="([^"]*)"[^>]*\/?>\s*(?:<\/snow-value>)?/gi,
      "$1"
    )
    .replace(
      /<temperature-value\s+[^>]*\/?>\s*(?:<\/temperature-value>)?/gi,
      ""
    )
    .replace(/<speed-value\s+[^>]*\/?>\s*(?:<\/speed-value>)?/gi, "")
    .replace(/<precipitation-value\s+[^>]*\/?>\s*(?:<\/precipitation-value>)?/gi, "")
    .replace(/<pressure-value\s+[^>]*\/?>\s*(?:<\/pressure-value>)?/gi, "")
    .replace(/<snow-value\s+[^>]*\/?>\s*(?:<\/snow-value>)?/gi, "");
}

/** Удаляет мусорные элементы из DOM-узла */
function removeJunk(root: Element): void {
  const junkSelectors = [
    "script", "style", "noscript",
    "img", "svg", "canvas", "picture",
    "button", ".button", "[role='button']",
    "form", "input", "select", "textarea",
    "iframe", "embed", "object",
    "nav", "header", "footer",
    "[class*='advert']", "[class*='ad-']", "[id*='ad-']",
    "[class*='banner']", "[class*='social']", "[class*='share']",
    ".widget-row-advert", ".js-widget-row-advert",
    ".widget-advert-wrap", ".widget-footer",
    ".widget-scroll-btns", ".feedback",
    // Декоративные блоки без текстовых данных
    ".now-astro-map", ".now-astro-sun", ".now-astro-line",
    // Иконки погоды (только картинки, без текста)
    ".weather-icon-group", ".icon",
    // Кнопки прокрутки виджета
    ".widget-scroll-btns",
  ];

  junkSelectors.forEach((selector) => {
    try {
      root.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // игнорируем невалидные селекторы
    }
  });
}

/** Удаляет служебные атрибуты, оставляя только семантически значимые */
function cleanAttributes(root: Element): void {
  const KEEP_ATTRS = new Set(["class", "data-row", "data-text", "data-tooltip", "href", "colspan", "rowspan"]);

  const walk = (el: Element) => {
    const toRemove: string[] = [];
    for (const attr of el.attributes) {
      if (!KEEP_ATTRS.has(attr.name)) toRemove.push(attr.name);
    }
    toRemove.forEach((a) => el.removeAttribute(a));
    for (const child of el.children) walk(child);
  };
  walk(root);
}

export function isGismeteoWeatherUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const validHosts = [
      "www.gismeteo.ru", "gismeteo.ru",
      "www.gismeteo.by", "gismeteo.by",
      "www.gismeteo.ua", "gismeteo.ua",
      "www.gismeteo.kz", "gismeteo.kz",
      "www.gismeteo.md", "gismeteo.md",
      "www.gismeteo.lt", "gismeteo.lt",
      "www.gismeteo.lv", "gismeteo.lv",
      "www.gismeteo.ee", "gismeteo.ee",
    ];
    if (!validHosts.includes(host)) return false;
    return u.pathname.startsWith("/weather-");
  } catch {
    return false;
  }
}

/**
 * Извлекает данные о погоде, очищает от мусора и возвращает HTML.
 * Не делает конвертацию в markdown — возвращает очищенный HTML,
 * чтобы LLM мог прочитать структурированные данные без потерь.
 */
export function extractGismeteoContent(html: string): GismeteoResult | null {
  const processed = replaceCustomElements(html);
  const dom = new JSDOM(processed);
  const doc = dom.window.document;

  const title =
    doc.querySelector("title")?.textContent?.trim() ?? "Погода — Gismeteo";

  const container = doc.createElement("div");

  // Заголовок страницы
  const h1 = doc.querySelector("h1");
  if (h1) container.appendChild(h1.cloneNode(true));

  // Виджет текущей погоды (страница /now/)
  const nowWidget = doc.querySelector(".widget.now");
  if (nowWidget) container.appendChild(nowWidget.cloneNode(true));

  // Виджет почасового/дневного прогноза (/, /tomorrow/, /3-days/, /weekend/, /10-days/, /2-weeks/)
  const forecastWidget = doc.querySelector(".widget-weather-parameters");
  if (forecastWidget) container.appendChild(forecastWidget.cloneNode(true));

  // Если ни один виджет не найден — fallback на всю секцию C1
  if (container.children.length === 0 || (container.children.length === 1 && h1)) {
    const col = doc.querySelector('[data-column="C1"]');
    if (col) {
      const clone = col.cloneNode(true) as Element;
      container.appendChild(clone);
    }
  }

  if (container.children.length === 0) {
    dom.window.close();
    return null;
  }

  // Удаляем мусор и служебные атрибуты
  removeJunk(container);
  cleanAttributes(container);

  // Схлопываем пустые теги и лишние пробелы
  const cleanHtml = container.innerHTML
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  dom.window.close();

  if (!cleanHtml) return null;

  return { html: cleanHtml, title };
}

// --- Feed parser для новостей gismeteo ---

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/** Парсит ISO дату "2026-03-03T19:50:00" в Unix timestamp */
function parseIsoTimestamp(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  try {
    const ms = new Date(dateStr).getTime();
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  } catch {
    return undefined;
  }
}

export const gismeteoNewsParser: NewsParser = {
  domains: ["www.gismeteo.by"],
  parse(html: string, baseUrl: string): NewsItem[] {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const result: NewsItem[] = [];
    const seenUrls = new Set<string>();

    // 1. Карточки (.card-wrap → a.rss-card)
    const cards = doc.querySelectorAll(".card-wrap");
    for (const card of cards) {
      const linkEl = card.querySelector<HTMLAnchorElement>("a.rss-card");
      if (!linkEl) continue;

      const href = linkEl.getAttribute("href") ?? "";
      const url = resolveUrl(href, baseUrl);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      const title = card.querySelector(".text-title")?.textContent?.trim() ?? "";
      if (!title) continue;

      const description = card.querySelector(".text-excerpt")?.textContent?.trim() ?? "";
      const pubDate = linkEl.getAttribute("data-pub-date") ?? "";
      const tag = linkEl.getAttribute("data-tag") ?? "";
      const timestamp = parseIsoTimestamp(pubDate);

      const date = pubDate
        ? new Date(pubDate).toLocaleString("ru-BY", {
            day: "numeric", month: "long", year: "numeric",
            hour: "2-digit", minute: "2-digit",
          })
        : "";

      result.push({
        title,
        url,
        date: tag ? `${date} [${tag}]` : date,
        views: 0,
        description,
        timestamp,
      });
    }

    // 2. Список статей (.article-item)
    const articles = doc.querySelectorAll(".article-item");
    for (const article of articles) {
      const href =
        (article as Element).getAttribute("data-news-url") ??
        (article as HTMLAnchorElement).getAttribute("href") ?? "";
      const url = resolveUrl(href, baseUrl);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      const title = article.querySelector(".item-title")?.textContent?.trim() ?? "";
      if (!title) continue;

      const description = article.querySelector(".item-excerpt")?.textContent?.trim() ?? "";
      const pubDate = (article as Element).getAttribute("data-pub-date") ?? "";
      const tag = (article as Element).getAttribute("data-tag") ?? "";
      const timestamp = parseIsoTimestamp(pubDate);

      const date = pubDate
        ? new Date(pubDate).toLocaleString("ru-BY", {
            day: "numeric", month: "long", year: "numeric",
            hour: "2-digit", minute: "2-digit",
          })
        : article.querySelector(".item-date")?.textContent?.trim() ?? "";

      result.push({
        title,
        url,
        date: tag ? `${date} [${tag}]` : date,
        views: 0,
        description,
        timestamp,
      });
    }

    dom.window.close();
    return result;
  },
};
