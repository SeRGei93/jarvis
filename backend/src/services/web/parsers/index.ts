import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { fetchRawHtml } from "../fetch.js";
import { webChild } from "../logger.js";
import { SsrfError } from "../ssrf-guard.js";
import type { LookupFn } from "../ssrf-guard.js";
import type { ContentProvider } from "../content/types.js";
import type { NewsItem, NewsParser } from "./types.js";
import type { NewsArticle, NewsFeedSection } from "./types.js";
import {
  formatArticleToMarkdown,
  formatNewsToMarkdown,
  formatFeedSectionsToMarkdown,
  formatNewsWithSourceToMarkdown,
  newsSectionStatus,
  type NewsItemWithSource,
} from "./markdown.js";
import { onlinerParser } from "./onliner.js";
import { tochkaParser } from "./tochka.js";
import { smartpressParser } from "./smartpress.js";
import { gismeteoNewsParser } from "./gismeteo.js";
import { wikidomParser } from "./wikidom.js";
import {
  isOnlinerArticleUrl,
  parseOnlinerArticle,
} from "./onliner-article.js";
import { isTochkaArticleUrl, parseTochkaArticle } from "./tochka-article.js";
import { isSmartpressArticleUrl, parseSmartpressArticle } from "./smartpress-article.js";
import { isRealtArticleUrl, parseRealtArticle } from "./realt.js";
import {
  SEARCH_NEWS_MAX_TOTAL,
  SEARCH_NEWS_MIN_ONLINER,
  SEARCH_NEWS_MIN_PER_SOURCE,
  NEWS_PARSER_CACHE_VERSION,
  FETCH_LIMITS,
  CACHE_TTL,
  CACHE_DIR,
} from "../config.js";

const log = webChild("news");

const PARSER_REGISTRY = new Map<string, NewsParser>();

function registerParser(parser: NewsParser): void {
  for (const domain of parser.domains) {
    PARSER_REGISTRY.set(domain, parser);
  }
}

registerParser(onlinerParser);
registerParser(tochkaParser);
registerParser(smartpressParser);
registerParser(gismeteoNewsParser);
registerParser(wikidomParser);

const ONLINER_URLS = [
  "https://money.onliner.by/",
  "https://people.onliner.by/",
  "https://tech.onliner.by/",
] as const;

const TOCHKA_URLS = [
  "https://tochka.by/articles/sport/",
  "https://tochka.by/articles/drive/",
  "https://tochka.by/articles/turizm/",
  "https://tochka.by/articles/economics/",
] as const;

const SMARTPRESS_URLS = [
  "https://smartpress.by/news/",
] as const;

const GISMETEO_URLS = [
  "https://www.gismeteo.by/news/",
] as const;

const WIKIDOM_URLS = [
  "https://wikidom.by/blog/",
] as const;

/**
 * Stable cache id per requested feed.
 *
 * Named feeds keep a readable id; arbitrary URLs are hashed from the FULL
 * normalised URL (not just the hostname) — two different pages on one host must
 * not share a cache entry. The parser version is part of every id.
 */
export function getCacheIdForSite(siteInput: string): string {
  const s = siteInput.trim().toLowerCase();
  const version = `v${NEWS_PARSER_CACHE_VERSION}`;
  if (s === "onliner.by") return `onliner_by_${version}`;
  if (s === "tochka.by" || s === "https://tochka.by") return `tochka_by_${version}`;
  if (s === "smartpress.by" || s === "https://smartpress.by") {
    return `smartpress_by_${version}`;
  }
  if (s === "gismeteo.by" || s === "www.gismeteo.by" || s === "https://www.gismeteo.by") {
    return `gismeteo_by_${version}`;
  }
  if (s === "wikidom.by" || s === "https://wikidom.by") {
    return `wikidom_by_${version}`;
  }
  let normalized = s;
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    url.hash = "";
    url.searchParams.sort();
    normalized = url.href;
  } catch {
    /* keep the raw input as the cache key */
  }
  const hash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `url_${version}_${hash}`;
}

function getCacheFilePath(cacheId: string): string {
  return join(CACHE_DIR.news, `${cacheId}.json`);
}

async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR.news)) {
    await mkdir(CACHE_DIR.news, { recursive: true });
  }
}

