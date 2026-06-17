import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { SkillService } from "../../services/skill-service.js";
import type { Skill } from "../../domain/entities.js";
import { listReferences } from "./skill-ref.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "tool-load-skill" });

/** The orchestrator's always-on tool name. */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/**
 * RequestContext key holding the per-request mutable set of loaded skill names.
 * `load_skill` widens it; the orchestrator's `prepareStep` gate reads it to decide
 * which tools to expose next step (decision #2 — progressive skill loading).
 */
export const LOADED_SKILLS_KEY = "loadedSkills";

export interface LoadSkillDeps {
  skills: SkillService;
  /** Filesystem root for skill references; defaults to the seed skills dir. */
  skillsRoot?: string;
}

/**
 * `load_skill(name)` — the progressive-loading linchpin. ALL skill tools are
 * registered on the orchestrator up front (AI SDK can't add tools mid-generation),
 * but each skill's tools stay gated until its instructions are loaded here. This
 * tool returns the skill's full SKILL.md body + its reference index and records
 * the skill in the per-request loaded set (via RequestContext), so the next
 * `prepareStep` widens `activeTools` to include that skill's tools.
 */
export function buildLoadSkillTool(deps: LoadSkillDeps) {
  return createTool({
    id: LOAD_SKILL_TOOL_NAME,
    description:
      "Load a skill before using its tools: returns the skill's full instructions and " +
      "its reference list, and activates its tools for the rest of this turn. " +
      "Call this with a skill name from the catalog whenever the request needs that skill.",
    inputSchema: z.object({
      name: z.string().describe("Skill name exactly as listed in the skill catalog."),
    }),
    outputSchema: z.object({
      loaded: z.boolean(),
      name: z.string(),
      instructions: z.string(),
      tools: z.array(z.string()),
      references: z.array(z.string()),
      error: z.string().optional(),
    }),
    execute: async ({ name }, { requestContext }) => {
      const skill = await deps.skills.getSkillByName(name);
      if (!skill) {
        log.warn({ name }, "load_skill: unknown skill");
        return {
          loaded: false,
          name,
          instructions: "",
          tools: [],
          references: [],
          error: `unknown skill: "${name}"`,
        };
      }

      const loaded = requestContext?.get(LOADED_SKILLS_KEY) as Set<string> | undefined;
      loaded?.add(skill.name);

      const references = listReferences(skill.name, deps.skillsRoot).map((r) => r.path);
      log.debug(
        { name: skill.name, tools: skill.allowedTools.length, refs: references.length },
        "skill loaded",
      );
      return {
        loaded: true,
        name: skill.name,
        instructions: skill.prompt,
        tools: skill.allowedTools,
        references,
      };
    },
  });
}

/** Map each skill name to the tools it activates once loaded (its `allowed-tools`). */
export function buildSkillToolMap(skills: Skill[]): Map<string, string[]> {
  return new Map(skills.map((s) => [s.name, s.allowedTools]));
}

/**
 * Tool names to expose for the current step: `load_skill` (always) plus the
 * `allowed-tools` of every loaded skill, intersected with what's actually
 * registered on the orchestrator. Drives `prepareStep -> activeTools`.
 */
export function activeToolNames(
  loadedSkills: ReadonlySet<string>,
  skillTools: ReadonlyMap<string, readonly string[]>,
  registered: ReadonlySet<string>,
): string[] {
  const out = new Set<string>([LOAD_SKILL_TOOL_NAME]);
  for (const skill of loadedSkills) {
    for (const t of skillTools.get(skill) ?? []) {
      if (registered.has(t)) out.add(t);
    }
  }
  return [...out];
}
