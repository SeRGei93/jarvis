import { apiGet } from "./api.js";
import type { CatalogResponse, CatalogRow } from "./types.js";

/**
 * Model catalog loading with a per-session cache.
 *
 * The OpenRouter catalog is ~100 KB for ~460 models, so it is fetched once per
 * screen visit and reused from `sessionStorage` for 6 hours (the backend caches
 * the same window, so both layers agree). Search itself is client-side — no
 * request per keystroke.
 */

export type CatalogProvider = "openrouter" | "decision";

const TTL_MS = 6 * 60 * 60 * 1000;
const key = (provider: CatalogProvider) => `jarvis.catalog.${provider}`;

interface Cached {
  at: number;
  items: CatalogRow[];
  stale: boolean;
}

function readCache(provider: CatalogProvider): Cached | null {
  try {
    const raw = sessionStorage.getItem(key(provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (!Array.isArray(parsed.items) || Date.now() - parsed.at > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Fetch (or reuse) a catalog. `force` bypasses the session cache. */
export async function loadCatalog(
  provider: CatalogProvider,
  force = false,
): Promise<CatalogResponse> {
  if (!force) {
    const cached = readCache(provider);
    if (cached) return { items: cached.items, stale: cached.stale };
  }
  const res = await apiGet<CatalogResponse>(`/models/catalog?provider=${provider}`);
  try {
    const payload: Cached = { at: Date.now(), items: res.items, stale: res.stale };
    sessionStorage.setItem(key(provider), JSON.stringify(payload));
  } catch {
    /* quota/private mode — the in-memory state still works */
  }
  return res;
}

/** Case-insensitive substring match over the model title (the plan's search rule). */
export function searchCatalog(items: CatalogRow[], query: string): CatalogRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.name.toLowerCase().includes(q));
}

/** "128K контекст · $1.00 / $5.00 за 1M" — the second line of a catalog option. */
export function catalogSubtitle(row: CatalogRow): string {
  const parts: string[] = [];
  if (row.contextLength) {
    parts.push(`${Math.round(row.contextLength / 1000)}K контекст`);
  }
  if (row.pricingIn !== null || row.pricingOut !== null) {
    const fmt = (v: number | null) => (v === null ? "?" : `$${v.toFixed(v < 1 ? 3 : 2)}`);
    parts.push(`${fmt(row.pricingIn)} / ${fmt(row.pricingOut)} за 1M`);
  }
  return parts.join(" · ");
}
