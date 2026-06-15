import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type { NewsArticle } from "./types.js";

export interface RealtResult {
  html: string;
  title: string;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.addRule("applicationLdJson", {
  filter: (node) =>
    node.nodeName === "SCRIPT" &&
    node.getAttribute?.("type") === "application/ld+json",
  replacement: (content) =>
    content.trim() ? `\n\n\`\`\`json\n${content.trim()}\n\`\`\`\n\n` : "",
});

/** Возвращает true для страниц объявлений realt.by */
export function isRealtObjectUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "realt.by" || u.hostname === "www.realt.by") &&
      /\/object\/\d+\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** Возвращает true для страниц статей/новостей realt.by */
export function isRealtArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "realt.by" || u.hostname === "www.realt.by") &&
      /\/news\/(?:[^/]+\/)*article\/\d+\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** Возвращает true для любого URL realt.by */
export function isRealtUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "realt.by" || u.hostname === "www.realt.by";
  } catch {
    return false;
  }
}

/** Удаляет мусорные элементы из объявления (React-приложение) */
function removeObjectJunk(root: Element): void {
  const selectors = [
    "script", "style", "noscript",
    // Изображения и иконки
    "img", "svg", "picture",
    // Слайдер и галерея изображений
    ".swiper", "[class*='swiper']",
    // Кнопки, интерактивные элементы
    "button", "[role='button']",
    // Пустые рекламные теги
    "ins",
    // Sticky-колонка справа с ценой/контактами (дублируется в основном контенте)
    "[class*='content__columns'] > div:last-child",
    // Блок "рекомендуем" после карты
    "[class*='layout__bottom']",
  ];

  selectors.forEach((sel) => {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // игнорируем
    }
  });
}

/** Удаляет мусорные элементы из статьи (TYPO3) */
function removeArticleJunk(root: Element): void {
  const selectors = [
    "script", "style", "noscript",
    // Изображения
    "img", "svg",
    // Реклама (все ins-теги)
    "ins",
    // Слайдер фото
    ".js-news-slider",
    // Скрытые галереи (csc-textpic с hidden)
    "[data-hidden='hidden']",
    // "Читайте также" и похожие блоки
    ".exclusive-news",
    // Кнопки подписки на новости
    ".reading-box",
    // Теги статьи
    ".tags",
    // Нативная реклама Яндекса
    "[id^='id-C-A-']",
    // Хлебные крошки
    "[itemtype='http://schema.org/BreadcrumbList']",
    "[itemtype='https://schema.org/BreadcrumbList']",
    // Кнопки шаринга
    ".share-buttons", ".social-share",
  ];

  selectors.forEach((sel) => {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // игнорируем
    }
  });

  // Удаляем параграфы "Читайте также:" (нет CSS-класса)
  root.querySelectorAll("p").forEach((p) => {
    if (p.textContent?.trim().startsWith("Читайте также")) {
      // Удаляем этот параграф и все следующие p-ссылки подряд
      let next = p.nextElementSibling;
      p.remove();
      while (next && next.tagName === "P" && next.querySelector("a")) {
        const toRemove = next;
        next = next.nextElementSibling;
        toRemove.remove();
      }
    }
  });
}

