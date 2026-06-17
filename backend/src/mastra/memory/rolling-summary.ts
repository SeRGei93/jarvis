import { generateText } from "ai";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { sessions } from "../../db/schema.js";
import type { Message } from "../../domain/entities.js";
import { ModelFactory } from "../models.js";
import { SettingsService } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "rolling-summary" });

type Db = LibSQLDatabase<typeof schema>;

/** Watchdog for the summary LLM call — a stuck summary must never block a turn. */
const SUMMARY_TIMEOUT_MS = 30_000;
/** Keep the rolling summary bounded so it never crowds out the live window. */
const MAX_SUMMARY_CHARS = 2000;

/** Folds evicted dialogue messages into a running summary. */
export interface Summarizer {
  /** Return an updated summary that folds `newMessages` into `previousSummary`. */
  summarize(previousSummary: string, newMessages: Message[]): Promise<string>;
}

const SYSTEM_PROMPT = [
  "You maintain a running summary of an ongoing chat between a user and their assistant.",
  "Given the PREVIOUS SUMMARY and the NEW MESSAGES that are scrolling out of the live window,",
  "produce an updated summary that preserves durable, useful context: the user's stated facts,",
  "preferences, decisions, ongoing tasks, and unresolved questions. Drop small talk and transient",
  "details. Be concise (a few short bullet points or sentences). Write in the user's language.",
  "Output ONLY the summary text — no preamble, no meta commentary.",
].join(" ");

/**
 * LLM-backed summarizer. Uses the cheap synthesizer/default role and a hard
 * timeout. Injectable behind `Summarizer` so tests need no network.
 */
export class LlmSummarizer implements Summarizer {
  constructor(
    private readonly factory: ModelFactory,
    private readonly settings: SettingsService,
  ) {}

  async summarize(previousSummary: string, newMessages: Message[]): Promise<string> {
    if (newMessages.length === 0) return previousSummary;
    const roles = await this.settings.getModelRoles();
    const ref = roles.synthesizer || roles.default;
    const convo = newMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const prompt = [
      previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}` : "PREVIOUS SUMMARY: (none)",
      `NEW MESSAGES:\n${convo}`,
    ].join("\n\n");
    const { text } = await generateText({
      model: this.factory.model(ref),
      system: SYSTEM_PROMPT,
      prompt,
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    return text.trim().slice(0, MAX_SUMMARY_CHARS);
  }
}

/** New rolling-summary state after a fold. */
export interface SummaryState {
  summary: string;
  count: number;
}

/**
 * Maintains a per-session rolling summary of dialogue history that has scrolled
 * out of the live `max_history` window. `summary_msg_count` records how many of
 * the thread's oldest messages the summary already covers, so each turn only
 * folds the newly-evicted slice. Fail-open: a summarizer error never throws — a
 * stuck summary must not break the chat turn.
 */
export class RollingSummaryService {
  constructor(
    private readonly db: Db,
    private readonly summarizer: Summarizer,
  ) {}

  /**
   * Fold any messages now beyond the live window into the session's summary.
   * `allMessages` is the full thread in chronological order; `windowSize` is the
   * live `max_history`. Returns the new {summary,count} when it changed, or null
   * when nothing needed folding or the summarizer failed.
   */
  async maybeUpdate(params: {
    sessionId: number;
    allMessages: Message[];
    windowSize: number;
    currentSummary: string | null;
    currentCount: number;
  }): Promise<SummaryState | null> {
    const { sessionId, allMessages, windowSize, currentSummary, currentCount } = params;
    const total = allMessages.length;
    const evicted = Math.max(0, total - windowSize); // messages beyond the live window
    if (evicted <= currentCount) {
      log.debug({ sessionId, total, windowSize, evicted, currentCount }, "summary up to date");
      return null;
    }
    const newlyEvicted = allMessages.slice(currentCount, evicted);
    try {
      const summary = await this.summarizer.summarize(currentSummary ?? "", newlyEvicted);
      await this.db
        .update(sessions)
        .set({ summary, summaryMsgCount: evicted, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));
      log.debug(
        { sessionId, folded: newlyEvicted.length, count: evicted, len: summary.length },
        "rolling summary updated",
      );
      return { summary, count: evicted };
    } catch (err) {
      log.warn(
        { sessionId, reason: err instanceof Error ? err.message : String(err) },
        "summary update failed -> skip (turn continues)",
      );
      return null;
    }
  }
}
