import { JSDOM } from "jsdom";

export interface YandexPogodaResult {
  html: string;
  title: string;
}

/**
 * Селекторы элементов, которые нужно удалить — JSON, CSS, SVG, JS и прочий мусор.
 * script[type="application/ld+json"] не удаляем — это структурированные данные.
 */
const JUNK_SELECTORS = [
  "script:not([type='application/ld+json'])",
  "style",
  "link[rel='stylesheet']",
  "[type='application/json']",
  "noscript",
  "iframe",
  "template",
  "meta",
];

/**
 * Удаляет из HTML всё ненужное: script, JSON, CSS, SVG, JS и подобное.
 */
function stripJunk(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const body = doc.body;
  if (!body) {
    dom.window.close();
    return "";
  }

  for (const selector of JUNK_SELECTORS) {
    body.querySelectorAll(selector).forEach((el) => el.remove());
  }

  // Удаляем картинки: base64, SVG, static-maps.yandex.ru (раздувают объём)
  body.querySelectorAll("img").forEach((img) => {
    const src = (img.getAttribute("src") ?? "").toLowerCase();
    if (
      src.startsWith("data:") ||
      src.includes(".svg") ||
      src.includes("static-maps.yandex.ru") ||
      src.includes("maps.yandex.ru")
    ) {
      img.remove();
    }
  });

  // Удаляем инлайновые <svg>
  body.querySelectorAll("svg").forEach((el) => el.remove());

  // Удаляем HTML-комментарии
  const walker = doc.createTreeWalker(body, 8); // NodeFilter.SHOW_COMMENT
  const comments: Comment[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    comments.push(node as Comment);
    node = walker.nextNode();
  }
  comments.forEach((c) => c.remove());

  const result = body.innerHTML;
  dom.window.close();
  return result;
}

/**
 * Определяет, является ли URL страницей погоды Яндекс.Погода.
 * Примеры: https://yandex.ru/pogoda/ru/minsk, https://yandex.ru/pogoda/moscow
 */
export function isYandexPogodaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "yandex.ru" && host !== "www.yandex.ru") return false;
    return u.pathname.startsWith("/pogoda/");
  } catch {
    return false;
  }
}

/**
 * Извлекает контент страницы Яндекс.Погода:
 * берём весь body, вырезаем script, JSON, CSS, SVG, iframe и другой мусор.
 */
export function extractYandexPogodaContent(
  html: string
): YandexPogodaResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title =
    doc.querySelector("title")?.textContent?.trim() ??
    "Погода — Яндекс.Погода";

  const bodyHtml = doc.body?.innerHTML ?? "";
  dom.window.close();
  if (!bodyHtml.trim()) return null;

  const cleaned = stripJunk(html);

  return {
    html: cleaned,
    title,
  };
}
