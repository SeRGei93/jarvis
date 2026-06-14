import { MCPClient } from "@mastra/mcp";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { parseGoDuration, type SettingsService } from "../config/settings.js";
import type { McpServers } from "../config/settings-keys.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "mcp" });

/** Default global timeout if `timeouts.http_client` cannot be parsed (matches @mastra/mcp default). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Structural shape of a Mastra MCP tool as returned by `listToolsetsWithErrors()`.
 * Mastra tools carry a zod `inputSchema` and an `execute({ context })` — NOT the
 * AI-SDK calling convention — so they must be adapted before LlmService can use them.
 */
interface McpToolLike {
  description?: string;
  inputSchema?: unknown;
  execute?: (arg: { context: unknown }) => Promise<unknown>;
}

/** The slice of `@mastra/mcp` MCPClient we depend on (real client or a fake in tests). */
export interface McpClientLike {
  listToolsetsWithErrors(): Promise<{
    toolsets: Record<string, Record<string, McpToolLike>>;
    errors: Record<string, string>;
  }>;
  disconnect(): Promise<void>;
}

/** Builds the MCP client. Injectable so tests never spawn a real subprocess. */
export type McpClientFactory = (servers: McpServers, timeoutMs: number) => McpClientLike;

export interface McpTools {
  /** Adapted AI-SDK ToolSet keyed by BARE tool name (web_search, web_fetch, …) — Go parity. */
  tools: ToolSet;
  /** Live client to `disconnect()` on shutdown, or null when MCP is disabled/unavailable. */
  client: McpClientLike | null;
}

const defaultFactory: McpClientFactory = (servers, timeoutMs) =>
  // `id` is mandatory: a second MCPClient with the same config and no id throws (leak guard).
  new MCPClient({ id: "jarvis-search", servers: servers as never, timeout: timeoutMs }) as McpClientLike;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Adapt one Mastra MCP tool into an AI-SDK `tool()` so it can be spread into
 * `streamText`/`generateText` via LlmService. Translates the `inputSchema` and the
 * Mastra `execute({ context })` convention into AI-SDK's `execute(args)`.
 */
function adaptTool(name: string, t: McpToolLike) {
  const schema = (t.inputSchema ?? z.object({})) as z.ZodTypeAny;
  return tool({
    description: t.description ?? `MCP tool ${name}`,
    inputSchema: schema,
    execute: async (args: unknown) => {
      if (!t.execute) return { error: `MCP tool ${name} is not executable` };
      return t.execute({ context: args });
    },
  });
}

/**
 * Connect to the configured MCP servers (only `search` is seeded — §9 ROADMAP) and
 * return an adapted AI-SDK ToolSet with BARE tool names. Never throws: an unreachable
 * server, a construction error, or a per-server list error degrades to an empty/partial
 * set + WARN so the chat workflow keeps working. Returns the live client for shutdown.
 */
export async function loadMcpTools(
  settings: SettingsService,
  factory: McpClientFactory = defaultFactory,
): Promise<McpTools> {
  const servers = await settings.getMcpServers();
  if (Object.keys(servers).length === 0) {
    log.info("no MCP servers configured; MCP tools disabled");
    return { tools: {}, client: null };
  }

  const timeouts = await settings.getTimeouts();
  const timeoutMs = parseGoDuration(timeouts.http_client) || DEFAULT_TIMEOUT_MS;

  let client: McpClientLike;
  try {
    client = factory(servers, timeoutMs);
  } catch (e) {
    log.warn({ err: errMsg(e) }, "failed to construct MCP client; MCP tools disabled");
    return { tools: {}, client: null };
  }

  try {
    const { toolsets, errors } = await client.listToolsetsWithErrors();
    for (const [server, e] of Object.entries(errors)) {
      log.warn({ server, err: e }, "MCP server unavailable; skipped");
    }

    const tools: ToolSet = {};
    for (const [server, toolset] of Object.entries(toolsets)) {
      for (const [toolName, t] of Object.entries(toolset)) {
        tools[toolName] = adaptTool(toolName, t); // bare name, parity with Go allowed-tools
        log.debug({ server, tool: toolName }, "adapted MCP tool");
      }
    }
    log.info(
      { servers: Object.keys(toolsets), tools: Object.keys(tools) },
      "MCP tools ready",
    );
    return { tools, client };
  } catch (e) {
    log.warn({ err: errMsg(e) }, "MCP listToolsets failed; MCP tools disabled");
    try {
      await client.disconnect();
    } catch {
      /* best effort */
    }
    return { tools: {}, client: null };
  }
}
