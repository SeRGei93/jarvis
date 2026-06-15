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

/** Паттерн URL детальной статьи Smartpress: /news/slug/ или /idea/category/slug/ */
export const SMARTPRESS_ARTICLE_PATH = /^\/(news|idea)(?:\/[^/]+)+\/?/;

export function isSmartpressArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "smartpress.by") return false;
    return SMARTPRESS_ARTICLE_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseSmartpressArticle(html: string, url: string): NewsArticle | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const container = doc.querySelector(".article-body");
  if (!container) {
    dom.window.close();
    return null;
  }

  const source = "smartpress.by";

  let title =
    container.getAttribute("data-title") ??
    doc.querySelector("h1")?.textContent?.trim() ??
    "";

  let date = "";
  let timestamp: number | undefined;
  let author: string | undefined;
  let body = "";

  const timeEl = container.querySelector(".time");
  const dateEl = container.querySelector(".date");
  if (timeEl?.textContent && dateEl?.textContent) {
    date = `${timeEl.textContent.trim()} ${dateEl.textContent.trim()}`;
    const [timeStr, dateStr] = [timeEl.textContent.trim(), dateEl.textContent.trim()];
    const d = dateStr.split(".");
    const t = timeStr.split(":");
    if (d.length === 3 && t.length >= 2) {
      const ts = new Date(
        Number.parseInt(d[2], 10),
        Number.parseInt(d[1], 10) - 1,
        Number.parseInt(d[0], 10),
        Number.parseInt(t[0], 10),
        Number.parseInt(t[1], 10)
      ).getTime();
      if (!Number.isNaN(ts)) timestamp = Math.floor(ts / 1000);
    }
  }

  const authorEl = container.querySelector(".event-data a[href*='about']");
  if (authorEl?.textContent) {
    author = authorEl.textContent.replace(/^Автор:\s*/i, "").trim();
  }

  const bodyEl = container.querySelector(".art-content");
  if (bodyEl) {
    const clone = bodyEl.cloneNode(true) as Element;
    clone
      .querySelectorAll("script:not([type='application/ld+json']), style, noscript")
      .forEach((el) => el.remove());
    for (const img of clone.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      const dataSrc = img.getAttribute("data-src");
      if (dataSrc && src?.startsWith("data:")) {
        try {
          img.setAttribute("src", new URL(dataSrc, url).href);
        } catch {
          img.setAttribute("src", dataSrc);
        }
      }
    }
    body = turndown.turndown(clone.innerHTML).trim();
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
    author,
    body,
    source,
  };
}
