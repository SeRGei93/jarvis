import { generateObject } from "ai";
import { z } from "zod";
import type { Message, Skill } from "../../domain/entities.js";
import type { RoutableSkill } from "../../services/skill-service.js";
import { ModelFactory } from "../models.js";
import { SettingsService, parseGoDuration } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "primary-skill" });

const RESEARCH = "research";
const ONBOARDING = "onboarding";
const RECENT_MESSAGE_WINDOW = 6;
/** Ceiling for the pre-pass classification call when settings lack llm_request. */
const DEFAULT_REQUEST_MS = 300_000;

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
 * Injectable fast-decision hook (`DecisionService.choose`, decision layer).
 * `null` = the decision layer is off or failed → the LLM classifier runs instead.
 */
export type ChoosePrimaryFn = (
  state: string,
  instructions: string,
  criteria: Record<string, string>,
) => Promise<{ choice: string; probabilities: Record<string, number> } | null>;

/** Instruction sent to the decision model with the routable-skill catalog. */
const ROUTING_INSTRUCTIONS =
  "Pick the single skill that should lead the answer to the user's message. " +
  "For a follow-up or correction pick the same skill as the previous reply. " +
  "If nothing clearly matches, pick the research option.";

/** Keep each option description short — the criteria travel with every decision. */
function briefDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

/** Highest-probability criterion id, or null when no probabilities came back. */
function argmaxOver(
  probabilities: Record<string, number> | undefined,
  allowed: ReadonlySet<string>,
): string | null {
  if (!probabilities) return null;
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const [id, p] of Object.entries(probabilities)) {
    if (!allowed.has(id) || typeof p !== "number") continue;
    if (p > bestValue) {
      bestValue = p;
      best = id;
    }
  }
  return best;
}

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
    private readonly chooseFn?: ChoosePrimaryFn,
  ) {}

  private async callModel(modelRef: string, system: string, prompt: string): Promise<string> {
    if (this.selectFn) return this.selectFn(modelRef, system, prompt);
    // Watchdog: this pre-pass runs before the orchestrator's own timeout is armed,
    // so bound it here or a hung classification stalls the whole turn.
    const t = await this.settings.getTimeouts();
    const overallMs = parseGoDuration(t.llm_request) || DEFAULT_REQUEST_MS;
    const { object } = await generateObject({
      model: this.factory.model(modelRef),
      schema: PrimarySchema,
      system,
      prompt,
      abortSignal: AbortSignal.timeout(overallMs),
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

    // Fast path: one typed decision over the routable catalog. Any null/failed
    // answer falls through to the LLM classifier below — the layer is optional.
    if (this.chooseFn && input.skills.length > 0) {
      const criteria = Object.fromEntries(
        input.skills.map((s) => [s.name, briefDescription(s.description)]),
      );
      try {
        const decided = await this.chooseFn(buildUserPrompt(input), ROUTING_INSTRUCTIONS, criteria);
        // argmax keeps only criteria ids: a probability mass on an unknown id is
        // a real miss (not "research") and yields null, letting the LLM decide.
        const winner = decided
          ? argmaxOver(decided.probabilities, new Set(Object.keys(criteria)))
          : null;
        if (winner) {
          log.info({ primary: winner, via: "decision" }, "primary skill selected");
          return winner;
        }
        log.warn(
          { picked: decided?.choice },
          "decision routing gave no usable probabilities -> LLM classifier",
        );
      } catch (err) {
        log.warn(
          { reason: err instanceof Error ? err.message : String(err) },
          "decision routing failed -> LLM classifier",
        );
      }
    }

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
