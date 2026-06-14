import { CronExpressionParser } from "cron-parser";

/**
 * Pure scheduling rules for the cron executor — NO IO (no db/config/mastra),
 * only `cron-parser` (the same parser `tools/tasks.ts::validateSchedule` uses).
 *
 * A task's kind is encoded in its `schedule` field (parity with M5 validation):
 *  - `"now"`  → immediate background task (run once ASAP).
 *  - `"once"` → one-time deferred task (run when `scheduledAt` arrives).
 *  - else     → recurring 5-field cron expression (min 1h interval, enforced at
 *               creation in M5; the scheduler does not re-check it).
 *
 * Ported from Go `internal/domain/entity/cron_task.go` (ShouldNotify markers) and
 * the scheduler's due-check logic.
 */

/** node-cron expression for the recurring/once poll tick (every minute). */
export const RECURRING_TICK = "* * * * *";
/** node-cron expression for the immediate (`now`) poll tick (every 5 seconds, 6-field). */
export const IMMEDIATE_TICK = "*/5 * * * * *";
/** Results shorter than this are checked against {@link SHORT_NEGATIVE_WORDS}. */
export const SHORT_RESULT_MIN_LEN = 20;

/** Substring markers (uppercased) that mean "no meaningful result" (Go `noResultMarkers`). */
export const NO_RESULT_MARKERS: readonly string[] = [
  "NO_RESULT",
  "NO_CHANGES",
  "NOTHING_FOUND",
  "NO_NEW_LISTINGS",
  "NO RESULT",
  "NO CHANGES",
  "NOTHING FOUND",
  "NO NEW LISTINGS",
];

/** Short RU phrases that, as the entire normalized result, mean "no changes" (Go `noResultExactPhrases`). */
export const NO_RESULT_EXACT_PHRASES: readonly string[] = [
  "НЕТ ИЗМЕНЕНИЙ",
  "НИЧЕГО НЕ НАЙДЕНО",
  "ИЗМЕНЕНИЙ НЕТ",
  "НИЧЕГО",
];

/** Words that, in a short (< 20 char) result, mean it is not meaningful (Go `shortNegativeWords`). */
export const SHORT_NEGATIVE_WORDS: readonly string[] = ["НЕТ", "NO", "NOTHING", "NONE", "EMPTY"];

/** Minimal task shape the scheduling rules need — a `cronTasks` row satisfies it structurally. */
export interface ScheduleFields {
  schedule: string;
  scheduledAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
}

/** True for an immediate background task (`schedule === "now"`). */
export function isImmediate(t: { schedule: string }): boolean {
  return t.schedule === "now";
}

/** True for a one-time deferred task (`schedule === "once"`). */
export function isOnce(t: { schedule: string }): boolean {
  return t.schedule === "once";
}

/** True for a recurring task (a non-empty cron expression that is neither `now` nor `once`). */
export function isRecurring(t: { schedule: string }): boolean {
  return t.schedule !== "" && t.schedule !== "now" && t.schedule !== "once";
}

/**
 * Next occurrence of `schedule` strictly after `from`. Uses the same parser and
 * (server-local, no `tz`) interpretation as `validateSchedule` — per-user
 * timezone is a documented divergence. Throws on an unparseable expression.
 */
export function computeNextRun(schedule: string, from: Date): Date {
  return CronExpressionParser.parse(schedule, { currentDate: from }).next().toDate();
}

/**
 * Recurring task is due when its next run after the last run (or, if never run,
 * after creation) is at or before `now`. Min-interval (1h) was enforced at
 * creation, so the next run is always far enough ahead to avoid double-firing.
 */
export function isRecurringDue(t: ScheduleFields, now: Date): boolean {
  const base = t.lastRunAt ?? t.createdAt;
  return computeNextRun(t.schedule, base).getTime() <= now.getTime();
}

/** One-time task is due when its scheduled time is set and has arrived. */
export function isOnceDue(t: { scheduledAt: Date | null }, now: Date): boolean {
  return t.scheduledAt != null && t.scheduledAt.getTime() <= now.getTime();
}

/**
 * Whether a task result is meaningful enough to notify the user (Go `ShouldNotify`).
 * Immediate tasks always notify (the user explicitly asked for them); empty/whitespace
 * results never notify. Otherwise the result is suppressed when it contains a
 * no-result marker, exactly matches a RU "no changes" phrase, or is short and
 * contains a negative word.
 */
export function shouldNotify(t: { schedule: string }, result: string): boolean {
  const trimmed = result.trim();
  if (trimmed === "") return false;
  if (isImmediate(t)) return true;

  const normalized = trimmed.toUpperCase();
  for (const marker of NO_RESULT_MARKERS) {
    if (normalized.includes(marker)) return false;
  }
  for (const phrase of NO_RESULT_EXACT_PHRASES) {
    if (normalized === phrase) return false;
  }
  if (result.length < SHORT_RESULT_MIN_LEN) {
    for (const word of SHORT_NEGATIVE_WORDS) {
      if (normalized.includes(word)) return false;
    }
  }
  return true;
}
