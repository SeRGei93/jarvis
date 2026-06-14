import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { resolveTools, type ToolContext } from "../../src/mastra/tools/registry.js";
import type { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../../src/db/schema.js";

// buildMemoryTools only closes over mem/userId (no calls at build time), and the
// built-in buckets are not exercised here, so bare stubs are enough. We focus on the
// merge logic: memory bucket, MCP bucket, and unknown-name skipping.
const mcpTools = {
  web_search: tool({ description: "x", inputSchema: z.object({ q: z.string() }), execute: async () => ({}) }),
};

const ctx: ToolContext = {
  mem: {} as unknown as MemoryService,
  userId: 1,
  chatId: 10,
  sessionId: 5,
  db: {} as unknown as LibSQLDatabase<typeof schema>,
  settings: {} as unknown as SettingsService,
  mcpTools,
};

describe("resolveTools", () => {
  it("resolves known memory tools", () => {
    const tools = resolveTools(["remember", "memory_search"], ctx);
    expect(Object.keys(tools).sort()).toEqual(["memory_search", "remember"]);
  });

  it("resolves MCP tools by bare name", () => {
    const tools = resolveTools(["web_search"], ctx);
    expect(Object.keys(tools)).toEqual(["web_search"]);
  });

  it("merges memory + MCP and skips unknown names", () => {
    const tools = resolveTools(["remember", "web_search", "totally_unknown"], ctx);
    expect(Object.keys(tools).sort()).toEqual(["remember", "web_search"]);
  });

  it("returns an empty ToolSet for no allowed-tools or all-unknown", () => {
    expect(resolveTools([], ctx)).toEqual({});
    expect(resolveTools(["nope", "nada"], ctx)).toEqual({});
  });
});
