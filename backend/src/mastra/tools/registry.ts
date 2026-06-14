import type { ToolSet } from "ai";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { MemoryService } from "../memory/memory-service.js";
import type { SettingsService } from "../../config/settings.js";
import { buildMemoryTools } from "./memory-tools.js";
import { buildCurrencyTools, CURRENCY_TOOL_NAMES } from "./currency.js";
import { buildTaskTools, TASK_TOOL_NAMES } from "./tasks.js";
import { buildProfileTools, PROFILE_TOOL_NAMES } from "./profile-tools.js";
import { buildSkillRefTools, SKILLREF_TOOL_NAMES } from "./skill-ref.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "tool-registry" });

type Db = LibSQLDatabase<typeof schema>;

const MEMORY_TOOL_NAMES = new Set(["remember", "forget", "list_memories", "memory_search"]);

/** Everything a tool's `execute` may need, threaded from the chat workflow. */
export interface ToolContext {
  mem: MemoryService;
  userId: number;
  chatId: number;
  sessionId: number;
  db: Db;
  settings: SettingsService;
  /** Adapted AI-SDK ToolSet from the MCP `search` server (bare names); {} when disabled. */
  mcpTools: ToolSet;
  /** Filesystem root for skill references; defaults to the seed skills dir (Task 6). */
  skillsRoot?: string;
}

interface Bucket {
  names: Set<string>;
  get: () => ToolSet;
}

/** Build the bucket's ToolSet at most once per resolve call. */
function once(fn: () => ToolSet): () => ToolSet {
  let cached: ToolSet | undefined;
  return () => (cached ??= fn());
}

/**
 * Resolve a skill's `allowed-tools` into a concrete AI-SDK ToolSet by merging buckets:
 * memory → built-in (currency/tasks/profile/skill-ref) → MCP `search`. First match wins;
 * unknown names are logged at WARN and skipped (the seam that lets the workflow run before
 * every tool exists). Buckets build lazily — only when a skill actually references them.
 * Sync by design: `mcpTools` is assembled once at boot and passed in via `ctx`.
 */
export function resolveTools(allowedTools: string[], ctx: ToolContext): ToolSet {
  if (allowedTools.length === 0) return {};

  const buckets: Bucket[] = [
    { names: MEMORY_TOOL_NAMES, get: once(() => buildMemoryTools(ctx.mem, ctx.userId)) },
    { names: CURRENCY_TOOL_NAMES, get: once(() => buildCurrencyTools(ctx)) },
    { names: TASK_TOOL_NAMES, get: once(() => buildTaskTools(ctx)) },
    { names: PROFILE_TOOL_NAMES, get: once(() => buildProfileTools(ctx)) },
    { names: SKILLREF_TOOL_NAMES, get: once(() => buildSkillRefTools(ctx)) },
  ];
  const mcp = ctx.mcpTools ?? {};

  const out: ToolSet = {};
  const skipped: string[] = [];
  for (const name of allowedTools) {
    const bucket = buckets.find((b) => b.names.has(name));
    const fromBucket = bucket?.get()[name];
    if (fromBucket) {
      out[name] = fromBucket;
    } else if (name in mcp) {
      out[name] = mcp[name]!;
    } else {
      skipped.push(name);
    }
  }

  for (const name of skipped) log.warn({ tool: name }, "tool not available; skipped");
  log.debug({ resolved: Object.keys(out), skipped }, "resolved skill tools");
  return out;
}
