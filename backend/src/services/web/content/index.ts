/**
 * Content-provider registry/factory.
 *
 * Add a vendor by implementing {@link ContentProvider} and registering a factory
 * below; tools stay untouched. `CONTENT_PROVIDER` selects one, `none` disables
 * external page fetching (the local HTTP/cleanup path remains as a fallback).
 */
import { env as defaultEnv, type Env } from "../../../config/env.js";
import { webChild } from "../logger.js";
import { FirecrawlProvider } from "./firecrawl.js";
import type { ContentProvider } from "./types.js";

const log = webChild("content");

export type ContentProviderFactory = (
  config: Env,
  fetchFn: typeof globalThis.fetch,
) => ContentProvider | undefined;

/** Provider id → factory. Add new vendors here only. */
const FACTORIES: Record<string, ContentProviderFactory> = {
  firecrawl: (config, fetchFn) => {
    if (!config.FIRECRAWL_API_KEY) return undefined;
    return new FirecrawlProvider({
      apiKey: config.FIRECRAWL_API_KEY,
      baseUrl: config.FIRECRAWL_API_URL,
      fetchFn,
    });
  },
};

/**
 * Build the configured content provider, or `undefined` when disabled/not configured.
 * Unknown names are treated as disabled (local fallback) with a warning.
 */
export function createContentProvider(
  config: Env = defaultEnv,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ContentProvider | undefined {
  const name = (config.CONTENT_PROVIDER ?? "firecrawl").trim().toLowerCase();
  if (!name || name === "none" || name === "off" || name === "local") return undefined;

  const factory = FACTORIES[name];
  if (!factory) {
    log.warn({ provider: name, known: Object.keys(FACTORIES) }, "unknown content provider; using local fallback");
    return undefined;
  }

  const provider = factory(config, fetchFn);
  if (!provider?.configured) {
    log.debug({ provider: name }, "content provider selected but not configured; using local fallback");
    return undefined;
  }

  log.debug({ provider: provider.name }, "content provider ready");
  return provider;
}

export * from "./types.js";
export { FirecrawlProvider } from "./firecrawl.js";
