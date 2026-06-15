/**
 * File-backed cache for fetched page markdown, keyed by URL.
 * No background cleanup timer — expiry is lazy (see cache.ts).
 */
import { CACHE_DIR, CACHE_TTL } from "./config.js";
import { createCache } from "./cache.js";

const cache = createCache<string>({
  dir: CACHE_DIR.fetch,
  ttlMs: CACHE_TTL.fetch,
});

/** Reads cached markdown for `url`, or null if missing/expired. */
export const readFetchCache = (url: string): Promise<string | null> => cache.read(url);

/** Caches `markdown` for `url` (best-effort). */
export const writeFetchCache = (url: string, markdown: string): Promise<void> =>
  cache.write(url, markdown);

/** Manually purges expired fetch-cache entries (no timer). Returns count deleted. */
export const cleanExpiredFetchCache = (): Promise<number> => cache.cleanup();
