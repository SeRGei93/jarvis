import { JSDOM } from "jsdom";

export interface AvByResult {
  html: string;
  title: string;
}

/**
 * Возвращает true для страниц объявлений cars.av.by
 * Пример: https://cars.av.by/audi/a5/118355447
 */
export function isAvByListingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "cars.av.by" &&
      /^\/[^/]+\/[^/]+\/\d+\/?$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

// Служебные пути cars.av.by, не являющиеся каталогами брендов/моделей
const AV_BY_NON_CATALOG_PATHS = new Set([
  "filter", "search", "pages", "favorites", "subscription",
  "compare", "garage", "cabinet", "promo", "electric",
]);

/**
 * Возвращает true для страниц каталога бренда/модели cars.av.by.
 * Примеры: /audi, /audi/a5, /filter?brands[0][brand]=6
 * Не матчит: /search, /pages/promo, и т.д.
 */
export function isAvByCatalogUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "cars.av.by") return false;

    // /filter с параметрами — страница результатов поиска
    if (u.pathname === "/filter" || u.pathname === "/filter/") return true;

    // Только 1 или 2 сегмента пути, без цифровых ID
    const m = u.pathname.match(/^\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?\/?$/);
    if (!m) return false;

    const first = m[1];
    // Исключаем служебные пути
    if (AV_BY_NON_CATALOG_PATHS.has(first)) return false;

    return true;
  } catch {
    return false;
  }
}

/** Удаляет мусорные элементы из страницы объявления */
function removeListingJunk(root: Element): void {
  const selectors = [
    "script", "style", "noscript",
    // Медиа
    "img", "svg", "picture", "video",
    // Галерея фото
    ".gallery", "[class*='gallery']",
    // Кнопки
    "button", "[role='button']",
    // Реклама
    "ins", "[class*='adfox']", "[id*='adfox']",
    // Лизинг/финансовые виджеты
    ".card-finance", ".card__commercial",
    // VIN-проверка
    ".card-vin",
    // Закладки / контакты (кнопки)
    ".card__actions", ".card__contact",
    // Блок жалобы
    ".card__complain",
    // Статистика просмотров
    ".card__stat",
    // Метки ТОП/VIN/Видео (badges)
    ".card__labels", ".badge",
    // Похожие объявления / постrelated
    "[class*='postrelated']", "[class*='related']",
    // Промо-баннеры
    "[class*='break--']",
    // Приложения
    ".app-badge",
    // Блок "другие объявления продавца"
    "[class*='dealer']",
    // Хлебные крошки
    ".breadcrumb", "[class*='breadcrumb']",
    // Навигация
    "header", "footer", "nav", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    // Скрытые
    "[aria-hidden='true']", "[hidden]",
  ];

  selectors.forEach((sel) => {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // игнорируем невалидные селекторы
    }
  });
}

/** Удаляет мусорные элементы из страницы списка объявлений */
function removeCatalogJunk(root: Element): void {
  const selectors = [
    "script", "style", "noscript",
    // Медиа
    "img", "svg", "picture", "video",
    // Фото-карусель
    ".carousel", "[class*='carousel']",
    // Кнопки и закладки
    "button", "[role='button']",
    // Реклама
    "ins", "[class*='adfox']", "[id*='adfox']",
    // Лизинг
    ".listing-item__finance",
    // Дилерские метки
    ".listing-item__dealer",
    // Badges (ТОП)
    ".listing-item__badges", ".badge",
    // Боковая панель фильтров
    "[class*='filter']", "aside",
    // Навигация
    "header", "footer", "nav",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    // Промо новые авто
    ".salon-listing-top", "[class*='salon']",
    // Подписка
    "[class*='subscribe']",
    // Скрытые
    "[aria-hidden='true']", "[hidden]",
    // Блок сортировки
    ".listing__sort",
    // Журнал / статьи
    ".journal-item", "[class*='journal']",
    // Хлебные крошки
    ".breadcrumb", "[class*='breadcrumb']",
  ];

  selectors.forEach((sel) => {
    try {
      root.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      // игнорируем
    }
  });
}

/** Очищает атрибуты, оставляя только семантически значимые */
function cleanAttributes(root: Element): void {
  const KEEP_ATTRS = new Set(["href", "itemprop", "itemscope", "itemtype", "colspan", "rowspan"]);

  const walk = (el: Element) => {
    const toRemove: string[] = [];
    for (const attr of el.attributes) {
      if (!KEEP_ATTRS.has(attr.name)) toRemove.push(attr.name);
    }
    toRemove.forEach((a) => el.removeAttribute(a));
    for (const child of el.children) walk(child);
  };
  walk(root);
}

/** Удаляет HTML-комментарии */
function removeComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Извлекает контент страницы объявления cars.av.by.
 * Страница — React-приложение (Next.js).
 */
export function extractAvByListingContent(html: string): AvByResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // Основной контент объявления в .card
  const card = doc.querySelector(".card");
  if (!card) return null;

  const container = card.cloneNode(true) as Element;

  removeListingJunk(container);
  cleanAttributes(container);

  const cleanHtmlStr = removeComments(container.innerHTML)
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  if (!cleanHtmlStr) return null;

  return { html: cleanHtmlStr, title };
}

/**
 * Извлекает контент страницы списка объявлений cars.av.by.
 */
export function extractAvByCatalogContent(html: string): AvByResult | null {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const title = doc.querySelector("title")?.textContent?.trim() ?? "";

  // Список объявлений в .listing
  const listing = doc.querySelector(".listing");
  if (!listing) return null;

  const container = listing.cloneNode(true) as Element;

  removeCatalogJunk(container);
  cleanAttributes(container);

  const cleanHtmlStr = removeComments(container.innerHTML)
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();

  if (!cleanHtmlStr) return null;

  return { html: cleanHtmlStr, title };
}
