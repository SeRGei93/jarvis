import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { loadMcpTools, type McpClientLike } from "../../src/mastra/mcp.js";
import type { SettingsService } from "../../src/config/settings.js";

function fakeSettings(servers: Record<string, unknown>): SettingsService {
  return {
    getMcpServers: async () => servers,
    getTimeouts: async () => ({ llm_request: "300s", http_client: "300s", llm_activity: "30s" }),
  } as unknown as SettingsService;
}

const SEARCH = { search: { command: "npx", args: ["-y", "mcp-remote", "http://x/mcp"] } };

describe("loadMcpTools", () => {
  it("adapts Mastra MCP tools to AI-SDK tools keyed by bare name", async () => {
    const exec = vi.fn(async ({ context }: { context: unknown }) => ({ echo: context }));
    const client: McpClientLike = {
      listToolsetsWithErrors: async () => ({
        toolsets: {
          search: {
            web_search: { description: "search the web", inputSchema: z.object({ q: z.string() }), execute: exec },
          },
        },
        errors: {},
      }),
      disconnect: async () => {},
    };

    const { tools } = await loadMcpTools(fakeSettings(SEARCH), () => client);

    expect(Object.keys(tools)).toEqual(["web_search"]); // bare, not namespaced search_web_search
    // The adapter must translate AI-SDK execute(args) → Mastra execute({ context: args }).
    const out = await tools.web_search!.execute!({ q: "hello" }, {} as never);
    expect(out).toEqual({ echo: { q: "hello" } });
    expect(exec).toHaveBeenCalledWith({ context: { q: "hello" } });
  });

  it("degrades gracefully when a server errors (empty set, no throw)", async () => {
    const client: McpClientLike = {
      listToolsetsWithErrors: async () => ({ toolsets: {}, errors: { search: "connection refused" } }),
      disconnect: async () => {},
    };
    const { tools, client: live } = await loadMcpTools(fakeSettings(SEARCH), () => client);
    expect(tools).toEqual({});
    expect(live).not.toBeNull(); // listing succeeded (just no tools), client stays for shutdown
  });

  it("disables MCP when no servers are configured", async () => {
    const { tools, client } = await loadMcpTools(fakeSettings({}), () => {
      throw new Error("factory must not be called");
    });
    expect(tools).toEqual({});
    expect(client).toBeNull();
  });

  it("survives a listToolsets failure and disconnects", async () => {
    const disconnect = vi.fn(async () => {});
    const client: McpClientLike = {
      listToolsetsWithErrors: async () => {
        throw new Error("boom");
      },
      disconnect,
    };
    const { tools, client: live } = await loadMcpTools(fakeSettings(SEARCH), () => client);
    expect(tools).toEqual({});
    expect(live).toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });
});
