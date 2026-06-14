import { describe, it, expect, vi } from "vitest";
import { synthesize, SYNTHESIZER_TEMPERATURE, type SynthesizeContext } from "../../src/mastra/agents/synthesizer.js";
import type { LlmService, LlmCallOptions, LlmResult } from "../../src/mastra/llm.js";

function fakeLlm() {
  const calls: LlmCallOptions[] = [];
  const result: LlmResult = { text: "MERGED", finishReason: "stop" };
  const llm = {
    stream: vi.fn(async (opts: LlmCallOptions, onText?: (s: string) => void) => {
      calls.push(opts);
      onText?.("MERGED");
      return result;
    }),
  } as unknown as LlmService;
  return { llm, calls };
}

function makeCtx(over: Partial<SynthesizeContext> = {}): SynthesizeContext {
  return {
    user: null,
    identity: null,
    memories: [],
    prompts: { soul: "SOUL", format: "FORMAT", synthesizer: "MERGE_RULES" },
    history: [],
    userMessage: "weather and news",
    synthesizerModel: "openrouter:synth",
    sessionModel: "openrouter:session",
    ...over,
  };
}

describe("synthesize", () => {
  it("streams a merged answer with the synthesizer model and temp 0.3", async () => {
    const { llm, calls } = fakeLlm();
    const onText = vi.fn();
    const text = await synthesize(llm, { weather: "sunny", news: "quiet" }, makeCtx(), onText);

    expect(text).toBe("MERGED");
    expect(onText).toHaveBeenCalledWith("MERGED");
    expect(calls[0]!.model).toBe("openrouter:synth");
    expect(calls[0]!.temperature).toBe(SYNTHESIZER_TEMPERATURE);
    expect(calls[0]!.tools).toBeUndefined(); // no tools for synthesis
    expect(calls[0]!.system).toContain("[SKILL RESULTS]");
    expect(calls[0]!.system).toContain("## weather\nsunny");
  });

  it("falls back to the session model when no synthesizer role is set", async () => {
    const { llm, calls } = fakeLlm();
    await synthesize(llm, { a: "x" }, makeCtx({ synthesizerModel: "" }));
    expect(calls[0]!.model).toBe("openrouter:session");
  });
});
