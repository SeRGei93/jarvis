import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildSubAgentPrompt,
  buildSynthesizerPrompt,
  SECURITY_INSTRUCTION,
  type PromptSkill,
} from "../../src/mastra/agents/prompt-builder.js";
import type { User, BotIdentity } from "../../src/domain/entities.js";
import type { StoredMemory } from "../../src/mastra/memory/memory-service.js";

const NOW = new Date("2025-06-02T12:00:00Z");

const user: User = {
  id: 1,
  name: "Alex",
  displayName: "",
  city: "Minsk",
  timezone: "Europe/Minsk",
  language: "ru",
  onboarded: true,
};

const skill: PromptSkill = { name: "research", prompt: "Be a researcher.", allowedTools: ["web_search"] };
const noToolSkill: PromptSkill = { name: "chat", prompt: "Small talk.", allowedTools: [] };

function mem(partial: Partial<StoredMemory>): StoredMemory {
  return {
    id: 1,
    userId: 1,
    category: "fact",
    scope: "permanent",
    sessionId: null,
    content: "likes tea",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...partial,
  } as StoredMemory;
}

const corePrompts = { soul: "SOUL_BODY", format: "FORMAT_BODY", integrity: "INTEGRITY_BODY" };

describe("buildSystemPrompt", () => {
  it("emits all sections in Go-parity order", () => {
    const out = buildSystemPrompt({
      prompts: corePrompts,
      user,
      memories: [mem({})],
      skill,
      identity: { userId: 1, botName: "Jarvis", vibe: "dry wit", systemPromptOverride: "" },
      now: NOW,
    });
    // NB: the security preamble itself mentions "[USER CONTEXT]" and
    // "[KNOWLEDGE ABOUT USER]", so we anchor on section-unique content instead.
    const order = [
      SECURITY_INSTRUCTION.split("\n")[0]!,
      "SOUL_BODY",
      "[CAPABILITIES]",
      "Name: Alex",
      "- [fact] likes tea",
      "[DATA INTEGRITY]",
      "[SKILL: research]",
      "[MESSAGE FORMATTING]",
      "[CURRENT DATE & TIME]",
    ];
    const positions = order.map((s) => out.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("omits DATA INTEGRITY when the skill has no tools", () => {
    const out = buildSystemPrompt({ prompts: corePrompts, user, skill: noToolSkill, now: NOW });
    expect(out).not.toContain("[DATA INTEGRITY]");
    expect(out).toContain("[SKILL: chat]");
  });

  it("omits KNOWLEDGE and CAPABILITIES when memories/identity are absent", () => {
    const out = buildSystemPrompt({ prompts: corePrompts, user, skill, now: NOW });
    // "[KNOWLEDGE ABOUT USER]" appears inside the security preamble, so check for
    // the actual section header (followed by a newline) instead.
    expect(out).not.toContain("[KNOWLEDGE ABOUT USER]\n");
    expect(out).not.toContain("[CAPABILITIES]");
    expect(out).toContain("SOUL_BODY");
  });

  it("uses the identity prompt override instead of SOUL when present", () => {
    const identity: BotIdentity = {
      userId: 1,
      botName: "",
      vibe: "",
      systemPromptOverride: "OVERRIDE_PERSONALITY",
    };
    const out = buildSystemPrompt({ prompts: corePrompts, user, skill, identity, now: NOW });
    expect(out).toContain("OVERRIDE_PERSONALITY");
    expect(out).not.toContain("SOUL_BODY");
  });

  it("adds a (learned …) suffix only for reflection/strategy memories", () => {
    const out = buildSystemPrompt({
      prompts: corePrompts,
      user,
      memories: [
        mem({ category: "fact", content: "drinks tea" }),
        mem({ category: "reflection", content: "prefers brevity", createdAt: new Date("2025-03-04T00:00:00Z") }),
      ],
      skill,
      now: NOW,
    });
    expect(out).toContain("- [fact] drinks tea");
    expect(out).toContain("- [reflection] prefers brevity (learned 2025-03-04)");
  });

  it("falls back to UTC for an invalid timezone", () => {
    const out = buildSystemPrompt({
      prompts: corePrompts,
      user: { ...user, timezone: "Not/AZone" },
      skill,
      now: NOW,
    });
    expect(out).toContain("[CURRENT DATE & TIME]");
  });
});

describe("buildSubAgentPrompt", () => {
  it("drops SOUL, CAPABILITIES and FORMAT", () => {
    const out = buildSubAgentPrompt({
      prompts: { integrity: "INTEGRITY_BODY" },
      user,
      memories: [mem({})],
      skill,
      now: NOW,
    });
    expect(out).toContain("[SKILL: research]");
    expect(out).toContain("[DATA INTEGRITY]");
    expect(out).toContain("[USER CONTEXT]");
    expect(out).not.toContain("SOUL_BODY");
    expect(out).not.toContain("[CAPABILITIES]");
    expect(out).not.toContain("[MESSAGE FORMATTING]");
  });
});

describe("buildSynthesizerPrompt", () => {
  it("includes SYNTHESIS RULES and a [SKILL RESULTS] block keyed by skill name", () => {
    const out = buildSynthesizerPrompt({
      prompts: { soul: "SOUL_BODY", format: "FORMAT_BODY", synthesizer: "MERGE_RULES" },
      user,
      skillResults: { weather: "sunny", news: "all quiet" },
      now: NOW,
    });
    expect(out).toContain("[SYNTHESIS RULES]");
    expect(out).toContain("MERGE_RULES");
    expect(out).toContain("[SKILL RESULTS]");
    expect(out).toContain("## weather\nsunny");
    expect(out).toContain("## news\nall quiet");
  });
});
