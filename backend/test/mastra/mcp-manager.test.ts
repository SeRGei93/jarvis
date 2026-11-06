import { describe, it, expect, afterEach } from "vitest";
import type { MastraMCPServerDefinition } from "@mastra/mcp";
import {
  McpManager,
  type McpClientFactory,
  type McpClientLike,
  type McpClientFactoryOptions,
} from "../../src/mastra/mcp/manager.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { McpConfig } from "../../src/domain/mcp-config.js";

// ── fakes (no network: the real MCPClient is never constructed) ─────────────

interface Discovery {
  toolsets: Record<string, Record<string, unknown> | undefined>;
  errors: Record<string, string>;
  durations?: Record<string, number>;
}

const EMPTY: Discovery = { toolsets: {}, errors: {} };

class FakeClient implements McpClientLike {
  readonly id: string;
  readonly servers: Record<string, MastraMCPServerDefinition>;
  readonly timeout: number;
  disconnected = false;
  discoveryCalls = 0;

  constructor(
    opts: McpClientFactoryOptions,
    private readonly handler: (call: number) => Discovery | Promise<Discovery>,
  ) {
    this.id = opts.id;
    this.servers = opts.servers;
    this.timeout = opts.timeout;
  }

  async listToolsetsWithErrors(): Promise<Discovery> {
    this.discoveryCalls++;
    return this.handler(this.discoveryCalls);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

function makeFactory(handler: (call: number) => Discovery | Promise<Discovery> = () => EMPTY) {
  const clients: FakeClient[] = [];
  const factory: McpClientFactory = (opts) => {
    const client = new FakeClient(opts, handler);
    clients.push(client);
    return client;
  };
  return { factory, clients };
}

function fakeSettings(initial: McpConfig) {
  let current = initial;
  const svc = {
    getMcpServers: async () => current,
  } as unknown as SettingsService;
  return {
    svc,
    set(next: McpConfig) {
      current = next;
    },
  };
}

const oneTool = (server: string, tool: string): Discovery => ({
  toolsets: { [server]: { [tool]: { id: `${server}_${tool}`, description: `tool ${tool}` } } },
  errors: {},
});

let managers: McpManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.close();
  managers = [];
});

function makeManager(settings: SettingsService, factory: McpClientFactory) {
  const mcp = new McpManager({ settings, factory, disposeGraceMs: 0 });
  managers.push(mcp);
  return mcp;
}

describe("McpManager — config mapping", () => {
  it("maps a resolved server to the SDK definition", async () => {
    const settings = fakeSettings({
      mcpServers: {
        github: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer t" },
          timeoutMs: 12_000,
          allowedHosts: ["mcp.example.com"],
        },
      },
    });
    const { factory, clients } = makeFactory();
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(clients).toHaveLength(1);
    const def = clients[0]!.servers.github as Record<string, unknown>;
    expect(def.url).toBeInstanceOf(URL);
    expect(String(def.url)).toBe("https://mcp.example.com/mcp");
    expect(def.requestInit).toEqual({ headers: { Authorization: "Bearer t" } });
    expect(def.timeout).toBe(12_000);
    expect(def.connectTimeout).toBe(10_000);
    expect(def.enableServerLogs).toBe(false);
    expect(def.forwardInstructions).toBe(false);
    expect(def.allowedHosts).toEqual(["mcp.example.com"]);
    expect(clients[0]!.timeout).toBe(60_000);
  });

  it("preserves an explicitly empty allowedHosts list (deny every host)", async () => {
    const settings = fakeSettings({
      mcpServers: { s: { url: "https://a.dev/mcp", allowedHosts: [] } },
    });
    const { factory, clients } = makeFactory();
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect((clients[0]!.servers.s as Record<string, unknown>).allowedHosts).toEqual([]);
  });

  it("omits requestInit/allowedHosts when absent and connects only enabled servers", async () => {
    const settings = fakeSettings({
      mcpServers: {
        on: { url: "https://a.dev/mcp" },
        off: { url: "https://b.dev/mcp", enabled: false },
      },
    });
    const { factory, clients } = makeFactory();
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(Object.keys(clients[0]!.servers)).toEqual(["on"]);
    const def = clients[0]!.servers.on as Record<string, unknown>;
    expect(def.requestInit).toBeUndefined();
    expect(def.allowedHosts).toBeUndefined();
    expect(mcp.getStatus().servers).toEqual([
      { name: "on", enabled: true, connected: true, toolCount: 0, tools: [] },
      { name: "off", enabled: false, connected: false, toolCount: 0, tools: [] },
    ]);
  });
});

