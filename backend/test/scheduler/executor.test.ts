import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runImmediateTasks, runScheduledTasks, type ExecutorDeps } from "../../src/scheduler/executor.js";
import type { SettingsService } from "../../src/config/settings.js";
import { users, sessions, cronTasks } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const OK_RESULT = "Готово: задача выполнена успешно.";

/** Seed user 1 + a session (chatId 100) and return the session id (FKs for cron_tasks). */
async function seedBase(): Promise<number> {
  await t!.db.insert(users).values({ id: 1, name: "u1" });
  const [s] = await t!.db
    .insert(sessions)
    .values({ chatId: 100, userId: 1, model: "test:model" })
    .returning({ id: sessions.id });
  return s!.id;
}

type Inserted = typeof cronTasks.$inferSelect;
async function insertTask(
  sessionId: number,
  over: Partial<typeof cronTasks.$inferInsert>,
): Promise<Inserted> {
  const [row] = await t!.db
    .insert(cronTasks)
    .values({
      userId: 1,
      sessionId,
      name: "task",
      prompt: "do x",
      schedule: "now",
      notificationChatId: 100,
      ...over,
    })
    .returning();
  return row!;
}

interface Harness {
  deps: ExecutorDeps;
  runs: { userId: number; chatId: number; text: string }[];
  sent: { chatId: number; text: string }[];
}
function makeDeps(over: Partial<ExecutorDeps> = {}, now?: Date): Harness {
  const runs: Harness["runs"] = [];
  const sent: Harness["sent"] = [];
  const deps: ExecutorDeps = {
    db: t!.db,
    settings: {
      getTimeouts: async () => ({ llm_request: "300s", http_client: "300s", llm_activity: "30s" }),
    } as unknown as SettingsService,
    runTask: async (userId, chatId, text) => {
      runs.push({ userId, chatId, text });
      return { text: OK_RESULT, skills: ["research"], rejected: false };
    },
    notifier: { sendMessage: async (chatId, text) => void sent.push({ chatId, text }) },
    getMonitoringPrompt: async () => "MONITORING",
    now: now ? () => now : undefined,
    taskTimeoutMs: 1000,
    ...over,
  };
  return { deps, runs, sent };
}

async function reload(id: number): Promise<Inserted> {
  const [row] = await t!.db.select().from(cronTasks).where(eq(cronTasks.id, id));
  return row!;
}

describe("runImmediateTasks", () => {
  it("runs a 'now' task once, deactivates it, notifies, and does not re-run", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { schedule: "now" });
    const { deps, runs, sent } = makeDeps();

    await runImmediateTasks(deps);
    expect(runs).toEqual([{ userId: 1, chatId: 100, text: "do x" }]);
    expect(sent).toEqual([{ chatId: 100, text: OK_RESULT }]);

    const row = await reload(task.id);
    expect(row.isActive).toBe(false);
    expect(row.lastRunStatus).toBe("success");
    expect(row.lastRunAt).not.toBeNull();

    // Second tick: last_run_at is now set, so the immediate query no longer matches.
    await runImmediateTasks(deps);
    expect(runs).toHaveLength(1);
  });

  it("skips a task without a notification chat and never calls runTask", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { schedule: "now", notificationChatId: null });
    const { deps, runs, sent } = makeDeps();

    await runImmediateTasks(deps);
    expect(runs).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const row = await reload(task.id);
    expect(row.lastRunAt).toBeNull(); // untouched
  });

  it("records an error and stays active when runTask throws (no notification)", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { schedule: "now" });
    const { deps, sent } = makeDeps({
      runTask: async () => {
        throw new Error("boom");
      },
    });

    await runImmediateTasks(deps);
    expect(sent).toHaveLength(0);
    const row = await reload(task.id);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toContain("boom");
    expect(row.isActive).toBe(true);
  });

  it("treats a rejected result as an error and does not notify", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { schedule: "now" });
    const { deps, sent } = makeDeps({
      runTask: async () => ({ text: "Слишком много сообщений.", skills: [], rejected: true }),
    });

    await runImmediateTasks(deps);
    expect(sent).toHaveLength(0);
    const row = await reload(task.id);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toMatch(/^rejected:/);
  });

  it("records an error via the watchdog when runTask hangs (scheduler survives)", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { schedule: "now" });
    const { deps, sent } = makeDeps({
      runTask: () => new Promise(() => {}), // never settles
      taskTimeoutMs: 50,
    });

    await runImmediateTasks(deps); // resolves despite the hanging task
    expect(sent).toHaveLength(0);
    const row = await reload(task.id);
    expect(row.lastRunStatus).toBe("error");
    expect(row.lastRunError).toMatch(/watchdog/);
  });

  it("does not double-run a task that is already in flight", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    await insertTask(sid, { schedule: "now" });

    let resolveRun!: () => void;
    const gate = new Promise<void>((r) => (resolveRun = r));
    let calls = 0;
    const { deps } = makeDeps({
      taskTimeoutMs: 5000,
      runTask: async () => {
        calls++;
        await gate;
        return { text: OK_RESULT, skills: [], rejected: false };
      },
    });

    const p1 = runImmediateTasks(deps); // parks at the gate, task id added to `running`
    await new Promise((r) => setTimeout(r, 30)); // let p1 reach runTask
    await runImmediateTasks(deps); // second tick sees the in-flight guard and skips
    expect(calls).toBe(1);

    resolveRun();
    await p1;
    expect(calls).toBe(1);
  });
});

