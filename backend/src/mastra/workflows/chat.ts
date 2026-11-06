import type { Memory } from "@mastra/memory";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import type { Message, StoredImageRef } from "../../domain/entities.js";
import { shouldAutoCompleteOnboarding } from "../../domain/entities.js";
import { SettingsService } from "../../config/settings.js";
import { SkillService, derivePreviousSkills } from "../../services/skill-service.js";
import { loadContext } from "../../services/conversation-context.js";
import { PrimarySkillSelector, resolveTurnConfig } from "../agents/primary-skill.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { ConfirmationService, type ConfirmationRequest } from "../confirmations/confirmation-service.js";
import { LlmService, type StreamCallback, type ToolEvents } from "../llm.js";
import { MemoryService } from "../memory/memory-service.js";
import { RollingSummaryService } from "../memory/rolling-summary.js";
import { FactExtractor } from "../memory/fact-extractor.js";
import { ProfileExtractor } from "../memory/profile-extractor.js";
import { RateLimitService } from "../../services/rate-limit.js";
import { UsageService } from "../../services/usage.js";
import { AccessRequestService } from "../../services/access-request-service.js";
import { MediaService, MAX_IMAGES_PER_TURN, type ImageInput } from "../../services/media-service.js";
import type { ModelsCatalog } from "../../services/models-catalog.js";
import type { McpManager } from "../mcp/manager.js";
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
/** Internal stand-in text for an image-only message (pre-pass, history, summary). */
export const IMAGE_PLACEHOLDER = "[изображение]";
/** Shown when the resolved turn model cannot accept images (known from the catalog). */
export const VISION_UNSUPPORTED_REPLY =
  "Не могу обработать изображение: выбранная модель не поддерживает картинки. Напишите текстом или укажите vision-модель в настройках.";

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
  /** Confirm-before-execute for risky tools (C1). */
  confirmations: ConfirmationService;
  /** Bot access-request inbox + allowlist gate (M17). Reused by the admin API. */
  accessRequests: AccessRequestService;
  /** OpenRouter + decision model catalogs (admin model picker, role validation). */
  modelsCatalog: ModelsCatalog;
  /** File-backed inbound image store (bytes on disk, refs in history). */
  media: MediaService;
  /**
   * Admin-managed HTTP MCP servers (settings `mcp_servers`). The orchestrator
   * reads its tool snapshot once per turn; the admin API drives refresh/test.
   */
  mcp: McpManager;
  /**
   * Best-effort Telegram sender for out-of-band notifications (e.g. "access
   * granted ✅" on approval). Wired by the server after the bot starts; undefined
   * until then, so callers must use optional-chaining.
   */
  notify?: (tgUserId: number, text: string) => Promise<void>;
}

export interface ChatInput {
  userId: number;
  chatId: number;
  text: string;
  /** Inbound images for this turn (Telegram photos/documents). */
  images?: ImageInput[];
}

export interface ChatResult {
  text: string;
  /** Primary skill chosen by the pre-pass (empty when rejected/none). */
  skills: string[];
  /** True when promptguard rejected the message (no LLM call was made). */
  rejected: boolean;
  /** Risky-tool confirmations requested this turn — the UI shows approve/decline (C1). */
  confirmations?: ConfirmationRequest[];
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
  const hasImages = !!input.images?.length;
  const trimmed = text.trim();
  // Image-only messages still need a text stand-in for the pre-pass, summary,
  // onboarding and history (promptguard is skipped for them below).
  const textForModel = trimmed || (hasImages ? IMAGE_PLACEHOLDER : text);
  log.info({ userId, hasImages, images: input.images?.length ?? 0 }, "chat turn started");

