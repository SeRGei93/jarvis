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
