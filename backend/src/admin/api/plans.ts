import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { subscriptionPlans, userSubscriptions } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-plans" });

/** New plan: unique name + non-negative hourly_limit / max_tasks (0 = unlimited). */
const createPlanSchema = z.object({
  name: z.string().min(1),
  hourly_limit: z.number().int().min(0),
  max_tasks: z.number().int().min(0),
});

/** Partial plan patch — only provided fields change. */
const patchPlanSchema = z
  .object({
    name: z.string().min(1),
    hourly_limit: z.number().int().min(0),
    max_tasks: z.number().int().min(0),
  })
  .partial();

/** Assign/replace a user's plan. */
const assignSchema = z.object({
  userId: z.number().int(),
  planId: z.number().int(),
});

/** Flatten zod issues to a single human-readable string. */
function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Serialise a subscription_plans row into the API shape (epoch-ms timestamps). */
function planInfo(row: typeof subscriptionPlans.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    hourlyLimit: row.hourlyLimit,
    maxTasks: row.maxTasks,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Admin subscription-plan router (mounted at /admin/api/plans).
 *
 * CRUD over `subscription_plans` plus `PUT /assign`, which upserts a row in
 * `user_subscriptions` to (re)attach a user to a plan — the same table
 * RateLimitService.resolveLimit reads, so an assignment immediately changes the
 * user's effective hourly limit.
 */
export function plansRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get("/", async (c) => {
    const { db } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list plans");
    const rows = await db.select().from(subscriptionPlans);
    return c.json({ plans: rows.map(planInfo) });
  });

  r.post("/", async (c) => {
    const { db } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = createPlanSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "plan create validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    // Reject a duplicate name up front (name is UNIQUE) with a clean 409.
    const [dupe] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, parsed.data.name))
      .limit(1);
    if (dupe) {
      log.warn({ adminUserId: c.var.adminUserId }, "plan name already exists");
      return c.json({ error: `plan '${parsed.data.name}' already exists` }, 409);
    }

    const [created] = await db
      .insert(subscriptionPlans)
      .values({
        name: parsed.data.name,
        hourlyLimit: parsed.data.hourly_limit,
        maxTasks: parsed.data.max_tasks,
      })
      .returning();
    log.info({ adminUserId: c.var.adminUserId, planId: created!.id }, "plan created");
    return c.json(planInfo(created!), 201);
  });

  r.patch("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const body = await c.req.json().catch(() => undefined);
    const parsed = patchPlanSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, planId: id }, "plan patch validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    const patch: Partial<typeof subscriptionPlans.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.hourly_limit !== undefined) patch.hourlyLimit = parsed.data.hourly_limit;
    if (parsed.data.max_tasks !== undefined) patch.maxTasks = parsed.data.max_tasks;

    const updated = await db
      .update(subscriptionPlans)
      .set(patch)
      .where(eq(subscriptionPlans.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: "plan not found" }, 404);

    log.info({ adminUserId: c.var.adminUserId, planId: id }, "plan updated");
    return c.json(planInfo(updated[0]));
  });

  r.delete("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    // Block deletion while a subscription references the plan: user_subscriptions
    // .plan_id is a non-nullable FK with no cascade, so an orphaning delete would
    // fail at the DB anyway — we surface a clean 409 instead.
    const [ref] = await db
      .select({ userId: userSubscriptions.userId })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.planId, id))
      .limit(1);
    if (ref) {
      log.warn({ adminUserId: c.var.adminUserId, planId: id }, "plan delete blocked (referenced)");
      return c.json({ error: "plan is assigned to one or more users; reassign them first" }, 409);
    }

    const deleted = await db
      .delete(subscriptionPlans)
      .where(eq(subscriptionPlans.id, id))
      .returning({ id: subscriptionPlans.id });
    if (!deleted[0]) return c.json({ error: "plan not found" }, 404);

    log.info({ adminUserId: c.var.adminUserId, planId: id }, "plan deleted");
    return c.json({ ok: true });
  });

  r.put("/assign", async (c) => {
    const { db } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "plan assign validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    // Validate the target plan exists for a clear 404 (FK would otherwise reject).
    const [plan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, parsed.data.planId))
      .limit(1);
    if (!plan) {
      log.warn(
        { adminUserId: c.var.adminUserId, planId: parsed.data.planId },
        "plan assign: plan not found",
      );
      return c.json({ error: "plan not found" }, 404);
    }

    const now = new Date();
    await db
      .insert(userSubscriptions)
      .values({ userId: parsed.data.userId, planId: parsed.data.planId, updatedAt: now })
      .onConflictDoUpdate({
        target: userSubscriptions.userId,
        set: { planId: parsed.data.planId, updatedAt: now },
      });

    log.info(
      { adminUserId: c.var.adminUserId, userId: parsed.data.userId, planId: parsed.data.planId },
      "plan assigned",
    );
    return c.json({ ok: true, userId: parsed.data.userId, planId: parsed.data.planId });
  });

  return r;
}
