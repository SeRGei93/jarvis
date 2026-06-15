import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import type { NewsArticle } from "./types.js";

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

/** Паттерн URL детальной статьи Tochka: /articles/category/slug/ */
export const TOCHKA_ARTICLE_PATH = /^\/articles\/[^/]+\/[^/?#]+\/?/;

export function isTochkaArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "tochka.by") return false;
    return TOCHKA_ARTICLE_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseTochkaArticle(html: string, url: string): NewsArticle | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const container = doc.querySelector(".l-news-detail");
  if (!container) {
    dom.window.close();
    return null;
  }

  const source = "tochka.by";

  let title = "";
  let date = "";
  let timestamp: number | undefined;
  let body = "";

  const titleEl = container.querySelector("h1[itemprop='headline']") ??
    container.querySelector("h1.page-title") ??
    container.querySelector("h1");
  if (titleEl?.textContent) title = titleEl.textContent.trim();

  const timeEl = container.querySelector("time[itemprop='datePublished']");
  if (timeEl?.textContent) {
    date = timeEl.textContent.trim();
    const datetime = timeEl.getAttribute("datetime");
    if (datetime) {
      const t = Date.parse(datetime);
      if (!Number.isNaN(t)) timestamp = Math.floor(t / 1000);
    }
  }

  const bodyEl = container.querySelector(".b-news-detail-body[itemprop='articleBody']") ??
    container.querySelector("[itemprop='articleBody']");
  if (bodyEl) {
    const clone = bodyEl.cloneNode(true) as Element;
    const toRemove = clone.querySelectorAll(
      "script:not([type='application/ld+json']), style, noscript, .adfox-between-paragraph, .adfox-banner, [class*='adfox']"
    );
    toRemove.forEach((el) => el.remove());
    body = turndown.turndown(clone.innerHTML).trim();
  }

  const tags: string[] = [];
  const tagLinks = container.querySelectorAll(".news-detail-meta__item:not(.news-detail-meta__item--title)");
  for (const link of tagLinks) {
    const t = link.textContent?.trim();
    if (t && t !== "Теги") tags.push(t);
  }

  dom.window.close();

  if (!title && !body) return null;

  return {
    title: title || "Без заголовка",
    url,
    date,
    timestamp,
    views: 0,
    description: "",
    body,
    tags: tags.length > 0 ? tags : undefined,
    source,
  };
}
