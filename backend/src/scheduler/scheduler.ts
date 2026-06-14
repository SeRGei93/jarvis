import cron from "node-cron";
import { logger } from "../pkg/logger.js";
import { IMMEDIATE_TICK, RECURRING_TICK } from "./schedule.js";
import { runImmediateTasks, runScheduledTasks, type ExecutorDeps } from "./executor.js";

const log = logger.child({ mod: "scheduler" });

/** A scheduled node-cron task — the slice of `ScheduledTask` the driver uses. */
interface CronHandle {
  stop(): void | Promise<void>;
}

/** Subset of `node-cron`'s `schedule()` the driver depends on — injectable for tests. */
export type ScheduleFn = (
  expression: string,
  fn: () => void | Promise<void>,
  options?: { noOverlap?: boolean; name?: string },
) => CronHandle;

export interface SchedulerDeps extends ExecutorDeps {
  /** node-cron `schedule` by default; a fake in tests. */
  scheduleFn?: ScheduleFn;
  /** Test seam — defaults to the real executor entry points. */
  runImmediate?: (deps: ExecutorDeps) => Promise<void>;
  runScheduled?: (deps: ExecutorDeps) => Promise<void>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

/**
 * Drives the cron executor with two node-cron polls: every 5s for immediate
 * (`now`) tasks and every minute for `once` + recurring tasks. Both use node-cron's
 * native `noOverlap`, so a slow tick is skipped rather than stacked (per-task
 * overlap is additionally guarded inside the executor). A tick never throws out of
 * the timer — any error is logged and the scheduler keeps running.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const scheduleFn: ScheduleFn = deps.scheduleFn ?? (cron.schedule as unknown as ScheduleFn);
  const immediate = deps.runImmediate ?? runImmediateTasks;
  const scheduled = deps.runScheduled ?? runScheduledTasks;

  let stopped = false;
  let handles: CronHandle[] = [];

  const tick =
    (label: "immediate" | "scheduled", run: (d: ExecutorDeps) => Promise<void>) => async (): Promise<void> => {
      if (stopped) return;
      const t0 = Date.now();
      try {
        await run(deps);
        log.debug({ tick: label, durationMs: Date.now() - t0 }, "scheduler tick done");
      } catch (err) {
        log.error(
          { tick: label, reason: err instanceof Error ? err.message : String(err) },
          "scheduler tick failed",
        );
      }
    };

  return {
    start(): void {
      if (handles.length > 0) return; // already started
      stopped = false;
      handles = [
        scheduleFn(IMMEDIATE_TICK, tick("immediate", immediate), { noOverlap: true, name: "cron-immediate" }),
        scheduleFn(RECURRING_TICK, tick("scheduled", scheduled), { noOverlap: true, name: "cron-scheduled" }),
      ];
      log.info({ immediate: IMMEDIATE_TICK, scheduled: RECURRING_TICK }, "scheduler started");
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const h of handles) {
        try {
          void h.stop();
        } catch (err) {
          log.warn({ reason: err instanceof Error ? err.message : String(err) }, "scheduler stop failed");
        }
      }
      handles = [];
      log.info("scheduler stopped");
    },
  };
}
