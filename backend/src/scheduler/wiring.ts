import { createScheduler, type Scheduler, type ScheduleFn } from "./scheduler.js";
import type { Notifier } from "./executor.js";
import type { ChatService } from "../app.js";

/**
 * Composition glue: wire a {@link ChatService} and a {@link Notifier} into a cron
 * {@link Scheduler}. Kept out of `server.ts` (the entry point that runs `main()`
 * on load) so it stays unit-testable without booting the whole process — the
 * `ChatService`/`Notifier` imports are type-only, so this module drags in no
 * db/Mastra/env side effects.
 *
 * `runTask` is `ChatService.handleUserMessage` (no `onText` — cron needs no
 * streaming); `getMonitoringPrompt` reads the seeded MONITORING prompt for the
 * recurring-task preamble.
 */
export function buildCronScheduler(
  svc: ChatService,
  notifier: Notifier,
  opts: { scheduleFn?: ScheduleFn } = {},
): Scheduler {
  return createScheduler({
    db: svc.deps.db,
    settings: svc.deps.settings,
    notifier,
    runTask: (userId, chatId, text) => svc.handleUserMessage(userId, chatId, text),
    getMonitoringPrompt: () => svc.deps.skills.getPrompt("MONITORING"),
    scheduleFn: opts.scheduleFn,
  });
}
