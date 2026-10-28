import { generateObject } from "ai";
import { z } from "zod";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "memory-dedup" });

/** Watchdog for the dedup LLM call — a stuck check must never block a `remember`. */
const DEDUP_TIMEOUT_MS = 30_000;

/** Decides whether a candidate fact already duplicates one the user has stored. */
export interface DedupChecker {
  /** True if `candidate` is semantically already covered by one of `existing`. */
  isDuplicate(candidate: string, existing: string[]): Promise<boolean>;
}

const DedupResult = z.object({ duplicate: z.boolean() });

/** P(duplicate) at or above this counts as a duplicate (calibrated on pplx-decider). */
export const DEDUP_DUPLICATE_THRESHOLD = 0.7;
/** Cap per existing fact so ~50 memories stay inside the decision model's context. */
const MAX_EXISTING_CHARS = 300;

const DEDUP_QUESTION =
  "Is the NEW fact already covered by one of the EXISTING facts (same meaning, " +
  "even if reworded)? Answer yes only when it adds nothing new.";

/** Minimal slice of the decision layer the dedup checker needs. */
export interface DecisionJudge {
  /** P(yes) in [0,1], or null when the decision layer is off/failed. */
  judge(state: string, instructions: string): Promise<number | null>;
}

export interface DedupOptions {
  threshold?: number;
}

/**
 * Decision-first dedup: one typed yes/no question (fast, ~$0.000003) instead of a
 * generative check. Anything other than a confident answer — layer off, refusal,
 * error, low probability — is delegated to the injected LLM checker (which itself
 * fails open), so memory saving keeps its "never block on a check" property.
 *
 * The `existing.length === 0` shortcut is preserved *before* any API call.
 */
export class DecisionDedupChecker implements DedupChecker {
  private readonly threshold: number;

  constructor(
    private readonly decisions: DecisionJudge,
    private readonly fallback: DedupChecker,
    opts: DedupOptions = {},
  ) {
    this.threshold = opts.threshold ?? DEDUP_DUPLICATE_THRESHOLD;
  }

  async isDuplicate(candidate: string, existing: string[]): Promise<boolean> {
    if (existing.length === 0) return false;

    const list = existing
      .map((c, i) => {
        const fact = c.length > MAX_EXISTING_CHARS ? `${c.slice(0, MAX_EXISTING_CHARS)}…` : c;
        return `${i + 1}. ${fact}`;
      })
      .join("\n");
    const p = await this.decisions.judge(
      `NEW fact:\n${candidate}\n\nEXISTING facts:\n${list}`,
      DEDUP_QUESTION,
    );
    if (p === null) {
      log.debug("dedup: decision layer unavailable -> LLM checker");
      return this.fallback.isDuplicate(candidate, existing);
    }
    log.debug({ p, threshold: this.threshold }, "dedup: decision answer");
    return p >= this.threshold;
  }
}

const SYSTEM_PROMPT = [
  "You deduplicate a user's long-term memory facts.",
  "Given a NEW fact and a numbered list of EXISTING facts, decide whether the NEW",
  "fact is already covered by an existing one (same meaning, even if reworded).",
  "Return duplicate=true only when it adds nothing new; otherwise duplicate=false.",
].join(" ");

/**
 * LLM-backed dedup — replaces the old cosine-0.92 vector check (embeddings removed).
 * Uses the cheap router model. Fails open (returns false) so a model/timeout error
 * never blocks a save. Injectable behind `DedupChecker` so tests need no network.
 */
export class LlmDedupChecker implements DedupChecker {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
  ) {}

  async isDuplicate(candidate: string, existing: string[]): Promise<boolean> {
    if (existing.length === 0) return false;
    try {
      const roles = await this.settings.getModelRoles();
      const ref = roles.router || roles.default;
      const list = existing.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const { object } = await generateObject({
        model: this.factory.model(ref),
        schema: DedupResult,
        system: SYSTEM_PROMPT,
        prompt: `NEW fact:\n${candidate}\n\nEXISTING facts:\n${list}`,
        abortSignal: AbortSignal.timeout(DEDUP_TIMEOUT_MS),
      });
      return object.duplicate;
    } catch (err) {
      log.warn(
        { reason: err instanceof Error ? err.message : String(err) },
        "dedup check failed -> treat as not duplicate",
      );
      return false;
    }
  }
}
