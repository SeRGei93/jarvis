import { generateObject } from "ai";
import { z } from "zod";
import type { Message } from "../../domain/entities.js";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "fact-extractor" });

/** Watchdog for the extraction call — a stuck extractor must never block a turn. */
const EXTRACT_TIMEOUT_MS = 30_000;

/** Durable fact categories the extractor may emit (mirrors the `remember` tool). */
const FACT_CATEGORIES = ["fact", "preference", "instruction", "lesson"] as const;

const FactsSchema = z.object({
  facts: z
    .array(
      z.object({
        category: z.enum(FACT_CATEGORIES),
        content: z.string(),
      }),
    )
    .default([]),
});
export type ExtractedFacts = z.infer<typeof FactsSchema>;

const SYSTEM_PROMPT = [
  "You extract durable, long-term facts a personal assistant should remember about its user,",
  "from one conversation turn. Be CONSERVATIVE: only capture stable, user-specific information",
  "the user volunteered — personal facts (fact), likes/dislikes (preference), standing orders",
  "(instruction), or corrections to remember (lesson).",
  "Do NOT capture: transient task details, one-off requests, questions, small talk, anything the",
  "assistant said, or anything already obvious. When nothing durable was stated, return an empty list.",
  "Each fact must be concise (1 sentence), standalone, and in the user's language.",
].join(" ");

/** Injectable extraction call (tests). */
export type FactExtractFn = (modelRef: string, messages: Message[]) => Promise<ExtractedFacts>;

/**
 * Opportunistic long-term memory: after a turn, surfaces durable facts the user
 * stated in passing (in addition to the explicit `remember` tool + onboarding).
 * A deliberate divergence from Go parity — Go did no automatic extraction.
 * The caller routes results through `MemoryService.save` (sensitivity filter,
 * sanitize, LLM dedup, cap), so this only decides WHAT is worth remembering.
 * Injectable behind `FactExtractFn` so tests need no network.
 */
export class FactExtractor {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
    private readonly extractFn?: FactExtractFn,
  ) {}

  async extract(messages: Message[]): Promise<ExtractedFacts> {
    const roles = await this.settings.getModelRoles();
    const ref = roles.default;
    if (this.extractFn) return this.extractFn(ref, messages);
    const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const { object } = await generateObject({
      model: this.factory.model(ref),
      schema: FactsSchema,
      system: SYSTEM_PROMPT,
      prompt: convo,
      abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
    log.debug({ count: object.facts.length }, "facts extracted");
    return object;
  }
}
