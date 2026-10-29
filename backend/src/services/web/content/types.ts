/**
 * Provider-agnostic page-content fetching.
 *
 * Tools depend on this interface, never on a concrete vendor. A provider can be
 * a hosted reader (Firecrawl, Jina), a self-hosted browser service, or a plain
 * HTTP fetch — swapping it must not change `fetch_url` / `search_news`.
 */

/** Output shape requested from a provider. */
export type ContentFormat = "markdown" | "html";

/** A single page request. */
export interface PageContentRequest {
  /** Absolute http(s) URL. Validated by the caller before it reaches a provider. */
  url: string;
  /** `markdown` for readable page text; `html` for site parsers. */
  format: ContentFormat;
  /** Hard request timeout in milliseconds. */
  timeoutMs: number;
  /** Caller abort signal (agent watchdog / tool abort). */
  signal?: AbortSignal;
  /**
   * Maximum acceptable provider-cache age in ms. `0` forces a fresh fetch.
   * Providers without a cache may ignore it.
   */
  maxAgeMs?: number;
  /** Return only the main content (provider may ignore it for HTML). */
  onlyMainContent?: boolean;
}

/** Normalised page returned by a provider. */
export interface PageContent {
  /** Provider that produced this result, e.g. `firecrawl`. */
  provider: string;
  /** URL that was requested. */
  requestedUrl: string;
  /** URL after redirects, when the provider reports it. */
  finalUrl: string;
  /** Format of `content`. */
  format: ContentFormat;
  /** Markdown text or HTML, depending on `format`. Never empty. */
  content: string;
  title?: string;
  description?: string;
  publishedTime?: string;
  statusCode?: number;
  /** Unmodified HTML when the provider can return it alongside markdown. */
  rawHtml?: string;
  /** Vendor metadata, passed through untouched for diagnostics. */
  metadata?: Record<string, unknown>;
}

/** A replaceable page-content backend. */
export interface ContentProvider {
  /** Stable provider id (used in logs and env selection). */
  readonly name: string;
  /** True when credentials/endpoint are present and the provider can be used. */
  readonly configured: boolean;
  /** Fetch one page. Throws {@link ContentProviderError} on failure. */
  fetchPage(request: PageContentRequest): Promise<PageContent>;
}

/** Error raised by a content provider; keep the status for actionable tool messages. */
export class ContentProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ContentProviderError";
  }
}
