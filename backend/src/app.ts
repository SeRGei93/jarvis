import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { LibSQLStore } from "@mastra/libsql";
import * as schema from "./db/schema.js";
import { SettingsService } from "./config/settings.js";
import { ModelFactory } from "./mastra/models.js";
import { LlmService, type StreamCallback, type ToolEvents } from "./mastra/llm.js";
import { SkillService } from "./services/skill-service.js";
import { MemoryService } from "./mastra/memory/memory-service.js";
import { DecisionDedupChecker, LlmDedupChecker } from "./mastra/memory/dedup.js";
import { DecisionService, createScopeDecider } from "./mastra/decisions/service.js";
import { RollingSummaryService, LlmSummarizer } from "./mastra/memory/rolling-summary.js";
import { FactExtractor } from "./mastra/memory/fact-extractor.js";
import { ProfileExtractor } from "./mastra/memory/profile-extractor.js";
import { PrimarySkillSelector } from "./mastra/agents/primary-skill.js";
import { Orchestrator } from "./mastra/agents/orchestrator.js";
import { ConfirmationService } from "./mastra/confirmations/confirmation-service.js";
import { createConversationMemory } from "./mastra/memory/history.js";
import { RateLimitService } from "./services/rate-limit.js";
import { UsageService } from "./services/usage.js";
import { AccessRequestService } from "./services/access-request-service.js";
import { ModelsCatalog } from "./services/models-catalog.js";
import { runChat, type ChatDeps, type ChatResult } from "./mastra/workflows/chat.js";
import { logger } from "./pkg/logger.js";

const log = logger.child({ mod: "app" });

type Db = LibSQLDatabase<typeof schema>;

export interface ChatServiceOptions {
  db: Db;
  storage: LibSQLStore;
  /**
   * Skill/prompt service. Defaults to the file-backed content store
   * (SKILLS_DIR/PROMPTS_DIR); injectable so tests can point at temp dirs.
   */
  skills?: SkillService;
}

export interface ChatService {
  /** Single entry point for M6 (Telegram) and the cron scheduler. */
  handleUserMessage(
    userId: number,
    chatId: number,
    text: string,
    onText?: StreamCallback,
    onTool?: ToolEvents,
  ): Promise<ChatResult>;
  deps: ChatDeps;
  /** Release external resources on shutdown. */
  close(): Promise<void>;
}

/**
 * Composition root for the chat stack: wires the settings cache, model factory,
 * skill/memory/profile services, the primary-skill pre-pass, the orchestrator
 * agent and Mastra conversation memory into a single `handleUserMessage` entry point.
 *
 * `conversationMemory.lastMessages` is taken from `settings.agent.max_history`
 * (runChat re-reads it per turn, so admin changes take effect on the next turn).
 */
export async function createChatService(opts: ChatServiceOptions): Promise<ChatService> {
  const settings = new SettingsService(opts.db);
  const [roles, agentCfg] = await Promise.all([settings.getModelRoles(), settings.getAgent()]);

  const factory = new ModelFactory();
  // Skills/prompts come from the file-backed content store (SKILLS_DIR/PROMPTS_DIR),
  // not the DB. The store must be populated before this runs (server.ts boot).
  const skills = opts.skills ?? new SkillService();
  // Fast typed decisions (skill routing, memory dedup, memory scope). Optional:
  // an empty `model_roles.decision` turns it off and every caller falls back.
  const decisions = new DecisionService(settings);
  const dedup = new DecisionDedupChecker(decisions, new LlmDedupChecker(factory, settings));
  const memoryService = new MemoryService(opts.db, dedup, createScopeDecider(decisions));
  const rollingSummary = new RollingSummaryService(opts.db, new LlmSummarizer(factory, settings));
  const factExtractor = new FactExtractor(factory, settings);
  const profileExtractor = new ProfileExtractor(factory, settings);
  const primarySelector = new PrimarySkillSelector(
    factory,
    settings,
    undefined,
    (state, instructions, criteria) => decisions.choose(state, instructions, criteria),
  );
  const orchestrator = new Orchestrator({ skills, settings, factory });
  // Used only by the admin skill test-run (admin reuses ChatDeps), not the chat path.
  const llm = new LlmService(factory, settings);
  const confirmations = new ConfirmationService(opts.db, memoryService);
  const memory = createConversationMemory(opts.storage, agentCfg.max_history);
  const rateLimit = new RateLimitService(opts.db);
  const usage = new UsageService(opts.db);
  const accessRequests = new AccessRequestService(opts.db, settings);
  const modelsCatalog = new ModelsCatalog();

  const deps: ChatDeps = {
    db: opts.db,
    settings,
    skills,
    primarySelector,
    orchestrator,
    llm,
    memoryService,
    rollingSummary,
    factExtractor,
    profileExtractor,
    memory,
    rateLimit,
    usage,
    confirmations,
    accessRequests,
    modelsCatalog,
  };

  const routableCount = (await skills.getRoutableSkills()).length;
  const activeRoles = Object.entries(roles)
    .filter(([, ref]) => typeof ref === "string" && ref.length > 0)
    .map(([role]) => role); // role names only — model refs are not secrets, but keep the log compact
  log.info(
    { routableSkills: routableCount, activeRoles, maxHistory: agentCfg.max_history },
    "chat service ready",
  );

  return {
    deps,
    handleUserMessage: (userId, chatId, text, onText, onTool) =>
      runChat(deps, { userId, chatId, text }, onText, onTool),
    close: async () => {},
  };
}
