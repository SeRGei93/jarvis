import type { ToolSet } from "ai";
import { MemoryService } from "../memory/memory-service.js";
import { buildMemoryTools } from "./memory-tools.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "tool-registry" });

/** Tool names wired in M4. The rest (web_search/web_fetch/currency/tasks/profile/skill-ref + MCP) land in M5. */
const MEMORY_TOOL_NAMES = new Set(["remember", "forget", "list_memories", "memory_search"]);

export interface ToolContext {
  mem: MemoryService;
  userId: number;
}

/**
 * Resolve a skill's `allowed-tools` name list into a concrete AI SDK ToolSet.
 * M4 wires only the memory tools (per-user closures). Unknown names are logged
 * at WARN and skipped — the full registry + MCP `search` arrive in M5. This is the
 * seam that lets the chat workflow run end-to-end before tools exist.
 */
export function resolveTools(allowedTools: string[], ctx: ToolContext): ToolSet {
  if (allowedTools.length === 0) return {};

  const wantsMemory = allowedTools.some((n) => MEMORY_TOOL_NAMES.has(n));
  const memTools = wantsMemory ? buildMemoryTools(ctx.mem, ctx.userId) : {};

  const out: ToolSet = {};
  const skipped: string[] = [];
  for (const name of allowedTools) {
    if (name in memTools) {
      out[name] = memTools[name]!;
    } else {
      skipped.push(name);
    }
  }

  for (const name of skipped) {
    log.warn({ tool: name }, "tool not available until M5; skipped");
  }
  log.debug({ resolved: Object.keys(out), skipped }, "resolved skill tools");
  return out;
}
