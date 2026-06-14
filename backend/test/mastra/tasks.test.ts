import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { buildTaskTools, validateSchedule } from "../../src/mastra/tools/tasks.js";
import type { ToolContext } from "../../src/mastra/tools/registry.js";
import {
  users,
  sessions,
  cronTasks,
  subscriptionPlans,
  userSubscriptions,
} from "../../src/db/schema.js";

// Minimal ToolCallOptions for direct execute() calls in tests.
const opts = { toolCallId: "test", messages: [] } as never;

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Seed a user + a session and return a ToolContext bound to them. */
async function seedCtx(userId: number, chatId: number): Promise<ToolContext> {
  await t!.db.insert(users).values({ id: userId, name: `u${userId}` });
  const [s] = await t!.db
    .insert(sessions)
    .values({ chatId, userId, model: "test:model" })
    .returning({ id: sessions.id });
  return {
    db: t!.db,
    userId,
    sessionId: s!.id,
    chatId,
  } as unknown as ToolContext;
}

describe("validateSchedule", () => {
  it("accepts 'now' (immediate)", () => {
    expect(validateSchedule("now")).toEqual({ ok: true });
  });

  it("rejects 'once' with a past scheduled_at", () => {
    const past = new Date(Date.now() - 60_000);
    const r = validateSchedule("once", past);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/future/i);
  });

  it("accepts 'once' with a future scheduled_at", () => {
    const future = new Date(Date.now() + 3_600_000);
    expect(validateSchedule("once", future)).toEqual({ ok: true });
  });

  it("rejects 'once' without scheduled_at", () => {
    const r = validateSchedule("once");
    expect(r.ok).toBe(false);
  });

  it("rejects a cron that runs every 5 minutes (under 1h)", () => {
    const r = validateSchedule("*/5 * * * *");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/frequent|hour/i);
  });

  it("accepts an hourly cron", () => {
    expect(validateSchedule("0 * * * *")).toEqual({ ok: true });
  });

  it("accepts a daily cron at 9 AM", () => {
    expect(validateSchedule("0 9 * * *")).toEqual({ ok: true });
  });

  it("rejects an empty schedule", () => {
    const r = validateSchedule("");
    expect(r.ok).toBe(false);
  });

  it("rejects an unparseable cron expression", () => {
    const r = validateSchedule("not a cron");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid/i);
  });
});

describe("task tools — integration (CRUD + userId scoping)", () => {
  it("create -> list -> get -> update -> toggle -> delete", async () => {
    t = await createTestDb();
    const ctx = await seedCtx(1, 100);
    const tools = buildTaskTools(ctx);

    const created = (await tools.task_create!.execute!(
      { name: "Daily report", prompt: "Summarise the day", schedule: "0 9 * * *" },
      opts,
    )) as { task_id: number; message: string };
    expect(created.task_id).toBeGreaterThan(0);
    expect(created.message).toContain("created");

    const listed = (await tools.task_list!.execute!({}, opts)) as {
      tasks: { id: number; name: string; is_active: boolean }[];
    };
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.name).toBe("Daily report");
    expect(listed.tasks[0]!.is_active).toBe(true);

    const got = (await tools.task_get!.execute!({ task_id: created.task_id }, opts)) as {
      task: { id: number; prompt: string; schedule: string };
    };
    expect(got.task.id).toBe(created.task_id);
    expect(got.task.schedule).toBe("0 9 * * *");

    const updated = (await tools.task_update!.execute!(
      { task_id: created.task_id, name: "Renamed", prompt: "New prompt" },
      opts,
    )) as { message: string };
    expect(updated.message).toContain("updated");

    const afterUpdate = (await tools.task_get!.execute!(
      { task_id: created.task_id },
      opts,
    )) as { task: { name: string; prompt: string } };
    expect(afterUpdate.task.name).toBe("Renamed");
    expect(afterUpdate.task.prompt).toBe("New prompt");

    const toggled = (await tools.task_toggle!.execute!(
      { task_id: created.task_id, is_active: false },
      opts,
    )) as { message: string };
    expect(toggled.message).toContain("disabled");

    const afterToggle = (await tools.task_get!.execute!(
      { task_id: created.task_id },
      opts,
    )) as { task: { is_active: boolean } };
    expect(afterToggle.task.is_active).toBe(false);

    const deleted = (await tools.task_delete!.execute!(
      { task_id: created.task_id },
      opts,
    )) as { message: string };
    expect(deleted.message).toContain("deleted");

    const afterDelete = (await tools.task_list!.execute!({}, opts)) as { tasks: unknown[] };
    expect(afterDelete.tasks).toHaveLength(0);
  });

  it("scopes tasks by userId — user 2 cannot see or delete user 1's task", async () => {
    t = await createTestDb();
    const ctx1 = await seedCtx(1, 100);
    const ctx2 = await seedCtx(2, 200);
    const tools1 = buildTaskTools(ctx1);
    const tools2 = buildTaskTools(ctx2);

    const created = (await tools1.task_create!.execute!(
      { name: "Owned by user 1", prompt: "do thing", schedule: "0 * * * *" },
      opts,
    )) as { task_id: number };

    // User 2's list must not include user 1's task.
    const list2 = (await tools2.task_list!.execute!({}, opts)) as { tasks: unknown[] };
    expect(list2.tasks).toHaveLength(0);

    // User 2 cannot get user 1's task.
    const get2 = (await tools2.task_get!.execute!({ task_id: created.task_id }, opts)) as {
      error?: string;
      task?: unknown;
    };
    expect(get2.task).toBeUndefined();
    expect(get2.error).toMatch(/not found/i);

    // User 2 cannot delete user 1's task.
    const del2 = (await tools2.task_delete!.execute!(
      { task_id: created.task_id },
      opts,
    )) as { error?: string; message?: string };
    expect(del2.message).toBeUndefined();
    expect(del2.error).toMatch(/not found/i);

    // The task still exists for user 1.
    const list1 = (await tools1.task_list!.execute!({}, opts)) as { tasks: unknown[] };
    expect(list1.tasks).toHaveLength(1);
  });
});

