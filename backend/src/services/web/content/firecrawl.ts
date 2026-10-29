/**
 * Firecrawl content provider (`POST /v2/scrape`).
 *
 * Firecrawl does the expensive part (browser, proxies, PDF/Office parsing) and
 * returns readable markdown or raw HTML. This module only adapts its response
 * to the vendor-neutral {@link ContentProvider} contract — tools never see
 * Firecrawl-specific fields.
 */
import { timeoutFetch } from "../../../pkg/timeout-fetch.js";
import { webChild } from "../logger.js";
import {
  ContentProviderError,
  type ContentFormat,
  type ContentProvider,
  type PageContent,
  type PageContentRequest,
} from "./types.js";

const log = webChild("firecrawl");

/** Firecrawl cloud base URL. Override for a self-hosted/proxied deployment. */
export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";
/** Default provider-side cache window: fresh enough for news, cheap for repeats. */
export const FIRECRAWL_DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
/** Firecrawl accepts 1s..300s. */
const FIRECRAWL_MIN_TIMEOUT_MS = 1_000;
const FIRECRAWL_MAX_TIMEOUT_MS = 300_000;

export interface FirecrawlProviderOptions {
  /** `fc-...` API key. Empty = provider is not configured. */
  apiKey?: string;
  /** Base URL without a trailing slash. Defaults to the cloud API. */
  baseUrl?: string;
  /** Injectable fetch for tests / custom transports. */
  fetchFn?: typeof globalThis.fetch;
  /** Default cache age; a request-level `maxAgeMs` wins. */
  maxAgeMs?: number;
}

interface FirecrawlMetadata {
  title?: string | string[];
  description?: string | string[];
  url?: string;
  sourceURL?: string;
  statusCode?: number;
  publishedTime?: string;
  [key: string]: unknown;
}

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    metadata?: FirecrawlMetadata;
    warning?: string;
  };
  error?: string;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((v) => typeof v === "string" && v.trim() !== "")?.trim();
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return FIRECRAWL_MIN_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(timeoutMs), FIRECRAWL_MIN_TIMEOUT_MS), FIRECRAWL_MAX_TIMEOUT_MS);
}

function normaliseBaseUrl(value: string | undefined): string {
  return (value?.trim() || FIRECRAWL_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Error body helper: keep provider detail short and actionable. */
async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const message = typeof body.error === "string" ? body.error : body.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    /* non-JSON error body */
  }
  return `HTTP ${response.status}`;
}

export class FirecrawlProvider implements ContentProvider {
  readonly name = "firecrawl";
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxAgeMs: number;

  constructor(options: FirecrawlProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = normaliseBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.maxAgeMs = options.maxAgeMs ?? FIRECRAWL_DEFAULT_MAX_AGE_MS;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async fetchPage(request: PageContentRequest): Promise<PageContent> {
    if (!this.apiKey) {
      throw new ContentProviderError(
        "Firecrawl is not configured: FIRECRAWL_API_KEY is missing",
        this.name,
      );
    }

    const format: ContentFormat = request.format;
    const body = {
      url: request.url,
      // `rawHtml` is the unmodified DOM; `markdown` is Firecrawl's readable output.
      formats: [format === "markdown" ? "markdown" : "rawHtml"],
      onlyMainContent: format === "markdown" ? (request.onlyMainContent ?? true) : false,
      maxAge: request.maxAgeMs ?? this.maxAgeMs,
      timeout: clampTimeout(request.timeoutMs),
      // Defaults are sensible, but make the security-relevant ones explicit.
      blockAds: true,
      skipTlsVerification: false,
      proxy: "auto",
    };

    const fetchWithTimeout = timeoutFetch(request.timeoutMs, this.fetchFn);
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}/v2/scrape`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      throw new ContentProviderError(
        `Firecrawl request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
      );
    }

    if (!response.ok) {
      const detail = await errorText(response);
      throw new ContentProviderError(
        `Firecrawl scrape failed (HTTP ${response.status}): ${detail}`,
        this.name,
        response.status,
      );
    }

    let payload: FirecrawlResponse;
    try {
      payload = (await response.json()) as FirecrawlResponse;
    } catch {
      throw new ContentProviderError("Firecrawl returned a non-JSON response", this.name, response.status);
    }

    const data = payload.data;
    const content =
      format === "markdown"
        ? data?.markdown?.trim()
        : (data?.rawHtml ?? data?.html)?.trim();

    if (payload.success === false || !content) {
      throw new ContentProviderError(
        payload.error?.trim() || "Firecrawl returned empty page content",
        this.name,
        response.status,
      );
    }

    const metadata = data?.metadata;
    const finalUrl = metadata?.url || metadata?.sourceURL || request.url;
    const result: PageContent = {
      provider: this.name,
      requestedUrl: request.url,
      finalUrl,
      format,
      content,
      title: firstString(metadata?.title),
      description: firstString(metadata?.description),
      publishedTime: firstString(metadata?.publishedTime),
      statusCode: typeof metadata?.statusCode === "number" ? metadata.statusCode : undefined,
      rawHtml: data?.rawHtml,
      metadata: metadata as Record<string, unknown> | undefined,
    };

    log.debug(
      {
        url: request.url,
        finalUrl: result.finalUrl,
        format,
        chars: content.length,
        status: result.statusCode,
      },
      "firecrawl: page fetched",
    );
    return result;
  }
}
