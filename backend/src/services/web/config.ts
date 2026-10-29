/**
 * Static configuration and tool descriptions for the native web service.
 *
 * Ported from the external MCP server, adapted to jarvis conventions:
 *  - browser/nesty/rate-limit config removed;
 *  - web search is Serper (Google SERP) — the key lives in `.env`, endpoints here;
 *  - cache dirs are rooted under `env.WEB_CACHE_DIR`;
 *  - request timeouts/retries are plain fallback constants — the real request
 *    timeout is supplied by SettingsService at call time.
 */
import { join } from "node:path";

import { env } from "../../config/env.js";

export const DEFAULT_REGION = "ru-by";

/** Search-result bounds and defaults (shared by search tools). */
export const CONFIG = {
  search: {
    maxQueryLength: 400,
    maxResults: 20,
    defaultResults: 10,
    defaultSafeSearch: "moderate" as const,
  },
} as const;

/** Per-category cache TTLs in milliseconds (lazy-expired on read). */
export const CACHE_TTL = {
  fetch: 10 * 60 * 1000, // 10 минут
  news: 30 * 60 * 1000, // 30 минут
  weather: 60 * 60 * 1000, // 1 час
  posts: 10 * 60 * 1000, // 10 минут
  actualized: 60 * 60 * 1000, // 1 час
  filters: 30 * 24 * 60 * 60 * 1000, // 30 дней
} as const;

/** Cache directories, all rooted under `env.WEB_CACHE_DIR`. */
export const CACHE_DIR = {
  fetch: join(env.WEB_CACHE_DIR, "fetch"),
  news: join(env.WEB_CACHE_DIR, "news"),
  weather: join(env.WEB_CACHE_DIR, "weather"),
  avby: join(env.WEB_CACHE_DIR, "avby"),
  filters: join(env.WEB_CACHE_DIR, "filters"),
} as const;

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Performs a web search. " +
  "Use for general queries, recent events, and broad information gathering. " +
  `Maximum ${CONFIG.search.maxResults} results per request.`;

export const WEB_SEARCH_BATCH_TOOL_DESCRIPTION =
  "Runs multiple search queries in parallel and returns grouped results.";

export const FETCH_PAGE_TOOL_DESCRIPTION =
  "Fetches a web page by URL, extracts the main content, removes visual noise, and returns markdown.";

export const SEARCH_NEWS_TOOL_DESCRIPTION =
  "Fetches news feed from supported sites. Without site returns news from all sources (onliner.by, tochka.by, smartpress.by, gismeteo.by, wikidom.by). Use site='onliner.by' for Onliner, site='tochka.by' for Tochka, site='smartpress.by' for Smartpress, site='gismeteo.by' for Gismeteo weather news, site='wikidom.by' for Wikidom real estate news. Multiple sites: site='onliner.by;smartpress.by'. Returns markdown with title, url, date, views, description.";

export const AVBY_SEARCH_TOOL_DESCRIPTION =
  "Search car listings on cars.av.by marketplace. " +
  "Takes brand slug (from the lookup tools), optional model name, year range, price range in USD, sorting and page. " +
  "Resolves all IDs internally and returns listing results.";

export const KUFAR_SEARCH_TOOL_DESCRIPTION =
  "Search listings on kufar.by marketplace (Belarus). " +
  "Takes optional query, category or subcategory slug (from the lookup tools), " +
  "region/city in Russian (from the lookup tools), price range in BYN, condition (new/used), private_only flag and page. " +
  "Returns listing results sorted by newest first.";

export const RABOTA_SEARCH_TOOL_DESCRIPTION =
  "Search job vacancies on rabota.by (Belarus). " +
  "Takes search text query (required), optional city (minsk, brest, vitebsk, gomel, grodno, mogilev), " +
  "experience level, education, schedule, employment type, minimum salary in BYR, " +
  "salary filter flag, sorting and page. Returns vacancy listings.";