async function readCache(cacheId: string): Promise<NewsFeedSection[] | null> {
  const filePath = getCacheFilePath(cacheId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf-8");
    const { expiresAt, data } = JSON.parse(raw) as {
      expiresAt: number;
      data: NewsFeedSection[];
    };
    if (Date.now() < expiresAt) return data;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(
  cacheId: string,
  data: NewsFeedSection[]
): Promise<void> {
  await ensureCacheDir();
  const filePath = getCacheFilePath(cacheId);
  const payload = JSON.stringify({
    expiresAt: Date.now() + CACHE_TTL.news,
    data,
  });
  await writeFile(filePath, payload, "utf-8");
}

export type { NewsItem, NewsParser, NewsFeedSection, NewsArticle };
export {
  formatNewsToMarkdown,
  formatFeedSectionsToMarkdown,
  formatNewsWithSourceToMarkdown,
  formatArticleToMarkdown,
  type NewsItemWithSource,
};
export { isOnlinerArticleUrl, parseOnlinerArticle };
export { isTochkaArticleUrl, parseTochkaArticle } from "./tochka-article.js";
export { isSmartpressArticleUrl, parseSmartpressArticle } from "./smartpress-article.js";
export { isRealtArticleUrl, parseRealtArticle } from "./realt.js";

export async function fetchNewsArticle(
  url: string,
  timeoutMs: number = 30000
): Promise<NewsArticle | null> {
  const html = await fetchRawHtml(url, timeoutMs);
  if (isOnlinerArticleUrl(url)) return parseOnlinerArticle(html, url);
  if (isTochkaArticleUrl(url)) return parseTochkaArticle(html, url);
  if (isSmartpressArticleUrl(url)) return parseSmartpressArticle(html, url);
  if (isRealtArticleUrl(url)) return parseRealtArticle(html, url);
  return null;
}

/**
 * Нормализует значение site в массив URL для парсинга.
 * onliner.by → [money, people, tech].onliner.by
 * tochka.by → [sport, drive, turizm, economics].tochka.by/articles
 */
export function normalizeSites(site: string): string[] {
  const trimmed = site.trim().toLowerCase();
  if (trimmed === "onliner.by") {
    return [...ONLINER_URLS];
  }
  if (trimmed === "tochka.by" || trimmed === "https://tochka.by") {
    return [...TOCHKA_URLS];
  }
  if (trimmed === "smartpress.by" || trimmed === "https://smartpress.by") {
    return [...SMARTPRESS_URLS];
  }
  if (trimmed === "gismeteo.by" || trimmed === "www.gismeteo.by" || trimmed === "https://www.gismeteo.by") {
    return [...GISMETEO_URLS];
  }
  if (trimmed === "wikidom.by" || trimmed === "https://wikidom.by") {
    return [...WIKIDOM_URLS];
  }
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    return [url.href];
  } catch {
    return [];
  }
}

function getParserForUrl(url: string): NewsParser | null {
  try {
    const hostname = new URL(url).hostname;
    return PARSER_REGISTRY.get(hostname) ?? null;
  } catch {
    return null;
  }
}

/** Injectable deps for {@link searchNews} (tests run without network/cache). */
export interface NewsFetchOptions {
  fetchFn?: typeof globalThis.fetch;
  lookupFn?: LookupFn;
  /** Read/write the on-disk news cache; default `true`. */
  useCache?: boolean;
}

/**
 * Fetch a news/list page as HTML. Local HTTP first; if it is blocked or fails
 * and a content provider is configured, ask the provider for rendered HTML so
 * the same site parser can run on it.
 */
async function fetchNewsHtml(
  url: string,
  timeoutMs: number,
  contentProvider?: ContentProvider,
  opts: NewsFetchOptions = {},
): Promise<string> {
  try {
    return await fetchRawHtml(url, timeoutMs, {
      fetchFn: opts.fetchFn,
      lookupFn: opts.lookupFn,
    });
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    if (!contentProvider) throw err;
    const page = await contentProvider.fetchPage({ url, format: "html", timeoutMs });
    return page.content;
  }
}

function isOnlinerSite(siteInput: string): boolean {
  const s = siteInput.trim().toLowerCase();
  return s === "onliner.by";
}

function isTochkaSite(siteInput: string): boolean {
  const s = siteInput.trim().toLowerCase();
  return s === "tochka.by" || s === "https://tochka.by";
}

function isSmartpressSite(siteInput: string): boolean {
  const s = siteInput.trim().toLowerCase();
  return s === "smartpress.by" || s === "https://smartpress.by";
}

function isGismeteoSite(siteInput: string): boolean {
  const s = siteInput.trim().toLowerCase();
  return s === "gismeteo.by" || s === "www.gismeteo.by" || s === "https://www.gismeteo.by";
}

function isWikidomSite(siteInput: string): boolean {
  const s = siteInput.trim().toLowerCase();
  return s === "wikidom.by" || s === "https://wikidom.by";
}

const ONLINER_SOURCE = "onliner.by";

/**
 * Объединяет новости из секций в общий список:
 *  - дедуп по URL;
 *  - гарантирует minOnliner от onliner.by и minPerSource от каждого
 *    остального источника (иначе date-only ленты вроде Tochka/Wikidom
 *    проигрывают источникам с точным временем и исчезают из топ-50);
 *  - добивает остаток самыми свежими новостями и сортирует по времени.
 */
export function mergeAndLimitNews(
  sections: NewsFeedSection[],
  maxTotal: number = SEARCH_NEWS_MAX_TOTAL,
  minOnliner: number = SEARCH_NEWS_MIN_ONLINER,
  minPerSource: number = SEARCH_NEWS_MIN_PER_SOURCE,
): NewsItemWithSource[] {
  const groups = new Map<string, NewsItemWithSource[]>();
  for (const section of sections) {
    if (section.error || section.fallbackMarkdown) continue;
    const items = section.items.map((item) => ({ ...item, source: section.source }));
    items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const existing = groups.get(section.source);
    if (existing) existing.push(...items);
    else groups.set(section.source, items);
  }

  const result: NewsItemWithSource[] = [];
  const used = new Set<string>();
  const add = (item: NewsItemWithSource): void => {
    if (used.has(item.url)) return;
    used.add(item.url);
    result.push(item);
  };

  // Onliner first (its minimum is larger); then every other source gets a quota.
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === ONLINER_SOURCE ? -1 : b === ONLINER_SOURCE ? 1 : 0,
  );
  for (const [source, items] of ordered) {
    if (result.length >= maxTotal) break;
    const quota = source === ONLINER_SOURCE ? minOnliner : minPerSource;
    for (const item of items.slice(0, quota)) {
      if (result.length >= maxTotal) break;
      add(item);
    }
  }

  // Fill the remaining slots with the newest items across all sources.
  const remaining = [...groups.values()]
    .flat()
    .filter((item) => !used.has(item.url))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  for (const item of remaining) {
    if (result.length >= maxTotal) break;
    add(item);
  }

  result.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return result;
}

