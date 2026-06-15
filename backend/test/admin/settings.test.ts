import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { settingsRoutes } from "../../src/admin/api/settings.js";
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
  app.route("/", settingsRoutes());
  return { app, settings };
}

describe("settingsRoutes — timeouts", () => {
  it("GET returns seeded timeouts", async () => {
    const { app } = await makeApp();
    const res = await app.request("/timeouts");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      llm_request: "300s",
      http_client: "300s",
      llm_activity: "30s",
    });
  });

  it("PUT updates and a later read reflects the change (invalidate works)", async () => {
    const { app, settings } = await makeApp();
    const body = { llm_request: "120s", http_client: "180s", llm_activity: "15s" };
    const res = await app.request("/timeouts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: body });

    // Service cache reflects the change (proves invalidate()).
    expect(await settings.getTimeouts()).toEqual(body);

    // And so does a subsequent GET.
    const after = await app.request("/timeouts");
    expect(await after.json()).toEqual(body);
  });

  it("PUT rejects an invalid Go-duration string", async () => {
    const { app } = await makeApp();
    const res = await app.request("/timeouts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm_request: "soon", http_client: "300s", llm_activity: "30s" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("llm_request");
  });

  it("PUT rejects a missing field", async () => {
    const { app } = await makeApp();
    const res = await app.request("/timeouts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm_request: "300s" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("settingsRoutes — agent", () => {
  it("GET returns seeded agent config", async () => {
    const { app } = await makeApp();
    const res = await app.request("/agent");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      max_history: 15,
      default_temperature: 0.4,
    });
  });

  it("PUT updates and a later read reflects the change", async () => {
    const { app, settings } = await makeApp();
    const body = { max_history: 20, default_temperature: 0.7 };
    const res = await app.request("/agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await settings.getAgent()).toEqual(body);
  });

  it("PUT rejects out-of-range temperature", async () => {
    const { app } = await makeApp();
    const res = await app.request("/agent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_history: 10, default_temperature: 5 }),
    });
    expect(res.status).toBe(400);
  });
});
