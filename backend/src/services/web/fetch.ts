/**
 * Browser-free page fetch + cleanup layer.
 *
 * Fetches a URL with realistic browser headers, follows redirects manually (so
 * the SSRF guard runs on every hop), strips junk markup, and produces a compact
 * markdown-ish document. Specialised parsers and news-article handlers are
 * INJECTED by the caller (see {@link FetchPageOptions}); generic pages may be
 * delegated to a replaceable external content provider (Firecrawl by default).
 * This module never imports a browser engine.
 */
import { JSDOM } from "jsdom";

import { readFetchCache, writeFetchCache } from "./fetch-cache.js";
import { webChild } from "./logger.js";
import { readableFromHtml } from "./readable.js";
import type { ContentProvider, PageContent } from "./content/types.js";
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

/** Minimal cache contract (the default is the on-disk fetch cache). */
export interface FetchCache {
  read(url: string): Promise<string | null>;
  write(url: string, markdown: string): Promise<void>;
}

/** Result of {@link truncateForOutput}. */
export interface TruncateResult {
  /** Text to hand to the model (with the truncation marker when needed). */
  text: string;
  shownChars: number;
  totalChars: number;
  truncated: boolean;
}

/**
 * Bound one tool result without touching the cached copy.
 *
 * The cache always stores the FULL extracted document, so a later call (or a
 * larger `maxChars`) can still reach the tail. This helper only builds the
 * model-facing string and appends an explicit marker.
 */
export function truncateForOutput(text: string, maxChars: number): TruncateResult {
  const total = text.length;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || total <= maxChars) {
    return { text, shownChars: total, totalChars: total, truncated: false };
  }

  let shown = Math.max(0, Math.trunc(maxChars));
  // Never split a surrogate pair (emoji/CJK) at the cut point.
  const lastCode = shown > 0 ? text.charCodeAt(shown - 1) : 0;
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) shown -= 1;

  const marker = `\n\n[truncated: показано ${shown} из ${total} символов]`;
  return {
    text: `${text.slice(0, shown).trimEnd()}${marker}`,
    shownChars: shown,
    totalChars: total,
    truncated: true,
  };
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
  /** Read/write the fetch cache; default `true`. */
  useCache?: boolean;
  /** Cache implementation override (default: the on-disk fetch cache). */
  cache?: FetchCache;
  /**
   * Max characters of markdown returned to the caller. The cache still keeps
   * the full document; the tail is only cut at this output boundary.
   */
  maxChars?: number;
  /**
   * Optional external content provider (Firecrawl, Jina, …). Local HTTP +
   * Readability is always tried first; the provider is used only when the local
   * fetch fails or produces no usable content.
   */
  contentProvider?: ContentProvider;
  /**
   * Caller abort signal (e.g. the agent watchdog). Composed with the internal
   * per-request timeout via `AbortSignal.any`, so EITHER aborts the in-flight
   * HTTP request. Optional — omit for the legacy timeout-only behaviour.
   */
  signal?: AbortSignal;
}

/** Realistic Chrome UA (mirrors the browser layer in the source repo). */
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Default cap on manually-followed redirects. */
const DEFAULT_MAX_REDIRECTS = 5;
/** Hard cap on a fetched page body — guards against memory exhaustion from a hostile/huge response. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Below this many Markdown chars, prefer the external provider when configured. */
const MIN_READABLE_CHARS = 200;

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

/**
 * Extract a cookie from a lightweight JS challenge page.
 *
 * Some sites answer with HTTP 200 + a tiny script that sets a cookie and
 * reloads (`document.cookie = "name=…; path=/; …"`). We can satisfy that
 * without a browser by echoing the cookie once — saving a Firecrawl credit.
 * Only short documents with an explicit cookie/path assignment qualify.
 */