export const TRANSPORT_SEARCH_TOOL_DESCRIPTION =
  "Search public transport schedules on zippybus.com (Belarus). " +
  "Takes city slug (required), optional transport type (bus, trolleybus, tram, routetaxi), " +
  "and optional route number. Without transport/route shows all available routes for the city. " +
  "With transport and route shows stops list with schedule.";

export const SEARCH_NEWS_DEFAULT_SITES = [
  "onliner.by",
  "tochka.by",
  "smartpress.by",
  "gismeteo.by",
  "wikidom.by",
] as const;

export const SEARCH_NEWS_MAX_TOTAL = 50;
export const SEARCH_NEWS_MIN_ONLINER = 15;
/** Keep at least this many items from every other source when available. */
export const SEARCH_NEWS_MIN_PER_SOURCE = 3;

export const FETCH_LIMITS = {
  timeoutMs: 30000,
} as const;

/** Serper (Google SERP) endpoint. The key comes from `env.SERPER_API_KEY`. */
export const SERPER_SEARCH_URL = "https://google.serper.dev/search";
/** Serper Google News endpoint (query → `news` array with date/source). */
export const SERPER_NEWS_URL = "https://google.serper.dev/news";

/** Search request shape constants. The real per-request timeout comes from
 * SettingsService at call time; these are fallbacks/limits. */
export const SEARCH_API_TIMEOUT_MS = 12000;
export const SEARCH_API_RETRIES = 2;
export const SEARCH_API_BACKOFF_MS = 350;
export const MAX_BATCH_QUERIES = 8;
/** Google returns ~10 organic results per page; extra pages cost another credit. */
export const SERPER_MAX_RESULTS = 10;
/** Google News accepts a larger `num`; keep a sane cap for one request. */
export const SERPER_NEWS_MAX_RESULTS = 20;

export const REGION_ALIASES: Record<string, string> = {
  // "global"/"world"/"all"/"wt" → worldwide (wt-wt). These previously mapped to
  // DEFAULT_REGION (ru-by), so asking for "world" news silently returned
  // Belarus-only results. The bare default (no region passed) stays DEFAULT_REGION.
  global: "wt-wt",
  world: "wt-wt",
  all: "wt-wt",
  wt: "wt-wt",
  ru: "ru-ru",
  russia: "ru-ru",
  by: "ru-by",
  belarus: "ru-by",
  belarusian: "ru-by",
  ua: "ua-uk",
  ukraine: "ua-uk",
  us: "us-en",
  usa: "us-en",
  en: "us-en",
  uk: "uk-en",
  gb: "uk-en",
  germany: "de-de",
  de: "de-de",
  france: "fr-fr",
  fr: "fr-fr",
};

/**
 * Google `gl`/`hl` per canonical region.
 *
 * Canonical regions are `ll-cc`-ish but not consistently ordered (`ru-by` is
 * language `ru` / country `by`; `us-en` is country `us` / language `en`), so the
 * mapping is explicit for every alias target and falls back to the same order
 * for regions the caller typed directly ("it-it").
 * Worldwide (`wt-wt`) sends neither parameter — Serper then uses the IP.
 */
export function googleLocale(resolvedRegion: string): { gl?: string; hl?: string } {
  if (resolvedRegion === "wt-wt") return {};
  const explicit: Record<string, { gl: string; hl: string }> = {
    "ru-ru": { gl: "ru", hl: "ru" },
    "ru-by": { gl: "by", hl: "ru" },
    "ua-uk": { gl: "ua", hl: "uk" },
    "us-en": { gl: "us", hl: "en" },
    "uk-en": { gl: "gb", hl: "en" },
    "de-de": { gl: "de", hl: "de" },
    "fr-fr": { gl: "fr", hl: "fr" },
  };
  const hit = explicit[resolvedRegion];
  if (hit) return hit;
  const [first, second] = resolvedRegion.split("-");
  if (!first || !second) return {};
  return { gl: second, hl: first };
}
