import { fetchPageAsMarkdown, type PageParser } from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";
import {
  isRelaxEstablishmentUrl,
  isRelaxAfishaUrl,
  isRelaxCatalogUrl,
  extractRelaxEstablishmentContent,
  extractRelaxAfishaContent,
  extractRelaxCatalogContent,
} from "./relax-page.js";

const log = webChild("relax");

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface WebDeps {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Page-parser registry (injected into fetchPageAsMarkdown)
// ---------------------------------------------------------------------------

export const relaxPageParsers: PageParser[] = [
  { match: isRelaxEstablishmentUrl, extract: extractRelaxEstablishmentContent },
  { match: isRelaxAfishaUrl, extract: extractRelaxAfishaContent },
  { match: isRelaxCatalogUrl, extract: extractRelaxCatalogContent },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelaxCategory {
  path: string;
  name: string;
  group: string;
}

export interface RelaxAfishaCategory {
  slug: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Place categories (~80 curated, grouped)
// ---------------------------------------------------------------------------

export const RELAX_CATEGORIES: RelaxCategory[] = [
  // Еда и развлечения
  { path: "ent/restorans", name: "Рестораны", group: "Еда и развлечения" },
  { path: "ent/cafe", name: "Кафе", group: "Еда и развлечения" },
  { path: "ent/bar", name: "Бары и пабы", group: "Еда и развлечения" },
  { path: "ent/clubs", name: "Ночные клубы", group: "Еда и развлечения" },
  { path: "ent/coffee", name: "Кофейни", group: "Еда и развлечения" },
  { path: "ent/sushi", name: "Суши-бары", group: "Еда и развлечения" },
  { path: "ent/pizzeria", name: "Пиццерии", group: "Еда и развлечения" },
  { path: "ent/dostavka", name: "Доставка еды", group: "Еда и развлечения" },
  { path: "ent/food-truck", name: "Фуд-траки", group: "Еда и развлечения" },
  { path: "ent/canteens", name: "Столовые", group: "Еда и развлечения" },
  { path: "ent/kalyan", name: "Кальянные", group: "Еда и развлечения" },
  { path: "ent/karaoke", name: "Караоке", group: "Еда и развлечения" },
  { path: "ent/billiards", name: "Бильярд", group: "Еда и развлечения" },
  { path: "ent/bowlings", name: "Боулинг", group: "Еда и развлечения" },
  { path: "ent/kino", name: "Кинотеатры", group: "Еда и развлечения" },
  { path: "ent/theatres", name: "Театры", group: "Еда и развлечения" },
  { path: "ent/casinos", name: "Казино", group: "Еда и развлечения" },
  { path: "ent/museums", name: "Музеи", group: "Еда и развлечения" },
  { path: "ent/circus", name: "Цирк", group: "Еда и развлечения" },
  { path: "ent/zoo", name: "Зоопарки", group: "Еда и развлечения" },
  { path: "ent/library", name: "Библиотеки", group: "Еда и развлечения" },
  { path: "ent/kinokomnaty", name: "Кинокомнаты", group: "Еда и развлечения" },
  { path: "ent/halls", name: "Банкетные залы", group: "Еда и развлечения" },
  { path: "ent/terrace", name: "Террасы", group: "Еда и развлечения" },

  // Бани и сауны
  { path: "ent/saunas", name: "Бани и сауны", group: "Бани и сауны" },

  // Туризм
  { path: "tourism/hotels", name: "Гостиницы", group: "Туризм" },
  { path: "tourism/cottages", name: "Коттеджи и усадьбы", group: "Туризм" },
  { path: "tourism/baza", name: "Базы отдыха", group: "Туризм" },
  { path: "tourism/kvartira", name: "Квартиры на сутки", group: "Туризм" },
  { path: "tourism/sights", name: "Достопримечательности", group: "Туризм" },
  { path: "tourism/turagentstva", name: "Турагентства", group: "Туризм" },
  { path: "tourism/visa", name: "Визовые центры", group: "Туризм" },
  { path: "tourism/posolstva", name: "Посольства", group: "Туризм" },
  { path: "tourism/guides", name: "Гиды и экскурсоводы", group: "Туризм" },

  // Здоровье и красота
  { path: "health/fitness", name: "Фитнес-клубы", group: "Здоровье и красота" },
  { path: "health/gyms", name: "Тренажёрные залы", group: "Здоровье и красота" },
  { path: "health/ioga", name: "Йога", group: "Здоровье и красота" },
  { path: "health/beauty", name: "Салоны красоты", group: "Здоровье и красота" },
  { path: "health/barbershop", name: "Барбершопы", group: "Здоровье и красота" },
  { path: "health/cosmetic", name: "Магазины косметики", group: "Здоровье и красота" },
  { path: "health/cosmetology", name: "Косметология", group: "Здоровье и красота" },
  { path: "health/manicure", name: "Маникюр", group: "Здоровье и красота" },
  { path: "health/pedikyur", name: "Педикюр", group: "Здоровье и красота" },
  { path: "health/massazh", name: "Массаж", group: "Здоровье и красота" },
  { path: "health/nail-bars", name: "Нейл-бары", group: "Здоровье и красота" },
  { path: "health/solariums", name: "Солярии", group: "Здоровье и красота" },
  { path: "health/spa-studio", name: "СПА-студии", group: "Здоровье и красота" },
  { path: "health/psychologist", name: "Психологи", group: "Здоровье и красота" },
  { path: "health/tattoo", name: "Тату-салоны", group: "Здоровье и красота" },

  // Активный отдых
  { path: "active/pools", name: "Бассейны", group: "Активный отдых" },
  { path: "active/dancing", name: "Танцы", group: "Активный отдых" },
  { path: "active/edinoborstva", name: "Единоборства", group: "Активный отдых" },
  { path: "active/mma", name: "ММА", group: "Активный отдых" },
  { path: "active/quest", name: "Квесты", group: "Активный отдых" },
  { path: "active/paintball", name: "Пейнтбол", group: "Активный отдых" },
  { path: "active/lazertag", name: "Лазертаг", group: "Активный отдых" },
  { path: "active/carting", name: "Картинг", group: "Активный отдых" },
  { path: "active/tennis-squash", name: "Теннис и сквош", group: "Активный отдых" },
  { path: "active/strelba", name: "Стрельба", group: "Активный отдых" },
  { path: "active/ski", name: "Лыжи и сноуборд", group: "Активный отдых" },
  { path: "active/skates", name: "Катки", group: "Активный отдых" },
  { path: "active/roller", name: "Ролики", group: "Активный отдых" },
  { path: "active/yacht", name: "Яхты и катера", group: "Активный отдых" },
  { path: "active/verhovaya-ezda", name: "Верховая езда", group: "Активный отдых" },
  { path: "active/prokat", name: "Прокат", group: "Активный отдых" },

  // Дети
  { path: "kids/entertainment", name: "Детские развлечения", group: "Дети" },
  { path: "kids/kindergartens", name: "Детские сады", group: "Дети" },
  { path: "kids/razvitie", name: "Развитие", group: "Дети" },
  { path: "kids/schools", name: "Школы", group: "Дети" },
  { path: "kids/workshop", name: "Мастер-классы", group: "Дети" },

  // Образование
  { path: "education/foreign-language", name: "Иностранные языки", group: "Образование" },
  { path: "education/it", name: "IT-курсы", group: "Образование" },
  { path: "education/driving", name: "Автошколы", group: "Образование" },
  { path: "education/culinary", name: "Кулинарные курсы", group: "Образование" },
  { path: "education/art", name: "Искусство", group: "Образование" },
  { path: "education/design", name: "Дизайн", group: "Образование" },
  { path: "education/professional-courses", name: "Профессиональные курсы", group: "Образование" },
  { path: "education/beautyschool", name: "Школы красоты", group: "Образование" },

  // Авто
  { path: "auto/autosalon", name: "Автосалоны", group: "Авто" },
  { path: "auto/service", name: "Автосервисы", group: "Авто" },
  { path: "auto/wash", name: "Автомойки", group: "Авто" },
  { path: "auto/auto-parts", name: "Автозапчасти", group: "Авто" },
  { path: "auto/refueling", name: "Заправки", group: "Авто" },

  // Магазины
  { path: "shops/wear", name: "Одежда", group: "Магазины" },
  { path: "shops/shoes", name: "Обувь", group: "Магазины" },
  { path: "shops/sport", name: "Спортивные товары", group: "Магазины" },
  { path: "shops/book-boardgames", name: "Книги и настольные игры", group: "Магазины" },
  { path: "shops/optics", name: "Оптика", group: "Магазины" },
  { path: "shops/pets", name: "Зоотовары", group: "Магазины" },
  { path: "shops/home", name: "Для дома", group: "Магазины" },
  { path: "shops/bags", name: "Сумки", group: "Магазины" },
  { path: "shops/fishing", name: "Рыбалка", group: "Магазины" },

  // Услуги
  { path: "services/appliance-repair", name: "Ремонт техники", group: "Услуги" },
  { path: "services/computer-repair", name: "Ремонт компьютеров", group: "Услуги" },
  { path: "services/phone-repair", name: "Ремонт телефонов", group: "Услуги" },
  { path: "services/atelier", name: "Ателье", group: "Услуги" },
  { path: "services/keys", name: "Ключи", group: "Услуги" },
  { path: "services/laundry", name: "Прачечные", group: "Услуги" },

  // Санатории
  { path: "sanatorii/sanatorii-tur", name: "Санатории (туры)", group: "Санатории" },
  { path: "sanatorii/sanatorii-dlya-lechenija", name: "Санатории (лечение)", group: "Санатории" },

  // Праздники
  { path: "holidays/wedding", name: "Свадьба", group: "Праздники" },
  { path: "holidays/flowers-shops", name: "Цветочные магазины", group: "Праздники" },
  { path: "holidays/present", name: "Подарки", group: "Праздники" },
  { path: "holidays/torts", name: "Торты на заказ", group: "Праздники" },
  { path: "holidays/kolca", name: "Обручальные кольца", group: "Праздники" },
  { path: "holidays/photovideo", name: "Фото и видео", group: "Праздники" },
  { path: "holidays/tamada", name: "Тамада и ведущие", group: "Праздники" },
  { path: "holidays/zal", name: "Залы для торжеств", group: "Праздники" },
  { path: "holidays/rent-car", name: "Аренда авто", group: "Праздники" },
  { path: "holidays/certificates-shops", name: "Сертификаты", group: "Праздники" },
];

// ---------------------------------------------------------------------------
// Afisha categories (all 18)
// ---------------------------------------------------------------------------

export const RELAX_AFISHA_CATEGORIES: RelaxAfishaCategory[] = [
  { slug: "kino", name: "Кино" },
  { slug: "theatre", name: "Театр" },
  { slug: "quest", name: "Квесты" },
  { slug: "conserts", name: "Концерты" },
  { slug: "event", name: "События" },
  { slug: "expo", name: "Выставки" },
  { slug: "kids", name: "Детям" },
  { slug: "clubs", name: "Клубы" },
  { slug: "stand-up", name: "Стенд-ап" },
  { slug: "ekskursii", name: "Экскурсии" },
  { slug: "education", name: "Образование" },
  { slug: "sport", name: "Спорт" },
  { slug: "hokkej", name: "Хоккей" },
  { slug: "free", name: "Бесплатно" },
  { slug: "circus", name: "Цирк" },
  { slug: "entertainment", name: "Развлечения" },
  { slug: "kviz", name: "Квиз" },
  { slug: "festivali", name: "Фестивали" },
];

// ---------------------------------------------------------------------------
// Getters (for resources)
// ---------------------------------------------------------------------------

export function getRelaxCategories(): RelaxCategory[] {
  return RELAX_CATEGORIES;
}

export function getRelaxAfishaCategories(): RelaxAfishaCategory[] {
  return RELAX_AFISHA_CATEGORIES;
}

// ---------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------

export const RELAX_CITIES: Record<string, string> = {
  minsk: "minsk",
  brest: "brest",
  gomel: "gomel",
  grodno: "grodno",
  vitebsk: "vitebsk",
  mogilev: "mogilev",
};

// ---------------------------------------------------------------------------
// Category path normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a category path to the canonical form `/cat/<group>/<slug>/`.
 * Accepts:
 *   "ent/restorans"
 *   "/cat/ent/restorans/"
 *   "https://www.relax.by/cat/ent/restorans/"
 *   "https://www.relax.by/cat/ent/restorans/minsk/"
 */
export function normalizeCategoryPath(input: string): string {
  let raw = input.trim();

  // Strip full URL prefix
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith("relax.by")) {
      raw = u.pathname;
    }
  } catch { /* not a URL, fine */ }

  // Strip leading /cat/ if present
  raw = raw.replace(/^\/cat\//, "");
  // Strip leading/trailing slashes
  raw = raw.replace(/^\/+|\/+$/g, "");

  // Strip trailing city slug if present (e.g. "ent/restorans/minsk" → "ent/restorans")
  const parts = raw.split("/");
  if (parts.length > 2) {
    const lastPart = parts[parts.length - 1];
    if (RELAX_CITIES[lastPart]) {
      parts.pop();
    }
  }

  raw = parts.join("/");

  return `/cat/${raw}/`;
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function buildPlaceUrl(categoryInput: string, params: { city?: string; page?: number }): string {
  const city = params.city?.toLowerCase().trim();
  if (city && !RELAX_CITIES[city]) {
    throw new Error(`Unknown city "${params.city}". Available: ${Object.keys(RELAX_CITIES).join(", ")}`);
  }

  const path = normalizeCategoryPath(categoryInput);

  // https://www.relax.by/cat/ent/restorans/minsk/?page=2
  let url = `https://www.relax.by${path}`;
  if (city) {
    url += `${city}/`;
  }
  if (params.page != null && params.page > 1) {
    url += `?page=${params.page}`;
  }
  return url;
}

function buildAfishaUrl(slug: string, params: { city?: string }): string {
  const city = params.city?.toLowerCase().trim();
  if (city && !RELAX_CITIES[city]) {
    throw new Error(`Unknown city "${params.city}". Available: ${Object.keys(RELAX_CITIES).join(", ")}`);
  }

  // https://afisha.relax.by/kino/minsk/
  let url = `https://afisha.relax.by/${slug}/`;
  if (city) {
    url += `${city}/`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Search functions
// ---------------------------------------------------------------------------

export async function relaxPlaceSearch(
  category: string,
  params: { city?: string; page?: number },
  deps: WebDeps = {},
): Promise<string> {
  const url = buildPlaceUrl(category, params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  log.debug({ url }, "relax: place fetch");
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: relaxPageParsers,
    });
    log.debug({ url, len: md.length, elapsedMs: Date.now() - started }, "relax: place done");
    return md;
  } catch (err) {
    log.warn(
      { url, err: (err as Error).message, elapsedMs: Date.now() - started },
      "relax: place failed",
    );
    throw err;
  }
}

export async function relaxAfishaSearch(
  slug: string,
  params: { city?: string },
  deps: WebDeps = {},
): Promise<string> {
  const url = buildAfishaUrl(slug, params);
  const timeoutMs = deps.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const started = Date.now();
  log.debug({ url }, "relax: afisha fetch");
  try {
    const md = await fetchPageAsMarkdown(url, timeoutMs, {
      fetchFn: deps.fetchFn,
      pageParsers: relaxPageParsers,
    });
    log.debug({ url, len: md.length, elapsedMs: Date.now() - started }, "relax: afisha done");
    return md;
  } catch (err) {
    log.warn(
      { url, err: (err as Error).message, elapsedMs: Date.now() - started },
      "relax: afisha failed",
    );
    throw err;
  }
}