describe("task tools — max_tasks enforcement", () => {
  it("rejects creating a second task when the plan allows only one", async () => {
    t = await createTestDb();
    const ctx = await seedCtx(1, 100);

    const [plan] = await t.db
      .insert(subscriptionPlans)
      .values({ name: "solo", hourlyLimit: 10, maxTasks: 1 })
      .returning({ id: subscriptionPlans.id });
    await t.db.insert(userSubscriptions).values({ userId: 1, planId: plan!.id });

    const tools = buildTaskTools(ctx);

    const first = (await tools.task_create!.execute!(
      { name: "First", prompt: "p1", schedule: "0 * * * *" },
      opts,
    )) as { task_id?: number; error?: string };
    expect(first.task_id).toBeGreaterThan(0);

    const second = (await tools.task_create!.execute!(
      { name: "Second", prompt: "p2", schedule: "0 * * * *" },
      opts,
    )) as { task_id?: number; error?: string };
    expect(second.task_id).toBeUndefined();
    expect(second.error).toMatch(/limit/i);

    // Only the first task was inserted.
    const rows = await t.db.select().from(cronTasks);
    expect(rows).toHaveLength(1);
  });

  it("allows up to the default limit of 3 when no subscription is set", async () => {
    t = await createTestDb();
    const ctx = await seedCtx(1, 100);
    const tools = buildTaskTools(ctx);

    for (let i = 0; i < 3; i++) {
      const r = (await tools.task_create!.execute!(
        { name: `T${i}`, prompt: "p", schedule: "0 * * * *" },
        opts,
      )) as { task_id?: number };
      expect(r.task_id).toBeGreaterThan(0);
    }

    const fourth = (await tools.task_create!.execute!(
      { name: "T4", prompt: "p", schedule: "0 * * * *" },
      opts,
    )) as { error?: string };
    expect(fourth.error).toMatch(/limit/i);
  });

  it("rejects re-enabling a task via task_toggle when it would exceed the plan limit", async () => {
    t = await createTestDb();
    const ctx = await seedCtx(1, 100);

    const [plan] = await t.db
      .insert(subscriptionPlans)
      .values({ name: "solo", hourlyLimit: 10, maxTasks: 1 })
      .returning({ id: subscriptionPlans.id });
    await t.db.insert(userSubscriptions).values({ userId: 1, planId: plan!.id });

    const tools = buildTaskTools(ctx);

    // Create task A (active), then disable it so a second create is allowed.
    const a = (await tools.task_create!.execute!(
      { name: "A", prompt: "p", schedule: "0 * * * *" },
      opts,
    )) as { task_id?: number };
    expect(a.task_id).toBeGreaterThan(0);

    await tools.task_toggle!.execute!({ task_id: a.task_id!, is_active: false }, opts);

    // With A disabled, creating B is allowed (active count is 0).
    const b = (await tools.task_create!.execute!(
      { name: "B", prompt: "p", schedule: "0 * * * *" },
      opts,
    )) as { task_id?: number };
    expect(b.task_id).toBeGreaterThan(0);

    // Re-enabling A would make 2 active tasks under a 1-task plan — must be rejected.
    const reEnable = (await tools.task_toggle!.execute!(
      { task_id: a.task_id!, is_active: true },
      opts,
    )) as { error?: string };
    expect(reEnable.error).toMatch(/limit/i);

    // A stays disabled — only B is active.
    const rows = await t.db.select().from(cronTasks);
    expect(rows.filter((r) => r.isActive)).toHaveLength(1);
  });
});
