import { JSDOM } from "jsdom";

export interface RelaxResult {
  html: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeAll(root: Element, selectors: string[]): void {
  for (const sel of selectors) {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch { /* ignore */ }
  }
}

function cleanAttributes(root: Element): void {
  const KEEP = new Set(["href", "itemprop", "itemscope", "itemtype", "content", "datetime"]);
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

function removeEmptyLeaves(root: Element): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of root.querySelectorAll("div, span, p, section")) {
      if (!el.innerHTML.trim()) {
        el.remove();
        changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// a) Catalog parser — www.relax.by/cat/... or /list/...
// ---------------------------------------------------------------------------

const CATALOG_JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "canvas",
  "button", "[role='button']",
  "iframe", "embed", "object",
  "header", "footer", "nav", "aside",
  // Relax-specific junk
  ".CatalogSlider", ".CatalogSlider__control",
  ".Place__buttons", ".Place__buttonsList",
  ".AdvertMessage", ".Place__advertMessage",
  ".FilterSidebar", ".FilterToolbar", ".FilterToolbarWrapper",
  "[class*='Banner']", "[class*='banner']",
  ".Breadcrumbs", ".CatalogNav__breadcrumbs",
  ".ContentPagination", ".Pagination",
  ".PromoListWrapper", ".Promo",
  ".RelinkingBlocksWrapper", ".RelinkingBlock",
  ".SectionInfo",
  ".SearchContainer", ".Search",
  ".FastLinks__toggle",
  ".UserBar",
  ".AddCompanyButton",
  ".Overlay--animation",
  ".Header", ".Footer",
  ".CookiesNotificationBy",
  ".PlaceButton___favorite",
  ".Image--loading",
  "[aria-hidden='true']", "[hidden]",
];

export function isRelaxCatalogUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.relax.by" && (/^\/cat\//.test(u.pathname) || /^\/list\//.test(u.pathname));
  } catch {
    return false;
  }
}

function extractFastLinks(doc: Document): string {
  const container = doc.querySelector(".FastLinks--scrollContainer");
  if (!container) return "";

  const groups: string[] = [];
  for (const item of container.querySelectorAll(".FastLinks__item")) {
    const btn = item.querySelector("button .Button__text");
    const groupName = btn?.textContent?.trim();
    const links: string[] = [];
    for (const a of item.querySelectorAll("a.FastLinks__DropDownItem")) {
      const text = a.textContent?.trim();
      const href = a.getAttribute("href");
      if (text && href) {
        links.push(`<a href="${href}">${text}</a>`);
      }
    }
    if (links.length === 0) {
      // plain links (not dropdown)
      const a = item.querySelector("a.FastLinks__button");
      const text = a?.textContent?.trim();
      const href = a?.getAttribute("href");
      if (text && href) {
        links.push(`<a href="${href}">${text}</a>`);
      }
    }
    if (links.length > 0) {
      const label = groupName ? `<b>${groupName}:</b> ` : "";
      groups.push(`<p>${label}${links.join(", ")}</p>`);
    }
  }

  return groups.length > 0 ? groups.join("") : "";
}

export function extractRelaxCatalogContent(html: string): RelaxResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const placeList = doc.querySelector(".PlaceList");
  if (!placeList) return null;

  const container = placeList.cloneNode(true) as Element;

  removeAll(container, CATALOG_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  const fastLinks = extractFastLinks(doc);
  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: fastLinks + cleaned, title };
}

// ---------------------------------------------------------------------------
// b) Establishment parser — *.relax.by (subdomain)
// ---------------------------------------------------------------------------

const EXCLUDED_SUBDOMAINS = new Set([
  "www", "afisha", "mag", "info", "static", "static2",
  "skidki", "go", "ms1",
]);

