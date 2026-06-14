import { describe, it, expect } from "vitest";
import { resolveTools } from "../../src/mastra/tools/registry.js";
import type { MemoryService } from "../../src/mastra/memory/memory-service.js";

// buildMemoryTools only closes over `mem`/`userId` (no calls at build time), so a
// bare stub is enough to exercise resolution.
const ctx = { mem: {} as unknown as MemoryService, userId: 1 };

describe("resolveTools", () => {
  it("resolves known memory tools", () => {
    const tools = resolveTools(["remember", "memory_search"], ctx);
    expect(Object.keys(tools).sort()).toEqual(["memory_search", "remember"]);
  });

  it("skips tools not yet available (until M5) and keeps the known ones", () => {
    const tools = resolveTools(["remember", "web_search", "currency"], ctx);
    expect(Object.keys(tools)).toEqual(["remember"]);
  });

  it("returns an empty ToolSet for no allowed-tools or all-unknown", () => {
    expect(resolveTools([], ctx)).toEqual({});
    expect(resolveTools(["web_fetch", "tasks"], ctx)).toEqual({});
  });
});
