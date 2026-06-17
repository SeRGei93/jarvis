import { describe, it, expect } from "vitest";
import {
  PrimarySkillSelector,
  normalizePrimary,
  resolveTurnConfig,
  type SelectPrimaryFn,
  type PrimaryInput,
} from "../../src/mastra/agents/primary-skill.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { ModelFactory } from "../../src/mastra/models.js";
import type { Skill } from "../../src/domain/entities.js";

const skills = [
  { name: "weather", description: "weather" },
  { name: "research", description: "research" },
  { name: "onboarding", description: "onboarding" },
];

const fakeSettings = {
  getModelRoles: async () => ({
    default: "openrouter:d",
    router: "openrouter:r",
    error_correction: "",
    speech: "",
    synthesizer: "",
  }),
} as unknown as SettingsService;

const fakeFactory = {} as ModelFactory;

function selector(fn: SelectPrimaryFn): PrimarySkillSelector {
  return new PrimarySkillSelector(fakeFactory, fakeSettings, fn);
}

const input = (onboarded: boolean, over: Partial<PrimaryInput> = {}): PrimaryInput => ({
  onboarded,
  skills,
  recentMessages: [],
  userMessage: "what's the weather?",
  previousSkills: [],
  ...over,
});

function skill(partial: Partial<Skill> & { name: string }): Skill {
  return {
    name: partial.name,
    description: partial.description ?? "",
    allowedTools: partial.allowedTools ?? [],
    model: partial.model ?? "",
    temperature: partial.temperature ?? null,
    reasoning: partial.reasoning ?? null,
    routable: partial.routable ?? true,
    prompt: partial.prompt ?? "",
    metadata: partial.metadata ?? {},
  };
}

describe("normalizePrimary", () => {
  const known = new Set(["weather", "research"]);
  it("keeps a known skill", () => expect(normalizePrimary("weather", known)).toBe("weather"));
  it("unknown -> research", () => expect(normalizePrimary("nope", known)).toBe("research"));
  it("empty -> research when present", () => expect(normalizePrimary("", known)).toBe("research"));
  it("empty -> '' when research absent", () =>
    expect(normalizePrimary("", new Set(["weather"]))).toBe(""));
});

describe("resolveTurnConfig", () => {
  const opts = { defaultModel: "openrouter:default", defaultTemperature: 0.4 };

  it("session.model overrides the skill model", () => {
    const cfg = resolveTurnConfig(skill({ name: "cars", model: "openrouter:skill" }), {
      ...opts,
      sessionModel: "openrouter:session",
    });
    expect(cfg).toEqual({
      skill: "cars",
      model: "openrouter:session",
      temperature: 0.4,
      reasoning: null,
    });
  });

  it("falls back skill.model then default; carries temperature/reasoning", () => {
    expect(
      resolveTurnConfig(skill({ name: "cars", model: "openrouter:skill", temperature: 0.2, reasoning: true }), opts),
    ).toEqual({ skill: "cars", model: "openrouter:skill", temperature: 0.2, reasoning: true });

    expect(resolveTurnConfig(skill({ name: "chat" }), opts)).toEqual({
      skill: "chat",
      model: "openrouter:default",
      temperature: 0.4,
      reasoning: null,
    });
  });

  it("blank session.model is treated as unset", () => {
    const cfg = resolveTurnConfig(skill({ name: "chat", model: "openrouter:skill" }), {
      ...opts,
      sessionModel: "  ",
    });
    expect(cfg.model).toBe("openrouter:skill");
  });

  it("no skill -> empty name and default model", () => {
    expect(resolveTurnConfig(null, opts)).toEqual({
      skill: "",
      model: "openrouter:default",
      temperature: 0.4,
      reasoning: null,
    });
  });
});

describe("PrimarySkillSelector.selectPrimary", () => {
  it("forces onboarding when not onboarded (model not called)", async () => {
    let called = false;
    const s = selector(async () => {
      called = true;
      return "weather";
    });
    expect(await s.selectPrimary(input(false))).toBe("onboarding");
    expect(called).toBe(false);
  });

  it("returns the chosen known skill", async () => {
    const s = selector(async () => "weather");
    expect(await s.selectPrimary(input(true))).toBe("weather");
  });

  it("unknown choice -> research fallback", async () => {
    const s = selector(async () => "nonexistent");
    expect(await s.selectPrimary(input(true))).toBe("research");
  });

  it("model error -> research fallback", async () => {
    const s = selector(async () => {
      throw new Error("boom");
    });
    expect(await s.selectPrimary(input(true))).toBe("research");
  });

  it("passes previous skills + uses the router model role for follow-up continuity", async () => {
    let seenModel = "";
    let seenPrompt = "";
    const s = selector(async (modelRef, _system, prompt) => {
      seenModel = modelRef;
      seenPrompt = prompt;
      return "weather";
    });
    await s.selectPrimary(input(true, { previousSkills: ["weather"], userMessage: "and tomorrow?" }));
    expect(seenModel).toBe("openrouter:r"); // roles.router
    expect(seenPrompt).toContain("weather"); // previousSkills surfaced to the model
    expect(seenPrompt).toContain("and tomorrow?");
  });
});
