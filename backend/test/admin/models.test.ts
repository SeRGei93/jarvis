import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { modelsRoutes } from "../../src/admin/api/models.js";
import { ModelsCatalog } from "../../src/services/models-catalog.js";
import type { AdminEnv, AdminApiDeps } from "../../src/admin/api/deps.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** OpenRouter `/models` payload stub — no network in these tests. */
function openRouterPayload(ids: string[]) {
  return {
    data: ids.map((id) => ({
      id,
      name: `Model ${id}`,
      context_length: 128000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools", "reasoning"],
    })),
  };
}

function catalogFetch(ids: string[] = ["openai/gpt-oss-120b", "google/gemini-3-flash-preview"]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(openRouterPayload(ids)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

async function makeApp(opts: { fetchFn?: typeof fetch } = {}) {
  t = await createTestDb();
  await runSeed(t.db);
  const settings = new SettingsService(t.db);
  const modelsCatalog = new ModelsCatalog({ fetchFn: opts.fetchFn ?? catalogFetch() });
  const deps = { db: t.db, settings, modelsCatalog } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", modelsRoutes());
  return { app, settings, modelsCatalog };
}

function json(body: unknown, method: string) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("modelsRoutes — catalog", () => {
  it("GET /catalog returns the trimmed OpenRouter catalog", async () => {
    const { app } = await makeApp();
    const res = await app.request("/catalog");
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      items: { ref: string; id: string; name: string; supportsTools: boolean }[];
      stale: boolean;
    };
    expect(out.stale).toBe(false);
    expect(out.items.map((i) => i.ref)).toEqual([
      "openrouter:google/gemini-3-flash-preview",
      "openrouter:openai/gpt-oss-120b",
    ]);
    expect(out.items[0]!.supportsTools).toBe(true);
  });

  it("GET /catalog?provider=decision returns the curated list offline", async () => {
    const { app } = await makeApp({ fetchFn: failingFetch() });
    const res = await app.request("/catalog?provider=decision");
    expect(res.status).toBe(200);
    const out = (await res.json()) as { items: { ref: string }[]; stale: boolean };
    expect(out.stale).toBe(false);
    expect(out.items.some((i) => i.ref === "openrouter:~perplexity/pplx-decider-latest")).toBe(true);
  });

  it("GET /catalog rejects an unknown provider", async () => {
    const { app } = await makeApp();
    const res = await app.request("/catalog?provider=anthropic");
    expect(res.status).toBe(400);
  });

  it("GET / (legacy) serves the OpenRouter catalog", async () => {
    const { app } = await makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const out = (await res.json()) as { items: unknown[] };
    expect(out.items.length).toBe(2);
  });

  it("GET /catalog reports stale + empty when the catalog is unreachable", async () => {
    const { app } = await makeApp({ fetchFn: failingFetch() });
    const res = await app.request("/catalog");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], stale: true });
  });
});

describe("modelsRoutes — roles", () => {
  it("GET /roles returns the seeded roles", async () => {
    const { app } = await makeApp();
    const res = await app.request("/roles");
    expect(res.status).toBe(200);
    const roles = (await res.json()) as { default: string; decision: string };
    expect(roles.default).toBe("openrouter:deepseek/deepseek-v4.1-flash");
    expect(roles.decision).toBe("openrouter:~perplexity/pplx-decider-latest");
  });

  it("PUT /roles accepts free-form refs and normalises every slot", async () => {
    const { app, settings } = await makeApp();
    const body = {
      default: "openrouter:openai/gpt-oss-120b",
      router: "openrouter:openai/gpt-oss-120b:nitro", // routing suffix, not in catalog
      error_correction: "zai:glm-5", // non-OpenRouter provider: format check only
      speech: "",
      decision: "openrouter:cloudflare/clef-flash",
    };
    const res = await app.request("/roles", json(body, "PUT"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; value: Record<string, string>; warnings: string[] };
    expect(out.ok).toBe(true);
    expect(out.value.synthesizer).toBe("");
    expect(out.warnings).toHaveLength(1); // the :nitro suffix
    expect(out.warnings[0]).toContain("nitro");

    const stored = await settings.getModelRoles();
    expect(stored.decision).toBe("openrouter:cloudflare/clef-flash");
  });

  it("PUT /roles rejects an unknown decision model", async () => {
    const { app } = await makeApp();
    const res = await app.request(
      "/roles",
      json({ decision: "openrouter:typesafe/not-a-decision-model" }, "PUT"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("unknown decision model");
  });

  it("PUT /roles rejects a malformed ref but accepts a bare model id", async () => {
    const { app } = await makeApp();
    const bad = await app.request("/roles", json({ default: "openrouter:" }, "PUT"));
    expect(bad.status).toBe(400);

    const spaces = await app.request("/roles", json({ default: "deepseek v4" }, "PUT"));
    expect(spaces.status).toBe(400);

    const bare = await app.request("/roles", json({ default: "deepseek/deepseek-v4.1-flash" }, "PUT"));
    expect(bare.status).toBe(200);
  });

  it("PUT /roles accepts an unknown OpenRouter ref with a warning", async () => {
    const { app } = await makeApp();
    const res = await app.request("/roles", json({ default: "openrouter:does/not-exist" }, "PUT"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { warnings: string[] };
    expect(out.warnings.join(" ")).toContain("does/not-exist");
  });

  it("PUT /roles does not block when the catalog is unreachable", async () => {
    const { app } = await makeApp({ fetchFn: failingFetch() });
    const res = await app.request("/roles", json({ default: "openrouter:does/not-exist" }, "PUT"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { warnings: string[] }).warnings).toHaveLength(0);
  });
});
