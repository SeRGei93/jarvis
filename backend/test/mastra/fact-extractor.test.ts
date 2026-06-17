import { describe, it, expect } from "vitest";
import { FactExtractor, type FactExtractFn } from "../../src/mastra/memory/fact-extractor.js";
import type { ModelFactory } from "../../src/mastra/models.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { Message } from "../../src/domain/entities.js";

const settings = {
  getModelRoles: async () => ({
    default: "openrouter:default",
    router: "openrouter:router",
    error_correction: "",
    speech: "",
    synthesizer: "",
  }),
} as unknown as SettingsService;
const factory = {} as ModelFactory;

describe("FactExtractor", () => {
  it("uses the injected extractFn with the default model role", async () => {
    let usedRef = "";
    let seen: Message[] = [];
    const fn: FactExtractFn = async (ref, messages) => {
      usedRef = ref;
      seen = messages;
      return { facts: [{ category: "preference", content: "likes oat milk" }] };
    };
    const ex = new FactExtractor(factory, settings, fn);
    const turn: Message[] = [
      { role: "user", content: "I only drink oat milk" },
      { role: "assistant", content: "Noted." },
    ];

    const out = await ex.extract(turn);

    expect(usedRef).toBe("openrouter:default");
    expect(seen).toEqual(turn);
    expect(out.facts).toEqual([{ category: "preference", content: "likes oat milk" }]);
  });

  it("returns an empty list when nothing durable is found", async () => {
    const ex = new FactExtractor(factory, settings, async () => ({ facts: [] }));
    const out = await ex.extract([{ role: "user", content: "ok thanks" }]);
    expect(out.facts).toEqual([]);
  });
});
