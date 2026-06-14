import { and, eq, gte, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { usageStats } from "../db/schema.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "usage" });

type Db = LibSQLDatabase<typeof schema>;

/** UTC 'YYYY-MM-DD' for the current day (parity with Go `time.Now().UTC().Truncate(24h)`). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Records per-user LLM cost/request counts into `usage_stats`, one row per
 * (userId, date). Parity with the Go UsageRepository.RecordUsage / daily stats:
 * each call accumulates cost and request count onto today's (or an explicit
 * date's) row via an upsert on the uq_usage_stats_user_date constraint.
 */
export class UsageService {
  constructor(private readonly db: Db) {}

  /**
   * Upsert today's row (or `date`), incrementing cost and requests.
   * An undefined `cost` is treated as 0 (request still counts).
   */
  async recordUsage(userId: number, cost?: number, requests = 1, date = todayUtc()): Promise<void> {
    const addCost = cost ?? 0;
    await this.db
      .insert(usageStats)
      .values({ userId, date, cost: addCost, requests })
      .onConflictDoUpdate({
        target: [usageStats.userId, usageStats.date],
        set: {
          cost: sql`${usageStats.cost} + ${addCost}`,
          requests: sql`${usageStats.requests} + ${requests}`,
          updatedAt: new Date(),
        },
      });
    log.debug({ userId, date, cost: addCost, requests }, "usage recorded");
  }

  /**
   * Returns the accumulated { cost, requests } for the user on the given date
   * (default: today UTC), or { cost: 0, requests: 0 } when no row exists.
   */
  async getDailyUsage(
    userId: number,
    date = todayUtc(),
  ): Promise<{ cost: number; requests: number }> {
    const [row] = await this.db
      .select({ cost: usageStats.cost, requests: usageStats.requests })
      .from(usageStats)
      .where(and(eq(usageStats.userId, userId), eq(usageStats.date, date)))
      .limit(1);
    return row ?? { cost: 0, requests: 0 };
  }

  /**
   * Sum cost/requests across all days on or after `sinceDate` ('YYYY-MM-DD').
   * One aggregate query (used by the `/usage [days]` command) instead of N
   * per-day reads. Lexical date comparison is correct for ISO 'YYYY-MM-DD'.
   */
  async getUsageSince(
    userId: number,
    sinceDate: string,
  ): Promise<{ cost: number; requests: number }> {
    const [row] = await this.db
      .select({
        cost: sql<number>`coalesce(sum(${usageStats.cost}), 0)`,
        requests: sql<number>`coalesce(sum(${usageStats.requests}), 0)`,
      })
      .from(usageStats)
      .where(and(eq(usageStats.userId, userId), gte(usageStats.date, sinceDate)));
    return { cost: Number(row?.cost ?? 0), requests: Number(row?.requests ?? 0) };
  }
}
