import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import * as schema from "./db/schema.js";
import { SettingsService } from "./config/settings.js";
import { ModelFactory } from "./mastra/models.js";
import { LlmService, type StreamCallback } from "./mastra/llm.js";
import { EmbeddingService } from "./mastra/embeddings.js";
import { SkillService } from "./services/skill-service.js";
import { MemoryService } from "./mastra/memory/memory-service.js";
import { ProfileExtractor } from "./mastra/memory/profile-extractor.js";
import { SkillRouter } from "./mastra/agents/router.js";
import { LoopGuard } from "./mastra/agents/loop-guard.js";
import { createConversationMemory } from "./mastra/memory/history.js";
import { loadMcpTools } from "./mastra/mcp.js";
import { RateLimitService } from "./services/rate-limit.js";
import { UsageService } from "./services/usage.js";
import { runChat, type ChatDeps, type ChatResult } from "./mastra/workflows/chat.js";
import { logger } from "./pkg/logger.js";

const log = logger.child({ mod: "app" });

type Db = LibSQLDatabase<typeof schema>;

export interface ChatServiceOptions {
  db: Db;
  storage: LibSQLStore;
  vector: LibSQLVector;
}

export interface ChatService {
  /** Single entry point for M6 (Telegram) and the cron scheduler. */
  handleUserMessage(
    userId: number,
    chatId: number,
    text: string,
    onText?: StreamCallback,
  ): Promise<ChatResult>;
  deps: ChatDeps;
  /** Release external resources (MCP client) on shutdown. */
  close(): Promise<void>;
}

/**
 * Composition root for the chat stack: wires the settings cache, model factory,
 * LLM service, skill/memory/profile services, router, loop guard and Mastra
 * conversation memory into a single `handleUserMessage` entry point.
 *
 * `conversationMemory.lastMessages` is taken from `settings.agent.max_history`
 * (runChat re-reads it per turn, so admin changes take effect on the next turn).
 */
export async function createChatService(opts: ChatServiceOptions): Promise<ChatService> {
  const settings = new SettingsService(opts.db);
  const [roles, agentCfg] = await Promise.all([settings.getModelRoles(), settings.getAgent()]);

  const factory = new ModelFactory();
  const llm = new LlmService(factory, settings);
  const skills = new SkillService(opts.db);
  const embedder = new EmbeddingService({ modelRef: roles.embedding ?? "" });
  const memoryService = new MemoryService(opts.db, opts.vector, embedder, settings);
  const profileExtractor = new ProfileExtractor(factory, settings);
  const router = new SkillRouter(factory, settings);
  const loopGuard = new LoopGuard();
  const memory = createConversationMemory(opts.storage, agentCfg.max_history);
  const rateLimit = new RateLimitService(opts.db);
  const usage = new UsageService(opts.db);

  // MCP `search` tools: connect once at boot. Best-effort — an unreachable server
  // degrades to an empty ToolSet (the chat still works); `mcpClient` is kept for shutdown.
  const { tools: mcpTools, client: mcpClient } = await loadMcpTools(settings);

  const deps: ChatDeps = {
    db: opts.db,
    settings,
    skills,
    router,
    llm,
    memoryService,
    profileExtractor,
    loopGuard,
    memory,
    rateLimit,
    usage,
    mcpTools,
  };

  const routableCount = (await skills.getRoutableSkills()).length;
  const activeRoles = Object.entries(roles)
    .filter(([, ref]) => typeof ref === "string" && ref.length > 0)
    .map(([role]) => role); // role names only — model refs are not secrets, but keep the log compact
  log.info(
    { routableSkills: routableCount, activeRoles, maxHistory: agentCfg.max_history, mcpTools: Object.keys(mcpTools).length },
    "chat service ready",
  );

  return {
    deps,
    handleUserMessage: (userId, chatId, text, onText) =>
      runChat(deps, { userId, chatId, text }, onText),
    close: async () => {
      if (mcpClient) await mcpClient.disconnect();
    },
  };
}
