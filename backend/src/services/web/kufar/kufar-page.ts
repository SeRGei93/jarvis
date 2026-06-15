import { JSDOM } from "jsdom";

export interface KufarResult {
  html: string;
  title: string;
}

/** Selectors to strip from extracted content */
const JUNK_SELECTORS = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video",
  "button", "[role='button']",
  "iframe", "embed", "object",
  "[aria-hidden='true']", "[hidden]",
  "[class*='banner']", "[class*='popup']", "[class*='modal']",
  "[class*='cookie']", "[class*='social']", "[class*='share']",
  "[class*='recommend']", "[class*='related']", "[class*='similar']",
  "[class*='promo']", "[class*='partner']",
];

function removeJunk(root: Element): void {
  for (const sel of JUNK_SELECTORS) {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch { /* ignore */ }
  }
}

function cleanAttributes(root: Element): void {
  const KEEP = new Set(["href", "itemprop", "itemscope", "itemtype", "content"]);
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

function collapse(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

/**
 * Returns true for Kufar item pages.
 * Example: https://www.kufar.by/item/208933778
 */
export function isKufarItemUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.kufar.by" && /^\/item\/\d+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Extracts content from a Kufar item page.
 * Takes schema.org/Product block, strips junk, returns cleaned HTML.
 */
export function extractKufarItemContent(html: string): KufarResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const product = doc.querySelector('[itemtype="http://schema.org/Product"]');
  if (!product) return null;

  const container = product.cloneNode(true) as Element;

  // Remove breadcrumbs, junk
  container.querySelectorAll('[itemtype="http://schema.org/BreadcrumbList"]').forEach((el) => el.remove());
  removeJunk(container);

  // Remove duplicate seller/price blocks:
  // "О продавце" section, "Все характеристики"/"Развернуть описание" UI buttons,
  // disclaimer, response time
  const junkLeafTexts = [
    "Все характеристики", "Развернуть описание",
    "Kufar не несет ответственности", "Отвечает в течение",
  ];
  for (const el of container.querySelectorAll("div, span")) {
    const text = el.textContent?.trim() ?? "";
    if (el.children.length === 0 && junkLeafTexts.some((jt) => text.startsWith(jt))) {
      el.remove();
    }
  }

  // Remove "О продавце" h2 + parent (duplicated in sidebar)
  for (const h2 of container.querySelectorAll("h2")) {
    if (h2.textContent?.trim() === "О продавце") {
      (h2.parentElement ?? h2).remove();
    }
  }

  // Remove duplicate h5 seller blocks (sidebar repeats seller name)
  const h5s = container.querySelectorAll("h5");
  for (let i = 1; i < h5s.length; i++) {
    // Keep first h5, remove subsequent duplicates and their parent containers
    const parent = h5s[i].closest("div");
    if (parent?.parentElement) parent.parentElement.remove();
    else h5s[i].remove();
  }

  // Remove empty leaf elements
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of container.querySelectorAll("div, span, p")) {
      if (!el.innerHTML.trim()) {
        el.remove();
        changed = true;
      }
    }
  }

  cleanAttributes(container);
  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}

/**
 * Returns true for Kufar listing/search pages.
 * Examples: /l, /l/elektronika, /l/r~minsk/telefony-i-planshety
 */
export function isKufarListingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.kufar.by" && /^\/l(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Extracts structured listing items from a Kufar search page (browser-rendered HTML).
 * Parses each item card for title, price, location, date, and link.
 */
export function extractKufarListingContent(html: string): KufarResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // Result count from h1 (e.g. "Объявления по запросу «...» в Беларуси")
  const h1 = doc.querySelector("h1");
  const heading = h1?.textContent?.trim() ?? "";

  // Find all item links — each listing card has <a href="...kufar.by/item/ID...">
  const links = doc.querySelectorAll('a[href*="/item/"]');
  const items: string[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const idMatch = href.match(/\/item\/(\d+)/);
    if (!idMatch) continue;
    const itemId = idMatch[1];
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const itemUrl = `https://www.kufar.by/item/${itemId}`;

    // Title from <h3>
    const h3 = link.querySelector("h3");
    const itemTitle = h3?.textContent?.trim() ?? "";
    if (!itemTitle) continue;

    // Price: first <span> containing "р."
    let price = "";
    for (const span of link.querySelectorAll("span")) {
      const text = span.textContent?.trim() ?? "";
      if (/[\d\s.,]+р\./.test(text)) {
        price = text;
        break;
      }
    }

    // Location and date: in a <div> after <h3> containing <p> (location) and <span> (date)
    let location = "";
    let date = "";
    if (h3) {
      let cur = h3.nextElementSibling;
      while (cur) {
        const p = cur.querySelector?.("p");
        const span = cur.querySelector?.("span");
        if (p && span) {
          location = p.textContent?.trim() ?? "";
          date = span.textContent?.trim() ?? "";
          break;
        }
        cur = cur.nextElementSibling;
      }
    }

    let line = `**${itemTitle}** — ${price || "цена не указана"}`;
    line += `\n${itemUrl}`;
    if (location || date) {
      line += "\n" + [location, date].filter(Boolean).join(" | ");
    }

    items.push(line);
  }

  if (items.length === 0) {
    return { html: "Найдено 0 результатов", title: title || "Kufar — поиск" };
  }

  const resultText = (heading ? `${heading}\n\n` : "") + items.join("\n\n");
  return { html: resultText, title };
}
