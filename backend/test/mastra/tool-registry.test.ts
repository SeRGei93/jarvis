import { describe, it, expect } from "vitest";
import { resolveTools, type ToolContext } from "../../src/mastra/tools/registry.js";
import type { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../../src/db/schema.js";

// buildMemoryTools only closes over mem/userId (no calls at build time), and the
// other built-in buckets are not exercised here, so bare stubs are enough. We focus
// on the merge logic: memory bucket and unknown-name skipping.
const ctx: ToolContext = {
  mem: {} as unknown as MemoryService,
  userId: 1,
  chatId: 10,
  sessionId: 5,
  db: {} as unknown as LibSQLDatabase<typeof schema>,
  settings: {} as unknown as SettingsService,
};

describe("resolveTools", () => {
  it("resolves known memory tools", () => {
    const tools = resolveTools(["remember", "memory_search"], ctx);
    expect(Object.keys(tools).sort()).toEqual(["memory_search", "remember"]);
  });

  it("resolves memory tools and skips unknown names", () => {
    const tools = resolveTools(["remember", "totally_unknown"], ctx);
    expect(Object.keys(tools).sort()).toEqual(["remember"]);
  });

  it("returns an empty ToolSet for no allowed-tools or all-unknown", () => {
    expect(resolveTools([], ctx)).toEqual({});
    expect(resolveTools(["nope", "nada"], ctx)).toEqual({});
  });
});
