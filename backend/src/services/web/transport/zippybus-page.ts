import { JSDOM } from "jsdom";

export interface ZippybusResult {
  html: string;
  title: string;
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Returns true for any zippybus.com/by/ page.
 * Matches: /by/{city}, /by/{city}/{transport}, /by/{city}/{transport}/{route},
 *          /by/{city}/{transport}/{route}/{direction}/stop-{id}
 */
export function isZippybusUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "zippybus.com" &&
      u.pathname.startsWith("/by/") &&
      u.pathname.length > 4 // more than just "/by/"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Junk selectors
// ---------------------------------------------------------------------------

const JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "iframe",
  "button", "form", "input", "select", "textarea",
  "[aria-hidden='true']", "[hidden]",
  // Ads
  "[class*='advert']", "[class*='ad-']",
  // Navigation / footer
  "header", "footer", "nav", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  // Cookie / popup
  "[class*='cookie']", "[class*='popup']", "[class*='modal']",
  // Social
  "[class*='social']", "[class*='share']",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeJunk(root: Element, selectors: string[]): void {
  for (const sel of selectors) {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch { /* ignore */ }
  }
}

function cleanAttributes(root: Element): void {
  const KEEP = new Set(["href", "data-time"]);
  const walk = (el: Element) => {
    const toRemove: string[] = [];
    for (const attr of el.attributes) {
      if (!KEEP.has(attr.name)) toRemove.push(attr.name);
    }
    toRemove.forEach((a) => el.removeAttribute(a));
    for (const child of el.children) walk(child);
  };
  walk(root);
}

function removeEmptyLeaves(root: Element): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of root.querySelectorAll("div, span, p, section, ul, li")) {
      const text = el.textContent?.trim() ?? "";
      if (!text && el.querySelectorAll("a[href]").length === 0) {
        el.remove();
        changed = true;
      }
    }
  }
}

function removeEmptyLinks(root: Element): void {
  for (const a of root.querySelectorAll("a")) {
    if (!(a.textContent?.trim())) {
      a.remove();
    }
  }
}

function collapse(html: string): string {
  let result = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result.replace(/<(div|span|p|section|a|ul|li)><\/\1>/gi, "");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

export function extractZippybusContent(html: string): ZippybusResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title =
    doc.querySelector("h1")?.textContent?.trim() ??
    doc.querySelector("title")?.textContent?.trim() ??
    "";

  // Page has multiple .container elements (navbar, content, footer).
  // Pick the one that contains the <h1> page header.
  let container: Element | null = null;
  for (const c of doc.querySelectorAll(".container")) {
    if (c.querySelector("h1, .page-header")) {
      container = c;
      break;
    }
  }
  if (!container) return null;

  const root = container.cloneNode(true) as Element;
  removeJunk(root, JUNK);

  // Remove SEO text paragraphs (long descriptive text at the bottom)
  for (const p of root.querySelectorAll("p.text-justify")) {
    p.remove();
  }

  // Remove copyright notice
  for (const em of root.querySelectorAll("em")) {
    if (em.textContent?.includes("Копирование расписаний")) {
      em.closest("p")?.remove() ?? em.remove();
    }
  }

  removeEmptyLinks(root);
  removeEmptyLeaves(root);
  cleanAttributes(root);

  const cleaned = collapse(root.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}
