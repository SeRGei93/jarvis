import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { cronTasks, users } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-tasks" });

/** Toggle a task's active flag (the only admin-editable field). */
const togglePatchSchema = z.object({ is_active: z.boolean() });

/** Flatten zod issues to a single human-readable string (never echoes values). */
function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** The display fields of the owning user (joined / looked up alongside a task). */
type TaskUser = { id: number; name: string; displayName: string };

/**
 * Serialise a cron_tasks row into the API shape (epoch-ms timestamps).
 * `scheduledAt` / `lastRunAt` are nullable timestamp columns — guard `.getTime()`.
 * `prompt` is intentionally omitted: the admin UI never renders it and it can be
 * large/sensitive, so it stays out of the wire payload.
 */
function taskInfo(row: typeof cronTasks.$inferSelect, user: TaskUser) {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    name: row.name,
    description: row.description,
    skillName: row.skillName,
    schedule: row.schedule,
    scheduledAt: row.scheduledAt ? row.scheduledAt.getTime() : null,
    isActive: row.isActive,
    lastRunStatus: row.lastRunStatus,
    lastRunError: row.lastRunError,
    lastRunAt: row.lastRunAt ? row.lastRunAt.getTime() : null,
    notificationChatId: row.notificationChatId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    user,
  };
}

/**
 * Admin scheduled-tasks router (mounted at /admin/api/tasks).
 *
 * Read-and-manage view over `cron_tasks`. Every row in that table is created by
 * the assistant via the `automation` skill (its `task_create` tool) — there is no
 * admin/human insert path and no "source" column, so this lists ALL rows: those
 * are exactly the agent-created tasks. NOTE: do not filter by `skill_name` — that
 * field names the skill that *executes* the task (the sub-agent), not how it was
 * created; filtering by it would hide most tasks. Admin can toggle `is_active` and
 * delete tasks; creation/editing stays with the agent.
 */
export function tasksRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  // ── list (newest first), joined with the owning user for display ───────────
  r.get("/", async (c) => {
    const { db } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list tasks");
    const rows = await db
      .select({
        task: cronTasks,
        userName: users.name,
        userDisplayName: users.displayName,
      })
      .from(cronTasks)
      .leftJoin(users, eq(cronTasks.userId, users.id))
      .orderBy(desc(cronTasks.createdAt));
    const out = rows.map(({ task, userName, userDisplayName }) =>
      taskInfo(task, { id: task.userId, name: userName ?? "", displayName: userDisplayName ?? "" }),
    );
    return c.json({ tasks: out });
  });

  // ── toggle is_active ───────────────────────────────────────────────────────
  r.patch("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const body = await c.req.json().catch(() => undefined);
    const parsed = togglePatchSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, taskId: id }, "task patch validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    const updated = await db
      .update(cronTasks)
      .set({ isActive: parsed.data.is_active, updatedAt: new Date() })
      .where(eq(cronTasks.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: "task not found" }, 404);

    log.info(
      { adminUserId: c.var.adminUserId, taskId: id, isActive: parsed.data.is_active },
      "task toggled",
    );

    // Return the same user-augmented shape the list endpoint produces.
    const [u] = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, updated[0].userId))
      .limit(1);
    return c.json(taskInfo(updated[0], u ?? { id: updated[0].userId, name: "", displayName: "" }));
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  r.delete("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const deleted = await db
      .delete(cronTasks)
      .where(eq(cronTasks.id, id))
      .returning({ id: cronTasks.id });
    if (!deleted[0]) return c.json({ error: "task not found" }, 404);

    log.info({ adminUserId: c.var.adminUserId, taskId: id }, "task deleted");
    return c.json({ ok: true });
  });

  return r;
}
