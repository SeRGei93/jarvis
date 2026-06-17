import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { modelsRoutes } from "../../src/admin/api/models.js";
import type { AdminEnv, AdminApiDeps } from "../../src/admin/api/deps.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function makeApp() {
  t = await createTestDb();
  await runSeed(t.db);
  const settings = new SettingsService(t.db);
  const deps = { db: t.db, settings } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", modelsRoutes());
  return { app, settings };
}

function json(body: unknown, method: string) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("modelsRoutes — CRUD", () => {
  it("GET / lists the seeded models", async () => {
    const { app } = await makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { ref: string }[];
    expect(rows.length).toBe(11);
  });

  it("POST / creates a model and invalidates the cache", async () => {
    const { app, settings } = await makeApp();
    const res = await app.request(
      "/",
      json({ ref: "openrouter:test/new-model", label: "New" }, "POST"),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean;
      value: { id: number; ref: string; provider: string };
    };
    expect(out.ok).toBe(true);
    expect(out.value.ref).toBe("openrouter:test/new-model");
    // provider is derived from the ref prefix, not supplied by the client.
    expect(out.value.provider).toBe("openrouter");

    const list = await settings.getModels();
    expect(list.some((m) => m.ref === "openrouter:test/new-model")).toBe(true);
  });

  it("POST / rejects a duplicate ref with 400", async () => {
    const { app } = await makeApp();
    const res = await app.request(
      "/",
      json({ ref: "zai:glm-5", label: "GLM" }, "POST"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already exists");
  });

  it("POST / rejects missing ref", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", json({ label: "X" }, "POST"));
    expect(res.status).toBe(400);
  });

  it("POST / rejects a missing/empty label", async () => {
    const { app } = await makeApp();
    const missing = await app.request("/", json({ ref: "openrouter:test/no-label" }, "POST"));
    expect(missing.status).toBe(400);
    const empty = await app.request(
      "/",
      json({ ref: "openrouter:test/blank-label", label: "   " }, "POST"),
    );
    expect(empty.status).toBe(400);
  });

  it("PATCH /:id updates fields", async () => {
    const { app, settings } = await makeApp();
    const all = await settings.getModels();
    const id = all[0]!.id;
    const res = await app.request(`/${id}`, json({ enabled: false, label: "Disabled" }, "PATCH"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { value: { enabled: boolean; label: string } };
    expect(out.value.enabled).toBe(false);
    expect(out.value.label).toBe("Disabled");

    const after = (await settings.getModels()).find((m) => m.id === id)!;
    expect(after.enabled).toBe(false);
  });

  it("PATCH /:id 404s on a missing id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/999999", json({ enabled: false }, "PATCH"));
    expect(res.status).toBe(404);
  });

  it("PATCH /:id rejects an empty patch", async () => {
    const { app } = await makeApp();
    const res = await app.request("/1", json({}, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("DELETE /:id removes the row", async () => {
    const { app, settings } = await makeApp();
    const all = await settings.getModels();
    const id = all[0]!.id;
    const res = await app.request(`/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = await settings.getModels();
    expect(after.some((m) => m.id === id)).toBe(false);
  });

  it("DELETE /:id 404s on a missing id", async () => {
    const { app } = await makeApp();
    const res = await app.request("/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("modelsRoutes — roles", () => {
  it("GET /roles returns the seeded roles", async () => {
    const { app } = await makeApp();
    const res = await app.request("/roles");
    expect(res.status).toBe(200);
    const roles = (await res.json()) as { default: string };
    expect(roles.default).toBe("openrouter:google/gemini-3.1-flash-lite");
  });

  it("PUT /roles accepts valid enabled refs and reflects the change", async () => {
    const { app, settings } = await makeApp();
    const body = {
      default: "zai:glm-5",
      router: "openrouter:openai/gpt-oss-120b:nitro",
      embedding: "",
      error_correction: "openrouter:google/gemini-3-flash-preview",
      speech: "",
      synthesizer: "",
    };
    const res = await app.request("/roles", json(body, "PUT"));
    expect(res.status).toBe(200);
    expect((await settings.getModelRoles()).default).toBe("zai:glm-5");
  });

  it("PUT /roles rejects an unknown ref", async () => {
    const { app } = await makeApp();
    const res = await app.request("/roles", json({ default: "openrouter:does/not-exist" }, "PUT"));
    expect(res.status).toBe(400);
    const out = (await res.json()) as { error: string; refs: string[] };
    expect(out.refs).toContain("openrouter:does/not-exist");
  });

  it("PUT /roles rejects a disabled ref", async () => {
    const { app, settings } = await makeApp();
    // Disable a model, then try to assign it to a role.
    const all = await settings.getModels();
    const target = all.find((m) => m.ref === "zai:glm-5")!;
    const dis = await app.request(`/${target.id}`, json({ enabled: false }, "PATCH"));
    expect(dis.status).toBe(200);

    const res = await app.request("/roles", json({ default: "zai:glm-5" }, "PUT"));
    expect(res.status).toBe(400);
    expect((await res.json()).refs).toContain("zai:glm-5");
  });
});
