import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { ModelMessage } from "ai";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import type { Message, User, BotIdentity } from "../../domain/entities.js";
import { ModelFactory } from "../models.js";
import { SettingsService, parseGoDuration } from "../../config/settings.js";
import { SkillService } from "../../services/skill-service.js";
import { MemoryService, type StoredMemory } from "../memory/memory-service.js";
import {
  reasoningProviderOptions,
  extractCost,
  startWatchdog,
  type StreamCallback,
  type ToolEvents,
} from "../llm.js";
import { resolveAllTools, type ToolContext } from "../tools/registry.js";
import type { ConfirmationService } from "../confirmations/confirmation-service.js";
import {
  buildLoadSkillTool,
  buildSkillToolMap,
  activeToolNames,
  LOADED_SKILLS_KEY,
  LOAD_SKILL_TOOL_NAME,
} from "../tools/load-skill.js";
import { listReferences } from "../tools/skill-ref.js";
import { buildOrchestratorPrompt } from "./prompt-builder.js";
import { stripLeakedToolCalls } from "../strip-leaked-tools.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "orchestrator" });

type Db = LibSQLDatabase<typeof schema>;

/**
 * Max tool-call steps per turn. Higher than the old per-skill cap (30): one
 * orchestrator turn now does `load_skill` calls PLUS the loaded skills' tool calls.
 */
export const MAX_STEPS = 50;
/** Model-call retries inside the agent loop (Mastra retries the model on failure). */
export const MAX_RETRIES = 3;
const DEFAULT_ACTIVITY_MS = 30_000;
const DEFAULT_REQUEST_MS = 300_000;

// RequestContext keys — per-turn values threaded to the agent's dynamic resolvers.
const SYSTEM_KEY = "orchestrator.system";
const MODEL_KEY = "orchestrator.model";
const TOOLS_KEY = "orchestrator.tools";

export interface OrchestratorDeps {
  skills: SkillService;
  settings: SettingsService;
  factory: ModelFactory;
}

/** Everything one orchestrated turn needs from the surrounding conversation. */
export interface OrchestratorRunContext {
  user: User | null;
  identity: BotIdentity | null;
  memories: StoredMemory[];
  prompts: { soul: string; format: string; integrity: string };
  /** Dialogue history BEFORE this turn (the current message is appended internally). */
  history: Message[];
  /** Rolling summary of evicted history (null when none). */
  summary?: string | null;
  userMessage: string;
  // ── turn config from the pre-pass (A3) ──
  /** Primary skill name to pre-load (its tools start active), or "" for none. */
  primarySkill: string;
  /** Resolved turn model ref (session override → skill model → default). */
  model: string;
  temperature: number;
  reasoning: boolean | null;
  // ── tool context ──
  mem: MemoryService;
  userId: number;
  chatId: number;
  sessionId: number;
  db: Db;
  settings: SettingsService;
  skillsRoot?: string;
  /** Confirm-before-execute for risky tools (C1); when set, forget/task_delete gate. */
  confirmations?: ConfirmationService;
  /** Caller-supplied cancellation, composed with the internal watchdog. */
  abortSignal?: AbortSignal;
}

export interface OrchestratorResult {
  text: string;
  cost: number;
}

/**
 * The single dynamic Mastra `Agent` that replaces the old router → N skills →
 * synthesizer pipeline (decisions #2/#4). Built once and kept standalone (not
 * registered on a Mastra instance). `instructions`/`model`/`tools` resolve per
 * request from a RequestContext assembled in `run()` (values pulled live from
 * SettingsService/SkillService), preserving DI + DB-backed config. All skill
 * tools are registered up front and gated per step via `prepareStep -> activeTools`,
 * widening as the model calls `load_skill`. Our own AbortSignal watchdog is kept
 * on top (Mastra has no built-in timeout).
 */
export class Orchestrator {
  private readonly agent: Agent;

  constructor(private readonly deps: OrchestratorDeps) {
    this.agent = new Agent({
      id: "jarvis-orchestrator",
      name: "jarvis-orchestrator",
      maxRetries: MAX_RETRIES,
      instructions: ({ requestContext }) => (requestContext?.get(SYSTEM_KEY) as string) ?? "",
      model: ({ requestContext }) => {
        const ref = (requestContext?.get(MODEL_KEY) as string | undefined) ?? "";
        // Cast bridges the two bundled LanguageModel declarations; runtime object is correct.
        return this.deps.factory.model(ref) as MastraModelConfig;
      },
      tools: ({ requestContext }) => (requestContext?.get(TOOLS_KEY) as ToolsInput) ?? {},
    });
  }

