import { and, eq, ne, isNull } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { cronTasks } from "../db/schema.js";
import { SettingsService, parseGoDuration } from "../config/settings.js";
import type { ChatResult } from "../mastra/workflows/chat.js";
import { logger } from "../pkg/logger.js";
import * as sched from "./schedule.js";

const log = logger.child({ mod: "scheduler" });

type Db = LibSQLDatabase<typeof schema>;
type CronTaskRow = typeof cronTasks.$inferSelect;

/** Margin added on top of `timeouts.llm_request` for the per-task watchdog backstop. */
const WATCHDOG_MARGIN_MS = 30_000;
/** Fallback when `timeouts.llm_request` is unset/unparseable (mirrors the settings default). */
const DEFAULT_LLM_REQUEST_MS = 300_000;

/** Minimal outbound surface — `telegram/messenger.ts::Messenger` satisfies it structurally. */
export interface Notifier {
  sendMessage(chatId: number, text: string): Promise<void>;
}

/** Runs a stored task prompt through the chat pipeline — `ChatService.handleUserMessage` in prod. */
export type RunTask = (userId: number, chatId: number, text: string) => Promise<ChatResult>;

export interface ExecutorDeps {
  db: Db;
  settings: SettingsService;
  runTask: RunTask;
  notifier: Notifier;
  /** Body of the MONITORING prompt, prepended to recurring-task prompts. */
  getMonitoringPrompt: () => Promise<string>;
  /** Injectable clock for deterministic tests (default: `() => new Date()`). */
  now?: () => Date;
  /** Per-task watchdog override (tests). Default: `llm_request + 30s`. */
  taskTimeoutMs?: number;
}

/**
 * Guards against a slow task overrunning into the next poll tick — a task id stays
 * in this set while it executes, so a later tick skips it. Module-scoped so the
 * immediate and scheduled ticks share one view (a task is unique to one tick kind,
 * but the guard is cheap insurance). Always cleared in `executeOne`'s `finally`.
 */
const running = new Set<number>();

/**
 * Run all pending immediate (`schedule="now"`) tasks: active, never run yet.
 * Polled every 5s. On success the task is deactivated; on failure `last_run_at`
 * is still set, so it is no longer "pending" — single-shot, parity with Go.
 */
export async function runImmediateTasks(deps: ExecutorDeps): Promise<void> {
  const rows = await deps.db
    .select()
    .from(cronTasks)
    .where(and(eq(cronTasks.isActive, true), eq(cronTasks.schedule, "now"), isNull(cronTasks.lastRunAt)));
  log.debug({ count: rows.length }, "immediate tasks due");
  for (const task of rows) await executeOne(deps, task, "immediate");
}

/**
 * Run all due scheduled tasks (`once` + recurring), polled every minute.
 * Due-ness is derived from `scheduled_at` / the cron expression vs `last_run_at`
 * (there is no `next_run_at` column). One-time tasks are deactivated after success;
 * recurring tasks stay active and reschedule from the updated `last_run_at`.
 */
export async function runScheduledTasks(deps: ExecutorDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.db
    .select()
    .from(cronTasks)
    .where(and(eq(cronTasks.isActive, true), ne(cronTasks.schedule, "now")));
  const due = rows.filter((t) => isDue(t, now));
  log.debug({ active: rows.length, due: due.length }, "scheduled tasks due");
  for (const task of due) await executeOne(deps, task, "scheduled");
}

/** Whether a non-immediate task is due now. Malformed expressions are treated as not-due. */
function isDue(task: CronTaskRow, now: Date): boolean {
  if (sched.isOnce(task)) return sched.isOnceDue(task, now);
  if (!sched.isRecurring(task)) return false;
  try {
    return sched.isRecurringDue(task, now);
  } catch (err) {
    log.warn(
      { taskId: task.id, reason: err instanceof Error ? err.message : String(err) },
      "unparseable schedule — task skipped",
    );
    return false;
  }
}