/** Удаляет HTML-комментарии из строки */
function removeComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Очищает атрибуты, оставляя только семантически значимые */
function cleanAttributes(root: Element): void {
  const KEEP_ATTRS = new Set(["href", "itemprop", "itemscope", "itemtype", "colspan", "rowspan"]);

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

/**
 * Парсит статью realt.by (TYPO3) и возвращает NewsArticle с Markdown-телом.
 */
export function parseRealtArticle(html: string, url: string): NewsArticle | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const container = doc.querySelector(".inner-center-content");
  if (!container) {
    dom.window.close();
    return null;
  }

  const source = "realt.by";

  // Заголовок
  const titleEl = container.querySelector("h1");
  const title = titleEl?.textContent?.trim() ?? "";

  // Дата и просмотры из .header-of-news
  let date = "";
  let timestamp: number | undefined;
  let views = 0;

  // Предпочитаем машиночитаемую дату из <meta>
  const publishedMeta = doc.querySelector('meta[name="mediator_published_time"]');
  if (publishedMeta) {
    const content = publishedMeta.getAttribute("content");
    if (content) {
      const t = Date.parse(content);
      if (!Number.isNaN(t)) {
        timestamp = Math.floor(t / 1000);
        date = content;
      }
    }
  }

  const headerEl = container.querySelector(".header-of-news");
  if (headerEl) {
    // Дата в тексте параграфа (если meta не найден)
    if (!date) {
      const pEl = headerEl.querySelector("p");
      if (pEl) {
        const raw = pEl.textContent?.trim() ?? "";
        // Извлекаем только дату — первое слово (формат DD.MM.YYYY)
        const dateMatch = raw.match(/\d{2}\.\d{2}\.\d{4}/);
        if (dateMatch) date = dateMatch[0];
      }
    }
    // Просмотры
    const viewsEl = headerEl.querySelector(".views");
    if (viewsEl?.textContent) {
      const n = Number.parseInt(viewsEl.textContent.replace(/\s/g, ""), 10);
      if (!Number.isNaN(n)) views = n;
    }
  }

  // Тело статьи из .text-news
  let body = "";
  const bodyEl = container.querySelector(".text-news");
  if (bodyEl) {
    const clone = bodyEl.cloneNode(true) as Element;
    clone.querySelectorAll(
      "script:not([type='application/ld+json']), style, noscript, ins, img, svg, .js-news-slider, .exclusive-news, .reading-box, .tags, [id^='id-C-A-']"
    ).forEach((el) => el.remove());
    // Удаляем "Читайте также:"
    clone.querySelectorAll("p").forEach((p) => {
      if (p.textContent?.trim().startsWith("Читайте также")) {
        let next = p.nextElementSibling;
        p.remove();
        while (next && next.tagName === "P" && next.querySelector("a")) {
          const toRemove = next;
          next = next.nextElementSibling;
          toRemove.remove();
        }
      }
    });
    body = turndown.turndown(clone.innerHTML).trim();
  }

  dom.window.close();

  if (!title && !body) return null;

  return {
    title: title || "Без заголовка",
    url,
    date,
    timestamp,
    views,
    description: "",
    body,
    source,
  };
}

/**
 * Извлекает контент страницы объявления realt.by.
 * Объявления — React-приложение с тегом <main>.
 */
export function extractRealtObjectContent(html: string): RealtResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const main = doc.querySelector("main");
  if (!main) {
    dom.window.close();
    return null;
  }

  const container = main.cloneNode(true) as Element;

  removeObjectJunk(container);
  cleanAttributes(container);

  const cleanHtml = removeComments(container.innerHTML)
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  dom.window.close();

  if (!cleanHtml) return null;

  return { html: cleanHtml, title };
}

/**
 * Извлекает контент статьи realt.by.
 * Статьи — TYPO3, контент в .inner-center-content.
 */
export function extractRealtArticleContent(html: string): RealtResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const center = doc.querySelector(".inner-center-content");
  if (!center) {
    dom.window.close();
    return null;
  }

  const container = center.cloneNode(true) as Element;

  removeArticleJunk(container);
  cleanAttributes(container);

  const cleanHtml = removeComments(container.innerHTML)
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  dom.window.close();

  if (!cleanHtml) return null;

  return { html: cleanHtml, title };
}

/**
 * Универсальная функция: определяет тип страницы realt.by
 * и извлекает полезный контент.
 */
export function extractRealtContent(html: string, url: string): RealtResult | null {
  if (isRealtObjectUrl(url)) {
    return extractRealtObjectContent(html);
  }
  if (isRealtArticleUrl(url)) {
    return extractRealtArticleContent(html);
  }
  // Фолбэк: попытаться извлечь из main или .inner-center-content
  return extractRealtObjectContent(html) ?? extractRealtArticleContent(html);
}
