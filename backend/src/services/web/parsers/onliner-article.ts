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

/** Паттерн URL детальной статьи Onliner: /YYYY/MM/DD/slug */
export const ONLINER_ARTICLE_PATH = /^\/\d{4}\/\d{2}\/\d{2}\/[^/?#]+/;

export function isOnlinerArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".onliner.by")) return false;
    return ONLINER_ARTICLE_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

function parseViews(text: string): number {
  const num = String(text).replace(/\s/g, "").replace(/\u00a0/g, "");
  const parsed = Number.parseInt(num, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parseOnlinerArticle(html: string, url: string): NewsArticle | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const container = doc.querySelector(".news-container");
  if (!container) {
    dom.window.close();
    return null;
  }

  const source = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "onliner.by";
    }
  })();

  let title = "";
  let date = "";
  let timestamp: number | undefined;
  let views = 0;
  let description = "";
  let author: string | undefined;
  let body = "";

  const pageMetaScript = doc.querySelector('#page-meta[type="application/json"]');
  if (pageMetaScript?.textContent) {
    try {
      const meta = JSON.parse(pageMetaScript.textContent) as {
        page_title?: string;
        article_creator?: string;
        article_publication_date?: string;
      };
      if (meta.page_title) {
        title = meta.page_title.replace(/\s*-\s*[^-]+$/, "").trim();
      }
      if (meta.article_creator) author = meta.article_creator;
    } catch {
      /* ignore */
    }
  }

  const timestampAttr = container.getAttribute("data-post-date");
  if (timestampAttr) {
    const t = Number.parseInt(timestampAttr, 10);
    if (!Number.isNaN(t)) timestamp = t;
  }

  const header = container.querySelector(".news-header");
  if (header) {
    const titleEl = header.querySelector(".news-header__title");
    if (titleEl?.textContent && !title) title = titleEl.textContent.trim();

    const timeEl = header.querySelector(".news-header__time");
    if (timeEl?.textContent) date = timeEl.textContent.trim();

    const viewsEl = header.querySelector(".news-header__button_views");
    if (viewsEl?.textContent) views = parseViews(viewsEl.textContent);

    const authorEl = header.querySelector(".news-header__author-link");
    if (authorEl?.textContent && !author) author = authorEl.textContent.trim();
  }

  const entry = container.querySelector(".news-entry");
  if (entry) {
    const speechEl = entry.querySelector(".news-entry__speech");
    if (speechEl?.textContent) description = speechEl.textContent.trim();
  }

  const textEl = container.querySelector(".news-text");
  if (textEl) {
    body = turndown.turndown(textEl.innerHTML).trim();
  }

  const tags: string[] = [];
  const tagLinks = container.querySelectorAll(".news-reference__link_secondary");
  for (const link of tagLinks) {
    const t = link.textContent?.trim();
    if (t) tags.push(t);
  }

  dom.window.close();

  if (!title && !body) return null;

  return {
    title: title || "Без заголовка",
    url,
    date,
    timestamp,
    views,
    description,
    author,
    body,
    tags: tags.length > 0 ? tags : undefined,
    source,
  };
}
