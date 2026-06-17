import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { tasksRoutes } from "../../src/admin/api/tasks.js";
import type { AdminApiDeps, AdminEnv } from "../../src/admin/api/deps.js";
import { users, sessions, cronTasks } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function makeApp(db: TestDb["db"]) {
  // The tasks router only touches c.var.deps.db; cast a minimal deps object.
  const deps = { db } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", tasksRoutes());
  return app;
}

/** Seed user 1 + a session (chatId 100) and return the session id (FKs for cron_tasks). */
async function seedBase(): Promise<number> {
  await t!.db.insert(users).values({ id: 1, name: "u1", displayName: "User One" });
  const [s] = await t!.db
    .insert(sessions)
    .values({ chatId: 100, userId: 1, model: "test:model" })
    .returning({ id: sessions.id });
  return s!.id;
}

async function insertTask(
  sessionId: number,
  over: Partial<typeof cronTasks.$inferInsert>,
): Promise<typeof cronTasks.$inferSelect> {
  const [row] = await t!.db
    .insert(cronTasks)
    .values({
      userId: 1,
      sessionId,
      name: "task",
      prompt: "do x",
      schedule: "0 * * * *",
      notificationChatId: 100,
      ...over,
    })
    .returning();
  return row!;
}

describe("tasksRoutes", () => {
  it("GET / lists tasks newest-first with the owning user and null-safe timestamps", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    // Older recurring task with a recorded run; newer one-time task, never run.
    await insertTask(sid, {
      name: "recurring",
      schedule: "0 * * * *",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastRunAt: new Date("2026-01-05T00:00:00Z"),
      lastRunStatus: "success",
    });
    await insertTask(sid, {
      name: "one-time",
      schedule: "once",
      scheduledAt: new Date("2026-02-01T00:00:00Z"),
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const app = makeApp(t.db);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: any[] };
    expect(body.tasks.map((x) => x.name)).toEqual(["one-time", "recurring"]); // newest first

    const [once, recurring] = body.tasks;
    // Owning user is joined and surfaced.
    expect(once.user).toMatchObject({ id: 1, name: "u1", displayName: "User One" });
    // Nullable timestamps serialise to number | null (never NaN/0).
    expect(typeof once.scheduledAt).toBe("number");
    expect(once.lastRunAt).toBeNull();
    expect(recurring.scheduledAt).toBeNull();
    expect(typeof recurring.lastRunAt).toBe("number");
    expect(recurring.lastRunStatus).toBe("success");
  });

  it("PATCH /:id toggles is_active both ways", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, { isActive: true });
    const app = makeApp(t.db);

    const off = await app.request(`/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).isActive).toBe(false);
    let [row] = await t.db.select().from(cronTasks).where(eq(cronTasks.id, task.id));
    expect(row!.isActive).toBe(false);

    const on = await app.request(`/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: true }),
    });
    expect(on.status).toBe(200);
    [row] = await t.db.select().from(cronTasks).where(eq(cronTasks.id, task.id));
    expect(row!.isActive).toBe(true);
  });

  it("PATCH rejects an invalid body (400) and a missing task (404)", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, {});
    const app = makeApp(t.db);

    const bad = await app.request(`/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: "no" }),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request("/999999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(missing.status).toBe(404);
  });

  it("DELETE /:id removes a task; 404 for a missing one", async () => {
    t = await createTestDb();
    const sid = await seedBase();
    const task = await insertTask(sid, {});
    const app = makeApp(t.db);

    const del = await app.request(`/${task.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()) as any).toEqual({ ok: true });
    const remaining = await t.db.select().from(cronTasks).where(eq(cronTasks.id, task.id));
    expect(remaining).toHaveLength(0);

    const missing = await app.request("/999999", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
