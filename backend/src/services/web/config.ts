/**
 * Static configuration and tool descriptions for the native web service.
 *
 * Ported from the external MCP server, adapted to jarvis conventions:
 *  - browser/nesty/rate-limit config removed;
 *  - SearXNG endpoint + engines come from the validated `env` (NOT process.env);
 *  - cache dirs are rooted under `env.WEB_CACHE_DIR`;
 *  - request timeouts/retries are plain fallback constants — the real request
 *    timeout is supplied by SettingsService at call time.
 */
import { join } from "node:path";

import { env } from "../../config/env.js";

export const DEFAULT_REGION = "ru-by";
export const DEFAULT_SEARCH_LANGUAGE = "all";

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

export const FETCH_LIMITS = {
  timeoutMs: 30000,
} as const;

/** SearXNG endpoint and engines come from the validated env. */
export const SEARCH_API_URL = env.SEARXNG_URL;
// Default engines: google + bing. (yandex's SearXNG parser is currently broken —
// it returns a parse error — so the old "google,yandex" effectively queried a
// single engine; bing answers reliably alongside google.) Override via SEARXNG_ENGINES.
export const SEARCH_ENGINES = env.SEARXNG_ENGINES ?? "google,bing";

/** Search request shape constants. The real per-request timeout comes from
 * SettingsService at call time; these are fallbacks/limits. */
export const SEARCH_CATEGORIES = "general";
export const SEARCH_API_TIMEOUT_MS = 12000;
export const SEARCH_API_RETRIES = 2;
export const SEARCH_API_BACKOFF_MS = 350;
export const MAX_BATCH_QUERIES = 8;

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

export const REGION_TO_LANGUAGE: Record<string, string> = {
  "wt-wt": "all",
  "ru-ru": "ru-RU",
  "ru-by": "ru-BY",
  "ua-uk": "uk-UA",
  "us-en": "en-US",
  "uk-en": "en-GB",
  "de-de": "de-DE",
  "fr-fr": "fr-FR",
};
