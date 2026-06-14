import type { StreamCallback } from "../llm.js";
import { LlmService } from "../llm.js";
import { MemoryService, type StoredMemory } from "../memory/memory-service.js";
import type { Message, Skill, User, BotIdentity } from "../../domain/entities.js";
import { resolveTools } from "../tools/registry.js";
import { LoopGuard } from "./loop-guard.js";
import { buildSystemPrompt, buildSubAgentPrompt } from "./prompt-builder.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "skill-agent" });

/** Everything a skill agent needs that comes from the surrounding conversation. */
export interface SkillRunContext {
  user: User | null;
  identity: BotIdentity | null;
  memories: StoredMemory[];
  prompts: { soul: string; format: string; integrity: string };
  /** Recent dialogue history BEFORE the current turn (current message is appended internally). */
  history: Message[];
  userMessage: string;
  mem: MemoryService;
  userId: number;
  /** roles.default — used when the skill does not pin its own model. */
  defaultModel: string;
  /** agent.default_temperature — used when the skill leaves temperature null. */
  defaultTemperature: number;
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
): Promise<string> {
  const model = resolveModel(skill, ctx);
  const temperature = resolveTemperature(skill, ctx);
  const tools = resolveTools(skill.allowedTools, { mem: ctx.mem, userId: ctx.userId });
  const system = buildSystemPrompt({
    prompts: ctx.prompts,
    user: ctx.user,
    memories: ctx.memories,
    skill: promptSkill(skill),
    identity: ctx.identity,
  });
  const messages: Message[] = [...ctx.history, { role: "user", content: ctx.userMessage }];

  log.debug(
    { skill: skill.name, model, temperature, tools: Object.keys(tools), mode: "single" },
    "skill agent start",
  );
  const res = await deps.llm.stream(
    { model, system, messages, tools, temperature, reasoning: skill.reasoning ?? null },
    onText,
  );
  log.debug({ skill: skill.name, cost: res.cost, finishReason: res.finishReason }, "skill agent done");
  return res.text;
}

/**
 * Run a single skill as a sub-agent for the multi-skill path (no streaming).
 * Uses the stripped sub-agent prompt (no SOUL/FORMAT) and is guarded against loops.
 */
export async function runSkillSubAgent(
  deps: SkillAgentDeps,
  skill: Skill,
  ctx: SkillRunContext,
): Promise<string> {
  deps.loopGuard.check(skill.name, ctx.userMessage);

  const model = resolveModel(skill, ctx);
  const temperature = resolveTemperature(skill, ctx);
  const tools = resolveTools(skill.allowedTools, { mem: ctx.mem, userId: ctx.userId });
  const system = buildSubAgentPrompt({
    prompts: { integrity: ctx.prompts.integrity },
    user: ctx.user,
    memories: ctx.memories,
    skill: promptSkill(skill),
  });
  const messages: Message[] = [{ role: "user", content: ctx.userMessage }];

  log.debug(
    { skill: skill.name, model, temperature, tools: Object.keys(tools), mode: "sub" },
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
  return res.text;
}
