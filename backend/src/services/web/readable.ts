/**
 * Local readable extraction: HTML → main content → Markdown.
 *
 * Uses Mozilla Readability for article extraction and Turndown (with GFM
 * tables) for Markdown. Links/images are absolutised against the final URL;
 * `<pre>` whitespace is left to Turndown (no global whitespace collapsing).
 * Returns `null` when there is no usable content, so the caller can decide to
 * fall back to an external provider.
 */
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ReadablePage {
  title: string;
  markdown: string;
  description?: string;
  byline?: string;
  publishedTime?: string;
  siteName?: string;
  /** Characters of Markdown produced (useful for a provider fallback threshold). */
  charCount: number;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
gfm(turndown);

/** Resolve every href/src against the page URL so citations stay usable. */
function absolutize(root: Element, baseUrl: string): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    try {
      a.setAttribute("href", new URL(href, baseUrl).href);
    } catch {
      /* leave malformed URLs as-is */
    }
  }

  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    const raw =
      img.getAttribute("data-src") ??
      img.getAttribute("data-original") ??
      img.getAttribute("data-lazy-src") ??
      img.getAttribute("src");
    if (raw) {
      try {
        img.setAttribute("src", new URL(raw, baseUrl).href);
      } catch {
        /* leave malformed URLs as-is */
      }
    }
    img.removeAttribute("srcset");
    img.removeAttribute("data-src");
  }

  // Embeds are often the only pointer to a video/tweet; keep their URL as a link.
  for (const iframe of root.querySelectorAll<HTMLIFrameElement>("iframe")) {
    const src = iframe.getAttribute("src");
    if (!src) {
      iframe.remove();
      continue;
    }
    const link = root.ownerDocument.createElement("a");
    try {
      link.setAttribute("href", new URL(src, baseUrl).href);
    } catch {
      link.setAttribute("href", src);
    }
    link.textContent = "Embedded content";
    iframe.replaceWith(link);
  }
}

function meta(doc: Document, selector: string): string | undefined {
  const value = doc.querySelector(selector)?.getAttribute("content")?.trim();
  return value || undefined;
}

/** Extract readable Markdown from one HTML document. */
export function readableFromHtml(html: string, url: string): ReadablePage | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  try {
    const parsed = new Readability(doc, {
      charThreshold: 200,
      keepClasses: false,
    }).parse();

    if (parsed?.content) {
      const contentDom = new JSDOM(`<body><div id="readable-root">${parsed.content}</div></body>`, { url });
      const root = contentDom.window.document.getElementById("readable-root");
      try {
        if (root) {
          root
            .querySelectorAll("script, style, noscript, nav, footer, [role='navigation']")
            .forEach((el) => el.remove());
          absolutize(root, url);
          const markdown = turndown.turndown(root.innerHTML).trim();
          if (markdown) {
            return {
              title: parsed.title?.trim() || doc.title?.trim() || url,
              markdown,
              description: parsed.excerpt?.trim() || meta(doc, 'meta[name="description"]') || meta(doc, 'meta[property="og:description"]'),
              byline: parsed.byline?.trim() || meta(doc, 'meta[name="author"]'),
              publishedTime:
                parsed.publishedTime?.trim() ||
                meta(doc, 'meta[property="article:published_time"]') ||
                meta(doc, 'meta[name="article:published_time"]'),
              siteName: parsed.siteName?.trim() || meta(doc, 'meta[property="og:site_name"]'),
              charCount: markdown.length,
            };
          }
        }
      } finally {
        contentDom.window.close();
      }
    }

    // Readability can reject listing/forum pages. Fall back to the largest
    // semantic container, still without the old denylist cleanup.
    const container =
      doc.querySelector("article") ??
      doc.querySelector("main") ??
      doc.querySelector('[role="main"]') ??
      doc.body;
    if (!container) return null;

    const fallback = container.cloneNode(true) as Element;
    fallback
      .querySelectorAll("script, style, noscript, nav, footer, [role='navigation']")
      .forEach((el) => el.remove());
    absolutize(fallback, url);
    const markdown = turndown.turndown(fallback.innerHTML).trim();
    if (!markdown) return null;

    return {
      title: doc.title?.trim() || url,
      markdown,
      description: meta(doc, 'meta[name="description"]') || meta(doc, 'meta[property="og:description"]'),
      byline: meta(doc, 'meta[name="author"]'),
      publishedTime:
        meta(doc, 'meta[property="article:published_time"]') ||
        meta(doc, 'meta[name="article:published_time"]'),
      siteName: meta(doc, 'meta[property="og:site_name"]'),
      charCount: markdown.length,
    };
  } catch {
    return null;
  } finally {
    dom.window.close();
  }
}
