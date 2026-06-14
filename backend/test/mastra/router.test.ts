import { describe, it, expect } from "vitest";
import {
  SkillRouter,
  normalizeRoutedSkills,
  type RouteModelFn,
  type ResolveInput,
} from "../../src/mastra/agents/router.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { ModelFactory } from "../../src/mastra/models.js";

const skills = [
  { name: "weather", description: "weather" },
  { name: "research", description: "research" },
  { name: "onboarding", description: "onboarding" },
];

const fakeSettings = {
  getModelRoles: async () => ({
    default: "",
    router: "openrouter:r",
    embedding: "",
    error_correction: "",
    speech: "",
    synthesizer: "",
  }),
} as unknown as SettingsService;

const fakeFactory = {} as ModelFactory;

function router(fn: RouteModelFn): SkillRouter {
  return new SkillRouter(fakeFactory, fakeSettings, fn);
}

const input = (onboarded: boolean): ResolveInput => ({
  onboarded,
  skills,
  recentMessages: [],
  userMessage: "what's the weather?",
  previousSkills: [],
});

describe("normalizeRoutedSkills", () => {
  const known = new Set(["weather", "research"]);
  it("keeps known skills", () => expect(normalizeRoutedSkills(["weather"], known)).toEqual(["weather"]));
  it("drops unknown -> research fallback", () => expect(normalizeRoutedSkills(["nope"], known)).toEqual(["research"]));
  it("empty -> research when present", () => expect(normalizeRoutedSkills([], known)).toEqual(["research"]));
  it("empty -> [] when research absent", () =>
    expect(normalizeRoutedSkills([], new Set(["weather"]))).toEqual([]));
  it("caps at 4", () =>
    expect(
      normalizeRoutedSkills(["a", "b", "c", "d", "e"], new Set(["a", "b", "c", "d", "e"])),
    ).toHaveLength(4));
});

describe("SkillRouter.resolveSkills", () => {
  it("forces onboarding when not onboarded (router not called)", async () => {
    let called = false;
    const r = router(async () => {
      called = true;
      return ["weather"];
    });
    expect(await r.resolveSkills(input(false))).toEqual(["onboarding"]);
    expect(called).toBe(false);
  });

  it("returns the routed known skill", async () => {
    const r = router(async () => ["weather"]);
    expect(await r.resolveSkills(input(true))).toEqual(["weather"]);
  });

  it("empty route -> research", async () => {
    const r = router(async () => []);
    expect(await r.resolveSkills(input(true))).toEqual(["research"]);
  });

  it("unknown skill -> research fallback", async () => {
    const r = router(async () => ["nonexistent"]);
    expect(await r.resolveSkills(input(true))).toEqual(["research"]);
  });

  it("model error -> research fallback", async () => {
    const r = router(async () => {
      throw new Error("boom");
    });
    expect(await r.resolveSkills(input(true))).toEqual(["research"]);
  });
});
