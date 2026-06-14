import { describe, it, expect } from "vitest";
import { ModelFactory, parseModelRef } from "../../src/mastra/models.js";

describe("parseModelRef", () => {
  it("splits provider:model on the first colon", () => {
    expect(parseModelRef("openrouter:google/gemini-3.1-flash-lite")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.1-flash-lite",
    });
    expect(parseModelRef("zai:glm-5")).toEqual({ provider: "zai", modelId: "glm-5" });
  });
  it("defaults to openrouter when there is no prefix", () => {
    expect(parseModelRef("some-model")).toEqual({ provider: "openrouter", modelId: "some-model" });
  });
});

describe("ModelFactory", () => {
  const f = new ModelFactory({
    apiKeys: { openrouter: "k", zai: "k", xai: "k", openai: "k", google: "k" },
  });

  it("builds a model for each provider with the right modelId", () => {
    expect(f.model("openrouter:google/gemini-3.1-flash-lite").modelId).toBe(
      "google/gemini-3.1-flash-lite",
    );
    expect(f.model("zai:glm-5").modelId).toBe("glm-5");
    expect(f.model("xai:grok-2").modelId).toBe("grok-2");
    expect(f.model("openai:gpt-4o").modelId).toBe("gpt-4o");
    expect(f.model("google:gemini-1.5-pro").modelId).toBe("gemini-1.5-pro");
  });

  it("defaults to openrouter without a prefix", () => {
    expect(f.model("plain-model").modelId).toBe("plain-model");
  });

  it("throws on an unknown provider", () => {
    expect(() => f.model("nope:x")).toThrow(/unknown provider/);
  });
});
