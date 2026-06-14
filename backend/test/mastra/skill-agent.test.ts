import { describe, it, expect, vi } from "vitest";
import {
  runSkillStreaming,
  runSkillSubAgent,
  type SkillRunContext,
} from "../../src/mastra/agents/skill-agent.js";
import { LoopGuard, LoopGuardError } from "../../src/mastra/agents/loop-guard.js";
import type { LlmService, LlmCallOptions, LlmResult } from "../../src/mastra/llm.js";
import type { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { Skill } from "../../src/domain/entities.js";

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    name: "research",
    description: "research",
    allowedTools: [],
    model: "",
    temperature: null,
    reasoning: null,
    routable: true,
    prompt: "Be a researcher.",
    metadata: {},
    ...over,
  };
}

function makeCtx(over: Partial<SkillRunContext> = {}): SkillRunContext {
  return {
    user: null,
    identity: null,
    memories: [],
    prompts: { soul: "SOUL", format: "FORMAT", integrity: "INTEGRITY" },
    history: [{ role: "user", content: "earlier" }],
    userMessage: "find cats",
    mem: {} as unknown as MemoryService,
    userId: 1,
    defaultModel: "openrouter:default",
    defaultTemperature: 0.4,
    ...over,
  };
}

/** Fake LlmService that records the last options it was called with. */
function fakeLlm() {
  const calls: { method: "stream" | "generate"; opts: LlmCallOptions }[] = [];
  const result: LlmResult = { text: "ANSWER", cost: 0.001, finishReason: "stop" };
  const llm = {
    stream: vi.fn(async (opts: LlmCallOptions, onText?: (s: string) => void) => {
      calls.push({ method: "stream", opts });
      onText?.("ANSWER");
      return result;
    }),
    generate: vi.fn(async (opts: LlmCallOptions) => {
      calls.push({ method: "generate", opts });
      return result;
    }),
  } as unknown as LlmService;
  return { llm, calls };
}

describe("runSkillStreaming (single-skill path)", () => {
  it("streams with the full system prompt and history + current message", async () => {
    const { llm, calls } = fakeLlm();
    const deps = { llm, loopGuard: new LoopGuard(() => 0) };
    const onText = vi.fn();

    const text = await runSkillStreaming(deps, makeSkill(), makeCtx(), onText);

    expect(text).toBe("ANSWER");
    expect(onText).toHaveBeenCalledWith("ANSWER");
    const { method, opts } = calls[0]!;
    expect(method).toBe("stream");
    expect(opts.system).toContain("[SKILL: research]");
    expect(opts.system).toContain("[MESSAGE FORMATTING]"); // full prompt keeps FORMAT
    expect(opts.messages.map((m) => m.content)).toEqual(["earlier", "find cats"]);
    expect(opts.temperature).toBe(0.4); // skill.temperature null -> default
    expect(opts.model).toBe("openrouter:default"); // skill.model "" -> default
  });

  it("honours the skill's own model and temperature when set", async () => {
    const { llm, calls } = fakeLlm();
    const deps = { llm, loopGuard: new LoopGuard(() => 0) };
    await runSkillStreaming(deps, makeSkill({ model: "openrouter:custom", temperature: 0.1 }), makeCtx());
    expect(calls[0]!.opts.model).toBe("openrouter:custom");
    expect(calls[0]!.opts.temperature).toBe(0.1);
  });
});

describe("runSkillSubAgent (multi-skill leg)", () => {
  it("generates with the stripped sub-agent prompt and only the current message", async () => {
    const { llm, calls } = fakeLlm();
    const deps = { llm, loopGuard: new LoopGuard(() => 0) };

    const text = await runSkillSubAgent(deps, makeSkill(), makeCtx());

    expect(text).toBe("ANSWER");
    const { method, opts } = calls[0]!;
    expect(method).toBe("generate");
    expect(opts.system).toContain("[SKILL: research]");
    expect(opts.system).not.toContain("[MESSAGE FORMATTING]"); // sub-agent drops FORMAT
    expect(opts.system).not.toContain("SOUL");
    expect(opts.messages.map((m) => m.content)).toEqual(["find cats"]); // no history
  });

  it("blocks a third identical sub-agent run via the loop guard", async () => {
    const { llm } = fakeLlm();
    const deps = { llm, loopGuard: new LoopGuard(() => 0) };
    await runSkillSubAgent(deps, makeSkill(), makeCtx());
    await runSkillSubAgent(deps, makeSkill(), makeCtx());
    await expect(runSkillSubAgent(deps, makeSkill(), makeCtx())).rejects.toBeInstanceOf(LoopGuardError);
  });
});
