import type { Memory } from "@mastra/memory";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import type { Message } from "../../domain/entities.js";
import { shouldAutoCompleteOnboarding } from "../../domain/entities.js";
import { SettingsService } from "../../config/settings.js";
import { SkillService, derivePreviousSkills } from "../../services/skill-service.js";
import { loadContext } from "../../services/conversation-context.js";
import { PrimarySkillSelector, resolveTurnConfig } from "../agents/primary-skill.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { LlmService, type StreamCallback, type ToolEvents } from "../llm.js";
import { MemoryService } from "../memory/memory-service.js";
import { RollingSummaryService } from "../memory/rolling-summary.js";
import { FactExtractor } from "../memory/fact-extractor.js";
import { ProfileExtractor } from "../memory/profile-extractor.js";
import { RateLimitService } from "../../services/rate-limit.js";
import { UsageService } from "../../services/usage.js";
import {
  ensureThread,
  saveUserMessage,
  saveAssistant,
  getRecentMessages,
} from "../memory/history.js";
import { validateUserMessage } from "../../pkg/promptguard.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "chat" });

type Db = LibSQLDatabase<typeof schema>;
/** Shown to the user when generation fails or no answer could be produced. */
const FALLBACK_REPLY = "Не удалось сформировать ответ. Попробуйте переформулировать запрос.";
/** Shown to the user when the hourly message rate limit is exceeded. */
const RATE_LIMIT_REPLY = "Слишком много сообщений за последний час. Попробуйте чуть позже.";

/** All collaborators the chat workflow orchestrates (wired by the composition root). */
export interface ChatDeps {
  db: Db;
  settings: SettingsService;
  skills: SkillService;
  /** Lightweight pre-pass: picks the primary skill + turn model (replaces the router). */
  primarySelector: PrimarySkillSelector;
  /** The single dynamic agent that answers (replaces router→N skills→synthesizer). */
  orchestrator: Orchestrator;
  /**
   * Hand-rolled LLM service. NOT used by the chat path (the orchestrator owns it),
   * but kept in the bundle for the admin skill test-run (admin reuses ChatDeps).
   */
  llm: LlmService;
  memoryService: MemoryService;
  /** Maintains the per-session rolling summary of evicted dialogue history. */
  rollingSummary: RollingSummaryService;
  /** Opportunistic long-term memory extractor (gated by agent.auto_memory). */
  factExtractor: FactExtractor;
  profileExtractor: ProfileExtractor;
  /** Mastra conversation memory (threads/messages). */
  memory: Memory;
  /** Hourly message rate limit (onboarding-bypassed). */
  rateLimit: RateLimitService;
  /** Per-user cost/request accounting. */
  usage: UsageService;
}

export interface ChatInput {
  userId: number;
  chatId: number;
  text: string;
}

export interface ChatResult {
  text: string;
  /** Primary skill chosen by the pre-pass (empty when rejected/none). */
  skills: string[];
  /** True when promptguard rejected the message (no LLM call was made). */
  rejected: boolean;
}

/**
 * Orchestrate one chat turn: promptguard → context → memories/history → pre-pass
 * (primary skill + turn model) → ONE orchestrator agent stream → persist →
 * rolling summary → opportunistic memory → onboarding auto-complete.
 *
 * The agent leads with its own voice and pulls in skills on demand via `load_skill`
 * (decision #2/#4) — no router fan-out, no synthesizer merge. Implemented as a flat
 * async orchestrator (not Mastra createWorkflow) so token streaming to Telegram
 * (`onText`) stays first-class.
 */