  // 1. promptguard — reject before any model call. Image-only messages have no
  //    text to validate; empty text without images is still rejected as before.
  if (trimmed || !hasImages) {
    const guard = validateUserMessage(text);
    if (!guard.ok) {
      log.warn({ userId, reason: guard.reason }, "message rejected by promptguard");
      return { text: guard.userMessage, skills: [], rejected: true };
    }
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

  // 3. history BEFORE the current turn + previousSkills. Image refs are hydrated
  //    into bytes here (bounded re-attach: last user messages / image count / bytes).
  const agentCfg = await deps.settings.getAgent();
  const recent = await getRecentMessages(deps.memory, ctx.threadId, ctx.resourceId, agentCfg.max_history);
  const previousSkills = derivePreviousSkills(recent);
  const hydrated = await deps.media.hydrate(recent);
  // A text-only follow-up ("what was on that photo?") still carries images from
  // history. Count both sources so the vision role and the capability gate below
  // stay in charge of EVERY image part sent to the provider.
  const historyImageCount = hydrated.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  const currentImages = input.images?.slice(0, MAX_IMAGES_PER_TURN) ?? [];
  const hasCurrentImages = currentImages.length > 0;
  const turnHasImages = hasCurrentImages || historyImageCount > 0;

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
    userMessage: textForModel,
    previousSkills,
    onboarded: ctx.user.onboarded,
  });
  const primary = primarySkill ? await deps.skills.getSkillByName(primarySkill) : null;
  const turn = resolveTurnConfig(primary, {
    sessionModel: ctx.session.model,
    defaultModel: roles.default,
    defaultTemperature: agentCfg.default_temperature,
    visionModel: roles.vision,
    hasImages: turnHasImages,
  });
  if (turn.model !== turn.baseModel) {
    log.info(
      {
        requested: turn.baseModel,
        effective: turn.model,
        role: "vision",
        currentImages: currentImages.length,
        historyImages: historyImageCount,
      },
      "vision model override",
    );
  }
  log.debug({ userId, primarySkill: turn.skill, model: turn.model, onboarded: ctx.user.onboarded }, "pre-pass");

  // 5a. capability gate: a catalog that positively says "no image input" refuses
  //     an image message BEFORE it is stored or the model is called. A cold/expired
  //     catalog (undefined) never blocks the turn. History images count too: when a
  //     text-only follow-up resolves to a non-vision model, the historical image
  //     parts are dropped instead of failing the request.
  let history = hydrated;
  if (turnHasImages) {
    const capable = await deps.modelsCatalog.supportsVision(turn.model);
    if (capable === false && hasCurrentImages) {
      log.warn({ userId, model: turn.model }, "turn model does not accept images; refusing");
      return { text: VISION_UNSUPPORTED_REPLY, skills: [], rejected: true };
    }
    if (capable === false) {
      history = hydrated.map((m) => (m.images ? { role: m.role, text: m.text } : m));
      log.info(
        { userId, model: turn.model, droppedImages: historyImageCount },
        "turn model does not accept images; dropping history images",
      );
    }
    log.debug(
      { userId, model: turn.model, capable, currentImages: currentImages.length, historyImages: historyImageCount },
      "vision capability checked",
    );
  }

  // 5b. Persist the user turn AFTER the turn model resolved: a capability refusal
  //     (Task 7) must not leave a placeholder-only message in history. Bytes are
  //     stored first (best-effort); a storage failure must not abort the turn.
  let imageRefs: StoredImageRef[] = [];
  if (hasCurrentImages) {
    try {
      imageRefs = await deps.media.saveMany(currentImages);
    } catch (err) {
      log.warn({ userId, reason: err instanceof Error ? err.message : String(err) }, "image save failed; continuing");
      imageRefs = [];
    }
    log.debug({ userId, saved: imageRefs.length, provided: currentImages.length }, "turn images stored");
  }
  await saveUserMessage(deps.memory, ctx.threadId, ctx.resourceId, textForModel, imageRefs);

  // Snapshot pending confirmations so we can surface only the ones created THIS
  // turn (a risky tool may record one mid-turn instead of acting — C1).
  const confirmationsBefore = await deps.confirmations.pendingIds(userId, ctx.session.id);

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
        history,
        summary: ctx.session.summary ?? null,
        userMessage: textForModel,
        userImages: currentImages,
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
        confirmations: deps.confirmations,
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
  //     passing. Skipped for image-only messages (the placeholder is not a fact).
  //     Onboarded users only (onboarding owns first-contact extraction),
  //     gated by agent.auto_memory (undefined = on). Best-effort: a cheap extra
  //     LLM call on the default model, routed through memoryService.save (which
  //     applies sensitivity/dedup/cap); its cost is not metered. A failure never
  //     breaks the turn.
  if (trimmed !== "" && ctx.user.onboarded && (agentCfg.auto_memory ?? true)) {
    try {
      const { facts } = await deps.factExtractor.extract([
        { role: "user", content: textForModel },
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
    { role: "user", content: textForModel, ...(imageRefs.length ? { images: imageRefs } : {}) },
    { role: "assistant", content: answer, skill: skillTag },
  ];
  if (shouldAutoCompleteOnboarding(ctx.user.onboarded, allMessages.length)) {
    log.info({ userId, msgCount: allMessages.length }, "auto-completing onboarding");
    await deps.profileExtractor.applyOnboarding(deps.db, userId, allMessages);
  }

  // Surface confirmations a risky tool requested THIS turn (created since the
  // pre-turn snapshot) so the UI can show approve/decline buttons (C1).
  let confirmations: ConfirmationRequest[] | undefined;
  try {
    const pending = await deps.confirmations.listPending(userId, ctx.session.id);
    const fresh = pending.filter((c) => !confirmationsBefore.has(c.id));
    if (fresh.length) confirmations = fresh;
  } catch (err) {
    log.warn({ userId, reason: err instanceof Error ? err.message : String(err) }, "confirmation surfacing failed");
  }

  return { text: answer, skills: turn.skill ? [turn.skill] : [], rejected: false, confirmations };
}