describe("runScheduledTasks", () => {
  it("runs a due one-time task, deactivates it, and notifies", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const now = new Date(2026, 5, 14, 12, 0, 0);
    const task = await insertTask(sid, {
      schedule: "once",
      scheduledAt: new Date(2026, 5, 14, 11, 0, 0), // an hour ago
    });
    const { deps, runs, sent } = makeDeps({}, now);

    await runScheduledTasks(deps);
    expect(runs).toHaveLength(1);
    expect(sent).toEqual([{ chatId: 100, text: OK_RESULT }]);
    const row = await reload(task.id);
    expect(row.isActive).toBe(false);
    expect(row.lastRunStatus).toBe("success");
  });

  it("does not run a one-time task scheduled in the future", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const now = new Date(2026, 5, 14, 12, 0, 0);
    await insertTask(sid, { schedule: "once", scheduledAt: new Date(2026, 5, 14, 13, 0, 0) });
    const { deps, runs } = makeDeps({}, now);

    await runScheduledTasks(deps);
    expect(runs).toHaveLength(0);
  });

  it("runs a due recurring task with the MONITORING preamble, stays active, reschedules", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const now = new Date(2026, 5, 14, 10, 0, 0);
    const task = await insertTask(sid, {
      schedule: "0 10 * * *",
      lastRunAt: new Date(2026, 5, 13, 10, 0, 0), // ran yesterday at 10:00
    });
    const { deps, runs, sent } = makeDeps({}, now);

    await runScheduledTasks(deps);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe("MONITORING\n\ndo x");
    expect(sent).toHaveLength(1);
    const row = await reload(task.id);
    expect(row.isActive).toBe(true); // recurring tasks are never deactivated
    expect(row.lastRunStatus).toBe("success");

    // Same minute, re-tick: next run is now tomorrow → not due.
    await runScheduledTasks(deps);
    expect(runs).toHaveLength(1);
  });

  it("suppresses the notification when a recurring result is a NO_CHANGES marker", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const now = new Date(2026, 5, 14, 10, 0, 0);
    const task = await insertTask(sid, {
      schedule: "0 10 * * *",
      lastRunAt: new Date(2026, 5, 13, 10, 0, 0),
    });
    const { deps, sent } = makeDeps(
      { runTask: async () => ({ text: "NO_CHANGES", skills: [], rejected: false }) },
      now,
    );

    await runScheduledTasks(deps);
    // The run happened (status=success) but the notification was suppressed.
    expect(sent).toHaveLength(0);
    const row = await reload(task.id);
    expect(row.lastRunStatus).toBe("success");
  });
});
