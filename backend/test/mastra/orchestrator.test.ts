import { describe, it, expect, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Orchestrator, type OrchestratorRunContext } from "../../src/mastra/agents/orchestrator.js";
import { formatSkillCatalog } from "../../src/services/skill-service.js";
import type { SkillService } from "../../src/services/skill-service.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { ModelFactory } from "../../src/mastra/models.js";
import type { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { Skill } from "../../src/domain/entities.js";

// --- mock model plumbing (no network) ---------------------------------------

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
  totalTokens: 8,
};
const finish = (unified: string) => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage: USAGE });

function textChunks(text: string) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finish("stop"),
  ];
}
function toolCallChunks(toolName: string, args: unknown) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: "tc1", toolName, input: JSON.stringify(args) },
    finish("tool-calls"),
  ];
}
function mockModel(perCall: unknown[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    modelId: "mock",
    doStream: async () => {
      const chunks = perCall[Math.min(call, perCall.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

// --- fake deps --------------------------------------------------------------

function skill(p: Partial<Skill> & { name: string }): Skill {
  return {
    name: p.name,
    description: p.description ?? p.name,
    allowedTools: p.allowedTools ?? [],
    model: p.model ?? "",
    temperature: p.temperature ?? null,
    reasoning: p.reasoning ?? null,
    routable: p.routable ?? true,
    prompt: p.prompt ?? `${p.name} body`,
    metadata: p.metadata ?? {},
  };
}

const SKILLS = [
  skill({ name: "research", allowedTools: ["web_search"], prompt: "RESEARCH" }),
  skill({ name: "currency", allowedTools: ["currency_rates"], prompt: "CURRENCY" }),
];

function fakeSkills(): SkillService {
  return {
    getAllSkills: async () => SKILLS,
    getSkillByName: async (n: string) => SKILLS.find((s) => s.name === n) ?? null,
    getSkillCatalog: async () =>
      formatSkillCatalog(SKILLS.map((s) => ({ name: s.name, description: s.description }))),
  } as unknown as SkillService;
}

const fakeSettings = {
  getTimeouts: async () => ({ llm_request: "300s", http_client: "300s", llm_activity: "30s" }),
} as unknown as SettingsService;

function orchestrator(model: MockLanguageModelV3) {
  const calls: string[] = [];
  const factory = {
    model: (ref: string) => {
      calls.push(ref);
      return model as never;
    },
  } as unknown as ModelFactory;
  const orch = new Orchestrator({ skills: fakeSkills(), settings: fakeSettings, factory });
  return { orch, calls };
}

function makeCtx(over: Partial<OrchestratorRunContext> = {}): OrchestratorRunContext {
  return {
    user: null,
    identity: null,
    memories: [],
    prompts: { soul: "SOUL", format: "FORMAT", integrity: "INTEGRITY" },
    history: [],
    summary: null,
    userMessage: "hi",
    primarySkill: "research",
    model: "openrouter:turn-model",
    temperature: 0.4,
    reasoning: null,
    mem: {} as unknown as MemoryService,
    userId: 1,
    chatId: 1,
    sessionId: 1,
    db: {} as never,
    settings: fakeSettings,
    skillsRoot: "/nonexistent-root",
    ...over,
  };
}

// --- tests ------------------------------------------------------------------

describe("Orchestrator", () => {
  it("streams an answer through the turn model with no network", async () => {
    const model = mockModel([textChunks("hello from orchestrator")]);
    const { orch, calls } = orchestrator(model);
    const seen: string[] = [];

    const r = await orch.run(makeCtx(), (acc) => seen.push(acc));

    expect(r.text).toBe("hello from orchestrator");
    expect(seen.at(-1)).toBe("hello from orchestrator");
    expect(calls).toContain("openrouter:turn-model"); // resolved via factory.model(ctx.model)
  });

  it("gates tools: load_skill widens the active set mid-turn", async () => {
    // step 1: model loads the currency skill; step 2: it answers.
    const model = mockModel([toolCallChunks("load_skill", { name: "currency" }), textChunks("done")]);
    const { orch } = orchestrator(model);

    const r = await orch.run(makeCtx({ primarySkill: "research" }));
    expect(r.text).toBe("done");

    const toolsAt = (i: number) => (model.doStreamCalls[i]?.tools ?? []).map((t) => t.name);
    // Step 0: primary=research → load_skill + web_search active, currency_rates NOT yet.
    expect(toolsAt(0)).toContain("load_skill");
    expect(toolsAt(0)).toContain("web_search");
    expect(toolsAt(0)).not.toContain("currency_rates");
    // After load_skill("currency"): currency_rates becomes active.
    expect(toolsAt(model.doStreamCalls.length - 1)).toContain("currency_rates");
  });

  it("strips tool-call syntax leaked into the answer text", async () => {
    const leaked = 'Answer.\nweb_search("x")\nEnd.';
    const model = mockModel([textChunks(leaked)]);
    const { orch } = orchestrator(model);

    const r = await orch.run(makeCtx());
    expect(r.text).not.toContain('web_search("x")');
    expect(r.text).toContain("Answer.");
    expect(r.text).toContain("End.");
  });
});
