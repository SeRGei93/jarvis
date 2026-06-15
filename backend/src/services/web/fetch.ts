/**
 * Browser-free page fetch + cleanup layer.
 *
 * Fetches a URL with realistic browser headers, follows redirects manually (so
 * the SSRF guard runs on every hop), strips junk markup, and produces a compact
 * markdown-ish document. Specialised parsers and news-article handlers are
 * INJECTED by the caller (see {@link FetchPageOptions}) — this module never
 * imports parser/vertical code or any browser engine.
 */
import { JSDOM } from "jsdom";

import { readFetchCache, writeFetchCache } from "./fetch-cache.js";
import { webChild } from "./logger.js";
import {
  assertUrlAllowed,
  SsrfError,
  type LookupFn,
} from "./ssrf-guard.js";

const log = webChild("fetch");

/** A specialised per-site content extractor, injected by the caller. */
export interface PageParser {
  /** True if this parser handles the given URL. */
  match: (url: string) => boolean;
  /** Extracts cleaned `{ html, title }`, or null to fall through. */
  extract: (html: string) => { html: string; title: string } | null;
}

/** Options for {@link fetchPageAsMarkdown}; everything network-facing is injectable. */
export interface FetchPageOptions {
  /** Fetch implementation (defaults to global `fetch`). */
  fetchFn?: typeof globalThis.fetch;
  /** DNS resolver used by the SSRF guard. */
  lookupFn?: LookupFn;
  /** Registry of specialised parsers, tried in order; default `[]`. */
  pageParsers?: PageParser[];
  /** Returns ready markdown for special article URLs, or null to fall through. */
  articleHandler?: (url: string, timeoutMs: number) => Promise<string | null>;
  /** Read/write the on-disk fetch cache; default `true`. */
  useCache?: boolean;
}

/** Realistic Chrome UA (mirrors the browser layer in the source repo). */
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Default cap on manually-followed redirects. */
const DEFAULT_MAX_REDIRECTS = 5;
/** Hard cap on a fetched page body — guards against memory exhaustion from a hostile/huge response. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Read a response body as UTF-8 text, aborting if it exceeds `maxBytes`.
 * Rejects early on an oversized `content-length`, then streams with a running
 * byte cap (a lying/absent content-length can't smuggle an unbounded body).
 * Decodes as UTF-8 to match the Fetch spec's `Response.text()` behaviour.
 */
async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response too large: ${declared} bytes (max ${maxBytes})`);
  }
  const body = response.body;
  if (!body) return await response.text(); // no stream available — fall back
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(concatChunks(chunks, total));
}

/** Concatenate body chunks into one buffer of the known total length. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Селекторы мусора удаляемого при универсальной очистке. */
const JUNK_SELECTORS = [
  // Технические теги
  "script", "style", "noscript",
  // Медиа без текстового содержимого
  "img", "svg", "canvas", "picture", "video", "audio",
  // Интерактивные элементы
  "button", "form", "input", "select", "textarea",
  // Встраиваемый контент
  "iframe", "embed", "object",
  // Структурная навигация
  "header", "footer", "nav", "aside",
  // ARIA-роли навигационного мусора
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  "[role='complementary']", "[role='search']",
  // Скрытые элементы
  "[aria-hidden='true']", "[hidden]",
  // Реклама
  "[class*='advert']", "[class*='ad-']", "[id*='ad-']",
  "[class*='-ad']", "[id*='-ad']",
  // Попапы, куки, соцсети
  "[class*='banner']", "[class*='popup']", "[class*='modal']",
  "[class*='cookie']", "[class*='social']", "[class*='share']",
  // Боковые колонки
  "[class*='sidebar']", "[class*='side-bar']",
  // Рекомендации и похожие материалы
  "[class*='recommend']", "[class*='related']", "[class*='more-']",
  // Хлебные крошки и пагинация
  "[class*='breadcrumb']", "[class*='pagination']",
];

/** Encode bare square brackets in the query string (some servers reject them). */
function encodeBrackets(url: string): string {
  const idx = url.indexOf("?");
  if (idx === -1) return url;
  const base = url.slice(0, idx);
  const qs = url.slice(idx + 1).replace(/%5B/gi, "[").replace(/%5D/gi, "]");
  const encoded = qs.replace(/\[/g, "%5B").replace(/\]/g, "%5D");
  return `${base}?${encoded}`;
}

/** Realistic browser request headers (some sites 403 a bare fetch). */
const REQUEST_HEADERS: Record<string, string> = {
  "user-agent": CHROME_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "ru-BY,ru;q=0.9,en;q=0.8",
};

/**
 * Fetches raw HTML for `url`, applying the SSRF guard before the request and on
 * every manually-followed redirect hop (so redirect-based SSRF is blocked).
 *
 * @throws {SsrfError} on a disallowed URL / redirect target or redirect overflow.
 * @throws {Error} on non-2xx responses or unsupported content types.
 */
export async function fetchRawHtml(
  url: string,
  timeoutMs: number,
  opts: {
    fetchFn?: typeof globalThis.fetch;
    lookupFn?: LookupFn;
    maxRedirects?: number;
  } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const lookupFn = opts.lookupFn;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = url;
  let hops = 0;

  // Loop: validate → fetch (no auto-redirect) → on 3xx revalidate target & repeat.
  for (;;) {
    // SSRF guard runs on the initial URL and on EVERY redirect target.
    await assertUrlAllowed(currentUrl, lookupFn);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(encodeBrackets(currentUrl), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: REQUEST_HEADERS,
      });
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect ${response.status} without Location header`);
      }
      hops += 1;
      if (hops > maxRedirects) {
        throw new Error(`Too many redirects (> ${maxRedirects}) for ${url}`);
      }
      // Resolve relative Location against the current URL; guard re-runs at loop top.
      const nextUrl = new URL(location, currentUrl).toString();
      log.debug({ from: currentUrl, to: nextUrl, hop: hops }, "fetch: redirect");
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    return await readTextCapped(response, MAX_RESPONSE_BYTES);
  }
}