const ESTABLISHMENT_JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "canvas",
  "button", "[role='button']",
  "iframe", "embed", "object",
  "header", "footer", "nav", "aside",
  // Relax-specific junk
  ".Header", ".Footer", ".PersonalPage__footer",
  ".FooterLine", ".FooterCopyright",
  ".CookiesNotificationBy",
  ".PaidGallery__wrapper", ".PersonalPhotoGallery",
  ".SliderGallery", ".Gallery", ".PhotoSwipeGallery",
  ".GalleryLinks", ".Gallery__control",
  ".BookingBlock",
  ".SocialNetworks", ".AdditionalContacts",
  ".PersonalHeaderButtons", ".PersonalHeaderButton",
  ".PartnerPlaces",
  ".PersonalRequisites",
  ".PersonalInfoBlocks",
  ".ReviewForm", ".ImageUploader",
  ".PersonalTabs",
  ".SearchContainer", ".Search",
  ".UserBar",
  ".PersonalTopToolbar", ".PersonalHeader__backButton",
  ".ContentBox__showMore",
  ".PersonalImages",
  ".RouteMap__button",
  ".SendError",
  ".Offers__control",
  "[class*='Banner']", "[class*='banner']",
  "[aria-hidden='true']", "[hidden]",
  ".Icon",
];

export function isRelaxEstablishmentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".relax.by")) return false;
    const sub = u.hostname.replace(".relax.by", "");
    if (!sub || sub.includes(".")) return false;
    return !EXCLUDED_SUBDOMAINS.has(sub);
  } catch {
    return false;
  }
}

export function extractRelaxEstablishmentContent(html: string): RelaxResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // Extract JSON-LD before removing scripts
  const jsonLdBlocks: string[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    const content = el.textContent?.trim();
    if (!content) return;
    try {
      const parsed = JSON.parse(content);
      const type = parsed["@type"];
      // Keep only useful structured data
      if (type === "LocalBusiness" || type === "FoodEstablishment" ||
          type === "Review" || Array.isArray(parsed)) {
        jsonLdBlocks.push(content);
      }
    } catch { /* ignore malformed */ }
  });

  const body = doc.body;
  if (!body) return null;

  const container = body.cloneNode(true) as Element;

  removeAll(container, ESTABLISHMENT_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  let cleaned = collapse(container.innerHTML);

  // Append JSON-LD at the end
  if (jsonLdBlocks.length > 0) {
    cleaned += "\n\n" + jsonLdBlocks
      .map((b) => `<script type="application/ld+json">${b}</script>`)
      .join("\n");
  }

  if (!cleaned) return null;

  return { html: cleaned, title };
}

// ---------------------------------------------------------------------------
// c) Afisha parser — afisha.relax.by/...
// ---------------------------------------------------------------------------

const AFISHA_JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "canvas",
  "button", "[role='button']",
  "iframe", "embed", "object",
  // Afisha-specific junk
  "header", ".b-header",
  "footer", ".b-footer",
  ".cookiesNotificationBy", ".CookiesNotificationBy",
  ".adFox", "[class*='adFox']", "[id^='adfox_']", ".adfox_wrapper",
  ".afishaSlider", ".b-afisha-layout_maldives_strap",
  ".b-cityes", ".afisha-menu",
  ".b-search", ".b-search__afisha", ".b-search-afisha",
  ".afisha-links",
  ".b-playbill_options", ".b-playbill_city",
  ".map-places", ".b-yandex-map", ".js-map-places",
  ".b-sideCol", ".js-sideCol",
  ".b-old-browser-modal",
  ".b-svgstore",
  ".b-spinner",
  ".b-suggest",
  ".b-afisha-full-content",
  ".b-font-loader",
  ".b-popup-map_preloader",
  ".stickyClose", ".bigBanner",
  "[aria-hidden='true']", "[hidden]",
  "nav", "aside",
];

export function isRelaxAfishaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Match afisha.relax.by with a path deeper than just /
    return u.hostname === "afisha.relax.by" && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function extractRelaxAfishaContent(html: string): RelaxResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const schedule = doc.querySelector(".schedule") ?? doc.querySelector("#schedule");
  if (!schedule) return null;

  const container = schedule.cloneNode(true) as Element;

  removeAll(container, AFISHA_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}
