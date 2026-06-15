/**
 * Shared types for the native web-search/scraping service.
 * Ported from the external MCP server, minus rate-limiting types.
 */

/** A single web-search result row. */
export interface SearchResult {
  title: string;
  description: string;
  url: string;
}

/** Outcome of resolving a user-supplied region/locale to a canonical one. */
export interface ResolvedRegion {
  /** The region as requested by the caller. */
  requested: string;
  /** The canonical region it resolved to. */
  resolved: string;
  /** Optional human-readable note (e.g. when an alias was applied). */
  note?: string;
}

/** On-disk cache envelope: payload plus an absolute expiry timestamp (ms epoch). */
export interface CacheEntry<T> {
  /** Absolute expiry time in ms since epoch; entry is stale once `Date.now() >= expiresAt`. */
  expiresAt: number;
  /** Cached payload. */
  data: T;
}