/**
 * Универсальная очистка HTML от мусора.
 * Returns the page title and a cleaned `innerHTML` of the main content,
 * preserving `application/ld+json` blocks.
 */
function cleanHtml(url: string, html: string): { title: string; html: string } {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const title = doc.title?.trim() || new URL(url).hostname;

  // Сохраняем json-ld перед удалением скриптов.
  const jsonLdBlocks: string[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    const content = el.textContent?.trim();
    if (content) jsonLdBlocks.push(content);
  });

  // Удаляем мусор.
  JUNK_SELECTORS.forEach((selector) => {
    try {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // игнорируем невалидные селекторы
    }
  });

  const bodyHtml = doc.body?.innerHTML ?? "<p>No content.</p>";

  // Схлопываем лишние пробелы.
  const clean = bodyHtml.replace(/\s{2,}/g, " ").replace(/>\s+</g, "><").trim();

  // Добавляем json-ld в конец если есть.
  const jsonLdSection =
    jsonLdBlocks.length > 0
      ? "\n\n" +
        jsonLdBlocks
          .map((b) => `<script type="application/ld+json">${b}</script>`)
          .join("\n")
      : "";

  dom.window.close();
  return { title, html: clean + jsonLdSection };
}

/** Wraps a cleaned body in the standard markdown document shell. */
function buildOutput(title: string, url: string, bodyHtml: string): string {
  return `# ${title}\n\nSource: ${url}\n\n---\n\n${bodyHtml}`;
}

/**
 * Fetches `url`, runs the (injected) article handler / parsers / generic
 * cleanup, and returns a markdown document. Results are cached on disk unless
 * `useCache === false`. No browser engine is ever used.
 */
export async function fetchPageAsMarkdown(
  url: string,
  timeoutMs: number,
  opts: FetchPageOptions = {},
): Promise<string> {
  const started = Date.now();
  const useCache = opts.useCache !== false;

  try {
    // 1) Cache hit short-circuit.
    if (useCache) {
      const cached = await readFetchCache(url);
      if (cached) {
        log.debug(
          { url, len: cached.length, elapsedMs: Date.now() - started },
          "fetch: cache hit",
        );
        return cached;
      }
    }
    log.debug({ url, useCache }, "fetch: cache miss");

    // 2) Special article handler (returns ready markdown), injected by caller.
    if (opts.articleHandler) {
      const md = await opts.articleHandler(url, timeoutMs);
      if (md) {
        if (useCache) await writeFetchCache(url, md);
        log.debug(
          { url, len: md.length, parser: "article", elapsedMs: Date.now() - started },
          "fetch: article handler",
        );
        return md;
      }
    }

    // 3) Plain HTML fetch (no browser branch).
    const rawHtml = await fetchRawHtml(url, timeoutMs, {
      fetchFn: opts.fetchFn,
      lookupFn: opts.lookupFn,
    });

    // 4) Specialised parsers — first match wins.
    let output: string | null = null;
    let chosen = "clean";
    for (const parser of opts.pageParsers ?? []) {
      if (parser.match(url)) {
        const r = parser.extract(rawHtml);
        if (r) {
          output = buildOutput(r.title, url, r.html);
          chosen = "parser";
          break;
        }
      }
    }

    // 5) Generic cleanup fallback.
    if (output === null) {
      const { title, html } = cleanHtml(url, rawHtml);
      output = buildOutput(title, url, html);
    }

    // 6) Cache and return.
    if (useCache) await writeFetchCache(url, output);
    log.debug(
      { url, parser: chosen, len: output.length, elapsedMs: Date.now() - started },
      "fetch: done",
    );
    return output;
  } catch (err) {
    if (err instanceof SsrfError) {
      log.warn(
        { url, err: err.message, elapsedMs: Date.now() - started },
        "fetch: SSRF blocked",
      );
    } else {
      log.warn(
        { url, err: (err as Error).message, elapsedMs: Date.now() - started },
        "fetch: failed",
      );
    }
    throw err;
  }
}
