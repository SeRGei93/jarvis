/**
 * Serper (Google SERP) web-search client for the native web service.
 *
 * Replaces the self-hosted SearXNG client: one POST to `google.serper.dev` with
 * the query, a result cap and Google's `gl`/`hl` locale, authenticated by
 * `X-API-KEY`. Regionality comes from the region parameter by construction
 * (country → `gl`, language → `hl`), there is no engine list to tune.
 *
 * Everything is injectable (`fetchFn`, `timeoutMs`, `apiKey`, `searchUrl`) so the
 * tool layer can pass SettingsService values and tests run without network.
 * Returns markdown strings ready to hand to the model.
 */
import { env } from "../../config/env.js";
import { timeoutFetch } from "../../pkg/timeout-fetch.js";
import { webChild } from "./logger.js";
import type { ResolvedRegion, SearchResult } from "./types.js";
import {
  CONFIG,
  DEFAULT_REGION,
  MAX_BATCH_QUERIES,
  REGION_ALIASES,
  SEARCH_API_BACKOFF_MS,
  SEARCH_API_RETRIES,
  SEARCH_API_TIMEOUT_MS,
  SERPER_MAX_RESULTS,
  SERPER_SEARCH_URL,
  googleLocale,
} from "./config.js";

const log = webChild("search");

/** SafeSearch level accepted by the search tools. Serper has no such switch — see below. */
type SafeSearch = "strict" | "moderate" | "off";

/**
 * Injectable dependencies for the search client. The tool layer supplies
 * `fetchFn` / `timeoutMs` from SettingsService; all fields fall back to the
 * static config and `env.SERPER_API_KEY`.
 */
export interface SearchDeps {
  /** Fetch implementation (defaults to the global `fetch`). */
  fetchFn?: typeof globalThis.fetch;
  /** Per-request timeout in ms (defaults to `SEARCH_API_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Serper API key (defaults to `env.SERPER_API_KEY`; injected in tests). */
  apiKey?: string;
  /** Serper endpoint override (tests point it at a local stub). */
  searchUrl?: string;
}

/** Common search options shared by single and batch searches. */
interface SearchOpts extends SearchDeps {
  count?: number;
  safeSearch?: SafeSearch;
  region?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Truncate a string for safe logging (never log full untrusted queries). */
function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Clamp a query to the configured maximum length. */
function clampQuery(query: string): string {
  return query.length > CONFIG.search.maxQueryLength
    ? query.slice(0, CONFIG.search.maxQueryLength)
    : query;
}

/** Clamp a requested result count into `[1, SERPER_MAX_RESULTS]` (one Google page). */
function clampCount(count: number): number {
  if (!Number.isFinite(count)) return CONFIG.search.defaultResults;
  return Math.max(1, Math.min(SERPER_MAX_RESULTS, Math.trunc(count)));
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  const formattedResults = results
    .map((r) => {
      return `### ${r.title}
${r.description}

Read more: ${r.url}
`;
    })
    .join("\n\n");

  return `# Web Search Results
Query: ${query}
Results: ${results.length}

---

${formattedResults}
`;
}

/**
 * Resolve a user-supplied region/locale to a canonical region.
 * Ported verbatim from the source client.
 */
export function resolveSearchRegion(region?: string): ResolvedRegion {
  if (!region) {
    return {
      requested: "default",
      resolved: DEFAULT_REGION,
    };
  }

  const normalized = region.trim().toLowerCase().replace("_", "-");
  if (!normalized) {
    return {
      requested: "default",
      resolved: DEFAULT_REGION,
    };
  }

  if (/^[a-z]{2}-[a-z]{2}$/.test(normalized)) {
    return {
      requested: region,
      resolved: normalized,
    };
  }

  const aliased = REGION_ALIASES[normalized];
  if (aliased) {
    const note =
      aliased === normalized
        ? undefined
        : `Region "${region}" mapped to "${aliased}".`;
    return {
      requested: region,
      resolved: aliased,
      note,
    };
  }

  return {
    requested: region,
    resolved: DEFAULT_REGION,
    note: `Unknown region "${region}", fallback to "${DEFAULT_REGION}".`,
  };
}

/** Serper's error body is `{message}` or `{error}`; keep it short for the model. */
async function serperErrorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const msg = typeof body.message === "string" ? body.message : body.error;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
  } catch {
    /* non-JSON body */
  }
  return `HTTP ${response.status}`;
}

/** A failure that repeating cannot fix (bad key, no credits, unknown model…). */
class NonRetryableSearchError extends Error {}

/**
 * Low-level Serper query with a retry/backoff loop.
 *
 * Retries network errors, 429 and 5xx (a fresh credit is only spent if the
 * request reached Serper); 401/403 fail immediately with an actionable message.
 * `safeSearch` is accepted for tool-contract compatibility but NOT sent: Serper's
 * Google endpoint has no safe-search parameter.
 */
