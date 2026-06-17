import { generateObject } from "ai";
import { z } from "zod";
import type { Message, Skill } from "../../domain/entities.js";
import type { RoutableSkill } from "../../services/skill-service.js";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "primary-skill" });

const RESEARCH = "research";
const ONBOARDING = "onboarding";
const RECENT_MESSAGE_WINDOW = 6;

const PrimarySchema = z.object({
  skill: z.string().describe("the single most relevant skill name for this message"),
});

export interface PrimaryInput {
  skills: RoutableSkill[];
  recentMessages: Message[];
  userMessage: string;
  /** Skills used in prior assistant replies, newest first (follow-up continuity). */
  previousSkills: string[];
  onboarded: boolean;
}

/** Per-turn execution config the orchestrator runs with, derived by the pre-pass. */
export interface TurnConfig {
  /** Primary skill name (preloaded into the orchestrator), or "" when none. */
  skill: string;
  /** Resolved turn model: session override → primary skill model → roles.default. */
  model: string;
  temperature: number;
  reasoning: boolean | null;
}

/** Injectable single-skill classifier so tests need no model/network. */
export type SelectPrimaryFn = (modelRef: string, system: string, prompt: string) => Promise<string>;

/**
 * Pure post-processing: keep the chosen skill if known, else research fallback,
 * else "" (no primary — orchestrator falls back to the catalog alone).
 * Single-skill analogue of the old router's `normalizeRoutedSkills`.
 */
export function normalizePrimary(chosen: string, known: ReadonlySet<string>): string {
  if (chosen && known.has(chosen)) return chosen;
  return known.has(RESEARCH) ? RESEARCH : "";
}

/**
 * Resolve the turn's execution config from the primary skill, honoring a
 * per-session model override (decision #3). session.model wins, then the skill's
 * own model, then roles.default; temperature/reasoning come from the skill.
 */
export function resolveTurnConfig(
  skill: Skill | null,
  opts: { sessionModel?: string | null; defaultModel: string; defaultTemperature: number },
): TurnConfig {
  const session = opts.sessionModel?.trim();
  return {
    skill: skill?.name ?? "",
    model: session || skill?.model || opts.defaultModel,
    temperature: skill?.temperature ?? opts.defaultTemperature,
    reasoning: skill?.reasoning ?? null,
  };
}

function buildSystemPrompt(skills: RoutableSkill[]): string {
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return [
    "You pick the single best skill to lead the answer to the user's message.",
    "Rules:",
    "- Return exactly ONE skill name.",
    "- For a follow-up or correction, return the same skill as the previous reply.",
    `- If nothing clearly matches, return "${RESEARCH}".`,
    "Available skills:",
    list,
  ].join("\n");
}

function buildUserPrompt(input: PrimaryInput): string {
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

/**
 * Lightweight pre-pass that picks the *primary* skill for a turn — replacing the
 * old multi-skill router. It does NOT decide an answer path or run anything: the
 * orchestrator pre-loads the primary skill and pulls in more via `load_skill`.
 *
 * Preserves two Go-parity rules from the router: onboarding is forced when the
 * user is not onboarded (no model call), and an empty/unknown/failed choice falls
 * back to `research`. Uses the cheap `roles.router` model.
 */
export class PrimarySkillSelector {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
    private readonly selectFn?: SelectPrimaryFn,
  ) {}

  private async callModel(modelRef: string, system: string, prompt: string): Promise<string> {
    if (this.selectFn) return this.selectFn(modelRef, system, prompt);
    const { object } = await generateObject({
      model: this.factory.model(modelRef),
      schema: PrimarySchema,
      system,
      prompt,
    });
    return object.skill;
  }

  /** Choose the primary skill for this turn (onboarding forced; research fallback). */
  async selectPrimary(input: PrimaryInput): Promise<string> {
    if (!input.onboarded) {
      log.debug("onboarding forced (user not onboarded)");
      return ONBOARDING;
    }
    const known = new Set(input.skills.map((s) => s.name));
    try {
      const roles = await this.settings.getModelRoles();
      const chosen = await this.callModel(
        roles.router,
        buildSystemPrompt(input.skills),
        buildUserPrompt(input),
      );
      const primary = normalizePrimary(chosen, known);
      log.info({ primary, chosen }, "primary skill selected");
      return primary;
    } catch (err) {
      log.error(
        { reason: err instanceof Error ? err.message : String(err) },
        "primary-skill selection failed -> research",
      );
      return known.has(RESEARCH) ? RESEARCH : "";
    }
  }
}
