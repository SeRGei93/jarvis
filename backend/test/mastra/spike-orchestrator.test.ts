import { describe, it, expect, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  createSpikeOrchestrator,
  runSpike,
  type SpikeModelResolver,
} from "../../src/mastra/agents/_spike-orchestrator.js";

// --- mock model plumbing (no network) ---------------------------------------

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
  totalTokens: 8,
};

const finish = (unified: string) => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified },
  usage: USAGE,
});

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
    {
      type: "tool-call",
      toolCallId: "tc1",
      toolName,
      input: JSON.stringify(args),
    },
    finish("tool-calls"),
  ];
}

/** Build a mock model whose doStream returns one result per call (step). */
function mockModel(modelId: string, perCallChunks: unknown[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    modelId,
    doStream: async () => {
      const chunks = perCallChunks[Math.min(call, perCallChunks.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

/** Fake factory: memoizes per ref so doStream call-counters survive re-resolution. */
function fakeFactory(perRefChunks: (ref: string) => unknown[][]) {
  const calls: string[] = [];
  const cache = new Map<string, MockLanguageModelV3>();
  const factory: SpikeModelResolver = {
    model(ref: string) {
      calls.push(ref);
      let m = cache.get(ref);
      if (!m) {
        m = mockModel(ref, perRefChunks(ref));
        cache.set(ref, m);
      }
      return m as never;
    },
  };
  return { factory, calls };
}

function fakeSettings() {
  return {
    getModelRoles: vi.fn(async () => ({
      default: "openrouter:default-model",
      router: "",
      error_correction: "",
      speech: "",
      synthesizer: "",
    })),
    getAgent: vi.fn(async () => ({ max_history: 50, default_temperature: 0.4, auto_memory: true })),
  };
}

// --- tests ------------------------------------------------------------------

describe("spike orchestrator (S1 go/no-go)", () => {
  it("(a,b,c) streams with dynamic config + a per-request factory model, no network", async () => {
    const { factory, calls } = fakeFactory(() => [textChunks("hello from the spike")]);
    const settings = fakeSettings();
    const agent = createSpikeOrchestrator({ factory, settings });

    const seen: string[] = [];
    const r1 = await runSpike(agent, {
      userMessage: "hi",
      modelRef: "openrouter:model-a",
      primarySkill: "research",
      onText: (acc) => seen.push(acc),
    });
    expect(r1.text).toBe("hello from the spike");
    expect(seen.at(-1)).toBe("hello from the spike"); // onText fired (streamed)

    // (a) config came from SettingsService, resolved per request.
    expect(settings.getModelRoles).toHaveBeenCalled();
    expect(settings.getAgent).toHaveBeenCalled();

    // (c) model changes per request — second turn resolves a different ref.
    await runSpike(agent, {
      userMessage: "again",
      modelRef: "openrouter:model-b",
      primarySkill: "research",
    });
    expect(calls).toContain("openrouter:model-a");
    expect(calls).toContain("openrouter:model-b");
  });

  it("(d) prepareStep->activeTools gating widens after load_skill mutates the set", async () => {
    // step 1: model calls load_skill("currency"); step 2: it answers.
    const { factory } = fakeFactory(() => [
      toolCallChunks("load_skill", { name: "currency" }),
      textChunks("converted for you"),
    ]);
    const agent = createSpikeOrchestrator({ factory, settings: fakeSettings() });

    const r = await runSpike(agent, {
      userMessage: "what's the dollar rate?",
      modelRef: "openrouter:model-a",
      primarySkill: "research",
    });

    expect(r.text).toBe("converted for you");
    // At least 2 steps ran (tool-call step + answer step).
    expect(r.activeToolsPerStep.length).toBeGreaterThanOrEqual(2);

    const first = r.activeToolsPerStep[0];
    const last = r.activeToolsPerStep.at(-1)!;
    // Before load_skill: only load_skill + the primary skill's tools (research -> web_search).
    expect(first).toContain("load_skill");
    expect(first).toContain("web_search");
    expect(first).not.toContain("currency_rates");
    // After load_skill("currency"): currency_rates becomes active (the linchpin).
    expect(last).toContain("currency_rates");
  });

  it("(e) strips leaked tool-calls post-stream and runs the output-processor pipeline", async () => {
    const leaked = "Here is the answer.\nweb_search(\"belarus news\")\nThat's all.";
    const { factory } = fakeFactory(() => [textChunks(leaked)]);
    const agent = createSpikeOrchestrator({ factory, settings: fakeSettings() });

    const r = await runSpike(agent, {
      userMessage: "news?",
      modelRef: "openrouter:model-a",
      primarySkill: "research",
    });

    expect(r.processorRan).toBe(true); // (e) agent output-processor pipeline ran
    expect(r.stripped).toBeGreaterThanOrEqual(1); // post-stream strip removed the leak
    expect(r.text).not.toContain('web_search("belarus news")');
    expect(r.text).toContain("Here is the answer.");
    expect(r.text).toContain("That's all.");
  });
});