/**
 * Mark every section with its health and log degradations. A page that was
 * fetched but parsed to 0 items is an `empty` WARN, not a silent "no news".
 */
function finalizeSections(siteInput: string, sections: NewsFeedSection[]): void {
  for (const section of sections) {
    section.status = newsSectionStatus(section);
    if (section.status === "error") {
      log.warn(
        { site: siteInput, source: section.source, url: section.url, err: section.error },
        "news: source failed",
      );
    } else if (section.status === "empty") {
      log.warn(
        { site: siteInput, source: section.source, url: section.url },
        "news: parser returned 0 items",
      );
    }
  }

  if (
    sections.length > 0 &&
    sections.every((s) => s.status !== "ok" && s.status !== "fallback")
  ) {
    log.error(
      {
        site: siteInput,
        sources: sections.map((s) => ({ source: s.source, status: s.status, error: s.error })),
      },
      "news: all sources for site are empty",
    );
  }
}

/** Only fully healthy sections are cached; degraded ones are retried next call. */
function isCacheableSection(section: NewsFeedSection): boolean {
  const status = newsSectionStatus(section);
  return status === "ok" || status === "fallback";
}

export async function searchNews(
  sites: string[],
  timeoutMs: number = 30000,
  contentProvider?: ContentProvider,
  opts: NewsFetchOptions = {},
): Promise<NewsFeedSection[]> {
  const sections: NewsFeedSection[] = [];
  const useCache = opts.useCache !== false;

  for (const siteInput of sites) {
    const urls = normalizeSites(siteInput);
    if (urls.length === 0) continue;

    const cacheId = getCacheIdForSite(siteInput);
    if (useCache) {
      const cached = await readCache(cacheId);
      if (cached) {
        sections.push(...cached);
        continue;
      }
    }

    const siteSections: NewsFeedSection[] = [];

    if (isOnlinerSite(siteInput) && urls.length > 1) {
      const allItems: NewsItem[] = [];
      let lastError: string | undefined;

      for (const url of urls) {
        const parser = getParserForUrl(url);
        if (!parser) {
          lastError = "Парсер для этого сайта не найден";
          continue;
        }
        try {
          const html = await fetchNewsHtml(url, timeoutMs, contentProvider, opts);
          const items = parser.parse(html, url);
          allItems.push(...items);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      allItems.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

      siteSections.push({
        source: "onliner.by",
        url: "https://onliner.by/",
        items: allItems,
        error: allItems.length === 0 ? lastError : undefined,
      });
    } else if (isTochkaSite(siteInput) && urls.length > 1) {
      const allItems: NewsItem[] = [];
      let lastError: string | undefined;

      for (const url of urls) {
        const parser = getParserForUrl(url);
        if (!parser) {
          lastError = "Парсер для этого сайта не найден";
          continue;
        }
        try {
          const html = await fetchNewsHtml(url, timeoutMs, contentProvider, opts);
          const items = parser.parse(html, url);
          allItems.push(...items);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      const seen = new Set<string>();
      const uniqueItems = allItems.filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
      uniqueItems.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

      // Tochka serves a JS "Verification" challenge with HTTP 200, so the local
      // fetch succeeds but the parser sees no items. Ask the provider for the
      // rendered HTML and parse that instead.
      if (uniqueItems.length === 0 && contentProvider) {
        for (const url of urls) {
          const parser = getParserForUrl(url);
          if (!parser) continue;
          try {
            const page = await contentProvider.fetchPage({ url, format: "html", timeoutMs });
            allItems.push(...parser.parse(page.content, url));
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        uniqueItems.length = 0;
        const seenRendered = new Set<string>();
        for (const item of allItems) {
          if (seenRendered.has(item.url)) continue;
          seenRendered.add(item.url);
          uniqueItems.push(item);
        }
        uniqueItems.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      }

      siteSections.push({
        source: "tochka.by",
        url: "https://tochka.by/articles/",
        items: uniqueItems,
        error: uniqueItems.length === 0 ? lastError : undefined,
      });
    } else if (isSmartpressSite(siteInput) && urls.length > 0) {
      const parser = getParserForUrl(urls[0]);
      if (parser) {
        try {
          const html = await fetchNewsHtml(urls[0], timeoutMs, contentProvider, opts);
          const items = parser.parse(html, urls[0]);
          items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          siteSections.push({
            source: "smartpress.by",
            url: "https://smartpress.by/news/",
            items,
          });
        } catch (error) {
          const lastError = error instanceof Error ? error.message : String(error);
          siteSections.push({
            source: "smartpress.by",
            url: "https://smartpress.by/news/",
            items: [],
            error: lastError,
          });
        }
      } else {
        siteSections.push({
          source: "smartpress.by",
          url: "https://smartpress.by/news/",
          items: [],
          error: "Парсер для smartpress.by не найден",
        });
      }
    } else if (isGismeteoSite(siteInput) && urls.length > 0) {
      const parser = getParserForUrl(urls[0]);
      if (parser) {
        try {
          const html = await fetchNewsHtml(urls[0], timeoutMs, contentProvider, opts);
          const items = parser.parse(html, urls[0]);
          items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          siteSections.push({
            source: "gismeteo.by",
            url: "https://www.gismeteo.by/news/",
            items,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          siteSections.push({
            source: "gismeteo.by",
            url: "https://www.gismeteo.by/news/",
            items: [],
            error: errMsg,
          });
        }
      } else {
        siteSections.push({
          source: "gismeteo.by",
          url: "https://www.gismeteo.by/news/",
          items: [],
          error: "Парсер для gismeteo.by не найден",
        });
      }
    } else if (isWikidomSite(siteInput) && urls.length > 0) {
      const parser = getParserForUrl(urls[0]);
      if (parser) {
        try {
          const html = await fetchNewsHtml(urls[0], timeoutMs, contentProvider, opts);
          const items = parser.parse(html, urls[0]);
          items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          siteSections.push({
            source: "wikidom.by",
            url: "https://wikidom.by/blog/",
            items,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          siteSections.push({
            source: "wikidom.by",
            url: "https://wikidom.by/blog/",
            items: [],
            error: errMsg,
          });
        }
      } else {
        siteSections.push({
          source: "wikidom.by",
          url: "https://wikidom.by/blog/",
          items: [],
          error: "Парсер для wikidom.by не найден",
        });
      }
    } else {
      for (const url of urls) {
        const sourceName = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return url;
          }
        })();

        const parser = getParserForUrl(url);
        if (!parser) {
          try {
            const { fetchPageAsMarkdown } = await import("../fetch.js");
            const fallbackMarkdown = await fetchPageAsMarkdown(url, timeoutMs, {
              contentProvider,
              fetchFn: opts.fetchFn,
              lookupFn: opts.lookupFn,
              maxChars: FETCH_LIMITS.defaultMaxChars,
            });
            siteSections.push({
              source: sourceName,
              url,
              items: [],
              fallbackMarkdown,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            siteSections.push({
              source: sourceName,
              url,
              items: [],
              error: message,
            });
          }
          continue;
        }

        try {
          const html = await fetchNewsHtml(url, timeoutMs, contentProvider, opts);
          const items = parser.parse(html, url);
          items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
          siteSections.push({ source: sourceName, url, items });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          siteSections.push({ source: sourceName, url, items: [], error: message });
        }
      }
    }

    finalizeSections(siteInput, siteSections);

    // Never cache an error/empty section: that would hide a degraded source
    // for the whole TTL. Healthy (or markdown-fallback) results are cached.
    if (useCache && siteSections.length > 0 && siteSections.every(isCacheableSection)) {
      await writeCache(cacheId, siteSections);
    } else if (useCache) {
      log.warn(
        { site: siteInput, cacheId, statuses: siteSections.map((s) => s.status) },
        "news: degraded result not cached",
      );
    }

    sections.push(...siteSections);
  }

  return sections;
}
