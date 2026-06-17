import { describe, it, expect, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import {
  buildLoadSkillTool,
  buildSkillToolMap,
  activeToolNames,
  LOAD_SKILL_TOOL_NAME,
  LOADED_SKILLS_KEY,
} from "../../src/mastra/tools/load-skill.js";
import type { SkillService } from "../../src/services/skill-service.js";
import type { Skill } from "../../src/domain/entities.js";

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

function fakeSkills(skills: Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    getSkillByName: vi.fn(async (name: string) => byName.get(name) ?? null),
  } as unknown as SkillService;
}

function ctxWith(loaded: Set<string>) {
  return { requestContext: new RequestContext([[LOADED_SKILLS_KEY, loaded]]) };
}

describe("load_skill tool", () => {
  it("returns the skill instructions/tools and records it in the loaded set", async () => {
    const skills = fakeSkills([
      skill({ name: "currency", allowedTools: ["currency_rates"], prompt: "CURRENCY BODY" }),
    ]);
    const tool = buildLoadSkillTool({ skills, skillsRoot: "/nonexistent-root" });
    const loaded = new Set<string>();

    const res = await tool.execute!({ name: "currency" }, ctxWith(loaded) as never);

    expect(res.loaded).toBe(true);
    expect(res.name).toBe("currency");
    expect(res.instructions).toBe("CURRENCY BODY");
    expect(res.tools).toEqual(["currency_rates"]);
    expect(res.references).toEqual([]); // no refs dir on a missing root
    expect(loaded.has("currency")).toBe(true);
  });

  it("reports an unknown skill without mutating the loaded set", async () => {
    const skills = fakeSkills([skill({ name: "currency" })]);
    const tool = buildLoadSkillTool({ skills, skillsRoot: "/nonexistent-root" });
    const loaded = new Set<string>();

    const res = await tool.execute!({ name: "nope" }, ctxWith(loaded) as never);

    expect(res.loaded).toBe(false);
    expect(res.error).toMatch(/unknown skill/);
    expect(loaded.size).toBe(0);
  });
});

describe("buildSkillToolMap", () => {
  it("maps skill name to its allowed-tools", () => {
    const map = buildSkillToolMap([
      skill({ name: "research", allowedTools: ["web_search", "fetch_url"] }),
      skill({ name: "currency", allowedTools: ["currency_rates"] }),
    ]);
    expect(map.get("research")).toEqual(["web_search", "fetch_url"]);
    expect(map.get("currency")).toEqual(["currency_rates"]);
  });
});

describe("activeToolNames", () => {
  const skillTools = new Map<string, string[]>([
    ["research", ["web_search", "fetch_url"]],
    ["currency", ["currency_rates"]],
  ]);
  const registered = new Set(["web_search", "fetch_url", "currency_rates"]);

  it("always includes load_skill plus the loaded skills' registered tools", () => {
    const active = activeToolNames(new Set(["research"]), skillTools, registered);
    expect(active).toContain(LOAD_SKILL_TOOL_NAME);
    expect(active).toContain("web_search");
    expect(active).toContain("fetch_url");
    expect(active).not.toContain("currency_rates");
  });

  it("widens as more skills load", () => {
    const active = activeToolNames(new Set(["research", "currency"]), skillTools, registered);
    expect(active.sort()).toEqual(
      [LOAD_SKILL_TOOL_NAME, "currency_rates", "fetch_url", "web_search"].sort(),
    );
  });

  it("drops tools that are not registered on the orchestrator", () => {
    const active = activeToolNames(
      new Set(["research"]),
      new Map([["research", ["web_search", "ghost_tool"]]]),
      registered,
    );
    expect(active).toContain("web_search");
    expect(active).not.toContain("ghost_tool");
  });
});