/**
 * Execute one task: run its prompt through the chat pipeline (with a watchdog
 * backstop), record `last_run_*`, deactivate one-shots, and notify the user when
 * the result is meaningful. Never throws — the scheduler must survive any task.
 *
 * NOTE: `runTask` goes through the full chat pipeline, so each run consumes the
 * user's hourly rate limit + records usage, and persists the synthetic user/
 * assistant turns into the notification chat's history (documented M7 divergence
 * from Go's isolated per-task session).
 */
async function executeOne(deps: ExecutorDeps, task: CronTaskRow, kind: "immediate" | "scheduled"): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();

  if (task.notificationChatId == null) {
    log.warn({ taskId: task.id }, "task has no notification chat — skipped");
    return;
  }
  if (running.has(task.id)) {
    log.warn({ taskId: task.id }, "task already running — skipped");
    return;
  }
  running.add(task.id);
  const startedMs = Date.now();
  try {
    const text = sched.isRecurring(task)
      ? `${await deps.getMonitoringPrompt()}\n\n${task.prompt}`
      : task.prompt;
    log.debug({ taskId: task.id, kind, schedule: task.schedule }, "running task");

    let result: ChatResult;
    try {
      const timeoutMs = await resolveTimeout(deps);
      result = await withTimeout(deps.runTask(task.userId, task.notificationChatId, text), timeoutMs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ taskId: task.id, reason }, "task run failed");
      await recordRun(deps.db, task.id, now, { status: "error", error: reason, deactivate: false });
      return;
    }

    // promptguard / rate-limit rejection — never deliver the rejection text for a
    // background task; mark it errored and leave it active.
    if (result.rejected) {
      log.warn({ taskId: task.id }, "task run rejected (promptguard/rate-limit)");
      await recordRun(deps.db, task.id, now, { status: "error", error: `rejected: ${result.text}`, deactivate: false });
      return;
    }

    const deactivate = sched.isImmediate(task) || sched.isOnce(task);
    await recordRun(deps.db, task.id, now, { status: "success", error: null, deactivate });

    if (sched.shouldNotify(task, result.text)) {
      try {
        await deps.notifier.sendMessage(task.notificationChatId, result.text);
        log.info({ taskId: task.id, kind, durationMs: Date.now() - startedMs, notified: true }, "task completed");
      } catch (err) {
        log.warn(
          { taskId: task.id, reason: err instanceof Error ? err.message : String(err) },
          "notification failed",
        );
      }
    } else {
      log.info(
        { taskId: task.id, kind, durationMs: Date.now() - startedMs, notified: false },
        "task completed (notification suppressed)",
      );
    }
  } catch (err) {
    log.error({ taskId: task.id, reason: err instanceof Error ? err.message : String(err) }, "task execution crashed");
  } finally {
    running.delete(task.id);
  }
}

/** Write `last_run_*` (and optionally deactivate) for a task in one update. */
async function recordRun(
  db: Db,
  taskId: number,
  now: Date,
  o: { status: "success" | "error"; error: string | null; deactivate: boolean },
): Promise<void> {
  const set: Partial<typeof cronTasks.$inferInsert> = {
    lastRunAt: now,
    lastRunStatus: o.status,
    lastRunError: o.error,
    updatedAt: now,
  };
  if (o.deactivate) set.isActive = false;
  await db.update(cronTasks).set(set).where(eq(cronTasks.id, taskId));
}

/** Per-task watchdog timeout: `llm_request + 30s`, a backstop over the chat pipeline's own timeouts. */
async function resolveTimeout(deps: ExecutorDeps): Promise<number> {
  if (deps.taskTimeoutMs != null) return deps.taskTimeoutMs;
  const timeouts = await deps.settings.getTimeouts();
  const base = parseGoDuration(timeouts.llm_request) || DEFAULT_LLM_REQUEST_MS;
  return base + WATCHDOG_MARGIN_MS;
}

/** Reject after `ms` if `p` has not settled. The orphaned `p` cannot be cancelled (no AbortController). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`task watchdog timeout after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
