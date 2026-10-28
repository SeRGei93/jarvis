/**
 * Model catalogs for the admin Mini App.
 *
 * The `models` registry table is gone: a role is a free-form `provider:model`
 * ref, and the UI picks OpenRouter refs from OpenRouter's **live public catalog**
 * (`GET https://openrouter.ai/api/v1/models`, no auth) instead of a hand-kept
 * list. The payload is trimmed to a handful of fields (~100 KB for ~464 models)
 * and shipped whole; the Mini App filters by name on the client, so there is no
 * server-side search and no request per keystroke.
 *
 * Decision (System One) models are NOT part of the general catalog — OpenRouter
 * only routes them through `POST /api/v1/systemone` — so they come from a small
 * curated list below. It is static and works offline.
 *
 * Failures never throw: an unreachable catalog returns the last known list with
 * `stale: true` (or an empty list on a cold cache) so the admin can always fall
 * back to typing a ref by hand.
 */
import { logger } from "../pkg/logger.js";
import { timeoutFetch } from "../pkg/timeout-fetch.js";

const log = logger.child({ mod: "models-catalog" });

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** How long a fetched catalog is trusted before the next request refreshes it. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 15_000;

/** One selectable model in the admin UI. */
export interface CatalogRow {
  /** Full `provider:model` ref written into a role (always `openrouter:<id>` here). */
  ref: string;
  /** Provider-side model id (what OpenRouter expects on the wire). */
  id: string;
  /** Human title used for the client-side substring search. */
  name: string;
  contextLength: number | null;
  /** USD per 1M input tokens (OpenRouter quotes per-token strings). */
  pricingIn: number | null;
  /** USD per 1M output tokens. */
  pricingOut: number | null;
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** Curated decision list only: the id is an alias that tracks the current release. */
  aliased?: boolean;
  /** Curated decision list only: UI hint (region limits, cost, purpose). */
  note?: string;
}

export interface CatalogResponse {
  items: CatalogRow[];
  /** `true` when these items are the last known list after a failed refresh. */
  stale: boolean;
}

/**
 * Curated decision-model list (System One endpoints via OpenRouter).
 * Verified live on 2026-10-28:
 *  - `~perplexity/pplx-decider-latest` → resolves to `pplx-decider-v1.2-*`;
 *  - `perplexity/pplx-decider-v1.2`, `cloudflare/clef`, `cloudflare/clef-flash` answer;
 *  - Typesafe/Jev ids answer `451 Typesafe is not available in your region` from
 *    Belarus — kept because they work from other regions, never used as default;
 *  - `perplexity/pplx-decider-v1-27b` / `-v1.1-27b` → 404 (no endpoints), dropped.
 */
export const DECISION_MODELS: readonly CatalogRow[] = [
  {
    ref: "openrouter:~perplexity/pplx-decider-latest",
    id: "~perplexity/pplx-decider-latest",
    name: "Perplexity Decider (latest alias)",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    aliased: true,
    note: "Алиас: трекает актуальный релиз pplx-decider (~$0.03/1M входных). Дефолт.",
  },
  {
    ref: "openrouter:perplexity/pplx-decider-v1.2",
    id: "perplexity/pplx-decider-v1.2",
    name: "Perplexity Decider v1.2",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    note: "Пиннутая версия — калибровка не сместится при релизе.",
  },
  {
    ref: "openrouter:cloudflare/clef-flash",
    id: "cloudflare/clef-flash",
    name: "Cloudflare Clef Flash",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    note: "Самая дешёвая (~$0.005/1M входных), быстрая.",
  },
  {
    ref: "openrouter:cloudflare/clef",
    id: "cloudflare/clef",
    name: "Cloudflare Clef",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    note: "Полная версия Clef — точнее flash, дороже (~$0.05/1M входных).",
  },
  {
    ref: "openrouter:~typesafe/jev-latest",
    id: "~typesafe/jev-latest",
    name: "Typesafe Jev (latest alias)",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    aliased: true,
    note: "Недоступна из Беларуси (HTTP 451) — только при деплое в другом регионе.",
  },
  {
    ref: "openrouter:typesafe/jev-1.14",
    id: "typesafe/jev-1.14",
    name: "Typesafe Jev 1.14",
    contextLength: null,
    pricingIn: null,
    pricingOut: null,
    supportsTools: false,
    supportsReasoning: false,
    note: "Пиннутая версия Jev — недоступна из Беларуси (HTTP 451).",
  },
];