describe("McpManager — discovery", () => {
  it("namespaces tools as <server>_<tool>", async () => {
    const settings = fakeSettings({ mcpServers: { github: { url: "https://a.dev/mcp" } } });
    const { factory } = makeFactory(() => oneTool("github", "create_issue"));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(Object.keys(mcp.getTools())).toEqual(["github_create_issue"]);
    expect(mcp.getStatus().servers[0]).toMatchObject({
      connected: true,
      toolCount: 1,
      tools: ["github_create_issue"],
    });
  });

  it("skips tools that do not fit the model-facing name rules", async () => {
    const settings = fakeSettings({ mcpServers: { s: { url: "https://a.dev/mcp" } } });
    const { factory } = makeFactory(() => ({
      toolsets: {
        s: {
          "bad name": { id: "x" }, // space → skipped
          ["t".repeat(63)]: { id: "y" }, // 63 + "s_" = 65 → skipped
          good: { id: "z" },
        },
      },
      errors: {},
    }));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(Object.keys(mcp.getTools())).toEqual(["s_good"]);
    expect(mcp.getStatus().servers[0]!.toolCount).toBe(1);
  });

  it("keeps healthy servers when one fails", async () => {
    const settings = fakeSettings({
      mcpServers: { ok: { url: "https://a.dev/mcp" }, bad: { url: "https://b.dev/mcp" } },
    });
    const { factory } = makeFactory(() => ({
      toolsets: { ok: { ping: { id: "p" } } },
      errors: { bad: "connection refused" },
      durations: { ok: 12 },
    }));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(Object.keys(mcp.getTools())).toEqual(["ok_ping"]);
    const [ok, bad] = mcp.getStatus().servers;
    expect(ok).toMatchObject({ name: "ok", connected: true, toolCount: 1, durationMs: 12 });
    expect(bad).toMatchObject({ name: "bad", connected: false, toolCount: 0, error: "connection refused" });
  });

  it("degrades to an empty tool map when discovery throws (never serves stale tools)", async () => {
    const settings = fakeSettings({ mcpServers: { s: { url: "https://a.dev/mcp" } } });
    let calls = 0;
    const { factory } = makeFactory(() => {
      calls++;
      if (calls === 1) return oneTool("s", "first");
      throw new Error("boom");
    });
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });
    expect(Object.keys(mcp.getTools())).toEqual(["s_first"]);

    await mcp.refresh({ force: true });
    expect(mcp.getTools()).toEqual({});
    // A thrown discovery error is reported generically (its text may contain URLs).
    expect(mcp.getStatus().servers[0]).toMatchObject({ connected: false, error: "discovery failed" });
  });

  it("truncates long status errors", async () => {
    const settings = fakeSettings({ mcpServers: { s: { url: "https://a.dev/mcp" } } });
    const { factory } = makeFactory(() => ({ toolsets: {}, errors: { s: "x".repeat(2000) } }));
    const mcp = makeManager(settings.svc, factory);
    await mcp.refresh({ force: true });
    const error = mcp.getStatus().servers[0]!.error!;
    expect(error.length).toBeLessThanOrEqual(501);
    expect(error.endsWith("…")).toBe(true);
  });

  it("redacts the configured url from per-server error text", async () => {
    const settings = fakeSettings({
      mcpServers: { s: { url: "https://mcp.example.com/mcp?token=SUPERSECRET" } },
    });
    const { factory } = makeFactory(() => ({
      toolsets: {},
      errors: {
        s: "connect failed: https://mcp.example.com/mcp?token=SUPERSECRET",
      },
    }));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    const error = mcp.getStatus().servers[0]!.error!;
    expect(error).not.toContain("SUPERSECRET");
    expect(error).toContain("[redacted-url]");
  });

  it("reports an invalid URL (bad env expansion) as a per-server error", async () => {
    const settings = fakeSettings({ mcpServers: { s: { url: "https://${MCP_TEST_MISSING_HOST}/mcp" } } });
    const { factory, clients } = makeFactory();
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(clients).toHaveLength(0);
    expect(mcp.getStatus().servers[0]).toMatchObject({
      name: "s",
      connected: false,
      toolCount: 0,
      error: "invalid server url",
    });
  });

  it("handles an empty config without constructing a client", async () => {
    const settings = fakeSettings({ mcpServers: {} });
    const { factory, clients } = makeFactory();
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh({ force: true });

    expect(clients).toHaveLength(0);
    expect(mcp.getTools()).toEqual({});
    expect(mcp.getStatus()).toEqual({ ready: true, refreshing: false, servers: [] });
  });
});

