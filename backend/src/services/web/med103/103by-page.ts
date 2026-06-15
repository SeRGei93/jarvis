import { JSDOM } from "jsdom";

export interface Med103Result {
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
// Common junk selectors for 103.by
// ---------------------------------------------------------------------------

const COMMON_JUNK = [
  "script", "style", "noscript",
  "img", "svg", "picture", "video", "canvas",
  "button", "[role='button']",
  "iframe", "embed", "object",
  "header", "footer", "nav", "aside",
  "[aria-hidden='true']", "[hidden]",
];

// ---------------------------------------------------------------------------
// 1) Doctor listing parser — www.103.by/doctor/...
// ---------------------------------------------------------------------------

export function isMed103DoctorListUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.103.by" && /^\/doctor\//.test(u.pathname);
  } catch {
    return false;
  }
}

interface DoctorCard {
  name: string;
  url: string;
  specialties: string;
  rating: string;
  reviews: string;
  service: string;
  price: string;
  clinic: string;
  clinicUrl: string;
  address: string;
}

function parseDoctorCards(doc: Document): DoctorCard[] {
  const cards: DoctorCard[] = [];
  const wrappers = doc.querySelectorAll(".StaffPlaceList__itemWrapper--content");

  for (const wrapper of wrappers) {
    const nameEl = wrapper.querySelector(".PlaceContentStaff__name");
    const name = nameEl?.textContent?.trim() ?? "";
    const url = nameEl?.getAttribute("href") ?? "";
    if (!name) continue;

    const specialties = wrapper.querySelector(".PlaceContentStaff__specialities")?.textContent?.trim() ?? "";
    const rating = wrapper.querySelector(".rating__count")?.textContent?.trim() ?? "";
    const reviews = wrapper.querySelector(".reviews")?.textContent?.trim() ?? "";
    const service = wrapper.querySelector(".PlaceContentStaff__speciality")?.textContent?.trim() ?? "";
    const price = wrapper.querySelector(".price")?.textContent?.trim() ?? "";
    const clinic = wrapper.querySelector(".Place__headerLink")?.textContent?.trim() ?? "";
    const clinicLink = wrapper.querySelector(".Place__headerLink");
    const clinicUrl = clinicLink?.getAttribute("href") ?? "";
    const address = wrapper.querySelector(".Place__addressText")?.textContent?.trim() ?? "";

    cards.push({ name, url, specialties, rating, reviews, service, price, clinic, clinicUrl, address });
  }
  return cards;
}

function formatDoctorCards(cards: DoctorCard[]): string {
  if (cards.length === 0) return "";
  const lines: string[] = [];
  for (const c of cards) {
    lines.push(`### ${c.name}`);
    if (c.specialties) lines.push(c.specialties);
    const meta: string[] = [];
    if (c.rating) meta.push(`Rating: ${c.rating}`);
    if (c.reviews) meta.push(c.reviews);
    if (meta.length) lines.push(meta.join(" | "));
    if (c.service || c.price) {
      lines.push(`${c.service}${c.price ? ": " + c.price : ""}`);
    }
    if (c.clinic) {
      lines.push(`Clinic: ${c.clinic}${c.address ? " — " + c.address : ""}`);
    }
    if (c.url) lines.push(c.url);
    if (c.clinicUrl) lines.push(c.clinicUrl);
    lines.push("");
  }
  return lines.join("\n");
}

export function extractMed103DoctorListContent(html: string): Med103Result | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const cards = parseDoctorCards(doc);
  if (cards.length === 0) return null;

  const text = formatDoctorCards(cards);
  return { html: text, title };
}

// ---------------------------------------------------------------------------
// 2) Doctor profile parser — www.103.by/spec/{id}-...
// ---------------------------------------------------------------------------

const DOCTOR_PROFILE_JUNK = [
  ...COMMON_JUNK,
  ".Header", ".Footer",
  ".CookiesNotification", ".CookiesNotificationBy",
  ".Breadcrumbs", ".breadcrumbs",
  "[class*='Banner']", "[class*='banner']",
  "[class*='advert']", "[class*='Advert']",
  ".SearchContainer", ".Search",
  ".UserBar",
  ".SocialNetworks", ".ShareButtons",
  ".ReviewForm", ".ImageUploader",
  ".SimilarDoctors", ".RelatedDoctors",
  ".Gallery", ".PhotoGallery",
  ".BookingWidget",
  ".FastLinks",
  ".SeoText", ".SeoBlock",
];

export function isMed103DoctorProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.103.by" && /^\/spec\/\d+-/.test(u.pathname);
  } catch {
    return false;
  }
}

