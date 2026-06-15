import {
  fetchPageAsMarkdown,
  fetchRawHtml,
  type PageParser,
} from "../fetch.js";
import { FETCH_LIMITS } from "../config.js";
import { webChild } from "../logger.js";
import {
  readFetchCache,
  writeFetchCache,
} from "../fetch-cache.js";
import {
  isKufarItemUrl,
  isKufarListingUrl,
  extractKufarItemContent,
  extractKufarListingContent,
} from "./kufar-page.js";

const log = webChild("kufar");

/** Injectable network deps; threaded into every exported fetching function. */
export interface WebDeps {
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Specialised page-parser registry for kufar.by, consumed by
 * {@link fetchPageAsMarkdown} via the `pageParsers` option. First match wins.
 */
export const kufarPageParsers: PageParser[] = [
  { match: isKufarItemUrl, extract: extractKufarItemContent },
  { match: isKufarListingUrl, extract: extractKufarListingContent },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KufarCategory {
  id: string;
  slug: string;
  name: string;
}

export interface KufarSearchParams {
  query?: string;
  category?: string;
  region?: string;
  price_min?: number;
  price_max?: number;
  condition?: string;
  private_only?: boolean;
  page?: number;
}

// ---------------------------------------------------------------------------
// Regions & areas (from __NEXT_DATA__.location.regions)
// Key = Russian name (lowercase), value = { name, rgn, ar? }
// rgn = region ID, ar = area (city/district) ID within region
// ---------------------------------------------------------------------------

export interface KufarRegion {
  name: string;
  rgn: string;
  ar?: string;
}

export const KUFAR_REGIONS: Record<string, KufarRegion> = {
  // Минск
  "минск": { name: "Минск", rgn: "7" },
  "центральный": { name: "Центральный", rgn: "7", ar: "22" },
  "советский": { name: "Советский", rgn: "7", ar: "23" },
  "первомайский": { name: "Первомайский", rgn: "7", ar: "24" },
  "партизанский": { name: "Партизанский", rgn: "7", ar: "25" },
  "заводской": { name: "Заводской", rgn: "7", ar: "26" },
  "ленинский": { name: "Ленинский", rgn: "7", ar: "27" },
  "октябрьский": { name: "Октябрьский", rgn: "7", ar: "28" },
  "московский": { name: "Московский", rgn: "7", ar: "29" },
  "фрунзенский": { name: "Фрунзенский", rgn: "7", ar: "30" },
  // Брестская область
  "брестская область": { name: "Брестская область", rgn: "1" },
  "брест": { name: "Брест", rgn: "1", ar: "1" },
  "брестский район": { name: "Брестский район", rgn: "1", ar: "150" },
  "барановичи": { name: "Барановичи", rgn: "1", ar: "37" },
  "береза": { name: "Береза", rgn: "1", ar: "38" },
  "белоозёрск": { name: "Белоозёрск", rgn: "1", ar: "123" },
  "высокое": { name: "Высокое", rgn: "1", ar: "148" },
  "ганцевичи": { name: "Ганцевичи", rgn: "1", ar: "48" },
  "городище": { name: "Городище", rgn: "1", ar: "159" },
  "давид-городок": { name: "Давид-Городок", rgn: "1", ar: "147" },
  "дрогичин": { name: "Дрогичин", rgn: "1", ar: "49" },
  "жабинка": { name: "Жабинка", rgn: "1", ar: "50" },
  "иваново": { name: "Иваново", rgn: "1", ar: "51" },
  "ивацевичи": { name: "Ивацевичи", rgn: "1", ar: "52" },
  "каменец": { name: "Каменец", rgn: "1", ar: "53" },
  "кобрин": { name: "Кобрин", rgn: "1", ar: "2" },
  "лунинец": { name: "Лунинец", rgn: "1", ar: "3" },
  "ляховичи": { name: "Ляховичи", rgn: "1", ar: "54" },
  "малорита": { name: "Малорита", rgn: "1", ar: "55" },
  "микашевичи": { name: "Микашевичи", rgn: "1", ar: "146" },
  "пинск": { name: "Пинск", rgn: "1", ar: "4" },
  "пружаны": { name: "Пружаны", rgn: "1", ar: "56" },
  "ружаны": { name: "Ружаны", rgn: "1", ar: "160" },
  "столин": { name: "Столин", rgn: "1", ar: "57" },
  "телеханы": { name: "Телеханы", rgn: "1", ar: "161" },
  // Гомельская область
  "гомельская область": { name: "Гомельская область", rgn: "2" },
  "гомель": { name: "Гомель", rgn: "2", ar: "5" },
  "гомельский район": { name: "Гомельский район", rgn: "2", ar: "152" },
  "большевик": { name: "Большевик", rgn: "2", ar: "162" },
  "брагин": { name: "Брагин", rgn: "2", ar: "128" },
  "буда-кошелево": { name: "Буда-Кошелево", rgn: "2", ar: "58" },
  "василевичи": { name: "Василевичи", rgn: "2", ar: "149" },
  "ветка": { name: "Ветка", rgn: "2", ar: "59" },
  "добруш": { name: "Добруш", rgn: "2", ar: "60" },
  "ельск": { name: "Ельск", rgn: "2", ar: "61" },
  "житковичи": { name: "Житковичи", rgn: "2", ar: "62" },
  "жлобин": { name: "Жлобин", rgn: "2", ar: "6" },
  "калинковичи": { name: "Калинковичи", rgn: "2", ar: "63" },
  "корма": { name: "Корма", rgn: "2", ar: "129" },
  "костюковка": { name: "Костюковка", rgn: "2", ar: "163" },
  "лельчицы": { name: "Лельчицы", rgn: "2", ar: "130" },
  "лоев": { name: "Лоев", rgn: "2", ar: "131" },
  "мозырь": { name: "Мозырь", rgn: "2", ar: "7" },
  "наровля": { name: "Наровля", rgn: "2", ar: "64" },
  "паричи": { name: "Паричи", rgn: "2", ar: "164" },
  "петриков": { name: "Петриков", rgn: "2", ar: "65" },
  "речица": { name: "Речица", rgn: "2", ar: "8" },
  "рогачев": { name: "Рогачев", rgn: "2", ar: "66" },
  "светлогорск": { name: "Светлогорск", rgn: "2", ar: "39" },
  "тереховка": { name: "Тереховка", rgn: "2", ar: "165" },
  "туров": { name: "Туров", rgn: "2", ar: "166" },
  "уваровичи": { name: "Уваровичи", rgn: "2", ar: "167" },
  "хойники": { name: "Хойники", rgn: "2", ar: "67" },
  "чечерск": { name: "Чечерск", rgn: "2", ar: "68" },
  // Гродненская область
  "гродненская область": { name: "Гродненская область", rgn: "3" },
  "гродно": { name: "Гродно", rgn: "3", ar: "9" },
  "гродненский район": { name: "Гродненский район", rgn: "3", ar: "153" },
  "большая берестовица": { name: "Большая Берестовица", rgn: "3", ar: "168" },
  "березовка": { name: "Березовка", rgn: "3", ar: "69" },
  "берестовица": { name: "Берестовица", rgn: "3", ar: "133" },
  "волковыск": { name: "Волковыск", rgn: "3", ar: "40" },
  "вороново": { name: "Вороново", rgn: "3", ar: "134" },
  "дятлово": { name: "Дятлово", rgn: "3", ar: "70" },
  "зельва": { name: "Зельва", rgn: "3", ar: "135" },
  "ивье": { name: "Ивье", rgn: "3", ar: "71" },
  "кореличи": { name: "Кореличи", rgn: "3", ar: "136" },
  "красносельский": { name: "Красносельский", rgn: "3", ar: "169" },
  "лида": { name: "Лида", rgn: "3", ar: "10" },
  "мосты": { name: "Мосты", rgn: "3", ar: "72" },
  "мир": { name: "Мир", rgn: "3", ar: "170" },
  "новогрудок": { name: "Новогрудок", rgn: "3", ar: "73" },
  "островец": { name: "Островец", rgn: "3", ar: "74" },
  "ошмяны": { name: "Ошмяны", rgn: "3", ar: "75" },
  "радунь": { name: "Радунь", rgn: "3", ar: "171" },
  "россь": { name: "Россь", rgn: "3", ar: "172" },
  "свислочь": { name: "Свислочь", rgn: "3", ar: "76" },
  "скидель": { name: "Скидель", rgn: "3", ar: "77" },
  "слоним": { name: "Слоним", rgn: "3", ar: "11" },
  "сморгонь": { name: "Сморгонь", rgn: "3", ar: "41" },
  "щучин": { name: "Щучин", rgn: "3", ar: "78" },
  // Могилёвская область
  "могилевская область": { name: "Могилёвская область", rgn: "4" },
  "могилев": { name: "Могилёв", rgn: "4", ar: "13" },
  "могилевский район": { name: "Могилёвский район", rgn: "4", ar: "154" },
  "белыничи": { name: "Белыничи", rgn: "4", ar: "137" },
  "бобруйск": { name: "Бобруйск", rgn: "4", ar: "12" },
  "быхов": { name: "Быхов", rgn: "4", ar: "79" },
  "глуск": { name: "Глуск", rgn: "4", ar: "80" },
  "горки": { name: "Горки", rgn: "4", ar: "42" },
  "дрибин": { name: "Дрибин", rgn: "4", ar: "138" },
  "елизово": { name: "Елизово", rgn: "4", ar: "173" },
  "кировск": { name: "Кировск", rgn: "4", ar: "81" },
  "климовичи": { name: "Климовичи", rgn: "4", ar: "82" },
  "кличев": { name: "Кличев", rgn: "4", ar: "83" },
  "краснополье": { name: "Краснополье", rgn: "4", ar: "139" },
  "круглое": { name: "Круглое", rgn: "4", ar: "140" },
  "костюковичи": { name: "Костюковичи", rgn: "4", ar: "84" },
  "кричев": { name: "Кричев", rgn: "4", ar: "43" },
  "мстиславль": { name: "Мстиславль", rgn: "4", ar: "85" },
  "осиповичи": { name: "Осиповичи", rgn: "4", ar: "14" },
  "славгород": { name: "Славгород", rgn: "4", ar: "86" },
  "чаусы": { name: "Чаусы", rgn: "4", ar: "87" },
  "чериков": { name: "Чериков", rgn: "4", ar: "88" },
  "шклов": { name: "Шклов", rgn: "4", ar: "89" },
  "хотимск": { name: "Хотимск", rgn: "4", ar: "141" },
  // Минская область
  "минская область": { name: "Минская область", rgn: "5" },
  "минский район": { name: "Минский район", rgn: "5", ar: "142" },
  "березино": { name: "Березино", rgn: "5", ar: "91" },
  "борисов": { name: "Борисов", rgn: "5", ar: "15" },
  "боровляны": { name: "Боровляны", rgn: "5", ar: "158" },
  "вилейка": { name: "Вилейка", rgn: "5", ar: "92" },
  "воложин": { name: "Воложин", rgn: "5", ar: "93" },
  "городея": { name: "Городея", rgn: "5", ar: "174" },
  "дзержинск": { name: "Дзержинск", rgn: "5", ar: "94" },
  "ждановичи": { name: "Ждановичи", rgn: "5", ar: "182" },
  "жодино": { name: "Жодино", rgn: "5", ar: "44" },
  "заславль": { name: "Заславль", rgn: "5", ar: "143" },
  "зеленый бор": { name: "Зеленый Бор", rgn: "5", ar: "175" },
  "ивенец": { name: "Ивенец", rgn: "5", ar: "176" },
  "клецк": { name: "Клецк", rgn: "5", ar: "95" },
  "копыль": { name: "Копыль", rgn: "5", ar: "96" },
  "крупки": { name: "Крупки", rgn: "5", ar: "97" },
  "логойск": { name: "Логойск", rgn: "5", ar: "98" },
  "любань": { name: "Любань", rgn: "5", ar: "99" },
  "марьина горка": { name: "Марьина Горка", rgn: "5", ar: "122" },
  "мачулищи": { name: "Мачулищи", rgn: "5", ar: "180" },
  "молодечно": { name: "Молодечно", rgn: "5", ar: "16" },
  "мядель": { name: "Мядель", rgn: "5", ar: "100" },
  "несвиж": { name: "Несвиж", rgn: "5", ar: "101" },
  "плещеницы": { name: "Плещеницы", rgn: "5", ar: "156" },
  "радошковичи": { name: "Радошковичи", rgn: "5", ar: "157" },
  "руденск": { name: "Руденск", rgn: "5", ar: "145" },
  "слуцк": { name: "Слуцк", rgn: "5", ar: "17" },
  "смолевичи": { name: "Смолевичи", rgn: "5", ar: "102" },
  "смиловичи": { name: "Смиловичи", rgn: "5", ar: "177" },
  "солигорск": { name: "Солигорск", rgn: "5", ar: "45" },
  "старобин": { name: "Старобин", rgn: "5", ar: "178" },
  "старые дороги": { name: "Старые Дороги", rgn: "5", ar: "103" },
  "столбцы": { name: "Столбцы", rgn: "5", ar: "104" },
  "узда": { name: "Узда", rgn: "5", ar: "105" },
  "фаниполь": { name: "Фаниполь", rgn: "5", ar: "144" },
  "червень": { name: "Червень", rgn: "5", ar: "106" },
  // Витебская область
  "витебская область": { name: "Витебская область", rgn: "6" },
  "витебск": { name: "Витебск", rgn: "6", ar: "18" },
  "витебский район": { name: "Витебский район", rgn: "6", ar: "151" },
  "бешенковичи": { name: "Бешенковичи", rgn: "6", ar: "125" },
  "барань": { name: "Барань", rgn: "6", ar: "107" },
  "браслав": { name: "Браслав", rgn: "6", ar: "108" },
  "браславский район": { name: "Браславский район", rgn: "6", ar: "155" },
  "верхнедвинск": { name: "Верхнедвинск", rgn: "6", ar: "109" },
  "ветрино": { name: "Ветрино", rgn: "6", ar: "179" },
  "глубокое": { name: "Глубокое", rgn: "6", ar: "110" },
  "городок": { name: "Городок", rgn: "6", ar: "111" },
  "докшицы": { name: "Докшицы", rgn: "6", ar: "112" },
  "дубровно": { name: "Дубровно", rgn: "6", ar: "113" },
  "коханово": { name: "Коханово", rgn: "6", ar: "181" },
  "лепель": { name: "Лепель", rgn: "6", ar: "114" },
  "лиозно": { name: "Лиозно", rgn: "6", ar: "115" },
  "миоры": { name: "Миоры", rgn: "6", ar: "116" },
  "новолукомль": { name: "Новолукомль", rgn: "6", ar: "117" },
  "новополоцк": { name: "Новополоцк", rgn: "6", ar: "46" },
  "орша": { name: "Орша", rgn: "6", ar: "19" },
  "полоцк": { name: "Полоцк", rgn: "6", ar: "20" },
  "поставы": { name: "Поставы", rgn: "6", ar: "47" },
  "россоны": { name: "Россоны", rgn: "6", ar: "118" },
  "сенно": { name: "Сенно", rgn: "6", ar: "119" },
  "толочин": { name: "Толочин", rgn: "6", ar: "120" },
  "ушачи": { name: "Ушачи", rgn: "6", ar: "126" },
  "чашники": { name: "Чашники", rgn: "6", ar: "121" },
  "шарковщина": { name: "Шарковщина", rgn: "6", ar: "127" },
  "шумилино": { name: "Шумилино", rgn: "6", ar: "124" },
};

// ---------------------------------------------------------------------------
// Parsing categories from __NEXT_DATA__
// ---------------------------------------------------------------------------

interface NextDataCategory {
  id: string;
  parent: string | null;
  labels: { ru?: string; by?: string };
  href?: string | { query?: Record<string, string>; pathname?: string };
  as?: string;
  url?: string;
}

function extractNextData(html: string): Record<string, unknown> | null {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractSlugFromUrl(url: string): string {
  // https://www.kufar.by/l/elektronika -> elektronika
  const m = url.match(/kufar\.by\/l\/(?:r~[^/]+\/)?([a-z0-9-]+)/);
  return m ? m[1] : "";
}

function getMegaMenu(nextData: Record<string, unknown>): {
  categories: NextDataCategory[];
  subCategories: NextDataCategory[];
} {
  const props = nextData.props as Record<string, unknown> | undefined;
  const initialState = props?.initialState as Record<string, unknown> | undefined;
  const menus = initialState?.menus as Record<string, unknown> | undefined;
  const megaMenu = menus?.megaMenu as Record<string, unknown> | undefined;
  return {
    categories: (megaMenu?.categories as NextDataCategory[]) ?? [],
    subCategories: (megaMenu?.subCategories as NextDataCategory[]) ?? [],
  };
}

/** Parse top-level categories from the main /l page HTML */
export function parseKufarCategories(html: string): KufarCategory[] {
  const nextData = extractNextData(html);
  if (!nextData) return [];

  const { categories } = getMegaMenu(nextData);
  const result: KufarCategory[] = [];

  for (const cat of categories) {
    if (cat.parent !== null) continue;

    const name = cat.labels?.ru ?? "";
    if (!name) continue;

    // Get slug from url or as field
    const rawUrl = (cat.url ?? cat.as ?? "") as string;
    if (!rawUrl || !rawUrl.includes("kufar.by/l/")) continue;

    const slug = extractSlugFromUrl(rawUrl);
    if (!slug) continue;

    result.push({ id: String(cat.id), slug, name });
  }

  return result;
}

/** Parse subcategories from a category page HTML (megaMenu.subCategories) */
export function parseKufarSubcategories(html: string): KufarCategory[] {
  const nextData = extractNextData(html);
  if (!nextData) return [];

  const { subCategories } = getMegaMenu(nextData);
  const result: KufarCategory[] = [];

  // Also collect from menuTree.links which has first-level subs
  const props = nextData.props as Record<string, unknown> | undefined;
  const initialState = props?.initialState as Record<string, unknown> | undefined;
  const menus = initialState?.menus as Record<string, unknown> | undefined;
  const menuTree = menus?.menuTree as Record<string, unknown> | undefined;
  const menuLinks = (menuTree?.links as NextDataCategory[]) ?? [];

  // Use menuTree links — these are the direct subcategories shown in sidebar
  const seen = new Set<string>();
  for (const link of menuLinks) {
    if (!link.parent || link.id === "all-categories") continue;

    const name = link.labels?.ru ?? "";
    if (!name) continue;

    const rawUrl = (link.url ?? link.as ?? "") as string;
    if (!rawUrl || !rawUrl.includes("kufar.by/l/")) continue;

    const slug = extractSlugFromUrl(rawUrl);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    result.push({ id: String(link.id), slug, name });
  }

  // If menuTree was empty, fall back to megaMenu subcategories (first-level only)
  if (result.length === 0) {
    for (const sub of subCategories) {
      const name = sub.labels?.ru ?? "";
      if (!name) continue;

      const rawUrl = (sub.url ?? sub.as ?? "") as string;
      if (!rawUrl || !rawUrl.includes("kufar.by/l/")) continue;

      const slug = extractSlugFromUrl(rawUrl);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      result.push({ id: String(sub.id), slug, name });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Category cache (uses fetch-cache, TTL 10 min — same as other fetches)
// ---------------------------------------------------------------------------

const CATEGORIES_CACHE_KEY = "kufar://categories";

export async function fetchKufarCategories(deps: WebDeps = {}): Promise<KufarCategory[]> {
  const cached = await readFetchCache(CATEGORIES_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as KufarCategory[];
    } catch { /* ignore */ }
  }

  const started = Date.now();
  const url = "https://www.kufar.by/l";
  const html = await fetchRawHtml(url, deps.timeoutMs ?? FETCH_LIMITS.timeoutMs, {
    fetchFn: deps.fetchFn,
  });
  const cats = parseKufarCategories(html);
  log.debug({ url, count: cats.length, elapsedMs: Date.now() - started }, "kufar: categories");
  if (cats.length > 0) {
    await writeFetchCache(CATEGORIES_CACHE_KEY, JSON.stringify(cats));
  }
  return cats;
}

export async function fetchKufarSubcategories(
  categorySlug: string,
  deps: WebDeps = {},
): Promise<KufarCategory[]> {
  const cacheKey = `kufar://subcategories/${categorySlug}`;
  const cached = await readFetchCache(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as KufarCategory[];
    } catch { /* ignore */ }
  }

  const started = Date.now();
  const url = `https://www.kufar.by/l/${encodeURIComponent(categorySlug)}`;
  const html = await fetchRawHtml(url, deps.timeoutMs ?? FETCH_LIMITS.timeoutMs, {
    fetchFn: deps.fetchFn,
  });
  const subs = parseKufarSubcategories(html);
  log.debug(
    { url, categorySlug, count: subs.length, elapsedMs: Date.now() - started },
    "kufar: subcategories",
  );
  if (subs.length > 0) {
    await writeFetchCache(cacheKey, JSON.stringify(subs));
  }
  return subs;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Region helpers for resources
// ---------------------------------------------------------------------------

/** Top-level regions (no ar field) — oblasts + Minsk city */
export function getKufarTopRegions(): { key: string; name: string; rgn: string }[] {
  return Object.entries(KUFAR_REGIONS)
    .filter(([, r]) => !r.ar)
    .map(([key, r]) => ({ key, name: r.name, rgn: r.rgn }));
}

/** Areas (cities/districts) within a given region ID */
export function getKufarAreas(rgn: string): { key: string; name: string; rgn: string; ar: string }[] {
  return Object.entries(KUFAR_REGIONS)
    .filter(([, r]) => r.rgn === rgn && r.ar != null)
    .map(([key, r]) => ({ key, name: r.name, rgn: r.rgn, ar: r.ar! }));
}

/**
 * Build Kufar search URL from parameters.
 *
 * URL: https://www.kufar.by/l[/{category}][/bez-posrednikov]?rgn=...&ar=...&query=...&sort=...&cnd=...&prc=r:{min},{max}
 *
 * Region uses rgn/ar numeric IDs (from KUFAR_REGIONS lookup by Russian name).
 * Category accepts any slug (top-level or subcategory) — no strict validation.
 */
export function buildKufarUrl(params: KufarSearchParams): string {
  const pathParts: string[] = ["/l"];

  if (params.category) {
    pathParts.push(params.category.toLowerCase().trim());
  }

  if (params.private_only) {
    pathParts.push("bez-posrednikov");
  }

  const path = pathParts.join("/");

  // Query params
  const qp = new URLSearchParams();

  // Region: lookup by Russian name (lowercase), set rgn and optionally ar
  if (params.region) {
    const regionKey = params.region.toLowerCase().trim();
    const regionEntry = KUFAR_REGIONS[regionKey];
    if (!regionEntry) {
      throw new Error(`Unknown region "${params.region}". Use Russian name from kufar://regions resource.`);
    }
    qp.set("rgn", regionEntry.rgn);
    if (regionEntry.ar) {
      qp.set("ar", regionEntry.ar);
    }
  }

  if (params.query) {
    qp.set("query", params.query);
  }

  if (params.condition) {
    const cond = params.condition.toLowerCase().trim();
    if (cond === "new") {
      qp.set("cnd", "1");
    } else if (cond === "used") {
      qp.set("cnd", "2");
    } else {
      throw new Error(`Unknown condition "${params.condition}". Available: new, used`);
    }
  }

  if (params.price_min != null || params.price_max != null) {
    // Kufar prices are in kopecks (BYN × 100)
    const min = params.price_min != null ? String(params.price_min * 100) : "";
    const max = params.price_max != null ? String(params.price_max * 100) : "";
    qp.set("prc", `r:${min},${max}`);
  }

  if (params.page != null && params.page > 1) {
    qp.set("page", String(params.page));
  }

  qp.set("size", "30");

  const qs = qp.toString();
  return `https://www.kufar.by${path}${qs ? `?${qs}` : ""}`;
}

export async function kufarSearch(
  params: KufarSearchParams,
  deps: WebDeps = {},
): Promise<string> {
  const url = buildKufarUrl(params);
  const started = Date.now();
  log.debug({ url }, "kufar: search");

  const md = await fetchPageAsMarkdown(url, deps.timeoutMs ?? FETCH_LIMITS.timeoutMs, {
    fetchFn: deps.fetchFn,
    pageParsers: kufarPageParsers,
  });
  log.debug({ url, len: md.length, elapsedMs: Date.now() - started }, "kufar: search done");
  return md;
}
