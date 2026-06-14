import { describe, it, expect, vi } from "vitest";
import { createScheduler, type ScheduleFn, type SchedulerDeps } from "../../src/scheduler/scheduler.js";
import type { ExecutorDeps } from "../../src/scheduler/executor.js";

interface Registered {
  expression: string;
  fn: () => void | Promise<void>;
  options?: { noOverlap?: boolean; name?: string };
  stop: ReturnType<typeof vi.fn>;
}

/** A fake `scheduleFn` that records registrations and exposes their callbacks. */
function fakeSchedule() {
  const registered: Registered[] = [];
  const scheduleFn: ScheduleFn = (expression, fn, options) => {
    const stop = vi.fn();
    registered.push({ expression, fn, options, stop });
    return { stop };
  };
  const by = (name: string) => registered.find((r) => r.options?.name === name)!;
  return { scheduleFn, registered, by };
}

function baseDeps(over: Partial<SchedulerDeps>): SchedulerDeps {
  return {
    db: {} as ExecutorDeps["db"],
    settings: {} as ExecutorDeps["settings"],
    runTask: async () => ({ text: "", skills: [], rejected: false }),
    notifier: { sendMessage: async () => {} },
    getMonitoringPrompt: async () => "",
    ...over,
  };
}

describe("createScheduler", () => {
  it("registers two ticks with the right cron expressions and noOverlap", () => {
    const f = fakeSchedule();
    const s = createScheduler(baseDeps({ scheduleFn: f.scheduleFn }));
    s.start();

    expect(f.registered).toHaveLength(2);
    expect(f.by("cron-immediate").expression).toBe("*/5 * * * * *");
    expect(f.by("cron-scheduled").expression).toBe("* * * * *");
    expect(f.by("cron-immediate").options?.noOverlap).toBe(true);
    expect(f.by("cron-scheduled").options?.noOverlap).toBe(true);
  });

  it("invoking a tick callback calls the matching executor runner", async () => {
    const f = fakeSchedule();
    const calls: string[] = [];
    const s = createScheduler(
      baseDeps({
        scheduleFn: f.scheduleFn,
        runImmediate: async () => void calls.push("immediate"),
        runScheduled: async () => void calls.push("scheduled"),
      }),
    );
    s.start();

    await f.by("cron-immediate").fn();
    await f.by("cron-scheduled").fn();
    expect(calls).toEqual(["immediate", "scheduled"]);
  });

  it("a throwing tick body never propagates out of the callback", async () => {
    const f = fakeSchedule();
    const s = createScheduler(
      baseDeps({
        scheduleFn: f.scheduleFn,
        runImmediate: async () => {
          throw new Error("tick boom");
        },
      }),
    );
    s.start();

    await expect(f.by("cron-immediate").fn()).resolves.toBeUndefined();
  });

  it("does not run a tick body after stop()", async () => {
    const f = fakeSchedule();
    const calls: string[] = [];
    const s = createScheduler(
      baseDeps({ scheduleFn: f.scheduleFn, runImmediate: async () => void calls.push("immediate") }),
    );
    s.start();
    const immediateFn = f.by("cron-immediate").fn;
    s.stop();

    await immediateFn(); // a tick already queued before stop must be a no-op
    expect(calls).toEqual([]);
  });

  it("stop() stops every handle and is idempotent", () => {
    const f = fakeSchedule();
    const s = createScheduler(baseDeps({ scheduleFn: f.scheduleFn }));
    s.start();
    const stops = f.registered.map((r) => r.stop);

    s.stop();
    s.stop(); // second call must not throw or re-stop

    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent — a second call does not double-register", () => {
    const f = fakeSchedule();
    const s = createScheduler(baseDeps({ scheduleFn: f.scheduleFn }));
    s.start();
    s.start();
    expect(f.registered).toHaveLength(2);
  });
});