export async function runChat(
  deps: ChatDeps,
  input: ChatInput,
  onText?: StreamCallback,
  onTool?: ToolEvents,
): Promise<ChatResult> {
  const { userId, chatId, text } = input;

  // 1. promptguard — reject before any model call.
  const guard = validateUserMessage(text);
  if (!guard.ok) {
    log.warn({ userId, reason: guard.reason }, "message rejected by promptguard");
    return { text: guard.userMessage, skills: [], rejected: true };
  }

  // 2. conversation context (user / session / identity / thread).
  const ctx = await loadContext(deps.db, deps.settings, userId, chatId);
  await ensureThread(deps.memory, ctx.threadId, ctx.resourceId);

  // 2a. hourly rate limit (onboarding users are bypassed inside the service).
  const rl = await deps.rateLimit.checkAndConsume(userId);
  if (!rl.allowed) {
    log.warn({ userId, limit: rl.limit }, "message rejected by rate limit");
    return { text: RATE_LIMIT_REPLY, skills: [], rejected: true };
  }

  // 3. history BEFORE the current turn + previousSkills.
  const agentCfg = await deps.settings.getAgent();
  const recent = await getRecentMessages(deps.memory, ctx.threadId, ctx.resourceId, agentCfg.max_history);
  const previousSkills = derivePreviousSkills(recent);

  // Persist the user turn (durable even if generation later fails).
  await saveUserMessage(deps.memory, ctx.threadId, ctx.resourceId, text);

  // 4. relevant long-term memories + core prompt bodies + model roles.
  const [memories, prompts, roles] = await Promise.all([
    deps.memoryService.loadRelevant(userId),
    deps.skills.getCorePrompts(),
    deps.settings.getModelRoles(),
  ]);

  // 5. pre-pass: choose the primary skill (onboarding forced when !onboarded;
  //    research fallback) and resolve the turn's model/temperature/reasoning
  //    (session.model override → primary skill → defaults).
  const routable = await deps.skills.getRoutableSkills();
  const primarySkill = await deps.primarySelector.selectPrimary({
    skills: routable,
    recentMessages: recent,
    userMessage: text,
    previousSkills,
    onboarded: ctx.user.onboarded,
  });
  const primary = primarySkill ? await deps.skills.getSkillByName(primarySkill) : null;
  const turn = resolveTurnConfig(primary, {
    sessionModel: ctx.session.model,
    defaultModel: roles.default,
    defaultTemperature: agentCfg.default_temperature,
  });
  log.debug({ userId, primarySkill: turn.skill, model: turn.model, onboarded: ctx.user.onboarded }, "pre-pass");

  // 6. run the single orchestrator agent. Any failure degrades to a user-facing
  //    fallback instead of throwing, so the caller always has a reply.
  let answer: string;
  let cost = 0;
  try {
    const r = await deps.orchestrator.run(
      {
        user: ctx.user,
        identity: ctx.identity,
        memories,
        prompts: { soul: prompts.soul, format: prompts.format, integrity: prompts.integrity },
        history: recent,
        summary: ctx.session.summary ?? null,
        userMessage: text,
        primarySkill: turn.skill,
        model: turn.model,
        temperature: turn.temperature,
        reasoning: turn.reasoning,
        mem: deps.memoryService,
        userId,
        chatId,
        sessionId: ctx.session.id,
        db: deps.db,
        settings: deps.settings,
      },
      onText,
      onTool,
    );
    answer = r.text || FALLBACK_REPLY;
    cost += r.cost;
  } catch (err) {
    log.error({ userId, reason: err instanceof Error ? err.message : String(err) }, "generation failed; using fallback reply");
    answer = FALLBACK_REPLY;
  }

  // 6a. record usage for this turn (one request; accumulated cost may be 0).
  //     Best-effort: the reply may already be streamed to the user, so an accounting
  //     DB error must never break the turn or skip the assistant-message persist below.
  try {
    await deps.usage.recordUsage(userId, cost);
  } catch (err) {
    log.warn({ userId, reason: err instanceof Error ? err.message : String(err) }, "usage record failed");
  }

  // 7. persist the assistant turn, tagged with the primary skill.
  const skillTag = turn.skill || null;
  await saveAssistant(deps.memory, ctx.threadId, ctx.resourceId, answer, skillTag);

  // 7a. roll the conversation summary forward for messages now beyond the live
  //     window. Best-effort: the reply is already streamed, so a summary failure
  //     must never break the turn. Reads the full thread (bounded read is T11).
  try {
    const full = await getRecentMessages(deps.memory, ctx.threadId, ctx.resourceId, 0);
    await deps.rollingSummary.maybeUpdate({
      sessionId: ctx.session.id,
      allMessages: full,
      windowSize: agentCfg.max_history,
      currentSummary: ctx.session.summary ?? null,
      currentCount: ctx.session.summaryMsgCount ?? 0,
    });
  } catch (err) {
    log.warn({ userId, reason: err instanceof Error ? err.message : String(err) }, "rolling summary update failed");
  }

  // 7b. opportunistic long-term memory: capture durable facts the user stated in
  //     passing. Onboarded users only (onboarding owns first-contact extraction),
  //     gated by agent.auto_memory (undefined = on). Best-effort: a cheap extra
  //     LLM call on the default model, routed through memoryService.save (which
  //     applies sensitivity/dedup/cap); its cost is not metered. A failure never
  //     breaks the turn.
  if (ctx.user.onboarded && (agentCfg.auto_memory ?? true)) {
    try {
      const { facts } = await deps.factExtractor.extract([
        { role: "user", content: text },
        { role: "assistant", content: answer },
      ]);
      let saved = 0;
      for (const f of facts) {
        const r = await deps.memoryService.save(userId, f.category, f.content, ctx.session.id);
        if (r.saved) saved++;
      }
      if (facts.length) log.debug({ userId, extracted: facts.length, saved }, "opportunistic memory");
    } catch (err) {
      log.warn({ userId, reason: err instanceof Error ? err.message : String(err) }, "opportunistic memory failed");
    }
  }

  // 8. onboarding auto-complete (msgCount includes the just-saved user + assistant turns).
  const allMessages: Message[] = [
    ...recent,
    { role: "user", content: text },
    { role: "assistant", content: answer, skill: skillTag },
  ];
  if (shouldAutoCompleteOnboarding(ctx.user.onboarded, allMessages.length)) {
    log.info({ userId, msgCount: allMessages.length }, "auto-completing onboarding");
    await deps.profileExtractor.applyOnboarding(deps.db, userId, allMessages);
  }

  return { text: answer, skills: turn.skill ? [turn.skill] : [], rejected: false };
}