  async run(
    ctx: OrchestratorRunContext,
    onText?: StreamCallback,
    onTool?: ToolEvents,
  ): Promise<OrchestratorResult> {
    const t = await this.deps.settings.getTimeouts();
    const activityMs = parseGoDuration(t.llm_activity) || DEFAULT_ACTIVITY_MS;
    const overallMs = parseGoDuration(t.llm_request) || DEFAULT_REQUEST_MS;

    // Our own watchdog + overall timeout, composed with any caller signal.
    const controller = new AbortController();
    const abortSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(overallMs),
      ...(ctx.abortSignal ? [ctx.abortSignal] : []),
    ]);
    const wd = startWatchdog(controller, activityMs);

    // Register ALL tools up front: load_skill + every bucket. The live set is
    // gated per step below; AI SDK can't add tools mid-generation (A2).
    const toolCtx: ToolContext = {
      mem: ctx.mem,
      userId: ctx.userId,
      chatId: ctx.chatId,
      sessionId: ctx.sessionId,
      db: ctx.db,
      settings: ctx.settings,
      skillsRoot: ctx.skillsRoot,
      confirmations: ctx.confirmations,
    };
    const loadSkill = buildLoadSkillTool({ skills: this.deps.skills, skillsRoot: ctx.skillsRoot });
    const tools: ToolsInput = { [LOAD_SKILL_TOOL_NAME]: loadSkill, ...resolveAllTools(toolCtx) };
    const registered = new Set(Object.keys(tools));

    // Skill→tools map for gating; loaded set seeded with the primary skill.
    const allSkills = await this.deps.skills.getAllSkills();
    const skillToolMap = buildSkillToolMap(allSkills);
    const loadedSkills = new Set<string>();
    if (ctx.primarySkill) loadedSkills.add(ctx.primarySkill);

    // Pre-load the primary skill's instructions + references into the prompt.
    const primary = ctx.primarySkill
      ? (allSkills.find((s) => s.name === ctx.primarySkill) ?? null)
      : null;
    const primaryReferences = primary ? listReferences(primary.name, ctx.skillsRoot) : [];

    const catalog = await this.deps.skills.getSkillCatalog();
    const system = buildOrchestratorPrompt({
      prompts: ctx.prompts,
      user: ctx.user,
      memories: ctx.memories,
      identity: ctx.identity,
      catalog,
      primary: primary
        ? { name: primary.name, prompt: primary.prompt, allowedTools: primary.allowedTools }
        : null,
      primaryReferences,
      summary: ctx.summary,
    });

    const requestContext = new RequestContext([
      [SYSTEM_KEY, system],
      [MODEL_KEY, ctx.model],
      [TOOLS_KEY, tools],
      [LOADED_SKILLS_KEY, loadedSkills],
    ]);

    const messages = [...ctx.history, { role: "user", content: ctx.userMessage }].map((m) => ({
      role: m.role,
      content: m.content,
    })) as ModelMessage[];
    const providerOptions = reasoningProviderOptions(ctx.model, ctx.reasoning);

    log.debug(
      { model: ctx.model, primary: ctx.primarySkill, temperature: ctx.temperature, tools: registered.size },
      "orchestrator start",
    );

    try {
      const out = await this.agent.stream(messages, {
        requestContext,
        abortSignal,
        maxSteps: MAX_STEPS,
        modelSettings: { temperature: ctx.temperature },
        ...(providerOptions ? { providerOptions } : {}),
        // Gate the live tool set: load_skill + the loaded skills' tools (A2/decision #2).
        prepareStep: () => ({ activeTools: activeToolNames(loadedSkills, skillToolMap, registered) }),
      });

      // Drive the loop off fullStream (B2): reset the watchdog on EVERY chunk (incl.
      // tool steps), accumulate answer text, and surface tool activity as statuses.
      let acc = "";
      for await (const chunk of out.fullStream) {
        wd.reset();
        switch (chunk.type) {
          case "text-delta":
            acc += chunk.payload.text;
            onText?.(acc);
            break;
          case "tool-call":
            onTool?.onStart?.(chunk.payload.toolName);
            break;
          case "tool-result":
            onTool?.onFinish?.(chunk.payload.toolName);
            break;
          case "tool-error":
            // A tool threw: clear its "running" status so the Telegram spinner doesn't hang.
            onTool?.onFinish?.(chunk.payload.toolName);
            break;
          default:
            break;
        }
      }

      const cost = extractCost(await out.providerMetadata) ?? 0;
      // Strip tool-call syntax that leaked into the text (A8; parity with llm.ts:195).
      const { text } = stripLeakedToolCalls(acc);
      log.debug({ cost, loaded: [...loadedSkills] }, "orchestrator done");
      return { text, cost };
    } finally {
      wd.clear();
    }
  }
}