/** Shapes we read from the OpenRouter payload (everything else is dropped). */
interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
  supported_parameters?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** OpenRouter prices are USD per token; the UI reads per-1M, which is human-sized. */
function perMillion(v: unknown): number | null {
  const perToken = asNumber(v);
  if (perToken === null) return null;
  return Number((perToken * 1_000_000).toPrecision(6));
}

function hasParam(model: OpenRouterModel, param: string): boolean {
  return Array.isArray(model.supported_parameters) && model.supported_parameters.includes(param);
}

/** Trim one OpenRouter entry; `null` for malformed rows (no id). */
export function toCatalogRow(raw: unknown): CatalogRow | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as OpenRouterModel;
  const id = asString(m.id);
  if (!id) return null;
  return {
    ref: `openrouter:${id}`,
    id,
    name: asString(m.name) ?? id,
    contextLength: asNumber(m.context_length),
    pricingIn: perMillion(m.pricing?.prompt),
    pricingOut: perMillion(m.pricing?.completion),
    supportsTools: hasParam(m, "tools"),
    supportsReasoning: hasParam(m, "reasoning"),
  };
}

export interface ModelsCatalogDeps {
  /** Injected for tests (no network). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  url?: string;
}

/**
 * OpenRouter catalog with an in-memory TTL cache (6h). One instance lives on the
 * chat deps bundle so the admin API and role validation share the same list.
 */
export class ModelsCatalog {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly url: string;

  private cached: CatalogRow[] | null = null;
  private fetchedAt = 0;
  private inflight: Promise<CatalogResponse> | null = null;

  constructor(deps: ModelsCatalogDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? CATALOG_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? CATALOG_TIMEOUT_MS;
    this.url = deps.url ?? OPENROUTER_MODELS_URL;
  }

  /** Curated System One models — static, always available, no network. */
  getDecisionCatalog(): CatalogResponse {
    return { items: DECISION_MODELS.map((m) => ({ ...m })), stale: false };
  }

  /**
   * Full trimmed OpenRouter catalog. Concurrent callers share one refresh.
   * Never throws: a failed refresh serves the previous list with `stale: true`.
   */
  async getOpenRouterCatalog(): Promise<CatalogResponse> {
    if (this.cached && this.now() - this.fetchedAt < this.ttlMs) {
      return { items: this.cached, stale: false };
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** True when `ref` (or bare id) is a known OpenRouter model. Unfetched catalog → `undefined`. */
  async isKnownOpenRouterRef(ref: string): Promise<boolean | undefined> {
    const { items } = await this.getOpenRouterCatalog();
    if (items.length === 0) return undefined;
    const id = ref.startsWith("openrouter:") ? ref.slice("openrouter:".length) : ref;
    return items.some((m) => m.id === id);
  }

  /** Whether a usable OpenRouter list is cached (false = cold cache after a failed fetch). */
  async hasOpenRouterCatalog(): Promise<boolean> {
    const { items } = await this.getOpenRouterCatalog();
    return items.length > 0;
  }

  private async refresh(): Promise<CatalogResponse> {
    const started = this.now();
    try {
      const res = await timeoutFetch(this.timeoutMs, this.fetchFn)(this.url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        log.warn({ status: res.status }, "OpenRouter catalog request failed");
        return this.fallback();
      }
      const body = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(body?.data) ? body.data : [];
      const items = raw
        .map(toCatalogRow)
        .filter((r): r is CatalogRow => r !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (items.length === 0) {
        log.warn("OpenRouter catalog returned no usable models");
        return this.fallback();
      }
      this.cached = items;
      this.fetchedAt = this.now();
      log.info({ models: items.length, ms: this.now() - started }, "OpenRouter catalog refreshed");
      return { items, stale: false };
    } catch (err) {
      log.warn({ err }, "OpenRouter catalog unavailable");
      return this.fallback();
    }
  }

  private fallback(): CatalogResponse {
    return { items: this.cached ?? [], stale: true };
  }
}

/** Process-wide instance (shared by the admin API and role validation). */
export const modelsCatalog = new ModelsCatalog();
