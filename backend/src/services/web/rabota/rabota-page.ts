import { JSDOM } from "jsdom";

export interface RabotaResult {
  html: string;
  title: string;
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Returns true for rabota.by vacancy search pages.
 * Example: https://rabota.by/search/vacancy?text=...
 */
export function isRabotaBySearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "rabota.by" &&
      u.pathname.startsWith("/search/vacancy")
    );
  } catch {
    return false;
  }
}

/**
 * Returns true for rabota.by individual vacancy pages.
 * Example: https://rabota.by/vacancy/130659108
 */
export function isRabotaByVacancyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "rabota.by" &&
      /^\/vacancy\/\d+\/?/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Junk selectors
// ---------------------------------------------------------------------------

const COMMON_JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "iframe",
  "button", "form", "input", "select", "textarea",
  "[aria-hidden='true']", "[hidden]",
];

const SEARCH_JUNK = [
  ...COMMON_JUNK,
  // Promo / branded employers
  '[data-qa*="branded-employers"]',
  // Autosearch subscribe form
  '[data-qa="autosearch-subscribe__form"]',
  // Banners
  '[data-qa*="banner"]',
  // Response buttons
  '[data-qa="vacancy-serp__vacancy_response"]',
  // Employer logos
  '[data-qa*="employer-logo"]',
  // Ads
  "[class*='advert']", "[class*='bloko-banner']",
  // Chat bot
  '[data-qa="chatik-float-button"]',
  // Login prompts
  '[data-qa="account-login-action"]',
  // Promo / premium
  '[data-qa*="premium"]',
  // Navigation / footer
  "header", "footer", "nav", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
];

const VACANCY_JUNK = [
  ...COMMON_JUNK,
  // Navigation / footer
  "header", "footer", "nav", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  // Sidebar
  '[data-qa="vacancy-sidebar"]',
  // Response button
  '[data-qa="vacancy-response-link-top"]',
  '[data-qa="vacancy-response-link-bottom"]',
  // Employer logos
  '[data-qa*="employer-logo"]',
  // Banners
  '[data-qa*="banner"]',
  // Similar vacancies
  '[data-qa="vacancy-section-related-vacancies"]',
  '[data-qa*="related"]',
  // Ads
  "[class*='advert']", "[class*='bloko-banner']",
  // Chat
  '[data-qa="chatik-float-button"]',
  // Breadcrumbs
  '[data-qa="breadcrumbs"]', "[class*='breadcrumb']",
  // Complain
  '[data-qa="vacancy-report-button"]',
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
  const KEEP = new Set(["href", "itemprop", "itemscope", "itemtype"]);
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

/** Remove empty leaf elements (empty divs, spans, etc.) iteratively */
function removeEmptyLeaves(root: Element): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of root.querySelectorAll("div, span, p, section, a")) {
      const text = el.textContent?.trim() ?? "";
      if (!text && el.querySelectorAll("a[href]").length === 0) {
        el.remove();
        changed = true;
      }
    }
  }
}

/** Remove empty <a> elements with no text (logo/icon links without content) */
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
  // Remove remaining empty tags after collapse
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result.replace(/<(div|span|p|section|a)><\/\1>/gi, "");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Content extraction: search results
// ---------------------------------------------------------------------------

export function extractRabotaBySearchContent(html: string): RabotaResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title =
    doc.querySelector('[data-qa="title"]')?.textContent?.trim() ??
    doc.querySelector("title")?.textContent?.trim() ??
    "";

  // Main results container
  const results = doc.querySelector('[data-qa="vacancy-serp__results"]');
  if (!results) {
    // Try alternative container
    const mainContent = doc.querySelector('[data-qa="vacancy-serp__results-search"]')
      ?? doc.querySelector(".vacancy-serp-content")
      ?? doc.querySelector("main");
    if (!mainContent) return null;

    const container = mainContent.cloneNode(true) as Element;
    removeJunk(container, SEARCH_JUNK);
    removeEmptyLinks(container);
    removeEmptyLeaves(container);
    cleanAttributes(container);
    const cleaned = collapse(container.innerHTML);
    if (!cleaned) return null;
    return { html: cleaned, title };
  }

  const container = results.cloneNode(true) as Element;
  removeJunk(container, SEARCH_JUNK);
  removeEmptyLinks(container);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}

// ---------------------------------------------------------------------------
// Content extraction: single vacancy
// ---------------------------------------------------------------------------

export function extractRabotaByVacancyContent(html: string): RabotaResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title =
    doc.querySelector('[data-qa="vacancy-title"]')?.textContent?.trim() ??
    doc.querySelector("title")?.textContent?.trim() ??
    "";

  // Try vacancy description block first, then fall back to main content area
  const content =
    doc.querySelector('[data-qa="vacancy-description"]')
    ?? doc.querySelector('[data-qa="vacancy-section"]')
    ?? doc.querySelector(".vacancy-section")
    ?? doc.querySelector("main");

  if (!content) return null;

  // If we got the narrow description block, also grab salary + employer info
  const body = doc.querySelector('[data-qa="vacancy-body"]')
    ?? content.closest('[data-qa="vacancy-body"]');

  const root = body ?? content;
  const container = root.cloneNode(true) as Element;

  removeJunk(container, VACANCY_JUNK);
  removeEmptyLinks(container);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}
