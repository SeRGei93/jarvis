import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import type { StreamCallback } from "../llm.js";
import { LlmService } from "../llm.js";
import { MemoryService, type StoredMemory } from "../memory/memory-service.js";
import type { Message, Skill, User, BotIdentity } from "../../domain/entities.js";
import type { SettingsService } from "../../config/settings.js";
import { resolveTools } from "../tools/registry.js";
import { listReferences } from "../tools/skill-ref.js";
import { LoopGuard } from "./loop-guard.js";
import { buildSystemPrompt, buildSubAgentPrompt } from "./prompt-builder.js";
import { logger } from "../../pkg/logger.js";

/** A skill agent's answer plus the LLM cost it incurred (for usage accounting, M5). */
export interface SkillRunResult {
  text: string;
  cost: number;
}

const log = logger.child({ mod: "skill-agent" });

type Db = LibSQLDatabase<typeof schema>;

/** Everything a skill agent needs that comes from the surrounding conversation. */
export interface SkillRunContext {
  user: User | null;
  identity: BotIdentity | null;
  memories: StoredMemory[];
  prompts: { soul: string; format: string; integrity: string };
  /** Recent dialogue history BEFORE the current turn (current message is appended internally). */
  history: Message[];
  /** Rolling summary of dialogue history evicted beyond the live window (null when none). */
  summary?: string | null;
  userMessage: string;
  mem: MemoryService;
  userId: number;
  /** roles.default — used when the skill does not pin its own model. */
  defaultModel: string;
  /** agent.default_temperature — used when the skill leaves temperature null. */
  defaultTemperature: number;
  // ── tool context (M5): threaded into resolveTools for built-in tools ──
  chatId: number;
  sessionId: number;
  db: Db;
  settings: SettingsService;
  /** Optional override for the skill-references filesystem root (Task 6). */
  skillsRoot?: string;
}

export interface SkillAgentDeps {
  llm: LlmService;
  loopGuard: LoopGuard;
}

function resolveModel(skill: Skill, ctx: SkillRunContext): string {
  return skill.model || ctx.defaultModel;
}

function resolveTemperature(skill: Skill, ctx: SkillRunContext): number {
  return skill.temperature ?? ctx.defaultTemperature;
}

function promptSkill(skill: Skill) {
  return { name: skill.name, prompt: skill.prompt, allowedTools: skill.allowedTools };
}

/**
 * Run a single skill directly and stream the answer to the user (single-skill path).
 * Uses the full system prompt (SOUL/CAPABILITIES/FORMAT) and the skill's tools.
 */
export async function runSkillStreaming(
  deps: SkillAgentDeps,
  skill: Skill,
  ctx: SkillRunContext,
  onText?: StreamCallback,
): Promise<SkillRunResult> {
  const model = resolveModel(skill, ctx);
  const temperature = resolveTemperature(skill, ctx);
  const tools = resolveTools(skill.allowedTools, ctx);
  const references = listReferences(skill.name, ctx.skillsRoot);
  const system = buildSystemPrompt({
    prompts: ctx.prompts,
    user: ctx.user,
    memories: ctx.memories,
    skill: promptSkill(skill),
    identity: ctx.identity,
    references,
    summary: ctx.summary,
  });
  const messages: Message[] = [...ctx.history, { role: "user", content: ctx.userMessage }];

  log.debug(
    { skill: skill.name, model, temperature, tools: Object.keys(tools), refs: references.length, mode: "single" },
    "skill agent start",
  );
  const res = await deps.llm.stream(
    { model, system, messages, tools, temperature, reasoning: skill.reasoning ?? null },
    onText,
  );
  log.debug({ skill: skill.name, cost: res.cost, finishReason: res.finishReason }, "skill agent done");
  return { text: res.text, cost: res.cost ?? 0 };
}

/**
 * Run a single skill as a sub-agent for the multi-skill path (no streaming).
 * Uses the stripped sub-agent prompt (no SOUL/FORMAT) and is guarded against loops.
 */
export async function runSkillSubAgent(
  deps: SkillAgentDeps,
  skill: Skill,
  ctx: SkillRunContext,
): Promise<SkillRunResult> {
  deps.loopGuard.check(skill.name, ctx.userMessage);

  const model = resolveModel(skill, ctx);
  const temperature = resolveTemperature(skill, ctx);
  const tools = resolveTools(skill.allowedTools, ctx);
  const references = listReferences(skill.name, ctx.skillsRoot);
  const system = buildSubAgentPrompt({
    prompts: { integrity: ctx.prompts.integrity },
    user: ctx.user,
    memories: ctx.memories,
    skill: promptSkill(skill),
    references,
    summary: ctx.summary,
  });
  // Include dialogue history so multi-skill sub-agents have the same conversation
  // context as the single-skill path — otherwise follow-ups lose context (T4).
  const messages: Message[] = [...ctx.history, { role: "user", content: ctx.userMessage }];

  log.debug(
    { skill: skill.name, model, temperature, tools: Object.keys(tools), refs: references.length, history: ctx.history.length, mode: "sub" },
    "skill agent start",
  );
  const res = await deps.llm.generate({
    model,
    system,
    messages,
    tools,
    temperature,
    reasoning: skill.reasoning ?? null,
  });
  log.debug({ skill: skill.name, cost: res.cost, finishReason: res.finishReason }, "skill agent done");
  return { text: res.text, cost: res.cost ?? 0 };
}
