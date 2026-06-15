import type { Memory } from "@mastra/memory";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import type { Message, Skill } from "../../domain/entities.js";
import { shouldAutoCompleteOnboarding } from "../../domain/entities.js";
import { SettingsService } from "../../config/settings.js";
import { SkillService, derivePreviousSkills } from "../../services/skill-service.js";
import { loadContext } from "../../services/conversation-context.js";
import { SkillRouter } from "../agents/router.js";
import { LlmService, type StreamCallback } from "../llm.js";
import { MemoryService } from "../memory/memory-service.js";
import { ProfileExtractor } from "../memory/profile-extractor.js";
import { LoopGuard } from "../agents/loop-guard.js";
import {
  runSkillStreaming,
  runSkillSubAgent,
  type SkillRunContext,
} from "../agents/skill-agent.js";
import { synthesize } from "../agents/synthesizer.js";
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
const FALLBACK_SKILL = "research";
/** Shown to the user when generation fails or no skill could produce a result. */
const FALLBACK_REPLY = "Не удалось сформировать ответ. Попробуйте переформулировать запрос.";
/** Shown to the user when the hourly message rate limit is exceeded. */
const RATE_LIMIT_REPLY = "Слишком много сообщений за последний час. Попробуйте чуть позже.";

/** All collaborators the chat workflow orchestrates (wired by the composition root). */
export interface ChatDeps {
  db: Db;
  settings: SettingsService;
  skills: SkillService;
  router: SkillRouter;
  llm: LlmService;
  memoryService: MemoryService;
  profileExtractor: ProfileExtractor;
  loopGuard: LoopGuard;
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
  /** Skills chosen by the router (empty when rejected). */
  skills: string[];
  /** True when promptguard rejected the message (no LLM call was made). */
  rejected: boolean;
}

/**
 * Orchestrate one chat turn: promptguard → context → memories/history → route →
 * run (single stream | multi sub-agents + synthesize) → persist → onboarding
 * auto-complete. Parity with Go HandleMessageUseCase. Implemented as a flat async
 * orchestrator (not Mastra createWorkflow) so token streaming to Telegram (`onText`)
 * stays first-class — see plan Key Decisions.
 */
export async function runChat(
  deps: ChatDeps,
  input: ChatInput,
  onText?: StreamCallback,
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

  // 4. relevant long-term memories + core prompt bodies.
  const [memories, prompts, roles] = await Promise.all([
    deps.memoryService.loadRelevant(userId),
    deps.skills.getCorePrompts(),
    deps.settings.getModelRoles(),
  ]);

  // 5. route (onboarding is forced inside resolveSkills when !onboarded).
  const routable = await deps.skills.getRoutableSkills();
  const selected = await deps.router.resolveSkills({
    skills: routable,
    recentMessages: recent,
    userMessage: text,
    previousSkills,
    onboarded: ctx.user.onboarded,
  });
  const resolved = await resolveSkillObjects(deps.skills, selected);
  log.debug({ userId, selected, resolved: resolved.map((s) => s.name), onboarded: ctx.user.onboarded }, "routed");

  const agentCtx: SkillRunContext = {
    user: ctx.user,
    identity: ctx.identity,
    memories,
    prompts: { soul: prompts.soul, format: prompts.format, integrity: prompts.integrity },
    history: recent,
    userMessage: text,
    mem: deps.memoryService,
    userId,
    defaultModel: roles.default,
    defaultTemperature: agentCfg.default_temperature,
    chatId,
    sessionId: ctx.session.id,
    db: deps.db,
    settings: deps.settings,
  };

  // 6. run: single → stream directly; multi → sub-agents in parallel → synthesize.
  //    Any failure (no skill / all sub-agents fail / model error) degrades to a
  //    user-facing fallback instead of throwing, so the caller always has a reply.
  let answer: string;
  let cost = 0; // accumulated LLM cost across all legs (single, sub-agents, synthesis).
  if (resolved.length === 0) {
    log.warn({ userId }, "no skill resolved; using fallback reply");
    answer = FALLBACK_REPLY;
  } else {
    try {
      if (resolved.length === 1) {
        const skill = resolved[0]!;
        log.debug({ skill: skill.name, path: "single" }, "executing");
        const r = await runSkillStreaming({ llm: deps.llm, loopGuard: deps.loopGuard }, skill, agentCtx, onText);
        answer = r.text;
        cost += r.cost;
      } else {
        log.debug({ skills: resolved.map((s) => s.name), path: "multi" }, "executing");
        const results = await Promise.all(
          resolved.map(async (s) => {
            try {
              const r = await runSkillSubAgent({ llm: deps.llm, loopGuard: deps.loopGuard }, s, agentCtx);
              return [s.name, r] as const;
            } catch (err) {
              log.warn({ skill: s.name, reason: err instanceof Error ? err.message : String(err) }, "sub-agent failed");
              return [s.name, { text: "", cost: 0 }] as const;
            }
          }),
        );
        for (const [, r] of results) cost += r.cost;
        const skillResults = Object.fromEntries(
          results.filter(([, r]) => r.text.length > 0).map(([name, r]) => [name, r.text]),
        );
        if (Object.keys(skillResults).length === 0) {
          log.warn({ userId }, "all sub-agents failed; using fallback reply");
          answer = FALLBACK_REPLY;
        } else {
          const synth = await synthesize(
            deps.llm,
            skillResults,
            {
              user: ctx.user,
              identity: ctx.identity,
              memories,
              prompts: { soul: prompts.soul, format: prompts.format, synthesizer: prompts.synthesizer },
              history: recent,
              userMessage: text,
              synthesizerModel: roles.synthesizer,
              sessionModel: ctx.session.model,
            },
            onText,
          );
          answer = synth.text;
          cost += synth.cost;
        }
      }
    } catch (err) {
      log.error({ userId, reason: err instanceof Error ? err.message : String(err) }, "generation failed; using fallback reply");
      answer = FALLBACK_REPLY;
    }
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
  const skillTag = resolved[0]?.name ?? null;
  await saveAssistant(deps.memory, ctx.threadId, ctx.resourceId, answer, skillTag);

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

  return { text: answer, skills: resolved.map((s) => s.name), rejected: false };
}

/** Resolve skill names to Skill rows; fall back to `research` if nothing resolves. */
async function resolveSkillObjects(skills: SkillService, names: string[]): Promise<Skill[]> {
  const resolved = (await Promise.all(names.map((n) => skills.getSkillByName(n)))).filter(
    (s): s is Skill => s !== null,
  );
  if (resolved.length > 0) return resolved;
  const fallback = await skills.getSkillByName(FALLBACK_SKILL);
  return fallback ? [fallback] : [];
}