describe("McpManager — lifecycle", () => {
  const config: McpConfig = { mcpServers: { s: { url: "https://a.dev/mcp" } } };

  it("skips discovery when the config is unchanged and force is not set", async () => {
    const settings = fakeSettings(config);
    const { factory, clients } = makeFactory(() => oneTool("s", "ping"));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh();
    await mcp.refresh();

    expect(clients).toHaveLength(1);
    expect(clients[0]!.discoveryCalls).toBe(1);
  });

  it("force-refresh re-discovers on the same client when the config is unchanged", async () => {
    const settings = fakeSettings(config);
    const { factory, clients } = makeFactory(() => oneTool("s", "ping"));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh();
    await mcp.refresh({ force: true });

    expect(clients).toHaveLength(1);
    expect(clients[0]!.discoveryCalls).toBe(2);
  });

  it("recreates the client (new generation id) when the config changes", async () => {
    const settings = fakeSettings(config);
    const { factory, clients } = makeFactory(() => oneTool("s", "ping"));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh();
    settings.set({ mcpServers: { s: { url: "https://b.dev/mcp" } } });
    await mcp.refresh();

    expect(clients.map((c) => c.id)).toEqual(["jarvis-admin-mcp-1", "jarvis-admin-mcp-2"]);
    expect(clients[0]!.disconnected).toBe(true);
    expect(clients[1]!.disconnected).toBe(false);
  });

  it("coalesces refresh requests arriving mid-pass into one follow-up", async () => {
    const settings = fakeSettings(config);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const began = new Promise<void>((r) => (started = r));

    const { factory, clients } = makeFactory(async (call) => {
      if (call === 1) {
        started();
        await gate;
      }
      return oneTool("s", "ping");
    });
    const mcp = makeManager(settings.svc, factory);

    const first = mcp.refresh({ force: true });
    await began;
    const second = mcp.refresh({ force: true });
    const third = mcp.refresh({ force: true });

    release();
    await Promise.all([first, second, third]);

    // 1 initial pass + exactly 1 coalesced follow-up (not one per caller).
    expect(clients[0]!.discoveryCalls).toBe(2);
  });

  it("close() disconnects the live client and makes later refreshes no-ops", async () => {
    const settings = fakeSettings(config);
    const { factory, clients } = makeFactory(() => oneTool("s", "ping"));
    const mcp = makeManager(settings.svc, factory);

    await mcp.refresh();
    await mcp.close();

    expect(clients[0]!.disconnected).toBe(true);
    expect(mcp.getTools()).toEqual({});
    expect(mcp.getStatus()).toMatchObject({ ready: false, refreshing: false, servers: [] });

    await mcp.refresh({ force: true });
    expect(clients[0]!.discoveryCalls).toBe(1);
  });
});

describe("McpManager — test()", () => {
  it("connects only enabled servers, namespaces tools and disconnects the ephemeral client", async () => {
    const { factory, clients } = makeFactory(() => ({
      toolsets: { on: { ping: { id: "p" } } },
      errors: {},
    }));
    const live = fakeSettings({ mcpServers: {} });
    const mcp = makeManager(live.svc, factory);

    const result = await mcp.test({
      mcpServers: {
        on: { url: "https://a.dev/mcp" },
        off: { url: "https://b.dev/mcp", enabled: false },
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      { name: "on", enabled: true, connected: true, toolCount: 1, tools: ["on_ping"] },
      { name: "off", enabled: false, connected: false, toolCount: 0, tools: [] },
    ]);
    // Live snapshot untouched; ephemeral client cleaned up.
    expect(mcp.getTools()).toEqual({});
    expect(clients).toHaveLength(1);
    expect(clients[0]!.id).toBe("jarvis-admin-mcp-test-1");
    expect(clients[0]!.disconnected).toBe(true);
  });

  it("returns env warnings without constructing a client when nothing is connectable", async () => {
    const { factory, clients } = makeFactory();
    const live = fakeSettings({ mcpServers: {} });
    const mcp = makeManager(live.svc, factory);

    const result = await mcp.test({
      mcpServers: { off: { url: "https://a.dev/mcp", enabled: false } },
    });

    expect(clients).toHaveLength(0);
    expect(result.servers[0]).toMatchObject({ name: "off", enabled: false });
  });
});
