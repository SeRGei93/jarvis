import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { mcpRoutes } from "../../src/admin/api/mcp.js";
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
  app.route("/", mcpRoutes());
  return { app, settings };
}

function json(body: unknown, method: string) {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("mcpRoutes", () => {
  it("GET / returns the seeded search server", async () => {
    const { app } = await makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json())).toEqual(["search"]);
  });

  it("PUT / updates the search server and reflects the change", async () => {
    const { app, settings } = await makeApp();
    const body = {
      search: { command: "npx", args: ["-y", "some-search-mcp"], env: { API_KEY: "x" } },
    };
    const res = await app.request("/", json(body, "PUT"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const after = await settings.getMcpServers();
    expect(after.search!.args).toEqual(["-y", "some-search-mcp"]);
  });

  it("PUT / accepts an empty object (clearing servers)", async () => {
    const { app, settings } = await makeApp();
    const res = await app.request("/", json({}, "PUT"));
    expect(res.status).toBe(200);
    expect(await settings.getMcpServers()).toEqual({});
  });

  it("PUT / rejects a non-search server name", async () => {
    const { app } = await makeApp();
    const res = await app.request(
      "/",
      json({ memory: { command: "npx", args: [] } }, "PUT"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("memory");
  });

  it("PUT / rejects a malformed server config", async () => {
    const { app } = await makeApp();
    const res = await app.request("/", json({ search: { command: "" } }, "PUT"));
    expect(res.status).toBe(400);
  });
});
