import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { eq, and, count } from "drizzle-orm";
import { cronTasks, userSubscriptions, subscriptionPlans } from "../../db/schema.js";
import { MAX_TASK_PROMPT_LEN } from "../../pkg/promptguard.js";
import { logger } from "../../pkg/logger.js";
import type { ToolContext } from "./registry.js";

const log = logger.child({ mod: "tool-tasks" });

/** Tool names provided by this bucket (cron task CRUD). */
export const TASK_TOOL_NAMES = new Set([
  "task_create",
  "task_list",
  "task_get",
  "task_update",
  "task_delete",
  "task_toggle",
]);

/** Default per-user active-task limit when no subscription/plan is set (Go parity). */
const DEFAULT_MAX_TASKS = 3;
/** Minimum allowed interval between two cron runs: 1 hour (Go parity). */
const MIN_INTERVAL_MS = 3_600_000;

export type ScheduleValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a task schedule (Go parity with manage_cron_tasks.go).
 *  - "now"   → immediate background task; always ok here (a session is always present).
 *  - "once"  → requires `scheduledAt` strictly in the future.
 *  - ""      → error (schedule is required).
 *  - else    → parse as a 5-field cron; enforce a minimum interval of 1 hour
 *              (two consecutive next times must be ≥ 1h apart). Unparseable → error.
 */
export function validateSchedule(
  schedule: string,
  scheduledAt?: Date,
  opts?: { now?: Date },
): ScheduleValidation {
  const now = opts?.now ?? new Date();

  if (schedule === "now") {
    return { ok: true };
  }

  if (schedule === "once") {
    if (!scheduledAt) {
      return { ok: false, error: "scheduled_at is required for one-time tasks (schedule='once')" };
    }
    if (scheduledAt.getTime() <= now.getTime()) {
      return { ok: false, error: "scheduled_at must be in the future" };
    }
    return { ok: true };
  }

  if (schedule === "") {
    return { ok: false, error: "schedule is required (cron expression, 'once', or 'now')" };
  }

  // Recurring cron expression — parse and enforce a minimum 1h interval.
  let n1: Date;
  let n2: Date;
  try {
    const it = CronExpressionParser.parse(schedule, { currentDate: now });
    n1 = it.next().toDate();
    n2 = it.next().toDate();
  } catch {
    return { ok: false, error: `invalid cron expression: ${schedule}` };
  }

  const interval = n2.getTime() - n1.getTime();
  if (interval < MIN_INTERVAL_MS) {
    return {
      ok: false,
      error: "schedule interval is too frequent (minimum allowed: 1 hour)",
    };
  }

  return { ok: true };
}

/** Parse an RFC3339 string to a Date, or return undefined for empty, or throw for invalid. */
function parseRfc3339(s: string | undefined): Date | undefined {
  if (s === undefined || s === "") return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      "invalid scheduled_at format (use RFC3339, e.g. '2026-02-10T15:00:00Z')",
    );
  }
  return d;
}

/** Resolve the user's active-task limit from their subscription plan (default 3). */
async function maxTasksForUser(ctx: ToolContext): Promise<number> {
  const rows = await ctx.db
    .select({ maxTasks: subscriptionPlans.maxTasks })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(eq(userSubscriptions.userId, ctx.userId))
    .limit(1);
  return rows[0]?.maxTasks ?? DEFAULT_MAX_TASKS;
}

