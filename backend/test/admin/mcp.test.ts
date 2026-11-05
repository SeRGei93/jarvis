import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { SettingKey } from "../../src/config/settings-keys.js";
import { mcpRoutes } from "../../src/admin/api/mcp.js";
import type { AdminEnv, AdminApiDeps } from "../../src/admin/api/deps.js";
import type { McpConfig } from "../../src/domain/mcp-config.js";
import type { McpManager, McpServerStatus } from "../../src/mastra/mcp/manager.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/**
 * Fake manager: `refresh` re-reads SettingsService (so the test proves
 * `invalidate()` ran) and `test` records the candidate config without writing.
 */
function fakeMcp(settings: SettingsService) {
  const calls = { refresh: [] as boolean[], test: [] as McpConfig[] };
  const state = {
    ready: true,
    refreshing: false,
    servers: [] as McpServerStatus[],
    warnings: [] as string[],
  };

  const manager = {
    getStatus: () => ({ ready: state.ready, refreshing: state.refreshing, servers: state.servers }),
    refresh: async (opts?: { force?: boolean }) => {
      calls.refresh.push(opts?.force === true);
      const cfg = await settings.getMcpServers();
      state.servers = Object.entries(cfg.mcpServers).map(([name, s]) => ({
        name,
        enabled: s.enabled !== false,
        connected: true,
        toolCount: 1,
        tools: [`${name}_ping`],
      }));
    },
    test: async (config: McpConfig) => {
      calls.test.push(config);
      return {
        servers: Object.entries(config.mcpServers).map(([name]) => ({
          name,
          enabled: true,
          connected: true,
          toolCount: 1,
          tools: [`${name}_ping`],
        })),
        warnings: state.warnings,
      };
    },
  } as unknown as McpManager;

  return { manager, calls, state };
}

async function makeApp() {
  t = await createTestDb();
  await runSeed(t.db);
  const settings = new SettingsService(t.db);
  const { manager, calls, state } = fakeMcp(settings);
  const deps = { db: t.db, settings, mcp: manager } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", mcpRoutes());
  return { app, settings, calls, state };
}

function get(app: Hono<AdminEnv>, path: string) {
  return app.request(path);
}
function send(app: Hono<AdminEnv>, method: string, path: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validConfig = {
  mcpServers: {
    github: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
  },
};

describe("mcpRoutes — GET", () => {
  it("returns the default empty config and status", async () => {
    const { app } = await makeApp();
    const res = await get(app, "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: { mcpServers: {} },
      ready: true,
      refreshing: false,
      status: [],
    });
  });
});

describe("mcpRoutes — PUT", () => {
  it("stores the config, invalidates the cache and force-refreshes", async () => {
    const { app, settings, calls } = await makeApp();

    const res = await send(app, "PUT", "/", validConfig);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.config).toEqual(validConfig);
    expect(body.status).toEqual([
      { name: "github", enabled: true, connected: true, toolCount: 1, tools: ["github_ping"] },
    ]);
    expect(body.warnings).toEqual([]);

    // Persisted + visible through the (invalidated) SettingsService cache.
    expect(await settings.getMcpServers()).toEqual(validConfig);
    // Force refresh was requested exactly once (the fake re-reads settings above).
    expect(calls.refresh).toEqual([true]);
  });

  it("rejects a stdio server with a 400 and writes nothing", async () => {
    const { app, settings, calls } = await makeApp();

    const res = await send(app, "PUT", "/", {
      mcpServers: { local: { command: "npx", args: ["-y", "srv"] } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("stdio is not supported");

    expect((await settings.getMcpServers()).mcpServers).toEqual({});
    expect(calls.refresh).toEqual([]);
  });

  it("returns env-expansion warnings for missing ${VAR}", async () => {
    const { app } = await makeApp();
    const res = await send(app, "PUT", "/", {
      mcpServers: { gh: { url: "https://mcp.example.com/mcp", headers: { Authorization: "${MCP_TEST_TOKEN}" } } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain("MCP_TEST_TOKEN");
  });

  it("never echoes secrets from an invalid entry", async () => {
    const { app } = await makeApp();
    const res = await send(app, "PUT", "/", {
      mcpServers: {
        bad_name: { url: "https://x.dev/mcp", headers: { Authorization: "Bearer SUPERSECRET" } },
      },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("SUPERSECRET");
  });
});

describe("mcpRoutes — POST /test", () => {
  it("probes a candidate config without persisting it", async () => {
    const { app, settings, calls } = await makeApp();

    const res = await send(app, "POST", "/test", validConfig);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toEqual([
      { name: "github", enabled: true, connected: true, toolCount: 1, tools: ["github_ping"] },
    ]);
    expect(body.warnings).toEqual([]);
    expect(calls.test).toEqual([validConfig]);
    // No DB write, no refresh.
    expect(await settings.getMcpServers()).toEqual({ mcpServers: {} });
    expect(calls.refresh).toEqual([]);
  });

  it("returns 400 on a schema error", async () => {
    const { app, calls } = await makeApp();
    const res = await send(app, "POST", "/test", { mcpServers: { s: { url: "not a url" } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("server \"s\"");
    expect(calls.test).toEqual([]);
  });
});

describe("mcpRoutes — POST /refresh", () => {
  it("force-refreshes the saved config and returns its status", async () => {
    const { app, calls } = await makeApp();
    await send(app, "PUT", "/", validConfig);
    calls.refresh.length = 0;

    const res = await send(app, "POST", "/refresh", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ready: true, refreshing: false });
    expect(body.status[0].name).toBe("github");
    expect(calls.refresh).toEqual([true]);
  });
});

describe("mcpRoutes — setting key", () => {
  it("uses the mcp_servers settings key", async () => {
    expect(SettingKey.McpServers).toBe("mcp_servers");
  });
});