export function extractMed103DoctorProfileContent(html: string): Med103Result | null {
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
      if (type === "Physician" || type === "MedicalBusiness" ||
          type === "LocalBusiness" || Array.isArray(parsed)) {
        jsonLdBlocks.push(content);
      }
    } catch { /* ignore malformed */ }
  });

  const body = doc.body;
  if (!body) return null;

  const container = body.cloneNode(true) as Element;

  removeAll(container, DOCTOR_PROFILE_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  let cleaned = collapse(container.innerHTML);

  if (jsonLdBlocks.length > 0) {
    cleaned += "\n\n" + jsonLdBlocks
      .map((b) => `<script type="application/ld+json">${b}</script>`)
      .join("\n");
  }

  if (!cleaned) return null;

  return { html: cleaned, title };
}

// ---------------------------------------------------------------------------
// 3) Catalog + Services parser — www.103.by/cat/... and /list/...
// ---------------------------------------------------------------------------

export function isMed103CatalogUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "www.103.by" && (/^\/cat\//.test(u.pathname) || /^\/list\//.test(u.pathname));
  } catch {
    return false;
  }
}

interface ClinicCard {
  type: string;
  name: string;
  url: string;
  rating: string;
  reviews: string;
  address: string;
  hours: string;
  description: string;
  services: { name: string; price: string }[];
}

function parseClinicCards(doc: Document): ClinicCard[] {
  const cards: ClinicCard[] = [];
  const wrappers = doc.querySelectorAll(".PlaceList__itemWrapper--content");

  for (const wrapper of wrappers) {
    const type = wrapper.querySelector(".Place__type")?.textContent?.trim() ?? "";
    const titleEl = wrapper.querySelector(".Place__headerLink");
    const name = titleEl?.textContent?.trim() ?? "";
    const url = titleEl?.getAttribute("href") ?? "";
    if (!name) continue;

    const rating = wrapper.querySelector(".rating__count")?.textContent?.trim() ?? "";
    const reviews = wrapper.querySelector(".reviews")?.textContent?.trim() ?? "";
    const address = wrapper.querySelector(".Place__addressText")?.textContent?.trim() ?? "";
    const description = wrapper.querySelector(".Place__description")?.textContent?.trim() ?? "";

    // Hours: look for "до XX:XX" text
    let hours = "";
    const allSpans = wrapper.querySelectorAll("span");
    for (const s of allSpans) {
      const t = s.textContent?.trim() ?? "";
      if (/^до \d+:\d+$/.test(t)) { hours = t; break; }
    }

    // Services with prices
    const services: { name: string; price: string }[] = [];
    const priceItems = wrapper.querySelectorAll(".PlacePrices__item");
    for (const item of priceItems) {
      const sName = item.querySelector(".PlacePrices__title")?.textContent?.trim() ?? "";
      const sPrice = item.querySelector(".PlacePrices__price")?.textContent?.trim() ?? "";
      if (sName && sName !== "Все цены") services.push({ name: sName, price: sPrice });
    }

    cards.push({ type, name, url, rating, reviews, address, hours, description, services });
  }
  return cards;
}

function formatClinicCards(cards: ClinicCard[]): string {
  if (cards.length === 0) return "";
  const lines: string[] = [];
  for (const c of cards) {
    lines.push(`### ${c.name}`);
    if (c.type) lines.push(c.type);
    const meta: string[] = [];
    if (c.rating) meta.push(`Rating: ${c.rating}`);
    if (c.reviews) meta.push(c.reviews);
    if (c.hours) meta.push(c.hours);
    if (meta.length) lines.push(meta.join(" | "));
    if (c.address) lines.push(c.address);
    if (c.description) lines.push(c.description);
    for (const s of c.services.slice(0, 5)) {
      lines.push(`- ${s.name}: ${s.price}`);
    }
    if (c.url) lines.push(c.url);
    lines.push("");
  }
  return lines.join("\n");
}

export function extractMed103CatalogContent(html: string): Med103Result | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  const cards = parseClinicCards(doc);
  if (cards.length === 0) return null;

  const text = formatClinicCards(cards);
  return { html: text, title };
}

// ---------------------------------------------------------------------------
// 4) Clinic subdomain parser — {name}.103.by
// ---------------------------------------------------------------------------

const EXCLUDED_SUBDOMAINS = new Set([
  "www", "apteka", "mag", "info", "about", "static2", "api", "m",
]);

const CLINIC_SUBDOMAIN_JUNK = [
  ...COMMON_JUNK,
  ".Header", ".Footer",
  ".CookiesNotification", ".CookiesNotificationBy",
  "[class*='Banner']", "[class*='banner']",
  "[class*='advert']", "[class*='Advert']",
  ".SearchContainer", ".Search",
  ".UserBar",
  ".SocialNetworks", ".ShareButtons",
  ".Gallery", ".PhotoGallery", ".SliderGallery",
  ".BookingBlock", ".BookingWidget",
  ".ReviewForm", ".ImageUploader",
  ".SimilarClinics", ".RelatedClinics",
  ".FastLinks",
  ".SeoText", ".SeoBlock",
  ".PartnerPlaces",
  ".PersonalRequisites",
  ".RouteMap__button",
  ".SendError",
];