function extractChallengeCookie(html: string): string | undefined {
  if (html.length > 32_000) return undefined;
  const direct = html.match(/document\.cookie\s*=\s*["']([^"']+)["']/i)?.[1];
  const assigned = html.match(/["']([A-Za-z0-9_-]+=[^;"'\s]+)[^"']*;\s*path=\//i)?.[1];
  const raw = direct ?? assigned;
  if (!raw) return undefined;
  const pair = raw.split(";")[0]?.trim();
  if (!pair || pair.length > 4096) return undefined;
  return /^[A-Za-z0-9_-]+=[^;\s]+$/.test(pair) ? pair : undefined;
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

/** Options for the low-level HTML fetch. */
export interface FetchRawOptions {
  fetchFn?: typeof globalThis.fetch;
  lookupFn?: LookupFn;
  maxRedirects?: number;
  /**
   * Caller abort signal (e.g. the agent watchdog). Composed with the internal
   * per-request timeout via `AbortSignal.any` — EITHER aborts the fetch.
   */
  signal?: AbortSignal;
  /** Internal: cookie obtained from a JS challenge, sent once on retry. */
  cookie?: string;
  /** Internal: prevents a challenge-cookie retry loop. */
  challengeRetried?: boolean;
}

/** Raw HTML plus the URL that finally served it (after redirects). */
export interface RawHtmlResult {
  html: string;
  finalUrl: string;
}

/**
 * Fetches raw HTML for `url`, applying the SSRF guard before the request and on
 * every manually-followed redirect hop (so redirect-based SSRF is blocked).
 *
 * Returns the final URL too: Google News links and many publisher links are
 * redirects, and the caller must cite the publisher, not the wrapper.
 *
 * @throws {SsrfError} on a disallowed URL / redirect target or redirect overflow.
 * @throws {Error} on non-2xx responses or unsupported content types.
 */
export async function fetchRawHtmlResult(
  url: string,
  timeoutMs: number,
  opts: FetchRawOptions = {},
): Promise<RawHtmlResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const lookupFn = opts.lookupFn;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const callerSignal = opts.signal;

  let currentUrl = url;
  let hops = 0;

  // Loop: validate → fetch (no auto-redirect) → on 3xx revalidate target & repeat.
  for (;;) {
    // SSRF guard runs on the initial URL and on EVERY redirect target.
    await assertUrlAllowed(currentUrl, lookupFn);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Compose the timeout signal with the caller's (watchdog) signal: EITHER
    // firing aborts the request. Fall back to the timeout-only signal when no
    // caller signal is supplied (preserves legacy behaviour).
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;

    let response: Response;
    try {
      const headers: Record<string, string> = { ...REQUEST_HEADERS };
      // Send a challenge cookie only to the same host that issued it.
      if (opts.cookie) {
        try {
          if (new URL(currentUrl).hostname === new URL(url).hostname) {
            headers.cookie = opts.cookie;
          }
        } catch {
          /* malformed URL is rejected by the guard above */
        }
      }
      response = await fetchFn(encodeBrackets(currentUrl), {
        method: "GET",
        redirect: "manual",
        signal,
        headers,
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

    const body = await readTextCapped(response, MAX_RESPONSE_BYTES);

    // Some sites answer HTTP 200 with a tiny JS cookie challenge (Tochka). Echo
    // the cookie once instead of spending an external-provider credit.
    if (!opts.challengeRetried) {
      const cookie = extractChallengeCookie(body);
      if (cookie) {
        log.debug({ url: currentUrl }, "fetch: JS cookie challenge, retrying with cookie");
        return await fetchRawHtmlResult(url, timeoutMs, {
          ...opts,
          cookie,
          challengeRetried: true,
        });
      }
    }

    return { html: body, finalUrl: currentUrl };
  }
}

/** Backwards-compatible wrapper: HTML only (most callers do not need the URL). */
export async function fetchRawHtml(
  url: string,
  timeoutMs: number,
  opts: FetchRawOptions = {},
): Promise<string> {
  return (await fetchRawHtmlResult(url, timeoutMs, opts)).html;
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

/** True for aborts that must not be swallowed by provider/local fallbacks. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

/** Normalise a provider result into the markdown document shell. */
function buildProviderOutput(page: PageContent, fallbackUrl: string): string {
  let title = page.title?.trim();
  if (!title) {
    try {
      title = new URL(fallbackUrl).hostname;
    } catch {
      title = "Page";
    }
  }
  const source = page.finalUrl || fallbackUrl;
  return buildOutput(title, source, page.content);
}

/**
 * Fetches `url`, runs the (injected) article handler / parsers / generic
 * cleanup, and returns a markdown document. Generic pages (or local failures)
 * may be delegated to a configured {@link ContentProvider} (Firecrawl, …).
 * Results are cached on disk unless `useCache === false`.
 */
export async function fetchPageAsMarkdown(
  url: string,
  timeoutMs: number,
  opts: FetchPageOptions = {},
): Promise<string> {
  const started = Date.now();
  const useCache = opts.useCache !== false;
  const provider = opts.contentProvider;
  const cache: FetchCache = opts.cache ?? {
    read: readFetchCache,
    write: writeFetchCache,
  };
  let providerAttempted = false;

  /**
   * Apply the output budget AFTER the cache write: the disk copy always keeps
   * the full document, the model gets a bounded string with an explicit marker.
   */
  const fitOutput = (targetUrl: string, output: string): string => {
    if (opts.maxChars === undefined) return output;
    const limited = truncateForOutput(output, opts.maxChars);
    if (limited.truncated) {
      log.warn(
        { url: targetUrl, shown: limited.shownChars, total: limited.totalChars },
        "fetch: output truncated",
      );
    }
    return limited.text;
  };

  /** Fetch through the external provider and cache the rendered document. */
  const fetchViaProvider = async (): Promise<string> => {
    if (!provider) throw new Error("content provider is not configured");
    // Never let an external provider bypass the SSRF guard (initial URL + DNS).
    await assertUrlAllowed(url, opts.lookupFn);
    providerAttempted = true;
    const page = await provider.fetchPage({
      url,
      format: "markdown",
      timeoutMs,
      signal: opts.signal,
    });
    const output = buildProviderOutput(page, url);
    if (useCache) await cache.write(url, output);
    log.debug(
      {
        url,
        provider: page.provider,
        finalUrl: page.finalUrl,
        len: output.length,
        elapsedMs: Date.now() - started,
      },
      "fetch: provider",
    );
    return fitOutput(url, output);
  };

  try {
    // 1) Cache hit short-circuit.
    if (useCache) {
      const cached = await cache.read(url);
      if (cached) {
        log.debug(
          { url, len: cached.length, elapsedMs: Date.now() - started },
          "fetch: cache hit",
        );
        return fitOutput(url, cached);
      }
    }
    log.debug({ url, useCache, provider: provider?.name }, "fetch: cache miss");

    // 2) Special article handler (returns ready markdown), injected by caller.
    if (opts.articleHandler) {
      try {
        const md = await opts.articleHandler(url, timeoutMs);
        if (md) {
          if (useCache) await cache.write(url, md);
          log.debug(
            { url, len: md.length, parser: "article", elapsedMs: Date.now() - started },
            "fetch: article handler",
          );
          return fitOutput(url, md);
        }
      } catch (err) {
        if (isAbortError(err) || err instanceof SsrfError) throw err;
        log.warn(
          { url, err: (err as Error).message, elapsedMs: Date.now() - started },
          "fetch: article handler failed; falling through",
        );
      }
    }

    // 3) Plain HTML fetch (local-first). The external provider is only used
    // when the local fetch fails or produces no usable content.
    let raw: RawHtmlResult;
    try {
      raw = await fetchRawHtmlResult(url, timeoutMs, {
        fetchFn: opts.fetchFn,
        lookupFn: opts.lookupFn,
        signal: opts.signal,
      });
    } catch (err) {
      if (isAbortError(err) || err instanceof SsrfError) throw err;
      if (provider && !providerAttempted) {
        try {
          return await fetchViaProvider();
        } catch (providerErr) {
          if (isAbortError(providerErr)) throw providerErr;
          log.warn(
            {
              url,
              provider: provider.name,
              localErr: (err as Error).message,
              providerErr: (providerErr as Error).message,
            },
            "fetch: local fetch and provider both failed",
          );
        }
      }
      throw err;
    }

    const rawHtml = raw.html;
    // Cite the URL that finally served the page (Google News and many publisher
    // links are redirects; the wrapper must never reach the model as a source).
    const finalUrl = raw.finalUrl;

    // 4) Specialised parsers — first match wins.
    let output: string | null = null;
    let chosen = "clean";
    for (const parser of opts.pageParsers ?? []) {
      if (parser.match(url)) {
        const r = parser.extract(rawHtml);
        if (r) {
          output = buildOutput(r.title, finalUrl, r.html);
          chosen = "parser";
          break;
        }
      }
    }

    // 5) Generic SSR page: local Readability → Markdown. No Firecrawl credit is
    // spent when the server-rendered HTML already contains the article.
    let readableOutput: string | null = null;
    if (output === null) {
      const readable = readableFromHtml(rawHtml, finalUrl);
      if (readable?.markdown) {
        const title = readable.title?.trim() || new URL(finalUrl).hostname;
        readableOutput = buildOutput(title, finalUrl, readable.markdown);
        if (readable.charCount >= MIN_READABLE_CHARS || !provider) {
          output = readableOutput;
          chosen = "readable";
        }
      }
    }

    // 6) No local content (or a JS shell / tiny challenge page): ask the
    // external provider before falling back to the old denylist cleanup.
    if (output === null && provider && !providerAttempted) {
      try {
        return await fetchViaProvider();
      } catch (err) {
        if (isAbortError(err)) throw err;
        log.warn(
          { url, provider: provider.name, err: (err as Error).message },
          "fetch: provider failed; using local fallback",
        );
      }
    }

    // 7) Keep a short-but-real local page if the provider is unavailable/failed.
    if (output === null && readableOutput) {
      output = readableOutput;
      chosen = "readable";
    }

    // 8) Generic cleanup fallback.
    if (output === null) {
      const { title, html } = cleanHtml(finalUrl, rawHtml);
      output = buildOutput(title, finalUrl, html);
    }

    // 9) Cache the FULL document, then apply the output budget.
    if (useCache) await cache.write(url, output);
    log.debug(
      {
        url,
        finalUrl,
        parser: chosen,
        len: output.length,
        elapsedMs: Date.now() - started,
      },
      "fetch: done",
    );
    return fitOutput(url, output);
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
