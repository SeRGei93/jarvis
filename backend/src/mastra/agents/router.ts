import { generateObject } from "ai";
import { z } from "zod";
import type { Message } from "../../domain/entities.js";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "router" });

const RESEARCH = "research";
const ONBOARDING = "onboarding";
const RECENT_MESSAGE_WINDOW = 6;

const RouteSchema = z.object({
  skills: z.array(z.string()).max(4).describe("1-4 skill names, ordered by relevance"),
});

export interface RoutableSkill {
  name: string;
  description: string;
}

export interface RouteInput {
  skills: RoutableSkill[];
  recentMessages: Message[];
  userMessage: string;
  /** Skills used in prior assistant replies, newest first. */
  previousSkills: string[];
}

export interface ResolveInput extends RouteInput {
  onboarded: boolean;
}

/** Pure post-processing: keep known skills, else research fallback, else none. */
export function normalizeRoutedSkills(chosen: string[], known: Set<string>): string[] {
  const filtered = (chosen ?? []).filter((s) => known.has(s)).slice(0, 4);
  if (filtered.length > 0) return filtered;
  return known.has(RESEARCH) ? [RESEARCH] : [];
}

function buildSystemPrompt(skills: RoutableSkill[]): string {
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return [
    "You are a router. Choose the skill(s) that should handle the user's message.",
    "Rules:",
    "- Return exactly 1 skill by default.",
    "- Return 2-4 skills ONLY for clearly multi-intent messages.",
    "- For a follow-up or correction, return the same skill as the previous reply.",
    `- If nothing matches, return ["${RESEARCH}"].`,
    "Available skills:",
    list,
  ].join("\n");
}

function buildUserPrompt(input: RouteInput): string {
  const history = input.recentMessages
    .slice(-RECENT_MESSAGE_WINDOW)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  const prev = input.previousSkills.length ? input.previousSkills.join(", ") : "(none)";
  return [
    history ? `Recent conversation:\n${history}` : "",
    `Previously used skills (newest first): ${prev}`,
    `User message: ${input.userMessage}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Function that asks the router model and returns raw skill names (injectable for tests). */
export type RouteModelFn = (modelRef: string, system: string, prompt: string) => Promise<string[]>;

/** Skill router: structured-output model call + Go-parity fallback/onboarding rules. */
export class SkillRouter {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
    private readonly routeModelFn?: RouteModelFn,
  ) {}

  private async callModel(modelRef: string, system: string, prompt: string): Promise<string[]> {
    if (this.routeModelFn) return this.routeModelFn(modelRef, system, prompt);
    const { object } = await generateObject({
      model: this.factory.model(modelRef),
      schema: RouteSchema,
      system,
      prompt,
    });
    return object.skills;
  }

  /** Low-level routing: returns model-chosen skills, research fallback on empty/error. */
  async route(input: RouteInput): Promise<string[]> {
    const roles = await this.settings.getModelRoles();
    try {
      const chosen = await this.callModel(
        roles.router,
        buildSystemPrompt(input.skills),
        buildUserPrompt(input),
      );
      const out = (chosen ?? []).filter(Boolean).slice(0, 4);
      if (out.length === 0) {
        log.warn("empty route -> research fallback");
        return [RESEARCH];
      }
      log.info({ skills: out }, "routed");
      return out;
    } catch (err) {
      log.error({ reason: err instanceof Error ? err.message : String(err) }, "router failed -> research");
      return [RESEARCH];
    }
  }

  /** High-level resolve (parity with Go SkillService.ResolveSkills). */
  async resolveSkills(input: ResolveInput): Promise<string[]> {
    if (!input.onboarded) {
      log.debug("onboarding forced (user not onboarded)");
      return [ONBOARDING];
    }
    const routed = await this.route(input);
    return normalizeRoutedSkills(routed, new Set(input.skills.map((s) => s.name)));
  }
}
