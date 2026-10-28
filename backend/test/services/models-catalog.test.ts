import { describe, it, expect } from "vitest";
import {
  ModelsCatalog,
  toCatalogRow,
  CATALOG_TTL_MS,
  DECISION_MODELS,
} from "../../src/services/models-catalog.js";

/** Minimal OpenRouter `/models` entry. */
function raw(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Human ${id}`,
    context_length: 200000,
    pricing: { prompt: "0.000002", completion: "0.00001" },
    supported_parameters: ["tools"],
    ...extra,
  };
}

function okFetch(data: unknown[], calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) calls.n++;
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function failFetch(status = 500, calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) calls.n++;
    return new Response("nope", { status });
  }) as unknown as typeof fetch;
}

describe("toCatalogRow", () => {
  it("maps id/name/pricing and derives capability flags", () => {
    const row = toCatalogRow(
      raw("vendor/model-x", { supported_parameters: ["tools", "reasoning", "temperature"] }),
    );
    expect(row).toEqual({
      ref: "openrouter:vendor/model-x",
      id: "vendor/model-x",
      name: "Human vendor/model-x",
      contextLength: 200000,
      pricingIn: 2, // $0.000002/token → $2 per 1M
      pricingOut: 10,
      supportsTools: true,
      supportsReasoning: true,
    });
  });

  it("falls back to the id when the name is missing and tolerates junk fields", () => {
    const row = toCatalogRow({ id: "a/b", name: null, context_length: "x", pricing: null });
    expect(row).toMatchObject({
      ref: "openrouter:a/b",
      name: "a/b",
      contextLength: null,
      pricingIn: null,
      pricingOut: null,
      supportsTools: false,
      supportsReasoning: false,
    });
  });

  it("drops rows without an id or with a non-object shape", () => {
    expect(toCatalogRow({ name: "no id" })).toBeNull();
    expect(toCatalogRow(null)).toBeNull();
    expect(toCatalogRow("string")).toBeNull();
  });
});

describe("ModelsCatalog — OpenRouter", () => {
  it("trims, sorts by name and reports fresh", async () => {
    const calls = { n: 0 };
    const cat = new ModelsCatalog({
      fetchFn: okFetch([raw("b/two"), raw("a/one")], calls),
    });
    const res = await cat.getOpenRouterCatalog();
    expect(calls.n).toBe(1);
    expect(res.stale).toBe(false);
    expect(res.items.map((i) => i.id)).toEqual(["a/one", "b/two"]);
    // only the trimmed fields travel to the client
    expect(Object.keys(res.items[0]!).sort()).toEqual([
      "contextLength",
      "id",
      "name",
      "pricingIn",
      "pricingOut",
      "ref",
      "supportsReasoning",
      "supportsTools",
    ]);
  });

  it("serves the cache inside the TTL and refetches after it", async () => {
    const calls = { n: 0 };
    let now = 1_000_000;
    const cat = new ModelsCatalog({ fetchFn: okFetch([raw("a/one")], calls), now: () => now });

    await cat.getOpenRouterCatalog();
    now += CATALOG_TTL_MS - 1;
    await cat.getOpenRouterCatalog();
    expect(calls.n).toBe(1);

    now += 2;
    await cat.getOpenRouterCatalog();
    expect(calls.n).toBe(2);
  });

  it("collapses concurrent cold-cache refreshes into one request", async () => {
    const calls = { n: 0 };
    const cat = new ModelsCatalog({ fetchFn: okFetch([raw("a/one")], calls) });
    const [a, b] = await Promise.all([cat.getOpenRouterCatalog(), cat.getOpenRouterCatalog()]);
    expect(calls.n).toBe(1);
    expect(a.items).toBe(b.items);
  });

  it("keeps the last known list and flags it stale when a refresh fails", async () => {
    let failing = false;
    let now = 0;
    const calls = { n: 0 };
    const fetchFn = (async () => {
      calls.n++;
      if (failing) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ data: [raw("a/one")] }), { status: 200 });
    }) as unknown as typeof fetch;

    const cat = new ModelsCatalog({ fetchFn, now: () => now });
    const first = await cat.getOpenRouterCatalog();
    expect(first.items).toHaveLength(1);

    failing = true;
    now += CATALOG_TTL_MS + 1;
    const second = await cat.getOpenRouterCatalog();
    expect(second.stale).toBe(true);
    expect(second.items.map((i) => i.id)).toEqual(["a/one"]);
  });

  it("returns an empty stale list on a cold cache failure (never throws)", async () => {
    const cat = new ModelsCatalog({ fetchFn: failFetch(500) });
    await expect(cat.getOpenRouterCatalog()).resolves.toEqual({ items: [], stale: true });
    await expect(cat.hasOpenRouterCatalog()).resolves.toBe(false);
  });

  it("treats a network throw and an empty payload as failures", async () => {
    const throwing = new ModelsCatalog({
      fetchFn: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect(await throwing.getOpenRouterCatalog()).toEqual({ items: [], stale: true });

    const empty = new ModelsCatalog({ fetchFn: okFetch([]) });
    expect(await empty.getOpenRouterCatalog()).toEqual({ items: [], stale: true });
  });

  it("validates refs against the loaded catalog", async () => {
    const cat = new ModelsCatalog({ fetchFn: okFetch([raw("a/one")]) });
    expect(await cat.isKnownOpenRouterRef("openrouter:a/one")).toBe(true);
    expect(await cat.isKnownOpenRouterRef("a/one")).toBe(true);
    expect(await cat.isKnownOpenRouterRef("openrouter:a/two")).toBe(false);

    const offline = new ModelsCatalog({ fetchFn: failFetch(500) });
    expect(await offline.isKnownOpenRouterRef("openrouter:a/one")).toBeUndefined();
  });
});

describe("ModelsCatalog — decision list", () => {
  it("is static, offline and includes the default alias", () => {
    const cat = new ModelsCatalog({
      fetchFn: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    const res = cat.getDecisionCatalog();
    expect(res.stale).toBe(false);
    expect(res.items).toHaveLength(DECISION_MODELS.length);
    const def = res.items.find((i) => i.ref === "openrouter:~perplexity/pplx-decider-latest");
    expect(def?.aliased).toBe(true);
  });

  it("returns copies so a caller cannot mutate the curated list", () => {
    const cat = new ModelsCatalog({});
    const first = cat.getDecisionCatalog();
    first.items[0]!.name = "tampered";
    expect(cat.getDecisionCatalog().items[0]!.name).not.toBe("tampered");
  });
});