async function performSerperSearch(
  query: string,
  count: number,
  safeSearch: SafeSearch,
  region: string | undefined,
  deps: SearchDeps
): Promise<SearchResult[]> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? SEARCH_API_TIMEOUT_MS;
  const searchUrl = deps.searchUrl ?? SERPER_SEARCH_URL;
  const apiKey = deps.apiKey ?? env.SERPER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "web search is not configured: SERPER_API_KEY is missing (fetch_url and the site tools keep working)",
    );
  }

  const resolvedRegion = resolveSearchRegion(region);
  const locale = googleLocale(resolvedRegion.resolved);
  const body = JSON.stringify({
    q: query,
    num: clampCount(count),
    ...(locale.gl ? { gl: locale.gl } : {}),
    ...(locale.hl ? { hl: locale.hl } : {}),
  });

  const request = timeoutFetch(timeoutMs, fetchFn);
  let lastError: unknown;

  for (let attempt = 0; attempt <= SEARCH_API_RETRIES; attempt += 1) {
    try {
      const response = await request(searchUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-API-KEY": apiKey,
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          const detail = await serperErrorText(response);
          log.warn(
            { status: response.status, query: truncate(query) },
            "serper rejected the API key (invalid key or credits exhausted)",
          );
          throw new NonRetryableSearchError(
            `Serper rejected the request (HTTP ${response.status}): ${detail}. ` +
              "Check SERPER_API_KEY and the remaining credits.",
          );
        }

        const retryable = response.status === 429 || response.status >= 500;
        const detail = await serperErrorText(response);
        if (retryable && attempt < SEARCH_API_RETRIES) {
          log.warn({ status: response.status, attempt }, "serper non-2xx, retrying");
          await sleep(SEARCH_API_BACKOFF_MS * (attempt + 1));
          continue;
        }

        const message = `Serper search failed (HTTP ${response.status}): ${detail}`;
        log.warn({ status: response.status, attempt }, "serper request failed");
        // 4xx (bad query) will not improve on retry; an exhausted 429/5xx might.
        throw retryable ? new Error(message) : new NonRetryableSearchError(message);
      }

      const payload = (await response.json()) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };

      return (payload.organic ?? [])
        .filter((item) => typeof item.link === "string" && item.link.length > 0)
        .map((item) => ({
          title: item.title?.trim() || "Untitled result",
          description: item.snippet?.trim() || item.title?.trim() || "No description",
          url: item.link as string,
        }));
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableSearchError) throw error;
      if (attempt < SEARCH_API_RETRIES) {
        await sleep(SEARCH_API_BACKOFF_MS * (attempt + 1));
        continue;
      }
    }
  }

  log.warn({ query: truncate(query), attempts: SEARCH_API_RETRIES + 1 }, "serper exhausted retries");
  throw lastError instanceof Error ? lastError : new Error("Serper request failed");
}

/**
 * Run a single web search and return a markdown report.
 *
 * @param query    The user query (clamped to `CONFIG.search.maxQueryLength`).
 * @param opts     Result count, safeSearch level, region and injectable deps.
 */
export async function performWebSearch(
  query: string,
  opts: SearchOpts = {}
): Promise<string> {
  const safeQuery = clampQuery(query);
  const count = clampCount(opts.count ?? CONFIG.search.defaultResults);
  const safeSearch = opts.safeSearch ?? CONFIG.search.defaultSafeSearch;
  const resolvedRegion = resolveSearchRegion(opts.region);

  const hits = await performSerperSearch(
    safeQuery,
    count,
    safeSearch,
    resolvedRegion.resolved,
    opts
  );

  if (hits.length === 0) {
    return `# Web Search Results
Query: ${safeQuery}
Region: ${resolvedRegion.resolved}
No results found.`;
  }

  const results: SearchResult[] = hits.slice(0, count);

  const result = formatSearchResults(safeQuery, results);
  const regionLine = `Region: ${resolvedRegion.resolved}\n`;
  const noteLine = resolvedRegion.note ? `Note: ${resolvedRegion.note}\n` : "";

  return result.replace(
    `Query: ${safeQuery}\n`,
    `Query: ${safeQuery}\n${regionLine}${noteLine}`
  );
}

/**
 * Run multiple web searches in parallel and return a grouped markdown report.
 * Queries beyond `MAX_BATCH_QUERIES` are dropped and noted in the output.
 *
 * @param queries  Queries to run; only the first `MAX_BATCH_QUERIES` execute.
 * @param opts     Result count, safeSearch level, region and injectable deps.
 */
export async function performWebSearchBatch(
  queries: string[],
  opts: SearchOpts = {}
): Promise<string> {
  const truncated = queries.length > MAX_BATCH_QUERIES;
  const effective = truncated ? queries.slice(0, MAX_BATCH_QUERIES) : queries;

  const jobs = effective.map(async (query) => {
    try {
      const result = await performWebSearch(query, opts);
      return { query, ok: true as const, result };
    } catch (error) {
      log.warn(
        {
          query: truncate(query),
          err: error instanceof Error ? error.message : String(error),
        },
        "batch query failed"
      );
      return {
        query,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const settled = await Promise.all(jobs);
  const success = settled.filter((item) => item.ok);
  const failed = settled.filter((item) => !item.ok);

  const sections = settled
    .map((item) => {
      if (item.ok) {
        return `## Query: ${item.query}\n\n${item.result}`;
      }
      return `## Query: ${item.query}\n\nError: ${item.error}`;
    })
    .join("\n\n---\n\n");

  const truncationNote = truncated
    ? `Note: only the first ${MAX_BATCH_QUERIES} of ${queries.length} queries were run.\n`
    : "";

  return `# Batch Web Search Results
Total queries: ${effective.length}
Successful: ${success.length}
Failed: ${failed.length}
${truncationNote}
${sections}`;
}