/** Serialise a cron_tasks row into the tool output shape (RFC3339 strings for dates). */
function taskInfo(row: typeof cronTasks.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    skill_name: row.skillName,
    schedule: row.schedule,
    scheduled_at: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    is_active: row.isActive,
    last_run_at: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    last_run_status: row.lastRunStatus ?? null,
    last_run_error: row.lastRunError ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Load a task by id, scoped to the current user. Returns undefined if not owned/missing. */
async function getOwnedTask(ctx: ToolContext, taskId: number) {
  const rows = await ctx.db
    .select()
    .from(cronTasks)
    .where(and(eq(cronTasks.id, taskId), eq(cronTasks.userId, ctx.userId)))
    .limit(1);
  return rows[0];
}

/** Build the per-user cron-task CRUD tools, all scoped to ctx.userId. */
export function buildTaskTools(ctx: ToolContext): ToolSet {
  return {
    task_create: tool({
      description:
        "Create a new scheduled task. Recurring (cron expression, min interval 1 hour), " +
        "one-time (schedule='once' with scheduled_at in RFC3339), or immediate background " +
        "(schedule='now'). Examples: '0 9 * * *' for daily at 9 AM.",
      inputSchema: z.object({
        name: z.string().describe("Task name (required)"),
        prompt: z.string().describe("Prompt to execute when the task runs (required)"),
        schedule: z
          .string()
          .describe("Cron expression (e.g. '0 * * * *'), 'once', or 'now' (required)"),
        description: z.string().optional().describe("Task description (optional)"),
        skill_name: z.string().optional().describe("Skill to use for execution (optional)"),
        scheduled_at: z
          .string()
          .optional()
          .describe("Scheduled time in RFC3339 (required only if schedule='once')"),
      }),
      execute: async ({ name, prompt, schedule, description, skill_name, scheduled_at }) => {
        log.debug({ op: "create", userId: ctx.userId }, "task_create");

        if (name === "") return { error: "name is required" };
        if (prompt === "") return { error: "prompt is required" };
        if ([...prompt].length > MAX_TASK_PROMPT_LEN) {
          log.warn({ op: "create", userId: ctx.userId }, "prompt too long");
          return { error: `prompt is too long (max ${MAX_TASK_PROMPT_LEN} characters)` };
        }

        let scheduledAt: Date | undefined;
        try {
          scheduledAt = parseRfc3339(scheduled_at);
        } catch (e) {
          return { error: (e as Error).message };
        }

        const v = validateSchedule(schedule, scheduledAt);
        if (!v.ok) {
          log.warn({ op: "create", userId: ctx.userId, schedule }, "schedule rejected");
          return { error: v.error };
        }

        // Enforce the per-plan active-task limit.
        const limit = await maxTasksForUser(ctx);
        const [{ n }] = await ctx.db
          .select({ n: count() })
          .from(cronTasks)
          .where(and(eq(cronTasks.userId, ctx.userId), eq(cronTasks.isActive, true)));
        if (n >= limit) {
          log.warn({ op: "create", userId: ctx.userId, active: n, limit }, "task limit reached");
          return {
            error: `Task limit reached: you have ${n} active task(s); your plan allows ${limit}.`,
          };
        }

        const [inserted] = await ctx.db
          .insert(cronTasks)
          .values({
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            name,
            description: description ?? "",
            prompt,
            skillName: skill_name ?? "",
            schedule,
            scheduledAt: scheduledAt ?? null,
            notificationChatId: ctx.chatId,
          })
          .returning({ id: cronTasks.id });

        const taskId = inserted!.id;
        log.info({ op: "create", task_id: taskId, userId: ctx.userId }, "task created");
        return {
          task_id: taskId,
          message: `Task '${name}' created successfully with ID ${taskId}`,
        };
      },
    }),

    task_list: tool({
      description:
        "List all scheduled tasks for the current user (id, name, schedule, status, last run).",
      inputSchema: z.object({}),
      execute: async () => {
        log.debug({ op: "list", userId: ctx.userId }, "task_list");
        const rows = await ctx.db
          .select()
          .from(cronTasks)
          .where(eq(cronTasks.userId, ctx.userId));
        return { tasks: rows.map(taskInfo) };
      },
    }),

    task_get: tool({
      description: "Get detailed information about one of the user's tasks by ID.",
      inputSchema: z.object({
        task_id: z.number().int().describe("Task ID to retrieve (required)"),
      }),
      execute: async ({ task_id }) => {
        log.debug({ op: "get", task_id, userId: ctx.userId }, "task_get");
        const row = await getOwnedTask(ctx, task_id);
        if (!row) return { error: `Task ${task_id} not found` };
        return { task: taskInfo(row) };
      },
    }),

    task_update: tool({
      description:
        "Update an existing task. Only provided fields change. Can update name, description, " +
        "prompt, skill_name, schedule, and scheduled_at.",
      inputSchema: z.object({
        task_id: z.number().int().describe("Task ID to update (required)"),
        name: z.string().optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        skill_name: z.string().optional(),
        schedule: z.string().optional(),
        scheduled_at: z.string().optional().describe("New scheduled time in RFC3339"),
      }),
      execute: async ({ task_id, name, description, prompt, skill_name, schedule, scheduled_at }) => {
        log.debug({ op: "update", task_id, userId: ctx.userId }, "task_update");
        const existing = await getOwnedTask(ctx, task_id);
        if (!existing) return { error: `Task ${task_id} not found` };

        if (prompt !== undefined) {
          if (prompt === "") return { error: "prompt cannot be empty" };
          if ([...prompt].length > MAX_TASK_PROMPT_LEN) {
            log.warn({ op: "update", task_id, userId: ctx.userId }, "prompt too long");
            return { error: `prompt is too long (max ${MAX_TASK_PROMPT_LEN} characters)` };
          }
        }
        if (name !== undefined && name === "") return { error: "name cannot be empty" };

        // Resolve the effective schedule/scheduledAt after the partial update,
        // then validate the result (Go parity: update re-validates the schedule).
        const nextSchedule = schedule ?? existing.schedule;
        let nextScheduledAt: Date | null = existing.scheduledAt;
        if (scheduled_at !== undefined) {
          try {
            nextScheduledAt = parseRfc3339(scheduled_at) ?? null;
          } catch (e) {
            return { error: (e as Error).message };
          }
        }

        if (schedule !== undefined || scheduled_at !== undefined) {
          const v = validateSchedule(nextSchedule, nextScheduledAt ?? undefined);
          if (!v.ok) {
            log.warn({ op: "update", task_id, userId: ctx.userId }, "schedule rejected");
            return { error: v.error };
          }
        }

        const patch: Partial<typeof cronTasks.$inferInsert> = { updatedAt: new Date() };
        if (name !== undefined) patch.name = name;
        if (description !== undefined) patch.description = description;
        if (prompt !== undefined) patch.prompt = prompt;
        if (skill_name !== undefined) patch.skillName = skill_name;
        if (schedule !== undefined) patch.schedule = schedule;
        if (scheduled_at !== undefined) patch.scheduledAt = nextScheduledAt;

        await ctx.db
          .update(cronTasks)
          .set(patch)
          .where(and(eq(cronTasks.id, task_id), eq(cronTasks.userId, ctx.userId)));

        return { message: `Task '${name ?? existing.name}' (ID ${task_id}) updated successfully` };
      },
    }),

    task_delete: tool({
      description: "Delete one of the user's tasks by ID. Permanent and cannot be undone.",
      inputSchema: z.object({
        task_id: z.number().int().describe("Task ID to delete (required)"),
      }),
      execute: async ({ task_id }) => {
        log.debug({ op: "delete", task_id, userId: ctx.userId }, "task_delete");
        const existing = await getOwnedTask(ctx, task_id);
        if (!existing) return { error: `Task ${task_id} not found` };

        // C1: destructive — request confirmation instead of deleting, when wired.
        if (ctx.confirmations) {
          await ctx.confirmations.create({
            userId: ctx.userId,
            chatId: ctx.chatId,
            sessionId: ctx.sessionId,
            toolName: "task_delete",
            args: { task_id },
            summary: `Удалить задачу #${task_id} «${existing.name}»?`,
          });
          log.debug({ op: "delete", task_id }, "task_delete -> confirmation requested");
          return { message: "Запрошено подтверждение у пользователя — дождитесь ответа на кнопки." };
        }

        await ctx.db
          .delete(cronTasks)
          .where(and(eq(cronTasks.id, task_id), eq(cronTasks.userId, ctx.userId)));

        log.info({ op: "delete", task_id, userId: ctx.userId }, "task deleted");
        return { message: `Task ID ${task_id} deleted successfully` };
      },
    }),

    task_toggle: tool({
      description:
        "Enable or disable one of the user's tasks. Disabled tasks are not executed by the scheduler.",
      inputSchema: z.object({
        task_id: z.number().int().describe("Task ID to toggle (required)"),
        is_active: z.boolean().describe("New active state (true=enable, false=disable)"),
      }),
      execute: async ({ task_id, is_active }) => {
        log.debug({ op: "toggle", task_id, userId: ctx.userId }, "task_toggle");
        const existing = await getOwnedTask(ctx, task_id);
        if (!existing) return { error: `Task ${task_id} not found` };

        // Re-enabling a disabled task adds to the active count, so enforce the same
        // per-plan limit as task_create (otherwise the cap is bypassable via toggle).
        if (is_active && !existing.isActive) {
          const limit = await maxTasksForUser(ctx);
          const [{ n }] = await ctx.db
            .select({ n: count() })
            .from(cronTasks)
            .where(and(eq(cronTasks.userId, ctx.userId), eq(cronTasks.isActive, true)));
          if (n >= limit) {
            log.warn({ op: "toggle", task_id, userId: ctx.userId, active: n, limit }, "task limit reached");
            return {
              error: `Task limit reached: you have ${n} active task(s); your plan allows ${limit}.`,
            };
          }
        }

        await ctx.db
          .update(cronTasks)
          .set({ isActive: is_active, updatedAt: new Date() })
          .where(and(eq(cronTasks.id, task_id), eq(cronTasks.userId, ctx.userId)));

        const status = is_active ? "enabled" : "disabled";
        return { message: `Task ID ${task_id} ${status} successfully` };
      },
    }),
  };
}
