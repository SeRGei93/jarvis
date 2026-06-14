import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { MemoryService } from "../memory/memory-service.js";
import { containsInjection } from "../../pkg/promptguard.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "memory-tools" });
const SEARCH_LIMIT = 10;

/** Build the per-user memory tools (remember/forget/list_memories/memory_search). */
export function buildMemoryTools(mem: MemoryService, userId: number): ToolSet {
  return {
    remember: tool({
      description: "Save a durable fact about the user for future conversations.",
      inputSchema: z.object({
        content: z.string().describe("the fact to remember"),
        category: z.enum(["fact", "preference", "instruction", "lesson"]),
      }),
      execute: async ({ content, category }) => {
        if (containsInjection(content)) {
          log.warn("remember blocked (injection)");
          return { message: "Rejected: content looks like an injection attempt." };
        }
        // remember always stores permanent scope (Go parity).
        const r = await mem.save(userId, category, content, null, "permanent");
        log.debug({ saved: r.saved }, "remember");
        return { message: r.saved ? "Memory saved" : `Not saved (${r.reason})` };
      },
    }),

    forget: tool({
      description: "Delete a stored memory by its id (obtained from list_memories).",
      inputSchema: z.object({ memory_id: z.number().int() }),
      execute: async ({ memory_id }) => {
        const ok = await mem.delete(userId, memory_id);
        log.debug({ id: memory_id, ok }, "forget");
        return { message: ok ? `Memory #${memory_id} deleted` : "Memory not found" };
      },
    }),

    list_memories: tool({
      description: "List the user's permanent memories, including ids for use with forget.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await mem.listPermanent(userId);
        return {
          count: rows.length,
          memories: rows.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.category,
            created_at: r.createdAt,
          })),
        };
      },
    }),

    memory_search: tool({
      description: "Search the user's memories by meaning. Returns matches (without ids).",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const rows = await mem.search(userId, query, SEARCH_LIMIT);
        return {
          count: rows.length,
          memories: rows.map((r) => ({
            content: r.content,
            category: r.category,
            created_at: r.createdAt,
          })),
        };
      },
    }),
  };
}