export function isMed103ClinicSubdomainUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".103.by")) return false;
    const sub = u.hostname.replace(".103.by", "");
    if (!sub || sub.includes(".")) return false;
    return !EXCLUDED_SUBDOMAINS.has(sub);
  } catch {
    return false;
  }
}

export function extractMed103ClinicSubdomainContent(html: string): Med103Result | null {
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
      if (type === "LocalBusiness" || type === "MedicalBusiness" ||
          type === "Hospital" || Array.isArray(parsed)) {
        jsonLdBlocks.push(content);
      }
    } catch { /* ignore malformed */ }
  });

  const body = doc.body;
  if (!body) return null;

  const container = body.cloneNode(true) as Element;

  removeAll(container, CLINIC_SUBDOMAIN_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  let cleaned = collapse(container.innerHTML);

  if (jsonLdBlocks.length > 0) {
    cleaned += "\n\n" + jsonLdBlocks
      .map((b) => `<script type="application/ld+json">${b}</script>`)
      .join("\n");
  }

  if (!cleaned) return null;

  return { html: cleaned, title };
}

// ---------------------------------------------------------------------------
// 5) Apteka parser — apteka.103.by/...
// ---------------------------------------------------------------------------

export function isMed103AptekaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "apteka.103.by" && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export function extractMed103AptekaContent(html: string): Med103Result | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // apteka.103.by is a Next.js app with hashed CSS classes — extract __NEXT_DATA__
  const nextDataEl = doc.querySelector("#__NEXT_DATA__");
  if (nextDataEl) {
    const raw = nextDataEl.textContent?.trim();
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const pageProps = data?.props?.pageProps;
        if (pageProps) {
          const text = formatAptekaPageProps(pageProps);
          if (text) {
            return { html: text, title };
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // Fallback: clean the body
  const body = doc.body;
  if (!body) return null;

  const container = body.cloneNode(true) as Element;
  removeAll(container, COMMON_JUNK);
  removeEmptyLeaves(container);
  cleanAttributes(container);

  const cleaned = collapse(container.innerHTML);
  if (!cleaned) return null;

  return { html: cleaned, title };
}

// ---------------------------------------------------------------------------
// Apteka __NEXT_DATA__ formatter
// ---------------------------------------------------------------------------

function formatAptekaPageProps(props: Record<string, unknown>): string {
  const lines: string[] = [];

  // Drug info
  const drug = props.drug as Record<string, unknown> | undefined;
  if (drug) {
    if (drug.name) lines.push(`## ${drug.name}`);
    if (drug.internationalName) lines.push(`International name: ${drug.internationalName}`);
    if (drug.manufacturer) lines.push(`Manufacturer: ${drug.manufacturer}`);
    if (drug.country) lines.push(`Country: ${drug.country}`);
    if (drug.releaseForm) lines.push(`Form: ${drug.releaseForm}`);
    if (drug.dosage) lines.push(`Dosage: ${drug.dosage}`);
    if (drug.description) lines.push(`\n${drug.description}`);
    lines.push("");
  }

  // Offers / pharmacy prices
  const offers = props.offers as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(offers) && offers.length > 0) {
    lines.push("## Prices in pharmacies\n");
    for (const offer of offers.slice(0, 30)) {
      const pharmacy = offer.pharmacy as Record<string, unknown> | undefined;
      const name = pharmacy?.name ?? offer.pharmacyName ?? "Unknown";
      const address = pharmacy?.address ?? offer.address ?? "";
      const price = offer.price ?? offer.priceFormatted ?? "";
      lines.push(`- **${name}**${address ? ` (${address})` : ""}: ${price} BYN`);
    }
    lines.push("");
  }

  // Search results list
  const drugs = props.drugs as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(drugs) && drugs.length > 0) {
    lines.push("## Medicines\n");
    for (const d of drugs.slice(0, 30)) {
      const name = d.name ?? "";
      const form = d.releaseForm ?? "";
      const manufacturer = d.manufacturer ?? "";
      const minPrice = d.minPrice ?? d.priceMin ?? "";
      const url = d.slug ? `https://apteka.103.by/${d.slug}/` : "";
      lines.push(`- **${name}**${form ? ` (${form})` : ""}${manufacturer ? ` — ${manufacturer}` : ""}${minPrice ? ` from ${minPrice} BYN` : ""}${url ? ` ${url}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
