/**
 * SearXNG web-search client for the native web service.
 *
 * Ported from the external MCP server and adapted to jarvis:
 *  - the rate limiter is removed (no `checkRateLimit`, no `skipRateLimitCheck`);
 *  - basic-auth is removed (our SearXNG is internal, no credentials);
 *  - `fetchFn`, `timeoutMs`, `searxngUrl`, `engines` and `categories` are
 *    injectable so the tool layer can pass values from SettingsService while
 *    keeping this service decoupled (it never imports SettingsService);
 *  - verbose DEBUG logging via the web service logger.
 *
 * Returns markdown strings ready to hand to the model.
 */
import { webChild } from "./logger.js";
import type { ResolvedRegion, SearchResult } from "./types.js";
import {
  CONFIG,
  DEFAULT_REGION,
  DEFAULT_SEARCH_LANGUAGE,
  MAX_BATCH_QUERIES,
  REGION_ALIASES,
  REGION_TO_LANGUAGE,
  SEARCH_API_BACKOFF_MS,
  SEARCH_API_RETRIES,
  SEARCH_API_TIMEOUT_MS,
  SEARCH_API_URL,
  SEARCH_CATEGORIES,
  SEARCH_ENGINES,
} from "./config.js";

const log = webChild("search");

/** SafeSearch level accepted by the search tools. */
type SafeSearch = "strict" | "moderate" | "off";

/**
 * Injectable dependencies for the search client. The tool layer supplies
 * `fetchFn` / `timeoutMs` (and optionally endpoint/engine overrides) from
 * SettingsService; all fields fall back to the static config constants.
 */
export interface SearchDeps {
  /** Fetch implementation (defaults to the global `fetch`). */
  fetchFn?: typeof globalThis.fetch;
  /** Per-request timeout in ms (defaults to `SEARCH_API_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** SearXNG base URL (defaults to `SEARCH_API_URL`). */
  searxngUrl?: string;
  /** Comma-separated engine list (defaults to `SEARCH_ENGINES`). */
  engines?: string;
  /** Comma-separated category list (defaults to `SEARCH_CATEGORIES`). */
  categories?: string;
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

/** Clamp a requested result count into `[1, CONFIG.search.maxResults]`. */
function clampCount(count: number): number {
  if (!Number.isFinite(count)) return CONFIG.search.defaultResults;
  return Math.max(1, Math.min(CONFIG.search.maxResults, Math.trunc(count)));
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

function resolveSearchLanguage(resolvedRegion: string): string {
  return REGION_TO_LANGUAGE[resolvedRegion] ?? DEFAULT_SEARCH_LANGUAGE;
}

/**
 * Low-level SearXNG JSON query with a retry/backoff loop.
 * Retries only on network errors or HTTP ≥500, using a per-attempt
 * `AbortController` driven by `timeoutMs`.
 */
async function performSearxSearch(
  query: string,
  safeSearch: SafeSearch,
  region: string | undefined,
  deps: SearchDeps
): Promise<SearchResult[]> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? SEARCH_API_TIMEOUT_MS;
  const searxngUrl = deps.searxngUrl ?? SEARCH_API_URL;
  const engines = deps.engines ?? SEARCH_ENGINES;
  const categories = deps.categories ?? SEARCH_CATEGORIES;

  const resolvedRegion = resolveSearchRegion(region);
  const language = resolveSearchLanguage(resolvedRegion.resolved);
  const safeSearchLevel =
    safeSearch === "strict" ? "2" : safeSearch === "off" ? "0" : "1";

  const params = new URLSearchParams({
    q: query,
    format: "json",
    engines,
    language,
    safesearch: safeSearchLevel,
    categories,
  });
  const headers: HeadersInit = {
    accept: "application/json",
    "user-agent": "jarvis-web/1.0",
  };

  const url = `${searxngUrl}/search?${params.toString()}`;
  log.debug(
    {
      query: truncate(query),
      region: resolvedRegion.resolved,
      language,
      safeSearch,
      engines,
      timeoutMs,
    },
    "searx request"
  );

  let lastError: unknown;

  for (let attempt = 0; attempt <= SEARCH_API_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        if (response.status >= 500 && attempt < SEARCH_API_RETRIES) {
          log.warn(
            { status: response.status, attempt },
            "searx non-2xx, retrying"
          );
          await sleep(SEARCH_API_BACKOFF_MS * (attempt + 1));
          continue;
        }
        log.warn({ status: response.status, attempt }, "searx request failed");
        throw new Error(`Search backend failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        results?: Array<{ title?: string; content?: string; url?: string }>;
      };

      const results = (payload.results ?? [])
        .filter((item) => typeof item.url === "string" && item.url.length > 0)
        .map((item) => ({
          title: item.title?.trim() || "Untitled result",
          description:
            item.content?.trim() || item.title?.trim() || "No description",
          url: item.url as string,
        }));

      log.debug(
        {
          query: truncate(query),
          count: results.length,
          attempt,
          elapsedMs: Date.now() - startedAt,
        },
        "searx response"
      );

      return results;
    } catch (error) {
      lastError = error;
      if (attempt < SEARCH_API_RETRIES) {
        log.debug(
          {
            attempt,
            elapsedMs: Date.now() - startedAt,
            err: error instanceof Error ? error.message : String(error),
          },
          "searx attempt error, retrying"
        );
        await sleep(SEARCH_API_BACKOFF_MS * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  log.warn(
    { query: truncate(query), attempts: SEARCH_API_RETRIES + 1 },
    "searx request exhausted retries"
  );
  throw lastError instanceof Error
    ? lastError
    : new Error("Search backend request failed");
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

  const searxResults = await performSearxSearch(
    safeQuery,
    safeSearch,
    resolvedRegion.resolved,
    opts
  );

  if (searxResults.length === 0) {
    log.debug({ query: truncate(safeQuery) }, "web search: no results");
    return `# Web Search Results
Query: ${safeQuery}
Region: ${resolvedRegion.resolved}
No results found.`;
  }

  const results: SearchResult[] = searxResults.slice(0, count);

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

  log.debug(
    {
      requested: queries.length,
      running: effective.length,
      truncated,
    },
    "batch web search"
  );

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
