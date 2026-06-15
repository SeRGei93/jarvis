import { JSDOM } from "jsdom";

export interface ShopProductResult {
  html: string;
  title: string;
}

/**
 * Паттерн страницы каталога Shop.by: /category/subcategory/ (список товаров)
 */
const SHOP_CATALOG_PATH = /^\/[^/]+\/[^/?#]+\/?/;

/**
 * Паттерн URL карточки товара Shop.by: последний сегмент — длинный slug с цифрами (модель)
 */
function looksLikeProductSlug(segment: string): boolean {
  return /\d/.test(segment) && segment.length > 15;
}

/**
 * URL-ы, которые не являются страницами каталога/товаров
 */
const EXCLUDED_PATHS = [
  /^\/$/,                    // главная
  /^\/informacya\//,         // информация
  /^\/news\//,                // новости
  /^\/shop_page\//,           // страницы магазинов
  /^\/get\.shop\.by/,        // get.shop.by редирект
];

function isExcludedPath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  return EXCLUDED_PATHS.some((re) => re.test(path));
}

function getLastPathSegment(pathname: string): string {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Определяет, является ли URL страницей каталога Shop.by (список товаров).
 * Например: /telefony_mobilnye/apple/
 */
export function isShopCatalogUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "shop.by") return false;
    if (isExcludedPath(u.pathname)) return false;
    if (!SHOP_CATALOG_PATH.test(u.pathname)) return false;
    const last = getLastPathSegment(u.pathname);
    return !looksLikeProductSlug(last);
  } catch {
    return false;
  }
}

/**
 * Определяет, является ли URL карточкой товара Shop.by.
 * Например: /telefony_mobilnye/apple_iphone_17_256gb_chernyy/
 */
export function isShopProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "shop.by") return false;
    if (isExcludedPath(u.pathname)) return false;
    if (!SHOP_CATALOG_PATH.test(u.pathname)) return false;
    const last = getLastPathSegment(u.pathname);
    return looksLikeProductSlug(last);
  } catch {
    return false;
  }
}

/** Удаляет script и application/json. application/ld+json оставляем — структурированные данные */
function stripScriptsAndJson(html: string): string {
  const dom = new JSDOM(`<div>${html}</div>`);
  const container = dom.window.document.body.firstElementChild!;
  container
    .querySelectorAll(
      "script:not([type='application/ld+json']), [type='application/json']"
    )
    .forEach((el) => el.remove());
  const result = container.innerHTML;
  dom.window.close();
  return result;
}

/**
 * Извлекает контент страницы каталога (список товаров) из блока .PageType__BlockRightWrapper.
 */
export function extractShopCatalogContent(html: string): ShopProductResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title = doc.querySelector("title")?.textContent?.trim() ?? "Shop.by";

  const content = doc.querySelector(".PageType__BlockRightWrapper");
  if (!content) {
    dom.window.close();
    return null;
  }

  const result = { html: stripScriptsAndJson(content.innerHTML), title };
  dom.window.close();
  return result;
}

/**
 * Извлекает контент карточки товара из блока .PageModel__shopContent.
 */
export function extractShopProductContent(html: string): ShopProductResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title = doc.querySelector("title")?.textContent?.trim() ?? "Shop.by";

  const content = doc.querySelector(".PageModel__shopContent");
  if (!content) {
    dom.window.close();
    return null;
  }

  const result = { html: stripScriptsAndJson(content.innerHTML), title };
  dom.window.close();
  return result;
}
