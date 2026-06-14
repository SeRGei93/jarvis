import { Hono } from "hono";
import { eq, gte, sql } from "drizzle-orm";
import { usageStats, messageRateLimits } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-usage" });

/** True for a well-formed 'YYYY-MM-DD' date (lexically comparable, the storage format). */
function isIsoDate(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Admin usage router (mounted at /admin/api/usage).
 *
 * Reads accumulated cost/request counts from `usage_stats` — per user (delegating
 * to UsageService) or aggregated across all users for a period — and offers an
 * admin reset of a user's rate-limit windows (`message_rate_limits`).
 */
export function usageRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  // Per-user usage: ?since=YYYY-MM-DD → period sum; otherwise today's totals.
  r.get("/user/:id", async (c) => {
    const { usage } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const since = c.req.query("since");
    if (since !== undefined && !isIsoDate(since)) {
      log.warn({ adminUserId: c.var.adminUserId, userId: id }, "invalid since date");
      return c.json({ error: "since must be 'YYYY-MM-DD'" }, 400);
    }

    log.debug({ adminUserId: c.var.adminUserId, userId: id, since: since ?? null }, "read user usage");
    const totals = isIsoDate(since)
      ? await usage.getUsageSince(id, since)
      : await usage.getDailyUsage(id);
    return c.json({ userId: id, since: since ?? null, ...totals });
  });

  // Aggregate usage across ALL users for the period (?since=YYYY-MM-DD, else all-time):
  // one grouped query (per-user SUMs) plus a grand total.
  r.get("/", async (c) => {
    const { db } = c.var.deps;
    const since = c.req.query("since");
    if (since !== undefined && !isIsoDate(since)) {
      log.warn({ adminUserId: c.var.adminUserId }, "invalid since date");
      return c.json({ error: "since must be 'YYYY-MM-DD'" }, 400);
    }

    log.debug({ adminUserId: c.var.adminUserId, since: since ?? null }, "read aggregate usage");
    const where = isIsoDate(since) ? gte(usageStats.date, since) : undefined;
    const perUser = await db
      .select({
        userId: usageStats.userId,
        cost: sql<number>`coalesce(sum(${usageStats.cost}), 0)`,
        requests: sql<number>`coalesce(sum(${usageStats.requests}), 0)`,
      })
      .from(usageStats)
      .where(where)
      .groupBy(usageStats.userId);

    const rows = perUser.map((row) => ({
      userId: row.userId,
      cost: Number(row.cost),
      requests: Number(row.requests),
    }));
    const total = rows.reduce(
      (acc, row) => ({ cost: acc.cost + row.cost, requests: acc.requests + row.requests }),
      { cost: 0, requests: 0 },
    );

    return c.json({ since: since ?? null, users: rows, total });
  });

  // Admin reset: clear the user's rate-limit windows (next message starts fresh).
  r.delete("/ratelimit/:userId", async (c) => {
    const { db } = c.var.deps;
    const userId = Number(c.req.param("userId"));
    if (!Number.isInteger(userId)) return c.json({ error: "invalid id" }, 400);

    await db.delete(messageRateLimits).where(eq(messageRateLimits.userId, userId));
    log.info({ adminUserId: c.var.adminUserId, userId }, "rate limit reset");
    return c.json({ ok: true, userId });
  });

  return r;
}
